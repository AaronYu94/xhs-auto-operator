import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppContext } from '../../../src/app/context.ts';
import { NotFoundError, ValidationError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import type { LeadSignal, LeadStage, PublicComment, PublicPost, SignalSourceType } from '../../../src/core/types.ts';
import {
  buildLeadCard,
  getLeadDetail,
  getLeadInbox,
  intentChips,
  locationLabel,
  modelLabel,
} from '../../../src/skills/operations/analytics/index.ts';
import { computeNextAction } from '../../../src/skills/operations/crm/index.ts';
import { TEST_NOW, createTestContext } from '../../helpers/context.ts';
import {
  accountIdByPlatformId,
  dealerIdByKey,
  loadDealerFixture,
  seedAppointment,
  seedAssignment,
  seedConversion,
  seedInboundReply,
  seedLead,
  seedOutreach,
  seedSuppression,
} from '../../helpers/fixtures.ts';

const SIGNAL_H = '杭州i3 35L白外红内有现车吗？这周想去看看';
const NOTE_URL = 'https://www.xiaohongshu.com/explore/note-comp-i3-001';

function publicPost(ctx: AppContext, input: { id: string; title: string; url?: string | null; ip?: string | null; author?: string }): PublicPost {
  return ctx.db.table('public_posts').insert({
    id: newId('ppost'),
    platform: 'xiaohongshu',
    platform_post_id: input.id,
    xsec_token: null,
    url: input.url ?? null,
    title: input.title,
    content: `${input.title} 正文`,
    author_platform_user_id: input.author ?? 'u-author-x',
    author_nickname: '作者',
    author_profile_url: null,
    ip_location: input.ip ?? null,
    tags: [],
    like_count: 0,
    comment_count: 0,
    collect_count: 0,
    published_at: '2026-09-01T02:00:00.000Z',
    own_post_id: null,
    first_search_run_id: null,
    fetched_at: TEST_NOW,
    raw: {},
  });
}

function publicComment(ctx: AppContext, input: { post: PublicPost; id: string; author: string; content: string; ip?: string | null }): PublicComment {
  return ctx.db.table('public_comments').insert({
    id: newId('pcmt'),
    platform: 'xiaohongshu',
    platform_comment_id: input.id,
    public_post_id: input.post.id,
    parent_comment_id: null,
    author_platform_user_id: input.author,
    author_nickname: input.author,
    content: input.content,
    ip_location: input.ip ?? null,
    like_count: 0,
    published_at: TEST_NOW,
    prefilter_passed: true,
    prefilter_reason: 'keyword_hit',
    first_search_run_id: null,
    fetched_at: TEST_NOW,
    raw: {},
  });
}

function signal(
  ctx: AppContext,
  input: {
    lead_id: string;
    source_type: SignalSourceType;
    content: string;
    signal_at: string;
    score: number;
    post?: PublicPost | null;
    comment?: PublicComment | null;
    post_title?: string | null;
    purchase?: boolean;
  },
): LeadSignal {
  return ctx.db.table('lead_signals').insert({
    id: newId('sig'),
    lead_id: input.lead_id,
    source_type: input.source_type,
    public_post_id: input.post?.id ?? null,
    public_comment_id: input.comment?.id ?? null,
    post_title: input.post_title === undefined ? (input.post?.title ?? null) : input.post_title,
    content: input.content,
    signal_at: input.signal_at,
    search_run_id: null,
    query_id: null,
    intent: {},
    signal_score: input.score,
    evidence: [],
    engine: 'rules',
    is_purchase_signal: input.purchase ?? true,
    strength: input.purchase === false ? 0 : 1,
    transaction_questions: [],
    author_role: input.purchase === false ? 'unknown' : 'asker',
    created_at: TEST_NOW,
  });
}

function transition(ctx: AppContext, leadId: string, from: LeadStage | null, to: LeadStage, at: string): void {
  ctx.db.table('lead_stage_transitions').insert({ id: newId('trn'), lead_id: leadId, from_stage: from, to_stage: to, reason: 'test', actor: 'test', at });
}

function setup() {
  const ctx = createTestContext();
  const s = loadDealerFixture(ctx);
  const hz = dealerIdByKey(s, 'hz-bmw');
  const sh = dealerIdByKey(s, 'sh-bmw');
  const wang = accountIdByPlatformId(s, 'xhs-hz-sales-wang');
  const li = accountIdByPlatformId(s, 'xhs-hz-sales-li');
  const leads = ctx.db.table('leads');

  // H — immediate follow-up, assigned to 销售小王, outreach awaiting review
  const ppI3 = publicPost(ctx, { id: 'note-comp-i3-001', title: '宝马i3现在值得买吗？', url: NOTE_URL, ip: '上海', author: 'u-creator-001' });
  let H = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-hz-buyer-001', stage: 'ASSIGNED' });
  const cWeak = publicComment(ctx, { post: ppI3, id: 'c-h-1', author: 'u-hz-buyer-001', content: '现在优惠多少', ip: '浙江' });
  const cStrong = publicComment(ctx, { post: ppI3, id: 'c-h-2', author: 'u-hz-buyer-001', content: SIGNAL_H, ip: '浙江' });
  const weakSig = signal(ctx, { lead_id: H.id, source_type: 'comment', content: '现在优惠多少', signal_at: '2026-09-10T08:00:00.000Z', score: 65, post: ppI3, comment: cWeak });
  const primarySig = signal(ctx, { lead_id: H.id, source_type: 'comment', content: SIGNAL_H, signal_at: '2026-09-11T08:00:00.000Z', score: 96, post: ppI3, comment: cStrong });
  H = leads.update(H.id, {
    score: 96,
    tier: 'immediate',
    intent: { brand: 'BMW', model: 'i3', trim: 'eDrive35L', location: '杭州', province: '浙江', purchase_stage: 'purchase_imminent', inventory_intent: true },
    evidence: [
      { code: 'inventory', label: '询问现车', quote: '有现车吗' },
      { code: 'specified_trim', label: '指定配置 eDrive35L', quote: '35L' },
      { code: 'stated_location', label: '本地买家（杭州）', quote: '杭州' },
      { code: 'inventory', label: '询问现车', quote: '现车' },
      { code: 'specified_color', label: '指定颜色 白外红内', quote: '白外红内' },
      { code: 'test_drive', label: '想到店看车', quote: '想去看看' },
      { code: 'purchase_timeframe', label: '本周到店', quote: '这周' },
      { code: 'recent_activity', label: '近期活跃' },
    ],
    primary_signal_id: primarySig.id,
    signal_count: 2,
    last_signal_at: '2026-09-11T08:00:00.000Z',
    estimated_value: 353_900,
  });
  seedAssignment(ctx, { lead_id: H.id, account_id: li, active: false, at: '2026-09-11T09:00:00.000Z', released_at: '2026-09-11T10:00:00.000Z' });
  const asgH = seedAssignment(ctx, { lead_id: H.id, account_id: wang, at: '2026-09-11T10:00:00.000Z' });
  const ranking = [
    { account_id: wang, nickname: '销售小王·杭州宝马', score: 95, eligible: true, factors: [] },
    { account_id: li, nickname: '李姐聊宝马', score: 84, eligible: true, factors: [] },
  ];
  ctx.db.table('lead_assignments').update(asgH.id, { candidates: ranking });
  const outreachH = seedOutreach(ctx, { lead_id: H.id, account_id: wang, assignment_id: asgH.id, status: 'READY_FOR_REVIEW' });

  // M — qualified X3 lead, no primary signal id (fallback to strongest purchase signal), location only via IP
  const ppX3 = publicPost(ctx, { id: 'note-x3-001', title: 'X3和GLC怎么选', ip: '江苏' });
  let M = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-hz-buyer-002' });
  const cM1 = publicComment(ctx, { post: ppX3, id: 'c-m-1', author: 'u-hz-buyer-002', content: 'X3 25L现在什么价', ip: '浙江' });
  const cM2 = publicComment(ctx, { post: ppX3, id: 'c-m-2', author: 'u-hz-buyer-002', content: '好看', ip: '浙江' });
  signal(ctx, { lead_id: M.id, source_type: 'comment', content: 'X3 25L现在什么价', signal_at: '2026-09-08T08:00:00.000Z', score: 65, post: ppX3, comment: cM1 });
  signal(ctx, { lead_id: M.id, source_type: 'comment', content: '好看', signal_at: '2026-09-09T08:00:00.000Z', score: 2, post: ppX3, comment: cM2, purchase: false });
  M = leads.update(M.id, {
    score: 70,
    tier: 'qualified',
    intent: { brand: 'BMW', model: 'X3', purchase_stage: 'price_shopping' },
    evidence: [{ code: 'price', label: '询问价格', quote: '什么价' }],
    signal_count: 2,
    last_signal_at: '2026-09-09T08:00:00.000Z',
  });

  // N — post author asking for a recommendation, brand only, IP 上海
  const ppN = publicPost(ctx, { id: 'note-q-003', title: '25万买什么车', url: 'https://www.xiaohongshu.com/explore/note-q-003', ip: '上海', author: 'u-hz-author-003' });
  let N = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-hz-author-003' });
  const sigN = signal(ctx, { lead_id: N.id, source_type: 'post', content: '25万预算想买宝马，求推荐', signal_at: '2026-09-10T08:00:00.000Z', score: 70, post: ppN });
  N = leads.update(N.id, { score: 70, tier: 'qualified', intent: { brand: 'BMW' }, evidence: [], primary_signal_id: sigN.id, last_signal_at: '2026-09-10T08:00:00.000Z' });

  // L — do-not-contact lead
  let L = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-negative-001', stage: 'LOST', suppressed: true });
  const cL = publicComment(ctx, { post: ppI3, id: 'c-l-1', author: 'u-negative-001', content: '杭州i3有现车吗', ip: '浙江' });
  const sigL = signal(ctx, { lead_id: L.id, source_type: 'comment', content: '杭州i3有现车吗', signal_at: '2026-09-01T08:00:00.000Z', score: 25, post: ppI3, comment: cL });
  L = leads.update(L.id, {
    score: 25,
    tier: 'candidate',
    intent: { model: 'i3', location: '杭州' },
    primary_signal_id: sigL.id,
    last_signal_at: '2026-09-01T08:00:00.000Z',
    suppression_reason: '用户回复：不需要，别再发了',
    lost_reason: 'do_not_contact: 用户回复：不需要，别再发了',
  });
  seedSuppression(ctx, 'u-negative-001');

  // S — Shanghai dealer lead (highest score overall)
  let S = seedLead(ctx, { dealer_id: sh, platform_user_id: 'u-sh-buyer-001' });
  const sigS = signal(ctx, { lead_id: S.id, source_type: 'comment', content: '上海X3 30L有现车吗', signal_at: '2026-09-11T09:00:00.000Z', score: 99, post: ppX3, comment: null, post_title: null });
  S = leads.update(S.id, { score: 99, tier: 'immediate', intent: { model: 'X3', location: '上海', province: '上海' }, primary_signal_id: sigS.id, last_signal_at: '2026-09-11T09:00:00.000Z' });

  return { ctx, hz, sh, wang, li, H, M, N, L, S, primarySig, weakSig, outreachH, ranking, ppI3, cStrong, ppX3 };
}

const ids = (cards: { lead_id: string }[]) => cards.map((c) => c.lead_id);

describe('analytics: lead inbox', () => {
  it('sorts by score then last signal and pages', () => {
    const { ctx, hz, H, M, N, L, S } = setup();
    assert.deepEqual(ids(getLeadInbox(ctx, { dealer_id: hz })), [H.id, N.id, M.id, L.id]);
    assert.deepEqual(ids(getLeadInbox(ctx)), [S.id, H.id, N.id, M.id, L.id]);
    assert.deepEqual(ids(getLeadInbox(ctx, { dealer_id: hz, limit: 2, offset: 1 })), [N.id, M.id]);
    assert.deepEqual(getLeadInbox(ctx, { dealer_id: hz, offset: 10 }), []);
    assert.deepEqual(ids(getLeadInbox(ctx, { dealer_id: hz, tier: 'qualified' })), [N.id, M.id]);
  });

  it('shows the verbatim original signal, its source and the assigned account on the card', () => {
    const { ctx, hz, wang, H, primarySig, outreachH } = setup();
    const card = getLeadInbox(ctx, { dealer_id: hz })[0];
    assert.equal(card.lead_id, H.id);
    assert.equal(card.original_signal, SIGNAL_H);
    assert.equal(card.original_signal_id, primarySig.id);
    assert.deepEqual(card.source, { type: 'comment', post_title: '宝马i3现在值得买吗？', url: NOTE_URL, signal_at: '2026-09-11T08:00:00.000Z' });
    assert.deepEqual(card.assigned_account, { id: wang, nickname: '销售小王·杭州宝马', account_type: 'salesperson' });
    assert.equal(card.score, 96);
    assert.equal(card.tier, 'immediate');
    assert.equal(card.tier_label, '立即跟进');
    assert.equal(card.model_label, 'BMW i3 eDrive35L');
    assert.equal(card.location_label, '杭州');
    assert.equal(card.purchase_stage, 'purchase_imminent');
    assert.equal(card.purchase_stage_label, '即将购买');
    assert.deepEqual(card.intent_chips, ['询问现车', '指定配置 eDrive35L', '本地买家（杭州）', '指定颜色 白外红内', '想到店看车', '本周到店']);
    assert.equal(card.signal_count, 2);
    assert.equal(card.stage, 'ASSIGNED');
    assert.equal(card.outreach_status, 'READY_FOR_REVIEW');
    assert.equal(card.next_action, '审核私信：通过后在小红书发送');
    assert.equal(card.next_action, computeNextAction(ctx, ctx.db.table('leads').require(H.id)));
    assert.equal(card.suppressed, false);
    assert.equal(card.username, 'u-hz-buyer-001');
    assert.ok(outreachH.id);
  });

  it('never hides provenance: every card carries a stored signal verbatim', () => {
    const { ctx, M, N, L } = setup();
    const cards = getLeadInbox(ctx);
    assert.equal(cards.length, 5);
    for (const card of cards) {
      assert.ok(card.original_signal.length > 0, `card ${card.lead_id} lacks its original signal`);
      const stored = ctx.db.table('lead_signals').require(card.original_signal_id as string);
      assert.equal(stored.lead_id, card.lead_id);
      assert.equal(stored.content, card.original_signal);
    }
    const byId = new Map(cards.map((c) => [c.lead_id, c]));
    const m = byId.get(M.id)!;
    assert.equal(m.original_signal, 'X3 25L现在什么价', 'fallback picks the strongest purchase signal, not the later remark');
    assert.equal(m.location_label, 'IP属地：浙江', "the commenter's IP, not the post author's");
    assert.equal(m.model_label, 'BMW X3');
    assert.equal(m.purchase_stage_label, '询价比价');
    assert.equal(m.assigned_account, null);
    assert.equal(m.outreach_status, null);
    assert.equal(m.next_action, '分配最合适的账号');
    const n = byId.get(N.id)!;
    assert.deepEqual([n.model_label, n.location_label, n.purchase_stage, n.purchase_stage_label], ['BMW', 'IP属地：上海', null, null]);
    assert.deepEqual(n.source, { type: 'post', post_title: '25万买什么车', url: 'https://www.xiaohongshu.com/explore/note-q-003', signal_at: '2026-09-10T08:00:00.000Z' });
    assert.deepEqual(n.intent_chips, []);
    const l = byId.get(L.id)!;
    assert.deepEqual([l.suppressed, l.tier_label, l.stage, l.next_action], [true, '候选', 'LOST', '勿扰：已停止所有触达']);
  });

  it('reports an empty original signal only when the lead has no stored signal at all', () => {
    const { ctx, hz } = setup();
    const bare = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-import-001' });
    const card = buildLeadCard(ctx, bare);
    assert.deepEqual([card.original_signal, card.original_signal_id, card.model_label, card.location_label], ['', null, '车型未明确', '地区未知']);
    assert.deepEqual(card.source, { type: null, post_title: null, url: null, signal_at: null });
  });

  it('filters by account, brand, model, location, source, stage and signal window', () => {
    const { ctx, hz, wang, li, H, M, N, L } = setup();
    const q = (f: Parameters<typeof getLeadInbox>[1]) => ids(getLeadInbox(ctx, { dealer_id: hz, ...f }));
    assert.deepEqual(q({ account_id: wang }), [H.id]);
    assert.deepEqual(q({ account_id: li }), [], 'released assignments do not count');
    assert.deepEqual(q({ brand: 'bmw' }), [H.id, N.id, M.id]);
    assert.deepEqual(q({ model: 'i3' }), [H.id, L.id]);
    assert.deepEqual(q({ model: '宝马X3' }), [M.id]);
    assert.deepEqual(q({ location: '杭州' }), [H.id, L.id]);
    assert.deepEqual(q({ location: '浙江' }), [H.id, L.id], 'IP 属地 is not a stated location');
    assert.deepEqual(q({ source_type: 'post' }), [N.id]);
    assert.deepEqual(q({ source_type: 'comment' }), [H.id, M.id, L.id]);
    assert.deepEqual(q({ stage: 'LOST' }), [L.id]);
    assert.deepEqual(q({ stage: 'ASSIGNED' }), [H.id]);
    assert.deepEqual(q({ from: '2026-09-10' }), [H.id, N.id]);
    assert.deepEqual(q({ to: '2026-09-09' }), [M.id, L.id]);
    assert.deepEqual(q({ from: '2026-09-10T00:00:00Z', to: '2026-09-11T00:00:00Z' }), [N.id]);
  });

  it('validates paging and tier', () => {
    const { ctx } = setup();
    for (const bad of [{ limit: 0 }, { limit: 501 }, { limit: 1.5 }, { offset: -1 }, { tier: 'hot' }, { stage: 'HOT' }]) {
      assert.throws(() => getLeadInbox(ctx, bad as never), ValidationError, JSON.stringify(bad));
    }
    assert.throws(() => getLeadInbox(ctx, { account_id: 'acc_missing' }), NotFoundError);
  });

  it('label helpers', () => {
    assert.equal(modelLabel({ brand: 'BMW', model: '3 Series', trim: '325Li' }), 'BMW 3 Series 325Li');
    assert.equal(modelLabel({ model: 'i3' }), 'BMW i3');
    assert.equal(modelLabel({ brand: '宝马' }), 'BMW');
    assert.equal(modelLabel({}), '车型未明确');
    assert.equal(locationLabel({ province: '浙江' }, '上海'), '浙江');
    assert.equal(locationLabel({}, null), '地区未知');
    assert.equal(intentChips([{ code: 'a', label: ' ' }, { code: 'b', label: '询问优惠' }, { code: 'c', label: '询问优惠' }]).length, 1);
  });
});

describe('analytics: lead detail', () => {
  it('returns the complete lead record', () => {
    const { ctx, hz, wang, li, H, M, primarySig, weakSig, outreachH, ranking, ppI3, cStrong } = setup();
    ctx.db.table('lead_scores').insert({ id: newId('lsc'), lead_id: H.id, score: 88, tier: 'high_intent', components: [], config_version: 1, computed_at: '2026-09-10T08:00:00.000Z' });
    ctx.db.table('lead_scores').insert({ id: newId('lsc'), lead_id: H.id, score: 96, tier: 'immediate', components: [], config_version: 1, computed_at: '2026-09-11T08:00:00.000Z' });
    transition(ctx, H.id, 'DISCOVERED', 'QUALIFIED', '2026-09-11T08:00:00.000Z');
    transition(ctx, H.id, 'QUALIFIED', 'ASSIGNED', '2026-09-11T10:00:00.000Z');
    const { conversation } = seedInboundReply(ctx, { lead_id: H.id, account_id: wang, at: '2026-09-11T12:00:00.000Z', content: '白色的还有吗' });
    ctx.db.table('conversation_messages').insert({
      id: newId('msg'),
      conversation_id: conversation.id,
      direction: 'outbound',
      content: '您好，白外红内35L目前有1台现车',
      intents: [],
      extracted: {},
      status: 'draft',
      fact_refs: [],
      provider_message_id: null,
      engine: 'rules',
      created_at: '2026-09-11T12:05:00.000Z',
    });
    const appt = seedAppointment(ctx, { lead_id: H.id, dealer_id: hz, account_id: wang });
    const conversion = seedConversion(ctx, { lead_id: H.id, dealer_id: hz, account_id: wang, outcome: 'won' });
    const base = { agent: 'lead-scoring-agent', skill: 'lead-scoring', inputs: {}, evidence: [], output: {}, confidence: 0.9, engine: 'rules' as const };
    ctx.audit.decision({ ...base, decision_type: 'lead_score', subject_type: 'lead', subject_id: H.id });
    ctx.audit.decision({ ...base, decision_type: 'outreach_generation', subject_type: 'outreach', subject_id: outreachH.id });
    ctx.audit.decision({ ...base, decision_type: 'conversation_reply', subject_type: 'conversation', subject_id: conversation.id });
    ctx.audit.decision({ ...base, decision_type: 'lead_score', subject_type: 'lead', subject_id: M.id });
    ctx.audit.event({ actor: 'agent:crm-agent', action: 'lead.stage_changed', entity_type: 'lead', entity_id: H.id, details: { to: 'ASSIGNED' } });

    const d = getLeadDetail(ctx, H.id);
    assert.equal(d.lead.id, H.id);
    assert.deepEqual(d.card, getLeadInbox(ctx, { dealer_id: hz })[0]);
    assert.deepEqual(d.dealer, { id: hz, name: '杭州宝马中心' });

    assert.deepEqual(d.signals.map((s) => s.signal.id), [weakSig.id, primarySig.id]);
    assert.deepEqual(d.signals.map((s) => s.is_primary), [false, true]);
    assert.equal(d.signals[1].public_post?.id, ppI3.id);
    assert.equal(d.signals[1].public_post?.url, NOTE_URL);
    assert.equal(d.signals[1].public_comment?.id, cStrong.id);
    assert.equal(d.signals[1].public_comment?.content, SIGNAL_H);

    assert.deepEqual(d.scores.map((s) => s.score), [88, 96]);
    assert.deepEqual(d.assignments.map((a) => [a.account_id, a.active]), [[li, false], [wang, true]]);
    assert.equal(d.assignment?.account_id, wang);
    assert.deepEqual(d.candidates, ranking);
    assert.deepEqual(d.outreach.map((o) => o.id), [outreachH.id]);
    assert.equal(d.conversation?.id, conversation.id);
    assert.deepEqual(d.messages.map((m) => [m.direction, m.status]), [['inbound', 'received'], ['outbound', 'draft']]);
    assert.equal(d.conversations.length, 1);
    assert.deepEqual(d.appointments.map((a) => a.id), [appt.id]);
    assert.deepEqual(d.conversions.map((c) => c.id), [conversion.id]);
    assert.deepEqual(d.transitions.map((t) => t.to_stage), ['QUALIFIED', 'ASSIGNED']);
    assert.deepEqual(
      d.decisions.map((x) => x.subject_type).sort(),
      ['conversation', 'lead', 'outreach'],
      "decisions include the lead's outreach and conversation subjects, not other leads",
    );
    assert.ok(d.events.some((e) => e.action === 'lead.stage_changed' && e.entity_id === H.id));
    assert.equal(d.suppression, null);
  });

  it('includes the suppression, handles leads without history and rejects unknown ids', () => {
    const { ctx, hz, L } = setup();
    const d = getLeadDetail(ctx, L.id);
    assert.equal(d.suppression?.platform_user_id, 'u-negative-001');
    assert.equal(d.card.next_action, '勿扰：已停止所有触达');

    const bare = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-bare-001' });
    const empty = getLeadDetail(ctx, bare.id);
    assert.deepEqual(
      [empty.signals, empty.scores, empty.assignments, empty.candidates, empty.outreach, empty.messages, empty.conversations, empty.appointments, empty.conversions, empty.transitions],
      [[], [], [], [], [], [], [], [], [], []],
    );
    assert.deepEqual([empty.assignment, empty.conversation, empty.suppression], [null, null, null]);

    assert.throws(() => getLeadDetail(ctx, 'lead_missing'), NotFoundError);
    assert.throws(() => getLeadDetail(ctx, ''), ValidationError);
  });
});
