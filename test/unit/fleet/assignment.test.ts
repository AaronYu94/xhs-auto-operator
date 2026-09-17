import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NotFoundError, PolicyError, ValidationError } from '../../../src/core/errors.ts';
import type { AutomotiveIntent, Evidence, Lead, LeadAssignment, LeadStage } from '../../../src/core/types.ts';
import type { FindOptions, Where } from '../../../src/db/database.ts';
import {
  REASSIGN_CANCEL_REASON,
  STICKY_UNAVAILABLE_REASON,
  assignLead,
  getActiveAssignment,
  releaseAssignment,
  skill,
  type AssignLeadResult,
} from '../../../src/skills/acquisition/account-assignment/index.ts';
import { DEFAULT_THRESHOLDS, tierFor } from '../../../src/skills/acquisition/lead-scoring/index.ts';
import { SkillRegistry } from '../../../src/skills/registry.ts';
import { TEST_NOW, createTestContext, type TestContext } from '../../helpers/context.ts';
import {
  accountIdByPlatformId,
  dealerIdByKey,
  loadDealerFixture,
  seedAssignment,
  seedInboundReply,
  seedLead,
  seedOutreach,
  seedSuppression,
} from '../../helpers/fixtures.ts';

function setup(opts: { skills?: SkillRegistry } = {}) {
  const ctx = createTestContext(opts);
  const s = loadDealerFixture(ctx);
  return {
    ctx,
    hz: dealerIdByKey(s, 'hz-bmw'),
    sh: dealerIdByKey(s, 'sh-bmw'),
    acc: (pid: string) => accountIdByPlatformId(s, pid),
  };
}

const I3_INVENTORY: AutomotiveIntent = {
  brand: 'BMW',
  model: 'i3',
  trim: 'eDrive35L',
  location: '杭州',
  province: '浙江',
  inventory_intent: true,
  color_intent: '白外红内',
  visit_intent: true,
  purchase_stage: 'purchase_imminent',
  confidence: 0.9,
};
const EVIDENCE: Evidence[] = [
  { code: 'inventory_intent', label: '询问现车', quote: '有现车吗' },
  { code: 'specified_trim', label: '指定配置', quote: '35L' },
];

let seq = 0;
function makeLead(
  ctx: TestContext,
  dealerId: string,
  spec: { score?: number; stage?: LeadStage; intent?: AutomotiveIntent; suppressed?: boolean; user?: string } = {},
): Lead {
  const lead = seedLead(ctx, {
    dealer_id: dealerId,
    platform_user_id: spec.user ?? `fleet-asg-${++seq}`,
    stage: spec.stage ?? 'QUALIFIED',
    suppressed: spec.suppressed,
  });
  const score = spec.score ?? 96;
  return ctx.db.table('leads').update(lead.id, {
    score,
    tier: tierFor(score, DEFAULT_THRESHOLDS),
    intent: spec.intent ?? I3_INVENTORY,
    evidence: EVIDENCE,
  });
}

const activeCount = (ctx: TestContext, leadId: string) => ctx.db.table('lead_assignments').count({ lead_id: leadId, active: true });
const events = (ctx: TestContext, action: string, leadId?: string) =>
  ctx.db.table('audit_events').findMany(leadId ? { action, entity_id: leadId } : { action }, { orderBy: 'created_at ASC' });
const assignmentDecisions = (ctx: TestContext, leadId: string) =>
  ctx.db.table('agent_decisions').findMany({ decision_type: 'account_assignment', subject_id: leadId }, { orderBy: 'created_at ASC' });
const stageOf = (ctx: TestContext, leadId: string) => ctx.db.table('leads').require(leadId).stage;

describe('assignLead: ranked assignment', () => {
  it('assigns the Hangzhou i3 inventory lead to 销售小王 with a persisted, audited, explainable decision', () => {
    const { ctx, hz, acc } = setup();
    const lead = makeLead(ctx, hz);
    const res = assignLead(ctx, lead.id);

    assert.equal(res.changed, true);
    assert.ok(res.assignment);
    assert.equal(res.assignment.account_id, acc('xhs-hz-sales-wang'));
    assert.equal(res.assignment.active, true);
    assert.equal(res.assignment.assigned_by, 'agent:fleet-controller');
    assert.equal(res.assignment.assigned_at, TEST_NOW);
    assert.equal(res.assignment.candidates.length, 6, 'the full ranking is stored on the assignment');
    assert.deepEqual(res.assignment.candidates, res.candidates);
    assert.equal(res.reason, res.assignment.reason);
    assert.match(res.reason, /选择「销售小王·杭州宝马」（90分），领先第二名「i3电车研究所」（85分）5分/);
    assert.match(res.reason, /同城/);

    assert.equal(stageOf(ctx, lead.id), 'ASSIGNED');
    const transition = ctx.db.table('lead_stage_transitions').findOne({ lead_id: lead.id, to_stage: 'ASSIGNED' });
    assert.ok(transition);
    assert.equal(transition.actor, 'agent:fleet-controller');

    const assigned = events(ctx, 'lead.assigned', lead.id);
    assert.equal(assigned.length, 1);
    assert.equal(assigned[0].details.account_id, acc('xhs-hz-sales-wang'));
    assert.equal(assigned[0].details.mode, 'ranked');

    const [decision] = assignmentDecisions(ctx, lead.id);
    assert.equal(decision.agent, 'fleet-controller');
    assert.equal(decision.skill, 'account-assignment');
    assert.equal(decision.engine, 'rules');
    assert.equal(decision.inputs.lead_score, 96);
    assert.equal(decision.inputs.dealer_id, hz);
    assert.deepEqual(decision.inputs.intent, I3_INVENTORY);
    assert.equal(decision.inputs.intent_class, 'transactional');
    assert.deepEqual(decision.evidence, EVIDENCE);
    assert.equal(decision.output.account_id, acc('xhs-hz-sales-wang'));
    assert.equal(decision.output.margin_to_next, 5);
    assert.equal((decision.output.ranking as unknown[]).length, 6);
    assert.equal(decision.confidence, 0.67, 'confidence = 0.5 + margin/30');
  });

  it('assigns the X3 price lead to 李姐聊宝马', () => {
    const { ctx, hz, acc } = setup();
    const lead = makeLead(ctx, hz, {
      intent: { brand: 'BMW', model: 'X3', location: '杭州', province: '浙江', price_intent: true, purchase_stage: 'price_shopping' },
      score: 75,
    });
    assert.equal(assignLead(ctx, lead.id).assignment?.account_id, acc('xhs-hz-sales-li'));
  });

  it('routes a sh-bmw lead to 上海宝马中心官方 (赵哥 needs re-login)', () => {
    const { ctx, sh, acc } = setup();
    const lead = makeLead(ctx, sh, {
      intent: { brand: 'BMW', model: 'X3', location: '上海', province: '上海', price_intent: true, purchase_stage: 'price_shopping' },
      score: 82,
    });
    const res = assignLead(ctx, lead.id);
    assert.equal(res.assignment?.account_id, acc('xhs-sh-official'));
    assert.equal(res.candidates.length, 2);
  });

  it('falls back to a group dealer account when every hz account is unavailable', () => {
    const { ctx, hz, acc } = setup();
    for (const a of ctx.db.table('xhs_accounts').findMany({ dealer_id: hz })) ctx.db.table('xhs_accounts').update(a.id, { status: 'paused' });
    const lead = makeLead(ctx, hz);
    const res = assignLead(ctx, lead.id);
    assert.equal(res.assignment?.account_id, acc('xhs-sh-official'));
    assert.match(res.reason, /杭州宝马中心」暂无可用账号，由集团内其他门店账号兜底/);
    assert.equal(events(ctx, 'lead.assigned', lead.id)[0].details.cross_dealer, true);
  });

  it('no eligible account in the whole group → null, lead.assignment_failed and a decision', () => {
    const { ctx, hz } = setup();
    for (const a of ctx.db.table('xhs_accounts').findMany()) ctx.db.table('xhs_accounts').update(a.id, { status: 'disabled' });
    const lead = makeLead(ctx, hz);
    const res = assignLead(ctx, lead.id);
    assert.equal(res.assignment, null);
    assert.equal(res.changed, false);
    assert.equal(res.candidates.length, 8);
    assert.match(res.reason, /没有可用的账号：账号已停用/);
    assert.equal(ctx.db.table('lead_assignments').count({ lead_id: lead.id }), 0);
    assert.equal(stageOf(ctx, lead.id), 'QUALIFIED');
    const failed = events(ctx, 'lead.assignment_failed', lead.id);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].details.reason, res.reason);
    const [decision] = assignmentDecisions(ctx, lead.id);
    assert.equal(decision.output.assigned, false);
  });
});

describe('assignLead: exclusivity', () => {
  it('a repeated call keeps the single active owner and still returns fresh candidates', () => {
    const { ctx, hz } = setup();
    const lead = makeLead(ctx, hz);
    const first = assignLead(ctx, lead.id);
    const second = assignLead(ctx, lead.id);
    assert.equal(second.changed, false);
    assert.equal(second.assignment?.id, first.assignment?.id);
    assert.equal(second.candidates.length, 6);
    assert.match(second.reason, /已由「销售小王·杭州宝马」负责/);
    assert.equal(activeCount(ctx, lead.id), 1);
    assert.equal(events(ctx, 'lead.assigned', lead.id).length, 1);
    assert.equal(assignmentDecisions(ctx, lead.id).length, 1);
  });

  it('the partial unique index blocks a second active assignment row', () => {
    const { ctx, hz, acc } = setup();
    const lead = makeLead(ctx, hz);
    assignLead(ctx, lead.id);
    assert.throws(() => seedAssignment(ctx, { lead_id: lead.id, account_id: acc('xhs-hz-i3') }), /UNIQUE constraint failed: lead_assignments/);
    seedAssignment(ctx, { lead_id: lead.id, account_id: acc('xhs-hz-i3'), active: false, released_at: TEST_NOW });
    assert.equal(activeCount(ctx, lead.id), 1, 'inactive history rows are allowed');
  });

  it('a lost insert race (stale read) returns the concurrent owner and rolls back', (t) => {
    const { ctx, hz, acc } = setup();
    const lead = makeLead(ctx, hz);
    const winner = seedAssignment(ctx, { lead_id: lead.id, account_id: acc('xhs-hz-i3') });
    const table = ctx.db.table('lead_assignments');
    const realFindOne = table.findOne.bind(table);
    const realInsert = table.insert.bind(table);
    let stale = true;
    t.mock.method(table, 'findOne', (where: Where<LeadAssignment>, opts?: FindOptions) =>
      stale && where.active === true ? undefined : realFindOne(where, opts),
    );
    t.mock.method(table, 'insert', (row: LeadAssignment) => {
      stale = false; // the other writer's row becomes visible exactly when we try to write
      return realInsert(row);
    });
    const res = assignLead(ctx, lead.id);
    assert.equal(res.changed, false);
    assert.equal(res.assignment?.id, winner.id);
    assert.match(res.reason, /并发分配已由其他流程完成/);
    assert.equal(activeCount(ctx, lead.id), 1);
    assert.equal(stageOf(ctx, lead.id), 'QUALIFIED', 'the failed transaction left no stage change');
    assert.equal(events(ctx, 'lead.assigned', lead.id).length, 0);
    assert.equal(assignmentDecisions(ctx, lead.id).length, 0);
  });

  it('keeps an owner that became unavailable but recommends manual reassignment', () => {
    const { ctx, hz, acc } = setup();
    const lead = makeLead(ctx, hz);
    const first = assignLead(ctx, lead.id);
    ctx.db.table('xhs_accounts').update(acc('xhs-hz-sales-wang'), { status: 'disabled' });
    const again = assignLead(ctx, lead.id);
    assert.equal(again.changed, false);
    assert.equal(again.assignment?.id, first.assignment?.id);
    assert.match(again.reason, /当前不可用（账号已停用），建议人工重新分配/);
  });
});

describe('assignLead: stickiness to a previously contacting account', () => {
  it('an account that already sent outreach is the forced owner even when another account ranks higher', () => {
    const { ctx, hz, acc } = setup();
    const lead = makeLead(ctx, hz);
    const i3 = acc('xhs-hz-i3');
    const old = seedAssignment(ctx, { lead_id: lead.id, account_id: i3, active: false, released_at: TEST_NOW });
    seedOutreach(ctx, { lead_id: lead.id, account_id: i3, assignment_id: old.id, status: 'SENT_MANUALLY' });
    const res = assignLead(ctx, lead.id);
    assert.equal(res.candidates[0].nickname, '销售小王·杭州宝马', 'ranking alone would pick 销售小王');
    assert.equal(res.assignment?.account_id, i3);
    assert.match(res.reason, /「i3电车研究所」已与该客户建立联系/);
    const [decision] = assignmentDecisions(ctx, lead.id);
    assert.equal(decision.inputs.mode, 'sticky');
    assert.equal(decision.confidence, 0.95);
  });

  it('a conversation with the lead also makes the account sticky', () => {
    const { ctx, hz, acc } = setup();
    const lead = makeLead(ctx, hz);
    seedInboundReply(ctx, { lead_id: lead.id, account_id: acc('xhs-hz-sales-li') });
    assert.equal(assignLead(ctx, lead.id).assignment?.account_id, acc('xhs-hz-sales-li'));
  });

  it('a sticky account that is unavailable yields null and asks for manual reassignment', () => {
    const { ctx, hz, acc } = setup();
    const lead = makeLead(ctx, hz);
    const i3 = acc('xhs-hz-i3');
    const old = seedAssignment(ctx, { lead_id: lead.id, account_id: i3, active: false, released_at: TEST_NOW });
    seedOutreach(ctx, { lead_id: lead.id, account_id: i3, assignment_id: old.id, status: 'SENT' });
    ctx.db.table('xhs_accounts').update(i3, { status: 'disabled' });
    const res = assignLead(ctx, lead.id);
    assert.equal(res.assignment, null);
    assert.ok(res.reason.startsWith(STICKY_UNAVAILABLE_REASON));
    assert.match(res.reason, /i3电车研究所」账号已停用/);
    assert.equal(activeCount(ctx, lead.id), 0);
    assert.equal(events(ctx, 'lead.assignment_failed', lead.id).length, 1);
    assert.equal(stageOf(ctx, lead.id), 'QUALIFIED');
  });

  it('a CONTACTED lead whose signal score decayed below the threshold is still re-owned by its contact account', () => {
    const { ctx, hz, acc } = setup();
    const li = acc('xhs-hz-sales-li');
    const lead = makeLead(ctx, hz, { stage: 'CONTACTED', score: 45 });
    const old = seedAssignment(ctx, { lead_id: lead.id, account_id: li, active: false, released_at: TEST_NOW });
    seedOutreach(ctx, { lead_id: lead.id, account_id: li, assignment_id: old.id, status: 'SENT' });
    const res = assignLead(ctx, lead.id);
    assert.equal(res.assignment?.account_id, li);
    assert.equal(stageOf(ctx, lead.id), 'CONTACTED', 'deeper stages are never moved back');
  });
});

describe('assignLead: operator reassignment', () => {
  function assigned() {
    const env = setup();
    const lead = makeLead(env.ctx, env.hz);
    const first = assignLead(env.ctx, lead.id);
    assert.ok(first.assignment);
    return { ...env, lead, first: first.assignment };
  }

  it('releases the old owner, cancels its pending outreach and creates the new owner in one transaction', () => {
    const { ctx, acc, lead, first } = assigned();
    const wang = acc('xhs-hz-sales-wang');
    const i3 = acc('xhs-hz-i3');
    const review = seedOutreach(ctx, { lead_id: lead.id, account_id: wang, assignment_id: first.id, status: 'READY_FOR_REVIEW' });
    const draft = seedOutreach(ctx, { lead_id: lead.id, account_id: wang, assignment_id: first.id, status: 'DRAFT', kind: 'follow_up' });
    ctx.clock.advance({ hours: 1 });

    const res = assignLead(ctx, lead.id, { reassign_to: i3, actor: 'operator:张经理', reason: '王磊休假一周' });
    assert.equal(res.changed, true);
    assert.equal(res.assignment?.account_id, i3);
    assert.equal(res.assignment?.assigned_by, 'operator:张经理');
    assert.match(res.reason, /人工重新分配给「i3电车研究所」（85分）：王磊休假一周/);

    const old = ctx.db.table('lead_assignments').require(first.id);
    assert.equal(old.active, false);
    assert.equal(old.released_at, ctx.clock.iso());
    assert.equal(old.released_reason, '王磊休假一周');
    assert.equal(activeCount(ctx, lead.id), 1);
    assert.equal(getActiveAssignment(ctx, lead.id)?.account_id, i3);

    for (const id of [review.id, draft.id]) {
      const o = ctx.db.table('outreach').require(id);
      assert.equal(o.status, 'CANCELLED');
      assert.equal(o.blocked_reason, REASSIGN_CANCEL_REASON);
    }
    assert.equal(events(ctx, 'outreach.cancelled').length, 2);
    const released = events(ctx, 'lead.assignment_released', lead.id);
    assert.equal(released.length, 1);
    assert.equal(released[0].actor, 'operator:张经理');
    assert.deepEqual((released[0].details.outreach_cancelled as string[]).sort(), [review.id, draft.id].sort());
    const assignedEvents = events(ctx, 'lead.assigned', lead.id);
    assert.equal(assignedEvents.length, 2);
    assert.equal(assignedEvents[1].details.previous_account_id, wang);

    const decisions = assignmentDecisions(ctx, lead.id);
    assert.equal(decisions.length, 2);
    assert.equal(decisions[1].engine, 'human');
    assert.equal(decisions[1].confidence, 1);
    assert.equal(decisions[1].inputs.mode, 'reassign');
    assert.equal(decisions[1].output.previous_account_id, wang);
  });

  it('keeps delivered outreach and only cancels undelivered messages', () => {
    const { ctx, acc, lead, first } = assigned();
    const wang = acc('xhs-hz-sales-wang');
    const sent = seedOutreach(ctx, { lead_id: lead.id, account_id: wang, assignment_id: first.id, status: 'SENT' });
    const approved = seedOutreach(ctx, { lead_id: lead.id, account_id: wang, assignment_id: first.id, status: 'APPROVED', kind: 'follow_up' });
    assignLead(ctx, lead.id, { reassign_to: acc('xhs-hz-sales-li'), actor: 'operator:张经理' });
    assert.equal(ctx.db.table('outreach').require(sent.id).status, 'SENT');
    assert.equal(ctx.db.table('outreach').require(approved.id).status, 'CANCELLED');
    assert.equal(getActiveAssignment(ctx, lead.id)?.account_id, acc('xhs-hz-sales-li'), 'explicit reassignment overrides stickiness');
    assert.equal(ctx.db.table('lead_assignments').require(first.id).released_reason, '重新分配给「李姐聊宝马」');
  });

  it('refuses an ineligible or unknown target without changing anything', () => {
    const { ctx, acc, lead, first } = assigned();
    const pending = seedOutreach(ctx, { lead_id: lead.id, account_id: acc('xhs-hz-sales-wang'), assignment_id: first.id, status: 'READY_FOR_REVIEW' });
    ctx.db.table('xhs_accounts').update(acc('xhs-hz-sales-li'), { status: 'disabled' });
    assert.throws(
      () => assignLead(ctx, lead.id, { reassign_to: acc('xhs-hz-sales-li'), actor: 'operator:张经理' }),
      (err: unknown) => err instanceof PolicyError && err.code === 'account_ineligible' && /账号已停用/.test(err.message),
    );
    assert.throws(() => assignLead(ctx, lead.id, { reassign_to: 'acc_missing', actor: 'operator:张经理' }), NotFoundError);
    assert.equal(getActiveAssignment(ctx, lead.id)?.id, first.id);
    assert.equal(ctx.db.table('outreach').require(pending.id).status, 'READY_FOR_REVIEW');
    assert.equal(events(ctx, 'lead.assignment_released').length, 0);
  });

  it('reassigning to the current owner is a no-op', () => {
    const { ctx, acc, lead, first } = assigned();
    const res = assignLead(ctx, lead.id, { reassign_to: acc('xhs-hz-sales-wang'), actor: 'operator:张经理' });
    assert.equal(res.changed, false);
    assert.equal(res.assignment?.id, first.id);
    assert.match(res.reason, /无需重新分配/);
    assert.equal(assignmentDecisions(ctx, lead.id).length, 1);
  });
});

describe('assignLead: guards', () => {
  const assertNotAssigned = (ctx: TestContext, lead: Lead, res: AssignLeadResult, pattern: RegExp) => {
    assert.equal(res.assignment, null);
    assert.equal(res.changed, false);
    assert.deepEqual(res.candidates, []);
    assert.match(res.reason, pattern);
    assert.equal(ctx.db.table('lead_assignments').count({ lead_id: lead.id }), 0);
    assert.equal(events(ctx, 'lead.assigned', lead.id).length, 0);
  };

  it('suppressed leads (flag or global do-not-contact list) are never assigned', () => {
    const { ctx, hz } = setup();
    const flagged = makeLead(ctx, hz, { suppressed: true });
    assertNotAssigned(ctx, flagged, assignLead(ctx, flagged.id), /勿扰/);
    const globally = makeLead(ctx, hz, { user: 'u-negative-fleet' });
    seedSuppression(ctx, 'u-negative-fleet');
    assertNotAssigned(ctx, globally, assignLead(ctx, globally.id), /勿扰/);
    assert.equal(ctx.db.table('account_health').count(), 0, 'guards never rank the fleet');
  });

  it('unqualified, LOST and WON leads are not assigned', () => {
    const { ctx, hz, acc } = setup();
    const weak = makeLead(ctx, hz, { score: 59 });
    assertNotAssigned(ctx, weak, assignLead(ctx, weak.id), /线索分59低于合格阈值60/);
    const lost = makeLead(ctx, hz, { stage: 'LOST' });
    assertNotAssigned(ctx, lost, assignLead(ctx, lost.id), /已流失/);
    const won = makeLead(ctx, hz, { stage: 'WON' });
    assertNotAssigned(ctx, won, assignLead(ctx, won.id), /已成交/);
    const guardedReassign = assignLead(ctx, lost.id, { reassign_to: acc('xhs-hz-i3'), actor: 'operator:张经理' });
    assert.equal(guardedReassign.assignment, null, 'guards apply to reassignment too');
    assert.match(guardedReassign.reason, /已流失/);
    assert.equal(assignLead(ctx, lost.id, { reassign_to: 'acc_missing' }).assignment, null, 'the guard runs before the target lookup');
    assert.throws(() => assignLead(ctx, 'lead_missing'), NotFoundError);
  });
});

describe('releaseAssignment', () => {
  it('releases the owner, cancels its undelivered outreach, is idempotent and lets the lead be re-ranked', () => {
    const { ctx, hz, acc } = setup();
    const lead = makeLead(ctx, hz);
    const first = assignLead(ctx, lead.id).assignment;
    assert.ok(first);
    const pending = seedOutreach(ctx, { lead_id: lead.id, account_id: first.account_id, assignment_id: first.id, status: 'READY_FOR_REVIEW' });

    releaseAssignment(ctx, lead.id, '客户转由门店电话跟进', 'operator:张经理');
    assert.equal(getActiveAssignment(ctx, lead.id), undefined);
    const row = ctx.db.table('lead_assignments').require(first.id);
    assert.equal(row.active, false);
    assert.equal(row.released_reason, '客户转由门店电话跟进');
    const o = ctx.db.table('outreach').require(pending.id);
    assert.equal(o.status, 'CANCELLED');
    assert.equal(o.blocked_reason, '负责账号已释放：客户转由门店电话跟进');
    assert.equal(events(ctx, 'lead.assignment_released', lead.id).length, 1);

    releaseAssignment(ctx, lead.id, '重复释放', 'operator:张经理');
    assert.equal(events(ctx, 'lead.assignment_released', lead.id).length, 1, 'no active owner → no-op');
    assert.throws(() => releaseAssignment(ctx, lead.id, '  ', 'operator:张经理'), ValidationError);
    assert.throws(() => releaseAssignment(ctx, 'lead_missing', '原因', 'operator:张经理'), NotFoundError);

    const again = assignLead(ctx, lead.id);
    assert.equal(again.changed, true);
    assert.equal(again.assignment?.account_id, acc('xhs-hz-sales-wang'));
    assert.notEqual(again.assignment?.id, first.id);
  });
});

describe('skill account-assignment', () => {
  it('validates input and assigns / reassigns through the registry', async () => {
    const registry = new SkillRegistry().register(skill);
    const { ctx, hz, acc } = setup({ skills: registry });
    assert.equal(skill.name, 'account-assignment');
    assert.equal(skill.agent, 'fleet-controller');
    assert.throws(() => skill.input(null, 'account-assignment'), ValidationError);
    await assert.rejects(registry.invoke(ctx, 'account-assignment', { lead_id: '' }), ValidationError);

    const lead = makeLead(ctx, hz);
    const res = await registry.invoke<AssignLeadResult>(ctx, 'account-assignment', { lead_id: lead.id });
    assert.equal(res.assignment?.account_id, acc('xhs-hz-sales-wang'));

    const moved = await registry.invoke<AssignLeadResult>(ctx, 'account-assignment', {
      lead_id: lead.id,
      reassign_to: acc('xhs-hz-guide'),
      actor: 'operator:张经理',
    });
    assert.equal(moved.changed, true);
    assert.equal(moved.assignment?.account_id, acc('xhs-hz-guide'));
    assert.equal(activeCount(ctx, lead.id), 1);

    const bad = { ...moved, changed: true, assignment: { ...moved.assignment!, account_id: 'acc_not_ranked' } };
    assert.throws(() => skill.validateOutput?.(bad), /eligible ranked candidate/);
  });
});
