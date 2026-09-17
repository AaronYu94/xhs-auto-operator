/**
 * Canonical domain model for the Automotive Xiaohongshu AI Operations system.
 *
 * Conventions
 * - Persisted entity fields are snake_case and map 1:1 to SQLite columns (see src/db/schema.ts).
 * - Timestamps are ISO-8601 strings (UTC) produced by the injectable Clock.
 * - Money is integer CNY (元). Percentages are 0..1 floats unless named *_pct.
 * - Enumerations are `as const` arrays + derived union types (erasable TypeScript only).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Enumerations
// ─────────────────────────────────────────────────────────────────────────────

export const PLATFORMS = ['xiaohongshu'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Explicit sales funnel (spec §14). Order matters: index = funnel depth. */
export const LEAD_STAGES = [
  'DISCOVERED',
  'CANDIDATE',
  'QUALIFIED',
  'ASSIGNED',
  'OUTREACH_READY',
  'CONTACTED',
  'REPLIED',
  'SALES_QUALIFIED',
  'CONTACT_ACQUIRED',
  'APPOINTMENT',
  'VISITED',
  'NEGOTIATING',
  'WON',
  'LOST',
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

/** Buyer journey stage detected from public signals (spec §7). Order = proximity to purchase. */
export const PURCHASE_STAGES = [
  'awareness',
  'research',
  'comparison',
  'price_shopping',
  'active_shopping',
  'dealer_selection',
  'purchase_imminent',
] as const;
export type PurchaseStage = (typeof PURCHASE_STAGES)[number];

/** Score tiers with configurable thresholds (spec §9). */
export const SCORE_TIERS = ['none', 'candidate', 'qualified', 'high_intent', 'immediate'] as const;
export type ScoreTier = (typeof SCORE_TIERS)[number];

/** Provider capability status (spec §23). */
export const CAPABILITY_STATUSES = ['AVAILABLE', 'UNAVAILABLE', 'REQUIRES_AUTH', 'REQUIRES_REVIEW'] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export const XHS_CAPABILITIES = [
  'search_public_content',
  'read_public_post',
  'read_public_comments',
  'read_public_profile',
  'publish_content',
  'read_engagement',
  'receive_messages',
  'send_messages',
  /** public reply to a comment (used for engagement on our OWN notes, never cold outreach) */
  'reply_comments',
] as const;
export type XhsCapability = (typeof XHS_CAPABILITIES)[number];

/** Send / publish approval policy (spec §12). */
export const APPROVAL_POLICIES = ['AUTO', 'REVIEW_REQUIRED', 'DISABLED'] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

export const ACCOUNT_TYPES = ['official', 'salesperson', 'model_specialist', 'local_guide', 'customer_story'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_STATUSES = ['active', 'paused', 'cooldown', 'disabled'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const AUTH_STATES = ['authenticated', 'requires_auth', 'unknown'] as const;
export type AuthState = (typeof AUTH_STATES)[number];

export const HEALTH_STATES = ['HEALTHY', 'WATCH', 'AT_RISK', 'RESTRICTED'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export const QUERY_CLASSES = [
  'direct_model',
  'competitor',
  'purchase_scenario',
  'transaction_intent',
  'location',
  'derived',
] as const;
export type QueryClass = (typeof QUERY_CLASSES)[number];

export const QUERY_STATUSES = ['active', 'paused', 'retired'] as const;
export type QueryStatus = (typeof QUERY_STATUSES)[number];

export const SIGNAL_SOURCE_TYPES = ['post', 'comment', 'profile', 'reply', 'import'] as const;
export type SignalSourceType = (typeof SIGNAL_SOURCE_TYPES)[number];

export const OUTREACH_KINDS = ['first_touch', 'follow_up'] as const;
export type OutreachKind = (typeof OUTREACH_KINDS)[number];

/**
 * Outreach lifecycle.
 * - BLOCKED: a pre-send guard failed (see guard_results) — never sendable without regeneration.
 * - READY_FOR_REVIEW: passed guards, awaiting human approval OR provider cannot send automatically.
 * - APPROVED: human approved; will be sent via provider if AVAILABLE, else requires manual send.
 * - SENT: provider confirmed delivery (provider_message_id present).
 * - SENT_MANUALLY: a human sent it in the Xiaohongshu app and recorded that fact.
 */
export const OUTREACH_STATUSES = [
  'DRAFT',
  'BLOCKED',
  'READY_FOR_REVIEW',
  'APPROVED',
  'SENT',
  'SENT_MANUALLY',
  'FAILED',
  'CANCELLED',
] as const;
export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];

export const CONVERSATION_INTENTS = [
  'price_query',
  'inventory_query',
  'model_comparison',
  'finance_query',
  'lease_query',
  'trade_in',
  'appointment',
  'contact_exchange',
  'not_interested',
  'general',
] as const;
export type ConversationIntent = (typeof CONVERSATION_INTENTS)[number];

export const CONVERSATION_STATUSES = ['open', 'handed_off', 'closed'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const MESSAGE_STATUSES = ['received', 'draft', 'sent', 'sent_manually', 'discarded'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const APPOINTMENT_STATUSES = ['proposed', 'confirmed', 'visited', 'no_show', 'cancelled'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const POST_STATUSES = [
  'PLANNED',
  'DRAFTED',
  'CHANGES_REQUIRED',
  'IN_REVIEW',
  'APPROVED',
  'SCHEDULED',
  'READY_TO_PUBLISH',
  'PUBLISHED',
  'FAILED',
  'REJECTED',
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const CONTENT_PILLARS = [
  'model_review',
  'price_offer',
  'inventory_showcase',
  'comparison',
  'buying_guide',
  'finance_explainer',
  'customer_story',
  'local_life',
  'dealer_event',
  'ownership_tips',
] as const;
export type ContentPillar = (typeof CONTENT_PILLARS)[number];

export const PLAN_STATUSES = ['draft', 'active', 'completed', 'archived'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const WORKFLOW_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL', 'CANCELLED'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const STEP_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const WORKFLOW_TRIGGERS = ['schedule', 'manual', 'goal', 'api', 'resume'] as const;
export type WorkflowTrigger = (typeof WORKFLOW_TRIGGERS)[number];

export const KNOWLEDGE_CATEGORIES = [
  'brand',
  'communication_guideline',
  'prohibited_claim',
  'store',
  'salesperson',
  'campaign',
  'faq',
  'policy',
] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

export const INVENTORY_STATUSES = ['in_stock', 'in_transit', 'reserved', 'sold'] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

export const OFFER_TYPES = ['cash_discount', 'finance', 'lease', 'trade_in', 'gift', 'campaign'] as const;
export type OfferType = (typeof OFFER_TYPES)[number];

export const GOAL_TYPES = ['lead_generation', 'content_campaign', 'daily_operations', 'reporting'] as const;
export type GoalType = (typeof GOAL_TYPES)[number];

export const GOAL_STATUSES = ['active', 'completed', 'paused', 'failed'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const DECISION_TYPES = [
  'lead_prefilter',
  'intent_detection',
  'lead_qualification',
  'lead_score',
  'lead_dedup_merge',
  'account_assignment',
  'outreach_generation',
  'outreach_guard',
  'conversation_reply',
  'sales_qualification',
  'appointment',
  'content_strategy',
  'content_plan',
  'content_generation',
  'content_fact_review',
  'content_duplicate_review',
  'query_generation',
  'query_optimization',
  'goal_planning',
  'account_health',
  'optimization',
  'research',
  'engagement_reply',
  'report',
  'lead_research',
] as const;
export type DecisionType = (typeof DECISION_TYPES)[number];

export const ENGINES = ['rules', 'llm', 'llm+rules', 'human'] as const;
export type Engine = (typeof ENGINES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Shared value objects (stored as JSON columns)
// ─────────────────────────────────────────────────────────────────────────────

/** A single piece of evidence. `quote` MUST be a verbatim substring of the source text when present. */
export interface Evidence {
  /** machine code, e.g. 'inventory_intent', 'specified_trim', 'location_match', 'recent_activity' */
  code: string;
  /** human-readable explanation (Chinese or English) shown to salespeople */
  label: string;
  /** verbatim quote from the source text that supports this evidence */
  quote?: string;
  /** which source this came from (signal id / comment id / post id) */
  source_ref?: string;
}

/** Structured automotive purchase intent (spec §7). All fields optional — only what was detected. */
export interface AutomotiveIntent {
  brand?: string;
  model?: string;
  trim?: string;
  competing_models?: string[];
  location?: string; // normalized city name, e.g. '杭州'
  province?: string; // e.g. '浙江'
  budget_min?: number; // CNY
  budget_max?: number; // CNY
  purchase_timeframe?: string; // normalized: 'this_week' | 'this_month' | 'within_3_months' | 'later' | free text
  price_sensitivity?: 'low' | 'medium' | 'high';
  price_intent?: boolean; // asks price / 落地价
  discount_intent?: boolean; // asks 优惠
  inventory_intent?: boolean; // asks 现车 / 库存 / 提车
  color_intent?: string; // e.g. '白外红内'
  financing_intent?: boolean;
  leasing_intent?: boolean;
  trade_in_intent?: boolean;
  dealer_selection_intent?: boolean; // asks where to buy / recommend a dealer
  visit_intent?: boolean; // wants to go see the car / test drive
  purchase_stage?: PurchaseStage;
  /** 0..1 confidence of the overall extraction */
  confidence?: number;
  /** fields that were inferred from context (e.g. parent post title) rather than stated by the user */
  inferred_fields?: string[];
}

export interface ScoreComponent {
  factor: string; // e.g. 'explicit_purchase_intent', 'model_match', 'recency'
  points: number;
  max: number;
  reason: string;
}

export interface GuardResult {
  check:
    | 'duplicate'
    | 'previous_contact'
    | 'factual_verification'
    | 'account_health'
    | 'rate_limit'
    | 'platform_rules'
    | 'negative_feedback'
    | 'approval_policy'
    | 'provider_capability'
    | 'ownership';
  passed: boolean;
  /** when passed=false: blocking=true stops the outreach; blocking=false routes it to review */
  blocking: boolean;
  detail: string;
}

export interface FactRef {
  /** 'vehicle' | 'inventory' | 'offer' | 'knowledge' | 'dealer' */
  kind: 'vehicle' | 'inventory' | 'offer' | 'knowledge' | 'dealer';
  id: string;
  /** the exact claim text as used in generated content */
  claim: string;
}

export interface AssignmentCandidate {
  account_id: string;
  nickname: string;
  score: number; // 0..100
  eligible: boolean;
  factors: ScoreComponent[];
  excluded_reason?: string;
}

export interface ConversationSlots {
  model?: string;
  trim?: string;
  budget_min?: number;
  budget_max?: number;
  location?: string;
  purchase_timeframe?: string;
  financing?: boolean;
  leasing?: boolean;
  trade_in?: boolean;
  trade_in_vehicle?: string;
  contact_phone?: string; // only when voluntarily provided by the user
  contact_wechat?: string; // only when voluntarily provided by the user
  appointment_intent?: boolean;
  appointment_time_text?: string;
  appointment_at?: string; // ISO when resolvable
  competing_models?: string[];
}

export interface PostMetrics {
  views: number;
  likes: number;
  collects: number;
  comments: number;
  shares: number;
}

export interface PostReview {
  fact_check: { passed: boolean; issues: string[]; verified_claims: FactRef[] };
  duplicate_check: { passed: boolean; max_similarity: number; similar_post_id?: string };
  compliance: { passed: boolean; issues: string[] };
  reviewed_at: string;
}

export interface DealerSettings {
  outreach_approval_policy: ApprovalPolicy;
  publish_approval_policy: ApprovalPolicy;
  /** per-account default max outbound first-touch + follow-up messages per day */
  daily_outreach_limit: number;
  /** min minutes between two outbound messages from the same account */
  min_outreach_interval_minutes: number;
  /** max outbound messages to one lead without any reply */
  max_unanswered_touches: number;
  /** days to wait before follow-up after no reply */
  follow_up_after_days: number;
  daily_publish_limit: number;
  /** max AI-driven turns in a conversation before handing off to a human */
  max_ai_conversation_turns: number;
  /** AUTO send only allowed at or above this lead score (if policy AUTO) */
  auto_send_min_score: number;
  timezone: string; // e.g. 'Asia/Shanghai'
}

export interface ScoringWeights {
  explicit_purchase_intent: number;
  transaction_questions: number;
  model_match: number;
  inventory_match: number;
  location_match: number;
  purchase_stage: number;
  recency: number;
  authenticity: number;
  dealer_relevance: number;
}

export interface ScoringThresholds {
  candidate: number;
  qualified: number;
  high_intent: number;
  immediate: number;
}

export interface GoalSpec {
  type: GoalType;
  brand?: string;
  models: string[];
  location?: string;
  province?: string;
  timeframe?: { label: string; start: string; end: string };
  target_leads?: number;
  notes?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared NLU / scoring contracts (produced by intent-detection, consumed by scoring & discovery)
// ─────────────────────────────────────────────────────────────────────────────

/** Transaction question codes detected in public signals. */
export const TRANSACTION_QUESTIONS = [
  'price', // 多少钱 / 价格
  'landing_price', // 落地价 / 落地多少
  'discount', // 优惠 / 折扣 / 让利
  'inventory', // 现车 / 库存 / 提车周期
  'color_trim_availability', // 特定颜色/内饰/配置是否有
  'finance', // 贷款 / 分期 / 首付 / 利率
  'lease', // 租赁 / 融资租赁 / 以租代购
  'trade_in', // 置换 / 旧车 / 补贴
  'dealer_location', // 哪家店 / 在哪买 / 推荐销售
  'test_drive', // 试驾 / 到店看车
] as const;
export type TransactionQuestion = (typeof TRANSACTION_QUESTIONS)[number];

/**
 * Who is speaking in a public signal (docs/PREVIEW_FINDINGS.md F1/F2):
 * - asker: prospective buyer expressing a need/question → can be a purchase signal
 * - owner: already purchased (提车了/车主/开了半年) → never an acquisition lead
 * - creator: informational/creator content (攻略/测评/体验/分享/一次说清) → never a lead
 * - marketing: dealer/sales/solicitation account → never a lead
 */
export const AUTHOR_ROLES = ['asker', 'owner', 'creator', 'marketing', 'unknown'] as const;
export type AuthorRole = (typeof AUTHOR_ROLES)[number];

export interface SignalContext {
  source_type: SignalSourceType;
  post_title?: string | null;
  post_content?: string | null;
  /** Xiaohongshu IP 属地 (province-level, e.g. '浙江') */
  ip_location?: string | null;
  /** public nickname of the signal author (creator/marketing hints such as '测评', '攻略', '4S店') */
  author_nickname?: string | null;
}

/** What the scoring engine needs to know about the dealer (derived from Dealer Brain). */
export interface DealerProfile {
  dealer_id: string;
  brands: string[]; // canonical, e.g. ['BMW']
  models: string[]; // canonical, e.g. ['i3', 'X3', '3 Series']
  trims: { model: string; trim: string; aliases: string[] }[];
  inventory: {
    model: string;
    trim: string;
    exterior_color: string;
    interior_color: string;
    status: InventoryStatus;
    quantity: number;
  }[];
  city: string; // e.g. '杭州'
  province: string; // e.g. '浙江'
}

export interface PrefilterResult {
  passed: boolean;
  /** machine reason, e.g. 'pure_praise', 'too_short', 'emoji_only', 'marketing_account', 'keyword_hit' */
  reason: string;
  hits: string[];
  is_marketing: boolean;
}

export interface IntentDetection {
  is_purchase_signal: boolean;
  intent: AutomotiveIntent;
  evidence: Evidence[];
  transaction_questions: TransactionQuestion[];
  /** explicit purchase-intent strength 0..1 (awareness≈0.1, research≈0.2, comparison≈0.4, price_shopping≈0.85, active_shopping+≈1) */
  strength: number;
  /** user explicitly declines / not interested */
  negative: boolean;
  engine: Engine;
  /** solicitation / dealer-sales account (also conveyed by evidence code 'marketing_account') */
  is_marketing?: boolean;
  /** speaker classification; owner / creator / marketing are never purchase signals */
  author_role?: AuthorRole;
  /** v3 person classification derived from author_role + detection (src/domain/actor-classification.ts) */
  actor_type?: ActorType;
}

/**
 * v3 (ARCHITECTURE §10.2): who the public author is, decided BEFORE scoring.
 * Only BUYER signals can create acquisition leads; OWNER/CREATOR/DEALER_OR_SALES/ENTHUSIAST never do.
 */
export const ACTOR_TYPES = ['BUYER', 'OWNER', 'CREATOR', 'DEALER_OR_SALES', 'ENTHUSIAST', 'UNKNOWN'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/**
 * v3 (ARCHITECTURE §10.1): provenance of public content and leads.
 * live = fetched from Xiaohongshu through a live provider · simulation = synthetic corpus (never allowed in production)
 * import = operator-supplied JSON of real public content · manual = typed in by a human · unknown = pre-v3 rows.
 */
export const DATA_MODES = ['live', 'simulation', 'import', 'manual', 'unknown'] as const;
export type DataMode = (typeof DATA_MODES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Persisted entities (1:1 with tables)
// ─────────────────────────────────────────────────────────────────────────────

export interface DealerGroup {
  id: string;
  name: string;
  created_at: string;
}

export interface Dealer {
  id: string;
  group_id: string;
  name: string;
  brands: string[];
  city: string;
  province: string;
  address: string;
  business_hours: string;
  phone: string | null;
  settings: DealerSettings;
  created_at: string;
  updated_at: string;
}

/** Source-aware dealership knowledge (brand, guidelines, prohibited claims, stores, salespeople, campaigns, FAQ). */
export interface DealerKnowledge {
  id: string;
  group_id: string;
  dealer_id: string | null; // null = group-wide
  category: KnowledgeCategory;
  key: string; // stable key, e.g. 'prohibited:lowest_price'
  title: string;
  content: string;
  data: Record<string, unknown>;
  source: string; // e.g. 'dealer_price_sheet_2026-09-01.xlsx'
  valid_from: string | null;
  valid_until: string | null;
  updated_at: string;
}

export interface VehicleSpecs {
  powertrain?: 'EV' | 'PHEV' | 'HEV' | 'ICE';
  body_type?: string;
  range_km?: number;
  horsepower?: number;
  torque_nm?: number;
  zero_to_100_s?: number;
  seats?: number;
  length_mm?: number;
  wheelbase_mm?: number;
  battery_kwh?: number;
  fuel_l_per_100km?: number;
  [k: string]: string | number | boolean | undefined;
}

export interface Vehicle {
  id: string;
  group_id: string;
  brand: string; // canonical, e.g. 'BMW'
  brand_zh: string; // e.g. '宝马'
  model: string; // canonical, e.g. 'i3'
  model_zh: string; // e.g. 'i3'
  trim: string; // e.g. 'eDrive35L'
  model_year: number;
  msrp: number; // CNY
  specs: VehicleSpecs;
  highlights: string[];
  aliases: string[]; // e.g. ['35L', 'i3 35L']
  source: string;
  updated_at: string;
}

export interface Inventory {
  id: string;
  dealer_id: string;
  vehicle_id: string;
  vin: string | null;
  exterior_color: string; // e.g. '白'
  interior_color: string; // e.g. '红'
  status: InventoryStatus;
  quantity: number;
  list_price: number | null;
  source: string;
  updated_at: string;
}

export interface Offer {
  id: string;
  dealer_id: string;
  vehicle_id: string | null; // specific trim
  model: string | null; // or whole model line
  type: OfferType;
  title: string;
  description: string;
  amount: number | null; // CNY discount / subsidy
  apr: number | null; // 0..1
  term_months: number | null;
  down_payment_pct: number | null; // 0..1
  conditions: string;
  valid_from: string;
  valid_until: string;
  source: string;
  updated_at: string;
}

export interface XhsAccount {
  id: string;
  group_id: string;
  dealer_id: string;
  platform_account_id: string | null;
  nickname: string;
  account_type: AccountType;
  status: AccountStatus;
  auth_state: AuthState;
  city: string;
  salesperson_name: string | null;
  /** null = inherit dealer settings */
  outreach_approval_policy: ApprovalPolicy | null;
  daily_outreach_limit: number | null;
  daily_publish_limit: number | null;
  /** v3: this account's xiaohongshu-mcp instance (env XHS_MCP_ACCOUNTS wins); unique per account */
  mcp_endpoint_url?: string | null;
  /** v3: Xiaohongshu user id verified from the logged-in session (guards against a wrong-account login) */
  platform_user_id?: string | null;
  /** v3: last live login probe time and its detail text */
  auth_checked_at?: string | null;
  auth_detail?: string | null;
  created_at: string;
  updated_at: string;
}

/** Account Brain persona & positioning (spec §1). One active persona per account. */
export interface AccountPersona {
  id: string;
  account_id: string;
  persona_name: string;
  bio: string;
  tone: string; // e.g. '专业、克制、数据导向'
  voice_rules: string[]; // e.g. ['第一人称“我”', '不用感叹号堆砌']
  target_customers: string[];
  focus_brands: string[];
  focus_models: string[];
  content_positioning: string;
  content_mix: Partial<Record<ContentPillar, number>>; // weights sum ~1
  goals: { monthly_qualified_leads?: number; monthly_posts?: number; monthly_appointments?: number };
  signature_phrases: string[];
  taboo_topics: string[];
  updated_at: string;
}

export interface AccountHealth {
  id: string;
  account_id: string;
  date: string; // YYYY-MM-DD
  health_score: number; // 0..100
  state: HealthState;
  outreach_sent_today: number;
  publish_today: number;
  negative_feedback_7d: number;
  reply_rate_30d: number; // 0..1
  conversion_rate_90d: number; // 0..1
  active_leads: number;
  issues: string[];
  computed_at: string;
}

export interface ContentPlan {
  id: string;
  dealer_id: string;
  account_id: string;
  period_start: string; // YYYY-MM-DD
  period_end: string;
  strategy: {
    positioning: string;
    pillars: { pillar: ContentPillar; weight: number; rationale: string }[];
    focus_models: string[];
    research_insights: string[];
    goal_id?: string;
  };
  status: PlanStatus;
  workflow_run_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Post {
  id: string;
  dealer_id: string;
  account_id: string;
  plan_id: string | null;
  slot_date: string; // YYYY-MM-DD
  pillar: ContentPillar;
  topic: string; // normalized topic key used for cannibalization checks, e.g. 'i3:price_offer:hangzhou'
  angle: string;
  model: string | null;
  title: string;
  body: string;
  tags: string[];
  cover_text: string;
  /** v3: image paths/URLs to publish with (xiaohongshu-mcp publish_content requires ≥1 image); DB default [] */
  images?: string[];
  fact_refs: FactRef[];
  status: PostStatus;
  review: PostReview | null;
  approval_policy: ApprovalPolicy;
  platform_note_id: string | null;
  scheduled_for: string | null;
  published_at: string | null;
  metrics: PostMetrics;
  metrics_updated_at: string | null;
  engine: Engine;
  created_at: string;
  updated_at: string;
}

export interface SearchQuery {
  id: string;
  dealer_id: string;
  goal_id: string | null;
  text: string;
  query_class: QueryClass;
  brand: string | null;
  model: string | null;
  location: string | null;
  priority: number; // 0..1, higher runs first
  status: QueryStatus;
  parent_query_id: string | null;
  generation_reason: string;
  created_at: string;
  updated_at: string;
}

export interface SearchRun {
  id: string;
  query_id: string;
  dealer_id: string;
  workflow_run_id: string | null;
  provider: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNAVAILABLE';
  /** v3: provider mode of this run (live / simulation / import); DB default 'unknown' */
  data_mode?: DataMode;
  posts_discovered: number;
  posts_new: number;
  comments_scanned: number;
  users_evaluated: number;
  candidates: number;
  qualified: number;
  high_intent: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface PublicPost {
  id: string;
  platform: Platform;
  platform_post_id: string;
  xsec_token: string | null;
  url: string | null;
  title: string;
  content: string;
  author_platform_user_id: string | null;
  author_nickname: string | null;
  author_profile_url: string | null;
  ip_location: string | null;
  tags: string[];
  like_count: number;
  comment_count: number;
  collect_count: number;
  published_at: string | null;
  /** v3: provenance (live Xiaohongshu fetch, simulation, import, manual); DB default 'unknown' */
  data_mode?: DataMode;
  /** set when this public post is one of our own managed accounts' posts (content → lead attribution) */
  own_post_id: string | null;
  first_search_run_id: string | null;
  fetched_at: string;
  raw: Record<string, unknown>;
}

export interface PublicComment {
  id: string;
  platform: Platform;
  platform_comment_id: string;
  public_post_id: string;
  parent_comment_id: string | null; // platform_comment_id of parent
  author_platform_user_id: string | null;
  author_nickname: string | null;
  content: string;
  ip_location: string | null;
  like_count: number;
  published_at: string | null;
  /** v3: provenance of this comment row (see DATA_MODES); DB default 'unknown' */
  data_mode?: DataMode;
  /** cheap-filter outcome (spec §6) */
  prefilter_passed: boolean;
  prefilter_reason: string;
  first_search_run_id: string | null;
  fetched_at: string;
  raw: Record<string, unknown>;
}

export interface Lead {
  id: string;
  group_id: string;
  dealer_id: string;
  platform: Platform;
  platform_user_id: string;
  username: string;
  profile_url: string | null;
  stage: LeadStage;
  score: number; // 0..100 (aggregate over signals)
  tier: ScoreTier;
  intent: AutomotiveIntent; // merged across signals
  evidence: Evidence[]; // merged, deduplicated evidence
  primary_signal_id: string | null; // strongest signal
  signal_count: number;
  first_seen_at: string;
  last_signal_at: string;
  suppressed: boolean;
  suppression_reason: string | null;
  contact: { phone?: string; wechat?: string; provided_at?: string; source_message_id?: string };
  lost_reason: string | null;
  estimated_value: number; // CNY pipeline value (MSRP-based)
  attributed_post_id: string | null; // our own Post that sourced this lead, if any
  attributed_query_id: string | null; // SearchQuery that first surfaced this lead
  next_action: string | null;
  /** v3: person classification (BUYER once any buyer signal exists; industry account → DEALER_OR_SALES) */
  actor_type?: ActorType | null;
  /** v3: provenance of the lead (mode of its creating signal; 'live' once any live signal merges) */
  data_mode?: DataMode;
  created_at: string;
  updated_at: string;
}

export interface LeadSignal {
  id: string;
  lead_id: string;
  source_type: SignalSourceType;
  public_post_id: string | null;
  public_comment_id: string | null;
  post_title: string | null;
  content: string; // verbatim original signal text
  signal_at: string; // when the user expressed it
  search_run_id: string | null;
  query_id: string | null;
  intent: AutomotiveIntent;
  signal_score: number;
  evidence: Evidence[];
  engine: Engine;
  /** detection fields persisted so re-scoring never depends on evidence-code conventions (migration v2) */
  is_purchase_signal: boolean;
  strength: number;
  transaction_questions: TransactionQuestion[];
  author_role: AuthorRole | null;
  /** v3: classifyActor() result for this signal */
  actor_type?: ActorType | null;
  created_at: string;
}

export interface LeadScore {
  id: string;
  lead_id: string;
  score: number;
  tier: ScoreTier;
  components: ScoreComponent[];
  config_version: number;
  computed_at: string;
}

export interface LeadAssignment {
  id: string;
  lead_id: string;
  account_id: string;
  active: boolean; // DB-enforced: at most one active assignment per lead
  reason: string;
  candidates: AssignmentCandidate[];
  assigned_by: string; // 'agent:fleet-controller' | 'operator:<name>'
  assigned_at: string;
  released_at: string | null;
  released_reason: string | null;
}

export interface Outreach {
  id: string;
  lead_id: string;
  account_id: string;
  assignment_id: string;
  kind: OutreachKind;
  message: string;
  personalization: Evidence[]; // which lead evidence was used
  fact_refs: FactRef[];
  guard_results: GuardResult[];
  approval_policy: ApprovalPolicy;
  status: OutreachStatus;
  capability_status: CapabilityStatus; // send_messages capability at generation/send time
  provider_message_id: string | null;
  blocked_reason: string | null;
  approved_by: string | null;
  approved_at: string | null;
  sent_at: string | null;
  /** v3: operator who sent it by hand in the Xiaohongshu app (SENT_MANUALLY) */
  sent_by?: string | null;
  engine: Engine;
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  lead_id: string;
  account_id: string;
  status: ConversationStatus;
  slots: ConversationSlots;
  ai_turns: number;
  needs_human: boolean;
  handoff_reason: string | null;
  last_message_at: string;
  created_at: string;
  updated_at: string;
}

export interface ConversationMessage {
  id: string;
  conversation_id: string;
  direction: MessageDirection;
  content: string;
  intents: ConversationIntent[];
  extracted: ConversationSlots;
  status: MessageStatus;
  fact_refs: FactRef[];
  provider_message_id: string | null;
  /** v3: operator who sent this reply by hand (status sent_manually) */
  sent_by?: string | null;
  engine: Engine;
  created_at: string;
}

export interface Appointment {
  id: string;
  lead_id: string;
  dealer_id: string;
  account_id: string;
  conversation_id: string | null;
  scheduled_for: string | null; // ISO; null when intent known but time unresolved
  time_text: string | null; // original text, e.g. '这周六下午'
  store: string;
  vehicle_interest: string;
  status: AppointmentStatus;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface Conversion {
  id: string;
  lead_id: string;
  dealer_id: string;
  outcome: 'won' | 'lost';
  vehicle_id: string | null;
  amount: number | null;
  lost_reason: string | null;
  attributed_post_id: string | null;
  attributed_query_id: string | null;
  account_id: string | null;
  occurred_at: string;
}

export interface LeadStageTransition {
  id: string;
  lead_id: string;
  from_stage: LeadStage | null;
  to_stage: LeadStage;
  reason: string;
  actor: string;
  at: string;
}

export interface ContactSuppression {
  id: string;
  platform: Platform;
  platform_user_id: string;
  reason: string;
  source: string; // e.g. 'conversation:<id>' | 'operator:<name>'
  created_at: string;
}

export interface ScoringConfig {
  id: string;
  dealer_id: string;
  version: number;
  weights: ScoringWeights;
  thresholds: ScoringThresholds;
  active: boolean;
  created_at: string;
}

export interface OperatorGoal {
  id: string;
  dealer_id: string;
  text: string;
  spec: GoalSpec;
  status: GoalStatus;
  plan: { step_key: string; agent: string; skill: string; description: string }[];
  created_at: string;
  updated_at: string;
}

export interface WorkflowRun {
  id: string;
  workflow: string;
  dealer_id: string | null;
  goal_id: string | null;
  trigger: WorkflowTrigger;
  status: WorkflowStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  error: string | null;
  resumed_from_run_id: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface WorkflowStep {
  id: string;
  run_id: string;
  step_key: string;
  seq: number;
  agent: string;
  skill: string;
  status: StepStatus;
  attempts: number;
  output: Record<string, unknown>;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface Schedule {
  id: string;
  dealer_id: string;
  workflow: string;
  /** local time 'HH:MM' in dealer timezone, or 'every:<minutes>' */
  cron: string;
  enabled: boolean;
  last_run_at: string | null;
  last_run_id: string | null;
  created_at: string;
}

export interface AgentDecision {
  id: string;
  agent: string;
  skill: string;
  decision_type: DecisionType;
  subject_type: string; // 'lead' | 'post' | 'outreach' | 'comment' | 'query' | 'account' | 'goal'
  subject_id: string;
  inputs: Record<string, unknown>;
  evidence: Evidence[];
  output: Record<string, unknown>;
  confidence: number; // 0..1
  engine: Engine;
  workflow_run_id: string | null;
  created_at: string;
}

export interface AuditEvent {
  id: string;
  actor: string; // 'system' | 'agent:<name>' | 'operator:<name>' | 'scheduler'
  action: string; // e.g. 'lead.stage_changed', 'outreach.approved', 'contact.suppressed'
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown>;
  created_at: string;
}

export interface CapabilitySnapshot {
  id: string;
  provider: string;
  account_id: string | null; // null = provider-level
  capability: XhsCapability | 'llm';
  status: CapabilityStatus;
  reason: string;
  checked_at: string;
}

export const RESEARCH_KINDS = ['xhs', 'competitor', 'market', 'trend'] as const;
export type ResearchKind = (typeof RESEARCH_KINDS)[number];

export interface ResearchInsight {
  text: string;
  evidence: Evidence[];
  metric?: number;
}

export interface ResearchBrief {
  id: string;
  dealer_id: string;
  kind: ResearchKind;
  scope: { models: string[]; location: string | null; window_days: number };
  findings: {
    headline: string;
    insights: ResearchInsight[];
    top_questions?: { question: string; count: number; example_quote: string }[];
    topics?: { topic: string; posts: number; engagement: number }[];
    competitors?: { brand: string; model: string; mentions: number; comparison_with: string; example_quote: string }[];
    trends?: { term: string; current: number; previous: number; change: number }[];
  };
  source_counts: { posts: number; comments: number; provider_searches: number };
  engine: Engine;
  workflow_run_id: string | null;
  created_at: string;
}

export const ENGAGEMENT_REPLY_STATUSES = [
  'DRAFT',
  'BLOCKED',
  'READY_FOR_REVIEW',
  'APPROVED',
  'SENT',
  'SENT_MANUALLY',
  'CANCELLED',
] as const;
export type EngagementReplyStatus = (typeof ENGAGEMENT_REPLY_STATUSES)[number];

/** Public reply to a comment left on one of OUR OWN published notes (content-ops engagement). */
export interface EngagementReply {
  id: string;
  dealer_id: string;
  account_id: string;
  post_id: string;
  public_comment_id: string;
  message: string;
  fact_refs: FactRef[];
  guard_results: GuardResult[];
  status: EngagementReplyStatus;
  capability_status: CapabilityStatus;
  provider_message_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface OperatorReport {
  id: string;
  dealer_id: string;
  date: string; // YYYY-MM-DD local
  report: Record<string, unknown>;
  workflow_run_id: string | null;
  created_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table registry type map (used by the typed data layer)
// ─────────────────────────────────────────────────────────────────────────────

export interface EntityMap {
  dealer_groups: DealerGroup;
  dealers: Dealer;
  dealer_knowledge: DealerKnowledge;
  vehicles: Vehicle;
  inventory: Inventory;
  offers: Offer;
  xhs_accounts: XhsAccount;
  account_personas: AccountPersona;
  account_health: AccountHealth;
  content_plans: ContentPlan;
  posts: Post;
  search_queries: SearchQuery;
  search_runs: SearchRun;
  public_posts: PublicPost;
  public_comments: PublicComment;
  leads: Lead;
  lead_signals: LeadSignal;
  lead_scores: LeadScore;
  lead_assignments: LeadAssignment;
  outreach: Outreach;
  conversations: Conversation;
  conversation_messages: ConversationMessage;
  appointments: Appointment;
  conversions: Conversion;
  lead_stage_transitions: LeadStageTransition;
  contact_suppressions: ContactSuppression;
  scoring_configs: ScoringConfig;
  operator_goals: OperatorGoal;
  workflow_runs: WorkflowRun;
  workflow_steps: WorkflowStep;
  schedules: Schedule;
  agent_decisions: AgentDecision;
  audit_events: AuditEvent;
  capability_snapshots: CapabilitySnapshot;
  research_briefs: ResearchBrief;
  engagement_replies: EngagementReply;
  operator_reports: OperatorReport;
}

export type TableName = keyof EntityMap;
