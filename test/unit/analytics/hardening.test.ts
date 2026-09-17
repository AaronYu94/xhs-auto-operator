/**
 * Adversarial hardening of the analytics module: runs the real NLU → lead-deduplication → fleet-controller chain over the
 * simulation corpus and checks what a salesperson actually sees, plus targeted regression tests for defects found.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppContext } from '../../../src/app/context.ts';
import { ValidationError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import type { Lead, LeadSignal, Post, PublicComment, PublicPost } from '../../../src/core/types.ts';
import { buildDealerProfile } from '../../../src/domain/dealer-profile.ts';
import type { XhsComment } from '../../../src/providers/xhs/types.ts';
import { SimulationXhsProvider } from '../../../src/providers/xhs/simulation.ts';
import { assignLead } from '../../../src/skills/acquisition/account-assignment/index.ts';
import { detectIntentRules } from '../../../src/skills/acquisition/intent-detection/nlu.ts';
import { upsertLeadFromSignal } from '../../../src/skills/acquisition/lead-deduplication/index.ts';
import {
  buildLeadCard,
  getAccountsOverview,
  getContentAttribution,
  getDashboard,
  getLeadDetail,
  getLeadInbox,
  intentChips,
  locationLabel,
} from '../../../src/skills/operations/analytics/index.ts';
import { TEST_NOW, createTestContext } from '../../helpers/context.ts';
import { accountIdByPlatformId, dealerIdByKey, loadDealerFixture, seedLead } from '../../helpers/fixtures.ts';

/** Labels of prefilter outcomes — they explain why text was NOT a purchase signal. */
const NOISE_LABELS = ['空内容/仅表情', '纯夸赞，无购车意图', '内容过短', '无购车相关信号'];
const WARNING_CODES = ['already_purchased', 'content_creator', 'marketing_account', 'industry_account', 'not_interested', 'negative_feedback'];

interface CorpusNote {
  platform_post_id: string;
  xsec_token: string;
}

const flatten = (comments: readonly XhsComment[], out: XhsComment[] = []): XhsComment[] => {
  for (const c of comments) {
    out.push(c);
    if (c.sub_comments) flatten(c.sub_comments, out);
  }
  return out;
};

function ownPost(ctx: AppContext, dealerId: string, accountId: string, noteId: string, model: string): Post {
  return ctx.db.table('posts').insert({
    id: newId('post'),
    dealer_id: dealerId,
    account_id: accountId,
    plan_id: null,
    slot_date: '2026-09-09',
    pillar: 'inventory_showcase',
    topic: `${model}:inventory_showcase:hangzhou`,
    angle: '',
    model,
    title: noteId,
    body: '',
    tags: [],
    cover_text: '',
    fact_refs: [],
    status: 'PUBLISHED',
    review: null,
    approval_policy: 'REVIEW_REQUIRED',
    platform_note_id: noteId,
    scheduled_for: null,
    published_at: '2026-09-09T02:00:00.000Z',
    metrics: { views: 100, likes: 10, collects: 2, comments: 5, shares: 1 },
    metrics_updated_at: TEST_NOW,
    engine: 'rules',
    created_at: TEST_NOW,
    updated_at: TEST_NOW,
  });
}

/** Ingest every corpus note + comment through the real rules NLU, lead dedup/scoring and the fleet controller. */
async function corpusSetup() {
  const xhs = SimulationXhsProvider.fromFile(createTestContext().clock);
  const ctx = createTestContext({ xhs });
  const s = loadDealerFixture(ctx);
  const hz = dealerIdByKey(s, 'hz-bmw');
  const profile = buildDealerProfile(ctx, hz);
  const own = new Map<string, Post>([
    ['note-own-hz-i3-001', ownPost(ctx, hz, accountIdByPlatformId(s, 'xhs-hz-i3'), 'note-own-hz-i3-001', 'i3')],
    ['note-own-hz-x3-001', ownPost(ctx, hz, accountIdByPlatformId(s, 'xhs-hz-sales-li'), 'note-own-hz-x3-001', 'X3')],
  ]);
  const { readFileSync } = await import('node:fs');
  const corpus = JSON.parse(readFileSync(new URL('../../../fixtures/xhs/simulation-corpus.json', import.meta.url), 'utf8')) as { notes: CorpusNote[] };

  const upsert = (input: Parameters<typeof upsertLeadFromSignal>[1]) => {
    try {
      const res = upsertLeadFromSignal(ctx, input);
      if (['qualified', 'high_intent', 'immediate'].includes(res.lead.tier)) assignLead(ctx, res.lead.id);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'not_a_purchase_signal' && code !== 'managed_account_identity') throw err;
    }
  };

  for (const n of corpus.notes) {
    const ref = { platform_post_id: n.platform_post_id, xsec_token: n.xsec_token };
    const note = await xhs.getNote(ref);
    assert.ok(note.ok, `simulation note ${n.platform_post_id}`);
    const d = note.data;
    const ownPostId = own.get(d.platform_post_id)?.id ?? null;
    const pp = ctx.db.table('public_posts').insert({
      id: newId('ppost'),
      platform: 'xiaohongshu',
      platform_post_id: d.platform_post_id,
      xsec_token: d.xsec_token ?? null,
      url: d.url ?? null,
      title: d.title,
      content: d.content,
      author_platform_user_id: d.author.platform_user_id,
      author_nickname: d.author.nickname,
      author_profile_url: null,
      ip_location: d.ip_location,
      tags: d.tags,
      like_count: d.like_count,
      comment_count: d.comment_count,
      collect_count: d.collect_count,
      published_at: d.published_at ?? null,
      own_post_id: ownPostId,
      first_search_run_id: null,
      fetched_at: TEST_NOW,
      raw: {},
    });
    if (d.author.platform_user_id) {
      const text = `${d.title}\n${d.content}`;
      upsert({
        dealer_id: hz,
        identity: { platform_user_id: d.author.platform_user_id, username: d.author.nickname ?? '' },
        signal: {
          source_type: 'post',
          public_post_id: pp.id,
          post_title: d.title,
          content: text,
          signal_at: d.published_at ?? TEST_NOW,
          detection: detectIntentRules(text, { source_type: 'post', ip_location: d.ip_location, author_nickname: d.author.nickname }, profile),
        },
        attributed_post_id: ownPostId,
      });
    }
    const comments = await xhs.getComments(ref, { include_replies: true, limit: 500 });
    assert.ok(comments.ok);
    for (const c of flatten(comments.data)) {
      const pc = ctx.db.table('public_comments').insert({
        id: newId('pcmt'),
        platform: 'xiaohongshu',
        platform_comment_id: c.platform_comment_id,
        public_post_id: pp.id,
        parent_comment_id: c.parent_comment_id,
        author_platform_user_id: c.author.platform_user_id,
        author_nickname: c.author.nickname,
        content: c.content,
        ip_location: c.ip_location,
        like_count: c.like_count,
        published_at: c.published_at,
        prefilter_passed: true,
        prefilter_reason: '',
        first_search_run_id: null,
        fetched_at: TEST_NOW,
        raw: {},
      });
      if (!c.author.platform_user_id) continue;
      const context = { source_type: 'comment' as const, post_title: d.title, post_content: d.content, ip_location: c.ip_location, author_nickname: c.author.nickname };
      upsert({
        dealer_id: hz,
        identity: { platform_user_id: c.author.platform_user_id, username: c.author.nickname ?? '' },
        signal: {
          source_type: 'comment',
          public_post_id: pp.id,
          public_comment_id: pc.id,
          post_title: d.title,
          content: c.content,
          signal_at: c.published_at ?? TEST_NOW,
          detection: detectIntentRules(c.content, context, profile),
        },
        attributed_post_id: ownPostId,
      });
    }
  }
  const leadOf = (platformUserId: string): Lead => {
    const lead = ctx.db.table('leads').findOne({ platform_user_id: platformUserId });
    assert.ok(lead, `lead for ${platformUserId}`);
    return lead;
  };
  return { ctx, s, hz, own, leadOf };
}

function signalsOf(ctx: AppContext, leadId: string): LeadSignal[] {
  return ctx.db.table('lead_signals').findMany({ lead_id: leadId });
}

describe('analytics hardening: real corpus through NLU, dedup and fleet controller', () => {
  it('every inbox card keeps provenance, owner and honest location, with intent chips led by the primary signal', async () => {
    const { ctx, hz } = await corpusSetup();
    const cards = getLeadInbox(ctx, { dealer_id: hz, limit: 500 });
    assert.ok(cards.length >= 15, `expected a realistic inbox, got ${cards.length}`);
    for (const card of cards) {
      const lead = ctx.db.table('leads').require(card.lead_id);
      const signals = signalsOf(ctx, lead.id);
      const primary = signals.find((sig) => sig.id === card.original_signal_id);
      assert.ok(primary, `${card.username}: original signal must be a stored signal of the lead`);
      assert.equal(card.original_signal, primary.content);
      assert.ok(card.source.url?.startsWith('https://www.xiaohongshu.com/explore/'), `${card.username}: source link`);
      if (lead.stage === 'ASSIGNED') assert.ok(card.assigned_account, `${card.username}: owner shown`);

      for (const chip of card.intent_chips) assert.ok(!NOISE_LABELS.includes(chip), `${card.username}: noise chip ${chip}`);
      assert.ok(card.intent_chips.length > 0 && card.intent_chips.length <= 6, `${card.username}: 1..6 chips`);
      // warnings (already purchased, creator, industry, refused) may precede; right after them the primary signal explains the lead
      const warningLabels = new Set(
        [...lead.evidence, ...signals.flatMap((sig) => sig.evidence)].filter((e) => WARNING_CODES.includes(e.code)).map((e) => e.label),
      );
      const primaryLabels = [...new Set(primary.evidence.map((e) => e.label))].filter((l) => !NOISE_LABELS.includes(l) && !warningLabels.has(l));
      const chipsAfterWarnings = card.intent_chips.filter((c) => !warningLabels.has(c));
      const shown = Math.min(primaryLabels.length, chipsAfterWarnings.length);
      assert.deepEqual(chipsAfterWarnings.slice(0, shown), primaryLabels.slice(0, shown), `${card.username}: primary-signal evidence leads the chips`);

      const inferred = new Set(lead.intent.inferred_fields ?? []);
      if (!lead.intent.location && lead.intent.province && inferred.has('province'))
        assert.equal(card.location_label, `IP属地：${lead.intent.province}`, `${card.username}: IP-inferred province is not a stated location`);
      if (lead.intent.location && !inferred.has('location')) assert.equal(card.location_label, lead.intent.location);
    }
  });

  it('shows the strongest (inventory) evidence for a multi-signal buyer and drops remarks that are not purchase signals', async () => {
    const { ctx, hz, leadOf } = await corpusSetup();
    const buyer = leadOf('u-hz-buyer-001');
    const card = buildLeadCard(ctx, buyer);
    assert.equal(card.original_signal, '杭州i3 35L白外红内有现车吗？这周想去看看');
    assert.equal(card.location_label, '杭州');
    assert.ok(card.intent_chips.includes('询问现车'), card.intent_chips.join('/'));
    assert.ok(card.intent_chips.includes('想到店看车'), card.intent_chips.join('/'));
    assert.ok(!card.intent_chips.includes('无购车相关信号'), 'the café remark is history, not intent');
    assert.equal(card.assigned_account?.nickname, '销售小王·杭州宝马');

    const lurker = buildLeadCard(ctx, leadOf('u-noise-002')); // many "蹲" remarks + one "蹲一个价格"
    assert.equal(lurker.location_label, 'IP属地：湖北');
    for (const noise of [...NOISE_LABELS, '本地买家（杭州）'])
      assert.ok(!lurker.intent_chips.includes(noise), `lurker chips must not include ${noise}: ${lurker.intent_chips.join('/')}`);

    const ownNoteBuyer = buildLeadCard(ctx, leadOf('u-hz-buyer-002'));
    assert.equal(ownNoteBuyer.location_label, 'IP属地：浙江', 'IP 属地 only — never shown as a stated 浙江 buyer');

    const d = getDashboard(ctx, { dealer_id: hz });
    const qualifiedNow = ctx.db.get<{ n: number }>(
      `SELECT COUNT(DISTINCT lead_id) AS n FROM lead_stage_transitions t JOIN leads l ON l.id = t.lead_id
       WHERE l.dealer_id = ? AND t.to_stage = 'QUALIFIED'`,
      hz,
    )?.n;
    assert.equal(d.discovery.qualified, qualifiedNow);
    assert.ok(d.discovery.candidates >= d.discovery.qualified && d.discovery.qualified >= d.discovery.high_intent);
  });

  it('attributes comments on our own notes without counting our own accounts (legacy key or verified Xiaohongshu id)', async () => {
    const { ctx, s, own } = await corpusSetup();
    const li = accountIdByPlatformId(s, 'xhs-hz-sales-li');
    const x3Post = own.get('note-own-hz-x3-001') as Post;
    const before = getContentAttribution(ctx).find((r) => r.post_id === x3Post.id);
    assert.ok(before && before.leads > 0 && before.comments_collected > 0);

    ctx.db.table('xhs_accounts').update(li, { platform_user_id: '5f1e0c0000000000010ab123' });
    const pp = ctx.db.table('public_posts').findOne({ own_post_id: x3Post.id }) as PublicPost;
    const reply = (author: string, id: string): PublicComment =>
      ctx.db.table('public_comments').insert({
        id: newId('pcmt'),
        platform: 'xiaohongshu',
        platform_comment_id: id,
        public_post_id: pp.id,
        parent_comment_id: null,
        author_platform_user_id: author,
        author_nickname: '李姐聊宝马',
        content: '已私信您，白色25L还有现车',
        ip_location: '浙江',
        like_count: 0,
        published_at: TEST_NOW,
        prefilter_passed: false,
        prefilter_reason: 'marketing_account',
        first_search_run_id: null,
        fetched_at: TEST_NOW,
        raw: {},
      });
    reply('5f1e0c0000000000010ab123', 'c-own-reply-live');
    reply('xhs-hz-sales-li', 'c-own-reply-legacy');

    const after = getContentAttribution(ctx).find((r) => r.post_id === x3Post.id);
    assert.ok(after);
    assert.equal(after.commenter_profiles, before.commenter_profiles, 'our own account is not a commenter profile');
    assert.equal(after.comments_collected, before.comments_collected, 'our own replies are not collected customer comments');
  });
});

describe('analytics hardening: targeted regressions', () => {
  function base() {
    const ctx = createTestContext();
    const s = loadDealerFixture(ctx);
    return { ctx, s, hz: dealerIdByKey(s, 'hz-bmw'), sh: dealerIdByKey(s, 'sh-bmw') };
  }

  function publicPost(ctx: AppContext, id: string, url: string): PublicPost {
    return ctx.db.table('public_posts').insert({
      id: newId('ppost'),
      platform: 'xiaohongshu',
      platform_post_id: id,
      xsec_token: null,
      url,
      title: 'X3和GLC怎么选',
      content: '',
      author_platform_user_id: 'u-author-9',
      author_nickname: '作者',
      author_profile_url: null,
      ip_location: '上海',
      tags: [],
      like_count: 0,
      comment_count: 1,
      collect_count: 0,
      published_at: '2026-09-01T02:00:00.000Z',
      own_post_id: null,
      first_search_run_id: null,
      fetched_at: TEST_NOW,
      raw: {},
    });
  }

  it('resolves the source note of a signal that only carries its comment id (card link + detail row)', () => {
    const { ctx, hz } = base();
    const pp = publicPost(ctx, 'note-x3-glc-777', 'https://www.xiaohongshu.com/explore/note-x3-glc-777');
    const pc = ctx.db.table('public_comments').insert({
      id: newId('pcmt'),
      platform: 'xiaohongshu',
      platform_comment_id: 'c-777',
      public_post_id: pp.id,
      parent_comment_id: null,
      author_platform_user_id: 'u-777',
      author_nickname: '选车中',
      content: 'X3 25L有白色现车吗',
      ip_location: '浙江',
      like_count: 0,
      published_at: TEST_NOW,
      prefilter_passed: true,
      prefilter_reason: 'keyword_hit',
      first_search_run_id: null,
      fetched_at: TEST_NOW,
      raw: {},
    });
    let lead = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-777' });
    const sig = ctx.db.table('lead_signals').insert({
      id: newId('sig'),
      lead_id: lead.id,
      source_type: 'comment',
      public_post_id: null,
      public_comment_id: pc.id,
      post_title: null,
      content: pc.content,
      signal_at: TEST_NOW,
      search_run_id: null,
      query_id: null,
      intent: {},
      signal_score: 80,
      evidence: [],
      engine: 'rules',
      is_purchase_signal: true,
      strength: 1,
      transaction_questions: ['inventory'],
      author_role: 'asker',
      created_at: TEST_NOW,
    });
    lead = ctx.db.table('leads').update(lead.id, { primary_signal_id: sig.id });
    const card = buildLeadCard(ctx, lead);
    assert.deepEqual(card.source, { type: 'comment', post_title: 'X3和GLC怎么选', url: 'https://www.xiaohongshu.com/explore/note-x3-glc-777', signal_at: TEST_NOW });
    assert.equal(card.location_label, 'IP属地：浙江', "commenter's IP, never the note author's 上海");
    const detail = getLeadDetail(ctx, lead.id);
    assert.equal(detail.signals[0].public_post?.id, pp.id);
    assert.equal(detail.signals[0].public_comment?.id, pc.id);
  });

  it('credits a won lead to exactly one post when the conversion names a different post than the lead', () => {
    const { ctx, s, hz } = base();
    const official = accountIdByPlatformId(s, 'xhs-hz-official');
    const mk = (title: string, publishedAt: string) => {
      const post = ownPost(ctx, hz, official, `note-won-${title}`, 'X3');
      return ctx.db.table('posts').update(post.id, { title, published_at: publishedAt });
    };
    const A = mk('A', '2026-09-01T02:00:00.000Z');
    const B = mk('B', '2026-09-02T02:00:00.000Z');
    let won = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-won-9', stage: 'WON' });
    won = ctx.db.table('leads').update(won.id, { attributed_post_id: A.id });
    ctx.db.table('conversions').insert({
      id: newId('cvn'),
      lead_id: won.id,
      dealer_id: hz,
      outcome: 'won',
      vehicle_id: null,
      amount: 389_900,
      lost_reason: null,
      attributed_post_id: B.id,
      attributed_query_id: null,
      account_id: official,
      occurred_at: TEST_NOW,
    });
    const rows = getContentAttribution(ctx, { dealer_id: hz });
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r]));
    assert.equal(byTitle.B.won, 1);
    assert.equal(byTitle.B.won_value, 389_900);
    assert.equal(byTitle.A.won, 0, 'the sale is credited once, to the post recorded on the conversion');
    assert.equal(byTitle.A.leads, 1);
    assert.equal(rows.reduce((sum, r) => sum + r.won, 0), 1);
  });

  it('rejects an account filter that does not belong to the dealer filter (instead of mixing two scopes)', () => {
    const { ctx, s, hz, sh } = base();
    const zhao = accountIdByPlatformId(s, 'xhs-sh-sales-zhao');
    assert.throws(() => getDashboard(ctx, { dealer_id: hz, account_id: zhao }), ValidationError);
    assert.throws(() => getLeadInbox(ctx, { dealer_id: hz, account_id: zhao }), ValidationError);
    assert.equal(getDashboard(ctx, { dealer_id: sh, account_id: zhao }).accounts.requiring_attention.length, 1);
  });

  it('never reports a persona name for an account whose persona does not exist', () => {
    const { ctx, s, hz } = base();
    const li = accountIdByPlatformId(s, 'xhs-hz-sales-li');
    const persona = ctx.db.table('account_personas').findOne({ account_id: li });
    assert.ok(persona);
    ctx.db.table('account_personas').delete(persona.id);
    const row = getAccountsOverview(ctx, hz).find((r) => r.account_id === li);
    assert.equal(row?.persona_name, null);
    assert.equal(row?.nickname, '李姐聊宝马');
  });

  it('normalizes full-width filter text even for models outside the lexicon', () => {
    const { ctx, hz } = base();
    const lead = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-fw-1' });
    ctx.db.table('leads').update(lead.id, { intent: { brand: 'BMW', model: 'M760Li', location: '杭州', province: '浙江' } });
    assert.deepEqual(getLeadInbox(ctx, { dealer_id: hz, model: 'Ｍ７６０Ｌｉ' }).map((c) => c.lead_id), [lead.id]);
    assert.deepEqual(getLeadInbox(ctx, { dealer_id: hz, brand: 'ＢＭＷ', location: '杭州　' }).map((c) => c.lead_id), [lead.id]);
  });

  it('label helpers distinguish stated, IP-inferred and inferred locations and drop prefilter noise', () => {
    assert.equal(locationLabel({ province: '浙江', inferred_fields: ['province'] }, null), 'IP属地：浙江');
    assert.equal(locationLabel({ province: '浙江', inferred_fields: ['province'] }, '浙江'), 'IP属地：浙江');
    assert.equal(locationLabel({ location: '杭州', province: '浙江', inferred_fields: ['location', 'province'] }, null), '杭州（推断）');
    assert.equal(locationLabel({ location: '宁波', province: '浙江', inferred_fields: ['province'] }, '上海'), '宁波');
    assert.equal(locationLabel({ province: '上海' }, '浙江'), '上海');
    assert.deepEqual(
      intentChips([
        { code: 'no_signal', label: '无购车相关信号' },
        { code: 'pure_praise', label: '纯夸赞，无购车意图' },
        { code: 'inventory', label: '询问现车', quote: '现车' },
        { code: 'empty_or_emoji', label: '空内容/仅表情' },
      ]),
      ['询问现车'],
    );
  });
});
