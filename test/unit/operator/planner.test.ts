import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GoalType } from '../../../src/core/types.ts';
import { explainPlan, planGoal } from '../../../src/operator/planner.ts';
import { goalExecutionSteps } from '../../../src/operator/workflows.ts';
import { getDealer } from '../../../src/skills/operations/dealer-brain/index.ts';
import { createTestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';

describe('planGoal / explainPlan', () => {
  it('the plan is exactly the goal_execution step list for each goal type', () => {
    const ctx = createTestContext();
    const dealer = getDealer(ctx, dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw'));
    for (const type of ['lead_generation', 'content_campaign', 'daily_operations', 'reporting'] as GoalType[]) {
      const plan = planGoal(ctx, dealer, { type, models: [] });
      const steps = goalExecutionSteps({ goal_type: type });
      assert.deepEqual(
        plan.map((p) => p.step_key),
        steps.map((s) => s.key),
      );
      assert.ok(plan.every((p) => p.description.length > 5 && p.agent && p.skill));
      assert.equal(new Set(plan.map((p) => p.step_key)).size, plan.length, 'unique step keys');
    }
    const lead = planGoal(ctx, dealer, { type: 'lead_generation', models: ['i3'] }).map((p) => p.step_key);
    for (const key of ['ensure_queries', 'discover', 'assign_leads', 'prepare_outreach', 'update_goal_progress']) assert.ok(lead.includes(key));
  });

  it('preview notes are grounded in real rows and the configured provider', () => {
    const ctx = createTestContext();
    const dealer = getDealer(ctx, dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw'));
    const notes = explainPlan(ctx, dealer, { type: 'lead_generation', brand: 'BMW', models: ['i3'], location: '杭州' });
    assert.ok(notes.some((n) => n.includes('活跃小红书账号 6 个')), notes.join('\n'));
    assert.ok(notes.some((n) => n.includes('未配置')));
    assert.ok(notes.some((n) => /将生成 \d+ 个搜索词，覆盖 5 类/.test(n)), notes.join('\n'));
    const bad = explainPlan(ctx, dealer, { type: 'lead_generation', models: ['Model 3'] });
    assert.ok(bad.some((n) => n.startsWith('搜索词无法生成')), bad.join('\n'));
  });
});
