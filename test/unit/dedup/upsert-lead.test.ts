import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NotFoundError, PolicyError, ValidationError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import type { IntentDetection, Lead, PublicComment, PublicPost } from '../../../src/core/types.ts';
import { buildDealerProfile } from '../../../src/domain/dealer-profile.ts';
import {
  findLeadByIdentity,
  skill,
  upsertLeadFromSignal,
  type SignalInput,
  type UpsertLeadResult,
} from '../../../src/skills/acquisition/lead-deduplication/index.ts';
import {
  authenticityFromEvidence,
  getScoringConfig,
  scoreSignal,
  updateScoringConfig,
} from '../../../src/skills/acquisition/lead-scoring/index.ts';
import { transitionLead } from '../../../src/skills/operations/crm/index.ts';
import { SkillRegistry } from '../../../src/skills/registry.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { accountIdByPlatformId, dealerIdByKey, loadDealerFixture, seedAssignment, seedSuppression } from '../../helpers/fixtures.ts';

const HOUR_MS = 3_600_000;

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

function setup() {
  const ctx = createTestContext();
  const summary = loadDealerFixture(ctx);
  return { ctx, summary, hz: dealerIdByKey(summary, 'hz-bmw'), sh: dealerIdByKey(summary, 'sh-bmw') };
}

const ago = (ctx: TestContext, hours: number): string => new Date(ctx.clock.now().getTime() - hours * HOUR_MS).toISOString();

let seq = 0;
function insertPost(ctx: TestContext, input: { title: string; author?: string | null; xsec_token?: string | null }): PublicPost {
  const n = ++seq;
  const now = ctx.clock.iso();
  return ctx.db.table('public_posts').insert({
    id: newId('ppost'),
    platform: 'xiaohongshu',
    platform_post_id: `note-dedup-${n}-${newId('n')}`,
    xsec_token: input.xsec_token ?? null,
    url: null,
    title: input.title,
    content: '',
    author_platform_user_id: input.author ?? null,
    author_nickname: null,
    author_profile_url: null,
    ip_location: null,
    tags: [],
    like_count: 0,
    comment_count: 0,
    collect_count: 0,
    published_at: now,
    own_post_id: null,
    first_search_run_id: null,
    fetched_at: now,
    raw: {},
  });
}

function insertComment(ctx: TestContext, post: PublicPost, author: string | null, content: string): PublicComment {
  const n = ++seq;
  const now = ctx.clock.iso();
  return ctx.db.table('public_comments').insert({
    id: newId('pcmt'),
    platform: 'xiaohongshu',
    platform_comment_id: `c-dedup-${n}-${newId('c')}`,
    public_post_id: post.id,
    parent_comment_id: null,
    author_platform_user_id: author,
    author_nickname: null,
    content,
    ip_location: '浙江',
    like_count: 0,
    published_at: now,
    prefilter_passed: true,
    prefilter_reason: 'keyword_hit',
    first_search_run_id: null,
    fetched_at: now,
    raw: {},
  });
}

// Hand-built detections (independent of NLU internals).
const landing = (): IntentDetection => ({
  is_purchase_signal: true,
  intent: {
    brand: 'BMW',
    model: 'i3',
    trim: 'eDrive35L',
    location: '杭州',
    province: '浙江',
    price_intent: true,
    price_sensitivity: 'medium',
    purchase_stage: 'active_shopping',
    confidence: 0.81,
  },
  evidence: [
    { code: 'stated_model', label: '提及车型 i3', quote: 'i3' },
    { code: 'specified_trim', label: '指定配置 eDrive35L', quote: '35L' },
    { code: 'stated_location', label: '本地买家（杭州）', quote: '杭州' },
    { code: 'landing_price', label: '询问落地价', quote: '落地多少' },
  ],
  transaction_questions: ['landing_price'],
  strength: 1,
  negative: false,
  engine: 'rules',
  author_role: 'asker',
});

const inventoryAsk = (): IntentDetection => ({
  is_purchase_signal: true,
  intent: { brand: 'BMW', model: 'i3', inventory_intent: true, purchase_stage: 'active_shopping', inferred_fields: ['brand', 'model'], confidence: 0.58 },
  evidence: [
    { code: 'model_from_post_context', label: '车型来自帖子上下文', quote: '宝马i3', source_ref: 'post_context' },
    { code: 'inventory', label: '询问现车', quote: '有现车' },
  ],
  transaction_questions: ['inventory'],
  strength: 1,
  negative: false,
  engine: 'rules',
  author_role: 'asker',
});

const discountAsk = (): IntentDetection => ({
  is_purchase_signal: true,
  intent: { brand: 'BMW', model: 'i3', discount_intent: true, price_sensitivity: 'medium', purchase_stage: 'price_shopping', inferred_fields: ['brand', 'model'], confidence: 0.6 },
  evidence: [
    { code: 'model_from_post_context', label: '车型来自帖子上下文', quote: '宝马i3', source_ref: 'post_context' },
    { code: 'discount', label: '询问优惠', quote: '优惠多少' },
  ],
  transaction_questions: ['discount'],
  strength: 0.88,
  negative: false,
  engine: 'rules',
  author_role: 'asker',
});

const spaceAsk = (): IntentDetection => ({
  is_purchase_signal: true,
  intent: { brand: 'BMW', model: 'i3', purchase_stage: 'research', inferred_fields: ['brand', 'model'], confidence: 0.55 },
  evidence: [
    { code: 'model_from_post_context', label: '车型来自帖子上下文', quote: '宝马i3', source_ref: 'post_context' },
    { code: 'product_research', label: '关注产品细节', quote: '后排空间' },
  ],
  transaction_questions: [],
  strength: 0.2,
  negative: false,
  engine: 'rules',
  author_role: 'asker',
});

const shanghaiLanding = (): IntentDetection => ({
  is_purchase_signal: true,
  intent: {
    brand: 'BMW',
    model: '3 Series',
    trim: '325Li',
    location: '上海',
    province: '上海',
    price_intent: true,
    purchase_stage: 'active_shopping',
    confidence: 0.8,
  },
  evidence: [
    { code: 'specified_trim', label: '指定配置 325Li', quote: '325Li' },
    { code: 'stated_location', label: '本地买家（上海）', quote: '上海' },
    { code: 'landing_price', label: '询问落地价', quote: '落地多少' },
  ],
  transaction_questions: ['landing_price'],
  strength: 1,
  negative: false,
  engine: 'rules',
  author_role: 'asker',
});

const praise = (): IntentDetection => ({
  is_purchase_signal: false,
  intent: { confidence: 0.95 },
  evidence: [{ code: 'pure_praise', label: '纯夸赞，无购车意图', quote: '帅' }],
  transaction_questions: [],
  strength: 0,
  negative: false,
  engine: 'rules',
  author_role: 'unknown',
});

function commentSignal(ctx: TestContext, user: string, content: string, detection: IntentDetection, hoursAgo: number, extra: Partial<SignalInput> = {}): SignalInput {
  const post = insertPost(ctx, { title: '宝马i3现在值得买吗？' });
  const comment = insertComment(ctx, post, user, content);
  return {
    source_type: 'comment',
    public_post_id: post.id,
    public_comment_id: comment.id,
    post_title: post.title,
    content,
    signal_at: ago(ctx, hoursAgo),
    detection,
    ...extra,
  };
}

function upsert(ctx: TestContext, dealerId: string, user: string, signal: SignalInput, extra: { username?: string; attributed_post_id?: string | null } = {}): UpsertLeadResult {
  return upsertLeadFromSignal(ctx, {
    dealer_id: dealerId,
    identity: { platform_user_id: user, username: extra.username ?? '西湖边的小鹿' },
    signal,
    attributed_post_id: extra.attributed_post_id,
  });
}

const count = (ctx: TestContext, sql: string, ...params: string[]): number =>
  Number(ctx.db.get<{ n: number }>(sql, ...params)?.n ?? 0);

function decisions(ctx: TestContext, leadId: string, type: string) {
  return ctx.audit.decisionsFor('lead', leadId).filter((d) => d.decision_type === type);
}

function seedSecondGroup(ctx: TestContext) {
  const now = ctx.clock.iso();
  const group = ctx.db.table('dealer_groups').insert({ id: newId('grp'), name: '杭州另一经销商集团', created_at: now });
  const hzDealer = ctx.db.table('dealers').require(dealerIdByKey(loadSummaryCache.get(ctx)!, 'hz-bmw'));
  const dealer = ctx.db.table('dealers').insert({
    ...hzDealer,
    id: newId('dlr'),
    group_id: group.id,
    name: '杭州第二宝马店',
    created_at: now,
    updated_at: now,
  });
  return { group, dealer };
}
const loadSummaryCache = new WeakMap<TestContext, ReturnType<typeof loadDealerFixture>>();
function setupWithCache() {
  const s = setup();
  loadSummaryCache.set(s.ctx, s.summary);
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('lead-deduplication · identity resolution across notes', () => {
  it('merges the same user commenting on three different notes into ONE lead', () => {
    const { ctx, hz } = setup();
    const user = 'u-dedup-001';
    const r1 = upsert(ctx, hz, user, commentSignal(ctx, user, '杭州i3 35L落地多少', landing(), 48));
    const r2 = upsert(ctx, hz, user, commentSignal(ctx, user, '有现车吗', inventoryAsk(), 24), { username: '西湖边的小鹿🦌' });
    const r3 = upsert(ctx, hz, user, commentSignal(ctx, user, '现在优惠多少', discountAsk(), 12), { username: '西湖边的小鹿🦌' });

    assert.equal(r1.created, true);
    assert.equal(r1.merged, false);
    assert.deepEqual([r2.created, r2.merged, r3.created, r3.merged], [false, true, false, true]);
    assert.equal(r2.lead.id, r1.lead.id);
    assert.equal(r3.lead.id, r1.lead.id);
    assert.equal(ctx.db.table('leads').count({ platform_user_id: user }), 1);

    const lead = ctx.db.table('leads').require(r1.lead.id);
    const signals = ctx.db.table('lead_signals').findMany({ lead_id: lead.id }, { orderBy: 'signal_at ASC' });
    assert.equal(signals.length, 3);
    assert.equal(lead.signal_count, 3);
    assert.deepEqual(
      signals.map((s) => s.id),
      [r1.signal!.id, r2.signal!.id, r3.signal!.id],
    );

    // merged intent keeps the stated trim + location and the inventory/discount/price intents
    assert.equal(lead.intent.model, 'i3');
    assert.equal(lead.intent.trim, 'eDrive35L');
    assert.equal(lead.intent.location, '杭州');
    assert.equal(lead.intent.province, '浙江');
    assert.equal(lead.intent.inventory_intent, true);
    assert.equal(lead.intent.discount_intent, true);
    assert.equal(lead.intent.price_intent, true);
    assert.equal(lead.intent.purchase_stage, 'active_shopping');
    assert.ok(!(lead.intent.inferred_fields ?? []).includes('model'), 'model was stated by the first comment');

    // evidence preserved with provenance
    const refOf = (code: string) => lead.evidence.find((e) => e.code === code)?.source_ref;
    assert.equal(refOf('specified_trim'), r1.signal!.id);
    assert.equal(refOf('inventory'), r2.signal!.id);
    assert.equal(refOf('discount'), r3.signal!.id);
    const signalIds = new Set(signals.map((s) => s.id));
    assert.ok(lead.evidence.every((e) => e.source_ref && signalIds.has(e.source_ref)));
    for (const s of signals) assert.ok(lead.evidence.some((e) => e.source_ref === s.id), `evidence of ${s.content} kept`);
    assert.equal(lead.evidence.filter((e) => e.code === 'model_from_post_context').length, 1, 'identical evidence deduplicated');

    // score ≥ best signal and carries corroboration
    const best = Math.max(...signals.map((s) => s.signal_score));
    assert.ok(lead.score >= best, `lead score ${lead.score} >= best signal ${best}`);
    const latestRow = ctx.db.get('SELECT * FROM lead_scores WHERE lead_id = ? ORDER BY computed_at DESC, rowid DESC LIMIT 1', lead.id);
    assert.ok(latestRow);
    const latestScore = ctx.db.table('lead_scores').decode(latestRow);
    const corroboration = latestScore.components.find((c) => c.factor === 'corroboration');
    assert.ok(corroboration && corroboration.points > 0, 'corroboration bonus applied');

    // lead fields
    assert.equal(lead.first_seen_at, r1.signal!.signal_at);
    assert.equal(lead.last_signal_at, r3.signal!.signal_at);
    assert.equal(lead.username, '西湖边的小鹿🦌');
    assert.equal(lead.primary_signal_id, signals.reduce((a, b) => (b.signal_score > a.signal_score ? b : a)).id);
    assert.equal(lead.estimated_value, 353900, 'MSRP of BMW i3 eDrive35L');
    assert.equal(lead.stage, 'QUALIFIED');
    assert.ok(lead.next_action && lead.next_action.length > 0);

    // audit
    const merges = decisions(ctx, lead.id, 'lead_dedup_merge');
    assert.equal(merges.length, 2);
    assert.deepEqual(merges.map((d) => d.output.signal_count), [2, 3]);
    assert.equal((merges[1].inputs.signal as { content: string }).content, '现在优惠多少');
    assert.equal(typeof merges[1].output.score_before, 'number');
    assert.equal(merges[1].output.score_after, lead.score);
    assert.ok(merges[1].evidence.every((e) => e.source_ref === r3.signal!.id));
    assert.equal(ctx.audit.eventsFor('lead', lead.id).filter((e) => e.action === 'lead.created').length, 1);
    assert.equal(ctx.audit.eventsFor('lead', lead.id).filter((e) => e.action === 'lead.signal_added').length, 3);
  });

  it('is idempotent when the same comment, post or content is ingested again', () => {
    const { ctx, hz } = setup();
    const user = 'u-dedup-002';
    const signal = commentSignal(ctx, user, '杭州i3 35L落地多少', landing(), 5);
    const first = upsert(ctx, hz, user, signal);
    const snapshot = {
      signals: ctx.db.table('lead_signals').count({ lead_id: first.lead.id }),
      scores: ctx.db.table('lead_scores').count({ lead_id: first.lead.id }),
      decisions: ctx.audit.decisionsFor('lead', first.lead.id).length,
      events: ctx.audit.eventsFor('lead', first.lead.id).length,
      transitions: ctx.db.table('lead_stage_transitions').count({ lead_id: first.lead.id }),
    };
    const lead = ctx.db.table('leads').require(first.lead.id);

    const again = upsert(ctx, hz, user, { ...signal, content: '杭州i3 35L落地多少', signal_at: ago(ctx, 1) });
    assert.equal(again.signal, null);
    assert.equal(again.duplicate, true);
    assert.equal(again.created, false);
    assert.equal(again.merged, false);
    assert.deepEqual(again.stage_changes, []);
    assert.equal(again.lead.id, first.lead.id);
    assert.deepEqual(ctx.db.table('leads').require(first.lead.id), lead, 'lead row untouched');
    assert.deepEqual(
      {
        signals: ctx.db.table('lead_signals').count({ lead_id: first.lead.id }),
        scores: ctx.db.table('lead_scores').count({ lead_id: first.lead.id }),
        decisions: ctx.audit.decisionsFor('lead', first.lead.id).length,
        events: ctx.audit.eventsFor('lead', first.lead.id).length,
        transitions: ctx.db.table('lead_stage_transitions').count({ lead_id: first.lead.id }),
      },
      snapshot,
    );

    // the user's own note: one signal per (lead, public post)
    const ownPost = insertPost(ctx, { title: '杭州i3 35L现在落地多少？', author: user });
    const postSignal: SignalInput = { source_type: 'post', public_post_id: ownPost.id, post_title: ownPost.title, content: ownPost.title, signal_at: ago(ctx, 3), detection: landing() };
    assert.notEqual(upsert(ctx, hz, user, postSignal).signal, null);
    assert.equal(upsert(ctx, hz, user, postSignal).duplicate, true);

    // reply / profile / import without ids: deduplicated by normalized content
    const reply: SignalInput = { source_type: 'reply', content: 'I3有现车吗 ', signal_at: ago(ctx, 2), detection: inventoryAsk() };
    assert.notEqual(upsert(ctx, hz, user, reply).signal, null);
    const replyAgain = upsert(ctx, hz, user, { ...reply, content: 'ｉ3有现车吗', signal_at: ago(ctx, 1) });
    assert.equal(replyAgain.duplicate, true);
    const asProfile = upsert(ctx, hz, user, { ...reply, source_type: 'profile' });
    assert.notEqual(asProfile.signal, null, 'another source type is a different signal');
    assert.equal(ctx.db.table('leads').require(first.lead.id).signal_count, 4);
  });
});

describe('lead-deduplication · tenancy and identity guards', () => {
  it('keeps two separate leads for the same user in two different dealer groups', () => {
    const { ctx, hz } = setupWithCache();
    const { group, dealer } = seedSecondGroup(ctx);
    const user = 'u-dedup-003';
    const a = upsert(ctx, hz, user, commentSignal(ctx, user, '杭州i3 35L落地多少', landing(), 4));
    const b = upsert(ctx, dealer.id, user, commentSignal(ctx, user, '杭州i3 35L落地多少', landing(), 3));
    assert.equal(a.created, true);
    assert.equal(b.created, true);
    assert.notEqual(a.lead.id, b.lead.id);
    assert.equal(b.lead.group_id, group.id);
    assert.equal(findLeadByIdentity(ctx, a.lead.group_id, user)?.id, a.lead.id);
    assert.equal(findLeadByIdentity(ctx, group.id, user)?.id, b.lead.id);
    assert.equal(findLeadByIdentity(ctx, group.id, 'u-nobody'), undefined);
    assert.equal(ctx.db.table('leads').count({ platform_user_id: user }), 2);

    // the same public comment seen by both groups: stored for the second group without the (globally unique) comment id
    const shared = commentSignal(ctx, user, '有现车吗', inventoryAsk(), 2);
    const inA = upsert(ctx, hz, user, shared);
    assert.equal(inA.signal?.public_comment_id, shared.public_comment_id);
    const inB = upsert(ctx, dealer.id, user, shared);
    assert.notEqual(inB.signal, null);
    assert.equal(inB.signal?.public_comment_id, null);
    assert.equal(inB.signal?.public_post_id, shared.public_post_id);
    assert.equal(inB.signal?.content, '有现车吗');
    assert.equal(upsert(ctx, dealer.id, user, shared).duplicate, true, 'still idempotent for the second group');
    assert.equal(upsert(ctx, hz, user, shared).duplicate, true);
  });

  it('rejects identities that are managed accounts of the dealer group', () => {
    const { ctx, hz } = setup();
    for (const managed of ['xhs-hz-sales-wang', 'xhs-sh-official']) {
      assert.throws(
        () => upsert(ctx, hz, managed, { source_type: 'import', content: '杭州i3 35L落地多少', signal_at: ago(ctx, 1), detection: landing() }),
        (err: unknown) => err instanceof PolicyError && err.code === 'managed_account_identity',
      );
    }
    assert.equal(ctx.db.table('leads').count(), 0);
    assert.equal(ctx.db.table('lead_signals').count(), 0);
  });

  it('rejects a comment written by a different user or already owned by another lead of the group', () => {
    const { ctx, hz } = setup();
    const post = insertPost(ctx, { title: '宝马i3现在值得买吗？' });
    const byOther = insertComment(ctx, post, 'u-author-real', '杭州i3 35L落地多少');
    assert.throws(
      () => upsert(ctx, hz, 'u-impostor', { source_type: 'comment', public_post_id: post.id, public_comment_id: byOther.id, content: byOther.content, signal_at: ago(ctx, 1), detection: landing() }),
      (err: unknown) => err instanceof PolicyError && err.code === 'signal_identity_conflict',
    );

    const anonymous = insertComment(ctx, post, null, '有现车吗');
    const signal: SignalInput = { source_type: 'comment', public_post_id: post.id, public_comment_id: anonymous.id, content: '有现车吗', signal_at: ago(ctx, 1), detection: inventoryAsk() };
    upsert(ctx, hz, 'u-first', signal);
    assert.throws(
      () => upsert(ctx, hz, 'u-second', signal),
      (err: unknown) => err instanceof PolicyError && err.code === 'signal_identity_conflict',
    );
    assert.equal(ctx.db.table('leads').count({ platform_user_id: 'u-second' }), 0);

    const otherPost = insertPost(ctx, { title: '别的笔记' });
    assert.throws(
      () => upsert(ctx, hz, 'u-first', { ...signal, public_post_id: otherPost.id }),
      ValidationError,
    );
    assert.throws(() => upsert(ctx, hz, 'u-first', { ...signal, public_comment_id: 'pcmt_missing' }), NotFoundError);
    assert.throws(() => upsert(ctx, 'dlr_missing', 'u-first', { source_type: 'import', content: 'x', signal_at: ago(ctx, 1), detection: landing() }), NotFoundError);
  });

  it('validates the input shape', () => {
    const { ctx, hz } = setup();
    const base = { source_type: 'import' as const, content: '杭州i3 35L落地多少', signal_at: ago(ctx, 1), detection: landing() };
    assert.throws(() => upsert(ctx, hz, 'u-v', { ...base, signal_at: 'yesterday' }), ValidationError);
    assert.throws(() => upsert(ctx, hz, 'u-v', { ...base, content: '   ' }), ValidationError);
    assert.throws(() => upsert(ctx, hz, '  ', base), ValidationError);
    assert.throws(() => upsert(ctx, hz, 'u-v', { ...base, detection: { ...landing(), strength: 1.5 } }), ValidationError);
    assert.throws(() => upsert(ctx, hz, 'u-v', { ...base, source_type: 'dm' as never }), ValidationError);
    assert.throws(() => skill.input(null, 'lead-deduplication'), ValidationError);
    assert.equal(ctx.db.table('leads').count(), 0);
  });
});

describe('lead-deduplication · persistence rules', () => {
  it('never creates a lead from a non-purchase comment, but allows reply and import sources', () => {
    const { ctx, hz } = setup();
    assert.throws(
      () => upsert(ctx, hz, 'u-praise', commentSignal(ctx, 'u-praise', '帅', praise(), 1)),
      (err: unknown) => err instanceof PolicyError && err.code === 'not_a_purchase_signal',
    );
    const negative: IntentDetection = { ...landing(), negative: true };
    assert.throws(
      () => upsert(ctx, hz, 'u-negative', { source_type: 'profile', content: '已经提车了', signal_at: ago(ctx, 1), detection: negative }),
      (err: unknown) => err instanceof PolicyError && err.code === 'not_a_purchase_signal',
    );
    assert.equal(ctx.db.table('leads').count(), 0);
    assert.equal(ctx.db.table('lead_signals').count(), 0);
    assert.equal(ctx.db.table('lead_stage_transitions').count(), 0);

    for (const source of ['reply', 'import'] as const) {
      const res = upsert(ctx, hz, `u-${source}`, { source_type: source, content: '好的，谢谢', signal_at: ago(ctx, 1), detection: praise() });
      assert.equal(res.created, true);
      assert.equal(res.lead.stage, 'DISCOVERED');
      assert.deepEqual(res.stage_changes, []);
      assert.equal(res.signal?.is_purchase_signal, false);
      assert.equal(res.lead.primary_signal_id, res.signal?.id, 'provenance kept even without purchase signals');
      assert.ok(res.lead.score < 20);
    }
  });

  it('stores a non-purchase signal on an existing lead for history without changing score, tier, stage or intent', () => {
    const { ctx, hz } = setup();
    const user = 'u-dedup-004';
    const first = upsert(ctx, hz, user, commentSignal(ctx, user, '这车后排空间怎么样', spaceAsk(), 6));
    const before = ctx.db.table('leads').require(first.lead.id);
    const scoresBefore = ctx.db.table('lead_scores').count({ lead_id: before.id });

    ctx.clock.advance({ days: 40 });
    const res = upsert(ctx, hz, user, commentSignal(ctx, user, '帅', praise(), 1));
    assert.notEqual(res.signal, null);
    assert.equal(res.signal?.is_purchase_signal, false);
    assert.equal(res.merged, true);
    assert.deepEqual(res.stage_changes, []);
    const after = ctx.db.table('leads').require(first.lead.id);
    assert.equal(after.signal_count, 2);
    assert.equal(after.score, before.score);
    assert.equal(after.tier, before.tier);
    assert.equal(after.stage, before.stage);
    assert.deepEqual(after.intent, before.intent);
    assert.equal(after.primary_signal_id, first.signal!.id);
    assert.ok(after.evidence.some((e) => e.code === 'pure_praise' && e.source_ref === res.signal!.id), 'history evidence kept');
    assert.equal(ctx.db.table('lead_scores').count({ lead_id: before.id }), scoresBefore, 'not re-scored');
    const merge = decisions(ctx, before.id, 'lead_dedup_merge')[0];
    assert.equal(merge.output.rescored, false);
    assert.equal(merge.output.intent_merged, false);
    assert.equal(merge.output.score_after, before.score);
  });

  it('stores suppressed identities as suppressed and never advances them', () => {
    const { ctx, hz } = setup();
    seedSuppression(ctx, 'u-dnc-001');
    const res = upsert(ctx, hz, 'u-dnc-001', commentSignal(ctx, 'u-dnc-001', '杭州i3 35L落地多少', landing(), 2));
    assert.equal(res.created, true);
    assert.equal(res.lead.suppressed, true);
    assert.equal(res.lead.suppression_reason, '用户回复：不需要，别再发了');
    assert.equal(res.lead.stage, 'DISCOVERED');
    assert.deepEqual(res.stage_changes, []);
    assert.equal(res.lead.next_action, '勿扰：已停止所有触达');
    assert.ok(res.lead.score >= 60, 'still scored for history');
    const more = upsert(ctx, hz, 'u-dnc-001', commentSignal(ctx, 'u-dnc-001', '有现车吗', inventoryAsk(), 1));
    assert.equal(more.lead.stage, 'DISCOVERED');
    assert.equal(ctx.db.table('lead_stage_transitions').count({ lead_id: res.lead.id }), 1);
    assert.equal(decisions(ctx, res.lead.id, 'lead_qualification').length, 0);

    // suppression recorded after the lead existed: flagged on the next signal, stage frozen
    const user = 'u-dnc-002';
    const early = upsert(ctx, hz, user, commentSignal(ctx, user, '这车后排空间怎么样', spaceAsk(), 5));
    assert.equal(early.lead.stage, 'CANDIDATE');
    seedSuppression(ctx, user);
    const late = upsert(ctx, hz, user, commentSignal(ctx, user, '杭州i3 35L落地多少', landing(), 1));
    assert.equal(late.lead.suppressed, true);
    assert.equal(late.lead.stage, 'CANDIDATE');
    assert.deepEqual(late.stage_changes, []);
    assert.ok(ctx.audit.eventsFor('lead', early.lead.id).some((e) => e.action === 'lead.suppressed'));
  });

  it('persists every v2 detection column, the evidence unchanged and the signal score from scoreSignal', () => {
    const { ctx, hz } = setup();
    const detection: IntentDetection = {
      is_purchase_signal: true,
      intent: { brand: 'BMW', model: 'X3', discount_intent: true, financing_intent: true, purchase_stage: 'price_shopping', confidence: 0.7 },
      evidence: [
        { code: 'stated_model', label: '提及车型 X3', quote: 'X3' },
        { code: 'discount', label: '询问优惠', quote: '优惠' },
        { code: 'finance', label: '询问贷款/金融方案', quote: '贷款' },
      ],
      transaction_questions: ['discount', 'finance'],
      strength: 0.88,
      negative: false,
      engine: 'llm+rules',
      author_role: 'asker',
    };
    const signal = commentSignal(ctx, 'u-v2', 'X3现在优惠多少，贷款怎么算', detection, 30, { query_id: 'q-test-1', search_run_id: 'run-test-1' });
    const res = upsert(ctx, hz, 'u-v2', signal);
    const row = ctx.db.table('lead_signals').require(res.signal!.id);
    assert.equal(row.is_purchase_signal, true);
    assert.equal(row.strength, 0.88);
    assert.deepEqual(row.transaction_questions, ['discount', 'finance']);
    assert.equal(row.author_role, 'asker');
    assert.equal(row.engine, 'llm+rules');
    assert.deepEqual(row.evidence, detection.evidence);
    assert.deepEqual(row.intent, detection.intent);
    assert.equal(row.query_id, 'q-test-1');
    assert.equal(row.search_run_id, 'run-test-1');
    assert.equal(row.post_title, '宝马i3现在值得买吗？');
    const expected = scoreSignal(
      { detection, signal_at: signal.signal_at, now: ctx.clock.iso(), dealer: buildDealerProfile(ctx, hz), authenticity: authenticityFromEvidence([]) },
      getScoringConfig(ctx, hz),
    );
    assert.equal(row.signal_score, expected.score);
    assert.equal(res.lead.attributed_query_id, 'q-test-1');

    const owner: IntentDetection = { ...praise(), author_role: 'owner', evidence: [{ code: 'already_purchased', label: '已购车（非在市买家）', quote: '提车' }] };
    const ownerRes = upsert(ctx, hz, 'u-v2', commentSignal(ctx, 'u-v2', '去年提车的X3，挺好', owner, 2));
    const ownerRow = ctx.db.table('lead_signals').require(ownerRes.signal!.id);
    assert.equal(ownerRow.is_purchase_signal, false);
    assert.equal(ownerRow.author_role, 'owner');
    assert.equal(ownerRow.strength, 0);
    assert.deepEqual(ownerRow.transaction_questions, []);

    const { author_role: _omit, ...noRole } = landing();
    const noRoleRes = upsert(ctx, hz, 'u-v2', { source_type: 'import', content: '杭州i3 35L落地多少', signal_at: ago(ctx, 1), detection: noRole });
    assert.equal(ctx.db.table('lead_signals').require(noRoleRes.signal!.id).author_role, null);
  });

  it('merges out-of-order signals chronologically and keeps the first attribution', () => {
    const { ctx, hz } = setup();
    const user = 'u-dedup-005';
    const ningbo: IntentDetection = {
      ...landing(),
      intent: { ...landing().intent, location: '宁波', province: '浙江' },
      evidence: [{ code: 'stated_location', label: '同省买家（宁波）', quote: '宁波' }],
    };
    const newer = upsert(ctx, hz, user, commentSignal(ctx, user, '宁波i3 35L落地多少', ningbo, 2), { attributed_post_id: null });
    assert.equal(newer.lead.attributed_post_id, null);
    const older = upsert(ctx, hz, user, commentSignal(ctx, user, '杭州i3 35L落地多少', landing(), 30, { query_id: 'q-first' }), { attributed_post_id: 'post_own_1' });
    const third = upsert(ctx, hz, user, commentSignal(ctx, user, '有现车吗', inventoryAsk(), 1, { query_id: 'q-second' }), { attributed_post_id: 'post_own_2' });

    const lead = ctx.db.table('leads').require(third.lead.id);
    assert.equal(lead.intent.location, '宁波', 'an older stated location never overrides a newer one');
    assert.equal(lead.first_seen_at, older.signal!.signal_at);
    assert.equal(lead.last_signal_at, third.signal!.signal_at);
    assert.equal(lead.attributed_post_id, 'post_own_1');
    assert.equal(lead.attributed_query_id, 'q-first');
  });
});

describe('lead-deduplication · funnel advancement', () => {
  it('advances DISCOVERED → CANDIDATE → QUALIFIED with transition rows, one qualification decision and no demotion', () => {
    const { ctx, hz } = setup();
    const user = 'u-funnel-001';
    const r1 = upsert(ctx, hz, user, commentSignal(ctx, user, '这车后排空间怎么样', spaceAsk(), 10));
    assert.deepEqual(r1.stage_changes, ['CANDIDATE']);
    assert.equal(r1.lead.stage, 'CANDIDATE');
    let transitions = ctx.db.table('lead_stage_transitions').findMany({ lead_id: r1.lead.id }, { orderBy: 'at ASC' });
    assert.deepEqual(
      transitions.map((t) => [t.from_stage, t.to_stage, t.actor]),
      [
        [null, 'DISCOVERED', 'agent:lead-hunting-agent'],
        ['DISCOVERED', 'CANDIDATE', 'agent:lead-hunting-agent'],
      ],
    );
    assert.ok(transitions[1].reason.includes(String(r1.lead.score)), transitions[1].reason);
    assert.ok(transitions[1].reason.includes('关注产品细节'), transitions[1].reason);
    assert.equal(decisions(ctx, r1.lead.id, 'lead_qualification').length, 0);

    const r2 = upsert(ctx, hz, user, commentSignal(ctx, user, '现在优惠多少', discountAsk(), 5));
    assert.deepEqual(r2.stage_changes, ['QUALIFIED']);
    assert.equal(r2.lead.stage, 'QUALIFIED');
    assert.ok(r2.lead.score >= 60);
    transitions = ctx.db.table('lead_stage_transitions').findMany({ lead_id: r1.lead.id }, { orderBy: 'at ASC' });
    assert.equal(transitions.length, 3);
    assert.deepEqual([transitions[2].from_stage, transitions[2].to_stage], ['CANDIDATE', 'QUALIFIED']);
    assert.ok(transitions[2].reason.includes(String(r2.lead.score)));
    assert.ok(transitions[2].reason.includes('询问优惠'), transitions[2].reason);

    const r3 = upsert(ctx, hz, user, commentSignal(ctx, user, '杭州i3 35L落地多少', landing(), 1));
    assert.deepEqual(r3.stage_changes, []);
    const qualification = decisions(ctx, r1.lead.id, 'lead_qualification');
    assert.equal(qualification.length, 1, 'lead_qualification recorded exactly once');
    assert.equal(qualification[0].agent, 'lead-hunting-agent');
    assert.equal(qualification[0].output.stage, 'QUALIFIED');
    assert.equal(qualification[0].output.score, r2.lead.score);
    assert.ok(Array.isArray(qualification[0].output.components) && (qualification[0].output.components as unknown[]).length > 0);
    assert.ok(qualification[0].evidence.length > 0);
    assert.equal(qualification[0].inputs.from_stage, 'CANDIDATE');
    assert.equal(decisions(ctx, r1.lead.id, 'lead_dedup_merge').length, 2);

    // the dealer tightens its thresholds: the lead's tier falls below qualified, but the stage is never demoted
    updateScoringConfig(ctx, hz, { thresholds: { qualified: 98, high_intent: 99, immediate: 100 } }, 'operator:tester');
    const r4 = upsert(ctx, hz, user, commentSignal(ctx, user, '后排怎么样', spaceAsk(), 1));
    assert.deepEqual(r4.stage_changes, []);
    assert.equal(r4.lead.stage, 'QUALIFIED');
    assert.ok(r4.lead.score < 98, `score ${r4.lead.score}`);
    assert.equal(r4.lead.tier, 'candidate');
    assert.equal(decisions(ctx, r1.lead.id, 'lead_qualification').length, 1);
  });

  it('jumps through CANDIDATE to QUALIFIED for a first strong signal and leaves terminal leads alone', () => {
    const { ctx, hz } = setup();
    const res = upsert(ctx, hz, 'u-funnel-002', commentSignal(ctx, 'u-funnel-002', '杭州i3 35L落地多少', landing(), 1));
    assert.deepEqual(res.stage_changes, ['CANDIDATE', 'QUALIFIED']);
    assert.equal(ctx.db.table('lead_stage_transitions').count({ lead_id: res.lead.id }), 3);
    assert.equal(decisions(ctx, res.lead.id, 'lead_qualification').length, 1);

    const lost = upsert(ctx, hz, 'u-funnel-003', commentSignal(ctx, 'u-funnel-003', '这车后排空间怎么样', spaceAsk(), 3));
    transitionLead(ctx, lost.lead.id, 'LOST', { reason: '测试流失', actor: 'operator:tester' });
    const after = upsert(ctx, hz, 'u-funnel-003', commentSignal(ctx, 'u-funnel-003', '杭州i3 35L落地多少', landing(), 1));
    assert.deepEqual(after.stage_changes, []);
    assert.equal(after.lead.stage, 'LOST');
  });
});

describe('lead-deduplication · group-level dealer matching (§5.3)', () => {
  it('moves an unassigned lead to the dealer where the new signal scores strictly higher', () => {
    const { ctx, hz, sh } = setup();
    const user = 'u-route-001';
    const first = upsert(ctx, hz, user, commentSignal(ctx, user, '这车后排空间怎么样', spaceAsk(), 6));
    const before: Lead = ctx.db.table('leads').require(first.lead.id);
    assert.equal(before.dealer_id, hz);

    const signal = commentSignal(ctx, user, '上海325Li现在落地多少', shanghaiLanding(), 2);
    const res = upsert(ctx, sh, user, signal);
    assert.equal(res.dealer_rerouted, true);
    assert.equal(res.lead.dealer_id, sh);
    const expected = scoreSignal(
      { detection: shanghaiLanding(), signal_at: signal.signal_at, now: ctx.clock.iso(), dealer: buildDealerProfile(ctx, sh), authenticity: authenticityFromEvidence(before.evidence) },
      getScoringConfig(ctx, sh),
    );
    assert.ok(expected.score > before.score);
    assert.equal(res.signal?.signal_score, expected.score);
    const event = ctx.audit.eventsFor('lead', res.lead.id).find((e) => e.action === 'lead.dealer_rerouted');
    assert.ok(event);
    assert.equal(event.details.from_dealer_id, hz);
    assert.equal(event.details.to_dealer_id, sh);
    const merge = decisions(ctx, res.lead.id, 'lead_dedup_merge').at(-1)!;
    assert.equal((merge.output.dealer_match as { moved: boolean }).moved, true);
    assert.equal(ctx.db.table('leads').count({ platform_user_id: user }), 1, 'still one lead in the group');
  });

  it('does not move a lead with an active assignment or when the new dealer does not score higher', () => {
    const { ctx, summary, hz, sh } = setup();
    const assigned = upsert(ctx, hz, 'u-route-002', commentSignal(ctx, 'u-route-002', '这车后排空间怎么样', spaceAsk(), 6));
    seedAssignment(ctx, { lead_id: assigned.lead.id, account_id: accountIdByPlatformId(summary, 'xhs-hz-sales-wang') });
    const signal = commentSignal(ctx, 'u-route-002', '上海325Li现在落地多少', shanghaiLanding(), 2);
    const res = upsert(ctx, sh, 'u-route-002', signal);
    assert.equal(res.dealer_rerouted, false);
    assert.equal(res.lead.dealer_id, hz);
    assert.ok(!ctx.audit.eventsFor('lead', res.lead.id).some((e) => e.action === 'lead.dealer_rerouted'));
    const match = decisions(ctx, res.lead.id, 'lead_dedup_merge').at(-1)!.output.dealer_match as { moved: boolean; reason: string; evaluated_signal_score: number };
    assert.equal(match.moved, false);
    assert.equal(match.reason, 'active_assignment');
    const leadDealerScore = scoreSignal(
      { detection: shanghaiLanding(), signal_at: signal.signal_at, now: ctx.clock.iso(), dealer: buildDealerProfile(ctx, hz), authenticity: authenticityFromEvidence(assigned.lead.evidence) },
      getScoringConfig(ctx, hz),
    );
    assert.equal(res.signal?.signal_score, leadDealerScore.score, 'stored score is comparable within the lead (scored for its dealer)');

    const strong = upsert(ctx, hz, 'u-route-003', commentSignal(ctx, 'u-route-003', '杭州i3 35L落地多少', landing(), 3));
    const weak = upsert(ctx, sh, 'u-route-003', commentSignal(ctx, 'u-route-003', '这车后排空间怎么样', spaceAsk(), 1));
    assert.equal(weak.dealer_rerouted, false);
    assert.equal(weak.lead.dealer_id, hz);
    assert.equal(strong.lead.dealer_id, hz);
    const weakMatch = decisions(ctx, weak.lead.id, 'lead_dedup_merge').at(-1)!.output.dealer_match as { reason: string };
    assert.equal(weakMatch.reason, 'score_not_higher');
  });
});

describe('lead-deduplication · skill', () => {
  it('runs through the skill registry', async () => {
    const { ctx, hz } = setup();
    const registry = new SkillRegistry().register(skill);
    const detection = landing();
    const out = await registry.invoke<UpsertLeadResult>(ctx, 'lead-deduplication', {
      dealer_id: hz,
      identity: { platform_user_id: 'u-skill-001', username: '看车的人' },
      signal: { source_type: 'import', content: '杭州i3 35L落地多少', signal_at: ago(ctx, 1), detection },
    });
    assert.equal(out.created, true);
    assert.equal(out.signal?.lead_id, out.lead.id);
    assert.equal(skill.agent, 'lead-hunting-agent');
    assert.equal(skill.category, 'acquisition');
    assert.equal(count(ctx, 'SELECT COUNT(*) AS n FROM lead_signals WHERE lead_id = ?', out.lead.id), 1);
  });
});
