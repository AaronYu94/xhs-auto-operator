import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PolicyError } from '../../../src/core/errors.ts';
import { parseJuguangLeadPush } from '../../../src/providers/xhs/juguang-webhook.ts';
import { SimulationXhsProvider } from '../../../src/providers/xhs/simulation.ts';
import { detectIntentRules } from '../../../src/skills/acquisition/intent-detection/nlu.ts';
import { upsertLeadFromSignal } from '../../../src/skills/acquisition/lead-deduplication/index.ts';
import { isSuppressed, transitionLead } from '../../../src/skills/operations/crm/index.ts';
import { getDealerProfile, verifyClaims } from '../../../src/skills/operations/dealer-brain/index.ts';
import {
  HANDOFF_REASONS,
  approveReply,
  colourOfMessage,
  ingestJuguangLeads,
  listConversations,
  markReplySentManually,
  pollInbox,
  processInboundMessage,
  skill,
} from '../../../src/skills/sales/conversation/index.ts';
import { createTestContext } from '../../helpers/context.ts';
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
  const summary = loadDealerFixture(ctx);
  const hz = dealerIdByKey(summary, 'hz-bmw');
  const wang = accountIdByPlatformId(summary, 'xhs-hz-sales-wang');
  const li = accountIdByPlatformId(summary, 'xhs-hz-sales-li');
  const internalToPlatform = Object.fromEntries(Object.entries(summary.account_ids).map(([p, i]) => [i, p]));
  return { ctx, summary, hz, wang, li, internalToPlatform };
}
type Setup = ReturnType<typeof setup>;

/**
 * A lead discovered from a real public comment ('宝马i3 35L现在什么价') that wang then contacted by hand
 * (active assignment + SENT_MANUALLY first touch).
 */
function contactedLead(s: Setup, user = 'u-conv-1', content = '宝马i3 35L现在什么价') {
  const detection = detectIntentRules(content, { source_type: 'comment', post_title: '宝马i3现在值得买吗？' }, getDealerProfile(s.ctx, s.hz));
  const created = upsertLeadFromSignal(s.ctx, {
    dealer_id: s.hz,
    identity: { platform_user_id: user, username: user },
    signal: { source_type: 'comment', content, signal_at: s.ctx.clock.iso(), detection },
  });
  const lead = transitionLead(s.ctx, created.lead.id, 'CONTACTED', { reason: 'test: contacted by hand', actor: 'operator:test' }).lead;
  const assignment = seedAssignment(s.ctx, { lead_id: lead.id, account_id: s.wang });
  seedOutreach(s.ctx, { lead_id: lead.id, account_id: s.wang, assignment_id: assignment.id, status: 'SENT_MANUALLY' });
  return { lead, assignment };
}

const inbound = (s: Setup, content: string, extra: Partial<Parameters<typeof processInboundMessage>[1]> = {}) =>
  processInboundMessage(s.ctx, { account_id: s.wang, platform_user_id: 'u-conv-1', content, source: 'manual', ...extra });

const policyCode = (code: string) => (err: unknown) => err instanceof PolicyError && err.code === code;

describe('processInboundMessage — fact-grounded drafts', () => {
  it('answers a price question only with verified Dealer Brain facts in the owning persona', async () => {
    const s = setup();
    contactedLead(s);
    const r = await inbound(s, '35L现在什么价？有什么优惠吗');
    assert.equal(r.duplicate, false);
    assert.ok(r.intents.includes('price_query'));
    assert.equal(r.lead.stage, 'REPLIED');
    const draft = r.reply_draft;
    assert.ok(draft, 'a draft is prepared');
    assert.equal(draft.status, 'draft');
    assert.equal(draft.provider_message_id, null);
    assert.match(draft.content, /^您好，我是销售小王～/);
    assert.match(draft.content, /eDrive35L指导价35\.39万/);
    assert.match(draft.content, /优惠9万/);
    assert.ok([...draft.content].length <= 300);
    assert.ok(draft.fact_refs.some((f) => f.kind === 'vehicle') && draft.fact_refs.some((f) => f.kind === 'offer'));
    const check = verifyClaims(s.ctx, s.hz, draft.content, draft.fact_refs);
    assert.equal(check.passed, true, check.issues.join('; '));
    assert.deepEqual(check.unverified_claims, []);
    const decision = s.ctx.db.table('agent_decisions').findOne({ decision_type: 'conversation_reply', subject_id: r.conversation.id });
    assert.ok(decision);
    assert.equal(decision.output.draft_message_id, draft.id);
    for (const e of decision.evidence) if (e.quote) assert.ok(r.message.content.includes(e.quote));
  });

  it('answers a 白外红内 35L inventory question from inventory rows', async () => {
    const s = setup();
    contactedLead(s);
    const r = await inbound(s, '白外红内的35L现在还有现车吗？');
    assert.ok(r.intents.includes('inventory_query'));
    assert.ok(r.reply_draft);
    assert.match(r.reply_draft.content, /宝马i3 eDrive35L 白外红内现车1台/);
    assert.ok(r.reply_draft.fact_refs.some((f) => f.kind === 'inventory' && f.claim === '白外红内现车1台'));
    assert.equal(verifyClaims(s.ctx, s.hz, r.reply_draft.content, r.reply_draft.fact_refs).passed, true);
  });

  it('never invents stock: an unavailable colour is answered honestly with alternatives from inventory', async () => {
    const s = setup();
    contactedLead(s);
    const r = await inbound(s, '35L有蓝色的现车吗');
    assert.ok(r.reply_draft);
    assert.match(r.reply_draft.content, /暂无/);
    assert.match(r.reply_draft.content, /现车/);
    assert.equal(verifyClaims(s.ctx, s.hz, r.reply_draft.content, r.reply_draft.fact_refs).passed, true);
  });

  it('parses colours from messages and stored intent', () => {
    assert.deepEqual(colourOfMessage('白外红内的还在吗'), { exterior: '白', interior: '红' });
    assert.deepEqual(colourOfMessage('外黑内棕有吗'), { exterior: '黑', interior: '棕' });
    assert.deepEqual(colourOfMessage('白色的有吗'), { exterior: '白' });
    assert.deepEqual(colourOfMessage('有现车吗', { intent: { color_intent: '白外红内' } }), { exterior: '白', interior: '红' });
  });
});

describe('processInboundMessage — funnel side effects', () => {
  it('"不需要，别再发了" suppresses the user globally, cancels other accounts\' pending outreach and drafts nothing', async () => {
    const s = setup();
    const { lead } = contactedLead(s);
    const released = seedAssignment(s.ctx, { lead_id: lead.id, account_id: s.li, active: false, released_at: s.ctx.clock.iso() });
    const pending = seedOutreach(s.ctx, { lead_id: lead.id, account_id: s.li, assignment_id: released.id, status: 'READY_FOR_REVIEW', kind: 'follow_up' });
    const r = await inbound(s, '不需要，别再发了');
    assert.ok(r.intents.includes('not_interested'));
    assert.equal(r.reply_draft, null);
    assert.ok(r.actions.includes('contact_suppressed'));
    assert.ok(isSuppressed(s.ctx, 'u-conv-1'));
    assert.equal(r.lead.stage, 'LOST');
    assert.equal(r.conversation.status, 'closed');
    assert.equal(s.ctx.db.table('outreach').require(pending.id).status, 'CANCELLED');
    const suppression = s.ctx.db.table('contact_suppressions').findOne({ platform_user_id: 'u-conv-1' });
    assert.match(suppression?.reason ?? '', /别再发了/);
    assert.equal(suppression?.source, `conversation:${r.conversation.id}`);

    // the user writes again later: stored for a human, never answered by the AI
    const again = await inbound(s, '35L多少钱', { received_at: '2026-09-12T03:00:00Z' });
    assert.equal(again.reply_draft, null);
    assert.equal(again.conversation.needs_human, true);
    assert.equal(again.conversation.handoff_reason, HANDOFF_REASONS.suppressed_inbound);
  });

  it('a voluntarily provided phone number → contact stored + CONTACT_ACQUIRED; our reply never repeats it', async () => {
    const s = setup();
    contactedLead(s);
    const r = await inbound(s, '我手机13800001234，方便的话打给我');
    assert.equal(r.lead.contact.phone, '13800001234');
    assert.equal(r.lead.contact.source_message_id, r.message.id);
    assert.equal(r.lead.stage, 'CONTACT_ACQUIRED');
    assert.ok(r.actions.includes('contact_acquired'));
    if (r.reply_draft) assert.doesNotMatch(r.reply_draft.content, /13800001234/);
  });

  it('"这周六下午去店里看看" → appointment resolved in Asia/Shanghai, APPOINTMENT stage, store address in the draft', async () => {
    const s = setup();
    contactedLead(s);
    const r = await inbound(s, '这周六下午去店里看看');
    assert.ok(r.intents.includes('appointment'));
    const appt = s.ctx.db.table('appointments').findOne({ lead_id: r.lead.id });
    assert.ok(appt);
    // TEST_NOW is Saturday 10:00 Shanghai → this Saturday 14:00 local = 06:00Z
    assert.equal(appt.scheduled_for, '2026-09-12T06:00:00.000Z');
    assert.equal(appt.conversation_id, r.conversation.id);
    assert.equal(appt.vehicle_interest, 'BMW i3 eDrive35L');
    assert.equal(r.lead.stage, 'APPOINTMENT');
    assert.ok(r.reply_draft);
    assert.match(r.reply_draft.content, /文三西路888号/);
    assert.doesNotMatch(r.reply_draft.content, /0571/);
  });

  it('phone + appointment in one message reaches APPOINTMENT and is sales qualified', async () => {
    const s = setup();
    contactedLead(s);
    const r = await inbound(s, '好的，这周六下午可以过去看车，我电话13800001234');
    assert.equal(r.lead.contact.phone, '13800001234');
    assert.equal(r.lead.stage, 'APPOINTMENT');
    assert.ok(r.actions.includes('sales_qualified'));
  });

  it('duplicate provider message ids are idempotent', async () => {
    const s = setup();
    contactedLead(s);
    const a = await inbound(s, '有现车吗', { provider_message_id: 'pm-1', source: 'provider' });
    const b = await inbound(s, '有现车吗', { provider_message_id: 'pm-1', source: 'provider' });
    assert.equal(b.duplicate, true);
    assert.equal(b.message.id, a.message.id);
    assert.equal(s.ctx.db.table('conversation_messages').count({ direction: 'inbound' }), 1);
    const manual = await inbound(s, '有现车吗');
    assert.equal(manual.duplicate, true, 'the same text typed in again within two minutes is not stored twice');
  });

  it('a reply reaching a non-owner account is handed to a human', async () => {
    const s = setup();
    contactedLead(s);
    const r = await inbound(s, '35L多少钱', { account_id: s.li });
    assert.equal(r.reply_draft, null);
    assert.equal(r.conversation.needs_human, true);
    assert.equal(r.conversation.handoff_reason, HANDOFF_REASONS.non_owner);
    assert.equal(r.conversation.account_id, s.li);
  });

  it('bargaining and the AI turn limit hand off to a human', async () => {
    const s = setup();
    const { lead } = contactedLead(s);
    const bargain = await inbound(s, '底价多少？能不能再便宜点');
    assert.equal(bargain.reply_draft, null);
    assert.equal(bargain.conversation.handoff_reason, HANDOFF_REASONS.negotiation);

    const conv = s.ctx.db.table('conversations').findOne({ lead_id: lead.id, account_id: s.wang })!;
    s.ctx.db.table('conversations').update(conv.id, { ai_turns: 6, needs_human: false, handoff_reason: null, status: 'open' });
    const limited = await inbound(s, '有现车吗', { received_at: '2026-09-12T02:30:00Z' });
    assert.equal(limited.reply_draft, null);
    assert.match(limited.conversation.handoff_reason ?? '', /轮次上限/);
  });

  it('a first message from an unknown user creates a lead and a clarifying draft', async () => {
    const s = setup();
    const r = await processInboundMessage(s.ctx, { account_id: s.wang, platform_user_id: 'u-new-dm', username: '新朋友', content: '你好', source: 'manual' });
    assert.ok(r.actions.includes('lead_created'));
    assert.equal(r.lead.username, '新朋友');
    assert.ok(r.reply_draft);
    assert.match(r.reply_draft.content, /哪款车型/);
    assert.equal(s.ctx.db.table('lead_signals').count({ lead_id: r.lead.id, source_type: 'reply' }), 1);
  });

  it('refuses messages "from" our own managed accounts', async () => {
    const s = setup();
    await assert.rejects(
      processInboundMessage(s.ctx, { account_id: s.wang, platform_user_id: 'xhs-hz-official', content: '你好', source: 'manual' }),
      policyCode('managed_account_identity'),
    );
  });
});

describe('human review path', () => {
  it('approve (no send capability) keeps a draft for manual sending; edits are re-verified; manual send records sent_by', async () => {
    const s = setup();
    contactedLead(s);
    const r = await inbound(s, '35L现在什么价？');
    const draft = r.reply_draft!;
    await assert.rejects(approveReply(s.ctx, draft.id, 'operator:wang', `${draft.content}再额外优惠20万`), policyCode('reply_verification_failed'));
    await assert.rejects(approveReply(s.ctx, draft.id, 'operator:wang', '您好，加我微信 wxid_abc12345 细聊'), policyCode('reply_verification_failed'));
    const approved = await approveReply(s.ctx, draft.id, 'operator:wang');
    assert.equal(approved.status, 'draft');
    const event = s.ctx.db.table('audit_events').findOne({ action: 'reply.approved', entity_id: draft.id });
    assert.equal(event?.details.manual_send_required, true);

    const sent = markReplySentManually(s.ctx, draft.id, 'operator:wang');
    assert.equal(sent.status, 'sent_manually');
    assert.equal(sent.sent_by, 'operator:wang');
    assert.equal(sent.provider_message_id, null);
    assert.equal(s.ctx.db.table('conversations').require(r.conversation.id).ai_turns, 1);
    assert.throws(() => markReplySentManually(s.ctx, draft.id, 'operator:wang'), policyCode('reply_not_pending'));
  });

  it('manual send is refused once the user is on the do-not-contact list', async () => {
    const s = setup();
    contactedLead(s);
    const r = await inbound(s, '35L现在什么价？');
    seedSuppression(s.ctx, 'u-conv-1');
    assert.throws(() => markReplySentManually(s.ctx, r.reply_draft!.id, 'operator:wang'), policyCode('contact_suppressed'));
  });

  it('approve with a provider that can send → sent only with the provider-confirmed id', async () => {
    const s = setup();
    s.ctx.xhs = SimulationXhsProvider.fromFile(s.ctx.clock, undefined, { send_messages: true, account_platform_ids: s.internalToPlatform });
    contactedLead(s);
    const r = await inbound(s, '35L现在什么价？');
    const sent = await approveReply(s.ctx, r.reply_draft!.id, 'operator:wang');
    assert.equal(sent.status, 'sent');
    assert.match(sent.provider_message_id ?? '', /^sim-msg-/);
    assert.equal(s.ctx.db.table('conversations').require(r.conversation.id).ai_turns, 1);
  });

  it('AUTO policy + AVAILABLE send capability sends automatically; REVIEW_REQUIRED never does', async () => {
    const s = setup();
    s.ctx.xhs = SimulationXhsProvider.fromFile(s.ctx.clock, undefined, { send_messages: true, account_platform_ids: s.internalToPlatform });
    contactedLead(s);
    const review = await inbound(s, '35L现在什么价？');
    assert.equal(review.reply_draft?.status, 'draft');

    const dealer = s.ctx.db.table('dealers').require(s.hz);
    s.ctx.db.table('dealers').update(s.hz, { settings: { ...dealer.settings, outreach_approval_policy: 'AUTO' } });
    const auto = await inbound(s, '白外红内的还有现车吗', { received_at: '2026-09-12T02:10:00Z' });
    assert.equal(auto.reply_draft?.status, 'sent');
    assert.ok(auto.actions.includes('reply_sent'));
  });
});

describe('pollInbox', () => {
  it('reports the unavailable capability honestly', async () => {
    const s = setup();
    const res = await pollInbox(s.ctx, s.wang);
    assert.equal(res.status, 'UNAVAILABLE');
    assert.equal(res.processed, 0);
    assert.ok(res.reason.length > 0);
    assert.equal(s.ctx.db.table('conversation_messages').count({}), 0);
  });

  it('processes the scripted simulation inbox once, in order, without duplicates', async () => {
    const s = setup();
    const sim = SimulationXhsProvider.fromFile(s.ctx.clock, undefined, { receive_messages: true, account_platform_ids: s.internalToPlatform });
    s.ctx.xhs = sim;
    sim.recordManualContact(s.wang, 'u-hz-buyer-002');
    s.ctx.clock.advance({ minutes: 31 });
    const first = await pollInbox(s.ctx, s.wang);
    assert.equal(first.status, 'AVAILABLE');
    assert.equal(first.processed, 1);
    const lead = s.ctx.db.table('leads').findOne({ platform_user_id: 'u-hz-buyer-002' });
    assert.ok(lead);
    const draft = s.ctx.db.table('conversation_messages').findOne({ direction: 'outbound', status: 'draft' });
    assert.match(draft?.content ?? '', /白外红内现车1台/);

    s.ctx.clock.advance({ minutes: 60 });
    const second = await pollInbox(s.ctx, s.wang);
    assert.equal(second.processed, 1);
    const fresh = s.ctx.db.table('leads').require(lead.id);
    assert.equal(fresh.contact.phone, '13800001234');
    assert.equal(fresh.stage, 'APPOINTMENT');
    assert.equal((await pollInbox(s.ctx, s.wang)).processed, 0);
    assert.equal(s.ctx.db.table('conversation_messages').count({ direction: 'inbound' }), 2);
  });
});

describe('ingestJuguangLeads', () => {
  it('creates and updates leads with voluntarily provided contact; skips suppressed users; rejects records without identity', () => {
    const s = setup();
    const first = parseJuguangLeadPush({ 小红书号: 'red-777', 用户昵称: '想买X3的李先生', 城市: '杭州', 电话: '13900001111', 备注: '想看X3 25L，预算40万左右' });
    const a = ingestJuguangLeads(s.ctx, first, { dealer_id: s.hz, actor: 'system:juguang-webhook' });
    assert.equal(a.created.length, 1);
    const lead = s.ctx.db.table('leads').require(a.created[0]);
    assert.equal(lead.contact.phone, '13900001111');
    assert.equal(lead.stage, 'CONTACT_ACQUIRED');
    assert.equal(lead.intent.location, '杭州');
    assert.equal(lead.username, '想买X3的李先生');

    const second = parseJuguangLeadPush({ 小红书号: 'red-777', 微信: 'lixiansheng_x3' });
    const b = ingestJuguangLeads(s.ctx, second, { dealer_id: s.hz, actor: 'system:juguang-webhook' });
    assert.deepEqual(b.updated, [lead.id]);
    const updated = s.ctx.db.table('leads').require(lead.id);
    assert.equal(updated.contact.wechat, 'lixiansheng_x3');
    assert.equal(updated.contact.phone, '13900001111');

    seedSuppression(s.ctx, 'red-888');
    const c = ingestJuguangLeads(s.ctx, parseJuguangLeadPush({ 小红书号: 'red-888', 电话: '13900002222' }), { dealer_id: s.hz, actor: 'system:juguang-webhook' });
    assert.deepEqual(c.suppressed_skipped, ['red-888']);
    assert.equal(s.ctx.db.table('leads').count({ platform_user_id: 'red-888' }), 0);

    const noIdentity = { ...first[0], platform_user_id: null, red_id: null };
    const d = ingestJuguangLeads(s.ctx, [noIdentity], { dealer_id: s.hz, actor: 'system:juguang-webhook' });
    assert.equal(d.rejected.length, 1);
    assert.equal(s.ctx.db.table('audit_events').count({ action: 'lead.juguang_imported' }), 2);
  });
});

describe('listConversations & skill', () => {
  it('lists needs-human conversations first with their pending draft', async () => {
    const s = setup();
    contactedLead(s);
    const drafted = await inbound(s, '35L现在什么价？');
    const handed = await inbound(s, '35L多少钱', { account_id: s.li });
    const rows = listConversations(s.ctx, { dealer_id: s.hz });
    assert.equal(rows[0].conversation.id, handed.conversation.id);
    const row = rows.find((x) => x.conversation.id === drafted.conversation.id);
    assert.equal(row?.pending_draft?.id, drafted.reply_draft?.id);
    assert.equal(listConversations(s.ctx, { dealer_id: s.hz, needs_human: true }).length, 1);
  });

  it('skill wrapper processes an inbound message', async () => {
    const s = setup();
    contactedLead(s);
    assert.equal(skill.name, 'conversation');
    assert.equal(skill.agent, 'conversation-agent');
    const out = (await skill.run(s.ctx, skill.input({ action: 'process_inbound', account_id: s.wang, platform_user_id: 'u-conv-1', content: '有现车吗' }))) as { reply_draft: unknown };
    assert.ok(out.reply_draft);
  });
});
