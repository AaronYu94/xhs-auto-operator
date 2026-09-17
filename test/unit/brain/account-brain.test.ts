import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import { DAY_MS } from '../../../src/core/time.ts';
import {
  effectiveOutreachPolicy,
  effectivePublishPolicy,
  getAccountBrain,
  getAccountPerformance,
  listFleet,
  skill,
  updatePersona,
} from '../../../src/skills/operations/account-brain/index.ts';
import { computeAccountHealth } from '../../../src/skills/operations/account-health/index.ts';
import { TEST_NOW, createTestContext } from '../../helpers/context.ts';
import {
  accountIdByPlatformId,
  dealerIdByKey,
  loadDealerFixture,
  seedAppointment,
  seedAssignment,
  seedConversion,
  seedInboundReply,
  seedLead,
  seedOutreach,
  seedPublishedPost,
  seedSuppression,
} from '../../helpers/fixtures.ts';

const daysAgo = (n: number) => new Date(Date.parse(TEST_NOW) - n * DAY_MS).toISOString();

function setup() {
  const ctx = createTestContext();
  const s = loadDealerFixture(ctx);
  return {
    ctx,
    s,
    hz: dealerIdByKey(s, 'hz-bmw'),
    sh: dealerIdByKey(s, 'sh-bmw'),
    acc: (pid: string) => accountIdByPlatformId(s, pid),
  };
}

describe('account-brain: fleet & personas', () => {
  it('gives the 6 Hangzhou accounts clearly distinct personas', () => {
    const { ctx, hz } = setup();
    const fleet = listFleet(ctx, { dealer_id: hz });
    assert.equal(fleet.length, 6);
    assert.deepEqual(
      fleet.map((b) => b.account.account_type).sort(),
      ['customer_story', 'local_guide', 'model_specialist', 'official', 'salesperson', 'salesperson'],
    );
    const toneAndFocus = new Set(fleet.map((b) => `${b.persona.tone}|${[...b.persona.focus_models].sort().join(',')}`));
    assert.equal(toneAndFocus.size, 6, 'no two personas share tone + focus_models');
    assert.equal(new Set(fleet.map((b) => b.persona.tone)).size, 6);
    assert.equal(new Set(fleet.map((b) => b.persona.content_positioning)).size, 6);
    assert.equal(new Set(fleet.map((b) => b.persona.signature_phrases.join('|'))).size, 6);
    for (const b of fleet) {
      const sum = Object.values(b.persona.content_mix).reduce((a, x) => a + (x ?? 0), 0);
      assert.ok(Math.abs(sum - 1) < 0.001, `${b.account.nickname} content_mix sums to 1`);
      assert.equal(b.account.city, '杭州');
      assert.ok(b.persona.voice_rules.length > 0 && b.persona.taboo_topics.length > 0);
    }
    const wang = fleet.find((b) => b.account.platform_account_id === 'xhs-hz-sales-wang')!;
    assert.deepEqual(wang.persona.focus_models, ['i3', '3 Series']);
    const li = fleet.find((b) => b.account.platform_account_id === 'xhs-hz-sales-li')!;
    assert.deepEqual(li.persona.focus_models, ['X3', 'X1']);

    assert.equal(listFleet(ctx, { group_id: fleet[0].account.group_id }).length, 8);
    assert.equal(listFleet(ctx, {}).length, 8);
  });

  it('returns zeros (never NaN) for accounts without history', () => {
    const { ctx, acc } = setup();
    const brain = getAccountBrain(ctx, acc('xhs-hz-official'));
    assert.equal(brain.health, null);
    assert.deepEqual(brain.recent_posts, []);
    for (const [k, value] of Object.entries(brain.performance)) {
      assert.equal(value, 0, k);
      assert.ok(Number.isFinite(value), k);
    }
    assert.throws(() => getAccountBrain(ctx, 'acc_missing'), /not found/);
  });

  it('creates a persisted account-type baseline persona for accounts created without one', () => {
    const { ctx, s, hz } = setup();
    const now = ctx.clock.iso();
    const account = ctx.db.table('xhs_accounts').insert({
      id: newId('acc'),
      group_id: s.group_id,
      dealer_id: hz,
      platform_account_id: 'xhs-hz-new-guide',
      nickname: '杭州新车指南',
      account_type: 'local_guide',
      status: 'active',
      auth_state: 'unknown',
      city: '杭州',
      salesperson_name: null,
      outreach_approval_policy: null,
      daily_outreach_limit: null,
      daily_publish_limit: null,
      created_at: now,
      updated_at: now,
    });
    const brain = getAccountBrain(ctx, account.id);
    assert.equal(brain.persona.persona_name, '杭州新车指南');
    assert.equal(brain.persona.tone, '热心、本地化、攻略感强');
    assert.deepEqual(brain.persona.focus_brands, ['BMW']);
    getAccountBrain(ctx, account.id);
    assert.equal(ctx.db.table('account_personas').count({ account_id: account.id }), 1);
    assert.equal(ctx.db.table('audit_events').count({ action: 'account.persona_created', entity_id: account.id }), 1);
  });

  it('updates personas with validation and an audit event', () => {
    const { ctx, acc } = setup();
    const id = acc('xhs-hz-i3');
    const updated = updatePersona(ctx, id, { tone: '极客、理性、更口语化', focus_models: ['i3', 'i4', 'iX3'] }, 'operator:运营主管');
    assert.equal(updated.tone, '极客、理性、更口语化');
    assert.deepEqual(updated.focus_models, ['i3', 'i4', 'iX3']);
    const events = ctx.db.table('audit_events').findMany({ action: 'account.persona_updated', entity_id: id });
    assert.equal(events.length, 1);
    assert.equal(events[0].actor, 'operator:运营主管');
    assert.deepEqual(events[0].details.changed_fields, ['tone', 'focus_models']);

    updatePersona(ctx, id, { tone: '极客、理性、更口语化' }, 'operator:运营主管');
    assert.equal(ctx.db.table('audit_events').count({ action: 'account.persona_updated', entity_id: id }), 1, 'no-op patch writes nothing');

    assert.throws(() => updatePersona(ctx, id, { content_mix: { model_review: 0.9 } }, 'operator:x'), ValidationError);
    assert.throws(() => updatePersona(ctx, id, { account_id: 'acc_other' }, 'operator:x'), /read-only/);
    assert.throws(() => updatePersona(ctx, id, { tone: '' }, 'operator:x'), /patch\.tone/);
    assert.equal(getAccountBrain(ctx, id).persona.tone, '极客、理性、更口语化');
  });
});

describe('account-brain: policies', () => {
  it('merges dealer settings with non-null account overrides', () => {
    const { ctx, acc } = setup();
    const hzOfficial = effectiveOutreachPolicy(ctx, acc('xhs-hz-official'));
    assert.deepEqual(hzOfficial, {
      policy: 'REVIEW_REQUIRED',
      daily_limit: 20,
      min_interval_minutes: 3,
      max_unanswered_touches: 2,
      follow_up_after_days: 2,
      auto_send_min_score: 90,
      timezone: 'Asia/Shanghai',
    });
    assert.equal(effectiveOutreachPolicy(ctx, acc('xhs-sh-official')).daily_limit, 15);

    const wang = acc('xhs-hz-sales-wang');
    ctx.db.table('xhs_accounts').update(wang, { outreach_approval_policy: 'AUTO', daily_outreach_limit: 5, daily_publish_limit: 4 });
    const p = effectiveOutreachPolicy(ctx, wang);
    assert.equal(p.policy, 'AUTO');
    assert.equal(p.daily_limit, 5);
    assert.equal(p.min_interval_minutes, 3);
    assert.deepEqual(effectivePublishPolicy(ctx, wang), { policy: 'REVIEW_REQUIRED', daily_limit: 4, timezone: 'Asia/Shanghai' });
    assert.equal(effectivePublishPolicy(ctx, acc('xhs-hz-official')).daily_limit, 2);

    ctx.db.table('xhs_accounts').update(wang, { daily_outreach_limit: 0 });
    assert.equal(effectiveOutreachPolicy(ctx, wang).daily_limit, 0, 'explicit 0 is an override, not inherit');
  });
});

describe('account-brain: performance windows', () => {
  it('computes 7d / 30d / 90d metrics from real tables relative to the clock', () => {
    const { ctx, hz, acc } = setup();
    const W = acc('xhs-hz-sales-wang');
    const LI = acc('xhs-hz-sales-li');

    seedPublishedPost(ctx, { dealer_id: hz, account_id: W, published_at: daysAgo(5), likes: 10, collects: 5, comments: 3, shares: 2 });
    seedPublishedPost(ctx, { dealer_id: hz, account_id: W, published_at: daysAgo(10), likes: 6, collects: 4 });
    seedPublishedPost(ctx, { dealer_id: hz, account_id: W, published_at: daysAgo(40), likes: 100 });
    seedPublishedPost(ctx, { dealer_id: hz, account_id: LI, published_at: daysAgo(1), likes: 50 });

    const L1 = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u1', stage: 'CONTACTED', at: daysAgo(21) });
    const L2 = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u2', stage: 'WON', at: daysAgo(41) });
    const L3 = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u3', stage: 'CONTACTED', at: daysAgo(81) });
    const L4 = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u4', stage: 'CONTACTED', suppressed: true, at: daysAgo(16) });
    const L5 = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u5', stage: 'WON', at: daysAgo(31) });
    const L6 = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u6', stage: 'CONTACTED', at: daysAgo(5) });

    const A1 = seedAssignment(ctx, { lead_id: L1.id, account_id: W, at: daysAgo(20) });
    const A2 = seedAssignment(ctx, { lead_id: L2.id, account_id: W, at: daysAgo(40) });
    const A3 = seedAssignment(ctx, { lead_id: L3.id, account_id: W, active: false, at: daysAgo(80), released_at: daysAgo(50) });
    const A4 = seedAssignment(ctx, { lead_id: L4.id, account_id: W, at: daysAgo(15) });
    seedAssignment(ctx, { lead_id: L5.id, account_id: W, at: daysAgo(30) });
    const A6 = seedAssignment(ctx, { lead_id: L6.id, account_id: LI, at: daysAgo(4) });

    seedOutreach(ctx, { lead_id: L1.id, account_id: W, assignment_id: A1.id, status: 'SENT', sent_at: daysAgo(2) });
    seedOutreach(ctx, { lead_id: L4.id, account_id: W, assignment_id: A4.id, status: 'SENT_MANUALLY', sent_at: daysAgo(3) });
    seedOutreach(ctx, { lead_id: L3.id, account_id: W, assignment_id: A3.id, status: 'SENT', sent_at: daysAgo(45) });
    seedOutreach(ctx, { lead_id: L2.id, account_id: W, assignment_id: A2.id, status: 'READY_FOR_REVIEW', sent_at: null });
    seedOutreach(ctx, { lead_id: L6.id, account_id: LI, assignment_id: A6.id, status: 'SENT', sent_at: daysAgo(2) });

    seedInboundReply(ctx, { lead_id: L1.id, account_id: W, at: daysAgo(1) });
    seedInboundReply(ctx, { lead_id: L3.id, account_id: W, at: daysAgo(40) });

    seedAppointment(ctx, { lead_id: L1.id, dealer_id: hz, account_id: W, at: daysAgo(10) });
    seedAppointment(ctx, { lead_id: L2.id, dealer_id: hz, account_id: W, at: daysAgo(100) });
    seedAppointment(ctx, { lead_id: L1.id, dealer_id: hz, account_id: W, at: daysAgo(5), status: 'cancelled' });

    seedConversion(ctx, { lead_id: L2.id, dealer_id: hz, account_id: W, outcome: 'won', at: daysAgo(20) });
    seedConversion(ctx, { lead_id: L5.id, dealer_id: hz, account_id: null, outcome: 'won', at: daysAgo(5) });
    seedConversion(ctx, { lead_id: L3.id, dealer_id: hz, account_id: W, outcome: 'lost', at: daysAgo(10) });
    seedConversion(ctx, { lead_id: L1.id, dealer_id: hz, account_id: W, outcome: 'won', at: daysAgo(120) });

    seedSuppression(ctx, 'u4', daysAgo(2));
    seedSuppression(ctx, 'u3', daysAgo(10));
    seedSuppression(ctx, 'u6', daysAgo(2));
    ctx.clock.set(daysAgo(1));
    ctx.audit.event({ actor: 'agent:crm-agent', action: 'contact.suppressed', entity_type: 'lead', entity_id: L1.id });
    ctx.audit.event({ actor: 'agent:crm-agent', action: 'contact.suppressed', entity_type: 'contact_suppression', entity_id: 'sup_x', details: { platform_user_id: 'u4' } });
    ctx.clock.set(TEST_NOW);

    const perf = getAccountPerformance(ctx, W);
    assert.deepEqual(perf, {
      posts_published_30d: 2,
      avg_engagement_30d: 15,
      leads_owned_active: 1,
      outreach_sent_30d: 2,
      replies_30d: 1,
      reply_rate_30d: 0.5,
      appointments_90d: 1,
      won_90d: 2,
      conversion_rate_90d: 0.4,
      negative_feedback_7d: 2,
    });

    const li = getAccountPerformance(ctx, LI);
    assert.equal(li.posts_published_30d, 1);
    assert.equal(li.outreach_sent_30d, 1);
    assert.equal(li.reply_rate_30d, 0);
    assert.equal(li.negative_feedback_7d, 1);
    assert.equal(li.leads_owned_active, 1);

    ctx.clock.set(new Date(Date.parse(TEST_NOW) + 6 * DAY_MS).toISOString());
    const later = getAccountPerformance(ctx, W);
    assert.equal(later.negative_feedback_7d, 2, 'u4 row left the window but both audit events sit exactly on the inclusive 7d bound');
    assert.equal(later.posts_published_30d, 2);
    assert.equal(later.outreach_sent_30d, 2);
    ctx.clock.set(new Date(Date.parse(TEST_NOW) + 6 * DAY_MS + 3_600_000).toISOString());
    assert.equal(getAccountPerformance(ctx, W).negative_feedback_7d, 0);

    const brain = getAccountBrain(ctx, W);
    assert.equal(brain.recent_posts.length, 3);
    assert.equal(brain.recent_posts[0].published_at, daysAgo(5), 'newest post first');
  });

  it('caps recent posts and exposes the latest health snapshot', async () => {
    const { ctx, hz, acc } = setup();
    const id = acc('xhs-hz-i3');
    for (let i = 0; i < 12; i++) seedPublishedPost(ctx, { dealer_id: hz, account_id: id, published_at: daysAgo(i + 1) });
    computeAccountHealth(ctx, id);
    const brain = getAccountBrain(ctx, id);
    assert.equal(brain.recent_posts.length, 10);
    assert.equal(brain.recent_posts[0].published_at, daysAgo(1));
    assert.equal(brain.health?.state, 'HEALTHY');

    ctx.skills.register(skill);
    const viaSkill = await ctx.skills.invoke<{ account: { id: string } }>(ctx, 'account-brain', { account_id: id });
    assert.equal(viaSkill.account.id, id);
    await assert.rejects(ctx.skills.invoke(ctx, 'account-brain', {}), /account_id/);
  });
});
