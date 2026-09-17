import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { NotFoundError, ValidationError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import { RESEARCH_KINDS, type PublicComment, type PublicPost, type ResearchInsight } from '../../../src/core/types.ts';
import { DEFAULT_SIMULATION_CORPUS_PATH, SimulationXhsProvider } from '../../../src/providers/xhs/simulation.ts';
import type { ProviderResult, XhsNoteSummary, XhsSearchOptions } from '../../../src/providers/xhs/types.ts';
import {
  MAX_NOTES_PER_QUERY,
  MAX_PROVIDER_QUERIES,
  assembleCorpus,
  buildResearchQueries,
  clauseAround,
  excerpt,
  fetchProviderCorpus,
  isQuestionForm,
  loadDbCorpus,
  mergeCorpora,
  noDataHeadline,
  resolveScope,
  verifyInsights,
  type ResearchComment,
  type ResearchNote,
} from '../../../src/skills/research/shared.ts';
import { TEST_NOW, createTestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';

const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(Date.parse(TEST_NOW) - d * DAY).toISOString();

function setup() {
  const ctx = createTestContext();
  const s = loadDealerFixture(ctx);
  return { ctx, hz: dealerIdByKey(s, 'hz-bmw') };
}

let seq = 0;
function seedPost(
  ctx: ReturnType<typeof createTestContext>,
  p: { title: string; content?: string; published_at: string | null; author?: string; tags?: string[] },
): PublicPost {
  seq++;
  return ctx.db.table('public_posts').insert({
    id: newId('ppost'),
    platform: 'xiaohongshu',
    platform_post_id: `shared-note-${seq}`,
    xsec_token: null,
    url: null,
    title: p.title,
    content: p.content ?? '',
    author_platform_user_id: p.author ?? `shared-author-${seq}`,
    author_nickname: '作者',
    author_profile_url: null,
    ip_location: '浙江',
    tags: p.tags ?? [],
    like_count: 0,
    comment_count: 0,
    collect_count: 0,
    published_at: p.published_at,
    own_post_id: null,
    first_search_run_id: null,
    fetched_at: ctx.clock.iso(),
    raw: {},
  });
}

function seedComment(ctx: ReturnType<typeof createTestContext>, post: PublicPost, content: string, publishedAt: string | null): PublicComment {
  seq++;
  return ctx.db.table('public_comments').insert({
    id: newId('pcmt'),
    platform: 'xiaohongshu',
    platform_comment_id: `shared-cmt-${seq}`,
    public_post_id: post.id,
    parent_comment_id: null,
    author_platform_user_id: `shared-user-${seq}`,
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

function note(p: Partial<ResearchNote> & { platform_post_id: string; title: string }): ResearchNote {
  return {
    public_post_id: null,
    origin: 'provider',
    content: '',
    tags: [],
    author_user_id: 'u-author',
    author_nickname: '作者',
    ip_location: '浙江',
    like_count: 0,
    collect_count: 0,
    comment_count: 0,
    published_at: TEST_NOW,
    observed_at: TEST_NOW,
    own_post_id: null,
    managed_author: false,
    data_mode: 'import',
    comments: [],
    ...p,
  };
}

function comment(p: Partial<ResearchComment> & { platform_comment_id: string; content: string }): ResearchComment {
  return {
    public_comment_id: null,
    parent_comment_id: null,
    author_user_id: `u-${p.platform_comment_id}`,
    author_nickname: '网友',
    ip_location: '浙江',
    like_count: 0,
    published_at: TEST_NOW,
    observed_at: TEST_NOW,
    managed_author: false,
    note_author: false,
    data_mode: 'import',
    ...p,
  };
}

describe('research shared: scope', () => {
  it('defaults to carried models prioritized by stock, the dealer city and a 30-day window', () => {
    const { ctx, hz } = setup();
    const scope = resolveScope(ctx, { dealer_id: hz });
    assert.deepEqual(scope.models.slice(0, 3), ['i3', 'X3', '3 Series'], 'in-stock i3 (+ in transit) and X3 first, then 3 Series');
    assert.deepEqual([...scope.models].sort(), ['3 Series', '5 Series', 'X1', 'X3', 'i3', 'i4', 'iX3'].sort());
    assert.equal(scope.explicit_models, false);
    assert.equal(scope.location, '杭州');
    assert.equal(scope.window_days, 30);
    assert.equal(scope.to, TEST_NOW);
    assert.equal(scope.from, daysAgo(30));
    assert.equal(scope.brand, 'BMW');
    assert.equal(scope.brand_zh, '宝马');
    assert.ok(scope.managed_ids.has('xhs-hz-i3') && scope.managed_ids.has('xhs-sh-official'), 'managed ids cover the whole group');
  });

  it('canonicalizes explicit models and aliases, keeps order and drops duplicates', () => {
    const { ctx, hz } = setup();
    const scope = resolveScope(ctx, { dealer_id: hz, models: ['宝马3系', 'i3', 'I3'], location: null, window_days: 14 });
    assert.deepEqual(scope.models, ['3 Series', 'i3']);
    assert.equal(scope.explicit_models, true);
    assert.equal(scope.location, null);
    assert.equal(scope.window_days, 14);
  });

  it('rejects invalid input and unknown dealers', () => {
    const { ctx, hz } = setup();
    assert.throws(() => resolveScope(ctx, { dealer_id: hz, window_days: 0 }), ValidationError);
    assert.throws(() => resolveScope(ctx, { dealer_id: hz, window_days: 181 }), ValidationError);
    assert.throws(() => resolveScope(ctx, { dealer_id: '' }), ValidationError);
    assert.throws(() => resolveScope(ctx, { dealer_id: 'dlr_missing' }), NotFoundError);
  });
});

describe('research shared: provider queries', () => {
  it('every research kind builds at most 6 unique queries from models and city', () => {
    const { ctx, hz } = setup();
    const scope = resolveScope(ctx, { dealer_id: hz });
    for (const kind of RESEARCH_KINDS) {
      const queries = buildResearchQueries(kind, scope);
      assert.ok(queries.length > 0 && queries.length <= MAX_PROVIDER_QUERIES, `${kind}: ${queries.length} queries`);
      assert.equal(new Set(queries).size, queries.length, `${kind}: unique`);
    }
    assert.ok(buildResearchQueries('xhs', scope).includes('宝马i3'));
    assert.ok(buildResearchQueries('xhs', scope).includes('杭州i3'));
    assert.ok(buildResearchQueries('competitor', scope).includes('i3 vs Model 3'));
    assert.ok(buildResearchQueries('competitor', scope).includes('X3 vs GLC'));
    assert.ok(buildResearchQueries('market', scope).includes('i3落地'));
    assert.ok(buildResearchQueries('market', scope).includes('杭州宝马优惠'));
    assert.ok(buildResearchQueries('trend', scope).includes('宝马i3'));
  });

  it('never mentions a city when location is disabled', () => {
    const { ctx, hz } = setup();
    const scope = resolveScope(ctx, { dealer_id: hz, location: null });
    for (const kind of RESEARCH_KINDS) {
      for (const q of buildResearchQueries(kind, scope)) assert.ok(!q.includes('杭州'), `${kind}: ${q}`);
    }
  });
});

describe('research shared: verbatim quoting', () => {
  it('widens a bare list item to its neighbours without crossing a line break', () => {
    const text = '纯电：宝马i3（看终端优惠）、Model 3、小米SU7\n混动/油车：3系入门款要看优惠力度';
    const quote = clauseAround(text, 'Model 3');
    assert.ok(quote);
    assert.ok(text.includes(quote), 'verbatim substring');
    assert.ok(quote.includes('Model 3') && quote.length > 'Model 3'.length, quote);
    assert.ok(!quote.includes('\n'));
  });

  it('keeps full-width punctuation verbatim and returns null for a missing needle', () => {
    const text = '这台白色35L还在吗？多少钱';
    assert.equal(clauseAround(text, '多少钱'), text);
    assert.equal(clauseAround(text, '以租代购'), null);
  });

  it('trims a long clause around the hit and stays verbatim', () => {
    const text = `${'这是一段非常长而且没有任何标点的描述'.repeat(5)}以租代购${'后面还有很多很多的字'.repeat(6)}`;
    const quote = clauseAround(text, '以租代购');
    assert.ok(quote);
    assert.ok(text.includes(quote));
    assert.ok(quote.includes('以租代购'));
    assert.ok(Array.from(quote).length <= 70, `length ${Array.from(quote).length}`);
  });

  it('excerpts by code points and never splits emoji', () => {
    const text = '  好看😍😍😍很帅';
    assert.equal(excerpt(text, 3), '好看😍');
    assert.ok(text.includes(excerpt(text, 5)));
  });

  it('recognizes buyer questions but not owner statements', () => {
    for (const t of ['现在优惠多少', '有白色现车吗', '杭州哪家宝马店靠谱', 'X3可以以租代购吗？', '优惠多少啊姐妹，求透露', '蹲一个价格']) {
      assert.equal(isQuestionForm(t), true, t);
    }
    for (const t of ['X3开了两年，保养也不贵，推荐', '杭州冬天续航大概打八折，够用', '同款白红，提车三个月了，很满意']) {
      assert.equal(isQuestionForm(t), false, t);
    }
  });

  it('drops evidence that is not verbatim in its referenced source and insights left without evidence', () => {
    const sources = new Map([
      ['comment:c1', ['现在i3优惠多少']],
      ['comment:c2', ['现在i3优惠多少']],
    ]);
    const insights: ResearchInsight[] = [
      {
        text: '保留',
        evidence: [
          { code: 'x', label: 'l', quote: 'i3优惠', source_ref: 'comment:c1' },
          { code: 'x', label: 'l', quote: 'i3优惠', source_ref: 'comment:c2' },
          { code: 'x', label: 'l', quote: 'i3优惠', source_ref: 'comment:c1' },
          { code: 'x', label: 'l', quote: '编造的内容', source_ref: 'comment:c1' },
          { code: 'x', label: 'l', quote: 'i3优惠', source_ref: 'comment:unknown' },
          { code: 'x', label: 'l', source_ref: 'comment:c1' },
        ],
      },
      { text: '丢弃', evidence: [{ code: 'y', label: 'l', quote: '不存在', source_ref: 'comment:c1' }] },
    ];
    const out = verifyInsights(insights, sources);
    assert.equal(out.insights.length, 1);
    assert.deepEqual(
      out.insights[0].evidence.map((e) => e.source_ref),
      ['comment:c1', 'comment:c2'],
      'identical quotes from different sources are both kept; the exact duplicate is not',
    );
    assert.equal(out.dropped, 4);
  });
});

class FlakySimulation extends SimulationXhsProvider {
  override async searchNotes(query: string, opts?: XhsSearchOptions, accountId?: string | null): Promise<ProviderResult<XhsNoteSummary[]>> {
    if (query === 'boom') throw new Error('network down');
    if (query === 'auth') return { ok: false, status: 'REQUIRES_AUTH', reason: '需要登录' };
    return super.searchNotes(query, opts, accountId);
  }
}

describe('research shared: provider gathering', () => {
  it('an unavailable provider yields no notes and records the capability status', async () => {
    const { ctx, hz } = setup();
    const scope = resolveScope(ctx, { dealer_id: hz });
    const r = await fetchProviderCorpus(ctx, scope, ['宝马i3']);
    assert.deepEqual(r.notes, []);
    assert.equal(r.usage.search_status, 'UNAVAILABLE');
    assert.equal(r.usage.searches, 0);
    assert.equal(r.usage.mode, 'none');
    assert.ok(r.usage.reason.length > 0);
  });

  it('simulation search is bounded, deduplicated, includes replies and persists nothing', async () => {
    const { ctx, hz } = setup();
    ctx.xhs = SimulationXhsProvider.fromFile(ctx.clock);
    const scope = resolveScope(ctx, { dealer_id: hz });
    const queries = [...buildResearchQueries('xhs', scope), '杭州买宝马', '宝马5系'];
    const r = await fetchProviderCorpus(ctx, scope, queries);
    assert.equal(r.usage.queries.length, MAX_PROVIDER_QUERIES, 'only the first 6 queries run');
    assert.equal(r.usage.searches, MAX_PROVIDER_QUERIES);
    for (const q of r.usage.queries) assert.ok(q.notes <= MAX_NOTES_PER_QUERY);
    const ids = r.notes.map((n) => n.platform_post_id);
    assert.ok(ids.length > 0);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(!ids.includes('note-hz-cafe-001'), 'irrelevant notes are filtered');
    assert.ok(r.notes.some((n) => n.comments.some((c) => c.parent_comment_id !== null)), 'replies are included');
    const own = r.notes.find((n) => n.platform_post_id === 'note-own-hz-i3-001');
    assert.ok(own && own.managed_author, 'own managed-account note is flagged');
    for (const n of r.notes) for (const c of n.comments) assert.equal(c.note_author, c.author_user_id === n.author_user_id);
    assert.equal(ctx.db.table('public_posts').count(), 0);
    assert.equal(ctx.db.table('public_comments').count(), 0);
  });

  it('logs failed and throwing searches and continues with the rest', async () => {
    const { ctx, hz } = setup();
    ctx.xhs = new FlakySimulation(ctx.clock, JSON.parse(readFileSync(DEFAULT_SIMULATION_CORPUS_PATH, 'utf8')));
    const scope = resolveScope(ctx, { dealer_id: hz });
    const r = await fetchProviderCorpus(ctx, scope, ['boom', 'auth', '宝马X3']);
    assert.deepEqual(
      r.usage.queries.map((q) => [q.query, q.ok, q.status]),
      [
        ['boom', false, 'UNAVAILABLE'],
        ['auth', false, 'REQUIRES_AUTH'],
        ['宝马X3', true, 'AVAILABLE'],
      ],
    );
    assert.ok(r.usage.queries[0].reason?.includes('network down'));
    assert.equal(r.usage.searches, 1);
    assert.ok(r.notes.length > 0);
  });
});

describe('research shared: DB corpus', () => {
  it('applies the window, model relevance, brand-level and competitor rules', () => {
    const { ctx, hz } = setup();
    const a = seedPost(ctx, { title: '宝马i3提车一周感受', published_at: daysAgo(2) });
    seedPost(ctx, { title: '杭州周末咖啡店合集', published_at: daysAgo(2) });
    const c = seedPost(ctx, { title: '杭州买宝马攻略', content: '到店前必看', published_at: daysAgo(3) });
    const d = seedPost(ctx, { title: '宝马i3老帖', published_at: '2026-07-01T02:00:00.000Z' });
    seedComment(ctx, d, 'i3以前多少钱', '2026-07-02T02:00:00.000Z');
    seedComment(ctx, d, 'i3现在优惠多少', daysAgo(1));
    seedPost(ctx, { title: '宝马X5一年车主感受', published_at: '2026-07-01T02:00:00.000Z' });
    const f = seedPost(ctx, { title: 'Model 3冬季续航实测', published_at: daysAgo(2) });
    seedPost(ctx, { title: '奔驰GLC提车', published_at: daysAgo(2) });
    seedPost(ctx, { title: '宝马X3到店实拍', published_at: daysAgo(2) });
    const own = seedPost(ctx, { title: '宝马i3官方到店', published_at: daysAgo(1), author: 'xhs-hz-official' });

    const scope = resolveScope(ctx, { dealer_id: hz, models: ['i3'] });
    const notes = loadDbCorpus(ctx, scope);
    const ids = new Set(notes.map((n) => n.platform_post_id));
    assert.deepEqual(ids, new Set([a.platform_post_id, c.platform_post_id, d.platform_post_id, own.platform_post_id]));
    const old = notes.find((n) => n.platform_post_id === d.platform_post_id)!;
    assert.deepEqual(old.comments.map((x) => x.content), ['i3现在优惠多少'], 'only in-window comments of an older thread');
    assert.equal(old.origin, 'db');
    assert.equal(old.public_post_id, d.id);
    assert.equal(notes.find((n) => n.platform_post_id === own.platform_post_id)!.managed_author, true);

    const withCompetitors = new Set(loadDbCorpus(ctx, scope, 30, { include_competitors: true }).map((n) => n.platform_post_id));
    assert.ok(withCompetitors.has(f.platform_post_id), 'Model 3 is an i3 competitor');
    assert.equal(withCompetitors.size, 5, 'GLC and X3 posts stay out of an i3 scope');
  });

  it('merges provider and DB notes by platform id', () => {
    const db = note({
      platform_post_id: 'n1',
      title: '宝马i3',
      origin: 'db',
      public_post_id: 'ppost_1',
      like_count: 10,
      comments: [comment({ platform_comment_id: 'k1', content: '多少钱', public_comment_id: 'pcmt_1' })],
    });
    const provider = note({
      platform_post_id: 'n1',
      title: '宝马i3',
      like_count: 99,
      comments: [comment({ platform_comment_id: 'k1', content: '多少钱' }), comment({ platform_comment_id: 'k2', content: '有现车吗' })],
    });
    const other = note({ platform_post_id: 'n2', title: '宝马X3', origin: 'db' });
    const merged = mergeCorpora([provider], [db, other]);
    const m = merged.find((n) => n.platform_post_id === 'n1')!;
    assert.equal(m.origin, 'provider+db');
    assert.equal(m.public_post_id, 'ppost_1');
    assert.equal(m.like_count, 99);
    assert.deepEqual(m.comments.map((x) => [x.platform_comment_id, x.public_comment_id]), [
      ['k1', 'pcmt_1'],
      ['k2', null],
    ]);
    assert.equal(merged.length, 2);
  });

  it('writes an honest no-data headline naming the provider state', async () => {
    const { ctx, hz } = setup();
    const scope = resolveScope(ctx, { dealer_id: hz });
    const unavailable = assembleCorpus(ctx, scope, await fetchProviderCorpus(ctx, scope, ['宝马i3']));
    const h1 = noDataHeadline(scope, unavailable);
    assert.ok(h1.startsWith('暂无可分析的小红书公开数据'), h1);
    assert.ok(h1.includes('UNAVAILABLE'));
    const notQueried = assembleCorpus(ctx, scope, null);
    assert.ok(noDataHeadline(scope, notQueried).includes('本次未调用小红书搜索'));
  });
});
