import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PolicyError } from '../../../src/core/errors.ts';
import { textSimilarity } from '../../../src/core/text.ts';
import type { LlmProvider } from '../../../src/providers/llm/types.ts';
import type { XhsProvider } from '../../../src/providers/xhs/types.ts';
import { seedSuppression } from '../../helpers/fixtures.ts';
import {
  approveOutreach,
  cancelOutreach,
  composeOutreachMessage,
  PRO_WORKBENCH_URL,
  listOutreachQueue,
  markOutreachSentManually,
  prepareOutreach,
  primarySignalOf,
  sendOutreach,
  skill,
} from '../../../src/skills/sales/outreach/index.ts';
import { BUYER_QUOTE, BUYER_TEXT, createWorld, seedSignalLead, setDealerSetting, type World } from './helpers.ts';

const WANG = 'xhs-hz-sales-wang';
const I3 = 'xhs-hz-i3';

function fakeLlm(respond: (prompt: string) => string): LlmProvider {
  return {
    name: 'fake',
    status: () => ({ provider: 'fake', status: 'AVAILABLE', model: 'fake-model', reason: 'test' }),
    completeJson: async () => ({ ok: false, reason: 'not used' }),
    completeText: async (req) => ({ ok: true, data: respond(req.prompt), model: 'fake-model' }),
  };
}

/** Provider that delegates to the simulation but replaces sendMessage. */
function withSend(w: World, sendMessage: XhsProvider['sendMessage']): void {
  const base = w.sim;
  const proxy = Object.create(base) as XhsProvider;
  (proxy as { sendMessage: XhsProvider['sendMessage'] }).sendMessage = sendMessage;
  w.ctx.xhs = proxy;
}

describe('prepareOutreach', () => {
  it('writes a personalized, fact-verified message and waits for review when DMs are unavailable', async () => {
    const w = createWorld();
    const lead = seedSignalLead(w, { user: 'u-buyer-1', owner: WANG });
    const o = await prepareOutreach(w.ctx, lead.id);

    assert.equal(o.status, 'READY_FOR_REVIEW');
    assert.equal(o.account_id, w.account(WANG));
    assert.equal(o.capability_status, 'UNAVAILABLE');
    assert.equal(o.provider_message_id, null);
    assert.ok(Array.from(o.message).length <= 300);
    assert.ok(o.message.includes(BUYER_QUOTE), 'quotes the real signal');
    assert.ok(BUYER_TEXT.includes(BUYER_QUOTE));
    assert.ok(o.message.includes('销售顾问王磊'));
    assert.ok(o.fact_refs.some((f) => f.kind === 'inventory' && f.claim === '白外红内现车1台'));
    assert.ok(o.fact_refs.some((f) => f.kind === 'offer'));
    for (const f of o.fact_refs) assert.ok(o.message.includes(f.claim), `claim "${f.claim}" is verbatim in the message`);
    assert.doesNotMatch(o.message, /微信|电话|http|加我/);

    const byCheck = Object.fromEntries(o.guard_results.map((g) => [g.check, g]));
    assert.deepEqual(
      o.guard_results.map((g) => g.check),
      ['ownership', 'negative_feedback', 'duplicate', 'previous_contact', 'account_health', 'rate_limit', 'factual_verification', 'platform_rules', 'approval_policy', 'provider_capability'],
    );
    assert.equal(byCheck.factual_verification.passed, true);
    assert.equal(byCheck.platform_rules.passed, true);
    assert.equal(byCheck.approval_policy.passed, false);
    assert.equal(byCheck.approval_policy.blocking, false);
    assert.equal(byCheck.provider_capability.passed, false);
    assert.equal(byCheck.provider_capability.blocking, false);

    assert.equal(w.ctx.db.table('leads').require(lead.id).stage, 'OUTREACH_READY');
    const decisions = w.ctx.audit.decisionsFor('outreach', o.id).map((d) => d.decision_type);
    assert.ok(decisions.includes('outreach_generation'));
    assert.ok(decisions.includes('outreach_guard'));
    const gen = w.ctx.audit.decisionsFor('outreach', o.id).find((d) => d.decision_type === 'outreach_generation')!;
    assert.equal(gen.inputs.llm, 'llm_unavailable');
    assert.ok(gen.evidence.some((e) => e.code === 'public_signal' && e.quote === BUYER_QUOTE));

    const again = await prepareOutreach(w.ctx, lead.id);
    assert.equal(again.id, o.id, 'idempotent while pending');
    assert.equal(w.ctx.db.table('outreach').count({ lead_id: lead.id }), 1);
  });

  it('requires an active owning account and an assigned stage', async () => {
    const w = createWorld();
    const unassigned = seedSignalLead(w, { user: 'u-free', owner: null });
    await assert.rejects(prepareOutreach(w.ctx, unassigned.id), (err: unknown) => err instanceof PolicyError && err.code === 'no_active_assignment');
    const early = seedSignalLead(w, { user: 'u-early', owner: WANG, stage: 'QUALIFIED' });
    await assert.rejects(prepareOutreach(w.ctx, early.id), (err: unknown) => err instanceof PolicyError && err.code === 'lead_not_assigned');
  });

  it('different account personas produce clearly different messages that both quote the real signal', async () => {
    const w = createWorld();
    const a = await prepareOutreach(w.ctx, seedSignalLead(w, { user: 'u-a', owner: WANG }).id);
    const b = await prepareOutreach(w.ctx, seedSignalLead(w, { user: 'u-b', owner: I3 }).id);
    assert.equal(a.status, 'READY_FOR_REVIEW');
    assert.equal(b.status, 'READY_FOR_REVIEW');
    assert.ok(a.message.includes(BUYER_QUOTE) && b.message.includes(BUYER_QUOTE));
    assert.match(a.message, /销售顾问/);
    assert.match(b.message, /i3电车研究所/);
    assert.match(b.message, /实测/);
    assert.ok(textSimilarity(a.message, b.message) < 0.8, `similarity ${textSimilarity(a.message, b.message)}`);
  });

  it('uses an LLM rewrite only when every fact and the quote survive and claims verify', async () => {
    const w = createWorld();
    const lead = seedSignalLead(w, { user: 'u-llm-bad', owner: WANG });
    w.ctx.llm = fakeLlm(() => '您好！宝马i3现在指导价只要20万，加微信详聊。');
    const bad = await prepareOutreach(w.ctx, lead.id);
    assert.equal(bad.engine, 'rules');
    assert.ok(!bad.message.includes('20万'));
    const gen = w.ctx.audit.decisionsFor('outreach', bad.id).find((d) => d.decision_type === 'outreach_generation')!;
    assert.match(String(gen.inputs.llm), /^llm_rejected/);

    const w2 = createWorld();
    const lead2 = seedSignalLead(w2, { user: 'u-llm-good', owner: WANG });
    w2.ctx.llm = fakeLlm((prompt) => {
      const draft = /待润色私信：(.*)$/su.exec(prompt)![1];
      return draft.replace('不催单', '不着急');
    });
    const good = await prepareOutreach(w2.ctx, lead2.id);
    assert.equal(good.engine, 'llm+rules');
    assert.match(good.message, /不着急/);
    assert.equal(good.guard_results.find((g) => g.check === 'factual_verification')!.passed, true);
  });

  it('composes follow-up text that references the earlier touch without repeating the first message', () => {
    const w = createWorld();
    const lead = seedSignalLead(w, { user: 'u-compose', owner: WANG });
    const account = w.ctx.db.table('xhs_accounts').require(w.account(WANG));
    const dealer = w.ctx.db.table('dealers').require(w.dealerId);
    const signal = primarySignalOf(w.ctx, lead);
    const first = composeOutreachMessage(w.ctx, { lead, account, persona: null, dealer, signal, kind: 'first_touch' });
    const at = new Date(w.ctx.clock.now().getTime() - 3 * 86_400_000).toISOString();
    const follow = composeOutreachMessage(w.ctx, { lead, account, persona: null, dealer, signal, kind: 'follow_up', previous_touch: { sent_at: at } });
    assert.match(follow.message, /3天前跟您聊过/);
    assert.match(follow.message, /不再打扰/);
    assert.ok(textSimilarity(first.message, follow.message) < 0.7);
  });
});

describe('approval, sending and manual send', () => {
  it('approved without send capability → waits APPROVED; manual send records sent_by and CONTACTED', async () => {
    const w = createWorld();
    const lead = seedSignalLead(w, { user: 'u-manual', owner: WANG });
    const o = await prepareOutreach(w.ctx, lead.id);
    const approved = await approveOutreach(w.ctx, o.id, 'operator:王磊');
    assert.equal(approved.status, 'APPROVED');
    assert.equal(approved.approved_by, 'operator:王磊');
    assert.equal(approved.provider_message_id, null);
    assert.equal(w.sim.sentMessages().length, 0, 'nothing was sent through the provider');

    const sent = markOutreachSentManually(w.ctx, o.id, 'operator:王磊');
    assert.equal(sent.status, 'SENT_MANUALLY');
    assert.equal(sent.sent_by, 'operator:王磊');
    assert.equal(sent.sent_at, w.ctx.clock.iso());
    assert.equal(w.ctx.db.table('leads').require(lead.id).stage, 'CONTACTED');
    assert.ok(w.ctx.audit.eventsFor('outreach', o.id).some((e) => e.action === 'outreach.sent_manually'));
    assert.equal(markOutreachSentManually(w.ctx, o.id, 'operator:王磊').status, 'SENT_MANUALLY', 'idempotent');
    assert.ok(w.sim.contactedAt(w.account(WANG), 'u-manual'), 'simulation inbox harness notified');
  });

  it('sends through the provider only with a confirmed message id', async () => {
    const w = createWorld({ send_messages: true });
    const lead = seedSignalLead(w, { user: 'u-send', owner: WANG });
    const o = await prepareOutreach(w.ctx, lead.id);
    assert.equal(o.status, 'READY_FOR_REVIEW', 'REVIEW_REQUIRED policy still needs a human');
    assert.deepEqual(o.guard_results.filter((g) => !g.passed).map((g) => g.check), ['approval_policy']);
    const sent = await approveOutreach(w.ctx, o.id, 'operator:王磊');
    assert.equal(sent.status, 'SENT');
    assert.match(sent.provider_message_id ?? '', /^sim-msg-/);
    assert.equal(w.sim.sentMessages()[0].to, 'u-send');
    assert.equal(w.ctx.db.table('leads').require(lead.id).stage, 'CONTACTED');
  });

  it('AUTO policy sends immediately at or above auto_send_min_score and routes lower scores to review', async () => {
    const w = createWorld({ send_messages: true });
    setDealerSetting(w, { outreach_approval_policy: 'AUTO' });
    const hot = await prepareOutreach(w.ctx, seedSignalLead(w, { user: 'u-hot', owner: WANG, score: 96 }).id);
    assert.equal(hot.status, 'SENT');
    assert.equal(hot.approved_by, 'policy:AUTO');
    const warm = await prepareOutreach(
      w.ctx,
      seedSignalLead(w, { user: 'u-warm', owner: I3, score: 70, text: '现在i3优惠多少', intent: { brand: 'BMW', model: 'i3', discount_intent: true, purchase_stage: 'price_shopping' } }).id,
    );
    assert.equal(warm.status, 'READY_FOR_REVIEW');
    const policy = warm.guard_results.find((g) => g.check === 'approval_policy')!;
    assert.equal(policy.passed, false);
    assert.match(policy.detail, /低于自动发送阈值90/);
  });

  it('provider failures never become SENT: retryable/unknown stay APPROVED, permanent failures are FAILED', async () => {
    const w = createWorld({ send_messages: true });
    const lead = seedSignalLead(w, { user: 'u-fail', owner: WANG });
    const o = await prepareOutreach(w.ctx, lead.id);

    withSend(w, async () => ({ ok: false, status: 'UNAVAILABLE', reason: 'network timeout', retryable: true }));
    const retry = await approveOutreach(w.ctx, o.id, 'operator:王磊');
    assert.equal(retry.status, 'APPROVED');
    assert.match(retry.blocked_reason ?? '', /network timeout/);

    withSend(w, async () => ({ ok: true, data: { provider_message_id: '' } }));
    const unconfirmed = await sendOutreach(w.ctx, o.id);
    assert.equal(unconfirmed.status, 'APPROVED');
    assert.match(unconfirmed.blocked_reason ?? '', /未返回消息ID/);

    withSend(w, async () => ({ ok: false, status: 'UNAVAILABLE', reason: 'account banned', retryable: false }));
    const failed = await sendOutreach(w.ctx, o.id);
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.provider_message_id, null);
    assert.notEqual(w.ctx.db.table('leads').require(lead.id).stage, 'CONTACTED');
    await assert.rejects(sendOutreach(w.ctx, o.id), (err: unknown) => err instanceof PolicyError && err.code === 'outreach_not_approved');
  });

  it('cancel works for pending outreach, is idempotent, refuses sent messages and frees the lead for regeneration', async () => {
    const w = createWorld();
    const lead = seedSignalLead(w, { user: 'u-cancel', owner: WANG });
    const o = await prepareOutreach(w.ctx, lead.id);
    const cancelled = cancelOutreach(w.ctx, o.id, 'operator:李娜', '客户信息需要核实');
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cancelOutreach(w.ctx, o.id, 'operator:李娜', '再次取消').status, 'CANCELLED');
    const regenerated = await prepareOutreach(w.ctx, lead.id);
    assert.notEqual(regenerated.id, o.id);
    markOutreachSentManually(w.ctx, regenerated.id, 'operator:王磊');
    assert.throws(() => cancelOutreach(w.ctx, regenerated.id, 'operator:李娜', 'late'), (err: unknown) => err instanceof PolicyError && err.code === 'outreach_already_sent');
  });

  it('skill dispatches actions and validates required ids', async () => {
    const w = createWorld();
    const lead = seedSignalLead(w, { user: 'u-skill', owner: WANG });
    const o = await skill.run(w.ctx, { action: 'prepare', lead_id: lead.id });
    assert.equal(o.status, 'READY_FOR_REVIEW');
    await assert.rejects(Promise.resolve().then(() => skill.run(w.ctx, { action: 'approve', outreach_id: o.id })), /actor/);
    const sent = await skill.run(w.ctx, { action: 'mark_sent', outreach_id: o.id, actor: 'operator:王磊' });
    assert.equal(sent.status, 'SENT_MANUALLY');
  });
});

describe('listOutreachQueue', () => {
  it('shows copy-ready text, source link and manual-send steps for the owning account; blocked rows are never copyable', async () => {
    const w = createWorld();
    const lead = seedSignalLead(w, { user: 'u-queue', owner: WANG });
    const o = await prepareOutreach(w.ctx, lead.id);
    const blockedLead = seedSignalLead(w, { user: 'u-queue-dnc', owner: I3 });
    seedSuppression(w.ctx, 'u-queue-dnc');
    const blocked = await prepareOutreach(w.ctx, blockedLead.id);
    assert.equal(blocked.status, 'BLOCKED');

    const queue = listOutreachQueue(w.ctx, { dealer_id: w.dealerId });
    assert.equal(queue.length, 1);
    const item = queue[0];
    assert.equal(item.outreach.id, o.id);
    assert.equal(item.copy_text, o.message);
    assert.equal(item.account.nickname, '销售小王·杭州宝马');
    assert.equal(item.lead.data_mode, 'live');
    assert.equal(item.lead.actor_type, 'BUYER');
    assert.equal(item.original_signal?.content, BUYER_TEXT);
    assert.match(item.original_signal?.url ?? '', /^https:\/\/www\.xiaohongshu\.com\/explore\//);
    const steps = item.manual_send_instructions.join('\n');
    assert.match(steps, /销售小王·杭州宝马/);
    assert.match(steps, /已在小红书发送/);
    assert.match(steps, /审核/);

    const blockedItems = listOutreachQueue(w.ctx, { dealer_id: w.dealerId, statuses: ['BLOCKED'] });
    assert.equal(blockedItems.length, 1);
    assert.equal(blockedItems[0].copy_text, null);
    assert.match(blockedItems[0].manual_send_instructions[0], /请勿发送/);
    assert.equal(listOutreachQueue(w.ctx, { dealer_id: w.dealerId, account_id: w.account(I3) }).length, 0);
  });

  it('follows the store\u2019s own DM channel: the 专业号 workbench instead of the app when the store set it', async () => {
    const w = createWorld();
    const lead = seedSignalLead(w, { user: 'u-pro', owner: WANG });
    await prepareOutreach(w.ctx, lead.id);

    const appItem = listOutreachQueue(w.ctx, { dealer_id: w.dealerId })[0];
    assert.equal(appItem.send_channel, 'app');
    assert.equal(appItem.workbench_url, null);
    assert.match(appItem.manual_send_instructions.join('\n'), /小红书App/);

    const dealer = w.ctx.db.table('dealers').get(w.dealerId)!;
    w.ctx.db.table('dealers').update(w.dealerId, { settings: { ...dealer.settings, dm_channel: 'pro' } });

    const proItem = listOutreachQueue(w.ctx, { dealer_id: w.dealerId })[0];
    assert.equal(proItem.send_channel, 'pro');
    assert.equal(proItem.workbench_url, PRO_WORKBENCH_URL);
    const steps = proItem.manual_send_instructions.join('\n');
    assert.match(steps, /专业号后台/);
    assert.match(steps, /pro\.xiaohongshu\.com/);
    assert.doesNotMatch(steps, /小红书App/);
    assert.match(steps, /已在小红书发送/, 'the human still registers the send by hand');
  });
});
