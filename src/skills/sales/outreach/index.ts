/**
 * Outreach engine (spec §12, ARCHITECTURE §6 / §8 C2 / §10.4).
 *
 * Lifecycle: prepareOutreach → guards → BLOCKED | READY_FOR_REVIEW | APPROVED(AUTO) → sendOutreach (provider) |
 * markOutreachSentManually (a human sends it in the Xiaohongshu app) | cancelOutreach.
 * SENT is recorded ONLY with a provider-confirmed provider_message_id. When send_messages is not AVAILABLE (the live
 * xiaohongshu-mcp integration has no DM tool) an approved message waits as APPROVED for the owning account to send
 * it by hand; the console shows it through listOutreachQueue.
 */
import type { AppContext } from '../../../app/context.ts';
import { NotFoundError, PolicyError, ValidationError } from '../../../core/errors.ts';
import { newId } from '../../../core/ids.ts';
import {
  OUTREACH_KINDS,
  OUTREACH_STATUSES,
  type AccountPersona,
  type AccountType,
  type ActorType,
  type CapabilityStatus,
  type DataMode,
  type DmChannel,
  type Engine,
  type GuardResult,
  type Lead,
  type LeadSignal,
  type LeadStage,
  type Outreach,
  type OutreachKind,
  type OutreachStatus,
  type ScoreTier,
  type SignalSourceType,
} from '../../../core/types.ts';
import { v } from '../../../core/validate.ts';
import { getActiveAssignment } from '../../acquisition/account-assignment/index.ts';
import { defineSkill } from '../../registry.ts';
import { applyVoicePronoun, getAccountVoice, voiceCopyCheck, voicePromptBlock } from '../../content/account-voice/index.ts';
import { effectiveOutreachPolicy, requireAccount } from '../../operations/account-brain/index.ts';
import { checkPlatformRules, detectContactInfoLeak } from '../../operations/compliance/index.ts';
import { STAGE_INDEX, refreshNextAction, transitionLead } from '../../operations/crm/index.ts';
import { getDealer, getProhibitedClaims, verifyClaims } from '../../operations/dealer-brain/index.ts';
import { MAX_OUTREACH_CHARS, composeOutreachMessage, type ComposedOutreach } from './composer.ts';
import { PENDING_STATUSES, SENT_STATUSES, blockingReason, hasBlocking, hasReview, runSendGuards } from './guards.ts';

export {
  MAX_OUTREACH_CHARS,
  MAX_QUOTE_CHARS,
  composeOutreachMessage,
  parseColourIntent,
  pickSignalQuote,
  type ComposeInput,
  type ComposedOutreach,
} from './composer.ts';
export {
  LIVE_FIRST_TOUCH_STATUSES,
  NEAR_DUPLICATE_THRESHOLD,
  PENDING_STATUSES,
  SENT_STATUSES,
  blockingReason,
  hasBlocking,
  hasReview,
  inboundCount,
  runSendGuards,
  type SendGuardInput,
} from './guards.ts';

export const OUTREACH_AGENT = 'outreach-agent';
export const OUTREACH_ACTOR = `agent:${OUTREACH_AGENT}`;
export const AUTO_APPROVER = 'policy:AUTO';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function requireOutreach(ctx: AppContext, outreachId: string): Outreach {
  const row = ctx.db.table('outreach').get(outreachId);
  if (!row) throw new NotFoundError('outreach', outreachId);
  return row;
}

function requireLead(ctx: AppContext, leadId: string): Lead {
  const row = ctx.db.table('leads').get(leadId);
  if (!row) throw new NotFoundError('lead', leadId);
  return row;
}

function requireActor(actor: unknown): string {
  if (typeof actor !== 'string' || !actor.trim()) throw new ValidationError('actor', 'actor is required');
  return actor.trim();
}

/** The signal shown to salespeople and quoted in messages: primary signal, else the strongest purchase signal. */
export function primarySignalOf(ctx: AppContext, lead: Lead): LeadSignal | null {
  const table = ctx.db.table('lead_signals');
  if (lead.primary_signal_id) {
    const s = table.get(lead.primary_signal_id);
    if (s && s.lead_id === lead.id) return s;
  }
  const row = ctx.db.get(
    `SELECT * FROM lead_signals WHERE lead_id = ?
     ORDER BY is_purchase_signal DESC, signal_score DESC, signal_at DESC, rowid DESC LIMIT 1`,
    lead.id,
  );
  return row ? table.decode(row) : null;
}

function personaOf(ctx: AppContext, accountId: string): AccountPersona | null {
  return ctx.db.table('account_personas').findOne({ account_id: accountId }) ?? null;
}

async function sendCapability(ctx: AppContext, accountId: string): Promise<{ status: CapabilityStatus; reason: string }> {
  try {
    const report = await ctx.xhs.capabilities(accountId);
    const cap = report.capabilities.send_messages;
    return { status: cap.status, reason: cap.reason };
  } catch (err) {
    return { status: 'UNAVAILABLE', reason: `capability check failed: ${(err as Error)?.message ?? String(err)}` };
  }
}

function lastSentTouch(ctx: AppContext, leadId: string): Outreach | null {
  const row = ctx.db.get(
    `SELECT * FROM outreach WHERE lead_id = ? AND status IN ('SENT', 'SENT_MANUALLY') AND sent_at IS NOT NULL
     ORDER BY sent_at DESC, rowid DESC LIMIT 1`,
    leadId,
  );
  return row ? ctx.db.table('outreach').decode(row) : null;
}

function recordGuardDecision(ctx: AppContext, outreach: Outreach, guards: GuardResult[], humanApproved: boolean, extra: Record<string, unknown> = {}): void {
  ctx.audit.decision({
    agent: OUTREACH_AGENT,
    skill: 'outreach',
    decision_type: 'outreach_guard',
    subject_type: 'outreach',
    subject_id: outreach.id,
    inputs: { lead_id: outreach.lead_id, account_id: outreach.account_id, kind: outreach.kind, human_approved: humanApproved, message: outreach.message },
    evidence: [],
    output: { status: outreach.status, guards, blocked_reason: outreach.blocked_reason, ...extra },
    confidence: 1,
    engine: 'rules',
  });
}

/** Move the lead forward; a suppression that appeared meanwhile must not undo a real send record. */
function advanceLead(ctx: AppContext, leadId: string, to: LeadStage, reason: string, actor: string): void {
  const lead = requireLead(ctx, leadId);
  if (STAGE_INDEX[lead.stage] >= STAGE_INDEX[to] || lead.stage === 'LOST' || lead.stage === 'WON') return;
  try {
    transitionLead(ctx, leadId, to, { reason, actor });
  } catch (err) {
    if (!(err instanceof PolicyError)) throw err;
    ctx.audit.event({ actor, action: 'lead.stage_change_skipped', entity_type: 'lead', entity_id: leadId, details: { to, reason: err.message } });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Optional LLM refinement (validated; rules text is always the fallback)
// ─────────────────────────────────────────────────────────────────────────────

const LLM_SYSTEM = [
  '你是汽车经销商小红书账号的私信润色助手。只允许调整语气和语序，使其更符合账号人设。',
  '必须原样保留所有事实短语（价格、优惠、库存、日期等）和用双引号引用的客户原话，不得新增任何事实、数字或承诺。',
  '禁止出现电话、微信、QQ、链接、“加我”等站外引流内容；联系方式只能引导使用留资卡或预约到店。',
  `全文不超过${MAX_OUTREACH_CHARS - 20}个字，只输出私信正文。`,
].join('\n');

async function refineWithLlm(
  ctx: AppContext,
  composed: ComposedOutreach,
  dealerId: string,
  persona: AccountPersona | null,
  accountId: string,
): Promise<{ message: string | null; note: string }> {
  if (ctx.llm.status().status !== 'AVAILABLE') return { message: null, note: 'llm_unavailable' };
  // 账号语言风格: how this account itself writes, learned from its own notes (compact — a DM is short).
  const voice = getAccountVoice(ctx, accountId);
  const voiceBlock = voicePromptBlock(voice, { compact: true });
  const prompt = [
    `账号人设：${persona?.persona_name ?? ''}；语气：${persona?.tone ?? ''}；表达规则：${(persona?.voice_rules ?? []).join('；')}`,
    voiceBlock,
    `必须原样保留的事实短语：${composed.fact_refs.map((f) => f.claim).join(' | ') || '（无）'}`,
    `必须原样保留的客户原话：${composed.quote ?? '（无）'}`,
    `待润色私信：${composed.message}`,
  ].join('\n');
  const res = await ctx.llm.completeText({ purpose: 'outreach_refinement', system: LLM_SYSTEM, prompt, max_tokens: 800 });
  if (!res.ok) return { message: null, note: `llm_failed: ${res.reason}` };
  const text = res.data.trim().replace(/^["“]+|["”]+$/gu, '').trim();
  const problems: string[] = [];
  if (!text) problems.push('empty');
  if (Array.from(text).length > MAX_OUTREACH_CHARS) problems.push('too_long');
  for (const f of composed.fact_refs) if (!text.includes(f.claim)) problems.push(`missing_fact:${f.claim}`);
  if (composed.quote && !text.includes(composed.quote)) problems.push('missing_quote');
  if (detectContactInfoLeak(text).length > 0) problems.push('contact_leak');
  const prohibited = getProhibitedClaims(ctx, dealerId).map((p) => ({ phrase: p.phrase, reason: p.reason }));
  if (!checkPlatformRules(text, { prohibited, max_length: MAX_OUTREACH_CHARS, channel: 'dm' }).passed) problems.push('platform_rules');
  const facts = verifyClaims(ctx, dealerId, text, composed.fact_refs);
  if (!facts.passed) problems.push(`unverified: ${facts.issues.join('；')}`);
  // Imitating the account's voice must never turn into reusing one of its notes.
  const copy = voiceCopyCheck(ctx, accountId, text);
  if (copy.copied) problems.push(`copied_own_note: ${copy.platform_note_id ?? ''}`);
  return problems.length > 0 ? { message: null, note: `llm_rejected: ${problems.join(', ')}` } : { message: applyVoicePronoun(text, voice), note: 'llm_used' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export interface PrepareOutreachOptions {
  kind?: OutreachKind;
  actor?: string;
}

/**
 * Generate a personalized message from the lead's real public signal and verified Dealer Brain facts for the
 * lead's ACTIVE owning account, run every guard and persist the outreach. Idempotent: a pending outreach of the
 * same kind from the same account is returned unchanged.
 */
export async function prepareOutreach(ctx: AppContext, leadId: string, opts: PrepareOutreachOptions = {}): Promise<Outreach> {
  const kind = opts.kind ?? 'first_touch';
  if (!(OUTREACH_KINDS as readonly string[]).includes(kind)) throw new ValidationError('kind', `expected ${OUTREACH_KINDS.join('|')}`);
  const actor = opts.actor?.trim() || OUTREACH_ACTOR;
  const lead = requireLead(ctx, leadId);
  const assignment = getActiveAssignment(ctx, lead.id);
  if (!assignment) throw new PolicyError('no_active_assignment', '线索没有负责账号：请先由 Fleet Controller 分配账号', { lead_id: lead.id });
  if (STAGE_INDEX[lead.stage] < STAGE_INDEX.ASSIGNED)
    throw new PolicyError('lead_not_assigned', `线索阶段为${lead.stage}，需达到ASSIGNED后才能生成私信`, { lead_id: lead.id, stage: lead.stage });

  const account = requireAccount(ctx, assignment.account_id);
  const pending = ctx.db
    .table('outreach')
    .findOne({ lead_id: lead.id, account_id: account.id, kind, status: [...PENDING_STATUSES] }, { orderBy: 'created_at DESC' });
  if (pending) return pending;

  const dealer = getDealer(ctx, account.dealer_id);
  const persona = personaOf(ctx, account.id);
  const signal = primarySignalOf(ctx, lead);
  const composed = composeOutreachMessage(ctx, {
    lead,
    account,
    persona,
    dealer,
    signal,
    kind,
    previous_touch: kind === 'follow_up' ? lastSentTouch(ctx, lead.id) : null,
  });

  const capability = await sendCapability(ctx, account.id);
  const refined = await refineWithLlm(ctx, composed, dealer.id, persona, account.id);
  const message = refined.message ?? composed.message;
  const engine: Engine = refined.message ? 'llm+rules' : 'rules';

  const fresh = requireLead(ctx, lead.id);
  const guards = runSendGuards(ctx, {
    lead: fresh,
    account_id: account.id,
    message,
    fact_refs: composed.fact_refs,
    kind,
    human_approved: false,
    capability: capability.status,
  });
  const policy = effectiveOutreachPolicy(ctx, account.id);
  const status: OutreachStatus = hasBlocking(guards) ? 'BLOCKED' : hasReview(guards) ? 'READY_FOR_REVIEW' : 'APPROVED';
  const now = ctx.clock.iso();

  const row = ctx.db.tx(() => {
    const base: Outreach = {
      id: newId('out'),
      lead_id: lead.id,
      account_id: account.id,
      assignment_id: assignment.id,
      kind,
      message,
      personalization: composed.personalization,
      fact_refs: composed.fact_refs,
      guard_results: guards,
      approval_policy: policy.policy,
      status,
      capability_status: capability.status,
      provider_message_id: null,
      blocked_reason: status === 'BLOCKED' ? blockingReason(guards) : null,
      approved_by: status === 'APPROVED' ? AUTO_APPROVER : null,
      approved_at: status === 'APPROVED' ? now : null,
      sent_at: null,
      sent_by: null,
      engine,
      created_at: now,
      updated_at: now,
    };
    let inserted: Outreach;
    try {
      inserted = ctx.db.tx(() => ctx.db.table('outreach').insert(base));
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('UNIQUE constraint failed: outreach')) throw err;
      // another live first touch was stored concurrently: never two first touches to one person
      const raced: GuardResult[] = guards.map((g) =>
        g.check === 'duplicate' ? { check: 'duplicate', passed: false, blocking: true, detail: '并发生成了另一条有效首次私信（数据库唯一约束）' } : g,
      );
      inserted = ctx.db.table('outreach').insert({
        ...base,
        status: 'BLOCKED',
        guard_results: raced,
        blocked_reason: blockingReason(raced),
        approved_by: null,
        approved_at: null,
      });
    }

    ctx.audit.decision({
      agent: OUTREACH_AGENT,
      skill: 'outreach',
      decision_type: 'outreach_generation',
      subject_type: 'outreach',
      subject_id: inserted.id,
      inputs: {
        lead_id: lead.id,
        account_id: account.id,
        account_type: account.account_type,
        kind,
        persona: persona ? { persona_name: persona.persona_name, tone: persona.tone } : null,
        signal_id: signal?.id ?? null,
        quote: composed.quote,
        facts_used: composed.facts_used,
        capability,
        llm: refined.note,
      },
      evidence: composed.personalization,
      output: { message, fact_refs: composed.fact_refs, engine },
      confidence: composed.quote ? 0.85 : 0.7,
      engine,
    });
    recordGuardDecision(ctx, inserted, inserted.guard_results, false);
    ctx.audit.event({
      actor,
      action: inserted.status === 'BLOCKED' ? 'outreach.blocked' : 'outreach.prepared',
      entity_type: 'outreach',
      entity_id: inserted.id,
      details: { lead_id: lead.id, account_id: account.id, kind, status: inserted.status, blocked_reason: inserted.blocked_reason },
    });
    if (inserted.status === 'READY_FOR_REVIEW' || inserted.status === 'APPROVED') {
      advanceLead(ctx, lead.id, 'OUTREACH_READY', inserted.status === 'APPROVED' ? '私信已生成，已通过审核' : '私信已生成，等人审核', actor);
    }
    return inserted;
  });

  if (row.status === 'APPROVED') return sendOutreach(ctx, row.id);
  refreshNextAction(ctx, lead.id);
  return row;
}

/**
 * Human approval (optionally with an edited text). All guards are re-run on the final text; a blocking failure
 * blocks the outreach. When every guard passes and the provider can send, it is sent immediately; otherwise it
 * stays APPROVED for the owning account to send by hand.
 */
export async function approveOutreach(ctx: AppContext, outreachId: string, actor: string, editedMessage?: string): Promise<Outreach> {
  const who = requireActor(actor);
  const o = requireOutreach(ctx, outreachId);
  const edited = typeof editedMessage === 'string' && editedMessage.trim() && editedMessage.trim() !== o.message ? editedMessage.trim() : null;
  if (o.status === 'APPROVED' && !edited) return o;
  if (!(o.status === 'READY_FOR_REVIEW' || o.status === 'DRAFT' || o.status === 'APPROVED'))
    throw new PolicyError('outreach_not_reviewable', `状态为${o.status}的私信不能审核`, { outreach_id: o.id, status: o.status });

  const lead = requireLead(ctx, o.lead_id);
  const message = edited ?? o.message;
  const capability = await sendCapability(ctx, o.account_id);
  const guards = runSendGuards(ctx, {
    lead,
    account_id: o.account_id,
    message,
    fact_refs: o.fact_refs,
    kind: o.kind,
    human_approved: true,
    capability: capability.status,
    outreach_id: o.id,
  });
  const now = ctx.clock.iso();
  const blocked = hasBlocking(guards);
  const row = ctx.db.tx(() => {
    const updated = ctx.db.table('outreach').update(o.id, {
      message,
      guard_results: guards,
      capability_status: capability.status,
      status: blocked ? 'BLOCKED' : 'APPROVED',
      blocked_reason: blocked ? blockingReason(guards) : null,
      approved_by: blocked ? o.approved_by : who,
      approved_at: blocked ? o.approved_at : now,
      engine: edited ? 'human' : o.engine,
    });
    if (!blocked && o.blocked_reason) ctx.db.table('outreach').setNull(o.id, ['blocked_reason']);
    recordGuardDecision(ctx, updated, guards, true, { edited: Boolean(edited) });
    ctx.audit.event({
      actor: who,
      action: blocked ? 'outreach.blocked' : 'outreach.approved',
      entity_type: 'outreach',
      entity_id: o.id,
      details: { lead_id: o.lead_id, edited: Boolean(edited), previous_message: edited ? o.message : undefined, blocked_reason: updated.blocked_reason },
    });
    if (!blocked) advanceLead(ctx, o.lead_id, 'OUTREACH_READY', '私信已审核通过', who);
    return ctx.db.table('outreach').require(o.id);
  });
  if (!blocked && !guards.some((g) => !g.passed)) return sendOutreach(ctx, row.id);
  refreshNextAction(ctx, o.lead_id);
  return row;
}

/**
 * Send an APPROVED outreach through the provider. SENT only with a provider-confirmed message id; unknown
 * outcomes and retryable failures stay APPROVED with the reason; non-retryable failures become FAILED.
 */
export async function sendOutreach(ctx: AppContext, outreachId: string): Promise<Outreach> {
  const o = requireOutreach(ctx, outreachId);
  if (o.status === 'SENT' || o.status === 'SENT_MANUALLY') return o;
  if (o.status !== 'APPROVED')
    throw new PolicyError('outreach_not_approved', `状态为${o.status}的私信不能发送，需先审核通过`, { outreach_id: o.id, status: o.status });

  const lead = requireLead(ctx, o.lead_id);
  const capability = await sendCapability(ctx, o.account_id);
  const guards = runSendGuards(ctx, {
    lead,
    account_id: o.account_id,
    message: o.message,
    fact_refs: o.fact_refs,
    kind: o.kind,
    human_approved: true,
    capability: capability.status,
    outreach_id: o.id,
  });
  const actor = o.approved_by === AUTO_APPROVER ? OUTREACH_ACTOR : 'system';

  if (hasBlocking(guards) || hasReview(guards)) {
    const blocked = hasBlocking(guards);
    const row = ctx.db.tx(() => {
      const updated = ctx.db.table('outreach').update(o.id, {
        guard_results: guards,
        capability_status: capability.status,
        status: blocked ? 'BLOCKED' : 'APPROVED',
        blocked_reason: blocked ? blockingReason(guards) : null,
      });
      recordGuardDecision(ctx, updated, guards, true, { phase: 'send' });
      ctx.audit.event({
        actor,
        action: blocked ? 'outreach.blocked' : 'outreach.awaiting_manual_send',
        entity_type: 'outreach',
        entity_id: o.id,
        details: {
          lead_id: o.lead_id,
          reasons: guards.filter((g) => !g.passed).map((g) => `${g.check}: ${g.detail}`),
        },
      });
      return updated;
    });
    refreshNextAction(ctx, o.lead_id);
    return row;
  }

  const result = await ctx.xhs.sendMessage(o.account_id, lead.platform_user_id, o.message);
  const now = ctx.clock.iso();
  const row = ctx.db.tx(() => {
    if (result.ok && typeof result.data.provider_message_id === 'string' && result.data.provider_message_id.trim()) {
      const updated = ctx.db.table('outreach').update(o.id, {
        status: 'SENT',
        provider_message_id: result.data.provider_message_id,
        sent_at: now,
        guard_results: guards,
        capability_status: capability.status,
        blocked_reason: null,
      });
      // The conversation is the first place this system ever sees the person's face; a lead that had none gets it now.
      const face = typeof result.data.peer_avatar_url === 'string' ? result.data.peer_avatar_url.trim() : '';
      if (face && !lead.avatar_url) ctx.db.table('leads').update(lead.id, { avatar_url: face });
      ctx.audit.event({
        actor,
        action: 'outreach.sent',
        entity_type: 'outreach',
        entity_id: o.id,
        details: { lead_id: o.lead_id, account_id: o.account_id, provider: ctx.xhs.name, provider_message_id: result.data.provider_message_id },
      });
      advanceLead(ctx, o.lead_id, 'CONTACTED', `私信已通过${ctx.xhs.name}发送（${result.data.provider_message_id}）`, actor);
      return updated;
    }
    const reason = result.ok
      ? '发送接口未返回消息ID，无法确认已送达：请在小红书中核实后手动登记或取消'
      : `${result.status}: ${result.reason}`;
    const keepApproved = result.ok || result.status === 'REQUIRES_REVIEW' || result.retryable === true;
    const updated = ctx.db.table('outreach').update(o.id, {
      status: keepApproved ? 'APPROVED' : 'FAILED',
      blocked_reason: reason,
      guard_results: guards,
      capability_status: capability.status,
    });
    ctx.audit.event({
      actor,
      action: 'outreach.send_failed',
      entity_type: 'outreach',
      entity_id: o.id,
      details: { lead_id: o.lead_id, provider: ctx.xhs.name, reason, status: updated.status },
    });
    return updated;
  });
  refreshNextAction(ctx, o.lead_id);
  return row;
}

/**
 * Record that a human sent the (approved or reviewed) message in the owning account's Xiaohongshu app.
 * Blocking guards are re-checked first (ownership, do-not-contact, duplicates, account disabled, facts, rules).
 */
export function markOutreachSentManually(ctx: AppContext, outreachId: string, actor: string): Outreach {
  const who = requireActor(actor);
  const o = requireOutreach(ctx, outreachId);
  if (o.status === 'SENT_MANUALLY' || o.status === 'SENT') return o;
  if (!(o.status === 'READY_FOR_REVIEW' || o.status === 'APPROVED' || o.status === 'FAILED'))
    throw new PolicyError('outreach_not_sendable', `状态为${o.status}的私信不能登记为已发送`, { outreach_id: o.id, status: o.status });

  const lead = requireLead(ctx, o.lead_id);
  const guards = runSendGuards(ctx, {
    lead,
    account_id: o.account_id,
    message: o.message,
    fact_refs: o.fact_refs,
    kind: o.kind,
    human_approved: true,
    capability: o.capability_status,
    outreach_id: o.id,
  });
  if (hasBlocking(guards)) {
    const reason = blockingReason(guards);
    ctx.db.tx(() => {
      const updated = ctx.db.table('outreach').update(o.id, { status: 'BLOCKED', guard_results: guards, blocked_reason: reason });
      recordGuardDecision(ctx, updated, guards, true, { phase: 'manual_send' });
      ctx.audit.event({ actor: who, action: 'outreach.blocked', entity_type: 'outreach', entity_id: o.id, details: { lead_id: o.lead_id, reason, phase: 'manual_send' } });
    });
    refreshNextAction(ctx, o.lead_id);
    throw new PolicyError('outreach_blocked', `发送前检查未通过，不能登记为已发送：${reason}`, { outreach_id: o.id });
  }

  const now = ctx.clock.iso();
  const row = ctx.db.tx(() => {
    const updated = ctx.db.table('outreach').update(o.id, {
      status: 'SENT_MANUALLY',
      sent_at: now,
      sent_by: who,
      approved_by: o.approved_by ?? who,
      approved_at: o.approved_at ?? now,
      guard_results: guards,
    });
    if (o.blocked_reason) ctx.db.table('outreach').setNull(o.id, ['blocked_reason']);
    ctx.audit.event({
      actor: who,
      action: 'outreach.sent_manually',
      entity_type: 'outreach',
      entity_id: o.id,
      details: { lead_id: o.lead_id, account_id: o.account_id, kind: o.kind },
    });
    advanceLead(ctx, o.lead_id, 'CONTACTED', `${who} 已在小红书手动发送私信`, who);
    return ctx.db.table('outreach').require(o.id);
  });

  // Demo harness only: lets the simulation's scripted inbox release this user's replies. Never used for live providers.
  const sim = ctx.xhs as unknown as { mode: string; recordManualContact?: (accountId: string, userId: string) => void };
  if (sim.mode === 'simulation' && typeof sim.recordManualContact === 'function') sim.recordManualContact(o.account_id, lead.platform_user_id);

  refreshNextAction(ctx, o.lead_id);
  return row;
}

export function cancelOutreach(ctx: AppContext, outreachId: string, actor: string, reason: string): Outreach {
  const who = requireActor(actor);
  if (typeof reason !== 'string' || !reason.trim()) throw new ValidationError('reason', 'reason is required');
  const o = requireOutreach(ctx, outreachId);
  if (o.status === 'CANCELLED') return o;
  if ((SENT_STATUSES as readonly string[]).includes(o.status))
    throw new PolicyError('outreach_already_sent', '已发送的私信不能取消', { outreach_id: o.id, status: o.status });
  const row = ctx.db.tx(() => {
    const updated = ctx.db.table('outreach').update(o.id, { status: 'CANCELLED' });
    ctx.audit.event({
      actor: who,
      action: 'outreach.cancelled',
      entity_type: 'outreach',
      entity_id: o.id,
      details: { lead_id: o.lead_id, previous_status: o.status, reason: reason.trim() },
    });
    return updated;
  });
  refreshNextAction(ctx, o.lead_id);
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// REVIEW_REQUIRED console queue
// ─────────────────────────────────────────────────────────────────────────────

export interface OutreachQueueQuery {
  dealer_id: string;
  statuses?: OutreachStatus[];
  account_id?: string;
  limit?: number;
}

export interface OutreachQueueItem {
  outreach: Outreach;
  lead: {
    id: string;
    username: string;
    profile_url: string | null;
    score: number;
    tier: ScoreTier;
    stage: LeadStage;
    data_mode: DataMode;
    actor_type: ActorType | null;
  };
  account: { id: string; nickname: string; account_type: AccountType; salesperson_name: string | null };
  original_signal: { content: string; post_title: string | null; url: string | null; signal_at: string; source_type: SignalSourceType } | null;
  /** exact text to paste in the Xiaohongshu app; null when the outreach must not be sent */
  copy_text: string | null;
  manual_send_instructions: string[];
  /** where this store sends DMs by hand, and the workbench to open for the 专业号 channel */
  send_channel: DmChannel;
  workbench_url: string | null;
}

/** 专业号 customer-service workbench. Opening it is all Steer does there: it never drives the page. */
export const PRO_WORKBENCH_URL = 'https://pro.xiaohongshu.com/im/multiCustomerService';

function instructionsFor(o: Outreach, lead: Lead, nickname: string, channel: DmChannel): string[] {
  if (o.status === 'BLOCKED') return [`已拦截，请勿发送：${o.blocked_reason ?? '未通过发送前检查'}`];
  if (o.status === 'CANCELLED') return ['已取消，请勿发送'];
  if (o.status === 'SENT' || o.status === 'SENT_MANUALLY') return [`已于 ${o.sent_at ?? ''} 发送${o.sent_by ? `（${o.sent_by}）` : ''}`];
  const steps: string[] = [];
  if (o.status === 'READY_FOR_REVIEW' || o.status === 'DRAFT') steps.push('先审核私信内容，必要时修改后点击「审核通过」');
  if (channel === 'pro') {
    steps.push(`用负责账号「${nickname}」登录专业号后台 ${PRO_WORKBENCH_URL}（只能由该账号发送，其他账号不要重复联系）`);
    steps.push(`在客服工作台的会话列表里找到用户「${lead.username}」${lead.profile_url ? `（主页 ${lead.profile_url}）` : ''}；对方还没来过私信时，先从主页发起会话`);
  } else {
    steps.push(`在小红书App中登录负责账号「${nickname}」（只能由该账号发送，其他账号不要重复联系）`);
    steps.push(lead.profile_url ? `打开客户主页 ${lead.profile_url} ，点击「私信」` : `在原笔记评论区找到用户「${lead.username}」，进入主页后点击「私信」`);
  }
  steps.push('粘贴下方私信内容发送，不要额外添加电话、微信或任何链接');
  steps.push('发送成功后回到本系统点击「已在小红书发送」登记');
  if (o.status === 'APPROVED' && o.blocked_reason) steps.unshift(`系统发送未完成：${o.blocked_reason}`);
  return steps;
}

export function listOutreachQueue(ctx: AppContext, q: OutreachQueueQuery): OutreachQueueItem[] {
  if (!q || typeof q.dealer_id !== 'string' || !q.dealer_id) throw new ValidationError('dealer_id', 'required');
  const channel = getDealer(ctx, q.dealer_id).settings.dm_channel ?? 'app';
  const statuses = q.statuses && q.statuses.length > 0 ? q.statuses : (['READY_FOR_REVIEW', 'APPROVED'] as OutreachStatus[]);
  for (const s of statuses) if (!(OUTREACH_STATUSES as readonly string[]).includes(s)) throw new ValidationError('statuses', `unknown status ${s}`);
  const limit = Math.min(500, Math.max(1, Math.floor(q.limit ?? 100)));
  const params: (string | number)[] = [q.dealer_id, q.dealer_id, ...statuses];
  let accountSql = '';
  if (q.account_id) {
    accountSql = ' AND o.account_id = ?';
    params.push(q.account_id);
  }
  const rows = ctx.db.all(
    `SELECT o.* FROM outreach o JOIN leads l ON l.id = o.lead_id JOIN xhs_accounts a ON a.id = o.account_id
     WHERE (l.dealer_id = ? OR a.dealer_id = ?) AND o.status IN (${statuses.map(() => '?').join(', ')})${accountSql}
     ORDER BY CASE o.status WHEN 'APPROVED' THEN 0 WHEN 'READY_FOR_REVIEW' THEN 1 ELSE 2 END, l.score DESC, o.created_at ASC, o.rowid ASC
     LIMIT ${limit}`,
    ...params,
  );
  const table = ctx.db.table('outreach');
  return rows.map((raw) => {
    const o = table.decode(raw);
    const lead = requireLead(ctx, o.lead_id);
    const account = requireAccount(ctx, o.account_id);
    const signal = primarySignalOf(ctx, lead);
    const post = signal?.public_post_id ? ctx.db.table('public_posts').get(signal.public_post_id) : undefined;
    const sendable = o.status === 'READY_FOR_REVIEW' || o.status === 'APPROVED' || o.status === 'FAILED' || o.status === 'DRAFT';
    return {
      outreach: o,
      lead: {
        id: lead.id,
        username: lead.username,
        profile_url: lead.profile_url,
        score: lead.score,
        tier: lead.tier,
        stage: lead.stage,
        data_mode: lead.data_mode ?? 'unknown',
        actor_type: lead.actor_type ?? null,
      },
      account: { id: account.id, nickname: account.nickname, account_type: account.account_type, salesperson_name: account.salesperson_name },
      original_signal: signal
        ? {
            content: signal.content,
            post_title: signal.post_title ?? post?.title ?? null,
            url: post?.url ?? null,
            signal_at: signal.signal_at,
            source_type: signal.source_type,
          }
        : null,
      copy_text: sendable ? o.message : null,
      manual_send_instructions: instructionsFor(o, lead, account.nickname, channel),
      send_channel: channel,
      workbench_url: channel === 'pro' && sendable ? PRO_WORKBENCH_URL : null,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill
// ─────────────────────────────────────────────────────────────────────────────

export const OUTREACH_ACTIONS = ['prepare', 'approve', 'send', 'mark_sent', 'cancel'] as const;
export type OutreachAction = (typeof OUTREACH_ACTIONS)[number];

const outreachSkillInput = v.object({
  action: v.literal(OUTREACH_ACTIONS),
  lead_id: v.optional(v.string({ min: 1 })),
  outreach_id: v.optional(v.string({ min: 1 })),
  kind: v.optional(v.literal(OUTREACH_KINDS)),
  actor: v.optional(v.string({ min: 1 })),
  edited_message: v.optional(v.string({ min: 1, max: 2000 })),
  reason: v.optional(v.string({ min: 1 })),
});

export interface OutreachSkillInput {
  action: OutreachAction;
  lead_id?: string;
  outreach_id?: string;
  kind?: OutreachKind;
  actor?: string;
  edited_message?: string;
  reason?: string;
}

function need<T>(value: T | undefined, path: string): T {
  if (value === undefined) throw new ValidationError(path, 'required for this action');
  return value;
}

export const skill = defineSkill<OutreachSkillInput, Outreach>({
  name: 'outreach',
  category: 'sales',
  agent: 'outreach-agent',
  description:
    '基于客户真实公开信号与门店核实事实，为负责账号生成个性化首次私信，执行10项发送前检查（负责账号、勿扰、重复、历史触达、账号健康、频率、事实核验、平台规则、审批策略、发送能力），仅在平台确认后记为已发送，否则进入人工审核/人工发送流程。',
  input: outreachSkillInput,
  async run(ctx, input) {
    switch (input.action) {
      case 'prepare':
        return prepareOutreach(ctx, need(input.lead_id, 'lead_id'), { kind: input.kind, actor: input.actor });
      case 'approve':
        return approveOutreach(ctx, need(input.outreach_id, 'outreach_id'), need(input.actor, 'actor'), input.edited_message);
      case 'send':
        return sendOutreach(ctx, need(input.outreach_id, 'outreach_id'));
      case 'mark_sent':
        return markOutreachSentManually(ctx, need(input.outreach_id, 'outreach_id'), need(input.actor, 'actor'));
      case 'cancel':
        return cancelOutreach(ctx, need(input.outreach_id, 'outreach_id'), need(input.actor, 'actor'), need(input.reason, 'reason'));
    }
  },
  validateOutput(output) {
    if (output.status === 'SENT' && !output.provider_message_id) throw new Error('outreach: SENT requires a provider_message_id');
  },
});
