/**
 * Adversarial hardening regressions for the B3 research skills: data provenance labelling, copy-pasted comments,
 * provider relevance per research kind, user landing prices vs hypotheticals, user discount talk vs dealer offers,
 * out-of-area demand, marketing posts, sentiment negation and trend comparisons without data in one window.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { newId } from '../../../src/core/ids.ts';
import type { DataMode, PublicComment, PublicPost, ResearchBrief } from '../../../src/core/types.ts';
import { mapText } from '../../../src/domain/automotive-lexicon.ts';
import { DEFAULT_SIMULATION_CORPUS_PATH, SimulationXhsProvider, type SimComment, type SimNote } from '../../../src/providers/xhs/simulation.ts';
import { extractAmounts, runMarketResearch } from '../../../src/skills/research/automotive-market-research/index.ts';
import { CUE_POLARITY, findSentimentCues, runCompetitorResearch } from '../../../src/skills/research/competitor-research/index.ts';
import { latestBrief } from '../../../src/skills/research/shared.ts';
import { runTrendDetection, runTrendDetectionWithProvider } from '../../../src/skills/research/trend-detection/index.ts';
import { runXhsResearch } from '../../../src/skills/research/xhs-research/index.ts';
import { TEST_NOW, createTestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';

type Ctx = ReturnType<typeof createTestContext>;
let seq = 0;

function setup(): { ctx: Ctx; hz: string } {
  const ctx = createTestContext();
  return { ctx, hz: dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw') };
}

function seedPost(
  ctx: Ctx,
  p: { title: string; content?: string; published_at?: string; author?: string; nickname?: string; ip?: string; data_mode?: DataMode },
): PublicPost {
  seq++;
  return ctx.db.table('public_posts').insert({
    id: newId('ppost'),
    platform: 'xiaohongshu',
    platform_post_id: `hard-note-${seq}`,
    xsec_token: null,
    url: null,
    title: p.title,
    content: p.content ?? '',
    author_platform_user_id: p.author ?? `hard-author-${seq}`,
    author_nickname: p.nickname ?? '路人甲',
    author_profile_url: null,
    ip_location: p.ip ?? '浙江',
    tags: [],
    like_count: 10,
    comment_count: 1,
    collect_count: 2,
    published_at: p.published_at ?? '2026-09-10T02:00:00.000Z',
    data_mode: p.data_mode ?? 'import',
    own_post_id: null,
    first_search_run_id: null,
    fetched_at: TEST_NOW,
    raw: {},
  });
}

function seedComment(
  ctx: Ctx,
  post: PublicPost,
  content: string,
  p: { author?: string; nickname?: string; ip?: string; published_at?: string; data_mode?: DataMode } = {},
): PublicComment {
  seq++;
  return ctx.db.table('public_comments').insert({
    id: newId('pcmt'),
    platform: 'xiaohongshu',
    platform_comment_id: `hard-cmt-${seq}`,
    public_post_id: post.id,
    parent_comment_id: null,
    author_platform_user_id: p.author ?? `hard-user-${seq}`,
    author_nickname: p.nickname ?? '网友',
    content,
    ip_location: p.ip ?? '浙江',
    like_count: 0,
    published_at: p.published_at ?? '2026-09-11T02:00:00.000Z',
    data_mode: p.data_mode ?? 'import',
    prefilter_passed: false,
    prefilter_reason: '',
    first_search_run_id: null,
    fetched_at: TEST_NOW,
    raw: {},
  });
}

const decisionOf = (ctx: Ctx, brief: ResearchBrief) => ctx.db.table('agent_decisions').findOne({ subject_id: brief.id })!;

describe('research hardening: data provenance', () => {
  it('labels briefs built on simulation rows already in the database, even without a simulation provider', async () => {
    const { ctx, hz } = setup();
    const post = seedPost(ctx, { title: '宝马i3试驾体验', content: '周末去试驾了i3', data_mode: 'simulation' });
    seedComment(ctx, post, '现在i3优惠多少', { data_mode: 'simulation' });

    const xhs = await runXhsResearch(ctx, { dealer_id: hz });
    assert.equal(xhs.source_counts.provider_searches, 0);
    assert.ok(xhs.findings.headline.startsWith('【模拟数据】'), xhs.findings.headline);
    const inputs = decisionOf(ctx, xhs).inputs as { data_modes: Record<DataMode, number> };
    assert.equal(inputs.data_modes.simulation, 2, 'note + comment');

    const trend = runTrendDetection(ctx, { dealer_id: hz });
    assert.ok(trend.findings.headline.startsWith('【模拟数据】'), trend.findings.headline);

    const live = seedPost(ctx, { title: '宝马i3提车一周', content: '续航很稳', data_mode: 'live' });
    seedComment(ctx, live, 'i3现在有现车吗', { data_mode: 'live' });
    const mixed = await runXhsResearch(ctx, { dealer_id: hz });
    assert.ok(mixed.findings.headline.startsWith('【含模拟数据】'), mixed.findings.headline);
  });

  it('never labels real (live/import) data as simulation', async () => {
    const { ctx, hz } = setup();
    const post = seedPost(ctx, { title: '宝马i3试驾体验', content: '周末去试驾了i3', data_mode: 'live' });
    seedComment(ctx, post, '现在i3优惠多少', { data_mode: 'live' });
    const brief = await runXhsResearch(ctx, { dealer_id: hz });
    assert.ok(!brief.findings.headline.includes('模拟数据'), brief.findings.headline);
  });
});

describe('research hardening: copied comments', () => {
  it('counts a comment the same author pasted under several notes once (questions, sentiment, trends)', async () => {
    const { ctx, hz } = setup();
    const notes = [1, 2, 3].map((i) => seedPost(ctx, { title: `宝马i3试驾记录${i}`, content: '说说感受', published_at: `2026-09-0${6 + i}T02:00:00.000Z` }));
    for (const n of notes) {
      seedComment(ctx, n, '现在i3优惠多少', { author: 'u-copy-paste' });
      seedComment(ctx, n, 'Model 3真香', { author: 'u-copy-fan' });
    }
    seedComment(ctx, notes[0], '现在i3优惠多少', { author: 'u-real-second-buyer' });

    const xhs = await runXhsResearch(ctx, { dealer_id: hz });
    const discount = xhs.findings.top_questions?.find((q) => q.question === '现在优惠多少');
    assert.equal(discount?.count, 2, 'two distinct askers, not four comments');
    assert.equal((decisionOf(ctx, xhs).inputs as { repeated_comments_ignored: number }).repeated_comments_ignored, 4);

    const competitor = await runCompetitorResearch(ctx, { dealer_id: hz });
    const sentiment = competitor.findings.insights.find((i) => i.text.startsWith('情绪词：Model 3'));
    assert.ok(sentiment, 'Model 3 sentiment insight');
    assert.ok(sentiment.text.includes('「香」1次'), sentiment.text);

    const trend = runTrendDetection(ctx, { dealer_id: hz, window_days: 7 });
    assert.equal(trend.findings.trends?.find((t) => t.term === '优惠')?.current, 2);
  });
});

function simNote(p: { id: string; title: string; content: string; keywords: string[]; comments: { id: string; content: string; author: string }[] }): SimNote {
  return {
    platform_post_id: p.id,
    xsec_token: `tok-${p.id}`,
    title: p.title,
    content: p.content,
    tags: [],
    keywords: p.keywords,
    author: { platform_user_id: `author-${p.id}`, nickname: '普通用户' },
    ip_location: '浙江',
    like_count: 5,
    comment_count: p.comments.length,
    collect_count: 1,
    published_at: '2026-09-10T02:00:00.000Z',
    comments: p.comments.map(
      (c): SimComment => ({
        platform_comment_id: c.id,
        author: { platform_user_id: c.author, nickname: '网友' },
        content: c.content,
        ip_location: '浙江',
        like_count: 0,
        published_at: '2026-09-11T02:00:00.000Z',
        sub_comments: [],
      }),
    ),
  };
}

describe('research hardening: provider relevance per research kind', () => {
  it('xhs research never counts buyer questions from competitor-only threads a search returned; competitor research keeps them', async () => {
    const ctx = createTestContext();
    const hz = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    ctx.xhs = new SimulationXhsProvider(ctx.clock, {
      notes: [
        simNote({
          id: 'rel-i3',
          title: '宝马i3值得买吗',
          content: '纠结中',
          keywords: ['宝马i3', 'i3 vs Model 3'],
          comments: [{ id: 'rel-c1', content: '现在i3优惠多少', author: 'u-rel-1' }],
        }),
        simNote({
          id: 'rel-m3',
          title: 'Model 3提车一个月',
          content: '说说Model 3的真实感受',
          keywords: ['宝马i3', 'i3 vs Model 3'],
          comments: [{ id: 'rel-c2', content: 'Model 3现在优惠多少', author: 'u-rel-2' }],
        }),
      ],
      profiles: [],
      inbox_scripts: [],
    });
    const xhs = await runXhsResearch(ctx, { dealer_id: hz, models: ['i3'] });
    assert.equal(xhs.source_counts.posts, 1, 'the Model 3-only note is not i3 research data');
    assert.equal(xhs.findings.top_questions?.find((q) => q.question === '现在优惠多少')?.count, 1);
    assert.ok(!JSON.stringify(xhs.findings).includes('rel-c2'));

    const competitor = await runCompetitorResearch(ctx, { dealer_id: hz, models: ['i3'] });
    assert.equal(competitor.source_counts.posts, 2, 'competitor research keeps competitor threads');
  });
});

describe('research hardening: market research user talk', () => {
  it('flags landing prices and discounts phrased as questions, budgets, conditions or hearsay', () => {
    const landing = (t: string) => extractAmounts(t, 'landing').map((a) => [a.value, a.hypothetical]);
    assert.deepEqual(landing('我上个月30万落地的i3'), [[300000, false]]);
    assert.deepEqual(landing('杭州提的35L，落地26.8万'), [[268000, false]]);
    assert.deepEqual(landing('i3 30万落地能拿下吗'), [[300000, true]]);
    assert.deepEqual(landing('预算30万落地'), [[300000, true]]);
    assert.deepEqual(landing('25万落地的话选i3还是Model 3'), [[250000, true]]);
    assert.deepEqual(landing('i3 30万落地，能拿下吗'), [[300000, true]], 'a short question right after the price');
    assert.deepEqual(landing('我30万落地的，你们现在店里给的优惠是多少'), [[300000, false]], 'a later, separate question does not turn a report into a question');
    const discount = (t: string) => extractAmounts(t, 'discount').map((a) => [a.value, a.hypothetical]);
    assert.deepEqual(discount('优惠了8千'), [[8000, false]]);
    assert.deepEqual(discount('听说i3优惠8万是真的吗'), [[80000, true]]);
    assert.deepEqual(discount('能优惠2万吗'), [[20000, true]]);
  });

  it('never presents a price from a question or budget as a self-reported landing price', async () => {
    const { ctx, hz } = setup();
    const post = seedPost(ctx, { title: '宝马i3提车分享', content: '杭州提的35L，落地26.8万', nickname: 'i3新车主' });
    const asked = seedComment(ctx, post, 'i3 30万落地能拿下吗');
    const budget = seedComment(ctx, post, '预算28万落地，i3够吗');
    const brief = await runMarketResearch(ctx, { dealer_id: hz });
    const insight = brief.findings.insights.find((i) => i.text.startsWith('【用户讨论·落地价】'));
    assert.ok(insight, 'landing price insight');
    const [reported, hypothetical] = insight.text.split('；另有');
    assert.ok(reported.includes('26.8万') && !reported.includes('30万') && !reported.includes('28万'), insight.text);
    assert.ok(hypothetical && hypothetical.includes('30万') && hypothetical.includes('28万'), insight.text);
    for (const e of insight.evidence) {
      if (e.source_ref === `comment:${asked.platform_comment_id}` || e.source_ref === `comment:${budget.platform_comment_id}`) {
        assert.ok(e.label.startsWith('用户讨论：提问/预算/假设中的落地价'), e.label);
      } else {
        assert.equal(e.source_ref, `note:${post.platform_post_id}`);
        assert.ok(e.label.startsWith('用户讨论：自述落地价'), e.label);
      }
    }
  });

  it('sets the discount amounts users mention against the dealer’s active offers for the same model', async () => {
    const { ctx, hz } = setup();
    const post = seedPost(ctx, { title: '宝马i3优惠分享', content: '杭州i3现金优惠了8万', nickname: 'i3新车主' });
    seedComment(ctx, post, '听说i3能优惠10万是真的吗');
    seedComment(ctx, post, '现在i3优惠多少');
    const brief = await runMarketResearch(ctx, { dealer_id: hz });
    const insight = brief.findings.insights.find((i) => i.text.startsWith('【用户讨论 vs 门店事实】i3'));
    assert.ok(insight, String(brief.findings.insights.map((i) => i.text)));
    const [userPart, dealerPart] = insight.text.split('；门店当前');
    assert.ok(userPart.includes('8万') && userPart.includes('10万') && userPart.includes('用户说法'), insight.text);
    assert.ok(dealerPart && dealerPart.includes('i3金九限时优惠') && dealerPart.includes('9万') && dealerPart.includes('门店事实'), insight.text);
    const refs = insight.evidence.map((e) => e.source_ref ?? '');
    assert.ok(refs.some((r) => r.startsWith('offer:')) && refs.some((r) => r.startsWith('note:') || r.startsWith('comment:')));
    for (const e of insight.evidence) assert.ok(e.label.startsWith(e.source_ref!.startsWith('offer:') ? '门店事实：' : '用户讨论：'), e.label);
  });

  it('counts a comment asking both price and discount once in the headline', async () => {
    const { ctx, hz } = setup();
    const post = seedPost(ctx, { title: '宝马i3值得买吗', content: '想了解i3' });
    seedComment(ctx, post, 'i3落地多少，优惠多少');
    const brief = await runMarketResearch(ctx, { dealer_id: hz });
    assert.ok(brief.findings.headline.includes('1条买家评论问价/问优惠'), brief.findings.headline);
  });

  it('keeps buyers who state another region out of this dealer’s model demand and price asks', async () => {
    const { ctx, hz } = setup();
    const post = seedPost(ctx, { title: '宝马X3白外棕内到店', content: 'X3实拍' });
    const away = seedComment(ctx, post, '上海X3现在什么价', { ip: '上海' });
    const local = seedComment(ctx, post, 'X3现在什么价', { ip: '浙江' });
    const brief = await runMarketResearch(ctx, { dealer_id: hz, models: ['X3'] });
    const stock = brief.findings.insights.find((i) => i.text.startsWith('【门店库存 vs 用户需求】X3'));
    assert.ok(stock && stock.text.includes('买家需求信号1条') && stock.text.includes('异地买家1条'), String(stock?.text));
    const asks = brief.findings.insights.find((i) => i.text.startsWith('【用户讨论 vs 门店事实】X3'));
    assert.ok(asks && asks.text.includes('1条买家评论问价/问优惠'), String(asks?.text));
    for (const insight of [stock, asks]) {
      const refs = insight.evidence.map((e) => e.source_ref);
      assert.ok(!refs.includes(`comment:${away.platform_comment_id}`), 'out-of-area buyer is not cited as local demand');
      assert.ok(refs.includes(`comment:${local.platform_comment_id}`));
    }
  });

  it('ignores prices published in dealer/marketing posts', async () => {
    const { ctx, hz } = setup();
    const spam = seedPost(ctx, { title: '杭州宝马i3底价', content: '私信我底价，i3落地25万包上牌', nickname: '杭州宝马销售小陈' });
    seedComment(ctx, spam, 'i3落地多少');
    const brief = await runMarketResearch(ctx, { dealer_id: hz });
    assert.ok(brief.source_counts.posts > 0);
    assert.ok(!brief.findings.insights.some((i) => i.text.startsWith('【用户讨论·落地价】') && i.text.includes('25万')), JSON.stringify(brief.findings.insights.map((i) => i.text)));
    assert.ok(!JSON.stringify(brief.findings.insights).includes(`note:${spam.platform_post_id}`));
  });
});

describe('research hardening: sentiment cues', () => {
  const cues = (text: string) => findSentimentCues(mapText(text)).map((h) => h.cue);
  it('handles negated, A-not-A and intensified cues', () => {
    assert.deepEqual(cues('Model Y一点也不香'), ['不香']);
    assert.deepEqual(cues('X3没那么香了'), ['不香']);
    assert.deepEqual(cues('X3香不香'), []);
    assert.deepEqual(cues('i3没那么值得'), ['不值']);
    assert.deepEqual(cues('这么香的车谁不爱'), ['香']);
    assert.deepEqual(cues('香港提的i3'), []);
    assert.deepEqual(cues('不吃香菜'), []);
    assert.deepEqual(cues('已经提了Model Y 很香'), ['香']);
    assert.equal(CUE_POLARITY['不香'], 'negative');
  });
});

function simulationSources(): Map<string, string[]> {
  const corpus = JSON.parse(readFileSync(DEFAULT_SIMULATION_CORPUS_PATH, 'utf8')) as { notes: SimNote[] };
  const sources = new Map<string, string[]>();
  const walk = (list: SimComment[]) => {
    for (const c of list) {
      sources.set(`comment:${c.platform_comment_id}`, [c.content]);
      walk(c.sub_comments ?? []);
    }
  };
  for (const n of corpus.notes) {
    sources.set(`note:${n.platform_post_id}`, [n.title, n.content]);
    walk(n.comments);
  }
  return sources;
}

describe('research hardening: trends need data in both windows', () => {
  it('does not claim rising terms when the previous window has no data at all (simulation corpus)', async () => {
    const ctx = createTestContext();
    ctx.xhs = SimulationXhsProvider.fromFile(ctx.clock);
    const hz = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const sources = simulationSources();
    const brief = await runTrendDetectionWithProvider(ctx, { dealer_id: hz });
    assert.ok(brief.findings.headline.includes('没有可比'), brief.findings.headline);
    assert.ok(brief.findings.insights.length > 0, 'window volume insights are still reported');
    for (const insight of brief.findings.insights) {
      assert.ok(!/升温|上升|下降/.test(insight.text), insight.text);
      for (const e of insight.evidence) assert.ok(sources.get(e.source_ref!)?.some((t) => t.includes(e.quote!)), `${e.quote} in ${e.source_ref}`);
    }
    assert.ok((brief.findings.trends ?? []).length > 0, 'counts are still listed');
    assert.equal((decisionOf(ctx, brief).inputs as { comparable: boolean }).comparable, false);
  });

  it('does not claim falling terms when the current window has no data', () => {
    const { ctx, hz } = setup();
    const post = seedPost(ctx, { title: '宝马i3落地价分享', content: '杭州落地价还可以', published_at: '2026-09-01T02:00:00.000Z' });
    seedComment(ctx, post, 'i3落地多少', { published_at: '2026-09-02T02:00:00.000Z' });
    seedComment(ctx, post, '杭州i3落地价多少', { published_at: '2026-09-03T02:00:00.000Z' });
    const brief = runTrendDetection(ctx, { dealer_id: hz });
    assert.ok(brief.findings.headline.includes('没有可比'), brief.findings.headline);
    for (const insight of brief.findings.insights) assert.ok(!/升温|上升|下降/.test(insight.text), insight.text);
  });
});

describe('research hardening: latest brief with data', () => {
  it('can skip newer briefs that had no public data', () => {
    const { ctx, hz } = setup();
    const insert = (createdAt: string, posts: number) =>
      ctx.db.table('research_briefs').insert({
        id: newId('rb'),
        dealer_id: hz,
        kind: 'xhs',
        scope: { models: ['i3'], location: '杭州', window_days: 30 },
        findings: { headline: posts > 0 ? '有数据' : '暂无可分析的小红书公开数据', insights: [] },
        source_counts: { posts, comments: posts * 3, provider_searches: 0 },
        engine: 'rules',
        workflow_run_id: null,
        created_at: createdAt,
      });
    const informative = insert('2026-09-08T02:00:00.000Z', 4);
    const empty = insert('2026-09-12T01:00:00.000Z', 0);
    assert.equal(latestBrief(ctx, hz, 'xhs', 30)?.id, empty.id);
    assert.equal(latestBrief(ctx, hz, 'xhs', 30, { with_data: true })?.id, informative.id);
    assert.equal(latestBrief(ctx, hz, 'xhs', 2, { with_data: true }), null);
  });
});
