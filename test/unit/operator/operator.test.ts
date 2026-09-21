import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AutomotiveOperator } from '../../../src/operator/operator.ts';
import { WorkflowEngine } from '../../../src/operator/workflow-engine.ts';
import { GOAL_WORKFLOW, buildWorkflows } from '../../../src/operator/workflows.ts';
import { DEFAULT_SIMULATION_CORPUS_PATH, SimulationXhsProvider } from '../../../src/providers/xhs/simulation.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';

function setup(withSimulation: boolean): { ctx: TestContext; dealerId: string; operator: AutomotiveOperator } {
  const ctx = createTestContext();
  const summary = loadDealerFixture(ctx);
  if (withSimulation) {
    const internalToPlatform = Object.fromEntries(Object.entries(summary.account_ids).map(([platform, internal]) => [internal, platform]));
    ctx.xhs = SimulationXhsProvider.fromFile(ctx.clock, DEFAULT_SIMULATION_CORPUS_PATH, { account_platform_ids: internalToPlatform });
  }
  return { ctx, dealerId: dealerIdByKey(summary, 'hz-bmw'), operator: new AutomotiveOperator(new WorkflowEngine(buildWorkflows())) };
}

describe('AutomotiveOperator.submitGoal', () => {
  it('persists the goal with its plan and an auditable goal_planning decision', async () => {
    const { ctx, dealerId, operator } = setup(false);
    const { goal, run } = await operator.submitGoal(ctx, { dealer_id: dealerId, text: '这个月在杭州获取宝马i3线索，目标30条', actor: 'operator:王经理' });
    assert.equal(goal.spec.type, 'lead_generation');
    assert.deepEqual(goal.spec.models, ['i3']);
    assert.equal(goal.spec.target_leads, 30);
    assert.ok(goal.plan.length >= 5);
    assert.equal(run.workflow, GOAL_WORKFLOW);
    assert.equal(run.trigger, 'goal');
    assert.equal(run.goal_id, goal.id);
    const decision = ctx.db.table('agent_decisions').findOne({ decision_type: 'goal_planning', subject_id: goal.id });
    assert.ok(decision);
    assert.ok(decision.evidence.length > 0);
    assert.ok(ctx.db.table('audit_events').findOne({ action: 'goal.created', entity_id: goal.id }));
  });

  it('without a Xiaohongshu integration the goal run skips discovery honestly and the goal stays active', async () => {
    const { ctx, dealerId, operator } = setup(false);
    const { goal, run } = await operator.submitGoal(ctx, { dealer_id: dealerId, text: 'Generate BMW i3 leads in Hangzhou this month', actor: 'operator' });
    const steps = operator.engine.getRun(ctx, run.id).steps;
    assert.equal(steps.find((s) => s.step_key === 'discover')?.status, 'SKIPPED');
    assert.equal(ctx.db.table('leads').count(), 0);
    assert.equal(ctx.db.table('operator_goals').require(goal.id).status, 'active');
  });

  it('when every search fails without a block, discovery is SKIPPED with the reason, never counted as done', async () => {
    const { ctx, dealerId, operator } = setup(true);
    ctx.xhs.searchNotes = async () => ({ ok: false, status: 'REQUIRES_REVIEW', reason: 'unexpected page layout' });
    const { run } = await operator.submitGoal(ctx, { dealer_id: dealerId, text: '这个月在杭州获取宝马i3线索', actor: 'operator' });
    const discover = operator.engine.getRun(ctx, run.id).steps.find((s) => s.step_key === 'discover');
    assert.equal(discover?.status, 'SKIPPED');
    assert.match(String(discover?.output.reason), /^\d+ 个搜索词都没有搜索成功：REQUIRES_REVIEW: unexpected page layout/);
    assert.equal(ctx.db.table('leads').count(), 0);
  });

  it('a manual lead_discovery run can be limited (small trial: queries, notes per query, comments per note)', async () => {
    const { ctx, dealerId, operator } = setup(true);
    await operator.submitGoal(ctx, { dealer_id: dealerId, text: '这个月在杭州获取宝马i3线索', actor: 'operator' });
    const before = ctx.db.table('search_runs').count();
    const run = await operator.engine.start(
      ctx,
      'lead_discovery',
      { dealer_id: dealerId, max_queries: 1, max_posts: 1, max_comments_per_post: 2 },
      { trigger: 'manual', dealer_id: dealerId },
    );
    const discover = operator.engine.getRun(ctx, run.id).steps.find((s) => s.step_key === 'discover');
    const runs = discover?.output.runs as { posts_discovered: number; comments_scanned: number }[];
    assert.equal(runs.length, 1);
    assert.ok(runs[0].posts_discovered <= 1);
    assert.ok(runs[0].comments_scanned <= 2);
    assert.equal(ctx.db.table('search_runs').count(), before + 1);
  });

  it('background submission returns the RUNNING run immediately and finishes later', async () => {
    const { ctx, dealerId, operator } = setup(false);
    const { run } = await operator.submitGoal(ctx, { dealer_id: dealerId, text: '生成今天的经营报告', actor: 'operator' }, { background: true });
    assert.equal(run.status, 'RUNNING');
    for (let i = 0; i < 200 && operator.engine.isExecuting(run.id); i++) await new Promise((r) => setTimeout(r, 5));
    const final = operator.engine.getRun(ctx, run.id).run;
    assert.equal(final.status, 'SUCCEEDED', final.error ?? '');
    assert.equal(ctx.db.table('operator_goals').findOne({ dealer_id: dealerId })?.status, 'completed');
  });

  it('end-to-end with the simulation provider: queries → search runs → leads → exclusive assignment → review-required outreach', async () => {
    const { ctx, dealerId, operator } = setup(true);
    const { goal, run } = await operator.submitGoal(ctx, { dealer_id: dealerId, text: '这个月在杭州获取宝马i3线索', actor: 'operator' });
    const steps = Object.fromEntries(operator.engine.getRun(ctx, run.id).steps.map((s) => [s.step_key, s]));
    assert.notEqual(run.status, 'FAILED', `${run.error} ${JSON.stringify(steps)}`);
    assert.equal(steps.discover.status, 'SUCCEEDED', JSON.stringify(steps.discover));

    const searchRuns = ctx.db.table('search_runs').findMany({ dealer_id: dealerId });
    assert.ok(searchRuns.length > 0);
    assert.ok(searchRuns.every((r) => r.data_mode === 'simulation'), 'simulation data is labelled as simulation');

    const leads = ctx.db.table('leads').findMany({});
    assert.ok(leads.length > 0, 'discovery produced leads');
    assert.ok(leads.every((l) => l.data_mode === 'simulation'));
    const qualified = leads.filter((l) => ['ASSIGNED', 'OUTREACH_READY', 'CONTACTED'].includes(l.stage));
    assert.ok(qualified.length > 0, `assigned leads expected; stages: ${JSON.stringify(leads.map((l) => l.stage))}`);

    const perLead = ctx.db.all<{ lead_id: string; n: number }>('SELECT lead_id, COUNT(*) AS n FROM lead_assignments WHERE active = 1 GROUP BY lead_id');
    assert.ok(perLead.length > 0);
    assert.ok(perLead.every((r) => Number(r.n) === 1), 'exactly one active owner per lead');

    assert.equal(steps.prepare_outreach.status, 'SUCCEEDED', JSON.stringify(steps.prepare_outreach));
    const outreach = ctx.db.table('outreach').findMany({});
    assert.ok(outreach.length > 0);
    assert.ok(outreach.every((o) => o.status !== 'SENT'), 'nothing is marked SENT without a provider-confirmed id (send_messages unavailable)');
    assert.ok(outreach.some((o) => o.status === 'READY_FOR_REVIEW'));
    for (const o of outreach) {
      const owner = ctx.db.table('lead_assignments').findOne({ lead_id: o.lead_id, active: true });
      assert.equal(o.account_id, owner?.account_id, 'outreach comes from the owning account');
    }

    const progress = steps.update_goal_progress.output;
    assert.ok((progress.qualified_leads as number) > 0);
    assert.equal(ctx.db.table('operator_goals').require(goal.id).status, 'active');
  });
});

describe('AutomotiveOperator.runDaily / runWorkflow', () => {
  it('runs every daily workflow once in pipeline order', async () => {
    const { ctx, dealerId, operator } = setup(false);
    const runs = await operator.runDaily(ctx, dealerId);
    assert.deepEqual(
      runs.map((r) => r.workflow),
      ['refresh_dealer_data', 'market_research', 'account_planning', 'lead_discovery', 'signal_processing', 'reply_processing', 'content_publishing', 'performance_collection', 'evening_analysis'],
    );
    for (const r of runs) assert.notEqual(r.status, 'FAILED', `${r.workflow}: ${r.error}`);
    await assert.rejects(operator.runWorkflow(ctx, GOAL_WORKFLOW, dealerId), /submitGoal/);
  });
});
