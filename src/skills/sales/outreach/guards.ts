/**
 * Pre-send guard pipeline (ARCHITECTURE §6) shared by first touches, follow-ups and manual-send checks.
 * Order and semantics are binding: a failed check with blocking=true stops the outreach (BLOCKED); blocking=false
 * routes it to a human (READY_FOR_REVIEW / APPROVED awaiting manual send). Read-only.
 */
import type { AppContext } from '../../../app/context.ts';
import { addDays, startOfLocalDay } from '../../../core/time.ts';
import type { CapabilityStatus, FactRef, GuardResult, Lead, OutreachKind } from '../../../core/types.ts';
import { getActiveAssignment } from '../../acquisition/account-assignment/index.ts';
import { effectiveOutreachPolicy, requireAccount } from '../../operations/account-brain/index.ts';
import { isAccountOperable } from '../../operations/account-health/index.ts';
import { checkPlatformRules, isNearDuplicate } from '../../operations/compliance/index.ts';
import { isSuppressed } from '../../operations/crm/index.ts';
import { getProhibitedClaims, verifyClaims } from '../../operations/dealer-brain/index.ts';
import { MAX_OUTREACH_CHARS } from './composer.ts';

export const LIVE_FIRST_TOUCH_STATUSES = ['READY_FOR_REVIEW', 'APPROVED', 'SENT', 'SENT_MANUALLY'] as const;
export const PENDING_STATUSES = ['DRAFT', 'READY_FOR_REVIEW', 'APPROVED'] as const;
export const SENT_STATUSES = ['SENT', 'SENT_MANUALLY'] as const;
export const NEAR_DUPLICATE_THRESHOLD = 0.85;
export const NEAR_DUPLICATE_WINDOW = 50;

export interface SendGuardInput {
  lead: Lead;
  account_id: string;
  message: string;
  fact_refs: FactRef[];
  kind: OutreachKind;
  /** a human (or the AUTO policy) approved this exact text */
  human_approved?: boolean;
  /** send_messages capability for the sending account */
  capability: CapabilityStatus;
  /** the outreach row being checked (excluded from duplicate / history comparisons) */
  outreach_id?: string | null;
}

const inList = (values: readonly string[]) => values.map((s) => `'${s}'`).join(', ');

function pass(check: GuardResult['check'], detail: string): GuardResult {
  return { check, passed: true, blocking: false, detail };
}
function fail(check: GuardResult['check'], blocking: boolean, detail: string): GuardResult {
  return { check, passed: false, blocking, detail };
}

interface Touch {
  id: string;
  account_id: string;
  kind: OutreachKind;
  status: string;
  sent_at: string | null;
}

function otherOutreach(ctx: AppContext, leadId: string, excludeId: string | null | undefined): Touch[] {
  return ctx.db.all<Touch>(
    'SELECT id, account_id, kind, status, sent_at FROM outreach WHERE lead_id = ? AND id <> ? ORDER BY created_at ASC, rowid ASC',
    leadId,
    excludeId ?? '',
  );
}

/** Inbound messages from the lead (optionally only after an instant). */
export function inboundCount(ctx: AppContext, leadId: string, after?: string | null): number {
  const row = ctx.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.lead_id = ? AND m.direction = 'inbound'${after ? ' AND m.created_at > ?' : ''}`,
    ...(after ? [leadId, after] : [leadId]),
  );
  return Number(row?.n ?? 0);
}

function refusedInConversation(ctx: AppContext, leadId: string): boolean {
  const row = ctx.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.lead_id = ? AND m.direction = 'inbound' AND m.intents LIKE '%"not_interested"%'`,
    leadId,
  );
  return Number(row?.n ?? 0) > 0;
}

/** Run the ten pre-send checks in ARCHITECTURE §6 order. Every check is always evaluated and reported. */
export function runSendGuards(ctx: AppContext, input: SendGuardInput): GuardResult[] {
  const { lead, message, kind } = input;
  const account = requireAccount(ctx, input.account_id);
  const policy = effectiveOutreachPolicy(ctx, account.id);
  const results: GuardResult[] = [];
  const others = otherOutreach(ctx, lead.id, input.outreach_id);
  const sentTouches = others.filter((o) => (SENT_STATUSES as readonly string[]).includes(o.status) && o.sent_at);

  // 1. ownership
  const assignment = getActiveAssignment(ctx, lead.id);
  if (!assignment) results.push(fail('ownership', true, '线索没有负责账号，不能触达'));
  else if (assignment.account_id !== account.id)
    results.push(fail('ownership', true, `发送账号「${account.nickname}」不是该线索的负责账号`));
  else results.push(pass('ownership', `负责账号「${account.nickname}」`));

  // 2. negative feedback / do-not-contact
  const suppression = isSuppressed(ctx, lead.platform_user_id, lead.platform);
  if (suppression || lead.suppressed)
    results.push(fail('negative_feedback', true, `用户在勿扰名单中：${suppression?.reason ?? lead.suppression_reason ?? '已屏蔽'}`));
  else if ((lead.evidence ?? []).some((e) => e.code === 'not_interested') || refusedInConversation(ctx, lead.id))
    results.push(fail('negative_feedback', true, '用户明确表示不需要/不感兴趣'));
  else if (lead.stage === 'LOST') results.push(fail('negative_feedback', true, `线索已流失：${lead.lost_reason ?? '未注明原因'}`));
  else results.push(pass('negative_feedback', '无负面反馈、不在勿扰名单'));

  // 3. duplicate
  if (kind === 'first_touch') {
    const live = others.find((o) => o.kind === 'first_touch' && (LIVE_FIRST_TOUCH_STATUSES as readonly string[]).includes(o.status));
    if (live) {
      const owner = live.account_id === account.id ? '本账号' : '其他账号';
      results.push(fail('duplicate', true, `${owner}已有一条有效首次私信（${live.status}），同一用户只能收到一条`));
    } else results.push(pass('duplicate', '没有其他有效的首次私信'));
  } else {
    const pending = others.find((o) => o.kind === 'follow_up' && (PENDING_STATUSES as readonly string[]).includes(o.status));
    if (pending) results.push(fail('duplicate', true, `已有一条待处理的跟进私信（${pending.status}）`));
    else results.push(pass('duplicate', '没有待处理的跟进私信'));
  }

  // 4. previous contact
  const lastSent = sentTouches.reduce<Touch | null>((a, b) => (!a || (b.sent_at ?? '') > (a.sent_at ?? '') ? b : a), null);
  if (kind === 'first_touch') {
    if (lead.stage === 'WON') results.push(fail('previous_contact', true, '客户已成交，不再发送获客私信'));
    else if (lastSent) results.push(fail('previous_contact', true, `该用户已于 ${lastSent.sent_at} 被触达过，不能再发首次私信`));
    else if (inboundCount(ctx, lead.id) > 0) results.push(fail('previous_contact', true, '客户已有回复，请在对话中继续沟通'));
    else results.push(pass('previous_contact', '此前未触达该用户'));
  } else if (!lastSent) {
    results.push(fail('previous_contact', true, '尚未发送过首次私信，不能跟进'));
  } else {
    const repliedAfter = inboundCount(ctx, lead.id, lastSent.sent_at) > 0;
    const lastInbound = ctx.db.get<{ at: string | null }>(
      `SELECT MAX(m.created_at) AS at FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.lead_id = ? AND m.direction = 'inbound'`,
      lead.id,
    )?.at;
    const unanswered = sentTouches.filter((t) => !lastInbound || (t.sent_at ?? '') > lastInbound).length;
    const days = (ctx.clock.now().getTime() - Date.parse(lastSent.sent_at ?? '')) / 86_400_000;
    if (repliedAfter) results.push(fail('previous_contact', true, '客户已回复，请在对话中跟进，不再发送跟进私信'));
    else if (unanswered >= policy.max_unanswered_touches)
      results.push(fail('previous_contact', true, `已连续触达${unanswered}次未回复（上限${policy.max_unanswered_touches}次），停止跟进`));
    else if (days < policy.follow_up_after_days)
      results.push(fail('previous_contact', true, `距上次触达仅${days.toFixed(1)}天，需满${policy.follow_up_after_days}天再跟进`));
    else results.push(pass('previous_contact', `上次触达${days.toFixed(1)}天前，未回复${unanswered}次`));
  }

  // 5. account health
  const operable = isAccountOperable(ctx, account.id);
  if (operable.blocking) results.push(fail('account_health', true, operable.reason));
  else if (!operable.ok) results.push(fail('account_health', false, operable.reason));
  else results.push(pass('account_health', operable.reason));

  // 6. rate limit (dealer-local day)
  const now = ctx.clock.now();
  const dayStart = startOfLocalDay(now, policy.timezone);
  const dayEnd = addDays(dayStart, 1);
  const accountSent = ctx.db.all<{ sent_at: string }>(
    `SELECT sent_at FROM outreach WHERE account_id = ? AND id <> ? AND status IN (${inList(SENT_STATUSES)}) AND sent_at IS NOT NULL
     ORDER BY sent_at DESC`,
    account.id,
    input.outreach_id ?? '',
  );
  const today = accountSent.filter((r) => r.sent_at >= dayStart.toISOString() && r.sent_at < dayEnd.toISOString()).length;
  const minutesSinceLast = accountSent[0] ? (now.getTime() - Date.parse(accountSent[0].sent_at)) / 60_000 : Number.POSITIVE_INFINITY;
  if (today >= policy.daily_limit) results.push(fail('rate_limit', false, `今日已发送${today}条，达到每日上限${policy.daily_limit}条`));
  else if (minutesSinceLast < policy.min_interval_minutes)
    results.push(fail('rate_limit', false, `距本账号上一条私信仅${Math.floor(minutesSinceLast)}分钟，需间隔${policy.min_interval_minutes}分钟`));
  else results.push(pass('rate_limit', `今日已发送${today}/${policy.daily_limit}条`));

  // 7. factual verification (facts of the sending account's store)
  const check = verifyClaims(ctx, account.dealer_id, message, input.fact_refs);
  if (!check.passed) results.push(fail('factual_verification', true, check.issues.join('；')));
  else results.push(pass('factual_verification', check.verified.length > 0 ? `已核实${check.verified.length}项门店事实` : '不含需核实的事实表述'));

  // 8. platform rules + mass-template guard
  const prohibited = getProhibitedClaims(ctx, account.dealer_id).map((p) => ({ phrase: p.phrase, reason: p.reason }));
  const rules = checkPlatformRules(message, { prohibited, max_length: MAX_OUTREACH_CHARS, channel: 'dm' });
  const history = ctx.db
    .all<{ message: string }>(
      `SELECT message FROM outreach WHERE account_id = ? AND lead_id <> ? AND id <> ? AND status IN ('READY_FOR_REVIEW', 'APPROVED', 'SENT', 'SENT_MANUALLY')
       ORDER BY created_at DESC LIMIT ${NEAR_DUPLICATE_WINDOW}`,
      account.id,
      lead.id,
      input.outreach_id ?? '',
    )
    .map((r) => r.message);
  const dup = isNearDuplicate(message, history, NEAR_DUPLICATE_THRESHOLD);
  const ruleIssues = rules.issues.map((i) => (i.quote ? `${i.message}（“${i.quote}”）` : i.message));
  if (dup.duplicate) ruleIssues.push(`与本账号近期私信高度相似（相似度${dup.max_similarity}），疑似群发模板`);
  if (ruleIssues.length > 0) results.push(fail('platform_rules', true, ruleIssues.join('；')));
  else results.push(pass('platform_rules', '符合平台规则：无联系方式/链接/禁用词，非群发模板'));

  // 9. approval policy
  if (policy.policy === 'DISABLED') results.push(fail('approval_policy', true, '该账号私信策略为 DISABLED，禁止发送'));
  else if (input.human_approved) results.push(pass('approval_policy', '已审核通过'));
  else if (policy.policy === 'REVIEW_REQUIRED') results.push(fail('approval_policy', false, '策略要求人工审核后发送'));
  else if (lead.score < policy.auto_send_min_score)
    results.push(fail('approval_policy', false, `线索分${lead.score}低于自动发送阈值${policy.auto_send_min_score}，需人工审核`));
  else results.push(pass('approval_policy', `AUTO 策略且线索分${lead.score}≥${policy.auto_send_min_score}`));

  // 10. provider capability
  if (input.capability !== 'AVAILABLE')
    results.push(fail('provider_capability', false, `私信发送能力为 ${input.capability}：需由负责账号在小红书人工发送`));
  else results.push(pass('provider_capability', '私信发送能力可用'));

  return results;
}

export const hasBlocking = (guards: readonly GuardResult[]) => guards.some((g) => !g.passed && g.blocking);
export const hasReview = (guards: readonly GuardResult[]) => guards.some((g) => !g.passed && !g.blocking);
export const blockingReason = (guards: readonly GuardResult[]) =>
  guards
    .filter((g) => !g.passed && g.blocking)
    .map((g) => `${g.check}: ${g.detail}`)
    .join(' | ');
