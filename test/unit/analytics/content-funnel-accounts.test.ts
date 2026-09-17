import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppContext } from '../../../src/app/context.ts';
import { NotFoundError, ValidationError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import { LEAD_STAGES, type Lead, type LeadStage, type Post, type PostMetrics, type PublicComment, type PublicPost } from '../../../src/core/types.ts';
import { getAccountPerformance, listFleet } from '../../../src/skills/operations/account-brain/index.ts';
import { computeAccountHealth } from '../../../src/skills/operations/account-health/index.ts';
import {
  getAccountsOverview,
  getContentAttribution,
  getFunnel,
  getLeadInbox,
  skill,
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
  seedPublishedPost,
} from '../../helpers/fixtures.ts';

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

function post(
  ctx: AppContext,
  input: { dealer_id: string; account_id: string; status?: Post['status']; published_at?: string | null; model?: string | null; title: string; metrics?: Partial<PostMetrics> },
): Post {
  return ctx.db.table('posts').insert({
    id: newId('post'),
    dealer_id: input.dealer_id,
    account_id: input.account_id,
    plan_id: null,
    slot_date: (input.published_at ?? TEST_NOW).slice(0, 10),
    pillar: 'model_review',
    topic: `test:${newId('t')}`,
    angle: '',
    model: input.model ?? null,
    title: input.title,
    body: '正文',
    tags: [],
    cover_text: '',
    fact_refs: [],
    status: input.status ?? 'PUBLISHED',
    review: null,
    approval_policy: 'REVIEW_REQUIRED',
    platform_note_id: null,
    scheduled_for: null,
    published_at: input.published_at ?? null,
    metrics: { views: 0, likes: 0, collects: 0, comments: 0, shares: 0, ...input.metrics },
    metrics_updated_at: null,
    engine: 'rules',
    created_at: TEST_NOW,
    updated_at: TEST_NOW,
  });
}

function ownPublicPost(ctx: AppContext, own: Post, platformPostId: string): PublicPost {
  return ctx.db.table('public_posts').insert({
    id: newId('ppost'),
    platform: 'xiaohongshu',
    platform_post_id: platformPostId,
    xsec_token: null,
    url: null,
    title: own.title,
    content: own.body,
    author_platform_user_id: null,
    author_nickname: null,
    author_profile_url: null,
    ip_location: '浙江',
    tags: [],
    like_count: 0,
    comment_count: 0,
    collect_count: 0,
    published_at: own.published_at,
    own_post_id: own.id,
    first_search_run_id: null,
    fetched_at: TEST_NOW,
    raw: {},
  });
}

let commentSeq = 0;
function comment(ctx: AppContext, pp: PublicPost, author: string, content: string): PublicComment {
  return ctx.db.table('public_comments').insert({
    id: newId('pcmt'),
    platform: 'xiaohongshu',
    platform_comment_id: `c-attr-${++commentSeq}`,
    public_post_id: pp.id,
    parent_comment_id: null,
    author_platform_user_id: author,
    author_nickname: author,
    content,
    ip_location: '浙江',
    like_count: 0,
    published_at: TEST_NOW,
    prefilter_passed: true,
    prefilter_reason: 'keyword_hit',
    first_search_run_id: null,
    fetched_at: TEST_NOW,
    raw: {},
  });
}

function commentSignal(ctx: AppContext, leadId: string, c: PublicComment, at: string, withPostId: boolean): void {
  ctx.db.table('lead_signals').insert({
    id: newId('sig'),
    lead_id: leadId,
    source_type: 'comment',
    public_post_id: withPostId ? c.public_post_id : null,
    public_comment_id: c.id,
    post_title: null,
    content: c.content,
    signal_at: at,
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
    created_at: TEST_NOW,
  });
}

function conversion(ctx: AppContext, lead: Lead, outcome: 'won' | 'lost', amount: number | null, attributedPostId: string | null): void {
  ctx.db.table('conversions').insert({
    id: newId('cvn'),
    lead_id: lead.id,
    dealer_id: lead.dealer_id,
    outcome,
    vehicle_id: null,
    amount,
    lost_reason: outcome === 'lost' ? '价格' : null,
    attributed_post_id: attributedPostId,
    attributed_query_id: null,
    account_id: null,
    occurred_at: TEST_NOW,
  });
}

function transition(ctx: AppContext, leadId: string, from: LeadStage | null, to: LeadStage): void {
  ctx.db.table('lead_stage_transitions').insert({ id: newId('trn'), lead_id: leadId, from_stage: from, to_stage: to, reason: 'test', actor: 'test', at: TEST_NOW });
}

describe('analytics: content attribution', () => {
  function attributionSetup() {
    const base = setup();
    const { ctx, hz, sh, acc } = base;
    const i3acc = acc('xhs-hz-i3');
    const official = acc('xhs-hz-official');
    const wang = acc('xhs-hz-sales-wang');
    const leads = ctx.db.table('leads');

    const A = post(ctx, { dealer_id: hz, account_id: i3acc, published_at: '2026-09-05T02:00:00.000Z', model: 'i3', title: '宝马i3一周通勤体验', metrics: { views: 100, likes: 10 } });
    const B = post(ctx, {
      dealer_id: hz,
      account_id: official,
      published_at: '2026-09-06T02:00:00.000Z',
      model: 'X3',
      title: '杭州宝马中心周末活动',
      metrics: { views: 5000, likes: 60, collects: 20, comments: 15, shares: 5 },
    });
    const C = post(ctx, { dealer_id: hz, account_id: wang, published_at: '2026-09-07T02:00:00.000Z', model: '3 Series', title: '325Li提车指南', metrics: { likes: 50 } });
    post(ctx, { dealer_id: hz, account_id: wang, status: 'DRAFTED', title: '草稿' });
    const E = post(ctx, { dealer_id: sh, account_id: acc('xhs-sh-official'), published_at: '2026-09-07T02:00:00.000Z', model: 'X3', title: '上海门店开放日', metrics: { likes: 999 } });

    const ppA = ownPublicPost(ctx, A, 'note-own-hz-i3-001');
    const ppB = ownPublicPost(ctx, B, 'note-own-hz-official-001');
    ownPublicPost(ctx, C, 'note-own-hz-wang-001');

    const cA1 = comment(ctx, ppA, 'u-a-1', '35L有现车吗');
    const cA2 = comment(ctx, ppA, 'u-a-2', '杭州落地多少');
    comment(ctx, ppA, 'xhs-hz-i3', '已私信您，欢迎到店'); // our own account replying
    comment(ctx, ppA, 'u-a-1', '白色的呢');
    for (let i = 1; i <= 5; i++) comment(ctx, ppB, `u-b-${i}`, '活动几点开始');
    const cB6 = comment(ctx, ppB, 'u-a-2', '活动有i3试驾吗');

    // LA1 — explicitly attributed to A, won with an amount
    let LA1 = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-a-1', stage: 'WON' });
    LA1 = leads.update(LA1.id, { attributed_post_id: A.id });
    commentSignal(ctx, LA1.id, cA1, '2026-09-05T08:00:00.000Z', true);
    conversion(ctx, LA1, 'won', 353_900, A.id);

    // LA2 — no explicit attribution; first touch is A (comment signal without public_post_id), later B
    const LA2 = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-a-2', stage: 'APPOINTMENT' });
    commentSignal(ctx, LA2.id, cA2, '2026-09-06T00:00:00.000Z', false);
    commentSignal(ctx, LA2.id, cB6, '2026-09-08T00:00:00.000Z', true);
    seedAppointment(ctx, { lead_id: LA2.id, dealer_id: hz, account_id: i3acc, status: 'proposed' });
    seedAppointment(ctx, { lead_id: LA2.id, dealer_id: hz, account_id: i3acc, status: 'cancelled' });
    seedInboundReply(ctx, { lead_id: LA2.id, account_id: i3acc });

    // LC1 — attributed to C, qualified then lost
    let LC1 = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-c-1', stage: 'LOST' });
    LC1 = leads.update(LC1.id, { attributed_post_id: C.id });
    transition(ctx, LC1.id, 'DISCOVERED', 'QUALIFIED');
    transition(ctx, LC1.id, 'QUALIFIED', 'LOST');
    conversion(ctx, LC1, 'lost', 300_000, C.id);

    return { ...base, i3acc, official, wang, A, B, C, E };
  }

  it('ranks the post that sold a car above a post with 10× engagement and no leads', () => {
    const { ctx, hz, A, B, C } = attributionSetup();
    const rows = getContentAttribution(ctx, { dealer_id: hz });
    assert.deepEqual(rows.map((r) => r.post_id), [A.id, C.id, B.id]);
    const byId = new Map(rows.map((r) => [r.post_id, r]));
    const a = byId.get(A.id)!;
    const b = byId.get(B.id)!;
    assert.equal(b.engagement, 10 * a.engagement);
    assert.equal(b.leads, 0);
    assert.ok(rows.indexOf(a) < rows.indexOf(b));

    assert.deepEqual(a, {
      post_id: A.id,
      dealer_id: hz,
      account_id: A.account_id,
      account_nickname: 'i3电车研究所',
      title: '宝马i3一周通勤体验',
      pillar: 'model_review',
      model: 'i3',
      published_at: '2026-09-05T02:00:00.000Z',
      platform_note_id: null,
      views: 100,
      engagement: 10,
      comments_collected: 3, // our own account's reply is not a collected customer comment
      commenter_profiles: 2,
      leads: 2,
      qualified_leads: 2,
      conversations: 1,
      appointments: 1,
      won: 1,
      won_value: 353_900,
    });
    const c = byId.get(C.id)!;
    assert.deepEqual(
      [c.leads, c.qualified_leads, c.conversations, c.appointments, c.won, c.won_value, c.comments_collected, c.engagement],
      [1, 1, 0, 0, 0, 0, 0, 50],
      'a lead that was qualified before being lost still counts as qualified; lost amounts are not sales',
    );
    assert.deepEqual(
      [b.views, b.engagement, b.comments_collected, b.commenter_profiles, b.leads, b.qualified_leads, b.won],
      [5000, 100, 6, 6, 0, 0, 0],
      'LA2 commented on B later but is attributed once, to its first touch',
    );
    assert.equal(rows.reduce((sum, r) => sum + r.leads, 0), 3, 'single-touch attribution never double counts');
  });

  it('filters by dealer, account, model and publish window', () => {
    const { ctx, hz, i3acc, A, B, C, E } = attributionSetup();
    assert.deepEqual(getContentAttribution(ctx).map((r) => r.post_id), [A.id, C.id, E.id, B.id]);
    assert.deepEqual(getContentAttribution(ctx, { account_id: i3acc }).map((r) => r.post_id), [A.id]);
    assert.deepEqual(getContentAttribution(ctx, { dealer_id: hz, model: 'x3' }).map((r) => r.post_id), [B.id]);
    assert.deepEqual(getContentAttribution(ctx, { dealer_id: hz, model: '3系' }).map((r) => r.post_id), [C.id]);
    assert.deepEqual(getContentAttribution(ctx, { dealer_id: hz, from: '2026-09-06', to: '2026-09-06' }).map((r) => r.post_id), [B.id]);
    assert.deepEqual(getContentAttribution(createTestContext()), []);
  });

  it('credits a won conversion to its recorded post and counts WON leads without a conversion row', () => {
    const { ctx, hz, acc } = setup();
    const official = acc('xhs-hz-official');
    const P1 = post(ctx, { dealer_id: hz, account_id: official, published_at: '2026-09-01T02:00:00.000Z', title: 'P1' });
    const P2 = post(ctx, { dealer_id: hz, account_id: official, published_at: '2026-09-02T02:00:00.000Z', title: 'P2', metrics: { likes: 500 } });
    const W1 = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-w-1', stage: 'WON' });
    conversion(ctx, W1, 'won', 300_000, P2.id);
    conversion(ctx, W1, 'lost', 999_999, P2.id);
    let W2 = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-w-2', stage: 'WON' });
    W2 = ctx.db.table('leads').update(W2.id, { attributed_post_id: P1.id });

    const rows = getContentAttribution(ctx, { dealer_id: hz });
    assert.deepEqual(rows.map((r) => [r.post_id, r.leads, r.qualified_leads, r.won, r.won_value]), [
      [P1.id, 1, 1, 1, 0],
      [P2.id, 0, 0, 1, 300_000],
    ]);
    assert.ok(W2.id);
  });
});

describe('analytics: funnel', () => {
  it('counts every stage and computes stage-to-stage conversion without LOST', () => {
    const { ctx, hz, sh } = setup();
    const plan: [LeadStage, number][] = [
      ['DISCOVERED', 2],
      ['CANDIDATE', 3],
      ['QUALIFIED', 2],
      ['ASSIGNED', 1],
      ['CONTACTED', 1],
      ['APPOINTMENT', 1],
      ['WON', 1],
      ['LOST', 4],
    ];
    let seq = 0;
    for (const [stage, count] of plan)
      for (let i = 0; i < count; i++) seedLead(ctx, { dealer_id: hz, platform_user_id: `u-f-${++seq}`, stage, at: '2026-09-01T02:00:00.000Z' });
    seedLead(ctx, { dealer_id: sh, platform_user_id: 'u-f-sh', stage: 'NEGOTIATING' });
    seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-f-today', stage: 'CANDIDATE' });

    const funnel = getFunnel(ctx, { dealer_id: hz });
    assert.deepEqual(funnel.map((f) => f.stage), [...LEAD_STAGES]);
    const table = Object.fromEntries(funnel.map((f) => [f.stage, [f.count, f.reached, f.conversion_from_prev]]));
    assert.deepEqual(table, {
      DISCOVERED: [2, 12, 1],
      CANDIDATE: [4, 10, 0.8333],
      QUALIFIED: [2, 6, 0.6],
      ASSIGNED: [1, 4, 0.6667],
      OUTREACH_READY: [0, 3, 0.75],
      CONTACTED: [1, 3, 1],
      REPLIED: [0, 2, 0.6667],
      SALES_QUALIFIED: [0, 2, 1],
      CONTACT_ACQUIRED: [0, 2, 1],
      APPOINTMENT: [1, 2, 1],
      VISITED: [0, 1, 0.5],
      NEGOTIATING: [0, 1, 1],
      WON: [1, 1, 1],
      LOST: [4, 4, 0],
    });

    const cohort = getFunnel(ctx, { dealer_id: hz, from: '2026-09-12' });
    assert.deepEqual(cohort.filter((f) => f.count > 0).map((f) => [f.stage, f.count]), [['CANDIDATE', 1]], 'from/to bound first_seen_at');
    assert.equal(cohort.find((f) => f.stage === 'QUALIFIED')?.conversion_from_prev, 0);
    assert.equal(getFunnel(ctx).find((f) => f.stage === 'NEGOTIATING')?.count, 1);
  });

  it('returns 14 zero rows on an empty database', () => {
    const funnel = getFunnel(createTestContext());
    assert.equal(funnel.length, LEAD_STAGES.length);
    assert.ok(funnel.every((f) => f.count === 0 && f.reached === 0 && f.conversion_from_prev === 0 && Number.isFinite(f.conversion_from_prev)));
  });
});

describe('analytics: accounts overview', () => {
  it('reports persona, latest health and real performance per account', () => {
    const { ctx, hz, sh, acc } = setup();
    const wang = acc('xhs-hz-sales-wang');
    const l = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-acc-1', stage: 'CONTACTED' });
    const asg = seedAssignment(ctx, { lead_id: l.id, account_id: wang });
    seedOutreach(ctx, { lead_id: l.id, account_id: wang, assignment_id: asg.id, status: 'SENT', sent_at: '2026-09-10T02:00:00.000Z' });
    seedInboundReply(ctx, { lead_id: l.id, account_id: wang, at: '2026-09-11T02:00:00.000Z' });
    seedPublishedPost(ctx, { dealer_id: hz, account_id: wang, published_at: '2026-09-09T02:00:00.000Z', likes: 3 });
    seedAppointment(ctx, { lead_id: l.id, dealer_id: hz, account_id: wang });

    const rows = getAccountsOverview(ctx, hz);
    assert.deepEqual(rows.map((r) => r.account_id), listFleet(ctx, { dealer_id: hz }).map((b) => b.account.id));
    const row = rows.find((r) => r.account_id === wang)!;
    const persona = ctx.db.table('account_personas').findOne({ account_id: wang })!;
    const perf = getAccountPerformance(ctx, wang);
    assert.deepEqual(row, {
      account_id: wang,
      dealer_id: hz,
      nickname: '销售小王·杭州宝马',
      account_type: 'salesperson',
      status: 'active',
      auth_state: 'authenticated',
      persona_name: persona.persona_name,
      focus_models: ['i3', '3 Series'],
      health_state: null,
      health_score: null,
      health_issues: ['尚未计算健康度'],
      health_date: null,
      active_leads: perf.leads_owned_active,
      outreach_sent_30d: perf.outreach_sent_30d,
      reply_rate_30d: perf.reply_rate_30d,
      appointments_90d: perf.appointments_90d,
      won_90d: perf.won_90d,
      posts_published_30d: perf.posts_published_30d,
    });
    assert.deepEqual([row.active_leads, row.outreach_sent_30d, row.reply_rate_30d, row.appointments_90d, row.posts_published_30d], [1, 1, 1, 1, 1]);

    const health = computeAccountHealth(ctx, wang);
    const after = getAccountsOverview(ctx, hz).find((r) => r.account_id === wang)!;
    assert.deepEqual([after.health_state, after.health_score, after.health_issues, after.health_date], [health.state, health.health_score, health.issues, health.date]);

    assert.equal(getAccountsOverview(ctx).length, 8);
    const zhao = getAccountsOverview(ctx, sh).find((r) => r.nickname === '赵哥说车·上海宝马')!;
    assert.equal(zhao.auth_state, 'requires_auth');
  });

  it('is read-only (never creates personas) and validates the dealer', () => {
    const { ctx, hz, acc } = setup();
    const li = acc('xhs-hz-sales-li');
    const persona = ctx.db.table('account_personas').findOne({ account_id: li })!;
    ctx.db.table('account_personas').delete(persona.id);
    const personas = ctx.db.table('account_personas').count();
    const row = getAccountsOverview(ctx, hz).find((r) => r.account_id === li)!;
    assert.deepEqual([row.persona_name, row.nickname, row.focus_models], [null, '李姐聊宝马', []], 'no persona is invented from the nickname');
    assert.equal(ctx.db.table('account_personas').count(), personas);
    assert.equal(getAccountsOverview(ctx, '').length, 8, 'empty dealer id means every dealer');
    assert.throws(() => getAccountsOverview(ctx, 'dlr_missing'), NotFoundError);
    assert.throws(() => getAccountsOverview(ctx, 7 as never), ValidationError);
    assert.deepEqual(getAccountsOverview(createTestContext()), []);
  });
});

describe('analytics skill', () => {
  it('serves every kind through the registry and validates input', async () => {
    const registry = new SkillRegistry().register(skill);
    const ctx = createTestContext({ skills: registry });
    const s = loadDealerFixture(ctx);
    const hz = dealerIdByKey(s, 'hz-bmw');
    const lead = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-skill-1' });

    const inbox = await registry.invoke<{ kind: string; result: unknown[] }>(ctx, 'analytics', { kind: 'inbox', filters: { dealer_id: hz, limit: 10 } });
    assert.equal(inbox.kind, 'inbox');
    assert.deepEqual(inbox.result, getLeadInbox(ctx, { dealer_id: hz, limit: 10 }));
    const funnel = await registry.invoke<{ kind: string; result: unknown[] }>(ctx, 'analytics', { kind: 'funnel', filters: { dealer_id: hz } });
    assert.deepEqual([funnel.kind, funnel.result.length], ['funnel', LEAD_STAGES.length]);
    const attribution = await registry.invoke<{ kind: string; result: unknown[] }>(ctx, 'analytics', { kind: 'attribution' });
    assert.deepEqual([attribution.kind, attribution.result], ['attribution', []]);
    const accounts = await registry.invoke<{ kind: string; result: unknown[] }>(ctx, 'analytics', { kind: 'accounts', filters: { dealer_id: hz } });
    assert.deepEqual([accounts.kind, accounts.result.length], ['accounts', 6]);
    const detail = await registry.invoke<{ kind: string; result: { lead: Lead } }>(ctx, 'analytics', { kind: 'lead_detail', lead_id: lead.id });
    assert.deepEqual([detail.kind, detail.result.lead.id], ['lead_detail', lead.id]);
    assert.equal(ctx.db.table('agent_decisions').count(), 0, 'only dashboard runs record a decision');

    for (const bad of [
      null,
      {},
      { kind: 'report' },
      { kind: 'lead_detail' },
      { kind: 'inbox', filters: { stage: 'HOT' } },
      { kind: 'inbox', filters: { limit: 0 } },
      { kind: 'inbox', filters: 'dealer' },
    ]) {
      await assert.rejects(registry.invoke(ctx, 'analytics', bad), ValidationError, JSON.stringify(bad));
    }
    await assert.rejects(registry.invoke(ctx, 'analytics', { kind: 'dashboard', filters: { dealer_id: 'dlr_missing' } }), NotFoundError);
  });
});
