import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { newId } from '../../../src/core/ids.ts';
import type { AssignmentCandidate, AutomotiveIntent, Evidence, Lead, LeadStage } from '../../../src/core/types.ts';
import {
  ASSIGNMENT_FACTOR_MAX,
  classifyLeadIntent,
  rankAccountsForLead,
} from '../../../src/skills/acquisition/account-assignment/index.ts';
import { DEFAULT_THRESHOLDS, tierFor } from '../../../src/skills/acquisition/lead-scoring/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import {
  accountIdByPlatformId,
  dealerIdByKey,
  loadDealerFixture,
  seedAssignment,
  seedConversion,
  seedInboundReply,
  seedLead,
  seedOutreach,
} from '../../helpers/fixtures.ts';

function setup() {
  const ctx = createTestContext();
  const s = loadDealerFixture(ctx);
  return {
    ctx,
    hz: dealerIdByKey(s, 'hz-bmw'),
    sh: dealerIdByKey(s, 'sh-bmw'),
    acc: (pid: string) => accountIdByPlatformId(s, pid),
  };
}

let seq = 0;
function makeLead(
  ctx: TestContext,
  dealerId: string,
  spec: { score?: number; stage?: LeadStage; intent?: AutomotiveIntent; evidence?: Evidence[] } = {},
): Lead {
  const lead = seedLead(ctx, { dealer_id: dealerId, platform_user_id: `fleet-rank-${++seq}`, stage: spec.stage ?? 'QUALIFIED' });
  const score = spec.score ?? 96;
  return ctx.db.table('leads').update(lead.id, {
    score,
    tier: tierFor(score, DEFAULT_THRESHOLDS),
    intent: spec.intent ?? {},
    evidence: spec.evidence ?? [],
  });
}

const I3_INVENTORY: AutomotiveIntent = {
  brand: 'BMW',
  model: 'i3',
  trim: 'eDrive35L',
  location: '杭州',
  province: '浙江',
  inventory_intent: true,
  color_intent: '白外红内',
  visit_intent: true,
  purchase_stage: 'purchase_imminent',
  confidence: 0.9,
};
const X3_PRICE: AutomotiveIntent = { brand: 'BMW', model: 'X3', location: '杭州', province: '浙江', price_intent: true, purchase_stage: 'price_shopping' };
const I3_COMPARISON: AutomotiveIntent = {
  brand: 'BMW',
  model: 'i3',
  competing_models: ['Model 3'],
  location: '杭州',
  province: '浙江',
  purchase_stage: 'comparison',
};

const byName = (cands: AssignmentCandidate[]) => Object.fromEntries(cands.map((c) => [c.nickname, c]));
const factorOf = (c: AssignmentCandidate, name: string) => {
  const f = c.factors.find((x) => x.factor === name);
  assert.ok(f, `${c.nickname} lacks factor ${name}`);
  return f;
};
const printRanking = (t: { diagnostic(msg: string): void }, cands: AssignmentCandidate[]) => {
  for (const [i, c] of cands.entries())
    t.diagnostic(
      `#${i + 1} ${c.nickname} ${c.score}${c.eligible ? '' : ` (不可用: ${c.excluded_reason})`} ` +
        c.factors.map((f) => `${f.factor}=${f.points}`).join(' '),
    );
};

function assertWellFormed(cands: AssignmentCandidate[]) {
  for (const c of cands) {
    assert.equal(c.factors.length, 7, `${c.nickname} has seven factors`);
    const sum = Math.round(c.factors.reduce((s, f) => s + f.points, 0) * 10) / 10;
    assert.equal(c.score, sum, `${c.nickname} score equals the sum of its factors`);
    assert.ok(c.score >= 0 && c.score <= 100);
    for (const f of c.factors) {
      assert.equal(f.max, ASSIGNMENT_FACTOR_MAX[f.factor as keyof typeof ASSIGNMENT_FACTOR_MAX]);
      assert.ok(f.points >= 0 && f.points <= f.max, `${c.nickname}.${f.factor} within 0..max`);
      assert.ok(/[一-鿿]/.test(f.reason), `${c.nickname}.${f.factor} has a Chinese reason`);
    }
  }
  const eligibleFlags = cands.map((c) => c.eligible);
  assert.deepEqual(eligibleFlags, [...eligibleFlags].sort((a, b) => Number(b) - Number(a)), 'eligible accounts come first');
  const eligible = cands.filter((c) => c.eligible);
  for (let i = 1; i < eligible.length; i++) assert.ok(eligible[i - 1].score >= eligible[i].score, 'sorted by score desc');
}

describe('fleet ranking: spec §11 examples with the dealer fixture', () => {
  it('Hangzhou i3 eDrive35L inventory lead → 销售小王 #1 > i3电车研究所 > 官方号', (t) => {
    const { ctx, hz } = setup();
    const lead = makeLead(ctx, hz, { intent: I3_INVENTORY, score: 96 });
    const ranking = rankAccountsForLead(ctx, lead);
    printRanking(t, ranking);
    assertWellFormed(ranking);
    assert.equal(ranking.length, 6, 'only the six hz-bmw accounts are ranked');
    assert.equal(ranking[0].nickname, '销售小王·杭州宝马');
    const n = byName(ranking);
    assert.deepEqual(
      Object.fromEntries(ranking.map((c) => [c.nickname, c.score])),
      {
        '销售小王·杭州宝马': 90,
        'i3电车研究所': 85,
        '宝马车主故事馆': 79,
        '李姐聊宝马': 78,
        '杭州宝马中心官方': 75,
        '杭州买车攻略君': 73,
      },
    );
    const idx = (name: string) => ranking.findIndex((c) => c.nickname === name);
    assert.ok(idx('销售小王·杭州宝马') < idx('i3电车研究所') && idx('i3电车研究所') < idx('杭州宝马中心官方'));
    assert.ok(n['销售小王·杭州宝马'].score > n['李姐聊宝马'].score, 'the focused salesperson beats the other salesperson');

    const wang = n['销售小王·杭州宝马'];
    assert.equal(factorOf(wang, 'location').points, 20);
    assert.match(factorOf(wang, 'location').reason, /杭州.*同城/);
    assert.equal(factorOf(wang, 'model_specialization').points, 20);
    assert.equal(factorOf(wang, 'persona_fit').points, 15);
    assert.match(factorOf(wang, 'persona_fit').reason, /成交型需求.*询问现车/);
    assert.equal(factorOf(wang, 'response_rate').points, 5, 'no outreach history → neutral prior');
    assert.equal(factorOf(wang, 'conversion_rate').points, 5);
    assert.equal(factorOf(wang, 'load').points, 10);
    assert.equal(factorOf(wang, 'health').points, 15);
    assert.equal(factorOf(n['杭州宝马中心官方'], 'model_specialization').points, 12, 'official covers 7 models → broad');
    assert.equal(factorOf(n['李姐聊宝马'], 'model_specialization').points, 8, 'X3/X1 focus → brand match only');
    assert.equal(factorOf(n['i3电车研究所'], 'persona_fit').points, 10);
    assert.ok(ranking.every((c) => c.eligible));
    assert.equal(
      ctx.db.table('account_health').count(),
      6,
      'today\'s health snapshot is computed for every ranked account that had none',
    );
    rankAccountsForLead(ctx, lead);
    assert.equal(ctx.db.table('account_health').count(), 6, 'an existing snapshot for today is reused');
  });

  it('X3 price lead → 李姐聊宝马 #1', (t) => {
    const { ctx, hz } = setup();
    const ranking = rankAccountsForLead(ctx, makeLead(ctx, hz, { intent: X3_PRICE, score: 75 }));
    printRanking(t, ranking);
    assertWellFormed(ranking);
    assert.equal(ranking[0].nickname, '李姐聊宝马');
    assert.equal(ranking[0].score, 90);
    assert.equal(factorOf(byName(ranking)['销售小王·杭州宝马'], 'model_specialization').points, 8);
  });

  it('research/comparison i3 lead → i3电车研究所 #1', (t) => {
    const { ctx, hz } = setup();
    const ranking = rankAccountsForLead(ctx, makeLead(ctx, hz, { intent: I3_COMPARISON, score: 62 }));
    printRanking(t, ranking);
    assertWellFormed(ranking);
    assert.equal(ranking[0].nickname, 'i3电车研究所');
    assert.equal(ranking[0].score, 90);
    const n = byName(ranking);
    assert.equal(factorOf(n['i3电车研究所'], 'persona_fit').points, 15);
    assert.match(factorOf(n['i3电车研究所'], 'persona_fit').reason, /调研\/对比型需求/);
    assert.equal(factorOf(n['销售小王·杭州宝马'], 'persona_fit').points, 9);
    assert.equal(factorOf(n['杭州买车攻略君'], 'persona_fit').points, 11);
    assert.equal(factorOf(n['杭州宝马中心官方'], 'persona_fit').points, 7);
  });

  it('sh-bmw lead ranks only Shanghai accounts; 赵哥 requires_auth gets 3 health points and 上海官方 wins', (t) => {
    const { ctx, sh, acc } = setup();
    const lead = makeLead(ctx, sh, {
      intent: { brand: 'BMW', model: 'X3', location: '上海', province: '上海', price_intent: true, purchase_stage: 'price_shopping' },
      score: 82,
    });
    const ranking = rankAccountsForLead(ctx, lead);
    printRanking(t, ranking);
    assertWellFormed(ranking);
    assert.deepEqual(
      ranking.map((c) => c.account_id).sort(),
      [acc('xhs-sh-official'), acc('xhs-sh-sales-zhao')].sort(),
    );
    assert.equal(ranking[0].nickname, '上海宝马中心官方');
    assert.equal(ranking[0].score, 83);
    const zhao = ranking[1];
    assert.equal(zhao.nickname, '赵哥说车·上海宝马');
    assert.equal(zhao.eligible, true, 'requires_auth stays eligible (a human can re-login)');
    assert.equal(zhao.score, 78);
    assert.equal(factorOf(zhao, 'health').points, 3);
    assert.match(factorOf(zhao, 'health').reason, /需重新登录/);
    assert.equal(factorOf(zhao, 'persona_fit').points, 15);
  });
});

describe('fleet ranking: location factor', () => {
  it('unknown location → 10, stated out-of-province city → 0, stated province only → 12', () => {
    const { ctx, hz } = setup();
    const { location: _l, province: _p, ...noLocation } = I3_INVENTORY;
    const unknown = byName(rankAccountsForLead(ctx, makeLead(ctx, hz, { intent: noLocation })));
    assert.equal(factorOf(unknown['销售小王·杭州宝马'], 'location').points, 10);
    assert.match(factorOf(unknown['销售小王·杭州宝马'], 'location').reason, /未透露/);

    const shenzhen = byName(rankAccountsForLead(ctx, makeLead(ctx, hz, { intent: { ...I3_INVENTORY, location: '深圳', province: '广东' } })));
    assert.equal(factorOf(shenzhen['销售小王·杭州宝马'], 'location').points, 0);
    assert.match(factorOf(shenzhen['销售小王·杭州宝马'], 'location').reason, /深圳.*不同省/);

    const ningbo = byName(rankAccountsForLead(ctx, makeLead(ctx, hz, { intent: { ...I3_INVENTORY, location: '宁波', province: undefined } })));
    assert.equal(factorOf(ningbo['销售小王·杭州宝马'], 'location').points, 12, 'province derived from the stated city');

    const zhejiang = byName(rankAccountsForLead(ctx, makeLead(ctx, hz, { intent: { ...noLocation, province: '浙江' } })));
    assert.equal(factorOf(zhejiang['杭州宝马中心官方'], 'location').points, 12);
    assert.match(factorOf(zhejiang['杭州宝马中心官方'], 'location').reason, /同省/);
  });

  it('IP 属地 of the source comment counts as same province when nothing is stated', () => {
    const { ctx, hz } = setup();
    const { location: _l, province: _p, ...noLocation } = I3_INVENTORY;
    const lead = makeLead(ctx, hz, { intent: noLocation });
    const at = ctx.clock.iso();
    const post = ctx.db.table('public_posts').insert({
      id: newId('ppost'), platform: 'xiaohongshu', platform_post_id: `note-ip-${seq}`, xsec_token: null, url: null,
      title: '宝马i3现在值得买吗？', content: '', author_platform_user_id: null, author_nickname: null, author_profile_url: null,
      ip_location: '上海', tags: [], like_count: 0, comment_count: 1, collect_count: 0, published_at: at, own_post_id: null,
      first_search_run_id: null, fetched_at: at, raw: {},
    });
    const comment = ctx.db.table('public_comments').insert({
      id: newId('pcmt'), platform: 'xiaohongshu', platform_comment_id: `c-ip-${seq}`, public_post_id: post.id, parent_comment_id: null,
      author_platform_user_id: lead.platform_user_id, author_nickname: '路人', content: 'i3 35L有现车吗', ip_location: '浙江',
      like_count: 0, published_at: at, prefilter_passed: true, prefilter_reason: 'keyword_hit', first_search_run_id: null, fetched_at: at, raw: {},
    });
    ctx.db.table('lead_signals').insert({
      id: newId('sig'), lead_id: lead.id, source_type: 'comment', public_post_id: post.id, public_comment_id: comment.id,
      post_title: post.title, content: comment.content, signal_at: at, search_run_id: null, query_id: null, intent: {},
      signal_score: 90, evidence: [], engine: 'rules', is_purchase_signal: true, strength: 1, transaction_questions: ['inventory'],
      author_role: 'asker', created_at: at,
    });
    const hzRanking = byName(rankAccountsForLead(ctx, lead));
    assert.equal(factorOf(hzRanking['销售小王·杭州宝马'], 'location').points, 12, 'the commenter IP (浙江) wins over the post author IP (上海)');
    assert.match(factorOf(hzRanking['销售小王·杭州宝马'], 'location').reason, /IP属地浙江/);
  });
});

describe('fleet ranking: eligibility, load and history', () => {
  it('paused, cooldown and disabled accounts are ineligible and listed after every eligible account', (t) => {
    const { ctx, hz, acc } = setup();
    const accounts = ctx.db.table('xhs_accounts');
    accounts.update(acc('xhs-hz-sales-wang'), { status: 'paused' });
    accounts.update(acc('xhs-hz-story'), { status: 'cooldown' });
    accounts.update(acc('xhs-hz-official'), { status: 'disabled' });
    const ranking = rankAccountsForLead(ctx, makeLead(ctx, hz, { intent: I3_INVENTORY }));
    printRanking(t, ranking);
    assertWellFormed(ranking);
    const n = byName(ranking);
    assert.equal(ranking[0].nickname, 'i3电车研究所');
    assert.deepEqual(
      ranking.slice(-3).map((c) => [c.nickname, c.eligible, c.excluded_reason]).sort(),
      [
        ['宝马车主故事馆', false, '账号处于冷却期'],
        ['杭州宝马中心官方', false, '账号已停用'],
        ['销售小王·杭州宝马', false, '账号已暂停运营'],
      ],
    );
    assert.equal(factorOf(n['销售小王·杭州宝马'], 'health').points, 0);
    assert.equal(n['李姐聊宝马'].eligible, true);
  });

  it('load lowers a busy account; a tie is broken by account creation order', () => {
    const { ctx, hz, acc } = setup();
    const wang = acc('xhs-hz-sales-wang');
    ctx.db.table('xhs_accounts').update(wang, { daily_outreach_limit: 2 }); // capacity 10
    const seedOwned = (n: number) => {
      for (let i = 0; i < n; i++) {
        const other = seedLead(ctx, { dealer_id: hz, platform_user_id: `busy-${++seq}` });
        seedAssignment(ctx, { lead_id: other.id, account_id: wang });
      }
    };
    seedOwned(5);
    const half = rankAccountsForLead(ctx, makeLead(ctx, hz, { intent: I3_INVENTORY }));
    const halfWang = byName(half)['销售小王·杭州宝马'];
    assert.equal(factorOf(halfWang, 'load').points, 5);
    assert.match(factorOf(halfWang, 'load').reason, /5条活跃线索，容量10条/);
    assert.equal(halfWang.score, 85);
    assert.equal(byName(half)['i3电车研究所'].score, 85);
    assert.deepEqual(half.slice(0, 2).map((c) => c.nickname), ['销售小王·杭州宝马', 'i3电车研究所'], 'tie → earlier-created account first');

    seedOwned(5);
    const full = rankAccountsForLead(ctx, makeLead(ctx, hz, { intent: I3_INVENTORY }));
    assert.equal(factorOf(byName(full)['销售小王·杭州宝马'], 'load').points, 0);
    assert.equal(full[0].nickname, 'i3电车研究所', 'a fully loaded salesperson drops below the specialist');
  });

  it('reply and conversion history replace the neutral priors; a silent account is penalised', () => {
    const { ctx, hz, acc } = setup();
    const li = acc('xhs-hz-sales-li');
    const official = acc('xhs-hz-official');
    for (let i = 0; i < 10; i++) {
      const other = seedLead(ctx, { dealer_id: hz, platform_user_id: `hist-li-${++seq}`, stage: 'CONTACTED' });
      const asg = seedAssignment(ctx, { lead_id: other.id, account_id: li });
      seedOutreach(ctx, { lead_id: other.id, account_id: li, assignment_id: asg.id, status: 'SENT' });
      if (i < 5) seedInboundReply(ctx, { lead_id: other.id, account_id: li });
      if (i < 2) seedConversion(ctx, { lead_id: other.id, dealer_id: hz, account_id: li });
    }
    for (let i = 0; i < 10; i++) {
      const other = seedLead(ctx, { dealer_id: hz, platform_user_id: `hist-off-${++seq}`, stage: 'CONTACTED' });
      const asg = seedAssignment(ctx, { lead_id: other.id, account_id: official });
      seedOutreach(ctx, { lead_id: other.id, account_id: official, assignment_id: asg.id, status: 'SENT' });
    }
    const n = byName(rankAccountsForLead(ctx, makeLead(ctx, hz, { intent: X3_PRICE, score: 75 })));
    assert.equal(factorOf(n['李姐聊宝马'], 'response_rate').points, 10);
    assert.match(factorOf(n['李姐聊宝马'], 'response_rate').reason, /回复率50%/);
    assert.equal(factorOf(n['李姐聊宝马'], 'conversion_rate').points, 10);
    assert.match(factorOf(n['李姐聊宝马'], 'conversion_rate').reason, /转化率20%/);
    assert.equal(factorOf(n['李姐聊宝马'], 'load').points, 9, '10 active leads of capacity 100');
    assert.equal(factorOf(n['杭州宝马中心官方'], 'response_rate').points, 0);
    assert.equal(factorOf(n['杭州宝马中心官方'], 'conversion_rate').points, 0);
    assert.equal(factorOf(n['杭州宝马中心官方'], 'health').points, 9, 'low reply rate → WATCH');
    assert.equal(factorOf(n['销售小王·杭州宝马'], 'response_rate').points, 5);
  });

  it('falls back to other group dealers (location 0) only when the lead dealer has no eligible account', (t) => {
    const { ctx, hz, sh, acc } = setup();
    for (const a of ctx.db.table('xhs_accounts').findMany({ dealer_id: hz })) ctx.db.table('xhs_accounts').update(a.id, { status: 'paused' });
    const ranking = rankAccountsForLead(ctx, makeLead(ctx, hz, { intent: I3_INVENTORY }));
    printRanking(t, ranking);
    assertWellFormed(ranking);
    assert.equal(ranking.length, 8);
    assert.equal(ranking.filter((c) => c.eligible).length, 2);
    assert.equal(ranking[0].account_id, acc('xhs-sh-official'));
    assert.equal(ranking[0].score, 63);
    const loc = factorOf(ranking[0], 'location');
    assert.equal(loc.points, 0);
    assert.match(loc.reason, /跨门店/);
    assert.ok(ctx.db.table('xhs_accounts').findMany({ dealer_id: sh }).every((a) => ranking.some((c) => c.account_id === a.id)));

    const healthy = setup();
    const noFallback = rankAccountsForLead(healthy.ctx, makeLead(healthy.ctx, healthy.hz, { intent: I3_INVENTORY }));
    assert.equal(noFallback.length, 6, 'no fallback while the lead dealer has an eligible account');
  });
});

describe('fleet ranking: classifyLeadIntent', () => {
  it('classifies transactional, research/comparison and awareness intents', () => {
    assert.equal(classifyLeadIntent({ intent: { inventory_intent: true } }).intent_class, 'transactional');
    assert.equal(classifyLeadIntent({ intent: { purchase_stage: 'dealer_selection' } }).intent_class, 'transactional');
    assert.equal(classifyLeadIntent({ intent: { purchase_stage: 'price_shopping' } }).intent_class, 'transactional');
    assert.equal(classifyLeadIntent({ intent: {} }, ['trade_in']).intent_class, 'transactional');
    assert.deepEqual(classifyLeadIntent({ intent: { price_intent: true } }, ['landing_price']).cues, ['询问价格/落地价']);
    assert.equal(classifyLeadIntent({ intent: { purchase_stage: 'comparison' } }).intent_class, 'research');
    assert.equal(classifyLeadIntent({ intent: { competing_models: ['Model 3'] } }).intent_class, 'research');
    assert.equal(classifyLeadIntent({ intent: { purchase_stage: 'awareness' } }).intent_class, 'awareness');
    const unknown = classifyLeadIntent({ intent: {} });
    assert.equal(unknown.intent_class, 'research');
    assert.match(unknown.cues[0], /未知/);
  });

  it('awareness leads favour customer-story and local-guide personas', () => {
    const { ctx, hz } = setup();
    const n = byName(rankAccountsForLead(ctx, makeLead(ctx, hz, { intent: { brand: 'BMW', location: '杭州', purchase_stage: 'awareness' }, score: 60 })));
    assert.equal(factorOf(n['宝马车主故事馆'], 'persona_fit').points, 12);
    assert.equal(factorOf(n['杭州买车攻略君'], 'persona_fit').points, 12);
    assert.equal(factorOf(n['销售小王·杭州宝马'], 'persona_fit').points, 6);
    assert.equal(factorOf(n['销售小王·杭州宝马'], 'model_specialization').points, 10, 'model unknown → neutral');
  });
});
