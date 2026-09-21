import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError, NotFoundError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import type { Logger } from '../../../src/core/logger.ts';
import type { Dealer, StepStatus } from '../../../src/core/types.ts';
import {
  INTERRUPTED_ERROR,
  WorkflowEngine,
  skipStep,
  type StepContext,
  type WorkflowRunOutput,
  type WorkflowStepDef,
} from '../../../src/operator/workflow-engine.ts';
import type { AgentName } from '../../../src/skills/registry.ts';
import { TEST_NOW, createTestContext, type TestContext } from '../../helpers/context.ts';

function seedDealer(ctx: TestContext, name = '杭州宝马中心'): Dealer {
  const now = ctx.clock.iso();
  const group =
    ctx.db.table('dealer_groups').findOne({}) ??
    ctx.db.table('dealer_groups').insert({ id: newId('grp'), name: '浙沪宝马经销商集团', created_at: now });
  return ctx.db.table('dealers').insert({
    id: newId('dlr'),
    group_id: group.id,
    name,
    brands: ['BMW'],
    city: '杭州',
    province: '浙江',
    address: '杭州市测试路1号',
    business_hours: '09:00-18:00',
    phone: null,
    settings: {
      outreach_approval_policy: 'REVIEW_REQUIRED',
      publish_approval_policy: 'REVIEW_REQUIRED',
      daily_outreach_limit: 20,
      min_outreach_interval_minutes: 3,
      max_unanswered_touches: 2,
      follow_up_after_days: 2,
      daily_publish_limit: 2,
      max_ai_conversation_turns: 6,
      auto_send_min_score: 90,
      timezone: 'Asia/Shanghai',
    },
    created_at: now,
    updated_at: now,
  });
}

function step(key: string, run: WorkflowStepDef['run'], extra: Partial<WorkflowStepDef> = {}): WorkflowStepDef {
  return { key, agent: 'automotive-operator', skill: `skill-${key}`, description: `step ${key}`, run, ...extra };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const actions = (ctx: TestContext, runId: string) => ctx.audit.eventsFor('workflow_run', runId).map((e) => e.action);
const stepsOf = (engine: WorkflowEngine, ctx: TestContext, runId: string) => engine.getRun(ctx, runId).steps;
const isCode = (code: string) => (err: unknown) => err instanceof AppError && err.code === code;

describe('workflow engine: execution', () => {
  it('runs steps in order and records a SUCCEEDED run with per-step status, outputs and audit trail', async () => {
    const ctx = createTestContext();
    const dealer = seedDealer(ctx);
    const order: string[] = [];
    const engine = new WorkflowEngine([
      {
        name: 'lead_discovery',
        description: '线索发现',
        steps: [
          step('collect', () => {
            order.push('collect');
            return { posts: 3 };
          }, { agent: 'lead-hunting-agent', skill: 'lead-discovery' }),
          step('score', async () => {
            order.push('score');
            ctx.clock.advance({ seconds: 30 });
            return { scored: 3 };
          }, { agent: 'lead-scoring-agent', skill: 'lead-scoring' }),
          step('report', () => {
            order.push('report');
            return { ok: true };
          }),
        ],
      },
    ]);

    const run = await engine.start(ctx, 'lead_discovery', { dealer_id: dealer.id }, { trigger: 'manual', dealer_id: dealer.id });

    assert.equal(run.status, 'SUCCEEDED');
    assert.equal(run.error, null);
    assert.equal(run.trigger, 'manual');
    assert.equal(run.dealer_id, dealer.id);
    assert.deepEqual(run.input, { dealer_id: dealer.id });
    assert.equal(run.started_at, TEST_NOW);
    assert.equal(run.finished_at, '2026-09-12T02:00:30.000Z');
    assert.deepEqual(order, ['collect', 'score', 'report']);

    const steps = stepsOf(engine, ctx, run.id);
    assert.deepEqual(
      steps.map((s) => [s.step_key, s.seq, s.status, s.attempts, s.agent, s.skill]),
      [
        ['collect', 1, 'SUCCEEDED', 1, 'lead-hunting-agent', 'lead-discovery'],
        ['score', 2, 'SUCCEEDED', 1, 'lead-scoring-agent', 'lead-scoring'],
        ['report', 3, 'SUCCEEDED', 1, 'automotive-operator', 'skill-report'],
      ],
    );
    assert.ok(steps.every((s) => s.started_at !== null && s.finished_at !== null && s.error === null));

    const output = run.output as WorkflowRunOutput;
    assert.deepEqual(output, {
      steps: { collect: 'SUCCEEDED', score: 'SUCCEEDED', report: 'SUCCEEDED' },
      summary: { succeeded: 3, failed: 0, skipped: 0, pending: 0 },
      outputs: { collect: { posts: 3 }, score: { scored: 3 }, report: { ok: true } },
    });

    assert.deepEqual(actions(ctx, run.id), ['workflow.started', 'workflow.completed']);
    const completed = ctx.audit.eventsFor('workflow_run', run.id)[1];
    assert.equal(completed.details.status, 'SUCCEEDED');
    assert.equal(completed.details.duration_ms, 30_000);
  });

  it('a long step can report live progress; its real output replaces it when it finishes', async () => {
    const ctx = createTestContext();
    const gate = deferred();
    const engine = new WorkflowEngine([
      {
        name: 'lead_discovery',
        description: '获客',
        steps: [
          step('discover', async (sc) => {
            sc.progress({ query_index: 1, queries_total: 3 });
            await gate.promise;
            return { runs: 3 };
          }),
        ],
      },
    ]);
    const started = engine.start(ctx, 'lead_discovery', {}, { trigger: 'manual' });
    await new Promise((r) => setTimeout(r, 5));
    const running = ctx.db.table('workflow_steps').findOne({ step_key: 'discover' });
    assert.equal(running?.status, 'RUNNING');
    assert.deepEqual(running?.output, { progress: { query_index: 1, queries_total: 3, at: ctx.clock.iso() } });
    gate.resolve();
    const run = await started;
    assert.deepEqual(stepsOf(engine, ctx, run.id)[0].output, { runs: 3 });
  });

  it('gives later steps the run-bound context, stored input and isolated copies of earlier outputs', async () => {
    const ctx = createTestContext();
    const seen: StepContext[] = [];
    const engine = new WorkflowEngine([
      {
        name: 'content_publishing',
        description: '发布',
        steps: [
          step('plan', () => ({ post_ids: ['p1', 'p2'], planned_at: new Date('2026-09-12T02:00:00Z'), note: undefined })),
          step('draft', (sc) => {
            seen.push(sc);
            const ids = sc.outputs.plan.post_ids as string[];
            ids.push('mutated-by-draft');
            return { drafted: ids.length };
          }),
          step('review', (sc) => ({ post_ids_seen: sc.outputs.plan.post_ids, drafted: sc.outputs.draft.drafted })),
        ],
      },
    ]);

    const run = await engine.start(ctx, 'content_publishing', { models: ['i3'], limit: 2 }, { trigger: 'api' });
    assert.equal(run.status, 'SUCCEEDED');
    const sc = seen[0];
    assert.equal(sc.ctx.runId, run.id);
    assert.equal(ctx.runId, null, 'the caller context is not mutated');
    assert.equal(sc.run.id, run.id);
    assert.equal(sc.run.status, 'RUNNING');
    assert.deepEqual(sc.input, { models: ['i3'], limit: 2 });

    const outputs = (run.output as WorkflowRunOutput).outputs;
    assert.deepEqual(outputs.plan, { post_ids: ['p1', 'p2'], planned_at: '2026-09-12T02:00:00.000Z' });
    assert.deepEqual(outputs.draft, { drafted: 3 });
    assert.deepEqual(outputs.review, { post_ids_seen: ['p1', 'p2'], drafted: 3 }, 'mutations in one step do not leak');
  });

  it('stamps agent decisions made inside a step with the workflow run id', async () => {
    const ctx = createTestContext();
    const decide = (c: TestContext | StepContext['ctx'], subject: string) =>
      c.audit.decision({
        agent: 'lead-scoring-agent',
        skill: 'lead-scoring',
        decision_type: 'lead_score',
        subject_type: 'lead',
        subject_id: subject,
        inputs: { signal: '杭州i3 35L落地多少' },
        evidence: [{ code: 'landing_price', label: '询问落地价', quote: '落地多少' }],
        output: { score: 91 },
        confidence: 0.9,
        engine: 'rules',
      });
    const engine = new WorkflowEngine([
      { name: 'signal_processing', description: '信号处理', steps: [step('score', (sc) => ({ decision_id: decide(sc.ctx, 'lead_in_run').id }))] },
    ]);

    const run = await engine.start(ctx, 'signal_processing', {}, { trigger: 'manual' });
    const outside = decide(ctx, 'lead_outside');

    const inside = ctx.db.table('agent_decisions').require((run.output as WorkflowRunOutput).outputs.score.decision_id as string);
    assert.equal(inside.workflow_run_id, run.id);
    assert.equal(outside.workflow_run_id, null);
  });

  it('fails the run on a required step failure and leaves later steps PENDING and unexecuted', async () => {
    const ctx = createTestContext();
    let laterCalls = 0;
    const engine = new WorkflowEngine([
      {
        name: 'refresh_dealer_data',
        description: '刷新',
        steps: [
          step('load', () => ({ rows: 10 })),
          step('sync_inventory', () => {
            throw new Error('inventory feed timeout');
          }, { agent: 'crm-agent', skill: 'dealer-brain' }),
          step('rebuild_profile', () => {
            laterCalls++;
            return {};
          }),
        ],
      },
    ]);

    const run = await engine.start(ctx, 'refresh_dealer_data', {}, { trigger: 'manual' });
    assert.equal(run.status, 'FAILED');
    assert.match(run.error ?? '', /^step "sync_inventory" failed: inventory feed timeout/);
    assert.ok(run.finished_at);
    assert.equal(laterCalls, 0);

    const [load, sync, rebuild] = stepsOf(engine, ctx, run.id);
    assert.equal(load.status, 'SUCCEEDED');
    assert.equal(sync.status, 'FAILED');
    assert.equal(sync.attempts, 1);
    assert.match(sync.error ?? '', /inventory feed timeout \(at /, 'error keeps the first stack frame');
    assert.equal(rebuild.status, 'PENDING');
    assert.equal(rebuild.attempts, 0);
    assert.equal(rebuild.started_at, null);

    const output = run.output as WorkflowRunOutput;
    assert.deepEqual(output.summary, { succeeded: 1, failed: 1, skipped: 0, pending: 1 });
    assert.deepEqual(Object.keys(output.outputs), ['load']);

    const events = ctx.audit.eventsFor('workflow_run', run.id);
    assert.deepEqual(events.map((e) => e.action), ['workflow.started', 'workflow.step_failed', 'workflow.completed']);
    assert.equal(events[1].details.step_key, 'sync_inventory');
    assert.equal(events[1].actor, 'agent:crm-agent');
    assert.equal(events[2].details.status, 'FAILED');
  });

  it('retries a throwing step up to `retries` extra attempts', async () => {
    const ctx = createTestContext();
    let flakyCalls = 0;
    let brokenCalls = 0;
    const engine = new WorkflowEngine([
      {
        name: 'flaky',
        description: '',
        steps: [
          step('fetch', () => {
            flakyCalls++;
            if (flakyCalls < 3) throw new Error(`transient ${flakyCalls}`);
            return { calls: flakyCalls };
          }, { retries: 2, retryDelayMs: 1 }),
        ],
      },
      {
        name: 'broken',
        description: '',
        steps: [
          step('fetch', () => {
            brokenCalls++;
            throw new Error('still broken');
          }, { retries: 1 }),
        ],
      },
    ]);

    const ok = await engine.start(ctx, 'flaky', {}, { trigger: 'manual' });
    assert.equal(ok.status, 'SUCCEEDED');
    const [okStep] = stepsOf(engine, ctx, ok.id);
    assert.equal(okStep.attempts, 3);
    assert.equal(okStep.error, null);
    assert.deepEqual(okStep.output, { calls: 3 });

    const failed = await engine.start(ctx, 'broken', {}, { trigger: 'manual' });
    assert.equal(failed.status, 'FAILED');
    const [failedStep] = stepsOf(engine, ctx, failed.id);
    assert.equal(brokenCalls, 2);
    assert.equal(failedStep.attempts, 2);
    assert.match(failedStep.error ?? '', /still broken/);
  });

  it('continues past a failed optional step and ends PARTIAL', async () => {
    const ctx = createTestContext();
    const engine = new WorkflowEngine([
      {
        name: 'market_research',
        description: '',
        steps: [
          step('search', () => ({ notes: 12 })),
          step('llm_enrich', () => {
            throw new Error('LLM unavailable');
          }, { optional: true, agent: 'research-agent' }),
          step('brief', (sc) => ({ has_enrichment: 'llm_enrich' in sc.outputs, notes: sc.outputs.search.notes })),
        ],
      },
    ]);

    const run = await engine.start(ctx, 'market_research', {}, { trigger: 'manual' });
    assert.equal(run.status, 'PARTIAL');
    assert.match(run.error ?? '', /optional step\(s\) failed: llm_enrich \(LLM unavailable/);
    const output = run.output as WorkflowRunOutput;
    assert.deepEqual(output.steps, { search: 'SUCCEEDED', llm_enrich: 'FAILED', brief: 'SUCCEEDED' });
    assert.deepEqual(output.summary, { succeeded: 2, failed: 1, skipped: 0, pending: 0 });
    assert.deepEqual(output.outputs.brief, { has_enrichment: false, notes: 12 });
    assert.equal(ctx.audit.eventsFor('workflow_run', run.id).at(-1)?.details.status, 'PARTIAL');
  });

  it('records a step that returns the skip marker as SKIPPED and still succeeds', async () => {
    const ctx = createTestContext();
    const engine = new WorkflowEngine([
      {
        name: 'reply_processing',
        description: '',
        steps: [
          step('poll_inbox', () => skipStep('receive_messages capability UNAVAILABLE', { capability: 'receive_messages' }), {
            agent: 'conversation-agent',
          }),
          step('follow_up', () => ({ __skipped: true, reason: '' })),
          step('summarize', (sc) => ({ inbox_skipped: sc.outputs.poll_inbox.skipped, why: sc.outputs.poll_inbox.reason })),
        ],
      },
    ]);

    const run = await engine.start(ctx, 'reply_processing', {}, { trigger: 'manual' });
    assert.equal(run.status, 'SUCCEEDED');
    const [poll, followUp, summarize] = stepsOf(engine, ctx, run.id);
    assert.equal(poll.status, 'SKIPPED');
    assert.deepEqual(poll.output, { capability: 'receive_messages', skipped: true, reason: 'receive_messages capability UNAVAILABLE' });
    assert.equal(followUp.status, 'SKIPPED');
    assert.equal(followUp.output.reason, 'skipped', 'blank reasons get a default');
    assert.deepEqual(summarize.output, { inbox_skipped: true, why: 'receive_messages capability UNAVAILABLE' });
    assert.deepEqual((run.output as WorkflowRunOutput).summary, { succeeded: 1, failed: 0, skipped: 2, pending: 0 });
    assert.equal(actions(ctx, run.id).filter((a) => a === 'workflow.step_skipped').length, 2);
  });

  it('stores empty results as {} and fails non-serializable outputs without retrying', async () => {
    const ctx = createTestContext();
    let circularCalls = 0;
    const returns = (value: () => unknown) => value as unknown as WorkflowStepDef['run'];
    const engine = new WorkflowEngine([
      { name: 'empty', description: '', steps: [step('noop', returns(() => undefined)), step('nil', returns(() => null))] },
      {
        name: 'circular',
        description: '',
        steps: [
          step('loop', () => {
            circularCalls++;
            const o: Record<string, unknown> = { a: 1 };
            o.self = o;
            return o;
          }, { retries: 3 }),
        ],
      },
      { name: 'map', description: '', steps: [step('m', () => ({ index: new Map([['a', 1]]) }))] },
      { name: 'array', description: '', steps: [step('arr', returns(() => [1, 2]))] },
      { name: 'fn', description: '', steps: [step('f', () => ({ nested: { callback: () => 1 } }))] },
      { name: 'nan', description: '', steps: [step('n', () => ({ ratio: Number.NaN }))] },
    ]);

    const empty = await engine.start(ctx, 'empty', {}, { trigger: 'manual' });
    assert.equal(empty.status, 'SUCCEEDED');
    assert.deepEqual(stepsOf(engine, ctx, empty.id).map((s) => s.output), [{}, {}]);

    const circular = await engine.start(ctx, 'circular', {}, { trigger: 'manual' });
    const [loop] = stepsOf(engine, ctx, circular.id);
    assert.equal(circular.status, 'FAILED');
    assert.equal(loop.attempts, 1);
    assert.equal(circularCalls, 1, 'serialization errors are not retried');
    assert.match(loop.error ?? '', /step "loop" output is not JSON-serializable: output\.self: circular reference/);

    const expectations: [string, RegExp][] = [
      ['map', /output\.index: Map instance is not a plain JSON object/],
      ['array', /step "arr" must return a plain object, got array/],
      ['fn', /output\.nested\.callback: function is not JSON-serializable/],
      ['nan', /output\.ratio: non-finite number/],
    ];
    for (const [name, pattern] of expectations) {
      const run = await engine.start(ctx, name, {}, { trigger: 'manual' });
      assert.equal(run.status, 'FAILED', name);
      assert.match(stepsOf(engine, ctx, run.id)[0].error ?? '', pattern, name);
    }
  });

  it('rejects unknown workflows, invalid definitions and invalid start requests without creating runs', async () => {
    const ctx = createTestContext();
    const engine = new WorkflowEngine();
    engine.register({ name: 'ok', description: '', steps: [step('a', () => ({}))] });
    engine.register({
      name: 'dynamic_broken',
      description: '',
      steps: () => {
        throw new Error('no accounts configured');
      },
    });

    await assert.rejects(engine.start(ctx, 'nope', {}, { trigger: 'manual' }), isCode('unknown_workflow'));
    assert.throws(() => engine.register({ name: 'ok', description: '', steps: [] }), isCode('workflow_already_registered'));
    assert.throws(
      () => engine.register({ name: 'dup', description: '', steps: [step('a', () => ({})), step('a', () => ({}))] }),
      /duplicate step key "a"/,
    );
    assert.throws(
      () => engine.register({ name: 'agent', description: '', steps: [step('a', () => ({}), { agent: 'ghost-agent' as AgentName })] }),
      /unknown agent "ghost-agent"/,
    );
    assert.throws(
      () => engine.register({ name: 'retries', description: '', steps: [step('a', () => ({}), { retries: -1 })] }),
      /retries must be an integer/,
    );
    await assert.rejects(
      engine.start(ctx, 'ok', { callback: () => 1 } as unknown as Record<string, unknown>, { trigger: 'manual' }),
      isCode('invalid_workflow_input'),
    );
    await assert.rejects(
      engine.start(ctx, 'ok', {}, { trigger: 'cron' as unknown as 'manual' }),
      isCode('invalid_trigger'),
    );
    await assert.rejects(engine.start(ctx, 'ok', {}, { trigger: 'manual', dealer_id: 'dlr_missing' }), NotFoundError);
    await assert.rejects(engine.start(ctx, 'dynamic_broken', {}, { trigger: 'manual' }), (err: unknown) => {
      return isCode('workflow_steps_unresolvable')(err) && /no accounts configured/.test((err as Error).message);
    });
    assert.equal(ctx.db.table('workflow_runs').count(), 0);
    assert.equal(ctx.db.table('workflow_steps').count(), 0);
    assert.deepEqual(engine.list().map((d) => d.name), ['ok', 'dynamic_broken']);
  });

  it('resolves input-dependent step lists', async () => {
    const ctx = createTestContext();
    const engine = new WorkflowEngine([
      {
        name: 'account_planning',
        description: '',
        steps: (input) =>
          (input.accounts as string[]).map((acc) =>
            step(`plan_${acc}`, () => ({ account: acc }), { agent: 'account-strategy-agent', skill: 'account-strategy' }),
          ),
      },
    ]);
    const run = await engine.start(ctx, 'account_planning', { accounts: ['xhs-hz-official', 'xhs-hz-i3'] }, { trigger: 'goal' });
    assert.equal(run.status, 'SUCCEEDED');
    assert.deepEqual(
      stepsOf(engine, ctx, run.id).map((s) => [s.step_key, s.output.account]),
      [
        ['plan_xhs-hz-official', 'xhs-hz-official'],
        ['plan_xhs-hz-i3', 'xhs-hz-i3'],
      ],
    );
  });
});

describe('workflow engine: resume, recovery, singleton, cancel', () => {
  it('resumes a failed run on the same run id without re-executing succeeded steps', async () => {
    const ctx = createTestContext();
    const calls = { load: 0, sync: 0, publish: 0 };
    let feedDown = true;
    const engine = new WorkflowEngine([
      {
        name: 'refresh_dealer_data',
        description: '',
        steps: [
          step('load', () => {
            calls.load++;
            return { token: 'abc' };
          }),
          step('sync', () => {
            calls.sync++;
            if (feedDown) throw new Error('inventory feed down');
            return { synced: true };
          }),
          step('publish', (sc) => {
            calls.publish++;
            return { token_from_load: sc.outputs.load.token, synced: sc.outputs.sync.synced };
          }),
        ],
      },
    ]);

    const failed = await engine.start(ctx, 'refresh_dealer_data', { source: 'dms' }, { trigger: 'manual' });
    assert.equal(failed.status, 'FAILED');

    feedDown = false;
    ctx.clock.advance({ minutes: 10 });
    const resumed = await engine.resume(ctx, failed.id);

    assert.equal(resumed.id, failed.id);
    assert.equal(resumed.status, 'SUCCEEDED');
    assert.equal(resumed.error, null);
    assert.equal(resumed.started_at, TEST_NOW);
    assert.equal(resumed.finished_at, '2026-09-12T02:10:00.000Z');
    assert.deepEqual(calls, { load: 1, sync: 2, publish: 1 });
    assert.equal(ctx.db.table('workflow_runs').count(), 1);

    const [load, sync, publish] = stepsOf(engine, ctx, failed.id);
    assert.equal(load.attempts, 1);
    assert.equal(sync.attempts, 2);
    assert.equal(sync.error, null);
    assert.deepEqual(publish.output, { token_from_load: 'abc', synced: true }, 'outputs of earlier steps are reloaded');

    assert.deepEqual(actions(ctx, failed.id), [
      'workflow.started',
      'workflow.step_failed',
      'workflow.completed',
      'workflow.resumed',
      'workflow.completed',
    ]);
    const resumedEvent = ctx.audit.eventsFor('workflow_run', failed.id)[3];
    assert.equal(resumedEvent.details.previous_status, 'FAILED');
    assert.deepEqual(resumedEvent.details.rerun_steps, ['sync', 'publish']);
  });

  it('resuming a PARTIAL run re-runs only the failed optional step', async () => {
    const ctx = createTestContext();
    const calls = { a: 0, enrich: 0, c: 0 };
    let llmUp = false;
    const engine = new WorkflowEngine([
      {
        name: 'evening_analysis',
        description: '',
        steps: [
          step('a', () => ({ a: ++calls.a })),
          step('enrich', () => {
            calls.enrich++;
            if (!llmUp) throw new Error('LLM rate limited');
            return { enriched: true };
          }, { optional: true }),
          step('c', () => ({ c: ++calls.c })),
        ],
      },
    ]);
    const partial = await engine.start(ctx, 'evening_analysis', {}, { trigger: 'manual' });
    assert.equal(partial.status, 'PARTIAL');

    llmUp = true;
    const resumed = await engine.resume(ctx, partial.id);
    assert.equal(resumed.status, 'SUCCEEDED');
    assert.deepEqual(calls, { a: 1, enrich: 2, c: 1 });
    assert.deepEqual((resumed.output as WorkflowRunOutput).summary, { succeeded: 3, failed: 0, skipped: 0, pending: 0 });
  });

  it('resuming a SUCCEEDED run returns it unchanged', async () => {
    const ctx = createTestContext();
    let calls = 0;
    const engine = new WorkflowEngine([{ name: 'w', description: '', steps: [step('a', () => ({ n: ++calls }))] }]);
    const run = await engine.start(ctx, 'w', {}, { trigger: 'manual' });
    ctx.clock.advance({ hours: 1 });
    const again = await engine.resume(ctx, run.id);
    assert.deepEqual(again, run);
    assert.equal(calls, 1);
    assert.ok(!actions(ctx, run.id).includes('workflow.resumed'));
    await assert.rejects(engine.resume(ctx, 'wf_missing'), NotFoundError);
  });

  it('appends step keys added to the definition and skips unfinished steps that were removed', async () => {
    const ctx = createTestContext();
    let version = 1;
    let notified = 0;
    const engine = new WorkflowEngine([
      {
        name: 'lead_discovery',
        description: '',
        steps: () =>
          version === 1
            ? [
                step('search', () => ({ found: 4 })),
                step('legacy_export', () => {
                  throw new Error('legacy CRM offline');
                }),
              ]
            : [step('search', () => ({ found: 99 })), step('notify', (sc) => ({ notified: ++notified, found: sc.outputs.search.found }))],
      },
    ]);

    const failed = await engine.start(ctx, 'lead_discovery', {}, { trigger: 'manual' });
    assert.equal(failed.status, 'FAILED');

    version = 2;
    const resumed = await engine.resume(ctx, failed.id);
    assert.equal(resumed.status, 'SUCCEEDED');
    const steps = stepsOf(engine, ctx, failed.id);
    assert.deepEqual(
      steps.map((s) => [s.step_key, s.seq, s.status]),
      [
        ['search', 1, 'SUCCEEDED'],
        ['legacy_export', 2, 'SKIPPED'],
        ['notify', 3, 'SUCCEEDED'],
      ],
    );
    assert.equal(steps[1].output.reason, 'step no longer defined in workflow');
    assert.match(String(steps[1].output.previous_error), /legacy CRM offline/);
    assert.deepEqual(steps[2].output, { notified: 1, found: 4 }, 'the succeeded search step was not re-run');

    const resumedEvent = ctx.audit.eventsFor('workflow_run', failed.id).find((e) => e.action === 'workflow.resumed');
    assert.deepEqual(resumedEvent?.details.appended_steps, ['notify']);
    assert.deepEqual(resumedEvent?.details.removed_steps, ['legacy_export']);
  });

  it('recoverInterrupted fails runs left RUNNING by a crashed process; they resume from the interrupted step', async () => {
    const ctx = createTestContext();
    const dealer = seedDealer(ctx);
    const calls = { a: 0, b: 0, c: 0 };
    const engine = new WorkflowEngine([
      {
        name: 'lead_discovery',
        description: '',
        steps: [
          step('a', () => ({ x: ++calls.a })),
          step('b', () => ({ y: ++calls.b })),
          step('c', (sc) => ({ z: ++calls.c, x: sc.outputs.a.x })),
        ],
      },
    ]);

    // Simulate the database state left by a process that died while executing step "b".
    const runId = newId('wf');
    const now = ctx.clock.iso();
    ctx.db.table('workflow_runs').insert({
      id: runId,
      workflow: 'lead_discovery',
      dealer_id: dealer.id,
      goal_id: null,
      trigger: 'schedule',
      status: 'RUNNING',
      input: {},
      output: {},
      error: null,
      resumed_from_run_id: null,
      started_at: now,
      finished_at: null,
    });
    const base = { run_id: runId, agent: 'automotive-operator', skill: 's', error: null };
    ctx.db.table('workflow_steps').insertMany([
      { ...base, id: newId('step'), step_key: 'a', seq: 1, status: 'SUCCEEDED', attempts: 1, output: { x: 41 }, started_at: now, finished_at: now },
      { ...base, id: newId('step'), step_key: 'b', seq: 2, status: 'RUNNING', attempts: 1, output: {}, started_at: now, finished_at: null },
      { ...base, id: newId('step'), step_key: 'c', seq: 3, status: 'PENDING', attempts: 0, output: {}, started_at: null, finished_at: null },
    ]);

    ctx.clock.advance({ minutes: 3 });
    const recovered = engine.recoverInterrupted(ctx);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, runId);
    assert.equal(recovered[0].status, 'FAILED');
    assert.equal(recovered[0].error, INTERRUPTED_ERROR);
    assert.equal(recovered[0].finished_at, '2026-09-12T02:03:00.000Z');
    assert.deepEqual(
      stepsOf(engine, ctx, runId).map((s) => [s.step_key, s.status, s.error]),
      [
        ['a', 'SUCCEEDED', null],
        ['b', 'FAILED', INTERRUPTED_ERROR],
        ['c', 'PENDING', null],
      ],
    );
    assert.deepEqual((recovered[0].output as WorkflowRunOutput).summary, { succeeded: 1, failed: 1, skipped: 0, pending: 1 });
    assert.ok(actions(ctx, runId).includes('workflow.interrupted'));
    assert.deepEqual(engine.recoverInterrupted(ctx), [], 'recovery is idempotent');

    const resumed = await engine.resume(ctx, runId);
    assert.equal(resumed.status, 'SUCCEEDED');
    assert.deepEqual(calls, { a: 0, b: 1, c: 1 });
    const [, b, c] = stepsOf(engine, ctx, runId);
    assert.equal(b.attempts, 2);
    assert.deepEqual(c.output, { z: 1, x: 41 });
  });

  it('never treats a run executing in this process as interrupted, and refuses to resume it concurrently', async () => {
    const ctx = createTestContext();
    const gate = deferred();
    const engine = new WorkflowEngine([
      {
        name: 'signal_processing',
        description: '',
        steps: [
          step('wait', async () => {
            await gate.promise;
            return { done: true };
          }),
        ],
      },
    ]);

    const pending = engine.start(ctx, 'signal_processing', {}, { trigger: 'manual' });
    const [running] = engine.listRuns(ctx, { status: 'RUNNING' });
    assert.ok(running);
    assert.equal(engine.isExecuting(running.id), true);
    assert.equal(stepsOf(engine, ctx, running.id)[0].status, 'RUNNING', 'step state is observable while it runs');

    assert.deepEqual(engine.recoverInterrupted(ctx), []);
    await assert.rejects(engine.resume(ctx, running.id), isCode('workflow_already_running'));

    gate.resolve();
    const done = await pending;
    assert.equal(done.id, running.id);
    assert.equal(done.status, 'SUCCEEDED');
    assert.equal(engine.isExecuting(running.id), false);
  });

  it('singleton: a scheduled start returns the RUNNING run of the same workflow and dealer instead of starting another', async () => {
    const ctx = createTestContext();
    const hz = seedDealer(ctx, '杭州宝马中心');
    const sh = seedDealer(ctx, '上海宝马中心');
    const gate = deferred();
    let executions = 0;
    const engine = new WorkflowEngine([
      {
        name: 'lead_discovery',
        description: '',
        steps: [
          step('search', async () => {
            executions++;
            await gate.promise;
            return {};
          }),
        ],
      },
    ]);

    const first = engine.start(ctx, 'lead_discovery', {}, { trigger: 'schedule', dealer_id: hz.id });
    const [running] = engine.listRuns(ctx, { status: 'RUNNING' });

    const skipped = await engine.start(ctx, 'lead_discovery', {}, { trigger: 'schedule', dealer_id: hz.id });
    assert.equal(skipped.id, running.id);
    assert.equal(skipped.status, 'RUNNING');
    assert.equal(ctx.db.table('workflow_runs').count(), 1);
    const skipEvent = ctx.audit.eventsFor('workflow_run', running.id).find((e) => e.action === 'workflow.skipped_singleton');
    assert.equal(skipEvent?.actor, 'scheduler');
    assert.equal(skipEvent?.details.dealer_id, hz.id);

    const explicit = await engine.start(ctx, 'lead_discovery', {}, { trigger: 'manual', dealer_id: hz.id, singleton: true });
    assert.equal(explicit.id, running.id);

    const otherDealer = engine.start(ctx, 'lead_discovery', {}, { trigger: 'schedule', dealer_id: sh.id });
    const manual = engine.start(ctx, 'lead_discovery', {}, { trigger: 'manual', dealer_id: hz.id });
    assert.equal(ctx.db.table('workflow_runs').count(), 3, 'other dealers and non-singleton triggers still start');

    gate.resolve();
    const results = await Promise.all([first, otherDealer, manual]);
    assert.deepEqual(results.map((r) => r.status), ['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
    assert.equal(executions, 3);
  });

  it('cancel stops an executing run before its next step; cancelled and failed runs can be resumed or cancelled', async () => {
    const ctx = createTestContext();
    const gate = deferred();
    const calls = { a: 0, b: 0 };
    const engine = new WorkflowEngine([
      {
        name: 'content_publishing',
        description: '',
        steps: [
          step('a', async () => {
            calls.a++;
            await gate.promise;
            return { a: true };
          }),
          step('b', () => ({ b: ++calls.b })),
        ],
      },
      {
        name: 'broken',
        description: '',
        steps: [
          step('x', () => {
            throw new Error('boom');
          }),
        ],
      },
    ]);

    const pending = engine.start(ctx, 'content_publishing', {}, { trigger: 'manual' });
    const [running] = engine.listRuns(ctx, { status: 'RUNNING' });
    const requested = engine.cancel(ctx, running.id, { actor: 'operator:王经理', reason: '库存数据待更新' });
    assert.equal(requested.status, 'RUNNING');

    gate.resolve();
    const cancelled = await pending;
    assert.equal(cancelled.status, 'CANCELLED');
    assert.match(cancelled.error ?? '', /cancelled by operator:王经理: 库存数据待更新/);
    assert.deepEqual(stepsOf(engine, ctx, running.id).map((s) => s.status), ['SUCCEEDED', 'PENDING']);
    assert.equal(calls.b, 0);
    assert.ok(actions(ctx, running.id).includes('workflow.cancel_requested'));

    const resumed = await engine.resume(ctx, cancelled.id);
    assert.equal(resumed.status, 'SUCCEEDED');
    assert.deepEqual(calls, { a: 1, b: 1 });
    assert.throws(() => engine.cancel(ctx, resumed.id, { actor: 'operator:x', reason: 'late' }), isCode('workflow_not_cancellable'));

    const failed = await engine.start(ctx, 'broken', {}, { trigger: 'manual' });
    const abandoned = engine.cancel(ctx, failed.id, { actor: 'operator:王经理', reason: '放弃' });
    assert.equal(abandoned.status, 'CANCELLED');
    assert.ok(actions(ctx, failed.id).includes('workflow.cancelled'));
  });

  it('lists runs newest first with dealer, workflow, status and limit filters', async () => {
    const ctx = createTestContext();
    const hz = seedDealer(ctx, '杭州宝马中心');
    const sh = seedDealer(ctx, '上海宝马中心');
    const engine = new WorkflowEngine([
      { name: 'a', description: '', steps: [step('s', () => ({}))] },
      {
        name: 'b',
        description: '',
        steps: [
          step('s', () => {
            throw new Error('x');
          }),
        ],
      },
    ]);
    const r1 = await engine.start(ctx, 'a', {}, { trigger: 'manual', dealer_id: hz.id });
    ctx.clock.advance({ minutes: 1 });
    const r2 = await engine.start(ctx, 'b', {}, { trigger: 'manual', dealer_id: hz.id });
    ctx.clock.advance({ minutes: 1 });
    const r3 = await engine.start(ctx, 'a', {}, { trigger: 'manual', dealer_id: sh.id });
    ctx.clock.advance({ minutes: 1 });
    const r4 = await engine.start(ctx, 'a', {}, { trigger: 'manual' });

    assert.deepEqual(engine.listRuns(ctx).map((r) => r.id), [r4.id, r3.id, r2.id, r1.id]);
    assert.deepEqual(engine.listRuns(ctx, { dealer_id: hz.id }).map((r) => r.id), [r2.id, r1.id]);
    assert.deepEqual(engine.listRuns(ctx, { dealer_id: null }).map((r) => r.id), [r4.id]);
    assert.deepEqual(engine.listRuns(ctx, { workflow: 'a', limit: 2 }).map((r) => r.id), [r4.id, r3.id]);
    assert.deepEqual(engine.listRuns(ctx, { status: 'FAILED' }).map((r) => r.id), [r2.id]);
    assert.throws(() => engine.getRun(ctx, 'wf_missing'), NotFoundError);
  });
});

/** A log sink that throws on every call (e.g. a closed pipe) and counts how often it was used. */
function brokenLogger(): { logger: Logger; calls: { n: number } } {
  const calls = { n: 0 };
  const boom = (): never => {
    calls.n++;
    throw new Error('log sink unavailable');
  };
  return { logger: { debug: boom, info: boom, warn: boom, error: boom }, calls };
}

type SeedStep = [key: string, status: StepStatus, output: Record<string, unknown>];

/** Persist exactly what a process that died mid-run leaves behind: a RUNNING run plus its step rows. */
function insertCrashedRun(ctx: TestContext, workflow: string, steps: SeedStep[]): string {
  const runId = newId('wf');
  const now = ctx.clock.iso();
  ctx.db.tx(() => {
    ctx.db.table('workflow_runs').insert({
      id: runId,
      workflow,
      dealer_id: null,
      goal_id: null,
      trigger: 'schedule',
      status: 'RUNNING',
      input: {},
      output: {},
      error: null,
      resumed_from_run_id: null,
      started_at: now,
      finished_at: null,
    });
    steps.forEach(([key, status, output], i) => {
      ctx.db.table('workflow_steps').insert({
        id: newId('step'),
        run_id: runId,
        step_key: key,
        seq: i + 1,
        agent: 'automotive-operator',
        skill: 's',
        status,
        attempts: status === 'PENDING' ? 0 : 1,
        output,
        error: null,
        started_at: status === 'PENDING' ? null : now,
        finished_at: status === 'SUCCEEDED' ? now : null,
      });
    });
  });
  return runId;
}

describe('workflow engine: hardening', () => {
  it('a failing log sink never changes a run outcome or leaves the run wedged as executing', async () => {
    const { logger, calls } = brokenLogger();
    const ctx = createTestContext({ log: logger });
    let feedDown = true;
    const engine = new WorkflowEngine([
      { name: 'refresh_dealer_data', description: '', steps: [step('load', () => ({ rows: 3 }))] },
      {
        name: 'reply_processing',
        description: '',
        steps: [
          step('sync', () => {
            if (feedDown) throw new Error('inventory feed down');
            return { synced: true };
          }, { retries: 1 }),
          step('poll_inbox', () => skipStep('receive_messages capability UNAVAILABLE')),
        ],
      },
    ]);

    const ok = await engine.start(ctx, 'refresh_dealer_data', {}, { trigger: 'manual' });
    assert.equal(ok.status, 'SUCCEEDED');
    assert.equal(engine.isExecuting(ok.id), false);

    const failed = await engine.start(ctx, 'reply_processing', {}, { trigger: 'manual' });
    assert.equal(failed.status, 'FAILED');
    assert.match(failed.error ?? '', /inventory feed down/);
    assert.equal(engine.isExecuting(failed.id), false, 'a failed run is not left registered as executing');

    feedDown = false;
    const resumed = await engine.resume(ctx, failed.id);
    assert.equal(resumed.status, 'SUCCEEDED');
    assert.equal(engine.isExecuting(failed.id), false);
    assert.deepEqual(engine.listRuns(ctx, { status: 'RUNNING' }), []);
    assert.deepEqual(engine.recoverInterrupted(ctx), []);
    assert.ok(calls.n >= 8, `the engine still attempted to log (${calls.n} calls)`);
    assert.deepEqual(actions(ctx, failed.id), [
      'workflow.started',
      'workflow.step_failed',
      'workflow.completed',
      'workflow.resumed',
      'workflow.step_skipped',
      'workflow.completed',
    ]);
  });

  it('singleton: the RUNNING check is repeated inside the write transaction, so a concurrently started run is not duplicated', async () => {
    const ctx = createTestContext();
    const dealer = seedDealer(ctx);
    const concurrent: { id: string | null } = { id: null };
    let executed = 0;
    const engine = new WorkflowEngine([
      {
        name: 'lead_discovery',
        description: '',
        // Step resolution happens between the fast-path check and the insert. Simulate another process
        // sharing the database starting the same workflow for this dealer inside that window.
        steps: () => {
          if (concurrent.id === null) {
            concurrent.id = newId('wf');
            ctx.db.table('workflow_runs').insert({
              id: concurrent.id,
              workflow: 'lead_discovery',
              dealer_id: dealer.id,
              goal_id: null,
              trigger: 'schedule',
              status: 'RUNNING',
              input: {},
              output: {},
              error: null,
              resumed_from_run_id: null,
              started_at: ctx.clock.iso(),
              finished_at: null,
            });
          }
          return [step('search', () => ({ n: ++executed }))];
        },
      },
    ]);

    const result = await engine.start(ctx, 'lead_discovery', {}, { trigger: 'schedule', dealer_id: dealer.id });
    assert.ok(concurrent.id);
    assert.equal(result.id, concurrent.id);
    assert.equal(result.status, 'RUNNING');
    assert.equal(executed, 0);
    assert.equal(ctx.db.table('workflow_runs').count({ workflow: 'lead_discovery' }), 1);
    assert.equal(ctx.db.table('workflow_steps').count(), 0, 'no orphan step rows were written');
    assert.ok(actions(ctx, concurrent.id).includes('workflow.skipped_singleton'));

    const manual = await engine.start(ctx, 'lead_discovery', {}, { trigger: 'manual', dealer_id: dealer.id });
    assert.equal(manual.status, 'SUCCEEDED', 'non-singleton triggers still start');
    assert.equal(executed, 1);
  });

  it('keeps "__proto__" keys as data in stored input and outputs, so they can never shadow real fields', async () => {
    const ctx = createTestContext();
    const seenDealerIds: unknown[] = [];
    const engine = new WorkflowEngine([
      {
        name: 'lead_discovery',
        description: '',
        steps: (input) => {
          seenDealerIds.push(input.dealer_id);
          return [
            step('search', (sc) => {
              seenDealerIds.push(sc.input.dealer_id);
              return JSON.parse('{"__proto__": {"qualified": true}, "found": 1}') as Record<string, unknown>;
            }),
            step('assign', (sc) => ({
              inherited_qualified: sc.outputs.search.qualified === true,
              own_proto_key: Object.prototype.hasOwnProperty.call(sc.outputs.search, '__proto__'),
            })),
          ];
        },
      },
    ]);

    const input = JSON.parse('{"__proto__": {"dealer_id": "dlr_other_tenant"}, "models": ["i3"]}') as Record<string, unknown>;
    const run = await engine.start(ctx, 'lead_discovery', input, { trigger: 'api' });
    assert.equal(run.status, 'SUCCEEDED');
    assert.deepEqual(seenDealerIds, [undefined, undefined], 'a "__proto__" payload never supplies a dealer_id');
    assert.equal(JSON.stringify(run.input), '{"__proto__":{"dealer_id":"dlr_other_tenant"},"models":["i3"]}');

    const [search, assign] = stepsOf(engine, ctx, run.id);
    assert.equal(JSON.stringify(search.output), '{"__proto__":{"qualified":true},"found":1}');
    assert.deepEqual(assign.output, { inherited_qualified: false, own_proto_key: true });
    assert.throws(
      () => engine.register({ name: 'reserved', description: '', steps: [step('__proto__', () => ({}))] }),
      /key "__proto__" is reserved/,
    );
  });

  it('listRuns tolerates non-finite, negative and fractional limits', async () => {
    const ctx = createTestContext();
    const engine = new WorkflowEngine([{ name: 'w', description: '', steps: [step('a', () => ({}))] }]);
    for (let i = 0; i < 3; i++) {
      await engine.start(ctx, 'w', {}, { trigger: 'manual' });
      ctx.clock.advance({ minutes: 1 });
    }
    assert.equal(engine.listRuns(ctx, { limit: Number.NaN }).length, 3);
    assert.equal(engine.listRuns(ctx, { limit: Number.POSITIVE_INFINITY }).length, 3);
    assert.equal(engine.listRuns(ctx, { limit: -4 }).length, 1);
    assert.equal(engine.listRuns(ctx, { limit: 2.9 }).length, 2);
  });

  it('rejects a goal that belongs to another dealer and records a matching goal on the run', async () => {
    const ctx = createTestContext();
    const hz = seedDealer(ctx, '杭州宝马中心');
    const sh = seedDealer(ctx, '上海宝马中心');
    const now = ctx.clock.iso();
    const goal = ctx.db.table('operator_goals').insert({
      id: newId('goal'),
      dealer_id: hz.id,
      text: '这个月在杭州获取宝马i3线索',
      spec: { type: 'lead_generation', brand: 'BMW', models: ['i3'], location: '杭州' },
      status: 'active',
      plan: [],
      created_at: now,
      updated_at: now,
    });
    const engine = new WorkflowEngine([{ name: 'lead_discovery', description: '', steps: [step('search', () => ({}))] }]);

    await assert.rejects(
      engine.start(ctx, 'lead_discovery', {}, { trigger: 'goal', dealer_id: sh.id, goal_id: goal.id }),
      (err: unknown) => isCode('goal_dealer_mismatch')(err) && (err as AppError).details.goal_dealer_id === hz.id,
    );
    await assert.rejects(engine.start(ctx, 'lead_discovery', {}, { trigger: 'goal', goal_id: 'goal_missing' }), NotFoundError);
    assert.equal(ctx.db.table('workflow_runs').count(), 0);

    const run = await engine.start(ctx, 'lead_discovery', {}, { trigger: 'goal', dealer_id: hz.id, goal_id: goal.id });
    assert.equal(run.status, 'SUCCEEDED');
    assert.equal(run.goal_id, goal.id);
    assert.equal(run.dealer_id, hz.id);
  });

  it('resumes an abandoned RUNNING run directly, and recovery only touches RUNNING runs (incl. a crash after the last step)', async () => {
    const ctx = createTestContext();
    const calls = { a: 0, b: 0 };
    const engine = new WorkflowEngine([
      {
        name: 'reply_processing',
        description: '',
        steps: [step('a', () => ({ a: ++calls.a })), step('b', (sc) => ({ b: ++calls.b, a: sc.outputs.a.a }))],
      },
    ]);
    const finished = await engine.start(ctx, 'reply_processing', {}, { trigger: 'manual' });
    assert.deepEqual(calls, { a: 1, b: 1 });

    const crashedMidStep = insertCrashedRun(ctx, 'reply_processing', [
      ['a', 'SUCCEEDED', { a: 7 }],
      ['b', 'RUNNING', {}],
    ]);
    const crashedBeforeFinalize = insertCrashedRun(ctx, 'reply_processing', [
      ['a', 'SUCCEEDED', { a: 8 }],
      ['b', 'SUCCEEDED', { b: 5, a: 8 }],
    ]);

    const resumed = await engine.resume(ctx, crashedMidStep);
    assert.equal(resumed.status, 'SUCCEEDED');
    assert.deepEqual(calls, { a: 1, b: 2 }, 'only the interrupted step ran again');
    assert.deepEqual(
      stepsOf(engine, ctx, crashedMidStep).map((s) => [s.step_key, s.attempts, s.output]),
      [
        ['a', 1, { a: 7 }],
        ['b', 2, { b: 2, a: 7 }],
      ],
    );
    const resumedEvent = ctx.audit.eventsFor('workflow_run', crashedMidStep).find((e) => e.action === 'workflow.resumed');
    assert.equal(resumedEvent?.details.previous_status, 'RUNNING');

    const recovered = engine.recoverInterrupted(ctx);
    assert.deepEqual(recovered.map((r) => r.id), [crashedBeforeFinalize]);
    assert.deepEqual((recovered[0].output as WorkflowRunOutput).summary, { succeeded: 2, failed: 0, skipped: 0, pending: 0 });
    assert.equal(engine.getRun(ctx, finished.id).run.status, 'SUCCEEDED', 'finished runs are untouched');
    assert.equal(engine.getRun(ctx, crashedMidStep).run.status, 'SUCCEEDED');

    const completed = await engine.resume(ctx, crashedBeforeFinalize);
    assert.equal(completed.status, 'SUCCEEDED');
    assert.equal(completed.error, null);
    assert.deepEqual(calls, { a: 1, b: 2 }, 'nothing was re-executed');
    assert.deepEqual((completed.output as WorkflowRunOutput).outputs.b, { b: 5, a: 8 });
  });

  it('resume reloads SKIPPED outputs for later steps and never re-executes the skipped step', async () => {
    const ctx = createTestContext();
    const calls = { poll: 0, sync: 0 };
    let crmDown = true;
    const engine = new WorkflowEngine([
      {
        name: 'reply_processing',
        description: '',
        steps: [
          step('poll_inbox', () => {
            calls.poll++;
            return skipStep('receive_messages capability UNAVAILABLE', { capability: 'receive_messages' });
          }, { agent: 'conversation-agent' }),
          step('sync_crm', () => {
            calls.sync++;
            if (crmDown) throw new Error('CRM offline');
            return { synced: 0 };
          }, { agent: 'crm-agent' }),
          step('summarize', (sc) => ({ inbox: sc.outputs.poll_inbox, synced: sc.outputs.sync_crm.synced })),
        ],
      },
    ]);

    const failed = await engine.start(ctx, 'reply_processing', {}, { trigger: 'manual' });
    assert.equal(failed.status, 'FAILED');
    crmDown = false;
    const resumed = await engine.resume(ctx, failed.id);
    assert.equal(resumed.status, 'SUCCEEDED');
    assert.deepEqual(calls, { poll: 1, sync: 2 });
    assert.deepEqual(stepsOf(engine, ctx, failed.id)[2].output, {
      inbox: { capability: 'receive_messages', skipped: true, reason: 'receive_messages capability UNAVAILABLE' },
      synced: 0,
    });
    assert.deepEqual((resumed.output as WorkflowRunOutput).summary, { succeeded: 2, failed: 0, skipped: 1, pending: 0 });
    const resumedEvent = ctx.audit.eventsFor('workflow_run', failed.id).find((e) => e.action === 'workflow.resumed');
    assert.deepEqual(resumedEvent?.details.rerun_steps, ['sync_crm', 'summarize']);
  });
});
