/**
 * Regression (found by test/integration/acquisition-core.test.ts): a note enters the research corpus when ANY of its
 * texts is relevant, and every buyer question under it used to be counted for the scope — an i3 brief counted
 * '上海X3现在什么价' and 'X3可以以租代购吗？' as i3 demand. Questions naming only other models are now excluded.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { newId } from '../../../src/core/ids.ts';
import type { PublicPost, ResearchBrief } from '../../../src/core/types.ts';
import { namesOnlyOutOfScopeModels } from '../../../src/skills/research/shared.ts';
import { runXhsResearch } from '../../../src/skills/research/xhs-research/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';

const COMMENTS = {
  x3: { id: 'c-scope-x3', author: 'u-scope-x3', text: 'X3 25L现在多少钱' },
  i3: { id: 'c-scope-i3', author: 'u-scope-i3', text: '现在i3优惠多少' },
  store: { id: 'c-scope-store', author: 'u-scope-store', text: '杭州哪家宝马店靠谱' },
  both: { id: 'c-scope-both', author: 'u-scope-both', text: 'i3和X3到底选哪个？' },
} as const;

function setup(): { ctx: TestContext; hz: string } {
  // default test context: UnavailableXhsProvider → the brief is built from the ingested rows only (deterministic)
  const ctx = createTestContext();
  const summary = loadDealerFixture(ctx);
  const hz = dealerIdByKey(summary, 'hz-bmw');
  const post: PublicPost = ctx.db.table('public_posts').insert({
    id: newId('ppost'),
    platform: 'xiaohongshu',
    platform_post_id: 'note-scope-brand-001',
    xsec_token: null,
    url: null,
    title: '杭州买宝马攻略｜到店前必看',
    content: '到店前先问清落地价包含哪些费用，优惠和金融政策分开谈。',
    author_platform_user_id: 'u-scope-author',
    author_nickname: '杭州买车笔记',
    author_profile_url: null,
    ip_location: '浙江',
    tags: [],
    like_count: 120,
    comment_count: 4,
    collect_count: 30,
    published_at: '2026-09-10T02:00:00.000Z',
    data_mode: 'import',
    own_post_id: null,
    first_search_run_id: null,
    fetched_at: ctx.clock.iso(),
    raw: {},
  });
  let minute = 0;
  for (const c of Object.values(COMMENTS)) {
    minute += 5;
    ctx.db.table('public_comments').insert({
      id: newId('pcmt'),
      platform: 'xiaohongshu',
      platform_comment_id: c.id,
      public_post_id: post.id,
      parent_comment_id: null,
      author_platform_user_id: c.author,
      author_nickname: c.author,
      content: c.text,
      ip_location: '浙江',
      like_count: 1,
      published_at: `2026-09-11T03:${String(minute).padStart(2, '0')}:00.000Z`,
      data_mode: 'import',
      prefilter_passed: true,
      prefilter_reason: 'keyword_hit',
      first_search_run_id: null,
      fetched_at: ctx.clock.iso(),
      raw: {},
    });
  }
  return { ctx, hz };
}

const citedComments = (brief: ResearchBrief): Set<string> =>
  new Set(
    brief.findings.insights
      .flatMap((i) => i.evidence)
      .map((e) => e.source_ref ?? '')
      .filter((ref) => ref.startsWith('comment:'))
      .map((ref) => ref.slice('comment:'.length)),
  );
const questionTotal = (brief: ResearchBrief) => (brief.findings.top_questions ?? []).reduce((s, q) => s + q.count, 0);

describe('xhs-research: comment-level model scope', () => {
  it('namesOnlyOutOfScopeModels excludes only comments that name models, none of them in scope', () => {
    const i3 = { models: ['i3'] };
    assert.equal(namesOnlyOutOfScopeModels(i3, '上海X3现在什么价'), true);
    assert.equal(namesOnlyOutOfScopeModels(i3, 'X3和GLC选哪个'), true);
    assert.equal(namesOnlyOutOfScopeModels(i3, 'i3和Model 3到底选哪个，纠结死了'), false, 'names a scope model');
    assert.equal(namesOnlyOutOfScopeModels(i3, '现在优惠多少'), false, 'names no model: inherits the note');
    assert.equal(namesOnlyOutOfScopeModels({ models: ['3 Series'] }, '325Li和3系怎么选'), false, 'canonical model names match');
    assert.equal(namesOnlyOutOfScopeModels({ models: [] }, '上海X3现在什么价'), false, 'an empty scope excludes nothing');
    assert.equal(namesOnlyOutOfScopeModels(i3, ''), false);
  });

  it('an i3 brief never counts or cites an X3-only buyer question from a brand-level note', async () => {
    const { ctx, hz } = setup();
    const brief = await runXhsResearch(ctx, { dealer_id: hz, models: ['i3'] });
    const cited = citedComments(brief);
    assert.ok(brief.findings.insights.length > 0, brief.findings.headline);
    assert.ok(!cited.has(COMMENTS.x3.id), 'X3 question must not be evidence of i3 demand');
    assert.ok(cited.has(COMMENTS.i3.id) || cited.has(COMMENTS.both.id), 'i3 questions are still counted');
    assert.equal(questionTotal(brief) >= 1, true);
    for (const q of brief.findings.top_questions ?? []) assert.notEqual(q.example_quote, COMMENTS.x3.text);
    assert.equal(brief.findings.top_questions?.some((q) => q.question === '价格多少'), false, 'the only price question is about X3');
  });

  it('the same X3 question counts for an X3 brief, where the i3 question does not', async () => {
    const { ctx, hz } = setup();
    const brief = await runXhsResearch(ctx, { dealer_id: hz, models: ['X3'] });
    const cited = citedComments(brief);
    assert.ok(cited.has(COMMENTS.x3.id), 'X3 question is X3 demand');
    assert.ok(!cited.has(COMMENTS.i3.id), 'i3 question is not X3 demand');
    assert.equal(brief.findings.top_questions?.find((q) => q.question === '价格多少')?.count, 1);
  });
});
