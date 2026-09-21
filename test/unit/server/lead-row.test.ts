/**
 * The lead inbox row: one number, one sentence, one status. The preview drops Xiaohongshu topic tags and emoji codes
 * (the stored signal stays verbatim for the detail page), repeats are left out, and the status says what the lead is
 * waiting for.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { leadInbox } from '../../../src/server/api/leads.ts';
import { leadsPage } from '../../../src/server/pages/leads.ts';
import type { PageEnv } from '../../../src/server/pages/shell.ts';
import type { RequestContext } from '../../../src/server/http.ts';
import { assignLead } from '../../../src/skills/acquisition/account-assignment/index.ts';
import { transitionLead } from '../../../src/skills/operations/crm/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { accountIdByPlatformId, dealerIdByKey, loadDealerFixture, seedLead, seedOutreach } from '../../helpers/fixtures.ts';

/** just the list markup: the filter bar mentions every label, the row is what this test is about */
function rows(ctx: TestContext, dealerId: string): string {
  const html = render(ctx, dealerId);
  const start = html.indexOf('<div class="lead-list">');
  return start < 0 ? '' : html.slice(start, html.indexOf('<div class="pager">', start));
}

function render(ctx: TestContext, dealerId: string): string {
  const env = { runtime: { ctx, config: { warnings: [] } }, options: { auth_enabled: true } } as unknown as PageEnv;
  const rc = { query: new URLSearchParams({ dealer: dealerId }), req: { headers: {} }, operator: 'op' } as unknown as RequestContext;
  return String(leadsPage(env, rc).html);
}

function seedSignal(ctx: TestContext, leadId: string, content: string): void {
  const now = ctx.clock.iso();
  const post = ctx.db.table('public_posts').insert({
    id: `pp_${leadId}`, platform: 'xiaohongshu', platform_post_id: `n_${leadId}`, xsec_token: 't', url: null, title: '小鹏L03提车',
    content: '正文', author_platform_user_id: 'u1', author_nickname: '路人', author_profile_url: null, ip_location: '浙江', tags: [],
    like_count: 0, comment_count: 0, collect_count: 0, published_at: now, own_post_id: null, first_search_run_id: null, fetched_at: now, raw: {}, data_mode: 'live',
  });
  ctx.db.table('lead_signals').insert({
    id: `sig_${leadId}`, lead_id: leadId, source_type: 'post', public_post_id: post.id, public_comment_id: null, post_title: post.title,
    content, signal_at: now, search_run_id: null, query_id: null, intent: {}, signal_score: 70, evidence: [], engine: 'rules',
    created_at: now, is_purchase_signal: true, strength: 2, transaction_questions: [], author_role: null, actor_type: 'BUYER',
  });
  ctx.db.table('leads').update(leadId, { signal_count: 1, primary_signal_id: `sig_${leadId}` });
}

describe('lead inbox row', () => {
  it('shows the sentence without Xiaohongshu topic tags or emoji codes; the stored signal keeps them', () => {
    const ctx = createTestContext();
    const dealerId = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const lead = seedLead(ctx, { dealer_id: dealerId, platform_user_id: 'buyer-1' });
    const raw = '小鹏L03有转让的吗，最好10月能提的[哭惹R]#小鹏汽车[话题]# #小鹏L03[话题]#';
    seedSignal(ctx, lead.id, raw);

    const list = rows(ctx, dealerId);
    assert.match(list, /小鹏L03有转让的吗，最好10月能提的/);
    assert.doesNotMatch(list, /话题/, 'topic tags are not shown in the row');
    assert.doesNotMatch(list, /哭惹R/, 'emoji codes are not shown in the row');
    assert.equal(ctx.db.table('lead_signals').require(`sig_${lead.id}`).content, raw, 'the stored signal is untouched');
    assert.equal(leadInbox(ctx, { dealer_id: dealerId, filters: { dealer_id: dealerId }, limit: 10, offset: 0 })[0].original_signal, raw);
  });

  it('the status column says what the lead waits for', () => {
    const ctx = createTestContext();
    const summary = loadDealerFixture(ctx);
    const dealerId = dealerIdByKey(summary, 'hz-bmw');
    const lead = seedLead(ctx, { dealer_id: dealerId, platform_user_id: 'buyer-2' });
    seedSignal(ctx, lead.id, '杭州什么价');
    assert.match(rows(ctx, dealerId), /待分配账号/);

    const assignment = assignLead(ctx, lead.id, { actor: 'test' });
    assert.ok(assignment.assignment);
    seedOutreach(ctx, {
      lead_id: lead.id,
      account_id: accountIdByPlatformId(summary, 'xhs-hz-official'),
      assignment_id: assignment.assignment.id,
      status: 'READY_FOR_REVIEW',
    });
    const waiting = rows(ctx, dealerId);
    assert.match(waiting, /私信待审核/);
    assert.doesNotMatch(waiting, /潜在买家|真实数据/, 'actor and data-mode badges stay off the row');
    assert.match(waiting, /lead-col-why|lead-col-origin/, 'the evidence and source columns are part of the row');

    transitionLead(ctx, lead.id, 'LOST', { reason: 'llm_screen', actor: 'test' });
    assert.match(render(ctx, dealerId), /没有符合条件的线索/, 'a closed lead leaves the inbox');
  });
});

describe('lead inbox filters', () => {
  /** two open leads at different stages: 阶段 can split the list, the other filters cannot */
  function seedTwo(ctx: TestContext, dealerId: string): void {
    for (const [i, id] of ['buyer-a', 'buyer-b'].entries()) {
      const lead = seedLead(ctx, { dealer_id: dealerId, platform_user_id: id, stage: i === 0 ? 'CANDIDATE' : 'QUALIFIED' });
      seedSignal(ctx, lead.id, `${id} 想买车，落地多少`);
    }
  }

  it('keeps only the filters that can split the list; the rest sit under 更多筛选', () => {
    const ctx = createTestContext();
    const dealerId = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    seedTwo(ctx, dealerId);
    const html = render(ctx, dealerId);
    const bar = html.slice(html.indexOf('<form class="filters"'), html.indexOf('<details class="filters-more"'));

    assert.match(bar, /name="q"/);
    assert.match(bar, /name="tier"/);
    assert.match(bar, /name="location"/);
    // every open lead is BUYER / live: those dropdowns would have a single option, so they are not rendered at all
    assert.doesNotMatch(html, /name="actor_type"/, 'identity cannot split a list of buyers');
    assert.doesNotMatch(html, /name="data_mode"/, 'one data mode means no data-mode filter');
    assert.match(html, /<summary>更多筛选<\/summary>/);
    const drawer = html.slice(html.indexOf('<details class="filters-more"'));
    assert.match(drawer, /name="stage"/, '阶段 can split these two leads, so it is offered');
    assert.doesNotMatch(drawer, /name="source_type"/, 'one signal type means no signal-type filter');
  });

  it('a filter that carries a value is always shown, and the drawer opens marked', () => {
    const ctx = createTestContext();
    const dealerId = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    seedTwo(ctx, dealerId);
    const env = { runtime: { ctx, config: { warnings: [] } }, options: { auth_enabled: true } } as unknown as PageEnv;
    const rc = { query: new URLSearchParams({ dealer: dealerId, source_type: 'comment' }), req: { headers: {} }, operator: 'op' } as unknown as RequestContext;
    const html = String(leadsPage(env, rc).html);
    assert.match(html, /name="source_type"/, 'a filter from the URL can still be seen and cleared');
    assert.match(html, /<details class="filters-more" open><summary>更多筛选（已启用）/);
  });
});

describe('lead inbox legend', () => {
  it('explains only the states this store actually has, with live counts', () => {
    const ctx = createTestContext();
    const dealerId = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const open = seedLead(ctx, { dealer_id: dealerId, platform_user_id: 'buyer-open', stage: 'CANDIDATE' });
    seedSignal(ctx, open.id, '杭州什么价');
    const closed = seedLead(ctx, { dealer_id: dealerId, platform_user_id: 'closed-one' });
    seedSignal(ctx, closed.id, '我也定了525max');
    transitionLead(ctx, closed.id, 'LOST', { reason: 'llm_screen', actor: 'test' });

    const html = render(ctx, dealerId);
    const legend = html.slice(html.indexOf('<details class="legend"'), html.indexOf('</details>', html.indexOf('<details class="legend"')));
    assert.match(legend, /候选<span class="legend-n">1<\/span><\/div><div>分数未到合格线/);
    assert.match(legend, /流失<span class="legend-n">1<\/span>/);
    assert.match(legend, /AI 看过他的原话：不是本地在市买家<span class="legend-n">1<\/span>/, '内部说法「大模型复核」不出现在页面上');
    assert.doesNotMatch(legend, /已约好到店时间|正在谈价的线索|刚从公开内容里发现/, 'stages this store never reached are not explained');
    assert.match(legend, /关闭的线索不会被删除/);
  });
});
