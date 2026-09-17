import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import type { Lead, LeadAssignment, Outreach, XhsAccount } from '../../../src/core/types.ts';
import {
  SUPPRESSION_NEXT_ACTION,
  isSuppressed,
  skill as crmSkill,
  suppressContact,
  type SuppressContactResult,
} from '../../../src/skills/operations/crm/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';

const NEGATIVE_USER = 'u-negative-001';

function seedDealer(ctx: TestContext, groupName: string, city = '杭州') {
  const now = ctx.clock.iso();
  const group = ctx.db.table('dealer_groups').insert({ id: newId('grp'), name: groupName, created_at: now });
  const dealer = ctx.db.table('dealers').insert({
    id: newId('dlr'),
    group_id: group.id,
    name: `${city}宝马中心`,
    brands: ['BMW'],
    city,
    province: city === '上海' ? '上海' : '浙江',
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
  const account = ctx.db.table('xhs_accounts').insert({
    id: newId('acc'),
    group_id: group.id,
    dealer_id: dealer.id,
    platform_account_id: null,
    nickname: `销售·${groupName}`,
    account_type: 'salesperson',
    status: 'active',
    auth_state: 'authenticated',
    city,
    salesperson_name: null,
    outreach_approval_policy: null,
    daily_outreach_limit: null,
    daily_publish_limit: null,
    created_at: now,
    updated_at: now,
  });
  return { group, dealer, account };
}

function insertLead(ctx: TestContext, d: { dealer: { id: string; group_id: string } }, platformUserId: string, patch: Partial<Lead> = {}): Lead {
  const now = ctx.clock.iso();
  return ctx.db.table('leads').insert({
    id: newId('lead'),
    group_id: d.dealer.group_id,
    dealer_id: d.dealer.id,
    platform: 'xiaohongshu',
    platform_user_id: platformUserId,
    username: '用户',
    profile_url: null,
    stage: 'CANDIDATE',
    score: 70,
    tier: 'qualified',
    intent: {},
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

function assign(ctx: TestContext, lead: Lead, account: XhsAccount): LeadAssignment {
  return ctx.db.table('lead_assignments').insert({
    id: newId('asg'),
    lead_id: lead.id,
    account_id: account.id,
    active: true,
    reason: 'best match',
    candidates: [],
    assigned_by: 'agent:fleet-controller',
    assigned_at: ctx.clock.iso(),
    released_at: null,
    released_reason: null,
  });
}

function addOutreach(ctx: TestContext, asg: LeadAssignment, patch: Partial<Outreach>): Outreach {
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

/** Two groups share the same XHS user; a third group already sold them a car; another user is a bystander. */
function seedScenario(ctx: TestContext) {
  const now = ctx.clock.iso();
  const zj = seedDealer(ctx, '浙沪宝马经销商集团', '杭州');
  const sh = seedDealer(ctx, '上海宝马集团', '上海');
  const js = seedDealer(ctx, '江苏宝马集团', '南京');

  const leadA = insertLead(ctx, zj, NEGATIVE_USER, { stage: 'CONTACTED' });
  const asgA = assign(ctx, leadA, zj.account);
  const sentA = addOutreach(ctx, asgA, { status: 'SENT', provider_message_id: 'pm-1', sent_at: now });
  const reviewA = addOutreach(ctx, asgA, { kind: 'follow_up', status: 'READY_FOR_REVIEW' });
  const draftA = addOutreach(ctx, asgA, { kind: 'follow_up', status: 'DRAFT' });
  const blockedA = addOutreach(ctx, asgA, { kind: 'follow_up', status: 'BLOCKED', blocked_reason: 'rate_limit' });

  const convA = ctx.db.table('conversations').insert({
    id: newId('conv'),
    lead_id: leadA.id,
    account_id: zj.account.id,
    status: 'open',
    slots: {},
    ai_turns: 2,
    needs_human: true,
    handoff_reason: '客户情绪负面',
    last_message_at: now,
    created_at: now,
    updated_at: now,
  });
  const message = (direction: 'inbound' | 'outbound', status: 'received' | 'draft' | 'sent', content: string) =>
    ctx.db.table('conversation_messages').insert({
      id: newId('msg'),
      conversation_id: convA.id,
      direction,
      content,
      intents: [],
      extracted: {},
      status,
      fact_refs: [],
      provider_message_id: null,
      engine: 'rules',
      created_at: now,
    });
  const inbound = message('inbound', 'received', '不需要，别再发了');
  const draftReply = message('outbound', 'draft', '好的，打扰了，那我再给你介绍一下优惠');

  const leadB = insertLead(ctx, sh, NEGATIVE_USER, { stage: 'OUTREACH_READY' });
  const asgB = assign(ctx, leadB, sh.account);
  const approvedB = addOutreach(ctx, asgB, { status: 'APPROVED', approved_by: 'operator:赵', approved_at: now });

  const wonLead = insertLead(ctx, js, NEGATIVE_USER, { stage: 'WON', next_action: '已成交' });

  const bystander = insertLead(ctx, zj, 'u-hz-buyer-001', { stage: 'OUTREACH_READY' });
  const bystanderOutreach = addOutreach(ctx, assign(ctx, bystander, zj.account), { status: 'READY_FOR_REVIEW' });

  // public engagement reply drafted for the user's comment on our own note
  const post = ctx.db.table('posts').insert({
    id: newId('post'),
    dealer_id: zj.dealer.id,
    account_id: zj.account.id,
    plan_id: null,
    slot_date: '2026-09-10',
    pillar: 'model_review',
    topic: 'i3:model_review:hangzhou',
    angle: '',
    model: 'i3',
    title: '宝马i3现在值得买吗？',
    body: '...',
    tags: [],
    cover_text: '',
    fact_refs: [],
    status: 'PUBLISHED',
    review: null,
    approval_policy: 'REVIEW_REQUIRED',
    platform_note_id: 'note-own-hz-i3-001',
    scheduled_for: null,
    published_at: now,
    metrics: { views: 0, likes: 0, collects: 0, comments: 0, shares: 0 },
    metrics_updated_at: null,
    engine: 'rules',
    created_at: now,
    updated_at: now,
  });
  const publicPost = ctx.db.table('public_posts').insert({
    id: newId('ppost'),
    platform: 'xiaohongshu',
    platform_post_id: 'note-own-hz-i3-001',
    xsec_token: null,
    url: null,
    title: post.title,
    content: '',
    author_platform_user_id: 'xhs-hz-i3',
    author_nickname: 'i3电车研究所',
    author_profile_url: null,
    ip_location: null,
    tags: [],
    like_count: 0,
    comment_count: 1,
    collect_count: 0,
    published_at: now,
    own_post_id: post.id,
    first_search_run_id: null,
    fetched_at: now,
    raw: {},
  });
  const comment = ctx.db.table('public_comments').insert({
    id: newId('pcmt'),
    platform: 'xiaohongshu',
    platform_comment_id: 'c-neg-1',
    public_post_id: publicPost.id,
    parent_comment_id: null,
    author_platform_user_id: NEGATIVE_USER,
    author_nickname: '路人',
    content: 'i3续航怎么样',
    ip_location: null,
    like_count: 0,
    published_at: now,
    prefilter_passed: true,
    prefilter_reason: 'keyword_hit',
    first_search_run_id: null,
    fetched_at: now,
    raw: {},
  });
  const engagement = ctx.db.table('engagement_replies').insert({
    id: newId('eng'),
    dealer_id: zj.dealer.id,
    account_id: zj.account.id,
    post_id: post.id,
    public_comment_id: comment.id,
    message: '续航表现不错，欢迎了解',
    fact_refs: [],
    guard_results: [],
    status: 'READY_FOR_REVIEW',
    capability_status: 'UNAVAILABLE',
    provider_message_id: null,
    created_at: now,
    updated_at: now,
  });

  return {
    zj, sh, js, leadA, leadB, wonLead, bystander, sentA, reviewA, draftA, blockedA, approvedB, bystanderOutreach,
    convA, inbound, draftReply, engagement,
  };
}

const input = { platform_user_id: NEGATIVE_USER, reason: '不需要，别再发了', source: 'conversation:test', actor: 'agent:conversation-agent' };

describe('crm: suppressContact cascade', () => {
  it('suppresses the user globally across dealer groups and stops every pending touch', () => {
    const ctx = createTestContext();
    const s = seedScenario(ctx);
    assert.equal(isSuppressed(ctx, NEGATIVE_USER), null);

    ctx.clock.advance({ minutes: 10 });
    const res = suppressContact(ctx, input);

    assert.equal(res.created, true);
    assert.equal(res.suppression.platform_user_id, NEGATIVE_USER);
    assert.equal(res.suppression.reason, input.reason);
    assert.equal(isSuppressed(ctx, NEGATIVE_USER)?.id, res.suppression.id);
    assert.equal(isSuppressed(ctx, 'u-hz-buyer-001'), null);
    assert.equal(isSuppressed(ctx, ''), null);

    assert.deepEqual(new Set(res.leads_updated), new Set([s.leadA.id, s.leadB.id, s.wonLead.id]));
    for (const id of [s.leadA.id, s.leadB.id]) {
      const lead = ctx.db.table('leads').require(id);
      assert.equal(lead.stage, 'LOST');
      assert.equal(lead.suppressed, true);
      assert.equal(lead.suppression_reason, input.reason);
      assert.equal(lead.lost_reason, `do_not_contact: ${input.reason}`);
      assert.equal(lead.next_action, SUPPRESSION_NEXT_ACTION);
      const trn = ctx.db.table('lead_stage_transitions').findOne({ lead_id: id });
      assert.equal(trn?.to_stage, 'LOST');
      assert.equal(trn?.reason, `do_not_contact: ${input.reason}`);
      assert.equal(trn?.actor, input.actor);
    }

    const won = ctx.db.table('leads').require(s.wonLead.id);
    assert.equal(won.stage, 'WON', 'a won lead is never moved to LOST');
    assert.equal(won.suppressed, true);
    assert.equal(won.next_action, SUPPRESSION_NEXT_ACTION);
    assert.equal(ctx.db.table('lead_stage_transitions').count({ lead_id: s.wonLead.id }), 0);

    assert.deepEqual(new Set(res.outreach_cancelled), new Set([s.reviewA.id, s.draftA.id, s.approvedB.id]));
    for (const id of res.outreach_cancelled) {
      const o = ctx.db.table('outreach').require(id);
      assert.equal(o.status, 'CANCELLED');
      assert.equal(o.blocked_reason, `do_not_contact: ${input.reason}`);
    }
    assert.equal(ctx.db.table('outreach').require(s.sentA.id).status, 'SENT', 'sent history is untouched');
    assert.equal(ctx.db.table('outreach').require(s.blockedA.id).status, 'BLOCKED');
    assert.equal(ctx.db.table('outreach').require(s.bystanderOutreach.id).status, 'READY_FOR_REVIEW');

    assert.deepEqual(res.conversations_closed, [s.convA.id]);
    const conv = ctx.db.table('conversations').require(s.convA.id);
    assert.equal(conv.status, 'closed');
    assert.equal(conv.needs_human, false);
    assert.equal(conv.handoff_reason, 'do_not_contact');

    assert.deepEqual(res.messages_discarded, [s.draftReply.id]);
    assert.equal(ctx.db.table('conversation_messages').require(s.draftReply.id).status, 'discarded');
    assert.equal(ctx.db.table('conversation_messages').require(s.inbound.id).status, 'received');

    assert.deepEqual(res.engagement_replies_cancelled, [s.engagement.id]);
    assert.equal(ctx.db.table('engagement_replies').require(s.engagement.id).status, 'CANCELLED');

    const bystander = ctx.db.table('leads').require(s.bystander.id);
    assert.equal(bystander.suppressed, false);
    assert.equal(bystander.stage, 'OUTREACH_READY');

    const events = ctx.db.table('audit_events').findMany({ action: 'contact.suppressed' });
    assert.equal(events.length, 1);
    assert.equal(events[0].entity_id, res.suppression.id);
    assert.equal(events[0].actor, input.actor);
    assert.deepEqual(events[0].details.outreach_cancelled, res.outreach_cancelled);
    assert.equal(ctx.db.table('audit_events').count({ action: 'lead.suppressed' }), 3);
    assert.equal(ctx.db.table('audit_events').count({ action: 'outreach.cancelled' }), 3);
    assert.equal(ctx.db.table('audit_events').count({ action: 'lead.stage_changed' }), 2);
  });

  it('is idempotent and re-applies the cascade to records created after the first suppression', () => {
    const ctx = createTestContext();
    const s = seedScenario(ctx);
    const first = suppressContact(ctx, input);
    const transitionsBefore = ctx.db.table('lead_stage_transitions').count();
    const eventsBefore = ctx.db.table('audit_events').count();
    const leadAUpdatedAt = ctx.db.table('leads').require(s.leadA.id).updated_at;
    const reviewAUpdatedAt = ctx.db.table('outreach').require(s.reviewA.id).updated_at;

    ctx.clock.advance({ hours: 1 });
    const repeat: SuppressContactResult = suppressContact(ctx, { ...input, reason: '再次要求勿扰' });
    assert.equal(repeat.created, false);
    assert.equal(repeat.suppression.id, first.suppression.id);
    assert.equal(repeat.suppression.reason, input.reason, 'the original suppression is kept');
    assert.deepEqual(
      [repeat.leads_updated, repeat.outreach_cancelled, repeat.conversations_closed, repeat.messages_discarded, repeat.engagement_replies_cancelled],
      [[], [], [], [], []],
    );
    assert.equal(ctx.db.table('contact_suppressions').count(), 1);
    assert.equal(ctx.db.table('lead_stage_transitions').count(), transitionsBefore);
    assert.equal(ctx.db.table('audit_events').count(), eventsBefore, 'a no-op repeat writes nothing');
    assert.equal(ctx.db.table('leads').require(s.leadA.id).updated_at, leadAUpdatedAt, 'already-suppressed lead row is not rewritten');
    assert.equal(ctx.db.table('outreach').require(s.reviewA.id).updated_at, reviewAUpdatedAt, 'cancelled outreach is not rewritten');

    // a lead discovered later in yet another group, plus a stray pending outreach
    const later = seedDealer(ctx, '安徽宝马集团', '合肥');
    const newLead = insertLead(ctx, later, NEGATIVE_USER, { stage: 'QUALIFIED' });
    const stray = addOutreach(ctx, assign(ctx, newLead, later.account), { status: 'READY_FOR_REVIEW' });

    const again = suppressContact(ctx, input);
    assert.equal(again.created, false);
    assert.deepEqual(again.leads_updated, [newLead.id]);
    assert.deepEqual(again.outreach_cancelled, [stray.id]);
    const updated = ctx.db.table('leads').require(newLead.id);
    assert.equal(updated.stage, 'LOST');
    assert.equal(updated.suppressed, true);
    assert.equal(ctx.db.table('audit_events').count({ action: 'contact.suppression_reapplied' }), 1);
    assert.equal(ctx.db.table('audit_events').count({ action: 'contact.suppressed' }), 1);
  });

  it('also cancels FAILED outreach, which could otherwise be retried or sent manually', () => {
    const ctx = createTestContext();
    const s = seedScenario(ctx);
    const failed = addOutreach(ctx, ctx.db.table('lead_assignments').findOne({ lead_id: s.leadB.id, active: true })!, {
      kind: 'follow_up',
      status: 'FAILED',
      capability_status: 'AVAILABLE',
    });
    const res = suppressContact(ctx, input);
    assert.ok(res.outreach_cancelled.includes(failed.id));
    const row = ctx.db.table('outreach').require(failed.id);
    assert.equal(row.status, 'CANCELLED');
    assert.equal(row.blocked_reason, `do_not_contact: ${input.reason}`);
  });

  it('stores the platform user id exactly as isSuppressed looks it up', () => {
    const ctx = createTestContext();
    const res = suppressContact(ctx, { ...input, platform_user_id: ' u-padded-7 ' });
    assert.equal(res.suppression.platform_user_id, ' u-padded-7 ');
    assert.equal(isSuppressed(ctx, ' u-padded-7 ')?.id, res.suppression.id);
    assert.equal(isSuppressed(ctx, 'u-padded-7'), null, 'ids are opaque: no silent normalization');
  });

  it('is atomic: a failure late in the cascade leaves no partial suppression behind', () => {
    const ctx = createTestContext();
    const s = seedScenario(ctx);
    const original = ctx.audit.event.bind(ctx.audit);
    ctx.audit.event = (e) => {
      if (e.action === 'contact.suppressed') throw new Error('audit store unavailable');
      return original(e);
    };
    assert.throws(() => suppressContact(ctx, input), /audit store/);
    assert.equal(isSuppressed(ctx, NEGATIVE_USER), null);
    assert.equal(ctx.db.table('leads').require(s.leadA.id).stage, 'CONTACTED');
    assert.equal(ctx.db.table('leads').require(s.leadA.id).suppressed, false);
    assert.equal(ctx.db.table('outreach').require(s.reviewA.id).status, 'READY_FOR_REVIEW');
    assert.equal(ctx.db.table('outreach').require(s.approvedB.id).status, 'APPROVED');
    assert.equal(ctx.db.table('conversations').require(s.convA.id).status, 'open');
    assert.equal(ctx.db.table('conversation_messages').require(s.draftReply.id).status, 'draft');
    assert.equal(ctx.db.table('engagement_replies').require(s.engagement.id).status, 'READY_FOR_REVIEW');
    assert.equal(ctx.db.table('lead_stage_transitions').count(), 0);
    assert.equal(ctx.db.table('audit_events').count(), 0);
  });

  it('validates input without writing anything', () => {
    const ctx = createTestContext();
    seedScenario(ctx);
    assert.throws(() => suppressContact(ctx, { ...input, reason: '  ' }), ValidationError);
    assert.throws(() => suppressContact(ctx, { ...input, platform_user_id: '' }), ValidationError);
    assert.throws(() => suppressContact(ctx, { ...input, actor: '' }), ValidationError);
    assert.equal(ctx.db.table('contact_suppressions').count(), 0);
    assert.equal(ctx.db.table('leads').count({ suppressed: true }), 0);
  });

  it('is exposed through the crm skill', async () => {
    const ctx = createTestContext();
    const s = seedScenario(ctx);
    ctx.skills.register(crmSkill);
    await assert.rejects(ctx.skills.invoke(ctx, 'crm', { action: 'suppress', platform_user_id: NEGATIVE_USER }), ValidationError);
    const out = await ctx.skills.invoke<{ action: string } & SuppressContactResult>(ctx, 'crm', {
      action: 'suppress',
      platform_user_id: NEGATIVE_USER,
      reason: '不需要',
      source: 'operator:李娜',
    });
    assert.equal(out.action, 'suppress');
    assert.equal(out.created, true);
    assert.equal(out.suppression.source, 'operator:李娜');
    assert.equal(ctx.db.table('leads').require(s.leadB.id).stage, 'LOST');
    assert.equal(ctx.db.table('lead_stage_transitions').findOne({ lead_id: s.leadB.id })?.actor, 'agent:crm-agent');
  });
});
