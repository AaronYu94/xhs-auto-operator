/**
 * Adversarial hardening regressions for the Fleet Controller (account-assignment).
 * Each describe block pins one defect found while running the module against the dealer fixture and the
 * simulation corpus; the tests fail on the pre-hardening implementation.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AssignmentCandidate, AutomotiveIntent, Evidence, Lead, LeadStage } from '../../../src/core/types.ts';
import {
  INDUSTRY_ACCOUNT_REASON,
  assignLead,
  assignmentConfidence,
  getActiveAssignment,
  rankAccountsForLead,
  skill,
} from '../../../src/skills/acquisition/account-assignment/index.ts';
import { DEFAULT_THRESHOLDS, tierFor } from '../../../src/skills/acquisition/lead-scoring/index.ts';
import { computeFleetHealth } from '../../../src/skills/operations/account-health/index.ts';
import { TEST_NOW, createTestContext, type TestContext } from '../../helpers/context.ts';
import {
  accountIdByPlatformId,
  dealerIdByKey,
  loadDealerFixture,
  seedAssignment,
  seedInboundReply,
  seedLead,
  seedOutreach,
  seedSuppression,
} from '../../helpers/fixtures.ts';

function setup(now?: string) {
  const ctx = createTestContext(now ? { now } : {});
  const s = loadDealerFixture(ctx);
  return {
    ctx,
    hz: dealerIdByKey(s, 'hz-bmw'),
    sh: dealerIdByKey(s, 'sh-bmw'),
    acc: (pid: string) => accountIdByPlatformId(s, pid),
  };
}

const I3_INVENTORY: AutomotiveIntent = {
  brand: 'BMW',
  model: 'i3',
  trim: 'eDrive35L',
  location: '杭州',
  province: '浙江',
  inventory_intent: true,
  visit_intent: true,
  purchase_stage: 'purchase_imminent',
};

let seq = 0;
function makeLead(
  ctx: TestContext,
  dealerId: string,
  spec: {
    score?: number;
    stage?: LeadStage;
    intent?: AutomotiveIntent;
    evidence?: Evidence[];
    actor_type?: Lead['actor_type'];
  } = {},
): Lead {
  const lead = seedLead(ctx, { dealer_id: dealerId, platform_user_id: `fleet-hard-${++seq}`, stage: spec.stage ?? 'QUALIFIED' });
  const score = spec.score ?? 96;
  return ctx.db.table('leads').update(lead.id, {
    score,
    tier: tierFor(score, DEFAULT_THRESHOLDS),
    intent: spec.intent ?? I3_INVENTORY,
    evidence: spec.evidence ?? [],
    ...(spec.actor_type !== undefined ? { actor_type: spec.actor_type } : {}),
  });
}

const byName = (cands: AssignmentCandidate[]) => Object.fromEntries(cands.map((c) => [c.nickname, c]));
const factorOf = (c: AssignmentCandidate, name: string) => {
  const f = c.factors.find((x) => x.factor === name);
  assert.ok(f, `${c.nickname} lacks factor ${name}`);
  return f;
};
const healthDecisions = (ctx: TestContext) => ctx.db.table('agent_decisions').count({ decision_type: 'account_health' });

describe('hardening: same-day health snapshots must not go stale', () => {
  it('an account re-enabled after a RESTRICTED snapshot is eligible again the same day (even at the same instant)', () => {
    const { ctx, hz, acc } = setup();
    const wang = acc('xhs-hz-sales-wang');
    ctx.db.table('xhs_accounts').update(wang, { status: 'disabled' });
    computeFleetHealth(ctx, hz); // the 08:00-style daily snapshot sees the disabled account
    assert.equal(ctx.db.table('account_health').findOne({ account_id: wang })?.state, 'RESTRICTED');

    ctx.db.table('xhs_accounts').update(wang, { status: 'active' });
    const ranking = rankAccountsForLead(ctx, makeLead(ctx, hz));
    const w = byName(ranking)['销售小王·杭州宝马'];
    assert.equal(w.eligible, true, `re-enabled account must not stay excluded (${w.excluded_reason ?? ''})`);
    assert.equal(factorOf(w, 'health').points, 15);
    assert.equal(ranking[0].account_id, wang);
    assert.equal(ctx.db.table('account_health').findOne({ account_id: wang })?.state, 'HEALTHY', 'the snapshot is refreshed');
  });

  it('a re-authenticated account gets full health points again; a newly expired login loses them', () => {
    const { ctx, sh, acc } = setup();
    const zhao = acc('xhs-sh-sales-zhao');
    const intent: AutomotiveIntent = { brand: 'BMW', model: 'X3', location: '上海', province: '上海', price_intent: true, purchase_stage: 'price_shopping' };
    const before = byName(rankAccountsForLead(ctx, makeLead(ctx, sh, { intent, score: 82 })));
    assert.equal(factorOf(before['赵哥说车·上海宝马'], 'health').points, 3);

    ctx.clock.advance({ minutes: 30 });
    ctx.db.table('xhs_accounts').update(zhao, { auth_state: 'authenticated' });
    const after = rankAccountsForLead(ctx, makeLead(ctx, sh, { intent, score: 82 }));
    const z = byName(after)['赵哥说车·上海宝马'];
    assert.equal(factorOf(z, 'health').points, 15, factorOf(z, 'health').reason);
    assert.doesNotMatch(factorOf(z, 'health').reason, /风险|重新登录/);
    assert.equal(after[0].nickname, '赵哥说车·上海宝马', 'the X3 salesperson wins once logged in');

    ctx.clock.advance({ minutes: 30 });
    ctx.db.table('xhs_accounts').update(acc('xhs-sh-official'), { auth_state: 'requires_auth' });
    const expired = byName(rankAccountsForLead(ctx, makeLead(ctx, sh, { intent, score: 82 })));
    assert.equal(factorOf(expired['上海宝马中心官方'], 'health').points, 3);
  });

  it('negative feedback received after the morning snapshot lowers health immediately', () => {
    const { ctx, hz, acc } = setup();
    const wang = acc('xhs-hz-sales-wang');
    const contacted: string[] = [];
    for (let i = 0; i < 3; i++) {
      const other = seedLead(ctx, { dealer_id: hz, platform_user_id: `neg-${++seq}`, stage: 'CONTACTED' });
      const asg = seedAssignment(ctx, { lead_id: other.id, account_id: wang });
      seedOutreach(ctx, { lead_id: other.id, account_id: wang, assignment_id: asg.id, status: 'SENT' });
      contacted.push(other.platform_user_id);
    }
    const morning = byName(rankAccountsForLead(ctx, makeLead(ctx, hz)));
    assert.equal(factorOf(morning['销售小王·杭州宝马'], 'health').points, 15);

    ctx.clock.advance({ hours: 2 });
    for (const u of contacted) seedSuppression(ctx, u);
    const later = byName(rankAccountsForLead(ctx, makeLead(ctx, hz)));
    const w = later['销售小王·杭州宝马'];
    assert.equal(factorOf(w, 'health').points, 3, factorOf(w, 'health').reason);
    assert.match(factorOf(w, 'health').reason, /账号存在风险/, '理由说明账号有风险，但不暴露英文枚举');
  });

  it('an unchanged fleet reuses today\'s snapshots without writing new health decisions', () => {
    const { ctx, hz } = setup();
    const lead = makeLead(ctx, hz);
    rankAccountsForLead(ctx, lead);
    const decisions = healthDecisions(ctx);
    assert.equal(decisions, 6);
    ctx.clock.advance({ hours: 3 });
    rankAccountsForLead(ctx, lead);
    rankAccountsForLead(ctx, lead);
    assert.equal(healthDecisions(ctx), decisions);
  });

  it('uses the dealer-local (Asia/Shanghai) day: 00:30 local on the next day computes a new snapshot', () => {
    const { ctx, hz, acc } = setup('2026-09-12T15:30:00.000Z'); // 23:30 Shanghai, Sat
    const lead = makeLead(ctx, hz);
    rankAccountsForLead(ctx, lead);
    const wang = acc('xhs-hz-sales-wang');
    assert.deepEqual(ctx.db.table('account_health').findMany({ account_id: wang }).map((h) => h.date), ['2026-09-12']);
    ctx.clock.advance({ hours: 1 }); // 16:30Z = 00:30 Sunday in Shanghai, still 2026-09-12 in UTC
    rankAccountsForLead(ctx, lead);
    assert.deepEqual(
      ctx.db.table('account_health').findMany({ account_id: wang }, { orderBy: 'date ASC' }).map((h) => h.date),
      ['2026-09-12', '2026-09-13'],
    );
  });
});

describe('hardening: location normalization and honest location reasons', () => {
  it('province names with administrative suffixes, or stored in the location field, still match the account province', () => {
    const { ctx, hz } = setup();
    const { location: _l, province: _p, ...noLocation } = I3_INVENTORY;
    const suffixed = byName(rankAccountsForLead(ctx, makeLead(ctx, hz, { intent: { ...noLocation, province: '浙江省' } })));
    assert.equal(factorOf(suffixed['杭州宝马中心官方'], 'location').points, 12, factorOf(suffixed['杭州宝马中心官方'], 'location').reason);

    const inLocationField = byName(rankAccountsForLead(ctx, makeLead(ctx, hz, { intent: { ...noLocation, location: '浙江' } })));
    const loc = factorOf(inLocationField['杭州宝马中心官方'], 'location');
    assert.equal(loc.points, 12, loc.reason);
    assert.match(loc.reason, /同省/);

    const outOfArea = byName(rankAccountsForLead(ctx, makeLead(ctx, hz, { intent: { ...noLocation, location: '广东省' } })));
    assert.equal(factorOf(outOfArea['杭州宝马中心官方'], 'location').points, 0);
  });

  it('account cities written with 市/district and dealer provinces written with 省 are normalized', () => {
    const { ctx, hz, acc } = setup();
    ctx.db.table('xhs_accounts').update(acc('xhs-hz-sales-wang'), { city: '杭州市西湖区' });
    ctx.db.table('xhs_accounts').update(acc('xhs-hz-i3'), { city: '萧山' });
    ctx.db.table('dealers').update(hz, { province: '浙江省' });
    const n = byName(rankAccountsForLead(ctx, makeLead(ctx, hz)));
    assert.equal(factorOf(n['销售小王·杭州宝马'], 'location').points, 20, factorOf(n['销售小王·杭州宝马'], 'location').reason);
    assert.equal(factorOf(n['i3电车研究所'], 'location').points, 12, factorOf(n['i3电车研究所'], 'location').reason);
  });

  it('an IP-derived province is explained as IP 属地, a post-context city as inferred from the post', () => {
    const { ctx, hz } = setup();
    const { location: _l, province: _p, ...noLocation } = I3_INVENTORY;
    const ipLead = makeLead(ctx, hz, {
      intent: { ...noLocation, province: '浙江', inferred_fields: ['province'] },
      evidence: [{ code: 'ip_location', label: 'IP属地 浙江', quote: '浙江', source_ref: 'ip_location' }],
    });
    const ip = factorOf(byName(rankAccountsForLead(ctx, ipLead))['销售小王·杭州宝马'], 'location');
    assert.equal(ip.points, 12);
    assert.match(ip.reason, /IP属地浙江/);
    assert.doesNotMatch(ip.reason, /帖子/);

    const ipOther = makeLead(ctx, hz, {
      intent: { ...noLocation, province: '上海', inferred_fields: ['province'] },
      evidence: [{ code: 'ip_location', label: 'IP属地 上海', quote: '上海', source_ref: 'ip_location' }],
    });
    const other = factorOf(byName(rankAccountsForLead(ctx, ipOther))['销售小王·杭州宝马'], 'location');
    assert.equal(other.points, 0);
    assert.match(other.reason, /IP属地上海/);

    const postCity = makeLead(ctx, hz, { intent: { ...I3_INVENTORY, inferred_fields: ['location', 'province'] } });
    const pc = factorOf(byName(rankAccountsForLead(ctx, postCity))['销售小王·杭州宝马'], 'location');
    assert.equal(pc.points, 20);
    assert.match(pc.reason, /帖子/);
  });
});

describe('hardening: brand canonicalization in model specialization', () => {
  it('a Chinese brand alias (宝马) still earns the brand-only points', () => {
    const { ctx, hz } = setup();
    const n = byName(rankAccountsForLead(ctx, makeLead(ctx, hz, { intent: { ...I3_INVENTORY, brand: '宝马', model: 'X5', trim: undefined } })));
    const f = factorOf(n['销售小王·杭州宝马'], 'model_specialization');
    assert.equal(f.points, 8, f.reason);
  });

  it('the lexicon brand of the model wins over a merged intent brand (Model 3 is not a BMW brand match)', () => {
    const { ctx, hz } = setup();
    const n = byName(rankAccountsForLead(ctx, makeLead(ctx, hz, { intent: { ...I3_INVENTORY, brand: 'BMW', model: 'Model 3', trim: undefined } })));
    assert.equal(factorOf(n['销售小王·杭州宝马'], 'model_specialization').points, 0);
    const compared = byName(
      rankAccountsForLead(ctx, makeLead(ctx, hz, { intent: { ...I3_INVENTORY, brand: 'Tesla', model: 'Model 3', competing_models: ['宝马i3'], trim: undefined } })),
    );
    assert.equal(factorOf(compared['i3电车研究所'], 'model_specialization').points, 12, 'a compared model alias resolves to i3');
  });
});

describe('hardening: undelivered outreach of non-owner accounts', () => {
  it('a new owner cancels orphaned pending outreach of other accounts so its own first touch is not blocked', () => {
    const { ctx, hz, acc } = setup();
    const lead = makeLead(ctx, hz);
    const i3 = acc('xhs-hz-i3');
    const old = seedAssignment(ctx, { lead_id: lead.id, account_id: i3, active: false, released_at: TEST_NOW });
    const orphan = seedOutreach(ctx, { lead_id: lead.id, account_id: i3, assignment_id: old.id, status: 'READY_FOR_REVIEW' });

    const res = assignLead(ctx, lead.id);
    assert.equal(res.assignment?.account_id, acc('xhs-hz-sales-wang'), 'unsent outreach does not make an account sticky');
    const o = ctx.db.table('outreach').require(orphan.id);
    assert.equal(o.status, 'CANCELLED');
    assert.match(o.blocked_reason ?? '', /其他账号|重新分配/);
    assert.equal(ctx.db.table('audit_events').count({ action: 'outreach.cancelled', entity_id: orphan.id }), 1);
    const assigned = ctx.db.table('audit_events').findOne({ action: 'lead.assigned', entity_id: lead.id });
    assert.deepEqual(assigned?.details.outreach_cancelled, [orphan.id]);

    assert.doesNotThrow(() =>
      seedOutreach(ctx, { lead_id: lead.id, account_id: res.assignment!.account_id, assignment_id: res.assignment!.id, status: 'READY_FOR_REVIEW' }),
    );
  });
});

describe('hardening: industry / dealer-sales leads are never routed to a salesperson', () => {
  it('no relationship is started with an industry account (evidence or actor_type), not even by an operator', () => {
    const { ctx, hz, acc } = setup();
    const flagged = makeLead(ctx, hz, {
      evidence: [{ code: 'industry_account', label: '行业账号（车商/销售）', quote: '4S店销售顾问' }],
    });
    const res = assignLead(ctx, flagged.id);
    assert.equal(res.assignment, null);
    assert.equal(res.reason, INDUSTRY_ACCOUNT_REASON);
    assert.deepEqual(res.candidates, []);
    assert.equal(ctx.db.table('lead_assignments').count({ lead_id: flagged.id }), 0);
    assert.equal(ctx.db.table('agent_decisions').count({ decision_type: 'account_assignment', subject_id: flagged.id }), 0);

    const typed = makeLead(ctx, hz, { actor_type: 'DEALER_OR_SALES' });
    assert.equal(assignLead(ctx, typed.id, { reassign_to: acc('xhs-hz-sales-li'), actor: 'operator:张经理' }).assignment, null);
    assert.equal(getActiveAssignment(ctx, typed.id), undefined);
    assert.equal(ctx.db.table('leads').require(typed.id).stage, 'QUALIFIED');
  });

  it('an existing sales conversation with a later-identified industry account is not orphaned (lead-research keeps it open)', () => {
    const { ctx, hz, acc } = setup();
    const li = acc('xhs-hz-sales-li');
    const contacted = makeLead(ctx, hz, { stage: 'CONTACTED', actor_type: 'DEALER_OR_SALES', score: 40 });
    const old = seedAssignment(ctx, { lead_id: contacted.id, account_id: li, active: false, released_at: TEST_NOW });
    seedOutreach(ctx, { lead_id: contacted.id, account_id: li, assignment_id: old.id, status: 'SENT' });
    const res = assignLead(ctx, contacted.id);
    assert.equal(res.assignment?.account_id, li, 'only the account already in the conversation re-owns it');
    assert.equal(ctx.db.table('leads').require(contacted.id).stage, 'CONTACTED');
  });
});

describe('hardening: ordering and confidence', () => {
  it('ties are broken by account created_at, also for accounts added outside the primary dealer ranking', () => {
    const { ctx, hz, acc } = setup();
    const guide = acc('xhs-hz-guide');
    const shOfficial = acc('xhs-sh-official');
    ctx.db.table('xhs_accounts').update(guide, { daily_outreach_limit: 1 }); // capacity 5
    for (let i = 0; i < 5; i++) {
      const other = seedLead(ctx, { dealer_id: hz, platform_user_id: `tie-${++seq}` });
      seedAssignment(ctx, { lead_id: other.id, account_id: guide });
    }
    ctx.db.run('UPDATE xhs_accounts SET created_at = ? WHERE id = ?', '2025-01-01T00:00:00.000Z', shOfficial);
    const lead = makeLead(ctx, hz);
    const res = assignLead(ctx, lead.id, { reassign_to: shOfficial, actor: 'operator:张经理' });
    const names = res.candidates.map((c) => `${c.nickname}:${c.score}`);
    const iSh = names.indexOf('上海宝马中心官方:63');
    const iGuide = names.indexOf('杭州买车攻略君:63');
    assert.ok(iSh >= 0 && iGuide >= 0, names.join(' '));
    assert.ok(iSh < iGuide, `earlier-created account first on a tie: ${names.join(' ')}`);
    assert.equal(ctx.db.table('audit_events').findOne({ action: 'lead.assigned', entity_id: lead.id })?.details.cross_dealer, true);
    assert.equal(factorOf(res.candidates[iSh], 'location').points, 0);
  });

  it('confidence of a non-top choice made by an automated actor is below 0.5; the top choice keeps the margin rule', () => {
    const { ctx, hz, acc } = setup();
    const lead = makeLead(ctx, hz);
    const res = assignLead(ctx, lead.id, { reassign_to: acc('xhs-hz-guide'), actor: 'agent:automotive-operator' });
    assert.equal(res.changed, true);
    const decision = ctx.db.table('agent_decisions').findOne({ decision_type: 'account_assignment', subject_id: lead.id });
    assert.ok(decision);
    assert.equal(decision.engine, 'rules');
    assert.ok(decision.confidence < 0.5, `guide (73) is 17 points behind 销售小王 (90): confidence ${decision.confidence}`);

    assert.equal(assignmentConfidence(res.candidates), 0.67);
    assert.equal(assignmentConfidence(res.candidates, acc('xhs-hz-sales-wang')), 0.67);
    assert.equal(assignmentConfidence([{ ...res.candidates[0] }]), 0.9, 'a single eligible account');
  });
});

describe('hardening: repeated identical failures do not spam the audit log', () => {
  it('writes one failure event + decision per distinct failure reason', () => {
    const { ctx, hz } = setup();
    const accounts = ctx.db.table('xhs_accounts');
    for (const a of accounts.findMany()) accounts.update(a.id, { status: 'disabled' });
    const lead = makeLead(ctx, hz);
    const first = assignLead(ctx, lead.id);
    ctx.clock.advance({ hours: 1 });
    const second = assignLead(ctx, lead.id);
    assert.equal(second.assignment, null);
    assert.equal(second.reason, first.reason);
    const failed = () => ctx.db.table('audit_events').count({ action: 'lead.assignment_failed', entity_id: lead.id });
    const decisions = () => ctx.db.table('agent_decisions').count({ decision_type: 'account_assignment', subject_id: lead.id });
    assert.equal(failed(), 1);
    assert.equal(decisions(), 1);

    const one = accounts.findOne({ dealer_id: hz });
    assert.ok(one);
    accounts.update(one.id, { status: 'paused' });
    const third = assignLead(ctx, lead.id);
    assert.notEqual(third.reason, first.reason);
    assert.equal(failed(), 2, 'a different reason is a new decision');
    assert.equal(decisions(), 2);
  });
});

describe('hardening: behaviours documented but previously untested', () => {
  it('with several contacting accounts the most recent contact owns the lead', () => {
    const { ctx, hz, acc } = setup();
    const lead = makeLead(ctx, hz);
    const li = acc('xhs-hz-sales-li');
    const i3 = acc('xhs-hz-i3');
    const old = seedAssignment(ctx, { lead_id: lead.id, account_id: li, active: false, released_at: TEST_NOW });
    seedOutreach(ctx, { lead_id: lead.id, account_id: li, assignment_id: old.id, status: 'SENT', sent_at: '2026-09-10T02:00:00.000Z' });
    seedInboundReply(ctx, { lead_id: lead.id, account_id: i3, at: '2026-09-11T02:00:00.000Z' });
    assert.equal(assignLead(ctx, lead.id).assignment?.account_id, i3);
  });

  it('reassign_to without a current owner creates the owner without a release', () => {
    const { ctx, hz, acc } = setup();
    const lead = makeLead(ctx, hz);
    const res = assignLead(ctx, lead.id, { reassign_to: acc('xhs-hz-i3'), actor: 'operator:张经理', reason: '客户点名研究所' });
    assert.equal(res.changed, true);
    assert.equal(res.assignment?.account_id, acc('xhs-hz-i3'));
    assert.equal(ctx.db.table('audit_events').count({ action: 'lead.assignment_released', entity_id: lead.id }), 0);
    assert.equal(ctx.db.table('leads').require(lead.id).stage, 'ASSIGNED');
  });

  it('validateOutput rejects a candidate whose score is not the sum of its factors', () => {
    const { ctx, hz } = setup();
    const res = assignLead(ctx, makeLead(ctx, hz).id);
    assert.doesNotThrow(() => skill.validateOutput?.(res));
    const tampered = { ...res, candidates: res.candidates.map((c, i) => (i === 1 ? { ...c, score: c.score + 7 } : c)) };
    assert.throws(() => skill.validateOutput?.(tampered), /does not equal its factors/);
    assert.throws(() => skill.validateOutput?.({ ...res, reason: ' ' }), /reason is required/);
  });
});
