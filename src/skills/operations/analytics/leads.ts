/**
 * Lead Inbox (spec §18) and lead detail: the original public signal and the owning account are always on the
 * card, next to score, model, location, purchase stage, evidence chips and the live recommended next action.
 */
import type { AppContext } from '../../../app/context.ts';
import { NotFoundError, ValidationError } from '../../../core/errors.ts';
import {
  PURCHASE_STAGES,
  SCORE_TIERS,
  type AccountType,
  type AutomotiveIntent,
  type Evidence,
  type Lead,
  type LeadSignal,
  type OutreachStatus,
  type PublicComment,
  type PublicPost,
  type PurchaseStage,
  type ScoreTier,
} from '../../../core/types.ts';
import { getBrandInfo, modelDisplayName } from '../../../domain/automotive-lexicon.ts';
import { PREFILTER_REASONS } from '../../acquisition/intent-detection/nlu.ts';
import { computeNextAction, getLeadTimeline, isSuppressed } from '../crm/index.ts';
import { joinAnd, leadScope, normalizeFilters, type SqlFragment } from './filters.ts';
import type { AnalyticsFilters, LeadCard, LeadDetail, LeadSignalDetail } from './types.ts';

export interface LeadInboxOptions {
  tier?: ScoreTier;
  /** leave out closed leads (LOST / WON); ignored when `filters.stage` names a stage */
  open_only?: boolean;
  /** default 50, max 500 */
  limit?: number;
  /** default 0 */
  offset?: number;
}

export const DEFAULT_INBOX_LIMIT = 50;
export const MAX_INBOX_LIMIT = 500;
export const MAX_INTENT_CHIPS = 6;
export const UNKNOWN_MODEL_LABEL = '车型未明确';
export const UNKNOWN_LOCATION_LABEL = '地区未知';

export const TIER_LABELS: Readonly<Record<ScoreTier, string>> = {
  immediate: '立即跟进',
  high_intent: '高意向',
  qualified: '合格',
  candidate: '候选',
  none: '未达候选',
};

export const PURCHASE_STAGE_LABELS: Readonly<Record<PurchaseStage, string>> = {
  awareness: '认知了解',
  research: '调研了解',
  comparison: '对比选车',
  price_shopping: '询价比价',
  active_shopping: '积极选购',
  dealer_selection: '选择门店',
  purchase_imminent: '即将购买',
};

/**
 * Prefilter outcome codes ('无购车相关信号', '纯夸赞，无购车意图', …): they explain why a text was NOT a purchase signal,
 * so they never explain a lead's intent and are never shown as intent chips. (`marketing_account` is a warning instead.)
 */
export const NON_INTENT_EVIDENCE_CODES: ReadonlySet<string> = new Set<string>([
  ...PREFILTER_REASONS.filter((reason) => reason !== 'marketing_account'),
  'emoji_only',
]);

/** Evidence that changes how a salesperson treats the lead (already bought, creator, industry, refused) — shown first. */
export const WARNING_EVIDENCE_CODES: ReadonlySet<string> = new Set<string>([
  'already_purchased',
  'content_creator',
  'marketing_account',
  'industry_account',
  'not_interested',
  'negative_feedback',
]);

const cleanText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** 'BMW i3 eDrive35L' from the lead intent; brand only → 'BMW'; nothing → '车型未明确'. */
export function modelLabel(intent: AutomotiveIntent | null | undefined): string {
  const brand = cleanText(intent?.brand);
  const model = cleanText(intent?.model);
  const trim = cleanText(intent?.trim);
  if (model) {
    const base = modelDisplayName(brand, model, 'en');
    return trim ? `${base} ${trim}` : base;
  }
  if (brand) return getBrandInfo(brand)?.brand ?? brand;
  return UNKNOWN_MODEL_LABEL;
}

/**
 * Where the buyer is, never overstating certainty:
 * stated city → stated province → inferred city ('杭州（推断）') → inferred province ('IP属地：浙江'; intent detection only
 * infers a province from the Xiaohongshu IP 属地) → the signal author's raw IP ('IP属地：浙江') → '地区未知'.
 */
export function locationLabel(intent: AutomotiveIntent | null | undefined, ipLocation: string | null | undefined): string {
  const inferred = new Set(Array.isArray(intent?.inferred_fields) ? intent.inferred_fields : []);
  const city = cleanText(intent?.location);
  const province = cleanText(intent?.province);
  const ip = cleanText(ipLocation);
  if (city && !inferred.has('location')) return city;
  if (province && !inferred.has('province')) return province;
  if (city) return `${city}（推断）`;
  if (province) return `IP属地：${province}`;
  if (ip) return `IP属地：${ip}`;
  return UNKNOWN_LOCATION_LABEL;
}

/** Distinct, non-empty evidence labels in the given order (max 6); prefilter noise codes are skipped. */
export function intentChips(evidence: readonly Evidence[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of evidence ?? []) {
    if (typeof e?.code === 'string' && NON_INTENT_EVIDENCE_CODES.has(e.code)) continue;
    const label = cleanText(e?.label);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
    if (out.length >= MAX_INTENT_CHIPS) break;
  }
  return out;
}

/** Every stored signal of the lead: purchase signals first, strongest first, then latest. */
function leadSignals(ctx: AppContext, leadId: string): LeadSignal[] {
  const table = ctx.db.table('lead_signals');
  return ctx.db
    .all(
      `SELECT * FROM lead_signals WHERE lead_id = ?
       ORDER BY is_purchase_signal DESC, signal_score DESC, signal_at DESC, rowid DESC`,
      leadId,
    )
    .map((row) => table.decode(row));
}

/** The signal that identified the lead: primary signal, else the strongest purchase signal, else the latest. */
function representativeSignal(lead: Lead, signals: readonly LeadSignal[]): LeadSignal | undefined {
  return (lead.primary_signal_id ? signals.find((s) => s.id === lead.primary_signal_id) : undefined) ?? signals[0];
}

/**
 * Chips explaining WHY the lead matters, in priority order: warnings (from any signal), the representative signal's
 * evidence, other purchase signals' evidence (strongest first), then lead-level evidence (e.g. lead research).
 * Evidence carried only by non-purchase remarks (merged for history) is not intent and is left out.
 */
function cardChips(lead: Lead, signals: readonly LeadSignal[], representative: LeadSignal | undefined): string[] {
  const byId = new Map(signals.map((s) => [s.id, s]));
  const leadEvidence = Array.isArray(lead.evidence) ? lead.evidence : [];
  const signalEvidence = (s: LeadSignal) => (Array.isArray(s.evidence) ? s.evidence : []);
  const ordered: Evidence[] = [];
  for (const e of [...leadEvidence, ...signals.flatMap(signalEvidence)]) if (WARNING_EVIDENCE_CODES.has(e?.code)) ordered.push(e);
  if (representative) ordered.push(...signalEvidence(representative));
  for (const s of signals) if (s !== representative && s.is_purchase_signal) ordered.push(...signalEvidence(s));
  for (const e of leadEvidence) {
    const source = typeof e?.source_ref === 'string' ? byId.get(e.source_ref) : undefined;
    if (!source || source.is_purchase_signal || source === representative) ordered.push(e);
  }
  return intentChips(ordered);
}

/** The public note a signal came from (comment-only signals resolve through their comment). */
function signalSources(ctx: AppContext, signal: LeadSignal | undefined): { post: PublicPost | undefined; comment: PublicComment | undefined } {
  const comment = signal?.public_comment_id ? ctx.db.table('public_comments').get(signal.public_comment_id) : undefined;
  const postId = signal?.public_post_id ?? comment?.public_post_id ?? null;
  return { post: postId ? ctx.db.table('public_posts').get(postId) : undefined, comment };
}

/** Build the inbox card for one lead (read-only). */
export function buildLeadCard(ctx: AppContext, lead: Lead): LeadCard {
  const signals = leadSignals(ctx, lead.id);
  const signal = representativeSignal(lead, signals);
  const { post: publicPost, comment: publicComment } = signalSources(ctx, signal);
  // the IP of the person who wrote the signal: the commenter's for comments, the note author's only for post signals
  const ip = publicComment?.ip_location ?? (signal?.source_type === 'post' ? publicPost?.ip_location : null) ?? null;

  const owner = ctx.db.get<{ id: string; nickname: string; account_type: AccountType }>(
    `SELECT x.id AS id, x.nickname AS nickname, x.account_type AS account_type
     FROM lead_assignments a JOIN xhs_accounts x ON x.id = a.account_id
     WHERE a.lead_id = ? AND a.active = 1 LIMIT 1`,
    lead.id,
  );
  const latestOutreach = ctx.db.get<{ status: OutreachStatus }>(
    'SELECT status FROM outreach WHERE lead_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    lead.id,
  );
  const stage = lead.intent?.purchase_stage;
  const purchaseStage = stage && (PURCHASE_STAGES as readonly string[]).includes(stage) ? stage : null;

  return {
    lead_id: lead.id,
    dealer_id: lead.dealer_id,
    username: lead.username,
    platform_user_id: lead.platform_user_id,
    profile_url: lead.profile_url,
    score: lead.score,
    tier: lead.tier,
    tier_label: TIER_LABELS[lead.tier] ?? TIER_LABELS.none,
    model_label: modelLabel(lead.intent),
    location_label: locationLabel(lead.intent, ip),
    purchase_stage: purchaseStage,
    purchase_stage_label: purchaseStage ? PURCHASE_STAGE_LABELS[purchaseStage] : null,
    intent_chips: cardChips(lead, signals, signal),
    source: {
      type: signal?.source_type ?? null,
      post_title: signal?.post_title ?? publicPost?.title ?? null,
      url: publicPost?.url ?? null,
      signal_at: signal?.signal_at ?? null,
      ...searchOrigin(ctx, signal),
    },
    original_signal_id: signal?.id ?? null,
    original_signal: signal?.content ?? '',
    signal_count: lead.signal_count,
    last_signal_at: lead.last_signal_at,
    avatar_url: lead.avatar_url,
    assigned_account: owner
      ? { id: owner.id, nickname: owner.nickname, account_type: owner.account_type, avatar_url: accountAvatar(ctx, owner.id) }
      : null,
    stage: lead.stage,
    next_action: computeNextAction(ctx, lead),
    outreach_status: latestOutreach?.status ?? null,
    suppressed: lead.suppressed,
  };
}

/** The managed account's own avatar, as the last live profile probe stored it (xhs_accounts.platform_profile). */
function accountAvatar(ctx: AppContext, accountId: string): string | null {
  const profile = ctx.db.table('xhs_accounts').get(accountId)?.platform_profile;
  const url = profile && typeof profile === 'object' ? (profile as { avatar_url?: unknown }).avatar_url : null;
  return typeof url === 'string' && url.trim() ? url.trim() : null;
}

/** The search that found a lead: its query text and the run it belonged to (every signal stores both). */
function searchOrigin(
  ctx: AppContext,
  signal: LeadSignal | undefined,
): { query_text: string | null; search_run_id: string | null; workflow_run_id: string | null; searched_at: string | null } {
  const empty = { query_text: null, search_run_id: null, workflow_run_id: null, searched_at: null };
  if (!signal) return empty;
  const query = signal.query_id ? ctx.db.table('search_queries').get(signal.query_id) : undefined;
  const run = signal.search_run_id ? ctx.db.table('search_runs').get(signal.search_run_id) : undefined;
  if (!query && !run) return empty;
  return {
    query_text: query?.text ?? null,
    search_run_id: run?.id ?? null,
    workflow_run_id: run?.workflow_run_id ?? null,
    searched_at: run?.started_at ?? null,
  };
}

function inboxPaging(f: LeadInboxOptions | null | undefined): { tier?: ScoreTier; limit: number; offset: number } {
  const raw = (f ?? {}) as Record<string, unknown>;
  const out: { tier?: ScoreTier; limit: number; offset: number } = { limit: DEFAULT_INBOX_LIMIT, offset: 0 };
  if (raw.tier !== undefined && raw.tier !== null && raw.tier !== '') {
    if (typeof raw.tier !== 'string' || !(SCORE_TIERS as readonly string[]).includes(raw.tier))
      throw new ValidationError('filters.tier', `expected one of ${SCORE_TIERS.join('|')}`);
    out.tier = raw.tier as ScoreTier;
  }
  if (raw.limit !== undefined && raw.limit !== null) {
    if (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > MAX_INBOX_LIMIT)
      throw new ValidationError('filters.limit', `expected integer 1..${MAX_INBOX_LIMIT}`);
    out.limit = raw.limit;
  }
  if (raw.offset !== undefined && raw.offset !== null) {
    if (typeof raw.offset !== 'number' || !Number.isInteger(raw.offset) || raw.offset < 0)
      throw new ValidationError('filters.offset', 'expected integer >= 0');
    out.offset = raw.offset;
  }
  return out;
}

/**
 * Lead cards sorted by score DESC, then last_signal_at DESC (id breaks ties). Explicit `from`/`to` bound
 * `last_signal_at`; without them every matching lead is listed (the inbox is not limited to today).
 */
export function getLeadInbox(ctx: AppContext, f: AnalyticsFilters & LeadInboxOptions = {}): LeadCard[] {
  const n = normalizeFilters(ctx, f);
  const paging = inboxPaging(f);
  const parts: SqlFragment[] = [leadScope(n, 'l')];
  if (paging.tier !== undefined) parts.push({ sql: 'l.tier = ?', params: [paging.tier] });
  if (f.open_only === true && n.stage === undefined) parts.push({ sql: "l.stage NOT IN ('LOST', 'WON')", params: [] });
  if (n.from !== undefined) parts.push({ sql: 'l.last_signal_at >= ?', params: [n.from] });
  if (n.to !== undefined) parts.push({ sql: 'l.last_signal_at < ?', params: [n.to] });
  const where = joinAnd(parts);
  const table = ctx.db.table('leads');
  return ctx.db
    .all(
      `SELECT l.* FROM leads l WHERE ${where.sql}
       ORDER BY l.score DESC, l.last_signal_at DESC, l.id ASC LIMIT ? OFFSET ?`,
      ...where.params,
      paging.limit,
      paging.offset,
    )
    .map((row) => buildLeadCard(ctx, table.decode(row)));
}

/** Everything known about one lead, each list in chronological order. */
export function getLeadDetail(ctx: AppContext, leadId: string): LeadDetail {
  if (typeof leadId !== 'string' || leadId.trim() === '') throw new ValidationError('lead_id', 'required non-empty string');
  const lead = ctx.db.table('leads').get(leadId);
  if (!lead) throw new NotFoundError('lead', leadId);
  const db = ctx.db;
  const card = buildLeadCard(ctx, lead);
  const dealer = db.table('dealers').get(lead.dealer_id);

  const signals: LeadSignalDetail[] = db
    .all('SELECT * FROM lead_signals WHERE lead_id = ? ORDER BY signal_at ASC, created_at ASC, rowid ASC', lead.id)
    .map((row) => db.table('lead_signals').decode(row))
    .map((signal) => {
      const sources = signalSources(ctx, signal);
      return {
        signal,
        is_primary: signal.id === card.original_signal_id,
        public_post: sources.post ?? null,
        public_comment: sources.comment ?? null,
      };
    });

  const scores = db
    .all('SELECT * FROM lead_scores WHERE lead_id = ? ORDER BY computed_at ASC, rowid ASC', lead.id)
    .map((row) => db.table('lead_scores').decode(row));
  const assignments = db
    .all('SELECT * FROM lead_assignments WHERE lead_id = ? ORDER BY assigned_at ASC, rowid ASC', lead.id)
    .map((row) => db.table('lead_assignments').decode(row));
  const assignment = assignments.find((a) => a.active) ?? null;
  const rankingSource = assignment ?? assignments[assignments.length - 1];
  const outreach = db
    .all('SELECT * FROM outreach WHERE lead_id = ? ORDER BY created_at ASC, rowid ASC', lead.id)
    .map((row) => db.table('outreach').decode(row));
  const conversations = db
    .all('SELECT * FROM conversations WHERE lead_id = ? ORDER BY last_message_at DESC, created_at DESC, rowid DESC', lead.id)
    .map((row) => db.table('conversations').decode(row))
    .map((conversation) => ({
      conversation,
      messages: db
        .all('SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC', conversation.id)
        .map((row) => db.table('conversation_messages').decode(row)),
    }));
  const appointments = db
    .all('SELECT * FROM appointments WHERE lead_id = ? ORDER BY created_at ASC, rowid ASC', lead.id)
    .map((row) => db.table('appointments').decode(row));
  const conversions = db
    .all('SELECT * FROM conversions WHERE lead_id = ? ORDER BY occurred_at ASC, rowid ASC', lead.id)
    .map((row) => db.table('conversions').decode(row));
  const timeline = getLeadTimeline(ctx, lead.id);

  return {
    lead,
    card,
    dealer: { id: lead.dealer_id, name: dealer?.name ?? '' },
    signals,
    scores,
    assignment,
    candidates: [...(rankingSource?.candidates ?? [])],
    assignments,
    outreach,
    conversation: conversations[0]?.conversation ?? null,
    messages: conversations[0]?.messages ?? [],
    conversations,
    appointments,
    conversions,
    transitions: timeline.transitions,
    decisions: timeline.decisions,
    events: timeline.events,
    suppression: isSuppressed(ctx, lead.platform_user_id, lead.platform),
  };
}
