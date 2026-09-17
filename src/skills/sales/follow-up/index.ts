/**
 * Follow-up planner (spec §12): one polite follow-up per silent contacted lead, through the SAME guard pipeline as
 * first touches. Never follows up a user who replied, is on the do-not-contact list, reached the unanswered-touch
 * limit, or was touched less than follow_up_after_days ago. Idempotent per dealer-local day.
 */
import type { AppContext } from '../../../app/context.ts';
import { AppError } from '../../../core/errors.ts';
import { startOfLocalDay } from '../../../core/time.ts';
import type { Outreach } from '../../../core/types.ts';
import { v } from '../../../core/validate.ts';
import { getActiveAssignment } from '../../acquisition/account-assignment/index.ts';
import { defineSkill } from '../../registry.ts';
import { effectiveOutreachPolicy } from '../../operations/account-brain/index.ts';
import { isSuppressed } from '../../operations/crm/index.ts';
import { getDealer } from '../../operations/dealer-brain/index.ts';
import { OUTREACH_ACTOR, PENDING_STATUSES, inboundCount, prepareOutreach } from '../outreach/index.ts';

export interface FollowUpCandidate {
  lead_id: string;
  account_id: string | null;
  last_sent_at: string | null;
  days_since_last_touch: number | null;
  unanswered_touches: number;
  eligible: boolean;
  reason: string;
}

/** Evaluate every CONTACTED lead of the dealer (read-only). */
export function findFollowUpCandidates(ctx: AppContext, dealerId: string): FollowUpCandidate[] {
  const dealer = getDealer(ctx, dealerId);
  const now = ctx.clock.now();
  const dayStart = startOfLocalDay(now, dealer.settings.timezone).toISOString();
  const leads = ctx.db.table('leads').findMany({ dealer_id: dealerId, stage: 'CONTACTED' }, { orderBy: 'score DESC, last_signal_at DESC' });
  return leads.map((lead) => {
    const base = { lead_id: lead.id, account_id: null, last_sent_at: null, days_since_last_touch: null, unanswered_touches: 0 };
    if (lead.suppressed || isSuppressed(ctx, lead.platform_user_id, lead.platform)) return { ...base, eligible: false, reason: '用户在勿扰名单中' };
    const assignment = getActiveAssignment(ctx, lead.id);
    if (!assignment) return { ...base, eligible: false, reason: '线索没有负责账号' };
    const policy = effectiveOutreachPolicy(ctx, assignment.account_id);
    const sent = ctx.db.all<{ sent_at: string }>(
      `SELECT sent_at FROM outreach WHERE lead_id = ? AND status IN ('SENT', 'SENT_MANUALLY') AND sent_at IS NOT NULL ORDER BY sent_at DESC`,
      lead.id,
    );
    const last = sent[0]?.sent_at ?? null;
    const withAccount = { ...base, account_id: assignment.account_id, last_sent_at: last };
    if (!last) return { ...withAccount, eligible: false, reason: '尚无已发送的私信' };
    const lastInbound = ctx.db.get<{ at: string | null }>(
      `SELECT MAX(m.created_at) AS at FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.lead_id = ? AND m.direction = 'inbound'`,
      lead.id,
    )?.at;
    const unanswered = sent.filter((s) => !lastInbound || s.sent_at > lastInbound).length;
    const days = (now.getTime() - Date.parse(last)) / 86_400_000;
    const detail = { ...withAccount, days_since_last_touch: Math.round(days * 10) / 10, unanswered_touches: unanswered };
    if (inboundCount(ctx, lead.id, last) > 0) return { ...detail, eligible: false, reason: '客户已回复，改为对话跟进' };
    if (unanswered >= policy.max_unanswered_touches)
      return { ...detail, eligible: false, reason: `已连续触达${unanswered}次未回复（上限${policy.max_unanswered_touches}次）` };
    if (days < policy.follow_up_after_days) return { ...detail, eligible: false, reason: `未满${policy.follow_up_after_days}天跟进间隔` };
    const pending = ctx.db.table('outreach').count({ lead_id: lead.id, status: [...PENDING_STATUSES] });
    if (pending > 0) return { ...detail, eligible: false, reason: '已有待审核/待发送的私信' };
    const today = ctx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM outreach WHERE lead_id = ? AND kind = 'follow_up' AND status <> 'CANCELLED' AND created_at >= ?`,
      lead.id,
      dayStart,
    );
    if (Number(today?.n ?? 0) > 0) return { ...detail, eligible: false, reason: '今天已生成过跟进私信' };
    return { ...detail, eligible: true, reason: `距上次触达${detail.days_since_last_touch}天，未回复${unanswered}次` };
  });
}

/** Prepare follow-up outreach for every eligible lead; returns the outreach rows created (any status). */
export async function planFollowUps(ctx: AppContext, dealerId: string): Promise<Outreach[]> {
  const candidates = findFollowUpCandidates(ctx, dealerId).filter((c) => c.eligible);
  const created: Outreach[] = [];
  const skipped: { lead_id: string; reason: string }[] = [];
  for (const c of candidates) {
    try {
      created.push(await prepareOutreach(ctx, c.lead_id, { kind: 'follow_up', actor: OUTREACH_ACTOR }));
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      skipped.push({ lead_id: c.lead_id, reason: err.message });
    }
  }
  ctx.audit.event({
    actor: OUTREACH_ACTOR,
    action: 'follow_up.planned',
    entity_type: 'dealer',
    entity_id: dealerId,
    details: {
      candidates: candidates.length,
      created: created.map((o) => ({ outreach_id: o.id, lead_id: o.lead_id, status: o.status })),
      skipped,
    },
  });
  return created;
}

export const skill = defineSkill<{ dealer_id: string }, Outreach[]>({
  name: 'follow-up',
  category: 'sales',
  agent: 'outreach-agent',
  description:
    '为已触达但未回复、满足跟进间隔且未超过未回复触达上限的线索生成一条礼貌的跟进私信，走与首次私信相同的发送前检查；客户已回复、勿扰或已达上限时绝不跟进。',
  input: v.object({ dealer_id: v.string({ min: 1 }) }),
  run(ctx, input) {
    return planFollowUps(ctx, input.dealer_id);
  },
});
