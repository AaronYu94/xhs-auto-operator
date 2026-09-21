/**
 * Re-screen leads that were created before the LLM screen existed (or while no LLM was configured).
 *
 * The rules alone nominate roughly three non-buyers per buyer on real Xiaohongshu comment threads (owners who already
 * ordered, salespeople in the comments, people advising others). This runs the same screen (llm-screen.ts) over the
 * stored signals of open leads and closes the ones that are not buyers, through the normal CRM path: LOST with a
 * reason, owning account released, undelivered outreach cancelled. Nothing is deleted, leads a human already worked
 * (CONTACTED or deeper, WON / LOST) are never touched, and a lead whose screen fails is left exactly as it is.
 */
import type { AppContext } from '../../../app/context.ts';
import type { Lead } from '../../../core/types.ts';
import { getDealer } from '../../operations/dealer-brain/index.ts';
import { STAGE_INDEX, transitionLead } from '../../operations/crm/index.ts';
import { getActiveAssignment, releaseAssignment } from '../account-assignment/index.ts';
import { SCREEN_ROLE_LABEL, areaLabel, inTargetArea, screenCandidates, type ScreenItem, type ScreenRole } from './llm-screen.ts';
import { targetAreaFor } from './index.ts';

const ACTOR = 'agent:lead-hunting-agent';
export const RESCREEN_LOST_REASON = 'llm_screen';

export interface RescreenInput {
  dealer_id: string;
  /** how many leads to check (default 200) */
  limit?: number;
  /** also close buyers outside the goal / store area (default true) */
  apply_area?: boolean;
}

export interface RescreenSummary {
  checked: number;
  kept: number;
  closed: number;
  closed_by_role: Partial<Record<ScreenRole | 'out_of_area', number>>;
  /** leads whose screen produced no valid verdict: left untouched */
  unscreened: number;
  failures: string[];
}

interface Candidate {
  lead: Lead;
  items: (ScreenItem & { post_title: string; post_content: string; lead_id: string })[];
}

/** Open leads (before CONTACTED) whose signals were never screened by an LLM. */
function candidates(ctx: AppContext, dealerId: string, limit: number): Candidate[] {
  const leads = ctx.db
    .table('leads')
    .findMany({ dealer_id: dealerId }, { orderBy: 'score DESC, created_at ASC' })
    .filter((l) => l.stage !== 'WON' && l.stage !== 'LOST' && STAGE_INDEX[l.stage] < STAGE_INDEX.CONTACTED);
  const out: Candidate[] = [];
  for (const lead of leads) {
    if (out.length >= limit) break;
    const signals = ctx.db.table('lead_signals').findMany({ lead_id: lead.id }, { orderBy: 'signal_at DESC, id ASC' });
    if (signals.length === 0) continue;
    if (signals.some((s) => s.evidence.some((e) => e.code === 'llm_screen'))) continue; // already screened
    const items: Candidate['items'] = [];
    for (const [i, s] of signals.entries()) {
      const comment = s.public_comment_id ? ctx.db.table('public_comments').get(s.public_comment_id) : undefined;
      const post = ctx.db.table('public_posts').get(comment?.public_post_id ?? s.public_post_id ?? '');
      const parent = comment?.parent_comment_id
        ? (ctx.db.get<{ content: string }>('SELECT content FROM public_comments WHERE platform_comment_id = ?', comment.parent_comment_id)?.content ?? null)
        : null;
      items.push({
        id: `${lead.id}#${i}`,
        lead_id: lead.id,
        source_type: s.source_type === 'post' ? 'post' : 'comment',
        text: s.content,
        author_nickname: lead.username,
        ip_location: comment?.ip_location ?? post?.ip_location ?? null,
        reply_to: parent,
        post_title: post?.title ?? '',
        post_content: post?.content ?? '',
      });
    }
    out.push({ lead, items });
  }
  return out;
}

/** Store each verdict as `llm_screen` evidence on its signal (the quote is already verbatim from that signal). */
function markScreened(ctx: AppContext, items: Candidate['items'], verdicts: Map<string, { role: string; quote: string; reason: string }>): void {
  const signals = ctx.db.table('lead_signals');
  ctx.db.tx(() => {
    for (const item of items) {
      const v = verdicts.get(item.id);
      if (!v) continue;
      const id = item.id.slice(item.id.indexOf('#') + 1);
      const signal = signals.findMany({ lead_id: item.lead_id }, { orderBy: 'signal_at DESC, id ASC' })[Number(id)];
      if (!signal || signal.evidence.some((e) => e.code === 'llm_screen')) continue;
      signals.update(signal.id, { evidence: [...signal.evidence, { code: 'llm_screen', label: `大模型复核：${v.reason}`, quote: v.quote }] });
    }
  });
}

/**
 * Re-screen and close non-buyers. Without an LLM nothing is closed (the rules made these leads in the first place).
 */
export async function rescreenLeads(ctx: AppContext, input: RescreenInput): Promise<RescreenSummary> {
  const dealer = getDealer(ctx, input.dealer_id);
  const limit = Number.isInteger(input.limit) && (input.limit ?? 0) > 0 ? (input.limit as number) : 200;
  const summary: RescreenSummary = { checked: 0, kept: 0, closed: 0, closed_by_role: {}, unscreened: 0, failures: [] };
  if (ctx.llm.status().status !== 'AVAILABLE') {
    summary.failures.push(`LLM 不可用，未做任何改动：${ctx.llm.status().reason}`);
    return summary;
  }
  const area = input.apply_area === false ? null : targetAreaFor(ctx, dealer, null);
  const brands = dealer.brands;
  const list = candidates(ctx, dealer.id, limit);
  summary.checked = list.length;

  for (const { lead, items } of list) {
    const out = await screenCandidates(ctx, { title: items[0].post_title, content: items[0].post_content }, items, brands);
    summary.failures.push(...out.failures.filter((f) => !summary.failures.includes(f)).slice(0, 3));
    const verdicts = items.map((i) => out.verdicts.get(i.id)).filter((v) => v !== undefined);
    if (verdicts.length === 0) {
      summary.unscreened++;
      continue;
    }
    const buyer = verdicts.find((v) => v.role === 'buyer');
    const where = buyer ? inTargetArea(area, items[0].ip_location, buyer.location) : null;
    if (buyer && (!where || where.inside)) {
      // record the verdict on the signal it quotes, so a later re-run skips this lead instead of paying for it again
      markScreened(ctx, items, out.verdicts);
      summary.kept++;
      continue;
    }
    const key: ScreenRole | 'out_of_area' = buyer ? 'out_of_area' : verdicts[0].role;
    const detail = buyer ? (where?.detail ?? '') : `${SCREEN_ROLE_LABEL[verdicts[0].role]}：“${verdicts[0].quote}”`;
    const reason = `大模型复核（不是本地在市买家）：${detail}`;
    ctx.audit.event({ actor: ACTOR, action: 'lead.rescreened', entity_type: 'lead', entity_id: lead.id, details: { role: key, reason, target_area: areaLabel(area) } });
    transitionLead(ctx, lead.id, 'LOST', { reason: RESCREEN_LOST_REASON, actor: ACTOR });
    if (getActiveAssignment(ctx, lead.id)) releaseAssignment(ctx, lead.id, reason, ACTOR);
    summary.closed++;
    summary.closed_by_role[key] = (summary.closed_by_role[key] ?? 0) + 1;
  }
  return summary;
}
