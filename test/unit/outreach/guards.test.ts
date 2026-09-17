import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PolicyError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import { releaseAssignment } from '../../../src/skills/acquisition/account-assignment/index.ts';
import {
  approveOutreach,
  markOutreachSentManually,
  prepareOutreach,
  runSendGuards,
} from '../../../src/skills/sales/outreach/index.ts';
import { seedAssignment, seedOutreach, seedSuppression } from '../../helpers/fixtures.ts';
import { createWorld, seedSignalLead, setDealerSetting } from './helpers.ts';

const WANG = 'xhs-hz-sales-wang';
const LI = 'xhs-hz-sales-li';
const I3 = 'xhs-hz-i3';

const failed = (o: { guard_results: { check: string; passed: boolean; blocking: boolean }[] }, check: string) =>
  o.guard_results.find((g) => g.check === check && !g.passed);

describe('negative feedback and ownership', () => {
  it('a globally suppressed user is BLOCKED and the lead does not advance', async () => {
    const w = createWorld();
    const lead = seedSignalLead(w, { user: 'u-dnc', owner: WANG });
    seedSuppression(w.ctx, 'u-dnc');
    const o = await prepareOutreach(w.ctx, lead.id);
    assert.equal(o.status, 'BLOCKED');
    assert.equal(failed(o, 'negative_feedback')?.blocking, true);
    assert.match(o.blocked_reason ?? '', /negative_feedback/);
    assert.equal(w.ctx.db.table('leads').require(lead.id).stage, 'ASSIGNED');
    assert.ok(w.ctx.audit.eventsFor('outreach', o.id).some((e) => e.action === 'outreach.blocked'));
  });

  it('not_interested evidence blocks outreach', async () => {
    const w = createWorld();
    const lead = seedSignalLead(w, { user: 'u-no', owner: WANG });
    w.ctx.db.table('leads').update(lead.id, { evidence: [{ code: 'not_interested', label: '明确拒绝', quote: '不需要' }] });
    const o = await prepareOutreach(w.ctx, lead.id);
    assert.equal(o.status, 'BLOCKED');
    assert.ok(failed(o, 'negative_feedback'));
  });

  it('only the active owning account may send', () => {
    const w = createWorld();
    const lead = seedSignalLead(w, { user: 'u-owner', owner: WANG });
    const guards = runSendGuards(w.ctx, { lead, account_id: w.account(I3), message: '你好', fact_refs: [], kind: 'first_touch', capability: 'UNAVAILABLE' });
    const ownership = guards.find((g) => g.check === 'ownership')!;
    assert.equal(ownership.passed, false);
    assert.equal(ownership.blocking, true);
  });
});

describe('duplicates and previous contact', () => {
  it('after one account contacted the user, a reassigned account cannot send another first touch', async () => {
    const w = createWorld();
    const lead = seedSignalLead(w, { user: 'u-dup', owner: WANG });
    const first = await prepareOutreach(w.ctx, lead.id);
    markOutreachSentManually(w.ctx, first.id, 'operator:王磊');

    releaseAssignment(w.ctx, lead.id, '人工重新分配', 'operator:经理');
    seedAssignment(w.ctx, { lead_id: lead.id, account_id: w.account(LI) });
    const second = await prepareOutreach(w.ctx, lead.id);
    assert.equal(second.status, 'BLOCKED');
    assert.equal(failed(second, 'duplicate')?.blocking, true);
    assert.equal(failed(second, 'previous_contact')?.blocking, true);
    const live = w.ctx.db.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM outreach WHERE lead_id = ? AND kind = 'first_touch' AND status IN ('READY_FOR_REVIEW','APPROVED','SENT','SENT_MANUALLY')`,
      lead.id,
    )[0];
    assert.equal(Number(live.n), 1);
  });

  it('a pending first touch from any other account is a blocking duplicate', () => {
    const w = createWorld();
    const lead = seedSignalLead(w, { user: 'u-dup2', owner: WANG });
    const other = w.ctx.db.table('lead_assignments').insert({
      id: newId('asg'),
      lead_id: lead.id,
      account_id: w.account(LI),
      active: false,
      reason: 'old',
      candidates: [],
      assigned_by: 'agent:fleet-controller',
      assigned_at: w.ctx.clock.iso(),
      released_at: w.ctx.clock.iso(),
      released_reason: 'released',
    });
    seedOutreach(w.ctx, { lead_id: lead.id, account_id: w.account(LI), assignment_id: other.id, status: 'READY_FOR_REVIEW' });
    const guards = runSendGuards(w.ctx, { lead, account_id: w.account(WANG), message: '你好', fact_refs: [], kind: 'first_touch', capability: 'UNAVAILABLE' });
    const dup = guards.find((g) => g.check === 'duplicate')!;
    assert.equal(dup.passed, false);
    assert.equal(dup.blocking, true);
    assert.match(dup.detail, /其他账号/);
  });

  it('the same account never sends a near-identical template to two users', async () => {
    const w = createWorld();
    const a = await prepareOutreach(w.ctx, seedSignalLead(w, { user: 'u-tpl-a', owner: WANG }).id);
    const b = await prepareOutreach(w.ctx, seedSignalLead(w, { user: 'u-tpl-b', owner: WANG }).id);
    assert.equal(a.status, 'READY_FOR_REVIEW');
    assert.equal(b.status, 'BLOCKED');
    assert.match(failed(b, 'platform_rules') ? b.guard_results.find((g) => g.check === 'platform_rules')!.detail : '', /群发模板/);
  });
});

describe('account health, rate limits and policy', () => {
  it('daily limit and minimum interval route to review (never auto-send)', async () => {
    const w = createWorld({ send_messages: true });
    w.ctx.db.table('xhs_accounts').update(w.account(WANG), { daily_outreach_limit: 1 });
    const earlier = seedSignalLead(w, { user: 'u-earlier', owner: WANG });
    const asg = w.ctx.db.table('lead_assignments').findOne({ lead_id: earlier.id, active: true })!;
    seedOutreach(w.ctx, { lead_id: earlier.id, account_id: w.account(WANG), assignment_id: asg.id, status: 'SENT_MANUALLY', sent_at: w.ctx.clock.iso() });

    const o = await prepareOutreach(w.ctx, seedSignalLead(w, { user: 'u-limit', owner: WANG }).id);
    assert.equal(o.status, 'READY_FOR_REVIEW');
    const rate = failed(o, 'rate_limit')!;
    assert.equal(rate.blocking, false);
    const approved = await approveOutreach(w.ctx, o.id, 'operator:王磊');
    assert.equal(approved.status, 'APPROVED', 'human approval does not bypass the rate limit into an automatic send');
    assert.equal(w.sim.sentMessages().length, 0);

    const w2 = createWorld();
    const prev = seedSignalLead(w2, { user: 'u-prev', owner: WANG });
    const asg2 = w2.ctx.db.table('lead_assignments').findOne({ lead_id: prev.id, active: true })!;
    seedOutreach(w2.ctx, {
      lead_id: prev.id,
      account_id: w2.account(WANG),
      assignment_id: asg2.id,
      status: 'SENT_MANUALLY',
      sent_at: new Date(w2.ctx.clock.now().getTime() - 60_000).toISOString(),
    });
    const lead = seedSignalLead(w2, { user: 'u-interval', owner: WANG });
    const guards = runSendGuards(w2.ctx, { lead, account_id: w2.account(WANG), message: '你好', fact_refs: [], kind: 'first_touch', capability: 'UNAVAILABLE' });
    assert.match(guards.find((g) => g.check === 'rate_limit')!.detail, /需间隔3分钟/);
  });

  it('a disabled account or DISABLED policy blocks', async () => {
    const w = createWorld();
    w.ctx.db.table('xhs_accounts').update(w.account(WANG), { status: 'disabled' });
    const blockedByHealth = await prepareOutreach(w.ctx, seedSignalLead(w, { user: 'u-disabled', owner: WANG }).id);
    assert.equal(blockedByHealth.status, 'BLOCKED');
    assert.equal(failed(blockedByHealth, 'account_health')?.blocking, true);

    const w2 = createWorld();
    setDealerSetting(w2, { outreach_approval_policy: 'DISABLED' });
    const blockedByPolicy = await prepareOutreach(w2.ctx, seedSignalLead(w2, { user: 'u-policy', owner: WANG }).id);
    assert.equal(blockedByPolicy.status, 'BLOCKED');
    assert.equal(failed(blockedByPolicy, 'approval_policy')?.blocking, true);
  });
});

describe('edits are re-verified', () => {
  it('an invented price or a landing price in the edited text is BLOCKED by factual verification', async () => {
    const w = createWorld();
    const o = await prepareOutreach(w.ctx, seedSignalLead(w, { user: 'u-price', owner: WANG }).id);
    const edited = await approveOutreach(w.ctx, o.id, 'operator:王磊', `${o.message}宝马i3现在指导价只要20万。`);
    assert.equal(edited.status, 'BLOCKED');
    assert.equal(failed(edited, 'factual_verification')?.blocking, true);
    assert.match(edited.blocked_reason ?? '', /20万/);
    assert.equal(edited.engine, 'human');

    const w2 = createWorld();
    const o2 = await prepareOutreach(w2.ctx, seedSignalLead(w2, { user: 'u-landing', owner: WANG }).id);
    const landing = await approveOutreach(w2.ctx, o2.id, 'operator:王磊', '您好，i3落地价28万就能开走。');
    assert.equal(landing.status, 'BLOCKED');
    assert.match(failed(landing, 'factual_verification') ? landing.blocked_reason ?? '' : '', /落地/);
  });

  it('asking to add WeChat or leaving a phone number is BLOCKED by platform rules', async () => {
    const w = createWorld();
    const o = await prepareOutreach(w.ctx, seedSignalLead(w, { user: 'u-wx', owner: WANG }).id);
    const wx = await approveOutreach(w.ctx, o.id, 'operator:王磊', '您好，方便的话加微信详聊，我发您报价单。');
    assert.equal(wx.status, 'BLOCKED');
    assert.equal(failed(wx, 'platform_rules')?.blocking, true);

    const w2 = createWorld();
    const o2 = await prepareOutreach(w2.ctx, seedSignalLead(w2, { user: 'u-phone', owner: WANG }).id);
    const phone = await approveOutreach(w2.ctx, o2.id, 'operator:王磊', '有问题直接打我电话13812345678。');
    assert.equal(phone.status, 'BLOCKED');
  });

  it('manual send re-checks blocking guards: a user who opted out meanwhile cannot be recorded as contacted', async () => {
    const w = createWorld();
    const lead = seedSignalLead(w, { user: 'u-late-dnc', owner: WANG });
    const o = await prepareOutreach(w.ctx, lead.id);
    seedSuppression(w.ctx, 'u-late-dnc');
    assert.throws(() => markOutreachSentManually(w.ctx, o.id, 'operator:王磊'), (err: unknown) => err instanceof PolicyError && err.code === 'outreach_blocked');
    assert.equal(w.ctx.db.table('outreach').require(o.id).status, 'BLOCKED');
    assert.notEqual(w.ctx.db.table('leads').require(lead.id).stage, 'CONTACTED');
  });
});
