import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HEALTH_STATES, type AccountStatus, type AuthState } from '../../../src/core/types.ts';
import {
  HEALTH_SCORE_BANDS,
  computeAccountHealth,
  computeFleetHealth,
  evaluateAccountHealth,
  getLatestHealth,
  isAccountOperable,
  skill,
} from '../../../src/skills/operations/account-health/index.ts';
import { TEST_NOW, createTestContext } from '../../helpers/context.ts';
import {
  accountIdByPlatformId,
  dealerIdByKey,
  loadDealerFixture,
  seedAssignment,
  seedLead,
  seedOutreach,
  seedSuppression,
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

let userSeq = 0;
/** Seeds `n` distinct leads contacted by the account at `sentAt`; returns their platform user ids. */
function seedSent(ctx: ReturnType<typeof createTestContext>, dealerId: string, accountId: string, n: number, sentAt: string): string[] {
  const users: string[] = [];
  for (let i = 0; i < n; i++) {
    const uid = `hu-${++userSeq}`;
    const lead = seedLead(ctx, { dealer_id: dealerId, platform_user_id: uid, stage: 'CONTACTED' });
    const asg = seedAssignment(ctx, { lead_id: lead.id, account_id: accountId });
    seedOutreach(ctx, { lead_id: lead.id, account_id: accountId, assignment_id: asg.id, status: 'SENT', sent_at: sentAt });
    users.push(uid);
  }
  return users;
}

const assertInBand = (score: number, state: (typeof HEALTH_STATES)[number]) => {
  const band = HEALTH_SCORE_BANDS[state];
  assert.ok(score >= band.min && score <= band.max, `${state} score ${score} within ${band.min}-${band.max}`);
};

describe('account-health: states', () => {
  it('fresh fixture accounts are HEALTHY and every computation is an audited decision', () => {
    const { ctx, hz } = setup();
    const rows = computeFleetHealth(ctx, hz);
    assert.equal(rows.length, 6);
    for (const r of rows) {
      assert.equal(r.state, 'HEALTHY');
      assertInBand(r.health_score, 'HEALTHY');
      assert.equal(r.date, '2026-09-12');
      assert.deepEqual(r.issues, []);
    }
    const decisions = ctx.db.table('agent_decisions').findMany({ decision_type: 'account_health' });
    assert.equal(decisions.length, 6);
    assert.equal(decisions[0].agent, 'fleet-controller');
    assert.equal(decisions[0].engine, 'rules');
    assert.equal(ctx.db.table('audit_events').count({ action: 'account.health_changed' }), 6, 'first snapshot records the initial state');
  });

  it('requires_auth → AT_RISK and reviewable (not blocking)', () => {
    const { ctx, sh, acc } = setup();
    const zhao = acc('xhs-sh-sales-zhao');
    const [official, sales] = computeFleetHealth(ctx, sh);
    assert.equal(official.state, 'HEALTHY');
    assert.equal(sales.account_id, zhao);
    assert.equal(sales.state, 'AT_RISK');
    assertInBand(sales.health_score, 'AT_RISK');
    assert.ok(sales.issues.some((i) => i.includes('授权')));
    assert.deepEqual(isAccountOperable(ctx, zhao), { ok: false, blocking: false, reason: '账号登录授权已失效，需要重新授权' });
  });

  it('daily outreach limit: 80% → WATCH, reached → AT_RISK, counted in the dealer-local day', () => {
    const { ctx, sh, acc } = setup();
    const id = acc('xhs-sh-official'); // sh-bmw limit 15
    seedSent(ctx, sh, id, 5, '2026-09-11T15:30:00.000Z'); // 23:30 previous local day — not today
    seedSent(ctx, sh, id, 12, '2026-09-11T16:30:00.000Z'); // 00:30 local today
    const watch = computeAccountHealth(ctx, id);
    assert.equal(watch.outreach_sent_today, 12);
    assert.equal(watch.state, 'WATCH');
    assertInBand(watch.health_score, 'WATCH');
    assert.ok(watch.issues.some((i) => i.includes('接近上限（12/15）')));
    assert.equal(isAccountOperable(ctx, id).ok, true, 'WATCH is operable');

    seedSent(ctx, sh, id, 3, '2026-09-12T01:00:00.000Z');
    const atRisk = computeAccountHealth(ctx, id);
    assert.equal(atRisk.outreach_sent_today, 15);
    assert.equal(atRisk.state, 'AT_RISK');
    assert.ok(atRisk.issues.some((i) => i.includes('已达上限（15/15）')));
    assert.equal(atRisk.id, watch.id, 'same-day recompute upserts the snapshot');
    assert.equal(ctx.db.table('account_health').count({ account_id: id }), 1);
    const op = isAccountOperable(ctx, id);
    assert.equal(op.ok, false);
    assert.equal(op.blocking, false);
    assert.equal(ctx.db.table('audit_events').count({ action: 'account.health_changed', entity_id: id }), 2);

    ctx.db.table('xhs_accounts').update(id, { daily_outreach_limit: 30 });
    const overridden = computeAccountHealth(ctx, id);
    assert.ok(!overridden.issues.some((i) => i.includes('上限')), 'account override raises the limit');
    assert.equal(overridden.state, 'WATCH', '20 sends in 30 days without a single reply is still a warning');
    assert.ok(overridden.issues.some((i) => i.includes('回复率')));
  });

  it('negative feedback in 7 days: 1 → WATCH, 3 → AT_RISK', () => {
    const { ctx, hz, acc } = setup();
    const id = acc('xhs-hz-sales-li');
    const users = seedSent(ctx, hz, id, 3, '2026-09-08T02:00:00.000Z');
    seedSuppression(ctx, users[0], '2026-09-10T02:00:00.000Z');
    const one = computeAccountHealth(ctx, id);
    assert.equal(one.negative_feedback_7d, 1);
    assert.equal(one.state, 'WATCH');

    seedSuppression(ctx, users[1], '2026-09-11T02:00:00.000Z');
    seedSuppression(ctx, users[2], '2026-09-12T01:00:00.000Z');
    const three = computeAccountHealth(ctx, id);
    assert.equal(three.negative_feedback_7d, 3);
    assert.equal(three.state, 'AT_RISK');
    assertInBand(three.health_score, 'AT_RISK');
    assert.ok(three.issues.some((i) => i.includes('3位')));
    assert.ok(three.health_score < one.health_score);

    ctx.clock.set('2026-09-18T03:00:00.000Z');
    const partial = computeAccountHealth(ctx, id);
    assert.equal(partial.negative_feedback_7d, 1, 'only the 09-12 suppression is still inside the 7-day window');
    assert.equal(partial.state, 'WATCH');
    ctx.clock.set('2026-09-19T02:00:01.000Z');
    const expired = computeAccountHealth(ctx, id);
    assert.equal(expired.negative_feedback_7d, 0);
    assert.equal(expired.state, 'HEALTHY', 'feedback older than 7 days no longer counts');
  });

  it('disabled → RESTRICTED and blocking; paused / cooldown → WATCH and reviewable', () => {
    const { ctx, acc } = setup();
    const id = acc('xhs-hz-guide');
    ctx.db.table('xhs_accounts').update(id, { status: 'disabled' });
    const restricted = computeAccountHealth(ctx, id);
    assert.equal(restricted.state, 'RESTRICTED');
    assert.ok(restricted.health_score < 30);
    assert.deepEqual(isAccountOperable(ctx, id), { ok: false, blocking: true, reason: '账号已停用' });

    ctx.db.table('xhs_accounts').update(id, { status: 'paused' });
    const paused = computeAccountHealth(ctx, id);
    assert.equal(paused.state, 'WATCH');
    assert.deepEqual(isAccountOperable(ctx, id), { ok: false, blocking: false, reason: '账号已暂停运营' });

    ctx.db.table('xhs_accounts').update(id, { status: 'cooldown' });
    assert.equal(computeAccountHealth(ctx, id).state, 'WATCH');
    assert.equal(isAccountOperable(ctx, id).blocking, false);

    ctx.db.table('xhs_accounts').update(id, { status: 'active' });
    assert.deepEqual(isAccountOperable(ctx, id), { ok: true, blocking: false, reason: '账号状态正常' });
  });

  it('low 30-day reply rate with ≥10 sent → WATCH', () => {
    const { ctx, hz, acc } = setup();
    const id = acc('xhs-hz-story');
    seedSent(ctx, hz, id, 9, '2026-09-01T02:00:00.000Z');
    assert.equal(computeAccountHealth(ctx, id).state, 'HEALTHY', '9 sent is below the minimum sample');
    seedSent(ctx, hz, id, 1, '2026-09-02T02:00:00.000Z');
    const row = computeAccountHealth(ctx, id);
    assert.equal(row.state, 'WATCH');
    assert.equal(row.reply_rate_30d, 0);
    assert.ok(row.issues.some((i) => i.includes('回复率')));
  });

  it('keeps one snapshot per local day; stale AT_RISK snapshots do not gate the next day', () => {
    const { ctx, sh, acc } = setup();
    const id = acc('xhs-sh-official');
    seedSent(ctx, sh, id, 15, '2026-09-12T01:00:00.000Z');
    assert.equal(computeAccountHealth(ctx, id).state, 'AT_RISK');
    assert.equal(isAccountOperable(ctx, id).ok, false);

    ctx.clock.set('2026-09-12T16:30:00.000Z'); // 00:30 on 2026-09-13 Shanghai
    assert.equal(isAccountOperable(ctx, id).ok, true, 'yesterday’s limit snapshot is not today’s state');
    const next = computeAccountHealth(ctx, id);
    assert.equal(next.date, '2026-09-13');
    assert.equal(next.outreach_sent_today, 0);
    assert.ok(!next.issues.some((i) => i.includes('上限')), 'daily limit resets at local midnight');
    assert.equal(next.state, 'WATCH', '15 unanswered sends in 30 days keep a low-reply warning');
    assert.equal(isAccountOperable(ctx, id).ok, true, 'WATCH remains operable');
    assert.equal(ctx.db.table('account_health').count({ account_id: id }), 2);
    assert.equal(getLatestHealth(ctx, id)?.id, next.id);
    assert.equal(getLatestHealth(ctx, acc('xhs-hz-i3')), null);
  });
});

describe('account-health: live operability (no snapshot computed yet)', () => {
  it('three negative responses in 7 days make the account non-operable even before the daily health run', () => {
    const { ctx, hz, acc } = setup();
    const id = acc('xhs-hz-sales-wang');
    const users = seedSent(ctx, hz, id, 3, '2026-09-09T02:00:00.000Z');
    for (const u of users) seedSuppression(ctx, u, '2026-09-11T02:00:00.000Z');
    assert.equal(getLatestHealth(ctx, id), null, 'no snapshot exists');
    const op = isAccountOperable(ctx, id);
    assert.equal(op.ok, false);
    assert.equal(op.blocking, false);
    assert.ok(op.reason.includes('3位'), op.reason);
    assert.equal(ctx.db.table('account_health').count({ account_id: id }), 0, 'isAccountOperable stays read-only');
    assert.equal(ctx.db.table('agent_decisions').count({ subject_id: id }), 0);
  });

  it('a reached daily outreach limit is detected live and resets at local midnight', () => {
    const { ctx, sh, acc } = setup();
    const id = acc('xhs-sh-official'); // limit 15
    seedSent(ctx, sh, id, 15, '2026-09-12T01:00:00.000Z');
    const op = isAccountOperable(ctx, id);
    assert.equal(op.ok, false);
    assert.equal(op.blocking, false);
    assert.ok(op.reason.includes('15/15'), op.reason);
    ctx.clock.set('2026-09-12T16:30:00.000Z');
    assert.equal(isAccountOperable(ctx, id).ok, true);
  });

  it('a stale persisted snapshot never overrides the live account state', () => {
    const { ctx, acc } = setup();
    const id = acc('xhs-hz-story');
    ctx.db.table('xhs_accounts').update(id, { status: 'disabled' });
    assert.equal(computeAccountHealth(ctx, id).state, 'RESTRICTED');
    ctx.db.table('xhs_accounts').update(id, { status: 'active' });
    assert.deepEqual(isAccountOperable(ctx, id), { ok: true, blocking: false, reason: '账号状态正常' });
  });
});

describe('account-health: scoring', () => {
  it('health_score always stays inside the band of its state', () => {
    const statuses: AccountStatus[] = ['active', 'paused', 'cooldown', 'disabled'];
    const auths: AuthState[] = ['authenticated', 'requires_auth', 'unknown'];
    let combos = 0;
    for (const status of statuses)
      for (const auth_state of auths)
        for (const negative_feedback_7d of [0, 1, 2, 3, 8])
          for (const outreach_sent_today of [0, 16, 20, 25])
            for (const [outreach_sent_30d, reply_rate_30d] of [
              [0, 0],
              [12, 0.01],
              [40, 0.3],
            ]) {
              const r = evaluateAccountHealth({
                status,
                auth_state,
                outreach_sent_today,
                daily_outreach_limit: 20,
                publish_today: 2,
                daily_publish_limit: 2,
                negative_feedback_7d,
                reply_rate_30d,
                outreach_sent_30d,
              });
              assertInBand(r.health_score, r.state);
              if (status === 'disabled') assert.equal(r.state, 'RESTRICTED');
              assert.equal(r.findings.length > 0, true, 'publish limit finding is always present here');
              combos++;
            }
    assert.equal(combos, 720);
    const zeroLimit = evaluateAccountHealth({
      status: 'active',
      auth_state: 'authenticated',
      outreach_sent_today: 0,
      daily_outreach_limit: 0,
      publish_today: 0,
      daily_publish_limit: 2,
      negative_feedback_7d: 0,
      reply_rate_30d: 0,
      outreach_sent_30d: 0,
    });
    assert.equal(zeroLimit.state, 'HEALTHY', 'a zero limit with nothing sent is not a breach');
    assert.equal(zeroLimit.health_score, 100);
  });

  it('runs as the account-health skill with persisted, audited, in-band snapshots', async () => {
    const { ctx, sh, acc } = setup();
    ctx.skills.register(skill);
    assert.equal(skill.agent, 'fleet-controller');
    const rows = await ctx.skills.invoke<{ account_id: string; state: (typeof HEALTH_STATES)[number]; health_score: number }[]>(
      ctx,
      'account-health',
      { dealer_id: sh },
    );
    assert.equal(rows.length, 2);
    const byAccount = new Map(rows.map((r) => [r.account_id, r]));
    assert.equal(byAccount.get(acc('xhs-sh-official'))?.state, 'HEALTHY');
    assert.equal(byAccount.get(acc('xhs-sh-sales-zhao'))?.state, 'AT_RISK');
    for (const r of rows) assertInBand(r.health_score, r.state);
    assert.equal(ctx.db.table('account_health').count(), 2);
    assert.equal(ctx.db.table('agent_decisions').count({ decision_type: 'account_health' }), 2);
    assert.throws(() => skill.validateOutput?.([{ ...getLatestHealth(ctx, acc('xhs-sh-official'))!, health_score: 20 }]), /outside HEALTHY band/);
    await assert.rejects(ctx.skills.invoke(ctx, 'account-health', { dealer_id: '' }), /dealer_id/);
    await assert.rejects(ctx.skills.invoke(ctx, 'account-health', { dealer_id: 'dlr_missing' }), /not found/);
    assert.equal(TEST_NOW, '2026-09-12T02:00:00.000Z');
  });
});
