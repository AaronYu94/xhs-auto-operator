/**
 * Result types of the business-outcome analytics module (spec §16–19, §26).
 * Every number is computed from real tables at read time — nothing here is static or estimated
 * beyond the documented pipeline weighting (estimated_value × STAGE_WIN_PROBABILITY).
 */
import type {
  AccountType,
  AccountStatus,
  AgentDecision,
  Appointment,
  AssignmentCandidate,
  AuditEvent,
  AuthState,
  ContactSuppression,
  ContentPillar,
  Conversation,
  ConversationMessage,
  Conversion,
  HealthState,
  Lead,
  LeadAssignment,
  LeadScore,
  LeadSignal,
  LeadStage,
  LeadStageTransition,
  Outreach,
  OutreachStatus,
  PublicComment,
  PublicPost,
  PurchaseStage,
  ScoreTier,
  SignalSourceType,
} from '../../../core/types.ts';

/**
 * Filters shared by every analytics view (ARCHITECTURE §8 B4).
 * - `dealer_id`: leads / posts / search runs / accounts of that dealer.
 * - `account_id`: leads whose ACTIVE assignment is that account; posts of that account; the account's dealer for
 *   dealer-level data (search runs, workflow runs).
 * - `brand` / `model`: lead `intent.brand` / `intent.model` (case-insensitive; aliases such as 宝马/3系 are canonicalized);
 *   `posts.model`; search-query brand/model for discovery counts.
 * - `location`: lead `intent.location` OR `intent.province` (a province also matches leads whose city lies in it).
 * - `from` / `to`: ISO-8601 datetimes (UTC) or `YYYY-MM-DD` dealer-local dates (`to` date is inclusive).
 * - `source_type`: the lead has at least one signal of that type.
 * - `stage`: the lead's current funnel stage.
 */
export interface AnalyticsFilters {
  dealer_id?: string;
  account_id?: string;
  brand?: string;
  model?: string;
  location?: string;
  from?: string;
  to?: string;
  source_type?: SignalSourceType;
  stage?: LeadStage;
}

/** Half-open reporting window `[from, to)` in UTC ISO, plus the dealer timezone used to derive it. */
export interface AnalyticsPeriod {
  from: string;
  to: string;
  timezone: string;
  /** true when the window is exactly the dealer-local current day (default period) */
  is_today: boolean;
}

export type ExceptionSeverity = 'high' | 'medium' | 'low';

export const EXCEPTION_KINDS = [
  'conversations_needs_human',
  'outreach_review',
  'appointments_unconfirmed',
  'outreach_manual_send',
  'posts_in_review',
  'reply_drafts',
  'engagement_replies_review',
  'qualified_unassigned',
  'accounts_attention',
  'workflow_failed',
  'outreach_blocked',
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

/** One item of the "需要你处理" list — only kinds with count > 0 are returned. */
export interface DashboardException {
  kind: ExceptionKind;
  /** Chinese title shown in the exception table */
  title: string;
  count: number;
  severity: ExceptionSeverity;
  /** operator-console link to the filtered list that resolves this exception */
  href: string;
}

/** An account that needs the operator's attention (latest health not HEALTHY, or never computed). */
export interface AccountAttention {
  account_id: string;
  nickname: string;
  /** latest AccountHealth state; null when no snapshot exists */
  state: HealthState | null;
  issues: string[];
}

/** Pipeline value of one open stage. */
export interface PipelineStageValue {
  stage: LeadStage;
  count: number;
  /** Σ estimated_value × STAGE_WIN_PROBABILITY[stage], integer CNY */
  value: number;
}

/** TODAY dashboard (spec §17, §26). Period metrics use `period`; snapshot metrics describe "now". */
export interface DashboardMetrics {
  period: AnalyticsPeriod;
  generated_at: string;
  content: {
    /** posts PUBLISHED with published_at in period */
    posts_published: number;
    /** Σ metrics.views of those posts (0 when the provider exposes no views) */
    views: number;
    /** Σ likes + collects + comments + shares of those posts */
    engagement: number;
    /** post slots whose slot_date falls in the period's local dates (all statuses except REJECTED) */
    posts_planned: number;
    /** posts currently IN_REVIEW */
    posts_pending_approval: number;
  };
  discovery: {
    /** Σ search_runs.posts_discovered for runs started in period */
    posts_scanned: number;
    /** Σ search_runs.comments_scanned for runs started in period */
    comments_scanned: number;
    /** Σ search_runs.users_evaluated for runs started in period */
    users_evaluated: number;
    /** distinct leads that entered CANDIDATE-or-deeper in period (lead_stage_transitions) */
    candidates: number;
    /** distinct leads that entered QUALIFIED-or-deeper in period */
    qualified: number;
    /** of `qualified`, leads whose current tier is high_intent or immediate */
    high_intent: number;
  };
  outreach: {
    /** outreach currently READY_FOR_REVIEW or APPROVED */
    outreach_ready: number;
    /** distinct leads that entered CONTACTED-or-deeper in period */
    contacted: number;
    /** inbound conversation messages received in period */
    replies: number;
    /** distinct leads with an inbound message in period ÷ contacted (0 when none, capped at 1) */
    reply_rate: number;
  };
  sales: {
    sales_qualified: number;
    contacts_acquired: number;
    appointments: number;
    visits: number;
    won: number;
    lost: number;
  };
  pipeline: {
    /** Σ over open leads (QUALIFIED..NEGOTIATING, not suppressed) of estimated_value × win probability, integer CNY */
    estimated_value: number;
    by_stage: PipelineStageValue[];
  };
  accounts: {
    /** accounts with status 'active' */
    active: number;
    /** accounts whose latest health snapshot is HEALTHY */
    healthy: number;
    requiring_attention: AccountAttention[];
  };
  exceptions: DashboardException[];
  /** "AI employee" TODAY lines in Chinese, built only from the numbers above */
  briefing: string[];
}

/** Lead Inbox card (spec §18): everything a salesperson needs at a glance — the original signal is never hidden. */
export interface LeadCard {
  lead_id: string;
  dealer_id: string;
  username: string;
  platform_user_id: string;
  profile_url: string | null;
  score: number;
  tier: ScoreTier;
  /** 立即跟进 / 高意向 / 合格 / 候选 / 未达候选 */
  tier_label: string;
  /** e.g. 'BMW i3 eDrive35L'; '车型未明确' when no model/brand was detected */
  model_label: string;
  /** stated city or province; 'IP属地：浙江' when only the IP location is known; '地区未知' otherwise */
  location_label: string;
  purchase_stage: PurchaseStage | null;
  /** Chinese purchase-stage label, null when unknown */
  purchase_stage_label: string | null;
  /** distinct evidence labels (max 6) explaining WHY the lead was detected */
  intent_chips: string[];
  source: {
    type: SignalSourceType | null;
    post_title: string | null;
    url: string | null;
    signal_at: string | null;
    /** the search that found this lead: query text, its search run and the workflow run it belonged to */
    query_text: string | null;
    search_run_id: string | null;
    workflow_run_id: string | null;
    searched_at: string | null;
  };
  /** id of the signal shown as original_signal (primary signal, else strongest, else latest) */
  original_signal_id: string | null;
  /** verbatim content of that signal ('' only when the lead has no stored signal at all) */
  original_signal: string;
  signal_count: number;
  last_signal_at: string;
  /** public avatar of the person (proxied when displayed); null when the platform never showed one */
  avatar_url: string | null;
  assigned_account: { id: string; nickname: string; account_type: AccountType; avatar_url: string | null } | null;
  stage: LeadStage;
  /** live recommended next action (CRM computeNextAction) */
  next_action: string;
  /** status of the most recent outreach for the lead */
  outreach_status: OutreachStatus | null;
  suppressed: boolean;
}

/** A stored signal with the public post/comment rows it came from. */
export interface LeadSignalDetail {
  signal: LeadSignal;
  is_primary: boolean;
  public_post: PublicPost | null;
  public_comment: PublicComment | null;
}

/** Complete lead record for the lead detail page. */
export interface LeadDetail {
  lead: Lead;
  card: LeadCard;
  dealer: { id: string; name: string };
  /** chronological (signal_at ASC) */
  signals: LeadSignalDetail[];
  /** score history (computed_at ASC) */
  scores: LeadScore[];
  /** current active assignment */
  assignment: LeadAssignment | null;
  /** ranking of the active assignment (or of the latest assignment when none is active) */
  candidates: AssignmentCandidate[];
  /** assignment history (assigned_at ASC) */
  assignments: LeadAssignment[];
  /** outreach history (created_at ASC) */
  outreach: Outreach[];
  /** most recently active conversation */
  conversation: Conversation | null;
  /** messages of `conversation` (created_at ASC) */
  messages: ConversationMessage[];
  /** every conversation of the lead (one per account) with its messages */
  conversations: { conversation: Conversation; messages: ConversationMessage[] }[];
  appointments: Appointment[];
  conversions: Conversion[];
  transitions: LeadStageTransition[];
  /** agent decisions about the lead and its related records (signals, outreach, conversations, …) */
  decisions: AgentDecision[];
  events: AuditEvent[];
  suppression: ContactSuppression | null;
}

/** Content → lead attribution row for one PUBLISHED post (spec §16: "which content actually sells cars"). */
export interface ContentAttributionRow {
  post_id: string;
  dealer_id: string;
  account_id: string;
  account_nickname: string;
  title: string;
  pillar: ContentPillar;
  model: string | null;
  published_at: string | null;
  platform_note_id: string | null;
  views: number;
  /** likes + collects + comments + shares */
  engagement: number;
  /** public comments collected on the matching public_posts row (own_post_id) */
  comments_collected: number;
  /** distinct commenters, excluding our own managed accounts */
  commenter_profiles: number;
  /** leads attributed to the post (see SKILL.md: single-touch attribution) */
  leads: number;
  /** of those, leads that reached QUALIFIED at some point */
  qualified_leads: number;
  conversations: number;
  /** appointments (not cancelled) of attributed leads */
  appointments: number;
  /** distinct attributed leads with a won conversion */
  won: number;
  /** Σ conversions.amount of those won conversions, integer CNY */
  won_value: number;
}

/** One funnel row (spec §14). */
export interface FunnelStage {
  stage: LeadStage;
  /** leads currently at this stage */
  count: number;
  /** leads at this stage or deeper (LOST excluded from the chain; for LOST = count) */
  reached: number;
  /** reached ÷ reached(previous stage); DISCOVERED = 1 when any lead exists; LOST = 0 (not part of the chain) */
  conversion_from_prev: number;
}

/** Account fleet overview row (spec §1, §17 ACCOUNTS). */
export interface AccountOverviewRow {
  account_id: string;
  dealer_id: string;
  nickname: string;
  account_type: AccountType;
  status: AccountStatus;
  auth_state: AuthState;
  /** Account Brain persona name; null when the account has no persona yet (never substituted with the nickname) */
  persona_name: string | null;
  focus_models: string[];
  /** latest AccountHealth; null when never computed */
  health_state: HealthState | null;
  health_score: number | null;
  /** snapshot issues, or ['尚未计算健康度'] when no snapshot exists */
  health_issues: string[];
  health_date: string | null;
  active_leads: number;
  outreach_sent_30d: number;
  reply_rate_30d: number;
  appointments_90d: number;
  won_90d: number;
  posts_published_30d: number;
}
