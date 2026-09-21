/**
 * Conversation agent (spec §13, ARCHITECTURE §6 / §8 C3 / §10.4).
 *
 * processInboundMessage  a user's DM reply (from the provider inbox, or typed in by a salesperson who received it in
 *                        the Xiaohongshu app) → conversation + message, lead signal, funnel stage, global do-not-contact,
 *                        voluntarily provided contact, appointment, sales qualification and a FACT-GROUNDED reply draft.
 * approveReply / markReplySentManually  the human review path. A reply is `sent` ONLY with a provider-confirmed id;
 *                        when the provider cannot send DMs (Xiaohongshu has no authorized DM API) a human sends it in the
 *                        app and records `sent_manually` with `sent_by`.
 * pollInbox              honest inbox polling: UNAVAILABLE / REQUIRES_AUTH are reported, never simulated.
 * ingestJuguangLeads     聚光「私信API对接」lead records (voluntarily provided contact) → CRM leads.
 *
 * Reply drafts contain dealer facts ONLY from Dealer Brain (`answerFact`) with FactRefs, are re-verified with
 * `verifyClaims` and platform rules (no phone / WeChat / links in DMs), and are discarded — with a human hand-off —
 * when verification fails. AI turns are capped by `max_ai_conversation_turns`.
 */
import type { AppContext } from '../../../app/context.ts';
import { AppError, NotFoundError, PolicyError, ValidationError } from '../../../core/errors.ts';
import { newId } from '../../../core/ids.ts';
import { normalizeText, truncate } from '../../../core/text.ts';
import type {
  AccountPersona,
  Appointment,
  AccountType,
  CapabilityStatus,
  Conversation,
  ConversationIntent,
  ConversationMessage,
  ConversationSlots,
  Dealer,
  Evidence,
  FactRef,
  IntentDetection,
  Lead,
  LeadStage,
  ScoreTier,
  XhsAccount,
} from '../../../core/types.ts';
import { v, type Infer } from '../../../core/validate.ts';
import { CITY_PROVINCE } from '../../../domain/automotive-lexicon.ts';
import type { JuguangLead } from '../../../providers/xhs/juguang-webhook.ts';
import { getActiveAssignment } from '../../acquisition/account-assignment/index.ts';
import { detectIntentRules } from '../../acquisition/intent-detection/nlu.ts';
import { findLeadByIdentity, upsertLeadFromSignal } from '../../acquisition/lead-deduplication/index.ts';
import { parseColorIntent } from '../../acquisition/lead-scoring/index.ts';
import { effectiveOutreachPolicy, ensurePersona, requireAccount } from '../../operations/account-brain/index.ts';
import { isAccountOperable } from '../../operations/account-health/index.ts';
import { DEFAULT_MAX_LENGTH, checkPlatformRules } from '../../operations/compliance/index.ts';
import { isSuppressed, isTerminalStage, refreshNextAction, suppressContact, transitionLead } from '../../operations/crm/index.ts';
import {
  answerFact,
  getDealer,
  getDealerProfile,
  getProhibitedClaims,
  verifyClaims,
  type FactQuestionKind,
} from '../../operations/dealer-brain/index.ts';
import { matchVehicle, vehicleFaqAnswer } from '../../operations/vehicle-brain/index.ts';
import { applyVoicePronoun, getAccountVoice } from '../../content/account-voice/index.ts';
import { defineSkill } from '../../registry.ts';
import { getActiveAppointment, upsertAppointment, vehicleInterestFor } from '../appointment/index.ts';
import { qualifyLead } from '../qualification/index.ts';
import { analyzeConversationMessage, detectContactInfo, extractSlots } from './nlu.ts';

export const CONVERSATION_AGENT = 'conversation-agent';
const AGENT_ACTOR = `agent:${CONVERSATION_AGENT}`;
const SKILL = 'conversation';
const PLATFORM = 'xiaohongshu' as const;
export const DM_MAX_LENGTH = DEFAULT_MAX_LENGTH.dm;
/** Same content typed in twice within this window is treated as one inbound message (manual entry). */
export const MANUAL_DUPLICATE_WINDOW_MS = 120_000;

export const HANDOFF_REASONS = {
  non_owner: '非负责账号收到回复',
  negotiation: '价格谈判/投诉，需要销售人工跟进',
  turn_limit: 'AI对话已达轮次上限，转人工',
  closed_lead: '线索已关闭，需人工判断是否继续沟通',
  suppressed_inbound: '勿扰用户主动来信，需人工判断是否回复',
  verification_failed: '自动回复草稿未通过事实/合规校验',
} as const;

/** Bargaining, complaints and disputes are never handled by the AI. */
const NEGOTIATION_RE =
  /砍价|再便宜|便宜点|能便宜|最低价|最低多少|底价|能不能少|少点|让点|包牌|送.{0,4}(?:膜|保养|装潢|脚垫)|投诉|差评|退定|退订金|退定金|退款|纠纷|律师|12315|骗子|欺骗|坑人|举报/;

export interface InboundMessageInput {
  account_id: string;
  platform_user_id: string;
  username?: string | null;
  content: string;
  received_at?: string;
  provider_message_id?: string | null;
  source: 'provider' | 'manual';
  /** additive: who entered a manual message (default operator:console for manual, agent:conversation-agent for provider) */
  actor?: string;
}

export interface InboundResult {
  conversation: Conversation;
  message: ConversationMessage;
  lead: Lead;
  intents: ConversationIntent[];
  slots: ConversationSlots;
  reply_draft: ConversationMessage | null;
  actions: string[];
  duplicate: boolean;
}

const inboundValidator = v.object({
  account_id: v.string({ min: 1, max: 200 }),
  platform_user_id: v.string({ min: 1, max: 200 }),
  username: v.optional(v.nullable(v.string({ max: 200 }))),
  content: v.string({ min: 1, max: 5000 }),
  received_at: v.optional(v.string({ min: 1 })),
  provider_message_id: v.optional(v.nullable(v.string({ min: 1, max: 300 }))),
  source: v.literal(['provider', 'manual'] as const),
  actor: v.optional(v.string({ min: 1, max: 200 })),
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function requireText(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(path, 'expected non-empty string');
  return value.trim();
}

function toIso(value: string | undefined, path: string): string | null {
  if (value === undefined) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new ValidationError(path, `invalid timestamp ${JSON.stringify(value)}`);
  return new Date(t).toISOString();
}

const later = (a: string, b: string): string => (Date.parse(b) > Date.parse(a) ? b : a);

function leadSuppressed(ctx: AppContext, lead: Lead): boolean {
  return lead.suppressed || isSuppressed(ctx, lead.platform_user_id, lead.platform) !== null;
}

function requireLead(ctx: AppContext, leadId: string): Lead {
  const lead = ctx.db.table('leads').get(leadId);
  if (!lead) throw new NotFoundError('lead', leadId);
  return lead;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

function managedAccountFor(ctx: AppContext, groupId: string, platformUserId: string): XhsAccount | undefined {
  return (
    ctx.db.table('xhs_accounts').findOne({ group_id: groupId, platform_account_id: platformUserId }) ??
    ctx.db.table('xhs_accounts').findOne({ group_id: groupId, platform_user_id: platformUserId })
  );
}

/** Transition that tolerates the funnel's "already passed" no-ops and a concurrent do-not-contact refusal. */
function advance(ctx: AppContext, lead: Lead, to: LeadStage, reason: string, actor: string, actions: string[]): void {
  if (isTerminalStage(lead.stage) || leadSuppressed(ctx, lead)) return;
  try {
    const res = transitionLead(ctx, lead.id, to, { reason, actor });
    if (res.changed) actions.push(`stage:${to}`);
  } catch (err) {
    if (err instanceof PolicyError && (err.code === 'contact_suppressed' || err.code === 'invalid_transition')) return;
    throw err;
  }
}

// ── colours asked in a message ('白外红内', '外白内红', '白色的') ─────────────────────

const C_EXT = '[白黑灰蓝红棕银绿金紫橙黄青米咖]';
const C_INT = '[白黑灰蓝红棕米咖驼]';
const COLOR_COMBO_RE = new RegExp(`(${C_EXT})色?(?:外观|外饰|车身|外)[ +/、,和配]?(${C_INT})色?(?:内饰|内)`, 'u');
const COLOR_COMBO_REVERSED_RE = new RegExp(`(?:外观|外饰|车身|外)(${C_EXT})色?[ +/、,和配]?(?:内饰|内)(${C_INT})`, 'u');
const COLOR_SINGLE_RE = new RegExp(`(${C_EXT})色(?!调|系)`, 'u');

export function colourOfMessage(content: string, lead?: Pick<Lead, 'intent'>): { exterior?: string; interior?: string } {
  const text = content.normalize('NFKC');
  const combo = COLOR_COMBO_RE.exec(text) ?? COLOR_COMBO_REVERSED_RE.exec(text);
  if (combo) return { exterior: combo[1], interior: combo[2] };
  const single = COLOR_SINGLE_RE.exec(text);
  if (single) return { exterior: single[1] };
  const stored = lead?.intent?.color_intent;
  if (stored) {
    const spec = parseColorIntent(stored);
    if (spec.exterior || spec.interior) return spec;
  }
  return {};
}

// ── reply composition ────────────────────────────────────────────────────────

const FACT_KIND_BY_INTENT: readonly [ConversationIntent, FactQuestionKind][] = [
  ['inventory_query', 'inventory'],
  ['price_query', 'price'],
  ['finance_query', 'finance'],
  ['lease_query', 'lease'],
  ['trade_in', 'trade_in'],
  ['model_comparison', 'highlights'],
];

const FACT_KIND_LABELS: Record<string, string> = {
  inventory: '现车情况',
  price: '价格与优惠',
  finance: '贷款方案',
  lease: '租赁方案',
  trade_in: '置换政策',
  highlights: '车型亮点',
  store: '门店地址',
  vehicle_faq: '车型资料',
};

function greetingFor(account: XhsAccount, persona: AccountPersona): string {
  const type: AccountType = account.account_type;
  switch (type) {
    case 'salesperson':
      return `您好，我是${persona.persona_name || account.salesperson_name || account.nickname}～`;
    case 'local_guide':
      return `你好呀，这里是${account.nickname}～`;
    case 'model_specialist':
      return `您好，这里是${account.nickname}。`;
    default:
      return `您好，这里是${account.nickname}～`;
  }
}

export interface ReplyPlan {
  text: string;
  facts: FactRef[];
  /** fact kinds included in the reply */
  answered: string[];
  /** fact kinds left out because the DM length limit was reached */
  skipped: string[];
}

interface ComposeInput {
  dealer: Dealer;
  account: XhsAccount;
  persona: AccountPersona;
  lead: Lead;
  slots: ConversationSlots;
  intents: ConversationIntent[];
  content: string;
  appointment: Appointment | null;
  appointment_requested: boolean;
  contact_acquired: boolean;
  first_inbound: boolean;
}

/**
 * Build a reply from Dealer Brain answers only. Returns null when the message needs no reply (e.g. a plain "好的"
 * in an ongoing conversation).
 */
export function composeReply(ctx: AppContext, p: ComposeInput): ReplyPlan | null {
  const model = p.slots.model ?? p.lead.intent.model;
  const trim = p.slots.model ? p.slots.trim : (p.slots.trim ?? p.lead.intent.trim);
  const colour = colourOfMessage(p.content, p.lead);
  const segments: { kind: string; text: string; facts: FactRef[] }[] = [];
  const seenText = new Set<string>();
  const push = (kind: string, text: string, facts: FactRef[]) => {
    const key = normalizeText(text);
    if (!text.trim() || seenText.has(key)) return;
    seenText.add(key);
    segments.push({ kind, text, facts });
  };

  for (const [intent, kind] of FACT_KIND_BY_INTENT) {
    if (!p.intents.includes(intent)) continue;
    const question = {
      kind,
      ...(model ? { model } : {}),
      ...(trim ? { trim } : {}),
      ...(kind === 'inventory' && colour.exterior ? { exterior_color: colour.exterior } : {}),
      ...(kind === 'inventory' && colour.interior ? { interior_color: colour.interior } : {}),
    };
    const answer = answerFact(ctx, p.dealer.id, question);
    push(kind, answer.text, answer.facts);
    if (kind === 'inventory' && !answer.found && (colour.exterior || colour.interior) && (model || trim)) {
      const alternatives = answerFact(ctx, p.dealer.id, { kind: 'inventory', ...(model ? { model } : {}), ...(trim ? { trim } : {}) });
      if (alternatives.found) push('inventory', alternatives.text, alternatives.facts);
    }
  }

  // 车型库 (RAG): a question the fact kinds do not cover — charging, warranty, space, servicing — may still have an
  // answer on the matched vehicle card. That text was verified against the store's own data when it was written.
  if (segments.length === 0) {
    const card = matchVehicle(ctx, p.dealer.id, { model: model ?? undefined, trim: trim ?? undefined, text: p.content });
    const faq = card ? vehicleFaqAnswer(card, p.content) : null;
    if (card && faq) push('vehicle_faq', faq.faq.answer, card.fact_refs.filter((r) => r.kind === 'vehicle'));
  }

  if (p.appointment_requested || p.appointment) {
    const parts: string[] = [];
    const facts: FactRef[] = [];
    if (p.dealer.address.trim()) {
      parts.push(`门店地址：${p.dealer.address}`);
      facts.push({ kind: 'dealer', id: p.dealer.id, claim: p.dealer.address });
    }
    if (p.dealer.business_hours.trim()) {
      parts.push(`营业时间：${p.dealer.business_hours}`);
      facts.push({ kind: 'dealer', id: p.dealer.id, claim: p.dealer.business_hours });
    }
    if (parts.length > 0) push('store', `${parts.join('，')}。`, facts);
  }

  const greeting = greetingFor(p.account, p.persona);
  const closings: string[] = [];
  if (p.appointment_requested || p.appointment) {
    const when = p.appointment?.time_text ?? p.slots.appointment_time_text ?? null;
    // times with digits could read as unverifiable date claims; they are confirmed by a human instead
    closings.push(
      when && !/[0-9０-９]/.test(when)
        ? `${when}到店的话我们会提前为您安排接待，出发前可以再和我确认一下～`
        : '到店时间我们再和您确认一下，提前为您安排接待～',
    );
  }
  if (p.contact_acquired) closings.push('收到您的联系方式，销售顾问会尽快与您联系～');

  if (segments.length === 0 && closings.length === 0) {
    if (!p.first_inbound) return null;
    const text = applyVoicePronoun(`${greeting}请问您想了解哪款车型？预算和计划购车时间方便说一下吗？我按门店资料帮您核实～`, getAccountVoice(ctx, p.account.id));
    return { text, facts: [], answered: [], skipped: [] };
  }

  const included: typeof segments = [];
  const skipped: string[] = [];
  const fallbackClosing = '还有其他想了解的随时问我～';
  const lengthOf = (segs: typeof segments, closing: string[]) =>
    [...greeting].length + segs.reduce((n, s) => n + [...s.text].length, 0) + closing.reduce((n, c) => n + [...c].length, 0);
  for (const seg of segments) {
    const reserve = skipped.length > 0 || included.length + 1 < segments.length ? ['其余细节我整理后再单独发您～'] : [];
    if (lengthOf([...included, seg], [...closings, ...reserve]) <= DM_MAX_LENGTH) included.push(seg);
    else skipped.push(seg.kind);
  }
  const closing = [...closings];
  if (skipped.length > 0) {
    const labels = [...new Set(skipped.map((k) => FACT_KIND_LABELS[k] ?? k))].join('、');
    const line = `${labels}我整理后再单独发您～`;
    if (lengthOf(included, [...closing, line]) <= DM_MAX_LENGTH) closing.push(line);
  } else if (closing.length === 0 && lengthOf(included, [fallbackClosing]) <= DM_MAX_LENGTH) {
    closing.push(fallbackClosing);
  }
  // 账号语言风格: say 你 or 您 the way this account itself says it (only when its own notes settle the question).
  const text = applyVoicePronoun(`${greeting}${included.map((s) => s.text).join('')}${closing.join('')}`, getAccountVoice(ctx, p.account.id));
  const facts = new Map<string, FactRef>();
  for (const s of included) for (const f of s.facts) facts.set(`${f.kind}:${f.id}:${f.claim}`, f);
  return { text, facts: [...facts.values()], answered: [...new Set(included.map((s) => s.kind))], skipped: [...new Set(skipped)] };
}

export interface ReplyCheck {
  passed: boolean;
  issues: string[];
}

/** Dealer-fact verification + DM platform rules for a customer-facing reply. */
export function checkReply(ctx: AppContext, dealerId: string, text: string, facts: FactRef[]): ReplyCheck {
  const claims = verifyClaims(ctx, dealerId, text, facts);
  const rules = checkPlatformRules(text, { prohibited: getProhibitedClaims(ctx, dealerId), max_length: DM_MAX_LENGTH, channel: 'dm' });
  const issues = [...claims.issues, ...rules.issues.map((i) => (i.quote ? `${i.message}（“${i.quote}”）` : i.message))];
  return { passed: claims.passed && rules.passed, issues };
}

/** Blocking checks before any reply leaves the system (auto, approved or recorded as sent by hand). */
function guardReply(ctx: AppContext, p: { lead: Lead; account: XhsAccount; text: string; facts: FactRef[] }): void {
  if (leadSuppressed(ctx, p.lead))
    throw new PolicyError('contact_suppressed', '该用户已在勿扰名单中，不能再发送任何消息', { lead_id: p.lead.id });
  const assignment = getActiveAssignment(ctx, p.lead.id);
  if (assignment && assignment.account_id !== p.account.id)
    throw new PolicyError('not_owner', '只有线索的负责账号可以回复该客户', { lead_id: p.lead.id, owner_account_id: assignment.account_id });
  const operable = isAccountOperable(ctx, p.account.id);
  if (!operable.ok && operable.blocking) throw new PolicyError('account_blocked', operable.reason, { account_id: p.account.id });
  const check = checkReply(ctx, p.lead.dealer_id, p.text, p.facts);
  if (!check.passed)
    throw new PolicyError('reply_verification_failed', `回复未通过事实/合规校验：${check.issues.join('；')}`, { issues: check.issues });
}

/** Persist a provider-confirmed send. */
function finalizeSent(ctx: AppContext, message: ConversationMessage, providerMessageId: string, actor: string): ConversationMessage {
  return ctx.db.tx(() => {
    const updated = ctx.db.table('conversation_messages').update(message.id, { status: 'sent', provider_message_id: providerMessageId });
    const conv = ctx.db.table('conversations').require(message.conversation_id);
    ctx.db.table('conversations').update(conv.id, { ai_turns: conv.ai_turns + 1, last_message_at: later(conv.last_message_at, ctx.clock.iso()) });
    ctx.audit.event({
      actor,
      action: 'reply.sent',
      entity_type: 'conversation_message',
      entity_id: message.id,
      details: { conversation_id: conv.id, provider_message_id: providerMessageId },
    });
    refreshNextAction(ctx, conv.lead_id);
    return updated;
  });
}

async function trySend(
  ctx: AppContext,
  message: ConversationMessage,
  lead: Lead,
  account: XhsAccount,
  actor: string,
): Promise<{ sent: ConversationMessage | null; status: CapabilityStatus; reason: string }> {
  const report = await ctx.xhs.capabilities(account.id);
  const cap = report.capabilities.send_messages;
  if (cap.status !== 'AVAILABLE') return { sent: null, status: cap.status, reason: cap.reason };
  if (leadSuppressed(ctx, requireLead(ctx, lead.id))) return { sent: null, status: 'UNAVAILABLE', reason: 'contact suppressed before sending' };
  const res = await ctx.xhs.sendMessage(account.id, lead.platform_user_id, message.content);
  if (!res.ok) {
    ctx.audit.event({
      actor,
      action: 'reply.send_failed',
      entity_type: 'conversation_message',
      entity_id: message.id,
      details: { status: res.status, reason: res.reason, retryable: res.retryable ?? false },
    });
    return { sent: null, status: res.status, reason: res.reason };
  }
  return { sent: finalizeSent(ctx, message, res.data.provider_message_id, actor), status: 'AVAILABLE', reason: 'provider confirmed' };
}

function duplicateResult(ctx: AppContext, message: ConversationMessage): InboundResult {
  const conversation = ctx.db.table('conversations').require(message.conversation_id);
  return {
    conversation,
    message,
    lead: requireLead(ctx, conversation.lead_id),
    intents: message.intents,
    slots: conversation.slots,
    reply_draft: null,
    actions: ['duplicate_ignored'],
    duplicate: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbound processing
// ─────────────────────────────────────────────────────────────────────────────

export async function processInboundMessage(ctx: AppContext, rawInput: InboundMessageInput): Promise<InboundResult> {
  const input = inboundValidator(rawInput, 'input');
  const content = input.content.trim();
  if (!content) throw new ValidationError('input.content', 'expected non-empty text');
  const account = requireAccount(ctx, input.account_id);
  const dealer = getDealer(ctx, account.dealer_id);
  const tz = dealer.settings.timezone;
  const actor = input.actor ?? (input.source === 'manual' ? 'operator:console' : AGENT_ACTOR);
  // a provider clock slightly ahead of ours must not drop the message: future timestamps are clamped to now
  const statedAt = toIso(input.received_at, 'input.received_at');
  const receivedAt = statedAt && Date.parse(statedAt) <= ctx.clock.now().getTime() ? statedAt : ctx.clock.iso();
  const providerMessageId = input.provider_message_id ?? null;
  const messages = ctx.db.table('conversation_messages');
  const conversations = ctx.db.table('conversations');

  if (providerMessageId) {
    const dup = messages.findOne({ provider_message_id: providerMessageId });
    if (dup) return duplicateResult(ctx, dup);
  }
  const managed = managedAccountFor(ctx, account.group_id, input.platform_user_id);
  if (managed)
    throw new PolicyError('managed_account_identity', 'the sender is one of our own managed Xiaohongshu accounts', {
      platform_user_id: input.platform_user_id,
      account_id: managed.id,
    });

  const existingLead = findLeadByIdentity(ctx, account.group_id, input.platform_user_id);
  if (existingLead && !providerMessageId) {
    const conv = conversations.findOne({ lead_id: existingLead.id, account_id: account.id });
    if (conv) {
      const key = normalizeText(content);
      const t = Date.parse(receivedAt);
      const recent = messages
        .findMany({ conversation_id: conv.id, direction: 'inbound' }, { orderBy: 'created_at DESC', limit: 20 })
        .find((m) => normalizeText(m.content) === key && Math.abs(Date.parse(m.created_at) - t) <= MANUAL_DUPLICATE_WINDOW_MS);
      if (recent) return duplicateResult(ctx, recent);
    }
  }

  // 1. lead identity + reply signal (merges intent, re-scores; creates a lead for a new user who wrote to us)
  const profile = getDealerProfile(ctx, dealer.id);
  const detection = detectIntentRules(content, { source_type: 'reply', author_nickname: input.username ?? null }, profile);
  const upsert = upsertLeadFromSignal(ctx, {
    dealer_id: existingLead?.dealer_id ?? dealer.id,
    identity: {
      platform_user_id: input.platform_user_id,
      username: input.username?.trim() || existingLead?.username || input.platform_user_id,
    },
    signal: { source_type: 'reply', content, signal_at: receivedAt, detection },
  });
  let lead = upsert.lead;
  const actions: string[] = [];
  if (upsert.created) actions.push('lead_created');
  const suppressedBefore = leadSuppressed(ctx, lead);
  const assignment = getActiveAssignment(ctx, lead.id);
  const ownedByOther = !!assignment && assignment.account_id !== account.id;

  // 2. conversation + inbound message
  const existingConv = conversations.findOne({ lead_id: lead.id, account_id: account.id });
  const firstInbound = !existingConv || messages.count({ conversation_id: existingConv.id, direction: 'inbound' }) === 0;
  const nluOpts = { now: new Date(receivedAt), tz, carried_models: profile.models };
  const analysis = analyzeConversationMessage(content, { ...nluOpts, previous: existingConv?.slots ?? {} });
  const extracted = extractSlots(content, nluOpts);
  const intents = analysis.intents;
  const now = ctx.clock.iso();

  let persisted: { conversation: Conversation; message: ConversationMessage };
  try {
    persisted = ctx.db.tx(() => {
      let conversation =
        conversations.findOne({ lead_id: lead.id, account_id: account.id }) ??
        conversations.insert({
          id: newId('conv'),
          lead_id: lead.id,
          account_id: account.id,
          status: 'open',
          slots: {},
          ai_turns: 0,
          needs_human: false,
          handoff_reason: null,
          last_message_at: receivedAt,
          created_at: now,
          updated_at: now,
        });
      const message = messages.insert({
        id: newId('msg'),
        conversation_id: conversation.id,
        direction: 'inbound',
        content,
        intents,
        extracted,
        status: 'received',
        fact_refs: [],
        provider_message_id: providerMessageId,
        engine: 'rules',
        created_at: receivedAt,
      });
      conversation = conversations.update(conversation.id, {
        slots: analysis.slots,
        last_message_at: later(conversation.last_message_at, receivedAt),
      });
      ctx.audit.event({
        actor,
        action: 'conversation.message_received',
        entity_type: 'conversation_message',
        entity_id: message.id,
        details: {
          conversation_id: conversation.id,
          lead_id: lead.id,
          account_id: account.id,
          source: input.source,
          provider_message_id: providerMessageId,
          intents,
        },
      });
      return { conversation, message };
    });
  } catch (err) {
    if (providerMessageId && isUniqueViolation(err)) {
      const dup = messages.findOne({ provider_message_id: providerMessageId });
      if (dup) return duplicateResult(ctx, dup);
    }
    throw err;
  }
  const { message } = persisted;
  let conversation = persisted.conversation;
  const setHandoff = (reason: string) => {
    conversation = conversations.update(conversation.id, { needs_human: true, handoff_reason: reason, status: 'handed_off' });
    actions.push(`handoff:${reason}`);
  };
  const recordDecision = (output: Record<string, unknown>, confidence: number) =>
    ctx.audit.decision({
      agent: CONVERSATION_AGENT,
      skill: SKILL,
      decision_type: 'conversation_reply',
      subject_type: 'conversation',
      subject_id: conversation.id,
      inputs: { message_id: message.id, content, source: input.source, account_id: account.id, lead_id: lead.id, intents, first_inbound: firstInbound },
      evidence: analysis.evidence.map((e): Evidence => ({ ...e, source_ref: message.id })),
      output: { ...output, actions },
      confidence,
      engine: 'rules',
    });

  // 3. do-not-contact users who write back: stored, handed to a human, no AI reply
  if (suppressedBefore) {
    setHandoff(HANDOFF_REASONS.suppressed_inbound);
    recordDecision({ reply: null, reason: 'suppressed_user' }, 0.9);
    refreshNextAction(ctx, lead.id);
    return finish(ctx, conversation.id, message, lead.id, intents, null, actions, false);
  }

  advance(ctx, lead, 'REPLIED', `客户回复私信：“${truncate(content, 40)}”`, actor, actions);

  // 4. refusal → global do-not-contact across every managed account
  if (intents.includes('not_interested')) {
    const result = suppressContact(ctx, {
      platform_user_id: lead.platform_user_id,
      reason: `用户回复：“${truncate(content, 60)}”`,
      source: `conversation:${conversation.id}`,
      actor: AGENT_ACTOR,
    });
    actions.push('contact_suppressed');
    if (result.outreach_cancelled.length > 0) actions.push(`outreach_cancelled:${result.outreach_cancelled.length}`);
    recordDecision({ reply: null, reason: 'not_interested', suppression_id: result.suppression.id, outreach_cancelled: result.outreach_cancelled }, 0.9);
    return finish(ctx, conversation.id, message, lead.id, intents, null, actions, false);
  }

  // 5. voluntarily provided contact
  const contact = detectContactInfo(content);
  const contactAcquired = Boolean(contact.phone || contact.wechat);
  if (contactAcquired) {
    lead = ctx.db.table('leads').update(lead.id, {
      contact: { ...lead.contact, ...contact, provided_at: receivedAt, source_message_id: message.id },
    });
    ctx.audit.event({
      actor,
      action: 'lead.contact_acquired',
      entity_type: 'lead',
      entity_id: lead.id,
      details: { message_id: message.id, fields: Object.keys(contact), source: 'conversation' },
    });
    advance(ctx, lead, 'CONTACT_ACQUIRED', '客户在私信中主动留下联系方式', actor, actions);
    actions.push('contact_acquired');
  }

  // 6. appointment intent
  let appointment: Appointment | null = null;
  const appointmentRequested = extracted.appointment_intent === true;
  if (appointmentRequested && !isTerminalStage(requireLead(ctx, lead.id).stage)) {
    appointment = upsertAppointment(ctx, {
      lead_id: lead.id,
      account_id: account.id,
      conversation_id: conversation.id,
      time_text: extracted.appointment_time_text ?? null,
      scheduled_for: extracted.appointment_at ?? null,
      vehicle_interest: vehicleInterestFor(ctx, requireLead(ctx, lead.id), analysis.slots),
      actor: AGENT_ACTOR,
    });
    actions.push('appointment_proposed');
  } else {
    appointment = getActiveAppointment(ctx, lead.id) ?? null;
  }

  // 7. sales qualification
  const qualification = qualifyLead(ctx, lead.id);
  if (qualification.sales_qualified) actions.push('sales_qualified');
  lead = requireLead(ctx, lead.id);

  // 8. hand-off rules
  const maxTurns = dealer.settings.max_ai_conversation_turns;
  let handoff: string | null = null;
  if (ownedByOther) handoff = HANDOFF_REASONS.non_owner;
  else if (isTerminalStage(lead.stage)) handoff = HANDOFF_REASONS.closed_lead;
  else if (NEGOTIATION_RE.test(content.normalize('NFKC'))) handoff = HANDOFF_REASONS.negotiation;
  else if (conversation.ai_turns >= maxTurns) handoff = `${HANDOFF_REASONS.turn_limit}（${maxTurns}轮）`;
  if (handoff) {
    setHandoff(handoff);
    recordDecision({ reply: null, needs_human: true, handoff_reason: handoff, qualification }, 0.8);
    refreshNextAction(ctx, lead.id);
    return finish(ctx, conversation.id, message, lead.id, intents, null, actions, false);
  }

  // 9. fact-grounded reply draft
  const persona = ensurePersona(ctx, account);
  const plan = composeReply(ctx, {
    dealer,
    account,
    persona,
    lead,
    slots: analysis.slots,
    intents,
    content,
    appointment,
    appointment_requested: appointmentRequested,
    contact_acquired: contactAcquired,
    first_inbound: firstInbound,
  });
  if (!plan) {
    recordDecision({ reply: null, reason: 'no_reply_needed', qualification }, 0.6);
    refreshNextAction(ctx, lead.id);
    return finish(ctx, conversation.id, message, lead.id, intents, null, actions, false);
  }
  const check = checkReply(ctx, dealer.id, plan.text, plan.facts);
  if (!check.passed) {
    setHandoff(HANDOFF_REASONS.verification_failed);
    recordDecision({ reply: null, discarded_draft: plan.text, fact_refs: plan.facts, verification: check, needs_human: true }, 0.5);
    refreshNextAction(ctx, lead.id);
    return finish(ctx, conversation.id, message, lead.id, intents, null, actions, false);
  }
  let draft = messages.insert({
    id: newId('msg'),
    conversation_id: conversation.id,
    direction: 'outbound',
    content: plan.text,
    intents,
    extracted: {},
    status: 'draft',
    fact_refs: plan.facts,
    provider_message_id: null,
    engine: 'rules',
    created_at: later(ctx.clock.iso(), receivedAt),
  });
  if (conversation.needs_human) conversation = conversations.update(conversation.id, { needs_human: false, handoff_reason: null, status: 'open' });
  actions.push('reply_drafted');

  // 10. automatic send only under AUTO policy with a provider that can really send
  const policy = effectiveOutreachPolicy(ctx, account.id).policy;
  let autoSend: Record<string, unknown> = { attempted: false, policy, reason: policy === 'AUTO' ? '' : `approval policy ${policy}` };
  if (policy === 'AUTO') {
    const operable = isAccountOperable(ctx, account.id);
    if (!operable.ok) autoSend = { attempted: false, policy, reason: operable.reason };
    else {
      const res = await trySend(ctx, draft, lead, account, AGENT_ACTOR);
      autoSend = { attempted: res.status === 'AVAILABLE', policy, capability_status: res.status, reason: res.reason, sent: !!res.sent };
      if (res.sent) {
        draft = res.sent;
        actions.push('reply_sent');
      }
    }
  }
  recordDecision(
    {
      draft_message_id: draft.id,
      reply: draft.content,
      status: draft.status,
      fact_refs: draft.fact_refs,
      answered: plan.answered,
      skipped: plan.skipped,
      verification: check,
      auto_send: autoSend,
      qualification,
    },
    plan.facts.length > 0 ? 0.8 : 0.65,
  );
  refreshNextAction(ctx, lead.id);
  return finish(ctx, conversation.id, message, lead.id, intents, draft, actions, false);
}

function finish(
  ctx: AppContext,
  conversationId: string,
  message: ConversationMessage,
  leadId: string,
  intents: ConversationIntent[],
  draft: ConversationMessage | null,
  actions: string[],
  duplicate: boolean,
): InboundResult {
  const conversation = ctx.db.table('conversations').require(conversationId);
  return {
    conversation,
    message: ctx.db.table('conversation_messages').require(message.id),
    lead: requireLead(ctx, leadId),
    intents,
    slots: conversation.slots,
    reply_draft: draft ? ctx.db.table('conversation_messages').require(draft.id) : null,
    actions,
    duplicate,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Human review path
// ─────────────────────────────────────────────────────────────────────────────

function pendingDraft(ctx: AppContext, messageId: string): { message: ConversationMessage; conversation: Conversation; lead: Lead; account: XhsAccount } {
  const message = ctx.db.table('conversation_messages').get(requireText(messageId, 'message_id'));
  if (!message) throw new NotFoundError('conversation_message', messageId);
  if (message.direction !== 'outbound' || message.status !== 'draft')
    throw new PolicyError('reply_not_pending', `message is ${message.direction}/${message.status}, not a pending reply draft`, {
      message_id: message.id,
    });
  const conversation = ctx.db.table('conversations').require(message.conversation_id);
  return { message, conversation, lead: requireLead(ctx, conversation.lead_id), account: requireAccount(ctx, conversation.account_id) };
}

/**
 * Human approval of a reply draft (optionally edited). The (edited) text is re-verified. When the provider can send
 * DMs the reply is sent and becomes `sent` only on provider confirmation; otherwise it stays `draft` with an
 * `reply.approved` audit event (MESSAGE_STATUSES has no approved state) and must be sent by hand, then recorded with
 * `markReplySentManually`.
 */
export async function approveReply(ctx: AppContext, messageId: string, actor: string, editedText?: string): Promise<ConversationMessage> {
  const who = requireText(actor, 'actor');
  const { message, lead, account } = pendingDraft(ctx, messageId);
  const text = editedText !== undefined ? requireText(editedText, 'edited_text') : message.content;
  guardReply(ctx, { lead, account, text, facts: message.fact_refs });
  const edited = text !== message.content;
  const current = edited ? ctx.db.table('conversation_messages').update(message.id, { content: text, engine: 'human' }) : message;
  const report = await ctx.xhs.capabilities(account.id);
  const cap = report.capabilities.send_messages;
  ctx.audit.event({
    actor: who,
    action: 'reply.approved',
    entity_type: 'conversation_message',
    entity_id: message.id,
    details: {
      edited,
      capability_status: cap.status,
      capability_reason: cap.reason,
      manual_send_required: cap.status !== 'AVAILABLE',
    },
  });
  if (cap.status !== 'AVAILABLE') {
    refreshNextAction(ctx, lead.id);
    return current;
  }
  const res = await trySend(ctx, current, lead, account, who);
  return res.sent ?? ctx.db.table('conversation_messages').require(message.id);
}

/** A human sent the draft in the Xiaohongshu app: blocking checks are re-run, then `sent_manually` + `sent_by`. */
export function markReplySentManually(ctx: AppContext, messageId: string, actor: string): ConversationMessage {
  const who = requireText(actor, 'actor');
  const { message, conversation, lead, account } = pendingDraft(ctx, messageId);
  guardReply(ctx, { lead, account, text: message.content, facts: message.fact_refs });
  return ctx.db.tx(() => {
    const at = ctx.clock.iso();
    const updated = ctx.db.table('conversation_messages').update(message.id, { status: 'sent_manually', sent_by: who });
    ctx.db.table('conversations').update(conversation.id, {
      ai_turns: conversation.ai_turns + 1,
      last_message_at: later(conversation.last_message_at, at),
    });
    ctx.audit.event({
      actor: who,
      action: 'reply.sent_manually',
      entity_type: 'conversation_message',
      entity_id: message.id,
      details: { conversation_id: conversation.id, lead_id: lead.id, account_id: account.id },
    });
    refreshNextAction(ctx, lead.id);
    return updated;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbox polling
// ─────────────────────────────────────────────────────────────────────────────

export async function pollInbox(ctx: AppContext, accountId: string): Promise<{ status: CapabilityStatus; processed: number; reason: string }> {
  const account = requireAccount(ctx, accountId);
  const report = await ctx.xhs.capabilities(account.id);
  const cap = report.capabilities.receive_messages;
  if (cap.status !== 'AVAILABLE') return { status: cap.status, processed: 0, reason: cap.reason };
  const last = ctx.db.get<{ at: string | null }>(
    `SELECT MAX(m.created_at) AS at FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.account_id = ? AND m.direction = 'inbound' AND m.provider_message_id IS NOT NULL`,
    account.id,
  );
  const res = await ctx.xhs.listInboundMessages(account.id, last?.at ?? null);
  if (!res.ok) return { status: res.status, processed: 0, reason: res.reason };
  let processed = 0;
  const failures: string[] = [];
  for (const m of res.data) {
    try {
      const out = await processInboundMessage(ctx, {
        account_id: account.id,
        platform_user_id: m.from_user_id,
        username: m.from_nickname,
        content: m.content,
        received_at: m.sent_at,
        provider_message_id: m.provider_message_id,
        source: 'provider',
      });
      if (!out.duplicate) processed++;
    } catch (err) {
      failures.push(`${m.provider_message_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  ctx.audit.event({
    actor: AGENT_ACTOR,
    action: 'inbox.polled',
    entity_type: 'xhs_account',
    entity_id: account.id,
    details: { fetched: res.data.length, processed, failures },
  });
  const reason = failures.length > 0 ? `处理${processed}条新私信，${failures.length}条失败：${failures.join('；')}` : `处理${processed}条新私信`;
  return { status: 'AVAILABLE', processed, reason };
}

// ─────────────────────────────────────────────────────────────────────────────
// Console listing
// ─────────────────────────────────────────────────────────────────────────────

export interface ConversationListItem {
  conversation: Conversation;
  lead: { id: string; username: string; platform_user_id: string; stage: LeadStage; score: number; tier: ScoreTier; suppressed: boolean };
  account: { id: string; nickname: string; account_type: AccountType };
  last_message: ConversationMessage | null;
  pending_draft: ConversationMessage | null;
  message_count: number;
}

/** Conversations of a dealer's leads, those needing a human first, then most recent. */
export function listConversations(
  ctx: AppContext,
  q: { dealer_id: string; needs_human?: boolean; account_id?: string; limit?: number },
): ConversationListItem[] {
  const dealerId = requireText(q?.dealer_id, 'dealer_id');
  const limit = Math.min(500, Math.max(1, Math.floor(q.limit ?? 100)));
  const params: (string | number)[] = [dealerId];
  let where = 'l.dealer_id = ?';
  if (q.needs_human !== undefined) {
    where += ' AND c.needs_human = ?';
    params.push(q.needs_human ? 1 : 0);
  }
  if (q.account_id) {
    where += ' AND c.account_id = ?';
    params.push(q.account_id);
  }
  const rows = ctx.db.all(
    `SELECT c.* FROM conversations c JOIN leads l ON l.id = c.lead_id WHERE ${where}
      ORDER BY c.needs_human DESC, c.last_message_at DESC LIMIT ${limit}`,
    ...params,
  );
  const messages = ctx.db.table('conversation_messages');
  return rows.map((row) => {
    const conversation = ctx.db.table('conversations').decode(row);
    const lead = requireLead(ctx, conversation.lead_id);
    const account = requireAccount(ctx, conversation.account_id);
    return {
      conversation,
      lead: {
        id: lead.id,
        username: lead.username,
        platform_user_id: lead.platform_user_id,
        stage: lead.stage,
        score: lead.score,
        tier: lead.tier,
        suppressed: lead.suppressed,
      },
      account: { id: account.id, nickname: account.nickname, account_type: account.account_type },
      last_message: messages.findOne({ conversation_id: conversation.id }, { orderBy: 'created_at DESC' }) ?? null,
      pending_draft: messages.findOne({ conversation_id: conversation.id, direction: 'outbound', status: 'draft' }, { orderBy: 'created_at DESC' }) ?? null,
      message_count: messages.count({ conversation_id: conversation.id }),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 聚光 私信API对接 lead intake
// ─────────────────────────────────────────────────────────────────────────────

export interface JuguangIngestResult {
  created: string[];
  updated: string[];
  suppressed_skipped: string[];
  rejected: { index: number; reason: string }[];
}

/**
 * Persist 聚光 lead records (parsed by `parseJuguangLeadPush`). Phone / WeChat were voluntarily provided through the
 * official 留资 flow and are stored on the lead (→ CONTACT_ACQUIRED). Do-not-contact users are skipped entirely.
 */
export function ingestJuguangLeads(ctx: AppContext, leads: JuguangLead[], opts: { dealer_id: string; actor: string }): JuguangIngestResult {
  if (!Array.isArray(leads)) throw new ValidationError('leads', 'expected an array of 聚光 lead records');
  const dealer = getDealer(ctx, requireText(opts?.dealer_id, 'dealer_id'));
  const actor = requireText(opts.actor, 'actor');
  const profile = getDealerProfile(ctx, dealer.id);
  const out: JuguangIngestResult = { created: [], updated: [], suppressed_skipped: [], rejected: [] };

  leads.forEach((record, index) => {
    try {
      const identity = record?.platform_user_id?.trim() || record?.red_id?.trim();
      if (!identity) {
        out.rejected.push({ index, reason: '缺少用户标识（user_id / 小红书号）' });
        return;
      }
      if (managedAccountFor(ctx, dealer.group_id, identity)) {
        out.rejected.push({ index, reason: '该标识属于本集团托管的小红书账号' });
        return;
      }
      if (isSuppressed(ctx, identity, PLATFORM)) {
        out.suppressed_skipped.push(identity);
        return;
      }
      const text = [record.remark, record.tags.length > 0 ? `线索标签：${record.tags.join('、')}` : null]
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .join('\n');
      const content = text || `聚光私信留资线索：${record.nickname ?? identity}`;
      const detection: IntentDetection = text
        ? detectIntentRules(text, { source_type: 'import', author_nickname: record.nickname }, profile)
        : { is_purchase_signal: false, intent: {}, evidence: [], transaction_questions: [], strength: 0, negative: false, engine: 'rules' };
      const city = record.city?.replace(/市$/u, '') || null;
      const province = record.province?.replace(/省$/u, '') || (city ? CITY_PROVINCE[city] : undefined) || null;
      if (city && !detection.intent.location) detection.intent = { ...detection.intent, location: city };
      if (province && !detection.intent.province) detection.intent = { ...detection.intent, province };
      const ownPost = record.note_id ? ctx.db.table('posts').findOne({ platform_note_id: record.note_id }) : undefined;

      const res = upsertLeadFromSignal(ctx, {
        dealer_id: dealer.id,
        identity: { platform_user_id: identity, username: record.nickname?.trim() || identity },
        signal: { source_type: 'import', content, signal_at: record.occurred_at ?? ctx.clock.iso(), detection },
        attributed_post_id: ownPost?.id ?? null,
      });
      let lead = res.lead;
      const contact = { ...(record.phone ? { phone: record.phone } : {}), ...(record.wechat ? { wechat: record.wechat } : {}) };
      if (contact.phone || contact.wechat) {
        lead = ctx.db.table('leads').update(lead.id, { contact: { ...lead.contact, ...contact, provided_at: record.occurred_at ?? ctx.clock.iso() } });
        const actions: string[] = [];
        advance(ctx, lead, 'CONTACT_ACQUIRED', '聚光私信留资（用户主动提供联系方式）', actor, actions);
      }
      ctx.audit.event({
        actor,
        action: 'lead.juguang_imported',
        entity_type: 'lead',
        entity_id: lead.id,
        details: {
          created: res.created,
          red_id: record.red_id,
          campaign_id: record.campaign_id,
          unit_id: record.unit_id,
          creative_id: record.creative_id,
          note_id: record.note_id,
          attributed_post_id: ownPost?.id ?? null,
          contact_fields: Object.keys(contact),
          operation: record.operation,
        },
      });
      refreshNextAction(ctx, lead.id);
      (res.created ? out.created : out.updated).push(lead.id);
    } catch (err) {
      if (err instanceof AppError) out.rejected.push({ index, reason: err.message });
      else throw err;
    }
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill
// ─────────────────────────────────────────────────────────────────────────────

export const CONVERSATION_ACTIONS = ['process_inbound', 'poll_inbox', 'approve_reply', 'mark_sent_manually'] as const;

const skillInput = v.object({
  action: v.literal(CONVERSATION_ACTIONS),
  account_id: v.optional(v.string({ min: 1 })),
  platform_user_id: v.optional(v.string({ min: 1 })),
  username: v.optional(v.nullable(v.string({ max: 200 }))),
  content: v.optional(v.string({ min: 1, max: 5000 })),
  received_at: v.optional(v.string({ min: 1 })),
  provider_message_id: v.optional(v.nullable(v.string({ min: 1 }))),
  source: v.optional(v.literal(['provider', 'manual'] as const)),
  message_id: v.optional(v.string({ min: 1 })),
  edited_text: v.optional(v.string({ min: 1, max: 5000 })),
  actor: v.optional(v.string({ min: 1 })),
});
export type ConversationSkillInput = Infer<typeof skillInput>;

export const skill = defineSkill<ConversationSkillInput, unknown>({
  name: 'conversation',
  category: 'sales',
  agent: 'conversation-agent',
  description: '处理客户私信回复：意图与信息提取、勿扰、留资、预约、销售合格与基于门店真实数据的回复草稿；人工审核/手动发送；收件箱轮询',
  input: skillInput,
  async run(ctx, input) {
    switch (input.action) {
      case 'process_inbound':
        return processInboundMessage(ctx, {
          account_id: requireText(input.account_id, 'account_id'),
          platform_user_id: requireText(input.platform_user_id, 'platform_user_id'),
          username: input.username ?? null,
          content: requireText(input.content, 'content'),
          received_at: input.received_at,
          provider_message_id: input.provider_message_id ?? null,
          source: input.source ?? 'manual',
          actor: input.actor,
        });
      case 'poll_inbox':
        return pollInbox(ctx, requireText(input.account_id, 'account_id'));
      case 'approve_reply':
        return approveReply(ctx, requireText(input.message_id, 'message_id'), requireText(input.actor, 'actor'), input.edited_text);
      case 'mark_sent_manually':
        return markReplySentManually(ctx, requireText(input.message_id, 'message_id'), requireText(input.actor, 'actor'));
    }
  },
});
