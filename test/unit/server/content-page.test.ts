/**
 * 内容 page: one surface at a time. Tabs carry the real counts, the page opens on the work that waits, notes look
 * like the notes they will become (cover line + title + status), and a store with no vehicles is told why the AI
 * cannot write about price or stock.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contentPage } from '../../../src/server/pages/content.ts';
import type { PageEnv } from '../../../src/server/pages/shell.ts';
import type { RequestContext } from '../../../src/server/http.ts';
import type { PostStatus } from '../../../src/core/types.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { accountIdByPlatformId, dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';

function render(ctx: TestContext, dealerId: string, query: Record<string, string> = {}): string {
  const env = { runtime: { ctx, config: { warnings: [] } }, options: { auth_enabled: true } } as unknown as PageEnv;
  const rc = { query: new URLSearchParams({ dealer: dealerId, ...query }), params: {}, req: { headers: {} }, operator: 'op' } as unknown as RequestContext;
  return String(contentPage(env, rc).html);
}

function seedPost(ctx: TestContext, dealerId: string, accountId: string, status: PostStatus, title: string, cover = ''): string {
  const id = `post_${status}_${title}`;
  const now = ctx.clock.iso();
  ctx.db.table('posts').insert({
    id,
    dealer_id: dealerId,
    account_id: accountId,
    plan_id: null,
    slot_date: now.slice(0, 10),
    pillar: 'buying_guide',
    topic: `general:buying_guide:${title}`,
    angle: '',
    model: null,
    title: status === 'PLANNED' ? '' : title,
    body: status === 'PLANNED' ? '' : '正文',
    tags: [],
    cover_text: cover,
    fact_refs: [],
    status,
    review:
      status === 'IN_REVIEW'
        ? {
            fact_check: { passed: true, issues: [], verified_claims: [] },
            duplicate_check: { passed: true, max_similarity: 0.1 },
            compliance: { passed: true, issues: [] },
            reviewed_at: now,
          }
        : null,
    approval_policy: 'REVIEW_REQUIRED',
    platform_note_id: null,
    scheduled_for: null,
    published_at: null,
    metrics: { views: 0, likes: 0, collects: 0, comments: 0, shares: 0 },
    metrics_updated_at: null,
    engine: 'rules',
    created_at: now,
    updated_at: now,
  });
  return id;
}

describe('内容 page', () => {
  it('opens on the work that waits, with counted tabs', () => {
    const ctx = createTestContext();
    const summary = loadDealerFixture(ctx);
    const dealerId = dealerIdByKey(summary, 'hz-bmw');
    const accountId = accountIdByPlatformId(summary, 'xhs-hz-official');
    seedPost(ctx, dealerId, accountId, 'IN_REVIEW', '待批准', '置换补贴最高 8000');
    seedPost(ctx, dealerId, accountId, 'PLANNED', '还没写的选题');

    const html = render(ctx, dealerId);
    assert.match(html, /class="view-tabs"/);
    for (const t of ['本周要发什么', '等你处理', '发出去之后', '评论回复']) assert.ok(html.includes(t), `tab ${t}`);
    assert.match(html, /等你处理<span class="tab-n">1<\/span>/, 'the tab counts real posts');
    assert.match(html, /<h2 class="section-title">等你处理/, 'and the page lands there');
    // What the page is for lives behind the 「?」 next to the title, not written out under it.
    assert.match(html, /<h1>内容<details class="hint">/, 'the title carries the explanation');
    assert.match(html, /AI 先排选题、写正文/, 'and the explanation is inside it');
    assert.match(html, /<p class="subtitle">杭州宝马中心<\/p>/, 'the subtitle is the store, nothing else');
  });

  it('shows a note as a note: cover line, title, status and the check result', () => {
    const ctx = createTestContext();
    const summary = loadDealerFixture(ctx);
    const dealerId = dealerIdByKey(summary, 'hz-bmw');
    const accountId = accountIdByPlatformId(summary, 'xhs-hz-official');
    const id = seedPost(ctx, dealerId, accountId, 'IN_REVIEW', '本周到店礼', '到店礼与置换补贴');

    const html = render(ctx, dealerId, { view: 'todo' });
    assert.match(html, /class="note-cover"/);
    assert.match(html, /note-cover-text">到店礼与置换补贴/, 'the cover shows the cover line, like the real note will');
    assert.match(html, /note-title">本周到店礼/);
    assert.match(html, /✓ 事实核查/);
    assert.match(html, /✓ 合规/);
    assert.match(html, new RegExp(`/content/posts/${id}`));
    assert.match(html, /去看一眼/);
  });

  it('the week view is a board: one row per account, one column per day', () => {
    const ctx = createTestContext();
    const summary = loadDealerFixture(ctx);
    const dealerId = dealerIdByKey(summary, 'hz-bmw');
    const accountId = accountIdByPlatformId(summary, 'xhs-hz-official');
    seedPost(ctx, dealerId, accountId, 'PLANNED', '本周选题');

    const html = render(ctx, dealerId, { view: 'week' });
    assert.match(html, /class="board"/);
    assert.match(html, /board-head is-today|is-today/, 'today is marked');
    assert.match(html, /本周 1 篇/, 'each account row says how many notes it has this week');
    assert.match(html, /本周选题/);
  });

  it('says why the AI cannot write about price or stock without vehicles, and never repeats the open tab as the action', () => {
    const ctx = createTestContext();
    const summary = loadDealerFixture(ctx);
    const dealerId = dealerIdByKey(summary, 'hz-bmw');
    const accountId = accountIdByPlatformId(summary, 'xhs-hz-official');
    ctx.db.run('DELETE FROM vehicles');
    seedPost(ctx, dealerId, accountId, 'IN_REVIEW', '待批准');

    const onTodo = render(ctx, dealerId, { view: 'todo' });
    assert.match(onTodo, /还没有车型资料/);
    assert.match(onTodo, /不会编/);
    assert.doesNotMatch(onTodo, /处理 1 篇等你的笔记/, 'the primary action never points at the tab already open');

    const onWeek = render(ctx, dealerId, { view: 'week' });
    assert.match(onWeek, /处理 1 篇等你的笔记/);
  });

  it('empty states explain what will appear there', () => {
    const ctx = createTestContext();
    const dealerId = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');

    const week = render(ctx, dealerId, { view: 'week' });
    assert.match(week, /这一周还没有排选题/);
    assert.match(render(ctx, dealerId, { view: 'todo' }), /没有等你处理的笔记/);
    assert.match(render(ctx, dealerId, { view: 'published' }), /还没有已发布的笔记/);
    assert.match(render(ctx, dealerId, { view: 'replies' }), /没有待回复的评论/);
  });
});
