/**
 * Integration gate — signal quality over the whole simulation corpus (docs/PREVIEW_FINDINGS.md F1–F5,
 * ARCHITECTURE §5.1 author roles · §5.2 out-of-area cap · §5.3 group-level dealer matching).
 *
 * Every public post (its author's signal: title + content) and every comment including replies is read through
 * SimulationXhsProvider at the test clock and evaluated with evaluateSignalForDealers against every dealer of the
 * group — the real Dealer Brain fixture, rules NLU and scoring, exactly as discovery does.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';
import type { ScoreComponent, SignalContext } from '../../src/core/types.ts';
import { DEFAULT_SIMULATION_CORPUS_PATH, SimulationXhsProvider, parseSimulationCorpus } from '../../src/providers/xhs/simulation.ts';
import type { XhsComment } from '../../src/providers/xhs/types.ts';
import { isNonBuyerRole } from '../../src/skills/acquisition/intent-detection/nlu.ts';
import {
  evaluateSignalForDealers,
  getScoringConfig,
  listGroupDealerIds,
  tierFor,
  type DealerSignalEvaluation,
} from '../../src/skills/acquisition/lead-scoring/index.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture } from '../helpers/fixtures.ts';

const SPAMMER = 'u-dealer-spam-001';
/** F1: informational posts that the preview scored 78–97. */
const CREATOR_POSTS: Record<string, string> = {
  'u-hz-guide-kol-001': '杭州买车指南针',
  'u-hz-blogger-001': '杭州小众探店车',
  'u-kol-ev-001': '电车老司机阿杰',
  'u-kol-suv-001': 'SUV测评君',
};
const OWNER_POST_AUTHOR = 'u-owner-story-001'; // 第一次买宝马的Coco (F2)
const OWNER_COMMENTER = 'u-owner-i3-001'; // i3车主小严 (F2, F4)
const OUT_OF_AREA_BUYER = 'u-gd-buyer-001'; // 深圳湾跑步的阿辉 (F3)
const IP_SHANGHAI_BUYER = 'u-sedan-001'; // 陆家嘴搬砖人 (F5)

interface Evaluated {
  results: DealerSignalEvaluation[];
  best: DealerSignalEvaluation;
}

interface CorpusSignal extends Evaluated {
  kind: 'post' | 'comment';
  note_id: string;
  author_id: string;
  nickname: string;
  text: string;
  context: SignalContext;
  signal_at: string;
}

interface Harness {
  ctx: TestContext;
  hz: string;
  sh: string;
  groupIds: string[];
  notes: number;
  signals: CorpusSignal[];
  candidate(dealerId: string): number;
  qualified(dealerId: string): number;
  evaluate(text: string, context: SignalContext, signalAt: string): Evaluated;
}

function flatten(comments: readonly XhsComment[]): XhsComment[] {
  const out: XhsComment[] = [];
  const seen = new Set<string>();
  const walk = (list: readonly XhsComment[]) => {
    for (const c of list) {
      if (!seen.has(c.platform_comment_id)) {
        seen.add(c.platform_comment_id);
        out.push(c);
      }
      walk(c.sub_comments ?? []);
    }
  };
  walk(comments);
  return out;
}

async function loadHarness(): Promise<Harness> {
  const ctx = createTestContext();
  ctx.xhs = SimulationXhsProvider.fromFile(ctx.clock);
  const summary = loadDealerFixture(ctx);
  const hz = dealerIdByKey(summary, 'hz-bmw');
  const sh = dealerIdByKey(summary, 'sh-bmw');
  const groupIds = listGroupDealerIds(ctx, hz);
  const thresholds = (dealerId: string) => getScoringConfig(ctx, dealerId).thresholds;
  const evaluate = (text: string, context: SignalContext, signalAt: string): Evaluated =>
    evaluateSignalForDealers(ctx, { dealer_ids: groupIds, text, context, signal_at: signalAt, preferred_dealer_id: hz });

  const corpus = parseSimulationCorpus(JSON.parse(readFileSync(DEFAULT_SIMULATION_CORPUS_PATH, 'utf8')));
  const signals: CorpusSignal[] = [];
  for (const note of corpus.notes) {
    const ref = { platform_post_id: note.platform_post_id, xsec_token: note.xsec_token };
    const detail = await ctx.xhs.getNote(ref);
    assert.ok(detail.ok, `getNote ${note.platform_post_id}: ${detail.ok ? '' : detail.reason}`);
    const comments = await ctx.xhs.getComments(ref, { include_replies: true, limit: 1000 });
    assert.ok(comments.ok, `getComments ${note.platform_post_id}: ${comments.ok ? '' : comments.reason}`);
    const d = detail.data;

    const postText = `${d.title}\n${d.content}`;
    const postContext: SignalContext = { source_type: 'post', post_title: d.title, ip_location: d.ip_location, author_nickname: d.author.nickname };
    const postAt = d.published_at ?? ctx.clock.iso();
    signals.push({
      kind: 'post',
      note_id: note.platform_post_id,
      author_id: d.author.platform_user_id ?? '',
      nickname: d.author.nickname ?? '',
      text: postText,
      context: postContext,
      signal_at: postAt,
      ...evaluate(postText, postContext, postAt),
    });

    for (const c of flatten(comments.data)) {
      const context: SignalContext = {
        source_type: 'comment',
        post_title: d.title,
        post_content: d.content,
        ip_location: c.ip_location,
        author_nickname: c.author.nickname,
      };
      const at = c.published_at ?? ctx.clock.iso();
      signals.push({
        kind: 'comment',
        note_id: note.platform_post_id,
        author_id: c.author.platform_user_id ?? '',
        nickname: c.author.nickname ?? '',
        text: c.content,
        context,
        signal_at: at,
        ...evaluate(c.content, context, at),
      });
    }
  }
  return {
    ctx,
    hz,
    sh,
    groupIds,
    notes: corpus.notes.length,
    signals,
    candidate: (id) => thresholds(id).candidate,
    qualified: (id) => thresholds(id).qualified,
    evaluate,
  };
}

const sum = (components: readonly ScoreComponent[]) => components.reduce((s, c) => s + c.points, 0);
const comp = (r: DealerSignalEvaluation, factor: string) => r.components.find((c) => c.factor === factor);

describe('integration: corpus signal quality (F1–F5, ARCHITECTURE §5.1–5.3)', () => {
  let h: Harness;
  before(async () => {
    h = await loadHarness();
  });

  const one = (authorId: string, text: string): CorpusSignal => {
    const s = h.signals.find((x) => x.author_id === authorId && x.text === text);
    assert.ok(s, `corpus signal by ${authorId} "${text}" not found`);
    return s;
  };
  const resultFor = (e: Evaluated, dealerId: string): DealerSignalEvaluation => {
    const r = e.results.find((x) => x.dealer_id === dealerId);
    assert.ok(r, `no result for dealer ${dealerId}`);
    return r;
  };

  it('evaluates every post and comment against every group dealer with consistent, explained scores', () => {
    assert.deepEqual(h.groupIds, [h.hz, h.sh]);
    assert.equal(h.signals.filter((s) => s.kind === 'post').length, h.notes);
    assert.ok(h.signals.filter((s) => s.kind === 'comment').length >= 100, 'every comment including replies is evaluated');
    for (const s of h.signals) {
      assert.deepEqual(s.results.map((r) => r.dealer_id), h.groupIds);
      const top = Math.max(...s.results.map((r) => r.score));
      assert.equal(s.best.score, top);
      if (resultFor(s, h.hz).score === top) assert.equal(s.best.dealer_id, h.hz, 'ties go to the query dealer');
      for (const r of s.results) {
        const label = `${s.nickname} "${s.text.slice(0, 30)}" for ${r.dealer_id}`;
        assert.equal(sum(r.components), r.score, `${label}: components sum to the score`);
        assert.equal(r.tier, tierFor(r.score, getScoringConfig(h.ctx, r.dealer_id).thresholds), label);
        assert.ok(r.detection.author_role, `${label}: author_role is always set`);
        assert.equal(typeof r.detection.is_marketing, 'boolean', label);
        if (isNonBuyerRole(r.detection.author_role)) {
          assert.equal(r.detection.is_purchase_signal, false, `${label}: ${r.detection.author_role} is never a purchase signal`);
          assert.ok(r.score < h.candidate(r.dealer_id), `${label}: ${r.detection.author_role} scored ${r.score}`);
        }
      }
    }
  });

  it('never lets the competitor salesperson u-dealer-spam-001 reach candidate', () => {
    const spam = h.signals.filter((s) => s.author_id === SPAMMER);
    assert.ok(spam.length >= 5, `found ${spam.length} spam comments`);
    for (const s of spam) {
      assert.equal(s.nickname, '宝马顾问小陈');
      for (const r of s.results) {
        assert.ok(r.score < h.candidate(r.dealer_id), `"${s.text}" scored ${r.score}`);
        assert.equal(r.detection.author_role, 'marketing');
        assert.equal(r.detection.is_marketing, true);
        assert.equal(r.detection.evidence.filter((e) => e.code === 'marketing_account').length, 1, 'marketing_account emitted once');
      }
    }
  });

  it('classifies the informational KOL posts as creators, never purchase signals (F1)', () => {
    for (const [authorId, nickname] of Object.entries(CREATOR_POSTS)) {
      const posts = h.signals.filter((s) => s.kind === 'post' && s.author_id === authorId);
      assert.equal(posts.length, 1, authorId);
      const [p] = posts;
      assert.equal(p.nickname, nickname);
      for (const r of p.results) {
        assert.equal(r.detection.author_role, 'creator', `${nickname} for ${r.dealer_id}`);
        assert.equal(r.detection.is_purchase_signal, false, nickname);
        assert.deepEqual(r.detection.transaction_questions, [], nickname);
        assert.ok(r.detection.evidence.some((e) => e.code === 'content_creator'), nickname);
        assert.ok(r.score < h.candidate(r.dealer_id), `${nickname} scored ${r.score} (preview: 78–97)`);
      }
    }
  });

  it('classifies the purchase story post and the i3 owner remarks as owners, never signals (F2, F4)', () => {
    const cocoPosts = h.signals.filter((s) => s.kind === 'post' && s.author_id === OWNER_POST_AUTHOR);
    assert.equal(cocoPosts.length, 1);
    const [coco] = cocoPosts;
    assert.equal(coco.nickname, '第一次买宝马的Coco');
    for (const r of coco.results) {
      assert.equal(r.detection.author_role, 'owner');
      assert.equal(r.detection.is_purchase_signal, false);
      assert.equal(r.detection.negative, true, '人生第一台宝马终于提啦: not in market');
      assert.ok(r.detection.evidence.some((e) => e.code === 'already_purchased'));
      assert.ok(r.score < h.candidate(r.dealer_id), `Coco scored ${r.score} (preview: 93)`);
    }

    const remarks = h.signals.filter((s) => s.author_id === OWNER_COMMENTER);
    assert.ok(remarks.length >= 5, `found ${remarks.length} owner remarks`);
    assert.ok(remarks.some((s) => s.text === '开了半年i3，做工和底盘真的好，推荐去试驾对比下'));
    assert.ok(remarks.some((s) => s.text === '同款白红，提车三个月了，很满意'));
    for (const s of remarks) {
      assert.equal(s.nickname, 'i3车主小严');
      for (const r of s.results) {
        assert.equal(r.detection.author_role, 'owner', `"${s.text}"`);
        assert.equal(r.detection.is_purchase_signal, false, `"${s.text}" could never corroborate a lead`);
        assert.ok(r.score < h.candidate(r.dealer_id), `"${s.text}" scored ${r.score} (preview: up to 82)`);
      }
    }
  });

  it('keeps the explicitly out-of-area 深圳 buyer below qualified for every dealer (F3, §5.2)', () => {
    const s = one(OUT_OF_AREA_BUYER, '深圳i3 35L落地多少');
    assert.equal(s.nickname, '深圳湾跑步的阿辉');
    assert.ok(s.best.score < h.qualified(s.best.dealer_id), `best ${s.best.score} (preview: 81)`);
    for (const r of s.results) {
      assert.equal(r.detection.is_purchase_signal, true, 'still a buyer — just outside every group dealer’s province');
      assert.equal(r.detection.intent.location, '深圳');
      const cap = comp(r, 'out_of_area_cap');
      assert.ok(cap && cap.points < 0, `out_of_area_cap for ${r.dealer_id}`);
      assert.equal(cap.max, 0);
      assert.match(cap.reason, /异地买家（深圳），不在本店服务范围/);
      assert.equal(r.score, h.qualified(r.dealer_id) - 1);
    }
  });

  /**
   * What §5.2 + §5.3 imply for 陆家嘴搬砖人 ("325Li现在落地多少", IP 属地 上海, no stated place):
   * - §5.2: an IP-only location is never capped, so BOTH dealers score the question normally.
   * - The factor rules then decide: 上海宝马中心 earns IP-province points (5) but has no 325Li; 杭州宝马中心 earns no
   *   location points but stocks the stated 325Li (inventory 7). 杭州 therefore scores strictly higher.
   * - §5.3 routes to the strictly highest score: the lead stays with 杭州宝马中心 (the query dealer).
   * - Only an explicitly stated 上海 caps 杭州宝马中心 and routes the buyer to 上海宝马中心.
   */
  it('routes 陆家嘴搬砖人 by score: IP-only 上海 is not capped, an explicit 上海 routes to 上海宝马中心 (F5, §5.2 + §5.3)', () => {
    const s = one(IP_SHANGHAI_BUYER, '325Li现在落地多少');
    assert.equal(s.nickname, '陆家嘴搬砖人');
    assert.equal(s.context.ip_location, '上海');
    const forHz = resultFor(s, h.hz);
    const forSh = resultFor(s, h.sh);
    for (const r of s.results) {
      assert.ok(r.detection.intent.inferred_fields?.includes('province'), 'the only location is IP 属地');
      assert.equal(comp(r, 'out_of_area_cap'), undefined, 'IP-only locations are never capped');
    }
    assert.equal(comp(forSh, 'location_match')?.points, 5);
    assert.equal(comp(forHz, 'location_match')?.points, 0);
    assert.equal(comp(forHz, 'inventory_match')?.points, 7, '杭州宝马中心 stocks the stated 325Li');
    assert.equal(comp(forSh, 'inventory_match')?.points, 0, '上海宝马中心 has no 325Li');
    assert.ok(forHz.score > forSh.score, `杭州 ${forHz.score} vs 上海 ${forSh.score}`);
    assert.equal(s.best.dealer_id, h.hz);
    assert.ok(forHz.score >= h.qualified(h.hz));

    const explicit = h.evaluate('上海325Li现在落地多少', s.context, s.signal_at);
    assert.equal(explicit.best.dealer_id, h.sh);
    assert.ok(comp(resultFor(explicit, h.hz), 'out_of_area_cap'), '杭州宝马中心 caps the stated 上海 buyer');
    assert.ok(explicit.best.score >= h.qualified(h.sh));

    for (const [authorId, text] of [
      ['u-sh-buyer-001', '上海X3现在什么价'],
      ['u-sh-buyer-002', '上海哪家宝马店靠谱'],
    ] as const) {
      const q = one(authorId, text);
      assert.equal(q.best.dealer_id, h.sh, text);
      assert.ok(q.best.score >= h.qualified(h.sh), `${text}: ${q.best.score}`);
      assert.ok(resultFor(q, h.hz).score < h.qualified(h.hz), `${text}: 杭州宝马中心 must not qualify it`);
    }
  });

  it('keeps genuine 杭州 askers qualified for 杭州宝马中心', () => {
    const askers: [string, 'post' | 'comment', string | null, string][] = [
      ['u-hz-buyer-001', 'comment', '杭州i3 35L白外红内有现车吗？这周想去看看', '西湖边的小鹿'],
      ['u-hz-buyer-002', 'comment', '这台白色35L还在吗？多少钱', '钱塘江的风'],
      ['u-hz-x3-002', 'comment', '有白色现车吗', '萧山阿May'],
      ['u-hz-author-001', 'post', null, '二胎妈妈Luna'],
    ];
    for (const [authorId, kind, text, nickname] of askers) {
      const s = kind === 'post' ? h.signals.find((x) => x.kind === 'post' && x.author_id === authorId) : one(authorId, text!);
      assert.ok(s, nickname);
      assert.equal(s.nickname, nickname);
      const r = resultFor(s, h.hz);
      assert.equal(r.detection.author_role, 'asker', nickname);
      assert.equal(r.detection.is_purchase_signal, true, nickname);
      assert.ok(r.score >= h.qualified(h.hz), `${nickname} scored ${r.score}`);
      assert.equal(s.best.dealer_id, h.hz, nickname);
    }

    // 二胎妈妈Luna asks owners for experiences ('有没有车主说说') and for a store — never about stock
    const luna = resultFor(h.signals.find((x) => x.kind === 'post' && x.author_id === 'u-hz-author-001')!, h.hz).detection;
    assert.deepEqual(luna.transaction_questions, ['dealer_location']);
    assert.equal(luna.intent.inventory_intent, undefined);
    assert.ok(!luna.evidence.some((e) => e.code === 'inventory'), "'有没有车主' is not '有没有车'");
  });

  it('never invents a stock question from a word that merely starts with 车 (车主 / 车友)', () => {
    for (const s of h.signals) {
      for (const r of s.results) {
        for (const e of r.detection.evidence.filter((x) => x.code === 'inventory' || x.code === 'color_trim_availability')) {
          const at = s.text.indexOf(e.quote ?? '');
          const next = at >= 0 ? s.text.slice(at + (e.quote ?? '').length, at + (e.quote ?? '').length + 1) : '';
          assert.ok(!/[主友]/.test(next), `${s.nickname} "${s.text.slice(0, 40)}": ${e.code} quote "${e.quote}" continues with ${next}`);
        }
      }
    }
  });

  it('finds a plausible number of qualified purchase signals across the corpus (sanity band 10–30)', (t) => {
    const qualified = h.signals.filter((s) => s.best.detection.is_purchase_signal && s.best.score >= h.qualified(s.best.dealer_id));
    const key = (id: string) => (id === h.hz ? 'hz-bmw' : id === h.sh ? 'sh-bmw' : id);
    t.diagnostic(`qualified purchase signals across the corpus: ${qualified.length}`);
    for (const s of [...qualified].sort((a, b) => b.best.score - a.best.score)) {
      t.diagnostic(`${s.best.score} ${key(s.best.dealer_id)} ${s.kind} ${s.nickname}: ${s.text.split('\n')[0]}`);
    }
    assert.ok(qualified.length >= 10 && qualified.length <= 30, `${qualified.length} qualified purchase signals`);
    for (const s of qualified) assert.equal(s.best.detection.author_role, 'asker', `${s.nickname}: only askers qualify`);
  });
});
