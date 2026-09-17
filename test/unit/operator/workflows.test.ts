import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { DEFAULT_DAILY_SCHEDULE } from '../../../src/operator/scheduler.ts';
import { WorkflowEngine } from '../../../src/operator/workflow-engine.ts';
import { GOAL_WORKFLOW, buildWorkflows, goalExecutionSteps, missingScheduledWorkflows } from '../../../src/operator/workflows.ts';
import { ALL_SKILLS, registerAllSkills } from '../../../src/skills/index.ts';
import { createTestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';

const SKILLS_ROOT = fileURLToPath(new URL('../../../src/skills/', import.meta.url));

describe('buildWorkflows', () => {
  it('registers every daily-schedule workflow plus goal_execution; every definition validates', () => {
    const defs = buildWorkflows();
    const names = defs.map((d) => d.name);
    for (const entry of DEFAULT_DAILY_SCHEDULE) assert.ok(names.includes(entry.workflow), `missing ${entry.workflow}`);
    assert.ok(names.includes(GOAL_WORKFLOW));
    assert.deepEqual(missingScheduledWorkflows(defs), []);
    const engine = new WorkflowEngine(defs);
    for (const type of ['lead_generation', 'content_campaign', 'daily_operations', 'reporting']) {
      const steps = engine.resolveSteps(engine.get(GOAL_WORKFLOW), { goal_type: type });
      assert.ok(steps.length >= 2);
      assert.equal(steps.at(-1)?.key, 'update_goal_progress');
    }
    assert.deepEqual(
      goalExecutionSteps({}).map((s) => s.key),
      goalExecutionSteps({ goal_type: 'lead_generation' }).map((s) => s.key),
    );
  });

  it('every skill directory on disk is registered by registerAllSkills', () => {
    const dirs: string[] = [];
    for (const category of readdirSync(SKILLS_ROOT)) {
      const catDir = join(SKILLS_ROOT, category);
      if (!statSync(catDir).isDirectory()) continue;
      for (const name of readdirSync(catDir)) {
        if (existsSync(join(catDir, name, 'index.ts'))) dirs.push(name);
      }
    }
    const registry = registerAllSkills();
    const registered = registry.list().map((s) => s.name);
    for (const name of dirs) assert.ok(registered.includes(name), `skill directory ${name} is not registered in src/skills/index.ts`);
    assert.equal(new Set(ALL_SKILLS.map((s) => s.name)).size, ALL_SKILLS.length, 'no duplicate skills');
    assert.equal(registerAllSkills(registry).list().length, registered.length, 'idempotent');
  });
});

describe('workflows with no Xiaohongshu integration (honest skips, no fabricated data)', () => {
  it('lead_discovery: queries generated from Dealer Brain, discovery SKIPPED with the provider reason, zero public rows', async () => {
    const ctx = createTestContext();
    const dealerId = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const engine = new WorkflowEngine(buildWorkflows());
    const run = await engine.start(ctx, 'lead_discovery', { dealer_id: dealerId }, { trigger: 'manual', dealer_id: dealerId });
    const { steps } = engine.getRun(ctx, run.id);
    const byKey = Object.fromEntries(steps.map((s) => [s.step_key, s]));
    assert.equal(byKey.ensure_queries.status, 'SUCCEEDED');
    assert.ok((byKey.ensure_queries.output.generated as number) > 0);
    assert.equal(byKey.discover.status, 'SKIPPED', JSON.stringify(byKey.discover));
    assert.match(String(byKey.discover.output.reason), /UNAVAILABLE/);
    assert.equal(byKey.research_leads.status, 'SKIPPED');
    assert.equal(ctx.db.table('public_posts').count(), 0);
    assert.equal(ctx.db.table('public_comments').count(), 0);
    assert.equal(ctx.db.table('leads').count(), 0);
    assert.notEqual(run.status, 'FAILED', run.error ?? '');
    const searchRuns = ctx.db.table('search_runs').findMany({});
    assert.ok(searchRuns.every((r) => r.status === 'UNAVAILABLE' && r.posts_discovered === 0));
  });

  it('refresh_dealer_data: Dealer Brain check, fleet health, sessions skipped, capability snapshots persisted', async () => {
    const ctx = createTestContext();
    const dealerId = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const engine = new WorkflowEngine(buildWorkflows());
    const run = await engine.start(ctx, 'refresh_dealer_data', { dealer_id: dealerId }, { trigger: 'manual', dealer_id: dealerId });
    assert.equal(run.status, 'SUCCEEDED', run.error ?? '');
    const { steps } = engine.getRun(ctx, run.id);
    const byKey = Object.fromEntries(steps.map((s) => [s.step_key, s]));
    assert.equal(byKey.check_dealer_facts.output.active_accounts, 6);
    assert.ok((byKey.check_dealer_facts.output.vehicles as number) > 0);
    assert.equal(byKey.account_health.status, 'SUCCEEDED');
    assert.equal(byKey.account_sessions.status, 'SKIPPED');
    assert.equal(byKey.capability_snapshot.status, 'SUCCEEDED');
    const snapshots = ctx.db.table('capability_snapshots').findMany({});
    assert.ok(snapshots.length > 6);
    assert.ok(snapshots.every((s) => s.capability === 'llm' || s.status === 'UNAVAILABLE'), 'nothing reported available without a provider');
    assert.ok(snapshots.some((s) => s.account_id !== null && s.capability === 'send_messages'), 'account-scoped capabilities are probed per account');
    const accounts = ctx.db.table('xhs_accounts').count({ dealer_id: dealerId, status: 'active' });
    assert.equal(snapshots.filter((s) => s.capability === 'send_messages').length, accounts + 1, 'provider-level probe + one per active account');
  });

  it('evening_analysis produces optimization recommendations and a persisted report', async () => {
    const ctx = createTestContext();
    const dealerId = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const engine = new WorkflowEngine(buildWorkflows());
    const run = await engine.start(ctx, 'evening_analysis', { dealer_id: dealerId }, { trigger: 'manual', dealer_id: dealerId });
    assert.equal(run.status, 'SUCCEEDED', run.error ?? '');
    assert.equal(ctx.db.table('operator_reports').count({ dealer_id: dealerId }), 1);
    assert.ok(ctx.db.table('agent_decisions').count({ decision_type: 'optimization' }) >= 1);
  });

  it('performance_collection: own-note comments are skipped honestly without a provider', async () => {
    const ctx = createTestContext();
    const summary = loadDealerFixture(ctx);
    const dealerId = dealerIdByKey(summary, 'hz-bmw');
    const engine = new WorkflowEngine(buildWorkflows());
    const run = await engine.start(ctx, 'performance_collection', { dealer_id: dealerId }, { trigger: 'manual', dealer_id: dealerId });
    assert.notEqual(run.status, 'FAILED', run.error ?? '');
    const own = engine.getRun(ctx, run.id).steps.find((s) => s.step_key === 'collect_own_comments');
    assert.equal(own?.status, 'SKIPPED');
    assert.match(String(own?.output.reason), /读取公开评论不可用/);
  });

  it('account_planning plans posts for every active account', async () => {
    const ctx = createTestContext();
    const dealerId = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const engine = new WorkflowEngine(buildWorkflows());
    const run = await engine.start(ctx, 'account_planning', { dealer_id: dealerId }, { trigger: 'manual', dealer_id: dealerId });
    assert.equal(run.status, 'SUCCEEDED', run.error ?? '');
    const accounts = ctx.db.table('xhs_accounts').findMany({ dealer_id: dealerId, status: 'active' });
    for (const a of accounts) assert.ok(ctx.db.table('posts').count({ account_id: a.id }) >= 2, `${a.nickname} has no posts`);
  });
});
