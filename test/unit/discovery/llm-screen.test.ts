/**
 * LLM screening of discovery candidates: the rules nominate, the LLM decides who is a buyer (validated, verbatim), and
 * the goal's area — not a fixed default — decides which buyers become leads.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LlmJsonRequest, LlmProvider, LlmResult, LlmStatus } from '../../../src/providers/llm/types.ts';
import { SimulationXhsProvider } from '../../../src/providers/xhs/simulation.ts';
import { parseGoal } from '../../../src/operator/goal-parser.ts';
import { LEAD_FRESH_DAYS, ingestPublicContent, runSearchQuery, targetAreaFor } from '../../../src/skills/acquisition/lead-discovery/index.ts';
import { rescreenLeads } from '../../../src/skills/acquisition/lead-discovery/rescreen.ts';
import { assignLead } from '../../../src/skills/acquisition/account-assignment/index.ts';
import { lostReasonText, transitionLead } from '../../../src/skills/operations/crm/index.ts';
import { getLeadInbox } from '../../../src/skills/operations/analytics/index.ts';
import {
  buildScreenRequest,
  inTargetArea,
  validateScreen,
  type ScreenItem,
} from '../../../src/skills/acquisition/lead-discovery/llm-screen.ts';
import { newId } from '../../../src/core/ids.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';

class FakeLlm implements LlmProvider {
  readonly name = 'fake';
  calls: LlmJsonRequest[] = [];
  private readonly respond: (items: { id: string; 原文: string }[]) => unknown;
  private readonly fail: boolean;
  constructor(respond: (items: { id: string; 原文: string }[]) => unknown, fail = false) {
    this.respond = respond;
    this.fail = fail;
  }
  status(): LlmStatus {
    return { provider: 'fake', status: 'AVAILABLE', model: 'fake-1', reason: 'test' };
  }
  async completeJson<T>(req: LlmJsonRequest): Promise<LlmResult<T>> {
    this.calls.push(req);
    if (this.fail) return { ok: false, reason: 'HTTP 503 upstream unavailable' };
    const payload = JSON.parse(req.prompt.slice(req.prompt.indexOf('\n') + 1)) as { 待审核: { id: string; 原文: string }[] };
    return { ok: true, data: this.respond(payload.待审核) as T, model: 'fake-1' };
  }
  async completeText(): Promise<LlmResult<string>> {
    return { ok: false, reason: 'unused' };
  }
}

const item = (id: string, text: string, extra: Partial<ScreenItem> = {}): ScreenItem => ({
  id,
  source_type: 'comment',
  text,
  author_nickname: null,
  ip_location: null,
  reply_to: null,
  ...extra,
});

describe('llm-screen: output validation (pure)', () => {
  const items = [item('i0', '小鹏L03有转让的吗或者现车，最好10月能提的，坐标浙江'), item('i1', '我也定了纯电525max，落地150942')];

  it('keeps valid verdicts; drops unknown roles, non-verbatim quotes, unknown and repeated ids', () => {
    const v = validateScreen(
      {
        results: [
          { id: 'i0', role: 'buyer', location: '浙江', quote: '小鹏L03有转让的吗或者现车', reason: '在找现车' },
          { id: 'i0', role: 'owner', location: null, quote: '最好10月能提的', reason: 'dup' },
          { id: 'i1', role: 'owner', location: null, quote: '我已经提车了', reason: '编造的引用' },
          { id: 'i9', role: 'buyer', location: null, quote: 'x', reason: 'unknown id' },
        ],
      },
      items,
    );
    assert.deepEqual([...v.keys()], ['i0']);
    assert.equal(v.get('i0')?.role, 'buyer');
    assert.equal(v.get('i0')?.location, '浙江');
    assert.equal(validateScreen({ results: [{ id: 'i1', role: 'shopper', location: null, quote: '我也定了', reason: '' }] }, items).size, 0);
    assert.equal(validateScreen('not json', items).size, 0);
  });

  it('a location the text does not contain is dropped (never inferred)', () => {
    const v = validateScreen({ results: [{ id: 'i1', role: 'owner', location: '上海', quote: '我也定了纯电525max', reason: '已下订' }] }, items);
    assert.equal(v.get('i1')?.location, null);
  });

  it('the request carries the reply context and the post, not IP-based guesses', () => {
    const req = buildScreenRequest({ title: '小鹏L03提车一个月', content: '说说感受' }, [item('i0', '我也是', { reply_to: '我也定了525max' })], ['小鹏']);
    assert.equal(req.purpose, 'lead_screening');
    assert.match(req.prompt, /回复的评论": "我也定了525max"/);
    assert.match(req.prompt, /笔记标题": "小鹏L03提车一个月"/);
    assert.match(req.system, /不要用 IP 属地推测/);
  });
});

describe('llm-screen: target area comes from the goal', () => {
  const zhoushan = { city: '舟山', province: '浙江' };
  it('stated place first, then IP province; unknown stays in; nationwide accepts all', () => {
    assert.equal(inTargetArea(zhoushan, '广东', '坐标杭州').inside, true, 'stated 杭州 is in 浙江');
    assert.equal(inTargetArea(zhoushan, '浙江', '人在厦门').inside, false, 'stated place beats IP');
    assert.equal(inTargetArea(zhoushan, '浙江', null).inside, true);
    assert.equal(inTargetArea(zhoushan, '福建', null).inside, false);
    assert.equal(inTargetArea(zhoushan, null, null).basis, 'unknown');
    assert.equal(inTargetArea(null, '福建', null).inside, true);
  });

  it('全国 in a goal means no area; no place means the store area; a named place wins', () => {
    const ctx = createTestContext();
    const hz = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const dealer = ctx.db.table('dealers').require(hz);
    const now = ctx.clock.now();
    assert.equal(parseGoal('搜索全国想要下单宝马的客户', dealer, now).nationwide, true);
    assert.notEqual(parseGoal('这个月在杭州获取宝马i3线索', dealer, now).nationwide, true);
    const goal = (text: string) => {
      const id = newId('goal');
      ctx.db.table('operator_goals').insert({ id, dealer_id: hz, text, spec: parseGoal(text, dealer, now), status: 'active', plan: [], created_at: ctx.clock.iso(), updated_at: ctx.clock.iso() });
      return id;
    };
    assert.equal(targetAreaFor(ctx, dealer, goal('搜索全国想要下单宝马的客户')), null);
    assert.deepEqual(targetAreaFor(ctx, dealer, goal('获取宝马线索')), { city: dealer.city, province: dealer.province });
    assert.deepEqual(targetAreaFor(ctx, dealer, goal('这个月在宁波获取宝马线索')), { city: '宁波', province: '浙江' });
    assert.deepEqual(targetAreaFor(ctx, dealer, null), { city: dealer.city, province: dealer.province });
  });
});

function setup(llm?: LlmProvider): { ctx: TestContext; hz: string; queryId: string } {
  const ctx = createTestContext();
  const hz = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
  ctx.xhs = SimulationXhsProvider.fromFile(ctx.clock);
  if (llm) ctx.llm = llm;
  const now = ctx.clock.iso();
  const q = ctx.db.table('search_queries').insert({
    id: newId('q'), dealer_id: hz, goal_id: null, text: '宝马i3', query_class: 'direct_model', brand: 'BMW', model: null, location: null,
    priority: 0.9, status: 'active', parent_query_id: null, generation_reason: 'test', created_at: now, updated_at: now,
  });
  return { ctx, hz, queryId: q.id };
}

describe('lead-discovery with an LLM: only screened buyers become leads', () => {
  it('rules-only baseline has leads; the LLM rejecting everyone leaves none, with the reasons recorded', async () => {
    const base = setup();
    const baseline = await runSearchQuery(base.ctx, { dealer_id: base.hz, query_id: base.queryId });
    assert.ok(base.ctx.db.table('leads').count() > 0, 'the rules nominate candidates');

    const llm = new FakeLlm((items) => ({ results: items.map((i) => ({ id: i.id, role: 'owner', location: null, quote: i.原文.slice(0, 4), reason: '已购车' })) }));
    const { ctx, hz, queryId } = setup(llm);
    const run = await runSearchQuery(ctx, { dealer_id: hz, query_id: queryId });
    assert.equal(run.status, 'SUCCEEDED');
    assert.equal(ctx.db.table('leads').count(), 0);
    assert.ok(llm.calls.length > 0 && llm.calls.every((c) => c.purpose === 'lead_screening'));
    const decision = ctx.db.table('agent_decisions').findMany({ decision_type: 'lead_prefilter' }).find((d) => (d.output.screen as { candidates: number }).candidates > 0);
    assert.ok(decision);
    assert.equal((decision.output.screen as { by: string }).by, 'llm');
    assert.ok(((decision.output.screen as { rejected: Record<string, number> }).rejected.owner ?? 0) > 0);
    assert.equal(run.comments_scanned, baseline.comments_scanned, 'same content read');
  });

  it('a screened buyer becomes a lead with the LLM verdict as verbatim evidence', async () => {
    const llm = new FakeLlm((items) => ({ results: items.map((i) => ({ id: i.id, role: 'buyer', location: null, quote: i.原文.slice(0, 6), reason: '在问现车' })) }));
    const { ctx, hz, queryId } = setup(llm);
    await runSearchQuery(ctx, { dealer_id: hz, query_id: queryId });
    const leads = ctx.db.table('leads').findMany({});
    assert.ok(leads.length > 0);
    const signal = ctx.db.table('lead_signals').findMany({ lead_id: leads[0].id })[0];
    const ev = signal.evidence.find((e) => e.code === "llm_screen");
    assert.ok(ev, 'llm_screen evidence stored');
    assert.ok(signal.content.includes(ev.quote ?? '\u0000'), 'quote is verbatim');
    assert.match(ev.label, /大模型复核：在问现车/);
  });

  it('when the LLM call fails nothing becomes a lead (never falls back to the rules while an LLM is configured)', async () => {
    const llm = new FakeLlm(() => ({}), true);
    const { ctx, hz, queryId } = setup(llm);
    const run = await runSearchQuery(ctx, { dealer_id: hz, query_id: queryId });
    assert.equal(run.status, 'SUCCEEDED');
    assert.equal(ctx.db.table('leads').count(), 0);
    const d = ctx.db.table('agent_decisions').findMany({ decision_type: 'lead_prefilter' }).find((x) => (x.output.screen as { unscreened: number }).unscreened > 0);
    assert.ok(d);
    assert.match(String((d.output.screen as { failures: string[] }).failures[0]), /503/);
  });
});

describe('lead-discovery: only fresh content becomes leads', () => {
  it(`texts older than ${LEAD_FRESH_DAYS} days are stored but never evaluated`, async () => {
    const ctx = createTestContext();
    const hz = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const now = ctx.clock.now().getTime();
    const note = (id: string, daysAgo: number) => ({
      platform_post_id: id, xsec_token: 't', title: '宝马i3现在值得买吗', content: '想买i3，杭州现车多少钱？这周想去看看',
      author: { platform_user_id: `u-${id}`, nickname: '路人' }, like_count: 0, comment_count: 0, collect_count: 0, tags: [],
      ip_location: '浙江', published_at: new Date(now - daysAgo * 86_400_000).toISOString(), url: null, comments: [],
    });
    const freshSince = new Date(now - LEAD_FRESH_DAYS * 86_400_000).toISOString();
    const out = await ingestPublicContent(ctx, { dealer_id: hz, notes: [note('old', 10), note('new', 1)], data_mode: 'import', fresh_since: freshSince });
    assert.equal(out.posts, 2, 'both notes are stored');
    assert.equal(out.stale_skipped, 1);
    assert.equal(out.users_evaluated, 1);
    assert.equal(ctx.db.table('leads').count({ platform_user_id: 'u-old' }), 0);
    assert.equal(ctx.db.table('leads').count({ platform_user_id: 'u-new' }), 1);
  });
});

describe('rescreen: cleaning up leads the rules made before the LLM screen', () => {
  async function seedRulesLeads() {
    const { ctx, hz, queryId } = setup();
    await runSearchQuery(ctx, { dealer_id: hz, query_id: queryId });
    const leads = ctx.db.table('leads').findMany({});
    assert.ok(leads.length >= 2, 'the rules made leads');
    return { ctx, hz, leads };
  }

  it('closes non-buyers with the verdict as the reason, keeps buyers, and never deletes anything', async () => {
    const { ctx, hz, leads } = await seedRulesLeads();
    const keep = leads[0].id;
    const rows = ctx.db.table('lead_signals').count();
    ctx.llm = new FakeLlm((items) => ({
      results: items.map((i) => ({
        id: i.id,
        role: i.id.startsWith(keep) ? 'buyer' : 'owner',
        location: null,
        quote: i.原文.slice(0, 5),
        reason: i.id.startsWith(keep) ? '在问现车' : '已经提车',
      })),
    }));
    const out = await rescreenLeads(ctx, { dealer_id: hz, apply_area: false });
    assert.equal(out.checked, leads.length);
    assert.equal(out.kept, 1);
    assert.equal(out.closed, leads.length - 1);
    assert.equal(out.closed_by_role.owner, leads.length - 1);
    assert.equal(ctx.db.table('leads').require(keep).stage !== 'LOST', true);
    assert.equal(ctx.db.table('leads').count({ stage: 'LOST' }), leads.length - 1);
    assert.equal(ctx.db.table('lead_signals').count(), rows, 'signals are kept');
    const closed = leads.find((l) => l.id !== keep)!;
    const event = ctx.db.table('audit_events').findOne({ action: 'lead.rescreened', entity_id: closed.id });
    assert.match(String(event?.details.reason), /大模型复核（不是本地在市买家）：已购车\/已下订/);
  });

  it('a kept lead is marked as screened, so a second run does not pay for it again', async () => {
    const { ctx, hz, leads } = await seedRulesLeads();
    const llm = new FakeLlm((items) => ({ results: items.map((i) => ({ id: i.id, role: 'buyer', location: null, quote: i.原文.slice(0, 5), reason: '在问现车' })) }));
    ctx.llm = llm;
    const first = await rescreenLeads(ctx, { dealer_id: hz, apply_area: false });
    assert.equal(first.kept, leads.length);
    assert.equal(first.closed, 0);
    const calls = llm.calls.length;
    const again = await rescreenLeads(ctx, { dealer_id: hz, apply_area: false });
    assert.equal(again.checked, 0, 'nothing left to screen');
    assert.equal(llm.calls.length, calls, 'no further LLM calls');
    const signal = ctx.db.table('lead_signals').findMany({ lead_id: leads[0].id })[0];
    assert.match(String(signal.evidence.find((e) => e.code === 'llm_screen')?.label), /大模型复核：在问现车/);
  });

  it('a failed screen leaves the lead untouched, and leads a human already contacted are never checked', async () => {
    const { ctx, hz, leads } = await seedRulesLeads();
    transitionLead(ctx, leads[0].id, 'QUALIFIED', { reason: 't', actor: 'test' });
    assignLead(ctx, leads[0].id, { actor: 'test' });
    transitionLead(ctx, leads[0].id, 'CONTACTED', { reason: 'sales wrote to them', actor: 'test' });
    ctx.llm = new FakeLlm(() => ({}), true);
    const out = await rescreenLeads(ctx, { dealer_id: hz });
    assert.equal(out.checked, leads.length - 1, 'the contacted lead is out of scope');
    assert.equal(out.closed, 0);
    assert.equal(out.unscreened, leads.length - 1);
    assert.match(out.failures[0] ?? '', /503/);
    assert.equal(ctx.db.table('leads').count({ stage: 'LOST' }), 0);
  });

  it('without an LLM nothing is touched', async () => {
    const { ctx, hz, leads } = await seedRulesLeads();
    const out = await rescreenLeads(ctx, { dealer_id: hz });
    assert.deepEqual([out.checked, out.closed, out.kept], [0, 0, 0]);
    assert.match(out.failures[0] ?? '', /LLM 不可用/);
    assert.equal(ctx.db.table('leads').count({ stage: 'LOST' }), 0);
    assert.ok(leads.length > 0);
  });
});

describe('lead cards: where the lead came from, and why it was closed', () => {
  it('carries the search query and task of the signal, and a Chinese lost reason', async () => {
    const { ctx, hz, queryId } = setup();
    await runSearchQuery(ctx, { dealer_id: hz, query_id: queryId });
    const card = getLeadInbox(ctx, { dealer_id: hz, limit: 1 })[0];
    assert.equal(card.source.query_text, '宝马i3');
    assert.ok(card.source.search_run_id?.startsWith('run_'));
    assert.ok(card.source.searched_at);

    transitionLead(ctx, card.lead_id, 'LOST', { reason: 'llm_screen', actor: 'test' });
    const closed = getLeadInbox(ctx, { dealer_id: hz, limit: 50 }).find((c) => c.lead_id === card.lead_id);
    assert.equal(closed?.next_action, '已流失：大模型复核：不是本地在市买家');
    assert.equal(ctx.db.table('leads').require(card.lead_id).lost_reason, 'llm_screen', 'the code stays in the column');
    assert.equal(lostReasonText('客户说买了别的品牌'), '客户说买了别的品牌', 'text a human wrote is shown as it is');
  });
});
