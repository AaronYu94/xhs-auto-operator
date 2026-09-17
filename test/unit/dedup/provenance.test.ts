/**
 * ARCHITECTURE §10.1–10.2 provenance persisted by lead-deduplication itself, so EVERY signal path (discovery, lead
 * research, replies, 聚光 imports, direct callers) stores the actor classification and the data mode.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { newId } from '../../../src/core/ids.ts';
import type { DataMode, IntentDetection, PublicComment, PublicPost } from '../../../src/core/types.ts';
import { upsertLeadFromSignal } from '../../../src/skills/acquisition/lead-deduplication/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';

const HOUR_MS = 3_600_000;
const ago = (ctx: TestContext, hours: number) => new Date(ctx.clock.now().getTime() - hours * HOUR_MS).toISOString();

function setup() {
  const ctx = createTestContext();
  const summary = loadDealerFixture(ctx);
  return { ctx, hz: dealerIdByKey(summary, 'hz-bmw') };
}

let seq = 0;
function post(ctx: TestContext, mode: DataMode, title = '宝马i3现在值得买吗？'): PublicPost {
  const now = ctx.clock.iso();
  return ctx.db.table('public_posts').insert({
    id: newId('ppost'),
    platform: 'xiaohongshu',
    platform_post_id: `note-prov-${++seq}`,
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
    data_mode: mode,
    own_post_id: null,
    first_search_run_id: null,
    fetched_at: now,
    raw: {},
  });
}

function comment(ctx: TestContext, p: PublicPost, author: string, content: string, mode: DataMode): PublicComment {
  const now = ctx.clock.iso();
  return ctx.db.table('public_comments').insert({
    id: newId('pcmt'),
    platform: 'xiaohongshu',
    platform_comment_id: `c-prov-${++seq}`,
    public_post_id: p.id,
    parent_comment_id: null,
    author_platform_user_id: author,
    author_nickname: null,
    content,
    ip_location: '浙江',
    like_count: 0,
    published_at: now,
    data_mode: mode,
    prefilter_passed: true,
    prefilter_reason: 'keyword_hit',
    first_search_run_id: null,
    fetched_at: now,
    raw: {},
  });
}

const buyer = (quote: string): IntentDetection => ({
  is_purchase_signal: true,
  intent: { brand: 'BMW', model: 'i3', inventory_intent: true, purchase_stage: 'active_shopping', location: '杭州', province: '浙江' },
  evidence: [{ code: 'inventory', label: '询问现车', quote }],
  transaction_questions: ['inventory'],
  strength: 1,
  negative: false,
  engine: 'rules',
  author_role: 'asker',
});

const owner = (quote: string): IntentDetection => ({
  is_purchase_signal: false,
  intent: { brand: 'BMW', model: 'i3' },
  evidence: [{ code: 'already_purchased', label: '已购车', quote }],
  transaction_questions: [],
  strength: 0,
  negative: true,
  engine: 'rules',
  author_role: 'owner',
});

describe('lead-deduplication: provenance (actor type + data mode)', () => {
  it('a live buyer comment stores actor BUYER on the signal and a live lead', () => {
    const { ctx, hz } = setup();
    const p = post(ctx, 'live');
    const c = comment(ctx, p, 'u-prov-live', '杭州i3有现车吗', 'live');
    const r = upsertLeadFromSignal(ctx, {
      dealer_id: hz,
      identity: { platform_user_id: 'u-prov-live', username: '真实用户' },
      signal: { source_type: 'comment', public_post_id: p.id, public_comment_id: c.id, post_title: p.title, content: c.content, signal_at: ago(ctx, 2), detection: buyer('有现车吗') },
    });
    assert.equal(r.signal?.actor_type, 'BUYER');
    assert.equal(r.lead.actor_type, 'BUYER');
    assert.equal(r.lead.data_mode, 'live');
  });

  it('an imported lead is upgraded to live by a live signal and never downgraded afterwards', () => {
    const { ctx, hz } = setup();
    const imported = post(ctx, 'import');
    const c1 = comment(ctx, imported, 'u-prov-mix', 'i3有现车吗', 'import');
    const first = upsertLeadFromSignal(ctx, {
      dealer_id: hz,
      identity: { platform_user_id: 'u-prov-mix', username: '导入用户' },
      signal: { source_type: 'comment', public_post_id: imported.id, public_comment_id: c1.id, content: c1.content, signal_at: ago(ctx, 5), detection: buyer('有现车吗') },
    });
    assert.equal(first.lead.data_mode, 'import');

    const live = post(ctx, 'live', '杭州i3落地价');
    const c2 = comment(ctx, live, 'u-prov-mix', '杭州i3白色有现车吗', 'live');
    const second = upsertLeadFromSignal(ctx, {
      dealer_id: hz,
      identity: { platform_user_id: 'u-prov-mix', username: '导入用户' },
      signal: { source_type: 'comment', public_post_id: live.id, public_comment_id: c2.id, content: c2.content, signal_at: ago(ctx, 3), detection: buyer('有现车吗') },
    });
    assert.equal(second.lead.data_mode, 'live', 'a live signal upgrades the lead');

    const later = post(ctx, 'import', 'i3贷款');
    const c3 = comment(ctx, later, 'u-prov-mix', 'i3现车还有吗', 'import');
    const third = upsertLeadFromSignal(ctx, {
      dealer_id: hz,
      identity: { platform_user_id: 'u-prov-mix', username: '导入用户' },
      signal: { source_type: 'comment', public_post_id: later.id, public_comment_id: c3.id, content: c3.content, signal_at: ago(ctx, 1), detection: buyer('现车') },
    });
    assert.equal(third.lead.data_mode, 'live', 'never downgraded');
  });

  it('replies without public rows are manual; an explicit data_mode wins', () => {
    const { ctx, hz } = setup();
    const reply = upsertLeadFromSignal(ctx, {
      dealer_id: hz,
      identity: { platform_user_id: 'u-prov-reply', username: '私信用户' },
      signal: { source_type: 'reply', content: 'i3有现车吗', signal_at: ago(ctx, 1), detection: buyer('有现车吗') },
    });
    assert.equal(reply.lead.data_mode, 'manual');

    const pushed = upsertLeadFromSignal(ctx, {
      dealer_id: hz,
      identity: { platform_user_id: 'u-prov-import', username: '聚光留资' },
      signal: { source_type: 'import', content: 'i3有现车吗', signal_at: ago(ctx, 1), detection: buyer('有现车吗'), data_mode: 'import' },
    });
    assert.equal(pushed.lead.data_mode, 'import');
    assert.equal(pushed.signal?.actor_type, 'BUYER');
  });

  it('an owner remark on a buyer lead is stored as OWNER but the person stays a BUYER; industry evidence → DEALER_OR_SALES', () => {
    const { ctx, hz } = setup();
    const p = post(ctx, 'live');
    const c = comment(ctx, p, 'u-prov-owner', 'i3有现车吗', 'live');
    upsertLeadFromSignal(ctx, {
      dealer_id: hz,
      identity: { platform_user_id: 'u-prov-owner', username: '车主' },
      signal: { source_type: 'comment', public_post_id: p.id, public_comment_id: c.id, content: c.content, signal_at: ago(ctx, 4), detection: buyer('有现车吗') },
    });
    const c2 = comment(ctx, p, 'u-prov-owner', '提车了，开了一周', 'live');
    const r = upsertLeadFromSignal(ctx, {
      dealer_id: hz,
      identity: { platform_user_id: 'u-prov-owner', username: '车主' },
      signal: { source_type: 'comment', public_post_id: p.id, public_comment_id: c2.id, content: c2.content, signal_at: ago(ctx, 2), detection: owner('提车了') },
    });
    assert.equal(r.signal?.actor_type, 'OWNER');
    assert.equal(r.lead.actor_type, 'BUYER', 'BUYER once any buyer signal exists');

    ctx.db.table('leads').update(r.lead.id, { evidence: [...r.lead.evidence, { code: 'industry_account', label: '疑似车商/销售账号', quote: '4S店销售' }] });
    const c3 = comment(ctx, p, 'u-prov-owner', 'i3还有现车吗', 'live');
    const after = upsertLeadFromSignal(ctx, {
      dealer_id: hz,
      identity: { platform_user_id: 'u-prov-owner', username: '车主' },
      signal: { source_type: 'comment', public_post_id: p.id, public_comment_id: c3.id, content: c3.content, signal_at: ago(ctx, 1), detection: buyer('现车') },
    });
    assert.equal(after.lead.actor_type, 'DEALER_OR_SALES');
  });
});
