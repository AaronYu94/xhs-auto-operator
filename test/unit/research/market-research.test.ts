import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { newId } from '../../../src/core/ids.ts';
import type { PublicPost, ResearchBrief } from '../../../src/core/types.ts';
import { DEFAULT_SIMULATION_CORPUS_PATH, SimulationXhsProvider, type SimComment } from '../../../src/providers/xhs/simulation.ts';
import { SkillRegistry } from '../../../src/skills/registry.ts';
import {
  describeOfferFact,
  extractAmounts,
  runMarketResearch,
  skill,
} from '../../../src/skills/research/automotive-market-research/index.ts';
import { createTestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';

function corpusSources(): Map<string, string[]> {
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
  return sources;
}

let seq = 0;
function seedPost(ctx: ReturnType<typeof createTestContext>, title: string, content: string, publishedAt: string): PublicPost {
  seq++;
  return ctx.db.table('public_posts').insert({
    id: newId('ppost'),
    platform: 'xiaohongshu',
    platform_post_id: `mkt-note-${seq}`,
    xsec_token: null,
    url: null,
    title,
    content,
    author_platform_user_id: `mkt-author-${seq}`,
    author_nickname: 'i3新车主',
    author_profile_url: null,
    ip_location: '浙江',
    tags: [],
    like_count: 50,
    comment_count: 3,
    collect_count: 10,
    published_at: publishedAt,
    own_post_id: null,
    first_search_run_id: null,
    fetched_at: ctx.clock.iso(),
    raw: {},
  });
}

function seedComment(ctx: ReturnType<typeof createTestContext>, post: PublicPost, content: string, ip: string, publishedAt: string) {
  seq++;
  return ctx.db.table('public_comments').insert({
    id: newId('pcmt'),
    platform: 'xiaohongshu',
    platform_comment_id: `mkt-cmt-${seq}`,
    public_post_id: post.id,
    parent_comment_id: null,
    author_platform_user_id: `mkt-user-${seq}`,
    author_nickname: '网友',
    content,
    ip_location: ip,
    like_count: 0,
    published_at: publishedAt,
    prefilter_passed: false,
    prefilter_reason: '',
    first_search_run_id: null,
    fetched_at: ctx.clock.iso(),
    raw: {},
  });
}

describe('automotive-market-research: user talk vs dealer facts', () => {
  it('keeps user price/discount talk and Dealer Brain offers/inventory in separate, correctly referenced insights', async () => {
    const ctx = createTestContext();
    ctx.xhs = SimulationXhsProvider.fromFile(ctx.clock);
    const summary = loadDealerFixture(ctx);
    const hz = dealerIdByKey(summary, 'hz-bmw');
    const sources = corpusSources();
    const offers = new Map(ctx.db.table('offers').findMany({}).map((o) => [`offer:${o.id}`, o]));
    const vehicles = new Map(ctx.db.table('vehicles').findMany({}).map((veh) => [veh.id, veh]));
    const inventory = new Map(ctx.db.table('inventory').findMany({ dealer_id: hz }).map((row) => [`inventory:${row.id}`, vehicles.get(row.vehicle_id)!.trim]));

    const brief = await runMarketResearch(ctx, { dealer_id: hz });
    assert.equal(brief.kind, 'market');
    assert.ok(brief.findings.insights.length > 0);
    const userRef = (ref: string) => ref.startsWith('comment:') || ref.startsWith('note:');

    for (const insight of brief.findings.insights) {
      for (const e of insight.evidence) {
        const ref = e.source_ref!;
        if (userRef(ref)) {
          assert.ok(sources.get(ref)?.some((t) => t.includes(e.quote!)), `"${e.quote}" verbatim in ${ref}`);
        } else if (ref.startsWith('offer:')) {
          const offer = offers.get(ref);
          assert.ok(offer, `unknown offer ${ref}`);
          assert.equal(offer.dealer_id, hz, 'only this dealer’s offers');
          assert.equal(e.quote, offer.title);
          assert.ok(e.label.startsWith('门店事实：'));
        } else if (ref.startsWith('inventory:')) {
          assert.equal(e.quote, inventory.get(ref));
          assert.ok(e.label.startsWith('门店事实：'));
        } else {
          assert.fail(`unexpected evidence ref ${ref}`);
        }
      }
      const refs = insight.evidence.map((e) => e.source_ref!);
      if (insight.text.startsWith('【门店事实·Dealer Brain】')) {
        assert.ok(refs.every((r) => r.startsWith('offer:')), `dealer fact insight cites only offers: ${insight.text}`);
      } else if (insight.text.startsWith('【用户讨论 vs 门店事实】') || insight.text.startsWith('【门店库存 vs 用户需求】')) {
        for (const e of insight.evidence) {
          if (userRef(e.source_ref!)) assert.ok(e.label.startsWith('用户讨论：'), e.label);
        }
      } else if (insight.text.startsWith('【用户讨论')) {
        assert.ok(refs.every(userRef), `user talk insight cites only public text: ${insight.text}`);
      } else if (insight.text.startsWith('【区域需求')) {
        assert.ok(refs.every((r) => r.startsWith('comment:')));
      } else {
        assert.fail(`unlabelled insight: ${insight.text}`);
      }
    }

    const texts = brief.findings.insights.map((i) => i.text);
    const i3Offers = texts.find((t) => t.startsWith('【门店事实·Dealer Brain】i3'));
    assert.ok(i3Offers && i3Offers.includes('i3金九限时优惠') && i3Offers.includes('i3 36期0息'), String(i3Offers));
    assert.ok(i3Offers.includes('36期') && i3Offers.includes('0息') && i3Offers.includes('有效期至9月30日'));
    const i3Stock = texts.find((t) => t.startsWith('【门店库存 vs 用户需求】i3'));
    assert.ok(i3Stock && i3Stock.includes('现车3台') && i3Stock.includes('在途1台'), String(i3Stock));
    const x3Stock = texts.find((t) => t.startsWith('【门店库存 vs 用户需求】X3'));
    assert.ok(x3Stock && x3Stock.includes('现车3台') && x3Stock.includes('在途0台'), String(x3Stock));
    assert.ok(texts.some((t) => t.startsWith('【区域需求·IP属地】') && t.includes('浙江')));
    assert.ok(texts.some((t) => t.startsWith('【用户讨论·价格】') || t.startsWith('【用户讨论·落地价】')));
    const json = JSON.stringify(brief);
    assert.ok(!json.includes('八月清库'), 'expired offers are never presented as dealer facts');
    assert.ok(!json.includes('上海宝马中心'), 'other dealers’ facts never leak');
    assert.ok(brief.findings.headline.includes('用户讨论') && brief.findings.headline.includes('门店事实'));
    const decision = ctx.db.table('agent_decisions').findOne({ subject_id: brief.id })!;
    assert.equal((decision.output as { evidence_dropped_unverified: number }).evidence_dropped_unverified, 0);
  });

  it('parses user-stated landing prices and discounts as quoted numbers, ignoring marketing spam', async () => {
    const ctx = createTestContext();
    const hz = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const post = seedPost(ctx, '宝马i3提车分享', '杭州提的35L，落地26.8万，现金优惠了9万，还送了保养', '2026-09-10T02:00:00.000Z');
    const c1 = seedComment(ctx, post, '我上个月30万落地的i3，优惠8万', '浙江', '2026-09-11T02:00:00.000Z');
    const spam = seedComment(ctx, post, '私信我底价，i3落地25万包上牌', '浙江', '2026-09-11T03:00:00.000Z');
    seedComment(ctx, post, '现在i3优惠多少', '上海', '2026-09-11T04:00:00.000Z');

    const brief = await runMarketResearch(ctx, { dealer_id: hz });
    assert.equal(brief.source_counts.provider_searches, 0);
    const landing = brief.findings.insights.find((i) => i.text.startsWith('【用户讨论·落地价】'));
    assert.ok(landing, 'landing price insight');
    assert.ok(landing.text.includes('26.8万') && landing.text.includes('30万'), landing.text);
    assert.ok(!landing.text.includes('25万'), 'spam numbers are not user talk');
    for (const e of landing.evidence) {
      assert.ok([`note:${post.platform_post_id}`, `comment:${c1.platform_comment_id}`].includes(e.source_ref!));
      assert.notEqual(e.source_ref, `comment:${spam.platform_comment_id}`);
      assert.ok(e.label.startsWith('用户讨论：'));
    }
    const discount = brief.findings.insights.find((i) => i.text.startsWith('【用户讨论·优惠】'));
    assert.ok(discount && discount.text.includes('9万') && discount.text.includes('8万'), String(discount?.text));
    assert.ok(discount.text.includes('1条买家评论询问优惠'), discount.text);
    assert.ok(brief.findings.headline.includes('小红书搜索当前不可用'));
  });

  it('presents only offers active at the research time', async () => {
    const ctx = createTestContext({ now: '2026-08-15T02:00:00.000Z' });
    const hz = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const post = seedPost(ctx, '宝马i3现在值得买吗', '想了解i3', '2026-08-12T02:00:00.000Z');
    seedComment(ctx, post, '现在i3优惠多少', '浙江', '2026-08-13T02:00:00.000Z');
    const brief = await runMarketResearch(ctx, { dealer_id: hz });
    const i3Offers = brief.findings.insights.find((i) => i.text.startsWith('【门店事实·Dealer Brain】i3'));
    assert.ok(i3Offers && i3Offers.text.includes('i3八月清库优惠'), String(i3Offers?.text));
    assert.ok(!JSON.stringify(brief).includes('金九'), 'September offers are not yet valid');
  });

  it('writes an honest empty brief (no dealer facts either) without public data', async () => {
    const ctx = createTestContext();
    const hz = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const registry = new SkillRegistry().register(skill);
    const brief = await registry.invoke<ResearchBrief>(ctx, 'automotive-market-research', { dealer_id: hz });
    assert.deepEqual(brief.findings.insights, []);
    assert.deepEqual(brief.source_counts, { posts: 0, comments: 0, provider_searches: 0 });
    assert.ok(brief.findings.headline.startsWith('暂无可分析的小红书公开数据'));
  });
});

describe('automotive-market-research: pure helpers', () => {
  it('extracts landing prices and discount amounts with verbatim phrases and plausibility ranges', () => {
    assert.deepEqual(extractAmounts('落地价26.8万，还行', 'landing').map((a) => [a.value, a.phrase]), [[268000, '落地价26.8万']]);
    assert.deepEqual(extractAmounts('杭州26万落地', 'landing').map((a) => a.value), [260000]);
    assert.deepEqual(extractAmounts('杭州i3 35L落地多少', 'landing'), []);
    assert.deepEqual(extractAmounts('落地2000万', 'landing'), []);
    assert.deepEqual(extractAmounts('预算30万左右', 'landing'), []);
    assert.deepEqual(extractAmounts('优惠了8千', 'discount').map((a) => a.value), [8000]);
    assert.deepEqual(extractAmounts('有9万的现金优惠', 'discount').map((a) => a.value), [90000]);
    assert.deepEqual(extractAmounts('预算30万左右', 'discount'), []);
    const text = '我上个月30万落地的i3，优惠8万';
    for (const a of [...extractAmounts(text, 'landing'), ...extractAmounts(text, 'discount')]) {
      assert.ok(text.includes(a.phrase) && text.includes(a.quote));
    }
  });

  it('describes offers only from structured fields', () => {
    const ctx = createTestContext();
    const hz = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const offers = ctx.db.table('offers').findMany({ dealer_id: hz });
    const finance = offers.find((o) => o.type === 'finance')!;
    assert.equal(describeOfferFact(finance, 'Asia/Shanghai'), 'i3 36期0息（36期，0息，首付30%，有效期至9月30日）');
    const cash = offers.find((o) => o.title === 'X3现金优惠')!;
    assert.equal(describeOfferFact(cash, 'Asia/Shanghai'), 'X3现金优惠（金额6万，有效期至9月30日）');
  });
});
