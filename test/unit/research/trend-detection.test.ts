import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { newId } from '../../../src/core/ids.ts';
import type { PublicComment, PublicPost, ResearchBrief } from '../../../src/core/types.ts';
import { DEFAULT_SIMULATION_CORPUS_PATH, SimulationXhsProvider, type SimComment } from '../../../src/providers/xhs/simulation.ts';
import { SkillRegistry } from '../../../src/skills/registry.ts';
import { fetchProviderCorpus, buildResearchQueries, resolveScope } from '../../../src/skills/research/shared.ts';
import {
  DEFAULT_TREND_WINDOW_DAYS,
  changeRatio,
  countTrends,
  runTrendDetection,
  runTrendDetectionWithProvider,
  skill,
} from '../../../src/skills/research/trend-detection/index.ts';
import { TEST_NOW, createTestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';

type Ctx = ReturnType<typeof createTestContext>;
let seq = 0;

function seedPost(ctx: Ctx, title: string, content: string, publishedAt: string | null): PublicPost {
  seq++;
  return ctx.db.table('public_posts').insert({
    id: newId('ppost'),
    platform: 'xiaohongshu',
    platform_post_id: `trend-note-${seq}`,
    xsec_token: null,
    url: null,
    title,
    content,
    author_platform_user_id: `trend-author-${seq}`,
    author_nickname: '作者',
    author_profile_url: null,
    ip_location: '浙江',
    tags: [],
    like_count: 0,
    comment_count: 0,
    collect_count: 0,
    published_at: publishedAt,
    own_post_id: null,
    first_search_run_id: null,
    fetched_at: ctx.clock.iso(),
    raw: {},
  });
}

function seedComment(ctx: Ctx, post: PublicPost, content: string, publishedAt: string | null, author?: string): PublicComment {
  seq++;
  return ctx.db.table('public_comments').insert({
    id: newId('pcmt'),
    platform: 'xiaohongshu',
    platform_comment_id: `trend-cmt-${seq}`,
    public_post_id: post.id,
    parent_comment_id: null,
    author_platform_user_id: author ?? `trend-user-${seq}`,
    author_nickname: '网友',
    content,
    ip_location: '浙江',
    like_count: 0,
    published_at: publishedAt,
    prefilter_passed: false,
    prefilter_reason: '',
    first_search_run_id: null,
    fetched_at: ctx.clock.iso(),
    raw: {},
  });
}

/** Current window (09-05T02:00, 09-12T02:00], previous (08-29T02:00, 09-05T02:00]. */
function seedTwoWindows(ctx: Ctx) {
  const p1 = seedPost(ctx, '宝马X3以租代购怎么样', '想了解以租代购方案', '2026-09-10T02:00:00.000Z');
  const c1 = seedComment(ctx, p1, 'X3以租代购月供多少', '2026-09-11T02:00:00.000Z');
  const c2 = seedComment(ctx, p1, '以租代购划算吗', '2026-09-11T03:00:00.000Z');
  const c3 = seedComment(ctx, p1, '落地价也问一下', '2026-09-11T04:00:00.000Z');
  seedComment(ctx, p1, '以租代购靠谱吗', null);
  seedComment(ctx, p1, '以租代购私信我', '2026-09-11T05:00:00.000Z');
  seedComment(ctx, p1, '砍价技巧有吗', '2026-09-11T06:00:00.000Z');
  seedComment(ctx, p1, '以租代购方案官方解读', '2026-09-11T07:00:00.000Z', 'xhs-hz-official');
  const p2 = seedPost(ctx, '宝马i3落地价分享', '杭州落地价还可以', '2026-09-01T02:00:00.000Z');
  const c7 = seedComment(ctx, p2, 'i3落地多少', '2026-09-02T02:00:00.000Z');
  const c8 = seedComment(ctx, p2, '杭州i3落地价多少', '2026-09-03T02:00:00.000Z');
  seedPost(ctx, '宝马X3以租代购老帖', '以租代购', '2026-08-20T02:00:00.000Z');
  const texts = new Map<string, string[]>([
    [`note:${p1.platform_post_id}`, [p1.title, p1.content]],
    [`comment:${c1.platform_comment_id}`, [c1.content]],
    [`comment:${c2.platform_comment_id}`, [c2.content]],
    [`comment:${c3.platform_comment_id}`, [c3.content]],
    [`note:${p2.platform_post_id}`, [p2.title, p2.content]],
    [`comment:${c7.platform_comment_id}`, [c7.content]],
    [`comment:${c8.platform_comment_id}`, [c8.content]],
  ]);
  return {
    texts,
    current: new Set([`note:${p1.platform_post_id}`, `comment:${c1.platform_comment_id}`, `comment:${c2.platform_comment_id}`]),
    previous: new Set([`note:${p2.platform_post_id}`, `comment:${c7.platform_comment_id}`, `comment:${c8.platform_comment_id}`]),
  };
}

describe('trend-detection: DB corpus across two windows', () => {
  it('computes rising and falling terms with change ratios, min support and verbatim evidence', () => {
    const ctx = createTestContext();
    const hz = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const seeded = seedTwoWindows(ctx);

    const brief = runTrendDetection(ctx, { dealer_id: hz });
    assert.ok(!(brief instanceof Promise), 'synchronous contract');
    assert.equal(brief.kind, 'trend');
    assert.equal(brief.scope.window_days, DEFAULT_TREND_WINDOW_DAYS);
    const trends = brief.findings.trends ?? [];
    const t = (term: string) => trends.find((x) => x.term === term);
    assert.deepEqual(t('以租代购'), { term: '以租代购', current: 3, previous: 0, change: 3 }, 'undated, marketing, managed and out-of-window units never count');
    assert.deepEqual(t('落地价'), { term: '落地价', current: 1, previous: 3, change: -0.67 });
    assert.deepEqual(t('X3'), { term: 'X3', current: 2, previous: 0, change: 2 });
    assert.deepEqual(t('i3'), { term: 'i3', current: 0, previous: 3, change: -1 });
    assert.equal(t('砍价'), undefined, 'below min support');
    for (let i = 1; i < trends.length; i++) assert.ok(trends[i - 1].change >= trends[i].change, 'sorted by change');

    const rising = brief.findings.insights.find((i) => i.text.startsWith('「以租代购」'));
    assert.ok(rising && rising.text.includes('新出现并升温'), String(rising?.text));
    assert.equal(rising.metric, 3);
    for (const e of rising.evidence) {
      assert.ok(seeded.current.has(e.source_ref!), `rising evidence from the current window: ${e.source_ref}`);
      assert.ok(seeded.texts.get(e.source_ref!)!.some((x) => x.includes(e.quote!)));
      assert.ok(e.quote!.includes('以租代购'));
    }
    const falling = brief.findings.insights.find((i) => i.text.startsWith('「落地价」讨论下降'));
    assert.ok(falling, 'falling term insight');
    for (const e of falling.evidence) {
      assert.ok(seeded.previous.has(e.source_ref!), `falling evidence from the previous window: ${e.source_ref}`);
      assert.ok(seeded.texts.get(e.source_ref!)!.some((x) => x.includes(e.quote!)));
    }
    assert.ok(brief.findings.headline.includes('以租代购'), brief.findings.headline);
    assert.deepEqual(brief.source_counts, { posts: 2, comments: 8, provider_searches: 0 });
    const decision = ctx.db.table('agent_decisions').findOne({ subject_id: brief.id })!;
    assert.equal(decision.decision_type, 'research');
    assert.equal((decision.inputs as { min_support: number }).min_support, 2);
  });

  it('uses a pre-gathered provider corpus when supplied to the synchronous API', async () => {
    const ctx = createTestContext();
    ctx.xhs = SimulationXhsProvider.fromFile(ctx.clock);
    const hz = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const scope = resolveScope(ctx, { dealer_id: hz }, DEFAULT_TREND_WINDOW_DAYS);
    const provider = await fetchProviderCorpus(ctx, scope, buildResearchQueries('trend', scope), 14);
    const brief = runTrendDetection(ctx, { dealer_id: hz }, { provider_corpus: provider });
    assert.equal(brief.source_counts.provider_searches, provider.usage.searches);
    assert.ok(brief.source_counts.posts > 0);
    assert.ok((brief.findings.trends ?? []).length > 0);
  });
});

describe('trend-detection: provider path and empty data', () => {
  it('skill path gathers bounded simulation data and quotes it verbatim', async () => {
    const ctx = createTestContext();
    ctx.xhs = SimulationXhsProvider.fromFile(ctx.clock);
    const hz = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const corpus = JSON.parse(readFileSync(DEFAULT_SIMULATION_CORPUS_PATH, 'utf8')) as {
      notes: { platform_post_id: string; title: string; content: string; comments: SimComment[] }[];
    };
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
    const registry = new SkillRegistry().register(skill);
    const brief = await registry.invoke<ResearchBrief>(ctx, 'trend-detection', { dealer_id: hz });
    assert.ok(brief.source_counts.provider_searches > 0 && brief.source_counts.provider_searches <= 6);
    assert.ok((brief.findings.trends ?? []).length > 0);
    assert.ok(brief.findings.insights.length > 0);
    for (const e of brief.findings.insights.flatMap((i) => i.evidence)) {
      assert.ok(sources.get(e.source_ref!)?.some((t) => t.includes(e.quote!)), `"${e.quote}" verbatim in ${e.source_ref}`);
    }
    assert.ok(brief.findings.headline.startsWith('【模拟数据】'));
    const again = await runTrendDetectionWithProvider(ctx, { dealer_id: hz, window_days: 3 });
    assert.equal(again.scope.window_days, 3);
  });

  it('persists an honest empty brief with no dated corpus', () => {
    const ctx = createTestContext();
    const hz = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const brief = runTrendDetection(ctx, { dealer_id: hz });
    assert.deepEqual(brief.findings.insights, []);
    assert.deepEqual(brief.findings.trends, []);
    assert.deepEqual(brief.source_counts, { posts: 0, comments: 0, provider_searches: 0 });
    assert.ok(brief.findings.headline.startsWith('暂无可分析的小红书公开数据'));
    assert.ok(brief.findings.headline.includes('本次未调用小红书搜索'));
  });
});

describe('trend-detection: pure helpers', () => {
  it('computes change ratios against max(1, previous)', () => {
    assert.equal(changeRatio(3, 0), 3);
    assert.equal(changeRatio(1, 3), -0.67);
    assert.equal(changeRatio(4, 2), 1);
    assert.equal(changeRatio(0, 0), 0);
  });

  it('counts document frequency once per unit and respects window boundaries', () => {
    const now = Date.parse(TEST_NOW);
    const at = (days: number) => new Date(now - days * 86_400_000).toISOString();
    const { counts, current_units, previous_units } = countTrends(
      [
        { ref: 'a', text: '优惠优惠优惠，i3优惠多少', context: null, published_at: at(1) },
        { ref: 'b', text: 'i3优惠', context: null, published_at: at(7) },
        { ref: 'c', text: 'i3优惠', context: null, published_at: at(7.5) },
        { ref: 'd', text: 'i3优惠', context: null, published_at: at(15) },
        { ref: 'e', text: 'i3优惠', context: null, published_at: new Date(now + 3_600_000).toISOString() },
      ],
      now,
      7,
    );
    assert.equal(current_units, 2, 'exactly 7 days ago is still inside the current window');
    assert.equal(previous_units, 1);
    const discount = counts.find((c) => c.term === '优惠')!;
    assert.equal(discount.current, 2, 'one count per unit');
    assert.equal(discount.previous, 1);
    assert.equal(counts.find((c) => c.term === 'i3')?.current, 2);
  });
});
