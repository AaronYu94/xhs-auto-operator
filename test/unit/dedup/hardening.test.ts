import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PolicyError, ValidationError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import type { IntentDetection, PublicComment, PublicPost } from '../../../src/core/types.ts';
import {
  intentDetectionValidator,
  isPurchaseDetection,
  upsertLeadFromSignal,
  type SignalInput,
  type UpsertLeadResult,
} from '../../../src/skills/acquisition/lead-deduplication/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { accountIdByPlatformId, dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';

const HOUR_MS = 3_600_000;

function setup() {
  const ctx = createTestContext();
  const summary = loadDealerFixture(ctx);
  return { ctx, summary, hz: dealerIdByKey(summary, 'hz-bmw'), sh: dealerIdByKey(summary, 'sh-bmw') };
}

const ago = (ctx: TestContext, hours: number): string => new Date(ctx.clock.now().getTime() - hours * HOUR_MS).toISOString();

let seq = 0;
function insertPost(ctx: TestContext, title: string): PublicPost {
  const now = ctx.clock.iso();
  return ctx.db.table('public_posts').insert({
    id: newId('ppost'),
    platform: 'xiaohongshu',
    platform_post_id: `note-hardening-${++seq}`,
    xsec_token: null,
    url: null,
    title,
    content: '',
    author_platform_user_id: null,
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

function insertComment(ctx: TestContext, post: PublicPost, author: string, content: string): PublicComment {
  const now = ctx.clock.iso();
  return ctx.db.table('public_comments').insert({
    id: newId('pcmt'),
    platform: 'xiaohongshu',
    platform_comment_id: `c-hardening-${++seq}`,
    public_post_id: post.id,
    parent_comment_id: null,
    author_platform_user_id: author,
    author_nickname: null,
    content,
    ip_location: null,
    like_count: 0,
    published_at: now,
    prefilter_passed: true,
    prefilter_reason: 'keyword_hit',
    first_search_run_id: null,
    fetched_at: now,
    raw: {},
  });
}

const landing = (): IntentDetection => ({
  is_purchase_signal: true,
  intent: { brand: 'BMW', model: 'i3', trim: 'eDrive35L', location: '杭州', province: '浙江', price_intent: true, purchase_stage: 'active_shopping', confidence: 0.81 },
  evidence: [
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

const ningbo = (): IntentDetection => ({
  ...landing(),
  intent: { ...landing().intent, location: '宁波', province: '浙江', confidence: 0.7 },
  evidence: [{ code: 'stated_location', label: '同省买家（宁波）', quote: '宁波' }],
});

const inventoryAsk = (): IntentDetection => ({
  is_purchase_signal: true,
  intent: { brand: 'BMW', model: 'i3', inventory_intent: true, purchase_stage: 'active_shopping', inferred_fields: ['brand', 'model'], confidence: 0.58 },
  evidence: [{ code: 'inventory', label: '询问现车', quote: '有现车' }],
  transaction_questions: ['inventory'],
  strength: 1,
  negative: false,
  engine: 'rules',
  author_role: 'asker',
});

const spaceAsk = (): IntentDetection => ({
  is_purchase_signal: true,
  intent: { brand: 'BMW', model: 'i3', purchase_stage: 'research', inferred_fields: ['brand', 'model'], confidence: 0.55 },
  evidence: [{ code: 'product_research', label: '关注产品细节', quote: '后排空间' }],
  transaction_questions: [],
  strength: 0.2,
  negative: false,
  engine: 'rules',
  author_role: 'asker',
});

const shanghaiLanding = (): IntentDetection => ({
  is_purchase_signal: true,
  intent: { brand: 'BMW', model: '3 Series', trim: '325Li', location: '上海', province: '上海', price_intent: true, purchase_stage: 'active_shopping', confidence: 0.8 },
  evidence: [
    { code: 'specified_trim', label: '指定配置 325Li', quote: '325Li' },
    { code: 'stated_location', label: '本地买家（上海）', quote: '上海' },
  ],
  transaction_questions: ['landing_price'],
  strength: 1,
  negative: false,
  engine: 'rules',
  author_role: 'asker',
});

function importSignal(ctx: TestContext, content: string, detection: IntentDetection, hoursAgo = 1): SignalInput {
  return { source_type: 'import', content, signal_at: ago(ctx, hoursAgo), detection };
}

function commentSignal(ctx: TestContext, user: string, content: string, detection: IntentDetection, hoursAgo: number): SignalInput {
  const post = insertPost(ctx, '宝马i3现在值得买吗？');
  const comment = insertComment(ctx, post, user, content);
  return { source_type: 'comment', public_post_id: post.id, public_comment_id: comment.id, post_title: post.title, content, signal_at: ago(ctx, hoursAgo), detection };
}

function upsert(ctx: TestContext, dealerId: string, user: string, signal: SignalInput): UpsertLeadResult {
  return upsertLeadFromSignal(ctx, { dealer_id: dealerId, identity: { platform_user_id: user, username: '看车用户' }, signal });
}

const isPolicy = (code: string) => (err: unknown) => err instanceof PolicyError && err.code === code;

describe('lead-deduplication hardening · author roles are binding (§5.1)', () => {
  it('never lets an owner / creator / marketing / negative detection create a lead, even when flagged as a purchase signal', () => {
    const { ctx, hz } = setup();
    const inconsistent: [string, IntentDetection][] = [
      ['owner', { ...landing(), author_role: 'owner', evidence: [{ code: 'already_purchased', label: '已购车（非在市买家）', quote: '提车了' }] }],
      ['creator', { ...landing(), author_role: 'creator', evidence: [{ code: 'content_creator', label: '内容创作/经验分享（非本人购车询问）', quote: '攻略' }] }],
      ['marketing', { ...landing(), author_role: 'marketing' }],
      ['is_marketing', { ...landing(), author_role: 'asker', is_marketing: true }],
      ['negative', { ...landing(), negative: true }],
    ];
    for (const [name, detection] of inconsistent) {
      const user = `u-role-${name}`;
      assert.equal(isPurchaseDetection(detection), false, name);
      // a public comment (reply / import sources may create leads from non-purchase signals by design)
      assert.throws(() => upsert(ctx, hz, user, commentSignal(ctx, user, '杭州i3 35L落地多少', detection, 1)), isPolicy('not_a_purchase_signal'), name);
      assert.equal(intentDetectionValidator(detection, 'detection').is_purchase_signal, false, `${name} normalized to a non-purchase signal`);
    }
    assert.equal(ctx.db.table('leads').count(), 0);
    assert.equal(ctx.db.table('lead_signals').count(), 0);
  });

  it('stores such a detection on an existing lead as a non-purchase signal that never changes score, stage or intent', () => {
    const { ctx, hz } = setup();
    const user = 'u-role-existing';
    const first = upsert(ctx, hz, user, commentSignal(ctx, user, '这车后排空间怎么样', spaceAsk(), 6));
    const before = ctx.db.table('leads').require(first.lead.id);
    for (const detection of [
      { ...landing(), author_role: 'owner' as const },
      { ...landing(), negative: true },
      { ...landing(), is_marketing: true },
    ]) {
      const res = upsert(ctx, hz, user, importSignal(ctx, `杭州i3 35L落地多少 ${newId('x')}`, detection));
      assert.ok(res.signal);
      const row = ctx.db.table('lead_signals').require(res.signal.id);
      assert.equal(row.is_purchase_signal, false, 'persisted as non-purchase so re-scoring can never count it');
      assert.ok(row.signal_score <= 2, `non-signal formula, got ${row.signal_score}`);
      assert.deepEqual(res.stage_changes, []);
      const after = ctx.db.table('leads').require(first.lead.id);
      assert.equal(after.score, before.score);
      assert.equal(after.stage, before.stage);
      assert.deepEqual(after.intent, before.intent);
      assert.equal(after.primary_signal_id, first.signal!.id);
    }
  });
});

describe('lead-deduplication hardening · managed identities', () => {
  it('rejects the verified Xiaohongshu user id of a managed account (xhs_accounts.platform_user_id)', () => {
    const { ctx, summary, hz } = setup();
    const accountId = accountIdByPlatformId(summary, 'xhs-hz-sales-wang');
    ctx.db.table('xhs_accounts').update(accountId, { platform_user_id: '5f0c9e2a000000000100a1b2' });
    assert.throws(
      () => upsert(ctx, hz, '5f0c9e2a000000000100a1b2', importSignal(ctx, '杭州i3 35L落地多少', landing())),
      isPolicy('managed_account_identity'),
    );
    assert.equal(ctx.db.table('leads').count(), 0);
  });
});

describe('lead-deduplication hardening · signal time', () => {
  it('interprets timestamps without an offset in the dealer timezone, keeps explicit offsets and rejects malformed ones', () => {
    const { ctx, hz } = setup();
    const at = (signal_at: string, user: string) => upsert(ctx, hz, user, { ...importSignal(ctx, '杭州i3 35L落地多少', landing()), signal_at }).signal!.signal_at;
    assert.equal(at('2026-09-11 23:30', 'u-tz-1'), '2026-09-11T15:30:00.000Z', 'Asia/Shanghai wall clock');
    assert.equal(at('2026/09/11 08:05:09', 'u-tz-2'), '2026-09-11T00:05:09.000Z');
    assert.equal(at('2026-09-10', 'u-tz-3'), '2026-09-09T16:00:00.000Z', 'date-only = local midnight');
    assert.equal(at('2026-09-11T23:30:00+08:00', 'u-tz-4'), '2026-09-11T15:30:00.000Z');
    assert.equal(at('2026-09-11T15:30:00Z', 'u-tz-5'), '2026-09-11T15:30:00.000Z');

    const dealer = ctx.db.table('dealers').require(hz);
    ctx.db.table('dealers').update(hz, { settings: { ...dealer.settings, timezone: 'Asia/Tokyo' } });
    assert.equal(at('2026-09-11 23:30', 'u-tz-6'), '2026-09-11T14:30:00.000Z', 'uses the dealer timezone setting');

    for (const bad of ['Sat Sep 12 2026 10:00:00', '2026-13-01 10:00', '2026-02-30', '12/09/2026', '2026-09-11 25:00']) {
      assert.throws(() => at(bad, `u-tz-bad-${bad}`), ValidationError, bad);
    }
  });

  it('rejects signals dated in the future beyond clock skew', () => {
    const { ctx, hz } = setup();
    const future = new Date(ctx.clock.now().getTime() + 2 * HOUR_MS).toISOString();
    assert.throws(() => upsert(ctx, hz, 'u-future', { ...importSignal(ctx, '杭州i3 35L落地多少', landing()), signal_at: future }), ValidationError);
    assert.equal(ctx.db.table('leads').count(), 0);
    const skew = new Date(ctx.clock.now().getTime() + 5 * 60_000).toISOString();
    assert.equal(upsert(ctx, hz, 'u-skew', { ...importSignal(ctx, '杭州i3 35L落地多少', landing()), signal_at: skew }).created, true);
  });
});

describe('lead-deduplication hardening · chronological merge', () => {
  it('lets the latest stated location win when an older signal arrives after a newer one without a location', () => {
    const { ctx, hz } = setup();
    const user = 'u-order-001';
    upsert(ctx, hz, user, commentSignal(ctx, user, '杭州i3 35L落地多少', landing(), 48));
    upsert(ctx, hz, user, commentSignal(ctx, user, '有现车吗', inventoryAsk(), 1));
    const late = upsert(ctx, hz, user, commentSignal(ctx, user, '宁波i3 35L落地多少', ningbo(), 24));
    assert.equal(late.lead.intent.location, '宁波');
    assert.equal(late.lead.intent.province, '浙江');
    assert.equal(late.lead.intent.inventory_intent, true);
  });

  it('produces the same merged intent whatever order the signals are ingested in', () => {
    const { ctx, hz } = setup();
    const specs: [string, () => IntentDetection, number][] = [
      ['杭州i3 35L落地多少', landing, 48],
      ['宁波i3 35L落地多少', ningbo, 24],
      ['有现车吗', inventoryAsk, 1],
    ];
    const orders = [
      [0, 1, 2],
      [2, 1, 0],
      [1, 2, 0],
      [2, 0, 1],
    ];
    const intents = orders.map((order, i) => {
      const user = `u-order-perm-${i}`;
      let last: UpsertLeadResult | null = null;
      for (const idx of order) {
        const [content, detection, hours] = specs[idx];
        last = upsert(ctx, hz, user, commentSignal(ctx, user, content, detection(), hours));
      }
      return ctx.db.table('leads').require(last!.lead.id).intent;
    });
    for (const intent of intents.slice(1)) assert.deepEqual(intent, intents[0]);
    assert.equal(intents[0].location, '宁波');
  });
});

describe('lead-deduplication hardening · provenance', () => {
  it('fills the note id and title of a comment signal from the stored comment', () => {
    const { ctx, hz } = setup();
    const user = 'u-prov-001';
    const post = insertPost(ctx, '宝马i3现在值得买吗？');
    const comment = insertComment(ctx, post, user, '杭州i3 35L落地多少');
    const res = upsert(ctx, hz, user, { source_type: 'comment', public_comment_id: comment.id, content: comment.content, signal_at: ago(ctx, 2), detection: landing() });
    assert.equal(res.signal?.public_post_id, post.id);
    assert.equal(res.signal?.post_title, '宝马i3现在值得买吗？');
    assert.equal(upsert(ctx, hz, user, { source_type: 'comment', public_comment_id: comment.id, content: comment.content, signal_at: ago(ctx, 2), detection: landing() }).duplicate, true);
  });

  it('drops IP-verified local-user evidence that no longer holds when the lead is rerouted to a dealer in another province', () => {
    const { ctx, hz, sh } = setup();
    const user = 'u-prov-route';
    const first = upsert(ctx, hz, user, commentSignal(ctx, user, '这车后排空间怎么样', spaceAsk(), 6));
    const verified = { code: 'verified_local_user', label: '本地真实用户（IP属地 浙江）', quote: '浙江', source_ref: `profile:${user}` };
    ctx.db.table('leads').update(first.lead.id, { evidence: [...first.lead.evidence, verified] });
    const res = upsert(ctx, sh, user, commentSignal(ctx, user, '上海325Li现在落地多少', shanghaiLanding(), 2));
    assert.equal(res.dealer_rerouted, true);
    const lead = ctx.db.table('leads').require(first.lead.id);
    assert.equal(lead.dealer_id, sh);
    assert.ok(!lead.evidence.some((e) => e.code === 'verified_local_user'), 'Zhejiang IP is not local to the Shanghai dealer');
    const event = ctx.audit.eventsFor('lead', lead.id).find((e) => e.action === 'lead.dealer_rerouted');
    assert.deepEqual(event?.details.removed_evidence, ['verified_local_user']);
  });
});
