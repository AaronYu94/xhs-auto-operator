import {
  ACCOUNT_STATUSES,
  ACCOUNT_TYPES,
  APPOINTMENT_STATUSES,
  APPROVAL_POLICIES,
  ACTOR_TYPES,
  AUTHOR_ROLES,
  AUTH_STATES,
  DATA_MODES,
  CAPABILITY_STATUSES,
  CONTENT_PILLARS,
  CONVERSATION_STATUSES,
  DECISION_TYPES,
  ENGAGEMENT_REPLY_STATUSES,
  ENGINES,
  RESEARCH_KINDS,
  GOAL_STATUSES,
  HEALTH_STATES,
  INVENTORY_STATUSES,
  KNOWLEDGE_CATEGORIES,
  LEAD_STAGES,
  MESSAGE_DIRECTIONS,
  MESSAGE_STATUSES,
  NOTIFICATION_KINDS,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TABS,
  OFFER_TYPES,
  OUTREACH_KINDS,
  OUTREACH_STATUSES,
  PLAN_STATUSES,
  POST_STATUSES,
  QUERY_CLASSES,
  QUERY_STATUSES,
  SCORE_TIERS,
  SIGNAL_SOURCE_TYPES,
  STEP_STATUSES,
  WORKFLOW_STATUSES,
  WORKFLOW_TRIGGERS,
  type TableName,
} from '../core/types.ts';

/** CHECK constraint generated from the canonical enum arrays so DB and TS can never drift. */
const inList = (col: string, values: readonly string[], nullable = false) =>
  `CHECK (${nullable ? `${col} IS NULL OR ` : ''}${col} IN (${values.map((x) => `'${x}'`).join(', ')}))`;

/** JSON and boolean column registry — drives encode/decode in the typed data layer. */
export const TABLE_META: Record<TableName, { json: readonly string[]; bool: readonly string[] }> = {
  dealer_groups: { json: [], bool: [] },
  dealers: { json: ['brands', 'settings'], bool: [] },
  dealer_knowledge: { json: ['data'], bool: [] },
  vehicles: { json: ['specs', 'highlights', 'aliases', 'images', 'target_customers', 'competitors', 'faqs', 'content_angles'], bool: [] },
  inventory: { json: [], bool: [] },
  offers: { json: [], bool: [] },
  xhs_accounts: { json: ['platform_profile'], bool: [] },
  account_personas: {
    json: [
      'voice_rules',
      'target_customers',
      'focus_brands',
      'focus_models',
      'content_mix',
      'goals',
      'signature_phrases',
      'taboo_topics',
    ],
    bool: [],
  },
  account_health: { json: ['issues'], bool: [] },
  content_plans: { json: ['strategy'], bool: [] },
  posts: { json: ['tags', 'fact_refs', 'review', 'metrics', 'images'], bool: [] },
  search_queries: { json: [], bool: [] },
  search_runs: { json: [], bool: [] },
  public_posts: { json: ['tags', 'raw'], bool: [] },
  public_comments: { json: ['raw'], bool: ['prefilter_passed'] },
  leads: { json: ['intent', 'evidence', 'contact'], bool: ['suppressed'] },
  lead_signals: { json: ['intent', 'evidence', 'transaction_questions'], bool: ['is_purchase_signal'] },
  lead_scores: { json: ['components'], bool: [] },
  lead_assignments: { json: ['candidates'], bool: ['active'] },
  outreach: { json: ['personalization', 'fact_refs', 'guard_results'], bool: [] },
  conversations: { json: ['slots'], bool: ['needs_human'] },
  conversation_messages: { json: ['intents', 'extracted', 'fact_refs'], bool: [] },
  appointments: { json: [], bool: [] },
  conversions: { json: [], bool: [] },
  lead_stage_transitions: { json: [], bool: [] },
  contact_suppressions: { json: [], bool: [] },
  scoring_configs: { json: ['weights', 'thresholds'], bool: ['active'] },
  operator_goals: { json: ['spec', 'plan'], bool: [] },
  workflow_runs: { json: ['input', 'output'], bool: [] },
  workflow_steps: { json: ['output'], bool: [] },
  schedules: { json: [], bool: ['enabled'] },
  agent_decisions: { json: ['inputs', 'evidence', 'output'], bool: [] },
  audit_events: { json: ['details'], bool: [] },
  capability_snapshots: { json: [], bool: [] },
  research_briefs: { json: ['scope', 'findings', 'source_counts'], bool: [] },
  engagement_replies: { json: ['fact_refs', 'guard_results'], bool: [] },
  xhs_notifications: { json: [], bool: ['comment_liked'] },
  account_voice_profiles: { json: ['sample_note_ids', 'metrics', 'rules', 'vocabulary', 'examples', 'avoid'], bool: [] },
  operator_reports: { json: ['report'], bool: [] },
};

const SCHEMA_V1 = /* sql */ `
CREATE TABLE dealer_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE dealers (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES dealer_groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  brands TEXT NOT NULL DEFAULT '[]',
  city TEXT NOT NULL,
  province TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  business_hours TEXT NOT NULL DEFAULT '',
  phone TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_dealers_group ON dealers(group_id);

CREATE TABLE dealer_knowledge (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES dealer_groups(id) ON DELETE CASCADE,
  dealer_id TEXT REFERENCES dealers(id) ON DELETE CASCADE,
  category TEXT NOT NULL ${inList('category', KNOWLEDGE_CATEGORIES)},
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL,
  valid_from TEXT,
  valid_until TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_knowledge_key ON dealer_knowledge(group_id, IFNULL(dealer_id, ''), key);
CREATE INDEX idx_knowledge_category ON dealer_knowledge(group_id, category);

CREATE TABLE vehicles (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES dealer_groups(id) ON DELETE CASCADE,
  brand TEXT NOT NULL,
  brand_zh TEXT NOT NULL,
  model TEXT NOT NULL,
  model_zh TEXT NOT NULL,
  trim TEXT NOT NULL,
  model_year INTEGER NOT NULL,
  msrp INTEGER NOT NULL CHECK (msrp >= 0),
  specs TEXT NOT NULL DEFAULT '{}',
  highlights TEXT NOT NULL DEFAULT '[]',
  aliases TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_vehicle ON vehicles(group_id, brand, model, trim, model_year);

CREATE TABLE inventory (
  id TEXT PRIMARY KEY,
  dealer_id TEXT NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  vin TEXT,
  exterior_color TEXT NOT NULL,
  interior_color TEXT NOT NULL,
  status TEXT NOT NULL ${inList('status', INVENTORY_STATUSES)},
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  list_price INTEGER,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_inventory_vin ON inventory(vin) WHERE vin IS NOT NULL;
CREATE INDEX idx_inventory_dealer ON inventory(dealer_id, vehicle_id, status);

CREATE TABLE offers (
  id TEXT PRIMARY KEY,
  dealer_id TEXT NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  vehicle_id TEXT REFERENCES vehicles(id) ON DELETE CASCADE,
  model TEXT,
  type TEXT NOT NULL ${inList('type', OFFER_TYPES)},
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount INTEGER,
  apr REAL,
  term_months INTEGER,
  down_payment_pct REAL,
  conditions TEXT NOT NULL DEFAULT '',
  valid_from TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_offers_dealer ON offers(dealer_id, valid_until);

CREATE TABLE xhs_accounts (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES dealer_groups(id) ON DELETE CASCADE,
  dealer_id TEXT NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  platform_account_id TEXT,
  nickname TEXT NOT NULL,
  account_type TEXT NOT NULL ${inList('account_type', ACCOUNT_TYPES)},
  status TEXT NOT NULL ${inList('status', ACCOUNT_STATUSES)},
  auth_state TEXT NOT NULL ${inList('auth_state', AUTH_STATES)},
  city TEXT NOT NULL,
  salesperson_name TEXT,
  outreach_approval_policy TEXT ${inList('outreach_approval_policy', APPROVAL_POLICIES, true)},
  daily_outreach_limit INTEGER,
  daily_publish_limit INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_account_platform ON xhs_accounts(platform_account_id) WHERE platform_account_id IS NOT NULL;
CREATE INDEX idx_accounts_dealer ON xhs_accounts(dealer_id);

CREATE TABLE account_personas (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE REFERENCES xhs_accounts(id) ON DELETE CASCADE,
  persona_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT '',
  voice_rules TEXT NOT NULL DEFAULT '[]',
  target_customers TEXT NOT NULL DEFAULT '[]',
  focus_brands TEXT NOT NULL DEFAULT '[]',
  focus_models TEXT NOT NULL DEFAULT '[]',
  content_positioning TEXT NOT NULL DEFAULT '',
  content_mix TEXT NOT NULL DEFAULT '{}',
  goals TEXT NOT NULL DEFAULT '{}',
  signature_phrases TEXT NOT NULL DEFAULT '[]',
  taboo_topics TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE account_health (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES xhs_accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  health_score REAL NOT NULL,
  state TEXT NOT NULL ${inList('state', HEALTH_STATES)},
  outreach_sent_today INTEGER NOT NULL DEFAULT 0,
  publish_today INTEGER NOT NULL DEFAULT 0,
  negative_feedback_7d INTEGER NOT NULL DEFAULT 0,
  reply_rate_30d REAL NOT NULL DEFAULT 0,
  conversion_rate_90d REAL NOT NULL DEFAULT 0,
  active_leads INTEGER NOT NULL DEFAULT 0,
  issues TEXT NOT NULL DEFAULT '[]',
  computed_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_account_health_day ON account_health(account_id, date);

CREATE TABLE content_plans (
  id TEXT PRIMARY KEY,
  dealer_id TEXT NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES xhs_accounts(id) ON DELETE CASCADE,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  strategy TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL ${inList('status', PLAN_STATUSES)},
  workflow_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_plans_account ON content_plans(account_id, period_start);

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  dealer_id TEXT NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES xhs_accounts(id) ON DELETE CASCADE,
  plan_id TEXT REFERENCES content_plans(id) ON DELETE SET NULL,
  slot_date TEXT NOT NULL,
  pillar TEXT NOT NULL ${inList('pillar', CONTENT_PILLARS)},
  topic TEXT NOT NULL,
  angle TEXT NOT NULL DEFAULT '',
  model TEXT,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  cover_text TEXT NOT NULL DEFAULT '',
  fact_refs TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL ${inList('status', POST_STATUSES)},
  review TEXT,
  approval_policy TEXT NOT NULL ${inList('approval_policy', APPROVAL_POLICIES)},
  platform_note_id TEXT,
  scheduled_for TEXT,
  published_at TEXT,
  metrics TEXT NOT NULL DEFAULT '{"views":0,"likes":0,"collects":0,"comments":0,"shares":0}',
  metrics_updated_at TEXT,
  engine TEXT NOT NULL ${inList('engine', ENGINES)},
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_posts_account ON posts(account_id, slot_date);
CREATE INDEX idx_posts_status ON posts(dealer_id, status);
CREATE UNIQUE INDEX uq_posts_note ON posts(platform_note_id) WHERE platform_note_id IS NOT NULL;

CREATE TABLE search_queries (
  id TEXT PRIMARY KEY,
  dealer_id TEXT NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  goal_id TEXT,
  text TEXT NOT NULL,
  query_class TEXT NOT NULL ${inList('query_class', QUERY_CLASSES)},
  brand TEXT,
  model TEXT,
  location TEXT,
  priority REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL ${inList('status', QUERY_STATUSES)},
  parent_query_id TEXT REFERENCES search_queries(id) ON DELETE SET NULL,
  generation_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_query_text ON search_queries(dealer_id, text);

CREATE TABLE search_runs (
  id TEXT PRIMARY KEY,
  query_id TEXT NOT NULL REFERENCES search_queries(id) ON DELETE CASCADE,
  dealer_id TEXT NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  workflow_run_id TEXT,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'UNAVAILABLE')),
  posts_discovered INTEGER NOT NULL DEFAULT 0,
  posts_new INTEGER NOT NULL DEFAULT 0,
  comments_scanned INTEGER NOT NULL DEFAULT 0,
  users_evaluated INTEGER NOT NULL DEFAULT 0,
  candidates INTEGER NOT NULL DEFAULT 0,
  qualified INTEGER NOT NULL DEFAULT 0,
  high_intent INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_search_runs_query ON search_runs(query_id, started_at);

CREATE TABLE public_posts (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL DEFAULT 'xiaohongshu',
  platform_post_id TEXT NOT NULL,
  xsec_token TEXT,
  url TEXT,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  author_platform_user_id TEXT,
  author_nickname TEXT,
  author_profile_url TEXT,
  ip_location TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  like_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  collect_count INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  own_post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
  first_search_run_id TEXT,
  fetched_at TEXT NOT NULL,
  raw TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX uq_public_post ON public_posts(platform, platform_post_id);
CREATE INDEX idx_public_posts_author ON public_posts(author_platform_user_id);

CREATE TABLE public_comments (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL DEFAULT 'xiaohongshu',
  platform_comment_id TEXT NOT NULL,
  public_post_id TEXT NOT NULL REFERENCES public_posts(id) ON DELETE CASCADE,
  parent_comment_id TEXT,
  author_platform_user_id TEXT,
  author_nickname TEXT,
  content TEXT NOT NULL,
  ip_location TEXT,
  like_count INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  prefilter_passed INTEGER NOT NULL DEFAULT 0,
  prefilter_reason TEXT NOT NULL DEFAULT '',
  first_search_run_id TEXT,
  fetched_at TEXT NOT NULL,
  raw TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX uq_public_comment ON public_comments(platform, platform_comment_id);
CREATE INDEX idx_public_comments_post ON public_comments(public_post_id);
CREATE INDEX idx_public_comments_author ON public_comments(author_platform_user_id);

CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES dealer_groups(id) ON DELETE CASCADE,
  dealer_id TEXT NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'xiaohongshu',
  platform_user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  profile_url TEXT,
  stage TEXT NOT NULL ${inList('stage', LEAD_STAGES)},
  score REAL NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 100),
  tier TEXT NOT NULL ${inList('tier', SCORE_TIERS)},
  intent TEXT NOT NULL DEFAULT '{}',
  evidence TEXT NOT NULL DEFAULT '[]',
  primary_signal_id TEXT,
  signal_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_signal_at TEXT NOT NULL,
  suppressed INTEGER NOT NULL DEFAULT 0,
  suppression_reason TEXT,
  contact TEXT NOT NULL DEFAULT '{}',
  lost_reason TEXT,
  estimated_value INTEGER NOT NULL DEFAULT 0,
  attributed_post_id TEXT,
  attributed_query_id TEXT,
  next_action TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Identity resolution: one lead per platform user per dealer group (spec §10).
CREATE UNIQUE INDEX uq_lead_identity ON leads(group_id, platform, platform_user_id);
CREATE INDEX idx_leads_stage ON leads(dealer_id, stage, score);

CREATE TABLE lead_signals (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL ${inList('source_type', SIGNAL_SOURCE_TYPES)},
  public_post_id TEXT REFERENCES public_posts(id) ON DELETE SET NULL,
  public_comment_id TEXT REFERENCES public_comments(id) ON DELETE SET NULL,
  post_title TEXT,
  content TEXT NOT NULL,
  signal_at TEXT NOT NULL,
  search_run_id TEXT,
  query_id TEXT,
  intent TEXT NOT NULL DEFAULT '{}',
  signal_score REAL NOT NULL DEFAULT 0,
  evidence TEXT NOT NULL DEFAULT '[]',
  engine TEXT NOT NULL ${inList('engine', ENGINES)},
  created_at TEXT NOT NULL
);
CREATE INDEX idx_signals_lead ON lead_signals(lead_id, signal_at);
-- Re-discovering the same comment / post never creates a second signal (idempotent ingestion).
CREATE UNIQUE INDEX uq_signal_comment ON lead_signals(public_comment_id) WHERE public_comment_id IS NOT NULL;
CREATE UNIQUE INDEX uq_signal_post ON lead_signals(lead_id, public_post_id) WHERE source_type = 'post' AND public_post_id IS NOT NULL;

CREATE TABLE lead_scores (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  score REAL NOT NULL,
  tier TEXT NOT NULL ${inList('tier', SCORE_TIERS)},
  components TEXT NOT NULL DEFAULT '[]',
  config_version INTEGER NOT NULL,
  computed_at TEXT NOT NULL
);
CREATE INDEX idx_lead_scores_lead ON lead_scores(lead_id, computed_at);

CREATE TABLE lead_assignments (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES xhs_accounts(id) ON DELETE CASCADE,
  active INTEGER NOT NULL DEFAULT 1,
  reason TEXT NOT NULL DEFAULT '',
  candidates TEXT NOT NULL DEFAULT '[]',
  assigned_by TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  released_at TEXT,
  released_reason TEXT
);
-- Exclusive ownership: at most ONE active owning account per lead (spec §11).
CREATE UNIQUE INDEX uq_active_assignment ON lead_assignments(lead_id) WHERE active = 1;
CREATE INDEX idx_assignments_account ON lead_assignments(account_id, active);

CREATE TABLE outreach (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES xhs_accounts(id) ON DELETE CASCADE,
  assignment_id TEXT NOT NULL REFERENCES lead_assignments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL ${inList('kind', OUTREACH_KINDS)},
  message TEXT NOT NULL,
  personalization TEXT NOT NULL DEFAULT '[]',
  fact_refs TEXT NOT NULL DEFAULT '[]',
  guard_results TEXT NOT NULL DEFAULT '[]',
  approval_policy TEXT NOT NULL ${inList('approval_policy', APPROVAL_POLICIES)},
  status TEXT NOT NULL ${inList('status', OUTREACH_STATUSES)},
  capability_status TEXT NOT NULL ${inList('capability_status', CAPABILITY_STATUSES)},
  provider_message_id TEXT,
  blocked_reason TEXT,
  approved_by TEXT,
  approved_at TEXT,
  sent_at TEXT,
  engine TEXT NOT NULL ${inList('engine', ENGINES)},
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_outreach_lead ON outreach(lead_id, created_at);
CREATE INDEX idx_outreach_account_sent ON outreach(account_id, sent_at);
CREATE INDEX idx_outreach_status ON outreach(status);
-- Never two live first-touch messages to the same person, from any account (spec §10, §12).
CREATE UNIQUE INDEX uq_live_first_touch ON outreach(lead_id)
  WHERE kind = 'first_touch' AND status IN ('READY_FOR_REVIEW', 'APPROVED', 'SENT', 'SENT_MANUALLY');

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES xhs_accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL ${inList('status', CONVERSATION_STATUSES)},
  slots TEXT NOT NULL DEFAULT '{}',
  ai_turns INTEGER NOT NULL DEFAULT 0,
  needs_human INTEGER NOT NULL DEFAULT 0,
  handoff_reason TEXT,
  last_message_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_conversation ON conversations(lead_id, account_id);

CREATE TABLE conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL ${inList('direction', MESSAGE_DIRECTIONS)},
  content TEXT NOT NULL,
  intents TEXT NOT NULL DEFAULT '[]',
  extracted TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL ${inList('status', MESSAGE_STATUSES)},
  fact_refs TEXT NOT NULL DEFAULT '[]',
  provider_message_id TEXT,
  engine TEXT NOT NULL ${inList('engine', ENGINES)},
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_conversation ON conversation_messages(conversation_id, created_at);
CREATE UNIQUE INDEX uq_message_provider ON conversation_messages(provider_message_id) WHERE provider_message_id IS NOT NULL;

CREATE TABLE appointments (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  dealer_id TEXT NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES xhs_accounts(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  scheduled_for TEXT,
  time_text TEXT,
  store TEXT NOT NULL,
  vehicle_interest TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL ${inList('status', APPOINTMENT_STATUSES)},
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_appointments_dealer ON appointments(dealer_id, scheduled_for);

CREATE TABLE conversions (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  dealer_id TEXT NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('won', 'lost')),
  vehicle_id TEXT REFERENCES vehicles(id) ON DELETE SET NULL,
  amount INTEGER,
  lost_reason TEXT,
  attributed_post_id TEXT,
  attributed_query_id TEXT,
  account_id TEXT,
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_conversions_dealer ON conversions(dealer_id, occurred_at);

CREATE TABLE lead_stage_transitions (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_stage TEXT ${inList('from_stage', LEAD_STAGES, true)},
  to_stage TEXT NOT NULL ${inList('to_stage', LEAD_STAGES)},
  reason TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX idx_transitions_lead ON lead_stage_transitions(lead_id, at);
CREATE INDEX idx_transitions_stage_at ON lead_stage_transitions(to_stage, at);

CREATE TABLE contact_suppressions (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL DEFAULT 'xiaohongshu',
  platform_user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- Do-not-contact is GLOBAL across every dealer and managed account (spec §24).
CREATE UNIQUE INDEX uq_suppression ON contact_suppressions(platform, platform_user_id);

CREATE TABLE scoring_configs (
  id TEXT PRIMARY KEY,
  dealer_id TEXT NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  weights TEXT NOT NULL,
  thresholds TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_scoring_version ON scoring_configs(dealer_id, version);
CREATE UNIQUE INDEX uq_scoring_active ON scoring_configs(dealer_id) WHERE active = 1;

CREATE TABLE operator_goals (
  id TEXT PRIMARY KEY,
  dealer_id TEXT NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  spec TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL ${inList('status', GOAL_STATUSES)},
  plan TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  workflow TEXT NOT NULL,
  dealer_id TEXT REFERENCES dealers(id) ON DELETE CASCADE,
  goal_id TEXT REFERENCES operator_goals(id) ON DELETE SET NULL,
  trigger TEXT NOT NULL ${inList('trigger', WORKFLOW_TRIGGERS)},
  status TEXT NOT NULL ${inList('status', WORKFLOW_STATUSES)},
  input TEXT NOT NULL DEFAULT '{}',
  output TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  resumed_from_run_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_workflow_runs ON workflow_runs(dealer_id, workflow, started_at);

CREATE TABLE workflow_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  agent TEXT NOT NULL,
  skill TEXT NOT NULL,
  status TEXT NOT NULL ${inList('status', STEP_STATUSES)},
  attempts INTEGER NOT NULL DEFAULT 0,
  output TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  started_at TEXT,
  finished_at TEXT
);
CREATE UNIQUE INDEX uq_workflow_step ON workflow_steps(run_id, step_key);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  dealer_id TEXT NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  workflow TEXT NOT NULL,
  cron TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_schedule ON schedules(dealer_id, workflow, cron);

CREATE TABLE agent_decisions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  skill TEXT NOT NULL,
  decision_type TEXT NOT NULL ${inList('decision_type', DECISION_TYPES)},
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  inputs TEXT NOT NULL DEFAULT '{}',
  evidence TEXT NOT NULL DEFAULT '[]',
  output TEXT NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 0,
  engine TEXT NOT NULL ${inList('engine', ENGINES)},
  workflow_run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_decisions_subject ON agent_decisions(subject_type, subject_id, created_at);
CREATE INDEX idx_decisions_type ON agent_decisions(decision_type, created_at);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_entity ON audit_events(entity_type, entity_id, created_at);
CREATE INDEX idx_audit_created ON audit_events(created_at);

CREATE TABLE capability_snapshots (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account_id TEXT,
  capability TEXT NOT NULL,
  status TEXT NOT NULL ${inList('status', CAPABILITY_STATUSES)},
  reason TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL
);
CREATE INDEX idx_capability_snapshots ON capability_snapshots(provider, capability, checked_at);

CREATE TABLE research_briefs (
  id TEXT PRIMARY KEY,
  dealer_id TEXT NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL ${inList('kind', RESEARCH_KINDS)},
  scope TEXT NOT NULL DEFAULT '{}',
  findings TEXT NOT NULL DEFAULT '{}',
  source_counts TEXT NOT NULL DEFAULT '{}',
  engine TEXT NOT NULL ${inList('engine', ENGINES)},
  workflow_run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_research_briefs ON research_briefs(dealer_id, kind, created_at);

CREATE TABLE engagement_replies (
  id TEXT PRIMARY KEY,
  dealer_id TEXT NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES xhs_accounts(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  public_comment_id TEXT NOT NULL REFERENCES public_comments(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  fact_refs TEXT NOT NULL DEFAULT '[]',
  guard_results TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL ${inList('status', ENGAGEMENT_REPLY_STATUSES)},
  capability_status TEXT NOT NULL ${inList('capability_status', CAPABILITY_STATUSES)},
  provider_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- one public reply per comment
CREATE UNIQUE INDEX uq_engagement_reply_comment ON engagement_replies(public_comment_id) WHERE status <> 'CANCELLED';

CREATE TABLE operator_reports (
  id TEXT PRIMARY KEY,
  dealer_id TEXT NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  report TEXT NOT NULL DEFAULT '{}',
  workflow_run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_operator_reports ON operator_reports(dealer_id, date, created_at);
`;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** v2: persist detection fields on signals (robust re-scoring, author-role filtering). */
const SCHEMA_V2 = /* sql */ `
ALTER TABLE lead_signals ADD COLUMN is_purchase_signal INTEGER NOT NULL DEFAULT 1;
ALTER TABLE lead_signals ADD COLUMN strength REAL NOT NULL DEFAULT 0;
ALTER TABLE lead_signals ADD COLUMN transaction_questions TEXT NOT NULL DEFAULT '[]';
ALTER TABLE lead_signals ADD COLUMN author_role TEXT ${inList('author_role', AUTHOR_ROLES, true)};
`;

/**
 * v3 (ARCHITECTURE §10): data provenance (live / simulation / import / manual), actor classification,
 * per-account Xiaohongshu session binding, and accountability for human sends.
 */
const SCHEMA_V3 = /* sql */ `
ALTER TABLE public_posts ADD COLUMN data_mode TEXT NOT NULL DEFAULT 'unknown' ${inList('data_mode', DATA_MODES)};
ALTER TABLE public_comments ADD COLUMN data_mode TEXT NOT NULL DEFAULT 'unknown' ${inList('data_mode', DATA_MODES)};
ALTER TABLE search_runs ADD COLUMN data_mode TEXT NOT NULL DEFAULT 'unknown' ${inList('data_mode', DATA_MODES)};
ALTER TABLE leads ADD COLUMN data_mode TEXT NOT NULL DEFAULT 'unknown' ${inList('data_mode', DATA_MODES)};
ALTER TABLE leads ADD COLUMN actor_type TEXT ${inList('actor_type', ACTOR_TYPES, true)};
ALTER TABLE lead_signals ADD COLUMN actor_type TEXT ${inList('actor_type', ACTOR_TYPES, true)};
ALTER TABLE xhs_accounts ADD COLUMN mcp_endpoint_url TEXT;
ALTER TABLE xhs_accounts ADD COLUMN platform_user_id TEXT;
ALTER TABLE xhs_accounts ADD COLUMN auth_checked_at TEXT;
ALTER TABLE xhs_accounts ADD COLUMN auth_detail TEXT;
ALTER TABLE outreach ADD COLUMN sent_by TEXT;
ALTER TABLE conversation_messages ADD COLUMN sent_by TEXT;
ALTER TABLE posts ADD COLUMN images TEXT NOT NULL DEFAULT '[]';
CREATE INDEX idx_leads_data_mode ON leads(dealer_id, data_mode);
CREATE INDEX idx_public_posts_data_mode ON public_posts(data_mode);
-- One xiaohongshu-mcp instance per managed account: a shared endpoint would run actions in another account's session.
CREATE UNIQUE INDEX uq_account_mcp_endpoint ON xhs_accounts(mcp_endpoint_url) WHERE mcp_endpoint_url IS NOT NULL;
`;

// v4: the managed account's own Xiaohongshu profile (avatar, bio, counts, own notes), read from its logged-in session.
const SCHEMA_V4 = /* sql */ `
ALTER TABLE xhs_accounts ADD COLUMN platform_profile TEXT;
ALTER TABLE xhs_accounts ADD COLUMN platform_profile_at TEXT;
`;

/**
 * Avatars: leads carry the public avatar of the person (Xiaohongshu serves it from sns-avatar-qc.xhscdn.com; the
 * console proxies it). Existing rows are backfilled from the payloads already stored with their signals, so the
 * inbox shows a face for leads discovered before this migration instead of an initial-letter placeholder.
 */
const SCHEMA_V5 = /* sql */ `
ALTER TABLE leads ADD COLUMN avatar_url TEXT;

UPDATE leads SET avatar_url = (
  SELECT json_extract(p.raw, '$.user.avatar')
  FROM lead_signals s
  JOIN public_posts p ON p.id = s.public_post_id
  WHERE s.lead_id = leads.id
    AND p.author_platform_user_id = leads.platform_user_id
    AND json_extract(p.raw, '$.user.avatar') IS NOT NULL
    AND json_extract(p.raw, '$.user.avatar') <> ''
  ORDER BY s.signal_at DESC
  LIMIT 1
)
WHERE avatar_url IS NULL;
`;

/**
 * Removing an account must never take the store's leads with it. An account that already talked to customers (sent
 * DMs, conversations, appointments, published notes) is archived instead of deleted: the row stays so that history
 * keeps its author, `removed_at` takes it out of the fleet, and its identity fields are cleared so the same
 * Xiaohongshu account can be added again. Leads are released to the pool by the assignment skill, never deleted.
 */
const SCHEMA_V6 = /* sql */ `
ALTER TABLE xhs_accounts ADD COLUMN removed_at TEXT;
`;

/**
 * The platform's own notification centre, mirrored per account. One row per notification the account received:
 * a comment or @ on our note, a like or collect, a new follower. `provider_notification_id` is Xiaohongshu's own id,
 * so a re-sync never duplicates a row, and everything needed to act on it later (comment_id for a reply or a like,
 * feed id + xsec_token to open the note, the sender's xsec_token to open their profile) is stored with it.
 */
const SCHEMA_V7 = /* sql */ `
CREATE TABLE xhs_notifications (
  id TEXT PRIMARY KEY,
  dealer_id TEXT NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES xhs_accounts(id) ON DELETE CASCADE,
  provider_notification_id TEXT NOT NULL,
  tab TEXT NOT NULL ${inList('tab', NOTIFICATION_TABS)},
  kind TEXT NOT NULL ${inList('kind', NOTIFICATION_KINDS)},
  title TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL,
  from_user_id TEXT NOT NULL,
  from_nickname TEXT NOT NULL DEFAULT '',
  from_xsec_token TEXT,
  comment_id TEXT,
  comment_text TEXT,
  comment_liked INTEGER NOT NULL DEFAULT 0,
  note_id TEXT,
  note_xsec_token TEXT,
  note_title TEXT,
  status TEXT NOT NULL ${inList('status', NOTIFICATION_STATUSES)},
  lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
  reply_message_id TEXT,
  handled_at TEXT,
  handled_by TEXT,
  fetched_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_notification_provider_id ON xhs_notifications(account_id, provider_notification_id);
CREATE INDEX idx_notifications_inbox ON xhs_notifications(dealer_id, status, occurred_at DESC);
CREATE INDEX idx_notifications_account ON xhs_notifications(account_id, tab, occurred_at DESC);
`;

/**
 * Video notes. Xiaohongshu publishes a video note through a different publisher than an image note
 * (`publish_with_video`), and it takes exactly one local file — so this is a path on the instance's host, and a post
 * has either images or a video, never both.
 */
const SCHEMA_V8 = /* sql */ `
ALTER TABLE posts ADD COLUMN video TEXT;
`;

/**
 * 车型库 / Vehicle Brain. A catalog row stops being a price list line and becomes the card the store actually sells
 * from: a gallery, the price it is sold at today, what it is, who it is for, what it is cross-shopped against, the
 * questions customers ask, and the angles a note can be written from. The prose may be AI-written; the numbers in it
 * are verified against these same rows plus inventory and offers, never invented. Archiving replaces deleting for a
 * trim that already has history.
 */
const SCHEMA_V9 = /* sql */ `
ALTER TABLE vehicles ADD COLUMN images TEXT NOT NULL DEFAULT '[]';
ALTER TABLE vehicles ADD COLUMN current_price INTEGER;
ALTER TABLE vehicles ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE vehicles ADD COLUMN target_customers TEXT NOT NULL DEFAULT '[]';
ALTER TABLE vehicles ADD COLUMN competitors TEXT NOT NULL DEFAULT '[]';
ALTER TABLE vehicles ADD COLUMN faqs TEXT NOT NULL DEFAULT '[]';
ALTER TABLE vehicles ADD COLUMN content_angles TEXT NOT NULL DEFAULT '[]';
ALTER TABLE vehicles ADD COLUMN knowledge_generated_at TEXT;
ALTER TABLE vehicles ADD COLUMN knowledge_engine TEXT;
ALTER TABLE vehicles ADD COLUMN archived_at TEXT;
CREATE INDEX idx_vehicles_live ON vehicles(group_id, archived_at, brand, model);
`;

/**
 * 账号语言风格. One row per account — never shared, never merged: the whole point is that each account keeps writing
 * the way it already writes. Everything in it is derived from that account's own published notes, which stay in
 * `public_posts`; `sample_note_ids` records exactly which ones the profile was built from.
 */
const SCHEMA_V10 = /* sql */ `
CREATE TABLE account_voice_profiles (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE REFERENCES xhs_accounts(id) ON DELETE CASCADE,
  dealer_id TEXT NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  sample_count INTEGER NOT NULL DEFAULT 0,
  sample_note_ids TEXT NOT NULL DEFAULT '[]',
  metrics TEXT NOT NULL DEFAULT '{}',
  rules TEXT NOT NULL DEFAULT '[]',
  vocabulary TEXT NOT NULL DEFAULT '{}',
  examples TEXT NOT NULL DEFAULT '[]',
  avoid TEXT NOT NULL DEFAULT '[]',
  engine TEXT NOT NULL,
  analyzed_at TEXT NOT NULL,
  newest_sample_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_voice_dealer ON account_voice_profiles(dealer_id, analyzed_at DESC);
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'initial_schema', sql: SCHEMA_V1 },
  { version: 2, name: 'signal_detection_fields', sql: SCHEMA_V2 },
  { version: 3, name: 'provenance_actor_sessions', sql: SCHEMA_V3 },
  { version: 4, name: 'account_platform_profile', sql: SCHEMA_V4 },
  { version: 5, name: 'lead_avatar', sql: SCHEMA_V5 },
  { version: 6, name: 'account_removed_at', sql: SCHEMA_V6 },
  { version: 7, name: 'xhs_notifications', sql: SCHEMA_V7 },
  { version: 8, name: 'post_video', sql: SCHEMA_V8 },
  { version: 9, name: 'vehicle_brain', sql: SCHEMA_V9 },
  { version: 10, name: 'account_voice', sql: SCHEMA_V10 },
];
