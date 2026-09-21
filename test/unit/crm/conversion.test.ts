import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NotFoundError, PolicyError, ValidationError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import type { Appointment, Conversion, Lead, LeadAssignment, Outreach, XhsAccount } from '../../../src/core/types.ts';
import {
  computeNextAction,
  getLeadTimeline,
  recordConversion,
  refreshNextAction,
  skill as crmSkill,
  suppressContact,
  transitionLead,
} from '../../../src/skills/operations/crm/index.ts';
import { createTestContext, TEST_NOW, type TestContext } from '../../helpers/context.ts';

function seed(ctx: TestContext) {
  const now = ctx.clock.iso();
  const group = ctx.db.table('dealer_groups').insert({ id: newId('grp'), name: '浙沪宝马经销商集团', created_at: now });
  const dealer = ctx.db.table('dealers').insert({
    id: newId('dlr'),
    group_id: group.id,
    name: '杭州宝马中心',
    brands: ['BMW'],
    city: '杭州',
    province: '浙江',
    address: '',
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
  const account = (nickname: string): XhsAccount =>
    ctx.db.table('xhs_accounts').insert({
      id: newId('acc'),
      group_id: group.id,
      dealer_id: dealer.id,
      platform_account_id: null,
      nickname,
      account_type: 'salesperson',
      status: 'active',
      auth_state: 'authenticated',
      city: '杭州',
      salesperson_name: null,
      outreach_approval_policy: null,
      daily_outreach_limit: null,
      daily_publish_limit: null,
      created_at: now,
      updated_at: now,
    });
  const vehicle = ctx.db.table('vehicles').insert({
    id: newId('veh'),
    group_id: group.id,
    brand: 'BMW',
    brand_zh: '宝马',
    model: 'i3',
    model_zh: 'i3',
    trim: 'eDrive35L',
    model_year: 2026,
    msrp: 353900,
    specs: {},
    highlights: [],
    aliases: ['35L'],
    source: 'test',
    updated_at: now,
  });
  return { group, dealer, wang: account('销售小王·杭州宝马'), li: account('李姐聊宝马'), vehicle };
}

type Seed = ReturnType<typeof seed>;
let seq = 0;

function lead(ctx: TestContext, s: Seed, patch: Partial<Lead> = {}): Lead {
  const now = ctx.clock.iso();
  return ctx.db.table('leads').insert({
    id: newId('lead'),
    group_id: s.group.id,
    dealer_id: s.dealer.id,
    platform: 'xiaohongshu',
    platform_user_id: `u-conv-${++seq}`,
    username: '看车用户',
    profile_url: null,
    avatar_url: null,
    stage: 'CANDIDATE',
    score: 80,
    tier: 'high_intent',
    intent: { brand: 'BMW', model: 'i3' },
    evidence: [],
    primary_signal_id: null,
    signal_count: 1,
    first_seen_at: now,
    last_signal_at: now,
    suppressed: false,
    suppression_reason: null,
    contact: {},
    lost_reason: null,
    estimated_value: 353900,
    attributed_post_id: null,
    attributed_query_id: null,
    next_action: null,
    created_at: now,
    updated_at: now,
    ...patch,
  });
}

function assign(ctx: TestContext, l: Lead, acc: XhsAccount, active = true): LeadAssignment {
  return ctx.db.table('lead_assignments').insert({
    id: newId('asg'),
    lead_id: l.id,
    account_id: acc.id,
    active,
    reason: 'test',
    candidates: [],
    assigned_by: 'agent:fleet-controller',
    assigned_at: ctx.clock.iso(),
    released_at: active ? null : ctx.clock.iso(),
    released_reason: active ? null : 'reassigned',
  });
}

function outreach(ctx: TestContext, asg: LeadAssignment, patch: Partial<Outreach> = {}): Outreach {
  const now = ctx.clock.iso();
  return ctx.db.table('outreach').insert({
    id: newId('out'),
    lead_id: asg.lead_id,
    account_id: asg.account_id,
    assignment_id: asg.id,
    kind: 'first_touch',
    message: '你好～看到你在问i3现车',
    personalization: [],
    fact_refs: [],
    guard_results: [],
    approval_policy: 'REVIEW_REQUIRED',
    status: 'READY_FOR_REVIEW',
    capability_status: 'UNAVAILABLE',
    provider_message_id: null,
    blocked_reason: null,
    approved_by: null,
    approved_at: null,
    sent_at: null,
    engine: 'rules',
    created_at: now,
    updated_at: now,
    ...patch,
  });
}

function appointment(ctx: TestContext, s: Seed, l: Lead, patch: Partial<Appointment>): Appointment {
  const now = ctx.clock.iso();
  return ctx.db.table('appointments').insert({
    id: newId('appt'),
    lead_id: l.id,
    dealer_id: s.dealer.id,
    account_id: s.wang.id,
    conversation_id: null,
    scheduled_for: null,
    time_text: null,
    store: '杭州宝马中心',
    vehicle_interest: 'i3 eDrive35L',
    status: 'proposed',
    notes: '',
    created_at: now,
    updated_at: now,
    ...patch,
  });
}

const isPolicy = (code: string) => (err: unknown) => err instanceof PolicyError && err.code === code;
const daysAgo = (n: number) => new Date(Date.parse(TEST_NOW) - n * 86_400_000).toISOString();

describe('crm: recordConversion', () => {
  it('records a won sale with content/query attribution and the active owning account', () => {
    const ctx = createTestContext();
    const s = seed(ctx);
    const l = lead(ctx, s, { stage: 'NEGOTIATING', attributed_post_id: 'post_i3_review', attributed_query_id: 'q_hz_i3_xianche' });
    assign(ctx, l, s.li, false);
    assign(ctx, l, s.wang, true);

    ctx.clock.advance({ days: 3 });
    const c = recordConversion(ctx, { lead_id: l.id, outcome: 'won', amount: 318000, vehicle_id: s.vehicle.id, actor: 'operator:王磊' });
    assert.equal(c.outcome, 'won');
    assert.equal(c.dealer_id, s.dealer.id);
    assert.equal(c.amount, 318000);
    assert.equal(c.vehicle_id, s.vehicle.id);
    assert.equal(c.lost_reason, null);
    assert.equal(c.attributed_post_id, 'post_i3_review');
    assert.equal(c.attributed_query_id, 'q_hz_i3_xianche');
    assert.equal(c.account_id, s.wang.id, 'account comes from the ACTIVE assignment');
    assert.equal(c.occurred_at, ctx.clock.iso());

    const after = ctx.db.table('leads').require(l.id);
    assert.equal(after.stage, 'WON');
    assert.equal(after.estimated_value, 318000);
    assert.equal(after.next_action, '已成交');
    const trn = ctx.db.table('lead_stage_transitions').findOne({ lead_id: l.id });
    assert.deepEqual([trn?.from_stage, trn?.to_stage, trn?.reason], ['NEGOTIATING', 'WON', `conversion_won:${c.id}`]);
    const ev = ctx.db.table('audit_events').findOne({ entity_id: l.id, action: 'lead.converted' });
    assert.equal(ev?.actor, 'operator:王磊');
    assert.equal(ev?.details.conversion_id, c.id);
    assert.equal(ev?.details.account_id, s.wang.id);

    assert.throws(
      () => recordConversion(ctx, { lead_id: l.id, outcome: 'won', actor: 'operator:王磊' }),
      isPolicy('invalid_transition'),
      'a lead cannot be won twice',
    );
    assert.throws(() => recordConversion(ctx, { lead_id: l.id, outcome: 'lost', actor: 'operator:王磊' }), isPolicy('invalid_transition'));
    assert.equal(ctx.db.table('conversions').count({ lead_id: l.id }), 1);
  });

  it('rejects a won conversion before contact and records losses from any open stage', () => {
    const ctx = createTestContext();
    const s = seed(ctx);
    const early = lead(ctx, s, { stage: 'ASSIGNED' });
    assert.throws(() => recordConversion(ctx, { lead_id: early.id, outcome: 'won', amount: 300000, actor: 'operator:王磊' }), isPolicy('invalid_transition'));
    assert.equal(ctx.db.table('conversions').count(), 0);
    assert.equal(ctx.db.table('leads').require(early.id).stage, 'ASSIGNED');

    const c = recordConversion(ctx, { lead_id: early.id, outcome: 'lost', lost_reason: '预算不足，改买国产电车', actor: 'operator:李娜' });
    assert.equal(c.outcome, 'lost');
    assert.equal(c.account_id, null);
    assert.equal(c.amount, null);
    assert.equal(c.lost_reason, '预算不足，改买国产电车');
    const after = ctx.db.table('leads').require(early.id);
    assert.equal(after.stage, 'LOST');
    assert.equal(after.lost_reason, '预算不足，改买国产电车');
    assert.equal(after.next_action, '已流失：预算不足，改买国产电车');

    const noReason = lead(ctx, s, { stage: 'REPLIED' });
    assert.equal(recordConversion(ctx, { lead_id: noReason.id, outcome: 'lost', actor: 'operator:李娜' }).lost_reason, '未说明原因');
  });

  it('validates amount and vehicle without writing', () => {
    const ctx = createTestContext();
    const s = seed(ctx);
    const l = lead(ctx, s, { stage: 'VISITED' });
    const base = { lead_id: l.id, outcome: 'won' as const, actor: 'operator:王磊' };
    assert.throws(() => recordConversion(ctx, { ...base, amount: -1 }), ValidationError);
    assert.throws(() => recordConversion(ctx, { ...base, amount: 1.5 }), ValidationError);
    assert.throws(() => recordConversion(ctx, { ...base, vehicle_id: 'veh_missing' }), NotFoundError);
    const otherGroup = ctx.db.table('dealer_groups').insert({ id: newId('grp'), name: '其他集团', created_at: ctx.clock.iso() });
    const foreign = ctx.db.table('vehicles').insert({ ...s.vehicle, id: newId('veh'), group_id: otherGroup.id });
    assert.throws(() => recordConversion(ctx, { ...base, vehicle_id: foreign.id }), ValidationError);
    assert.throws(() => recordConversion(ctx, { ...base, lead_id: 'lead_missing' }), NotFoundError);
    assert.equal(ctx.db.table('conversions').count(), 0);
    assert.equal(ctx.db.table('leads').require(l.id).stage, 'VISITED');
  });
});

describe('crm: computeNextAction', () => {
  it('derives the next action for each funnel stage', () => {
    const ctx = createTestContext();
    const s = seed(ctx);
    const next = (patch: Partial<Lead>) => computeNextAction(ctx, lead(ctx, s, patch));
    assert.equal(next({ stage: 'DISCOVERED' }), '评估公开信号：判断购买意向');
    assert.equal(next({ stage: 'CANDIDATE' }), '继续观察：等待更多购买信号');
    assert.equal(next({ stage: 'QUALIFIED' }), '分配最合适的账号');
    assert.equal(next({ stage: 'ASSIGNED' }), '生成个性化私信');
    assert.equal(next({ stage: 'REPLIED' }), '处理客户回复');
    assert.equal(next({ stage: 'SALES_QUALIFIED' }), '发送留资卡/名片获取联系方式');
    assert.equal(next({ stage: 'CONTACT_ACQUIRED' }), '电话邀约到店');
    assert.equal(next({ stage: 'VISITED' }), '跟进报价与谈判');
    assert.equal(next({ stage: 'NEGOTIATING' }), '推进成交');
    assert.equal(next({ stage: 'WON' }), '已成交');
    assert.equal(next({ stage: 'LOST', lost_reason: '已在别家提车' }), '已流失：已在别家提车');
    assert.equal(next({ stage: 'LOST' }), '已流失：未说明原因');
    assert.equal(next({ stage: 'REPLIED', suppressed: true, suppression_reason: '不需要' }), '勿扰：已停止所有触达');
  });

  it('follows the latest outreach status while outreach is being prepared', () => {
    const ctx = createTestContext();
    const s = seed(ctx);
    const l = lead(ctx, s, { stage: 'OUTREACH_READY' });
    const asg = assign(ctx, l, s.wang);
    const o = outreach(ctx, asg, { status: 'READY_FOR_REVIEW' });
    assert.equal(computeNextAction(ctx, l), '审核私信：通过后在小红书发送');

    ctx.db.table('outreach').update(o.id, { status: 'APPROVED' });
    assert.equal(computeNextAction(ctx, l), '由负责账号在小红书人工发送已审核私信并登记');
    ctx.db.table('outreach').update(o.id, { capability_status: 'AVAILABLE' });
    assert.equal(computeNextAction(ctx, l), '私信已审核通过：等待系统发送');

    ctx.db.table('outreach').update(o.id, { status: 'CANCELLED' });
    ctx.clock.advance({ minutes: 5 });
    outreach(ctx, asg, { status: 'BLOCKED', blocked_reason: '平台规则：包含微信号' });
    assert.equal(computeNextAction(ctx, l), '私信被拦截：平台规则：包含微信号');
  });

  it('counts down to the follow-up and pauses after the unanswered-touch limit', () => {
    const ctx = createTestContext();
    const s = seed(ctx);
    const at = (sentDaysAgo: number) => {
      const l = lead(ctx, s, { stage: 'CONTACTED' });
      outreach(ctx, assign(ctx, l, s.wang), { status: 'SENT', provider_message_id: newId('pm'), sent_at: daysAgo(sentDaysAgo) });
      return l;
    };
    assert.equal(computeNextAction(ctx, at(0)), '等待回复（2天后跟进）');
    assert.equal(computeNextAction(ctx, at(1)), '等待回复（1天后跟进）');
    assert.equal(computeNextAction(ctx, at(0.5)), '等待回复（2天后跟进）');
    assert.equal(computeNextAction(ctx, at(3)), '已到跟进时间：准备跟进私信');

    const twice = lead(ctx, s, { stage: 'CONTACTED' });
    const asg = assign(ctx, twice, s.wang);
    outreach(ctx, asg, { status: 'SENT_MANUALLY', sent_at: daysAgo(5) });
    const followUp = outreach(ctx, asg, { kind: 'follow_up', status: 'READY_FOR_REVIEW' });
    assert.equal(computeNextAction(ctx, twice), '审核跟进私信：通过后在小红书发送');
    ctx.db.table('outreach').update(followUp.id, { status: 'SENT', sent_at: daysAgo(2) });
    assert.equal(computeNextAction(ctx, twice), '已触达2次未回复：暂停触达，等待客户主动回复');
  });

  it('honours a dealer follow-up delay of 0 days instead of silently using the default', () => {
    const ctx = createTestContext();
    const s = seed(ctx);
    ctx.db.table('dealers').update(s.dealer.id, { settings: { ...s.dealer.settings, follow_up_after_days: 0 } });
    const l = lead(ctx, s, { stage: 'CONTACTED' });
    outreach(ctx, assign(ctx, l, s.wang), { status: 'SENT', provider_message_id: 'pm-0', sent_at: ctx.clock.iso() });
    assert.equal(computeNextAction(ctx, l), '已到跟进时间：准备跟进私信');
  });

  it('prioritizes human hand-off and shows appointment times in dealer-local time', () => {
    const ctx = createTestContext();
    const s = seed(ctx);
    const l = lead(ctx, s, { stage: 'REPLIED' });
    const conv = ctx.db.table('conversations').insert({
      id: newId('conv'),
      lead_id: l.id,
      account_id: s.wang.id,
      status: 'handed_off',
      slots: {},
      ai_turns: 6,
      needs_human: true,
      handoff_reason: '客户询问底价',
      last_message_at: ctx.clock.iso(),
      created_at: ctx.clock.iso(),
      updated_at: ctx.clock.iso(),
    });
    assert.equal(computeNextAction(ctx, l), '人工接管对话：客户询问底价');
    ctx.db.table('conversations').update(conv.id, { needs_human: false });
    assert.equal(computeNextAction(ctx, l), '处理客户回复');

    const booked = lead(ctx, s, { stage: 'APPOINTMENT' });
    assert.equal(computeNextAction(ctx, booked), '确认到店：时间待定');
    const appt = appointment(ctx, s, booked, { status: 'proposed', time_text: '这周六下午' });
    assert.equal(computeNextAction(ctx, booked), '确认到店：这周六下午');
    ctx.db.table('appointments').update(appt.id, { status: 'confirmed', scheduled_for: '2026-09-13T06:00:00.000Z' });
    assert.equal(computeNextAction(ctx, booked), '确认到店：9月13日（周日）14:00');
    ctx.db.table('appointments').update(appt.id, { status: 'no_show' });
    assert.equal(computeNextAction(ctx, booked), '客户未到店：重新邀约');
  });

  it('refreshNextAction persists only when the recommendation changes', () => {
    const ctx = createTestContext();
    const s = seed(ctx);
    const l = lead(ctx, s, { stage: 'QUALIFIED' });
    ctx.clock.advance({ minutes: 1 });
    const first = refreshNextAction(ctx, l.id);
    assert.equal(first.next_action, '分配最合适的账号');
    assert.notEqual(first.updated_at, l.updated_at);
    ctx.clock.advance({ minutes: 1 });
    assert.equal(refreshNextAction(ctx, l.id).updated_at, first.updated_at);
    assert.throws(() => refreshNextAction(ctx, 'lead_missing'), NotFoundError);
  });
});

describe('crm: getLeadTimeline', () => {
  it('returns the lead history with related outreach events and decisions in time order', () => {
    const ctx = createTestContext();
    const s = seed(ctx);
    const l = lead(ctx, s, { stage: 'QUALIFIED' });
    const other = lead(ctx, s, { stage: 'QUALIFIED' });
    ctx.audit.decision({
      agent: 'lead-scoring-agent', skill: 'lead-scoring', decision_type: 'lead_score', subject_type: 'lead', subject_id: l.id,
      inputs: {}, evidence: [], output: { score: 80 }, confidence: 0.9, engine: 'rules',
    });
    ctx.clock.advance({ minutes: 1 });
    const asg = assign(ctx, l, s.wang);
    transitionLead(ctx, l.id, 'ASSIGNED', { reason: 'fleet controller', actor: 'agent:fleet-controller' });
    ctx.clock.advance({ minutes: 1 });
    const o = outreach(ctx, asg, { status: 'READY_FOR_REVIEW' });
    ctx.audit.decision({
      agent: 'outreach-agent', skill: 'outreach', decision_type: 'outreach_generation', subject_type: 'outreach', subject_id: o.id,
      inputs: {}, evidence: [], output: {}, confidence: 0.8, engine: 'rules',
    });
    ctx.audit.event({ actor: 'agent:outreach-agent', action: 'outreach.created', entity_type: 'outreach', entity_id: o.id });
    transitionLead(ctx, l.id, 'OUTREACH_READY', { reason: 'draft ready', actor: 'agent:outreach-agent' });
    transitionLead(ctx, other.id, 'LOST', { reason: 'noise', actor: 'system' });

    const t = getLeadTimeline(ctx, l.id);
    assert.deepEqual(t.transitions.map((x) => x.to_stage), ['ASSIGNED', 'OUTREACH_READY']);
    assert.deepEqual(t.events.map((e) => e.action), ['lead.stage_changed', 'outreach.created', 'lead.stage_changed']);
    assert.deepEqual(t.decisions.map((d) => d.decision_type), ['lead_score', 'outreach_generation']);
    assert.ok(t.events.every((e) => e.entity_id !== other.id));
    const times = t.events.map((e) => e.created_at);
    assert.deepEqual([...times].sort(), times);
    assert.throws(() => getLeadTimeline(ctx, 'lead_missing'), NotFoundError);
  });

  it('shows the global suppression without leaking record ids from other dealer groups', () => {
    const ctx = createTestContext();
    const s = seed(ctx);
    const otherGroup = ctx.db.table('dealer_groups').insert({ id: newId('grp'), name: '上海宝马集团', created_at: ctx.clock.iso() });
    const otherDealer = ctx.db.table('dealers').insert({ ...s.dealer, id: newId('dlr'), group_id: otherGroup.id, name: '上海宝马中心' });
    const otherAccount = ctx.db.table('xhs_accounts').insert({ ...s.wang, id: newId('acc'), group_id: otherGroup.id, dealer_id: otherDealer.id });

    const mine = lead(ctx, s, { platform_user_id: 'u-shared-dnc', stage: 'OUTREACH_READY' });
    const mineOutreach = outreach(ctx, assign(ctx, mine, s.wang), { status: 'READY_FOR_REVIEW' });
    const theirs = ctx.db.table('leads').insert({ ...mine, id: newId('lead'), group_id: otherGroup.id, dealer_id: otherDealer.id });
    const theirOutreach = outreach(ctx, assign(ctx, theirs, otherAccount), { status: 'APPROVED' });
    const { suppression } = suppressContact(ctx, { platform_user_id: 'u-shared-dnc', reason: '别再发了', source: 'operator:李娜', actor: 'operator:李娜' });

    const t = getLeadTimeline(ctx, mine.id);
    const ev = t.events.find((e) => e.action === 'contact.suppressed');
    assert.ok(ev, 'the global suppression is part of every affected lead timeline');
    assert.equal(ev.entity_id, suppression.id);
    assert.equal(ev.details.reason, '别再发了');
    assert.deepEqual(ev.details.leads_updated, [mine.id]);
    assert.deepEqual(ev.details.outreach_cancelled, [mineOutreach.id]);
    assert.ok(!JSON.stringify(t).includes(theirs.id), 'no lead id from the other group');
    assert.ok(!JSON.stringify(t).includes(theirOutreach.id), 'no outreach id from the other group');
    // the stored audit record itself stays complete
    const stored = ctx.db.table('audit_events').require(ev.id);
    assert.deepEqual(new Set(stored.details.leads_updated as string[]), new Set([mine.id, theirs.id]));
  });
});

describe('crm: skill (convert / refresh_next_action)', () => {
  it('records conversions and refreshes next actions through the registry', async () => {
    const ctx = createTestContext();
    const s = seed(ctx);
    ctx.skills.register(crmSkill);
    const l = lead(ctx, s, { stage: 'APPOINTMENT' });
    await assert.rejects(ctx.skills.invoke(ctx, 'crm', { action: 'convert', lead_id: l.id, outcome: 'maybe' }), ValidationError);
    await assert.rejects(ctx.skills.invoke(ctx, 'crm', { action: 'convert', lead_id: l.id, outcome: 'won', amount: -5 }), ValidationError);

    const refreshed = await ctx.skills.invoke<{ lead: Lead }>(ctx, 'crm', { action: 'refresh_next_action', lead_id: l.id });
    assert.equal(refreshed.lead.next_action, '确认到店：时间待定');

    const out = await ctx.skills.invoke<{ action: string; conversion: Conversion; lead: Lead }>(ctx, 'crm', {
      action: 'convert',
      lead_id: l.id,
      outcome: 'won',
      amount: 330000,
    });
    assert.equal(out.action, 'convert');
    assert.equal(out.conversion.amount, 330000);
    assert.equal(out.lead.stage, 'WON');
    assert.equal(ctx.db.table('audit_events').findOne({ action: 'lead.converted' })?.actor, 'agent:crm-agent');
  });
});
