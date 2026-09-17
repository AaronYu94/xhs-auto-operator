/**
 * Goal planner: the plan an operator sees is exactly the step list `goal_execution` will run for the goal type,
 * plus preview notes computed from real rows (carried models, active accounts, provider mode, how many search
 * queries the goal would produce). No step is described that the workflow does not execute.
 */
import type { AppContext } from '../app/context.ts';
import { ValidationError } from '../core/errors.ts';
import type { Dealer, GoalSpec, OperatorGoal } from '../core/types.ts';
import { planQueries } from '../skills/acquisition/automotive-query-generation/index.ts';
import { goalExecutionSteps } from './workflows.ts';

export type GoalPlanStep = OperatorGoal['plan'][number];

export function planGoal(_ctx: AppContext, dealer: Dealer, spec: GoalSpec): GoalPlanStep[] {
  return goalExecutionSteps({ dealer_id: dealer.id, goal_type: spec.type }).map((s) => ({
    step_key: s.key,
    agent: s.agent,
    skill: s.skill,
    description: s.description,
  }));
}

/** Preview notes for the goal (Chinese), from Dealer Brain rows and runtime configuration. */
export function explainPlan(ctx: AppContext, dealer: Dealer, spec: GoalSpec): string[] {
  const notes: string[] = [];
  const accounts = ctx.db.table('xhs_accounts').count({ dealer_id: dealer.id, status: 'active' });
  notes.push(`${dealer.name} 当前活跃小红书账号 ${accounts} 个`);
  if (ctx.xhs.mode === 'simulation') notes.push(`小红书接入：${ctx.xhs.name}（模拟数据模式，结果不是真实客户）`);
  else if (ctx.xhs.mode === 'none') notes.push('小红书接入未配置：无法搜索公开内容，只能处理人工导入的数据');
  else notes.push(`小红书接入：${ctx.xhs.name}（${ctx.xhs.mode}），执行时实时检测登录与能力状态`);

  if (spec.type === 'lead_generation' || spec.type === 'daily_operations') {
    try {
      const planned = planQueries(ctx, { dealer_id: dealer.id, goal: spec });
      const classes = new Set(planned.map((q) => q.query_class));
      notes.push(`将生成 ${planned.length} 个搜索词，覆盖 ${classes.size} 类`);
    } catch (err) {
      if (err instanceof ValidationError) notes.push(`搜索词无法生成：${err.message}`);
      else throw err;
    }
  }
  if (spec.type === 'content_campaign' && accounts === 0) notes.push('没有活跃账号：内容计划无法生成');
  return notes;
}
