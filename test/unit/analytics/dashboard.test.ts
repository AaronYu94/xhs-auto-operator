import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppContext } from '../../../src/app/context.ts';
import { NotFoundError, ValidationError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import type { Conversation, Lead, LeadStage, Post, PostMetrics, PostStatus, SignalSourceType } from '../../../src/core/types.ts';
import { transitionLead } from '../../../src/skills/operations/crm/index.ts';
import { computeFleetHealth } from '../../../src/skills/operations/account-health/index.ts';
import {
  EXCEPTION_KINDS,
  buildBriefing,
  getDashboard,
  resolvePeriod,
  skill,
  type DashboardMetrics,
  type ExceptionKind,
} from '../../../src/skills/operations/analytics/index.ts';
import { SkillRegistry } from '../../../src/skills/registry.ts';
import { TEST_NOW, createTestContext } from '../../helpers/context.ts';
import {
  accountIdByPlatformId,
  dealerIdByKey,
  loadDealerFixture,
  seedAppointment,
  seedAssignment,
  seedInboundReply,
  seedLead,
  seedOutreach,
} from '../../helpers/fixtures.ts';

// TEST_NOW = Sat 2026-09-12 10:00 Asia/Shanghai (02:00Z) → dealer-local today = [2026-09-11T16:00Z, 2026-09-12T16:00Z)
const TODAY_START = '2026-09-11T16:00:00.000Z'; // 00:00 today (local)
const LATE_TODAY = '2026-09-12T15:59:00.000Z'; // 23:59 today (local)
const NEXT_MIDNIGHT = '2026-09-12T16:00:00.000Z'; // 00:00 tomorrow (local)
const NEXT_DAY = '2026-09-12T16:01:00.000Z'; // 00:01 tomorrow (local)
const PREV_DAY = '2026-09-11T15:59:00.000Z'; // 23:59 yesterday (local)
const MID_TODAY = TEST_NOW;

function setup() {
  const ctx = createTestContext();
  const s = loadDealerFixture(ctx);
  return {
    ctx,
    hz: dealerIdByKey(s, 'hz-bmw'),
    sh: dealerIdByKey(s, 'sh-bmw'),
    acc: (pid: string) => accountIdByPlatformId(s, pid),
  };
}

let userSeq = 0;
function lead(ctx: AppContext, dealerId: string, patch: Partial<Lead> = {}, at?: string): Lead {
  const row = seedLead(ctx, { dealer_id: dealerId, platform_user_id: `u-dash-${++userSeq}`, at });
  return Object.keys(patch).length > 0 ? ctx.db.table('leads').update(row.id, patch) : row;
}

function transition(ctx: AppContext, leadId: string, from: LeadStage | null, to: LeadStage, at: string): void {
  ctx.db.table('lead_stage_transitions').insert({
    id: newId('trn'),
    lead_id: leadId,
    from_stage: from,
    to_stage: to,
    reason: 'test',
    actor: 'test',
    at,
  });
}

function signal(ctx: AppContext, leadId: string, sourceType: SignalSourceType, content: string): void {
  ctx.db.table('lead_signals').insert({
    id: newId('sig'),
    lead_id: leadId,
    source_type: sourceType,
    public_post_id: null,
    public_comment_id: null,
    post_title: null,
    content,
    signal_at: MID_TODAY,
    search_run_id: null,
    query_id: null,
    intent: {},
    signal_score: 70,
    evidence: [],
    engine: 'rules',
    is_purchase_signal: true,
    strength: 1,
    transaction_questions: [],
    author_role: 'asker',
    created_at: MID_TODAY,
  });
}

function post(
  ctx: AppContext,
  input: {
    dealer_id: string;
    account_id: string;
    status: PostStatus;
    slot_date: string;
    published_at?: string | null;
    metrics?: Partial<PostMetrics>;
    model?: string | null;
  },
): Post {
  return ctx.db.table('posts').insert({
    id: newId('post'),
    dealer_id: input.dealer_id,
    account_id: input.account_id,
    plan_id: null,
    slot_date: input.slot_date,
    pillar: 'model_review',
    topic: `test:${newId('t')}`,
    angle: '',
    model: input.model === undefined ? 'i3' : input.model,
    title: '测试笔记',
    body: '正文',
    tags: [],
    cover_text: '',
    fact_refs: [],
    status: input.status,
    review: null,
    approval_policy: 'REVIEW_REQUIRED',
    platform_note_id: null,
    scheduled_for: null,
    published_at: input.published_at ?? null,
    metrics: { views: 0, likes: 0, collects: 0, comments: 0, shares: 0, ...input.metrics },
    metrics_updated_at: null,
    engine: 'rules',
    created_at: MID_TODAY,
    updated_at: MID_TODAY,
  });
}

function searchRun(
  ctx: AppContext,
  dealerId: string,
  startedAt: string,
  counts: { posts: number; comments: number; users: number },
  query: { text: string; brand?: string | null; model?: string | null; location?: string | null },
): void {
  const queries = ctx.db.table('search_queries');
  const q =
    queries.findOne({ dealer_id: dealerId, text: query.text }) ??
    queries.insert({
      id: newId('q'),
      dealer_id: dealerId,
      goal_id: null,
      text: query.text,
      query_class: 'direct_model',
      brand: query.brand ?? null,
      model: query.model ?? null,
      location: query.location ?? null,
      priority: 0.5,
      status: 'active',
      parent_query_id: null,
      generation_reason: 'test',
      created_at: MID_TODAY,
      updated_at: MID_TODAY,
    });
  ctx.db.table('search_runs').insert({
    id: newId('run'),
    query_id: q.id,
    dealer_id: dealerId,
    workflow_run_id: null,
    provider: 'simulation',
    status: 'SUCCEEDED',
    posts_discovered: counts.posts,
    posts_new: 0,
    comments_scanned: counts.comments,
    users_evaluated: counts.users,
    candidates: 0,
    qualified: 0,
    high_intent: 0,
    error: null,
    started_at: startedAt,
    finished_at: startedAt,
  });
}

function message(ctx: AppContext, conversation: Conversation, direction: 'inbound' | 'outbound', status: 'received' | 'draft' | 'sent', at: string): void {
  ctx.db.table('conversation_messages').insert({
    id: newId('msg'),
    conversation_id: conversation.id,
    direction,
    content: direction === 'inbound' ? '还有现车吗' : '您好，白色35L目前有现车',
    intents: [],
    extracted: {},
    status,
    fact_refs: [],
    provider_message_id: null,
    engine: 'rules',
    created_at: at,
  });
}

function workflowRun(ctx: AppContext, dealerId: string | null, status: 'FAILED' | 'SUCCEEDED', startedAt: string, finishedAt: string | null): void {
  ctx.db.table('workflow_runs').insert({
    id: newId('wf'),
    workflow: 'lead_discovery',
    dealer_id: dealerId,
    goal_id: null,
    trigger: 'schedule',
    status,
    input: {},
    output: {},
    error: status === 'FAILED' ? 'provider timeout' : null,
    resumed_from_run_id: null,
    started_at: startedAt,
    finished_at: finishedAt,
  });
}

function assertNoNaN(value: unknown, path = 'result'): void {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} must be finite, got ${value}`);
    return;
  }
  if (value && typeof value === 'object') for (const [k, x] of Object.entries(value)) assertNoNaN(x, `${path}.${k}`);
}

const zeroCounts = (): Record<ExceptionKind, number> =>
  Object.fromEntries(EXCEPTION_KINDS.map((k) => [k, 0])) as Record<ExceptionKind, number>;

describe('analytics: resolvePeriod', () => {
  it('defaults to the dealer-local day in Asia/Shanghai', () => {
    const ctx = createTestContext();
    assert.deepEqual(resolvePeriod(ctx, {}), { from: TODAY_START, to: NEXT_MIDNIGHT, timezone: 'Asia/Shanghai', is_today: true });
    const { ctx: c2, hz } = setup();
    assert.deepEqual(resolvePeriod(c2, { dealer_id: hz }), { from: TODAY_START, to: NEXT_MIDNIGHT, timezone: 'Asia/Shanghai', is_today: true });
  });

  it("uses the dealer's (or the filtered account's dealer's) timezone", () => {
    const { ctx, sh, acc } = setup();
    const dealers = ctx.db.table('dealers');
    dealers.update(sh, { settings: { ...dealers.require(sh).settings, timezone: 'Asia/Tokyo' } });
    // 2026-09-12T02:00Z = 11:00 Tokyo → [2026-09-11T15:00Z, 2026-09-12T15:00Z)
    const expected = { from: '2026-09-11T15:00:00.000Z', to: '2026-09-12T15:00:00.000Z', timezone: 'Asia/Tokyo', is_today: true };
    assert.deepEqual(resolvePeriod(ctx, { dealer_id: sh }), expected);
    assert.deepEqual(resolvePeriod(ctx, { account_id: acc('xhs-sh-sales-zhao') }), expected);
  });

  it('accepts local dates (to inclusive), ISO datetimes and open-ended bounds', () => {
    const { ctx, hz } = setup();
    assert.deepEqual(resolvePeriod(ctx, { dealer_id: hz, from: '2026-09-01', to: '2026-09-07' }), {
      from: '2026-08-31T16:00:00.000Z',
      to: '2026-09-07T16:00:00.000Z',
      timezone: 'Asia/Shanghai',
      is_today: false,
    });
    assert.equal(resolvePeriod(ctx, { from: '2026-09-12', to: '2026-09-12' }).is_today, true);
    assert.deepEqual(resolvePeriod(ctx, { from: '2026-09-10T00:00:00+08:00' }), {
      from: '2026-09-09T16:00:00.000Z',
      to: NEXT_MIDNIGHT,
      timezone: 'Asia/Shanghai',
      is_today: false,
    });
    const future = resolvePeriod(ctx, { from: '2026-09-20' });
    assert.deepEqual([future.from, future.to], ['2026-09-19T16:00:00.000Z', '2026-09-20T16:00:00.000Z']);
    const toOnly = resolvePeriod(ctx, { to: '2026-09-05T12:00:00Z' });
    assert.deepEqual([toOnly.from, toOnly.to], ['2026-09-04T16:00:00.000Z', '2026-09-05T12:00:00.000Z']);
    assert.equal(resolvePeriod(ctx, { from: '', to: '' }).is_today, true, 'empty strings are ignored');
  });

  it('rejects malformed filters and unknown ids', () => {
    const { ctx } = setup();
    for (const bad of [
      { from: 'yesterday' },
      { from: '2026-02-30' },
      { from: '2026-09-12T10:00:00' },
      { from: '2026-09-10', to: '2026-09-09' },
      { from: '2026-09-10T05:00:00Z', to: '2026-09-10T05:00:00Z' },
      { stage: 'NOPE' },
      { source_type: 'dm' },
      { dealer_id: 42 },
    ]) {
      assert.throws(() => resolvePeriod(ctx, bad as never), ValidationError, JSON.stringify(bad));
    }
    assert.throws(() => resolvePeriod(ctx, 'today' as never), ValidationError);
    assert.throws(() => resolvePeriod(ctx, { dealer_id: 'dlr_missing' }), NotFoundError);
    assert.throws(() => resolvePeriod(ctx, { account_id: 'acc_missing' }), NotFoundError);
  });
});

describe('analytics: getDashboard', () => {
  it('returns zeros (never NaN) on an empty database and only reports what exists', () => {
    const ctx = createTestContext();
    const d = getDashboard(ctx);
    assert.deepEqual(d.period, { from: TODAY_START, to: NEXT_MIDNIGHT, timezone: 'Asia/Shanghai', is_today: true });
    assert.deepEqual(d.content, { posts_published: 0, views: 0, engagement: 0, posts_planned: 0, posts_pending_approval: 0 });
    assert.deepEqual(d.discovery, { posts_scanned: 0, comments_scanned: 0, users_evaluated: 0, candidates: 0, qualified: 0, high_intent: 0 });
    assert.deepEqual(d.outreach, { outreach_ready: 0, contacted: 0, replies: 0, reply_rate: 0 });
    assert.deepEqual(d.sales, { sales_qualified: 0, contacts_acquired: 0, appointments: 0, visits: 0, won: 0, lost: 0 });
    assert.equal(d.pipeline.estimated_value, 0);
    assert.deepEqual(
      d.pipeline.by_stage.map((s) => s.stage),
      ['QUALIFIED', 'ASSIGNED', 'OUTREACH_READY', 'CONTACTED', 'REPLIED', 'SALES_QUALIFIED', 'CONTACT_ACQUIRED', 'APPOINTMENT', 'VISITED', 'NEGOTIATING'],
    );
    assert.ok(d.pipeline.by_stage.every((s) => s.count === 0 && s.value === 0));
    assert.deepEqual(d.accounts, { active: 0, healthy: 0, requiring_attention: [] });
    assert.deepEqual(d.exceptions, []);
    assert.deepEqual(d.briefing, ['今日暂无新的运营进展']);
    assert.equal(d.generated_at, TEST_NOW);
    assertNoNaN(d);
  });

  it('is read-only and treats accounts without a health snapshot as requiring attention', () => {
    const { ctx, hz } = setup();
    const before = [ctx.db.table('agent_decisions').count(), ctx.db.table('audit_events').count(), ctx.db.table('account_health').count()];
    const d = getDashboard(ctx, { dealer_id: hz });
    assert.deepEqual(before, [ctx.db.table('agent_decisions').count(), ctx.db.table('audit_events').count(), ctx.db.table('account_health').count()]);
    assert.equal(d.accounts.active, 6);
    assert.equal(d.accounts.healthy, 0);
    assert.equal(d.accounts.requiring_attention.length, 6);
    assert.ok(d.accounts.requiring_attention.every((a) => a.state === null && a.issues.length === 1 && a.issues[0] === '尚未计算健康度'));
    assert.deepEqual(d.exceptions, [
      { kind: 'accounts_attention', title: '账号需要关注', count: 6, severity: 'medium', href: `/accounts?dealer_id=${encodeURIComponent(hz)}` },
    ]);
    assert.deepEqual(d.briefing, ['6 个账号需要关注']);

    computeFleetHealth(ctx, hz);
    const healthy = getDashboard(ctx, { dealer_id: hz });
    assert.deepEqual([healthy.accounts.active, healthy.accounts.healthy, healthy.accounts.requiring_attention.length], [6, 6, 0]);
    assert.deepEqual(healthy.exceptions, []);
    assert.deepEqual(healthy.briefing, ['今日暂无新的运营进展']);
  });

  it('counts content published and planned in the local day, filtered by dealer / account / model', () => {
    const { ctx, hz, sh, acc } = setup();
    const official = acc('xhs-hz-official');
    const wang = acc('xhs-hz-sales-wang');
    post(ctx, { dealer_id: hz, account_id: official, status: 'PUBLISHED', slot_date: '2026-09-12', published_at: LATE_TODAY, metrics: { views: 500, likes: 10, collects: 5, comments: 3, shares: 2 } });
    post(ctx, { dealer_id: hz, account_id: wang, status: 'PUBLISHED', slot_date: '2026-09-12', published_at: TODAY_START, metrics: { likes: 1 }, model: 'X3' });
    post(ctx, { dealer_id: hz, account_id: official, status: 'PUBLISHED', slot_date: '2026-09-11', published_at: PREV_DAY, metrics: { views: 9000, likes: 1000 } });
    post(ctx, { dealer_id: hz, account_id: official, status: 'PUBLISHED', slot_date: '2026-09-13', published_at: NEXT_DAY, metrics: { likes: 1000 } });
    post(ctx, { dealer_id: sh, account_id: acc('xhs-sh-official'), status: 'PUBLISHED', slot_date: '2026-09-12', published_at: MID_TODAY, metrics: { likes: 7 } });
    for (const status of ['PLANNED', 'DRAFTED', 'IN_REVIEW', 'REJECTED'] as const)
      post(ctx, { dealer_id: hz, account_id: official, status, slot_date: '2026-09-12' });
    post(ctx, { dealer_id: hz, account_id: official, status: 'IN_REVIEW', slot_date: '2026-09-14' });
    post(ctx, { dealer_id: hz, account_id: official, status: 'PLANNED', slot_date: '2026-09-13' });

    const d = getDashboard(ctx, { dealer_id: hz });
    // planned today: 2 published + PLANNED + DRAFTED + IN_REVIEW (REJECTED and other days excluded)
    assert.deepEqual(d.content, { posts_published: 2, views: 500, engagement: 21, posts_planned: 5, posts_pending_approval: 2 });
    assert.ok(d.briefing.includes('今日计划 5 篇内容，2 篇待审批'));
    assert.ok(d.briefing.includes('今日已发布 2 篇内容，浏览 500 次，互动 21 次'));

    assert.deepEqual(getDashboard(ctx).content, { posts_published: 3, views: 500, engagement: 28, posts_planned: 6, posts_pending_approval: 2 });
    assert.deepEqual(getDashboard(ctx, { account_id: wang }).content, { posts_published: 1, views: 0, engagement: 1, posts_planned: 1, posts_pending_approval: 0 });
    assert.equal(getDashboard(ctx, { dealer_id: hz, model: 'x3' }).content.posts_published, 1);
    assert.equal(getDashboard(ctx, { dealer_id: hz, model: '宝马i3' }).content.posts_published, 1);
  });

  it('sums discovery scans from search runs started in the period (dealer, account dealer, model, location)', () => {
    const { ctx, hz, sh, acc } = setup();
    const i3q = { text: '杭州i3落地', brand: 'BMW', model: 'i3', location: '杭州' };
    const x3q = { text: 'X3优惠', brand: 'BMW', model: 'X3', location: null };
    searchRun(ctx, hz, LATE_TODAY, { posts: 10, comments: 100, users: 40 }, i3q);
    searchRun(ctx, hz, TODAY_START, { posts: 5, comments: 50, users: 20 }, x3q);
    searchRun(ctx, hz, NEXT_MIDNIGHT, { posts: 100, comments: 1000, users: 400 }, i3q);
    searchRun(ctx, hz, PREV_DAY, { posts: 100, comments: 1000, users: 400 }, x3q);
    searchRun(ctx, sh, MID_TODAY, { posts: 7, comments: 70, users: 30 }, { text: '上海X3', model: 'X3', location: '上海' });

    const pick = (d: DashboardMetrics) => [d.discovery.posts_scanned, d.discovery.comments_scanned, d.discovery.users_evaluated];
    assert.deepEqual(pick(getDashboard(ctx, { dealer_id: hz })), [15, 150, 60]);
    assert.deepEqual(pick(getDashboard(ctx)), [22, 220, 90]);
    assert.deepEqual(pick(getDashboard(ctx, { dealer_id: hz, model: 'i3' })), [10, 100, 40]);
    assert.deepEqual(pick(getDashboard(ctx, { dealer_id: hz, location: '浙江' })), [10, 100, 40], 'province matches a query located in one of its cities');
    assert.deepEqual(pick(getDashboard(ctx, { account_id: acc('xhs-hz-sales-li') })), [15, 150, 60], 'account filter scopes to its dealer');
    assert.ok(getDashboard(ctx, { dealer_id: hz }).briefing.includes('分析了 165 条公开信号，评估了 60 位用户'));
  });

  it('counts leads entering stages via transitions with exact Asia/Shanghai day boundaries', () => {
    const { ctx, hz, sh } = setup();
    const A = lead(ctx, hz, { stage: 'CANDIDATE', tier: 'candidate', score: 30 });
    transition(ctx, A.id, 'DISCOVERED', 'CANDIDATE', LATE_TODAY); // 23:59 local → today
    const B = lead(ctx, hz, { tier: 'high_intent', score: 85 });
    transition(ctx, B.id, null, 'QUALIFIED', TODAY_START); // 00:00 local, forward jump → candidate + qualified
    const C = lead(ctx, hz);
    transition(ctx, C.id, 'DISCOVERED', 'CANDIDATE', PREV_DAY); // 23:59 yesterday → not today
    transition(ctx, C.id, 'CANDIDATE', 'QUALIFIED', MID_TODAY);
    const D = lead(ctx, hz, { stage: 'CANDIDATE', tier: 'candidate' });
    transition(ctx, D.id, 'DISCOVERED', 'CANDIDATE', NEXT_DAY); // 00:01 tomorrow → not today
    const G = lead(ctx, hz, { stage: 'CANDIDATE', tier: 'candidate' });
    transition(ctx, G.id, 'DISCOVERED', 'CANDIDATE', NEXT_MIDNIGHT); // exactly 00:00 tomorrow → not today
    const E = lead(ctx, hz, { stage: 'ASSIGNED' });
    transition(ctx, E.id, 'DISCOVERED', 'QUALIFIED', PREV_DAY);
    transition(ctx, E.id, 'QUALIFIED', 'ASSIGNED', MID_TODAY); // already qualified → never re-counted
    const F = lead(ctx, sh, { tier: 'immediate', score: 95 });
    transition(ctx, F.id, 'DISCOVERED', 'QUALIFIED', MID_TODAY);

    const d = getDashboard(ctx, { dealer_id: hz });
    assert.deepEqual([d.discovery.candidates, d.discovery.qualified, d.discovery.high_intent], [2, 2, 1]);
    assert.ok(d.briefing.includes('发现 2 条合格线索，其中 1 条高意向'));
    const all = getDashboard(ctx);
    assert.deepEqual([all.discovery.candidates, all.discovery.qualified, all.discovery.high_intent], [3, 3, 2]);

    const window = getDashboard(ctx, { dealer_id: hz, from: '2026-09-11', to: '2026-09-12' });
    assert.deepEqual([window.discovery.candidates, window.discovery.qualified], [4, 3], 'A, B, C, E / B, C, E over two local days');
    assert.equal(window.period.is_today, false);

    ctx.clock.set('2026-09-13T02:00:00.000Z');
    const tomorrow = getDashboard(ctx, { dealer_id: hz });
    assert.equal(tomorrow.period.from, NEXT_MIDNIGHT);
    assert.deepEqual([tomorrow.discovery.candidates, tomorrow.discovery.qualified], [2, 0], 'D (00:01) and G (00:00) count on the next day');
  });

  it('computes outreach readiness, contacted, replies and reply rate', () => {
    const { ctx, hz, acc } = setup();
    const wang = acc('xhs-hz-sales-wang');
    const P1 = lead(ctx, hz, { stage: 'CONTACTED' });
    const a1 = seedAssignment(ctx, { lead_id: P1.id, account_id: wang });
    seedOutreach(ctx, { lead_id: P1.id, account_id: wang, assignment_id: a1.id, status: 'SENT' });
    transition(ctx, P1.id, 'ASSIGNED', 'CONTACTED', MID_TODAY);
    const conv1 = seedInboundReply(ctx, { lead_id: P1.id, account_id: wang, at: LATE_TODAY }).conversation;
    message(ctx, conv1, 'outbound', 'sent', MID_TODAY); // our own message is not a reply

    const P2 = lead(ctx, hz, { stage: 'CONTACTED' });
    transition(ctx, P2.id, 'ASSIGNED', 'CONTACTED', TODAY_START);

    const P3 = lead(ctx, hz, { stage: 'REPLIED' });
    transition(ctx, P3.id, 'ASSIGNED', 'CONTACTED', PREV_DAY);
    transition(ctx, P3.id, 'CONTACTED', 'REPLIED', MID_TODAY);
    seedInboundReply(ctx, { lead_id: P3.id, account_id: wang, at: MID_TODAY });
    seedInboundReply(ctx, { lead_id: P3.id, account_id: wang, at: LATE_TODAY });

    const P4 = lead(ctx, hz, { stage: 'REPLIED' });
    transition(ctx, P4.id, 'OUTREACH_READY', 'REPLIED', MID_TODAY); // jump across CONTACTED
    seedInboundReply(ctx, { lead_id: P4.id, account_id: wang, at: NEXT_DAY });

    for (const status of ['READY_FOR_REVIEW', 'APPROVED', 'BLOCKED'] as const) {
      const r = lead(ctx, hz);
      const a = seedAssignment(ctx, { lead_id: r.id, account_id: wang });
      seedOutreach(ctx, { lead_id: r.id, account_id: wang, assignment_id: a.id, status });
    }

    const d = getDashboard(ctx, { dealer_id: hz });
    // contacted: P1, P2, P4 · replies: P1×1 + P3×2 · replied leads: P1, P3 → 2/3
    assert.deepEqual(d.outreach, { outreach_ready: 2, contacted: 3, replies: 3, reply_rate: 0.6667 });
    assert.ok(d.briefing.includes('今日触达 3 位潜在客户，收到 3 条回复（回复率 66.7%）'));
    assert.ok(d.briefing.includes('1 条私信待你审核'));
    assert.ok(d.briefing.includes('1 条已审核私信待你在小红书发送'));
  });

  it('keeps reply rate within [0, 1] and 0 when nobody was contacted', () => {
    const { ctx, hz, acc } = setup();
    const wang = acc('xhs-hz-sales-wang');
    const replier = lead(ctx, hz, { stage: 'REPLIED' });
    seedInboundReply(ctx, { lead_id: replier.id, account_id: wang, at: MID_TODAY });
    let d = getDashboard(ctx, { dealer_id: hz });
    assert.deepEqual([d.outreach.contacted, d.outreach.replies, d.outreach.reply_rate], [0, 1, 0]);
    assert.ok(d.briefing.includes('收到 1 条客户回复'));

    const contacted = lead(ctx, hz, { stage: 'CONTACTED' });
    transition(ctx, contacted.id, 'ASSIGNED', 'CONTACTED', MID_TODAY);
    const other = lead(ctx, hz, { stage: 'REPLIED' });
    seedInboundReply(ctx, { lead_id: other.id, account_id: wang, at: MID_TODAY });
    d = getDashboard(ctx, { dealer_id: hz });
    assert.deepEqual([d.outreach.contacted, d.outreach.replies, d.outreach.reply_rate], [1, 2, 1]);
  });

  it('counts sales movements exactly (jumps count crossed stages; WON jumps are not appointments)', () => {
    const { ctx, hz } = setup();
    const S1 = lead(ctx, hz, { stage: 'SALES_QUALIFIED' });
    transition(ctx, S1.id, 'REPLIED', 'SALES_QUALIFIED', MID_TODAY);
    const S2 = lead(ctx, hz, { stage: 'APPOINTMENT' });
    transition(ctx, S2.id, 'SALES_QUALIFIED', 'APPOINTMENT', MID_TODAY);
    const S3 = lead(ctx, hz, { stage: 'VISITED' });
    transition(ctx, S3.id, 'APPOINTMENT', 'VISITED', LATE_TODAY);
    const S4 = lead(ctx, hz, { stage: 'WON' });
    transition(ctx, S4.id, 'NEGOTIATING', 'WON', MID_TODAY);
    const S5 = lead(ctx, hz, { stage: 'WON' });
    transition(ctx, S5.id, 'CONTACTED', 'WON', MID_TODAY);
    const S6 = lead(ctx, hz, { stage: 'LOST' });
    transition(ctx, S6.id, 'ASSIGNED', 'LOST', TODAY_START);
    const S7 = lead(ctx, hz, { stage: 'QUALIFIED' });
    transition(ctx, S7.id, 'LOST', 'QUALIFIED', MID_TODAY); // operator reopen re-enters the funnel
    const old = lead(ctx, hz, { stage: 'WON' });
    transition(ctx, old.id, 'NEGOTIATING', 'WON', PREV_DAY);

    const d = getDashboard(ctx, { dealer_id: hz });
    assert.deepEqual(d.sales, { sales_qualified: 1, contacts_acquired: 1, appointments: 1, visits: 1, won: 2, lost: 1 });
    assert.deepEqual([d.discovery.candidates, d.discovery.qualified, d.outreach.contacted], [1, 1, 0]);
    for (const line of ['1 位客户通过销售资格确认', '获取 1 位客户的联系方式', '新增 1 个到店预约', '1 位客户到店看车', '成交 2 台', '1 条线索流失'])
      assert.ok(d.briefing.includes(line), line);
  });

  it('values the open pipeline as estimated_value × stage win probability', () => {
    const { ctx, hz, sh } = setup();
    lead(ctx, hz, { stage: 'QUALIFIED', estimated_value: 353_900 });
    lead(ctx, hz, { stage: 'APPOINTMENT', estimated_value: 389_900 });
    lead(ctx, hz, { stage: 'APPOINTMENT', estimated_value: 100_000 });
    lead(ctx, hz, { stage: 'NEGOTIATING', estimated_value: 0 });
    lead(ctx, hz, { stage: 'CANDIDATE', estimated_value: 500_000 });
    lead(ctx, hz, { stage: 'WON', estimated_value: 459_900 });
    lead(ctx, hz, { stage: 'LOST', estimated_value: 459_900 });
    lead(ctx, hz, { stage: 'NEGOTIATING', estimated_value: 529_900, suppressed: true });
    lead(ctx, sh, { stage: 'APPOINTMENT', estimated_value: 1_000_000 });

    const d = getDashboard(ctx, { dealer_id: hz });
    const byStage = Object.fromEntries(d.pipeline.by_stage.map((s) => [s.stage, [s.count, s.value]]));
    assert.deepEqual(byStage.QUALIFIED, [1, 7_078]); // 353900 × 0.02
    assert.deepEqual(byStage.APPOINTMENT, [2, 195_960]); // (389900 + 100000) × 0.4
    assert.deepEqual(byStage.NEGOTIATING, [1, 0]);
    assert.deepEqual(byStage.ASSIGNED, [0, 0]);
    assert.equal(d.pipeline.estimated_value, 203_038);
    assert.equal(d.pipeline.estimated_value, d.pipeline.by_stage.reduce((s, x) => s + x.value, 0));
    assert.ok(d.briefing.includes('预计管道价值 20.3万'));
    assert.equal(getDashboard(ctx).pipeline.estimated_value, 603_038);
    assert.equal(getDashboard(ctx, { dealer_id: hz, stage: 'APPOINTMENT' }).pipeline.estimated_value, 195_960);
  });

  it('applies account / brand / model / location / source / stage filters to lead metrics', () => {
    const { ctx, hz, acc } = setup();
    const wang = acc('xhs-hz-sales-wang');
    const li = acc('xhs-hz-sales-li');
    const F1 = lead(ctx, hz, { intent: { brand: 'BMW', model: 'i3', location: '杭州', province: '浙江' } });
    seedAssignment(ctx, { lead_id: F1.id, account_id: wang });
    signal(ctx, F1.id, 'comment', '杭州i3有现车吗');
    const F2 = lead(ctx, hz, { stage: 'ASSIGNED', intent: { model: 'X3', province: '浙江' } });
    seedAssignment(ctx, { lead_id: F2.id, account_id: li });
    signal(ctx, F2.id, 'post', 'X3落地价求分享');
    const F3 = lead(ctx, hz, { intent: { model: 'i3', location: '上海', province: '上海' } });
    signal(ctx, F3.id, 'comment', '上海i3优惠多少');
    const F4 = lead(ctx, hz, { intent: { model: '3 Series', location: '宁波' } });
    seedAssignment(ctx, { lead_id: F4.id, account_id: wang, active: false, released_at: MID_TODAY });
    signal(ctx, F4.id, 'comment', '宁波325Li落地多少');
    for (const l of [F1, F2, F3, F4]) transition(ctx, l.id, 'DISCOVERED', 'QUALIFIED', MID_TODAY);

    const qualified = (f: Parameters<typeof getDashboard>[1]) => getDashboard(ctx, { dealer_id: hz, ...f }).discovery.qualified;
    assert.equal(qualified({}), 4);
    assert.equal(qualified({ account_id: wang }), 1, 'only the ACTIVE assignment counts');
    assert.equal(qualified({ account_id: li }), 1);
    assert.equal(qualified({ brand: '宝马' }), 1);
    assert.equal(qualified({ model: 'i3' }), 2);
    assert.equal(qualified({ model: 'I3' }), 2);
    assert.equal(qualified({ model: '3系' }), 1);
    assert.equal(qualified({ location: '杭州' }), 1);
    assert.equal(qualified({ location: '杭州市' }), 1);
    assert.equal(qualified({ location: '浙江' }), 3, 'province, or a city of the province');
    assert.equal(qualified({ location: '浙江省' }), 3);
    assert.equal(qualified({ location: '上海' }), 1);
    assert.equal(qualified({ source_type: 'post' }), 1);
    assert.equal(qualified({ source_type: 'comment' }), 3);
    assert.equal(qualified({ source_type: 'reply' }), 0);
    assert.equal(qualified({ stage: 'QUALIFIED' }), 3);
    assert.equal(qualified({ stage: 'ASSIGNED' }), 1);
    assert.equal(qualified({ model: 'i3', location: '浙江' }), 1);
  });

  it('lists every exception queue with counts, severity order and console links', () => {
    const { ctx, hz, sh, acc } = setup();
    const wang = acc('xhs-hz-sales-wang');
    const i3acc = acc('xhs-hz-i3');
    const now = Date.parse(TEST_NOW);
    const hoursFromNow = (h: number) => new Date(now + h * 3_600_000).toISOString();

    const withOutreach = (status: 'READY_FOR_REVIEW' | 'APPROVED' | 'BLOCKED') => {
      const l = lead(ctx, hz);
      const a = seedAssignment(ctx, { lead_id: l.id, account_id: wang });
      return { lead: l, outreach: seedOutreach(ctx, { lead_id: l.id, account_id: wang, assignment_id: a.id, status }) };
    };
    const X1 = withOutreach('READY_FOR_REVIEW');
    const conv1 = seedInboundReply(ctx, { lead_id: X1.lead.id, account_id: wang, at: PREV_DAY }).conversation;
    ctx.db.table('conversations').update(conv1.id, { needs_human: true, handoff_reason: '客户询问贷款细节' });
    message(ctx, conv1, 'outbound', 'draft', PREV_DAY);
    for (const [status, h] of [['proposed', 24], ['proposed', 72], ['confirmed', 10], ['proposed', -1]] as const) {
      const appt = seedAppointment(ctx, { lead_id: X1.lead.id, dealer_id: hz, account_id: wang, status });
      ctx.db.table('appointments').update(appt.id, { scheduled_for: hoursFromNow(h) });
    }
    seedAppointment(ctx, { lead_id: X1.lead.id, dealer_id: hz, account_id: wang, status: 'proposed' }); // time unresolved

    const X2 = withOutreach('APPROVED'); // capability UNAVAILABLE → a human must send it
    const conv2 = seedInboundReply(ctx, { lead_id: X2.lead.id, account_id: wang, at: PREV_DAY }).conversation;
    ctx.db.table('conversations').update(conv2.id, { status: 'closed', needs_human: true });
    message(ctx, conv2, 'outbound', 'draft', PREV_DAY);
    const X3 = withOutreach('APPROVED');
    ctx.db.table('outreach').update(X3.outreach.id, { capability_status: 'AVAILABLE' });
    const X4 = withOutreach('BLOCKED');
    ctx.db.table('outreach').update(X4.outreach.id, { updated_at: new Date(now - 2 * 86_400_000).toISOString() });
    const X5 = withOutreach('BLOCKED');
    ctx.db.table('outreach').update(X5.outreach.id, { updated_at: new Date(now - 8 * 86_400_000).toISOString() });

    lead(ctx, hz); // X6: QUALIFIED without owner
    lead(ctx, hz, { suppressed: true });
    lead(ctx, hz, { stage: 'WON' });
    lead(ctx, hz, { stage: 'CANDIDATE', tier: 'candidate' });
    lead(ctx, hz, { stage: 'LOST' });
    lead(ctx, sh); // other dealer

    post(ctx, { dealer_id: hz, account_id: acc('xhs-hz-official'), status: 'IN_REVIEW', slot_date: '2026-09-14' });
    const ownPost = post(ctx, { dealer_id: hz, account_id: i3acc, status: 'PUBLISHED', slot_date: '2026-09-10', published_at: '2026-09-10T02:00:00.000Z' });
    const pp = ctx.db.table('public_posts').insert({
      id: newId('ppost'),
      platform: 'xiaohongshu',
      platform_post_id: 'note-own-dash-001',
      xsec_token: null,
      url: null,
      title: '宝马i3一周通勤体验',
      content: '',
      author_platform_user_id: 'xhs-hz-i3',
      author_nickname: 'i3电车研究所',
      author_profile_url: null,
      ip_location: '浙江',
      tags: [],
      like_count: 0,
      comment_count: 1,
      collect_count: 0,
      published_at: '2026-09-10T02:00:00.000Z',
      own_post_id: ownPost.id,
      first_search_run_id: null,
      fetched_at: TEST_NOW,
      raw: {},
    });
    const pc = ctx.db.table('public_comments').insert({
      id: newId('pcmt'),
      platform: 'xiaohongshu',
      platform_comment_id: 'c-dash-001',
      public_post_id: pp.id,
      parent_comment_id: null,
      author_platform_user_id: 'u-commenter-001',
      author_nickname: '路人甲',
      content: '续航实际多少',
      ip_location: '浙江',
      like_count: 0,
      published_at: TEST_NOW,
      prefilter_passed: true,
      prefilter_reason: 'keyword_hit',
      first_search_run_id: null,
      fetched_at: TEST_NOW,
      raw: {},
    });
    ctx.db.table('engagement_replies').insert({
      id: newId('eng'),
      dealer_id: hz,
      account_id: i3acc,
      post_id: ownPost.id,
      public_comment_id: pc.id,
      message: '您好，i3 eDrive35L的续航表现可以私信了解',
      fact_refs: [],
      guard_results: [],
      status: 'READY_FOR_REVIEW',
      capability_status: 'UNAVAILABLE',
      provider_message_id: null,
      created_at: TEST_NOW,
      updated_at: TEST_NOW,
    });

    workflowRun(ctx, hz, 'FAILED', MID_TODAY, MID_TODAY);
    workflowRun(ctx, hz, 'FAILED', PREV_DAY, MID_TODAY); // interrupted yesterday, failed today
    workflowRun(ctx, hz, 'FAILED', '2026-09-11T02:00:00.000Z', PREV_DAY);
    workflowRun(ctx, hz, 'SUCCEEDED', MID_TODAY, MID_TODAY);
    workflowRun(ctx, sh, 'FAILED', MID_TODAY, MID_TODAY);

    const fleet = computeFleetHealth(ctx, hz);
    const risky = fleet.find((h) => h.account_id === wang);
    assert.ok(risky);
    ctx.db.table('account_health').update(risky.id, {
      state: 'AT_RISK',
      health_score: 40,
      issues: ['近7天有3位被联系用户明确拒绝联系，需暂停主动触达并复盘话术'],
    });

    const d = getDashboard(ctx, { dealer_id: hz });
    assert.deepEqual(
      d.exceptions.map((e) => [e.kind, e.count, e.severity]),
      [
        ['conversations_needs_human', 1, 'high'],
        ['outreach_review', 1, 'high'],
        ['appointments_unconfirmed', 1, 'high'],
        ['accounts_attention', 1, 'high'],
        ['workflow_failed', 2, 'high'],
        ['outreach_manual_send', 1, 'medium'],
        ['posts_in_review', 1, 'medium'],
        ['reply_drafts', 1, 'medium'],
        ['engagement_replies_review', 1, 'medium'],
        ['qualified_unassigned', 1, 'medium'],
        ['outreach_blocked', 1, 'low'],
      ],
    );
    assert.deepEqual(new Set(d.exceptions.map((e) => e.kind)), new Set(EXCEPTION_KINDS));
    const dealerParam = `dealer_id=${encodeURIComponent(hz)}`;
    for (const e of d.exceptions) {
      assert.ok(e.href.startsWith('/') && e.href.includes(dealerParam), e.href);
      assert.ok(e.title.length > 0);
    }
    assert.equal(d.exceptions.find((e) => e.kind === 'outreach_review')?.href, `/leads?outreach_status=READY_FOR_REVIEW&${dealerParam}`);
    assert.equal(d.outreach.outreach_ready, 3);

    // a closed lead's drafts are not work: closing it removes them from the queues
    const reviewLead = ctx.db.table('outreach').findOne({ status: 'READY_FOR_REVIEW' })?.lead_id;
    assert.ok(reviewLead);
    transitionLead(ctx, reviewLead, 'LOST', { reason: 'llm_screen', actor: 'test' });
    const after = getDashboard(ctx, { dealer_id: hz });
    assert.equal(after.exceptions.find((e) => e.kind === 'outreach_review'), undefined);
    assert.equal(after.outreach.outreach_ready, 2);
    assert.deepEqual([d.accounts.active, d.accounts.healthy], [6, 5]);
    assert.deepEqual(d.accounts.requiring_attention, [
      { account_id: wang, nickname: '销售小王·杭州宝马', state: 'AT_RISK', issues: ['近7天有3位被联系用户明确拒绝联系，需暂停主动触达并复盘话术'] },
    ]);
    for (const line of [
      '1 篇内容待审批',
      '1 条私信待你审核',
      '1 条已审核私信待你在小红书发送',
      '1 条回复需要人工处理',
      '1 条回复草稿待审核',
      '1 条评论回复待审核',
      '1 个48小时内的到店预约尚未确认',
      '1 条合格线索尚未分配账号',
      '1 个账号需要关注',
      '2 个自动任务今日运行失败',
      '近7天有 1 条私信被发送前检查拦截',
    ])
      assert.ok(d.briefing.includes(line), `briefing lacks ${line}: ${d.briefing.join(' | ')}`);
    assert.ok(!d.briefing.some((l) => l.includes('成交') || l.includes('触达')), 'zero facts are omitted');

    const all = getDashboard(ctx);
    const counts = Object.fromEntries(all.exceptions.map((e) => [e.kind, e.count]));
    assert.equal(counts.workflow_failed, 3);
    assert.equal(counts.qualified_unassigned, 2);
    assert.equal(counts.accounts_attention, 3, 'AT_RISK wang + two Shanghai accounts never evaluated');
    assert.equal(all.accounts.requiring_attention[0].state, 'AT_RISK');
    assert.ok(all.exceptions.every((e) => !e.href.includes('dealer_id=')));
  });

  it('builds the AI-employee briefing only from the numbers', () => {
    const { ctx, hz, acc } = setup();
    const official = acc('xhs-hz-official');
    const wang = acc('xhs-hz-sales-wang');
    for (let i = 0; i < 6; i++) post(ctx, { dealer_id: hz, account_id: official, status: i % 2 ? 'PLANNED' : 'DRAFTED', slot_date: '2026-09-12' });
    post(ctx, { dealer_id: hz, account_id: official, status: 'IN_REVIEW', slot_date: '2026-09-12' });
    searchRun(ctx, hz, MID_TODAY, { posts: 28, comments: 400, users: 120 }, { text: '杭州宝马i3', model: 'i3' });
    for (let i = 0; i < 34; i++) {
      const l = lead(ctx, hz, i < 11 ? { tier: 'high_intent', score: 86 } : {});
      transition(ctx, l.id, 'DISCOVERED', 'QUALIFIED', MID_TODAY);
      const a = seedAssignment(ctx, { lead_id: l.id, account_id: wang });
      if (i < 8) seedOutreach(ctx, { lead_id: l.id, account_id: wang, assignment_id: a.id, status: 'READY_FOR_REVIEW' });
      else if (i < 13) {
        const conv = seedInboundReply(ctx, { lead_id: l.id, account_id: wang, at: PREV_DAY }).conversation;
        ctx.db.table('conversations').update(conv.id, { needs_human: true, handoff_reason: '需要人工报价' });
      }
    }
    for (let i = 0; i < 3; i++) {
      const l = lead(ctx, hz, { stage: 'APPOINTMENT' });
      seedAssignment(ctx, { lead_id: l.id, account_id: wang });
      transition(ctx, l.id, 'CONTACT_ACQUIRED', 'APPOINTMENT', MID_TODAY);
    }
    computeFleetHealth(ctx, hz);

    const d = getDashboard(ctx, { dealer_id: hz });
    assert.deepEqual(d.briefing, [
      '今日计划 7 篇内容，1 篇待审批',
      '分析了 428 条公开信号，评估了 120 位用户',
      '发现 34 条合格线索，其中 11 条高意向',
      '8 条私信待你审核',
      '5 条回复需要人工处理',
      '新增 3 个到店预约',
    ]);
  });

  it('buildBriefing uses 本期 for custom periods and handles partial facts', () => {
    const base = getDashboard(createTestContext());
    const { briefing: _ignored, ...metrics } = base;
    const custom = structuredClone(metrics);
    custom.period.is_today = false;
    custom.content.posts_planned = 3;
    custom.discovery.comments_scanned = 10;
    custom.discovery.candidates = 4;
    custom.outreach = { outreach_ready: 0, contacted: 3, replies: 3, reply_rate: 0.6667 };
    assert.deepEqual(buildBriefing(custom, zeroCounts()), [
      '本期计划 3 篇内容',
      '本期分析了 10 条公开信号',
      '发现 4 条候选线索，暂无合格线索',
      '本期触达 3 位潜在客户，收到 3 条回复（回复率 66.7%）',
    ]);
    const pendingOnly = structuredClone(metrics);
    pendingOnly.content.posts_pending_approval = 2;
    assert.deepEqual(buildBriefing(pendingOnly, zeroCounts()), ['2 篇内容待审批']);
    const quiet = structuredClone(metrics);
    quiet.period.is_today = false;
    assert.deepEqual(buildBriefing(quiet, zeroCounts()), ['本期暂无新的运营进展']);
  });
});

describe('analytics skill: dashboard', () => {
  it('returns {kind, result} and records the briefing as an audited report decision', async () => {
    const registry = new SkillRegistry().register(skill);
    const ctx = createTestContext({ skills: registry });
    const s = loadDealerFixture(ctx);
    const hz = dealerIdByKey(s, 'hz-bmw');
    const out = await registry.invoke<{ kind: string; result: DashboardMetrics }>(ctx, 'analytics', { kind: 'dashboard', filters: { dealer_id: hz } });
    assert.equal(out.kind, 'dashboard');
    assert.deepEqual(out.result, getDashboard(ctx, { dealer_id: hz }));
    const decisions = ctx.db.table('agent_decisions').findMany({ decision_type: 'report' });
    assert.equal(decisions.length, 1);
    const dec = decisions[0];
    assert.equal(dec.agent, 'analytics-agent');
    assert.equal(dec.skill, 'analytics');
    assert.deepEqual([dec.subject_type, dec.subject_id], ['dealer', hz]);
    assert.deepEqual(dec.output.briefing, out.result.briefing);
    assert.deepEqual(dec.evidence, [{ code: 'exception:accounts_attention', label: '账号需要关注（6）' }]);

    await registry.invoke(ctx, 'analytics', { kind: 'dashboard' });
    assert.equal(ctx.db.table('agent_decisions').findOne({ subject_type: 'fleet' })?.subject_id, 'all');
  });
});
