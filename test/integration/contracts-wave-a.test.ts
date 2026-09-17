/**
 * Wave A integration gate — module contract (ARCHITECTURE.md §8, A1–A6).
 *
 * 1. Runtime: dynamically imports every Wave A module and checks each contract export exists with the
 *    right `typeof` (classes also expose their contract methods).
 * 2. Compile time: `npx tsc --noEmit` checks every contract signature is assignable from the implementation
 *    (type-only imports; erased at runtime).
 * 3. Skills: every `src/skills/<category>/<name>/index.ts` exports a well-formed `skill` named after its
 *    directory, owned by a known agent, with a complete SKILL.md.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import type { AppContext } from '../../src/app/context.ts';
import type { Clock } from '../../src/core/clock.ts';
import { ValidationError } from '../../src/core/errors.ts';
import { LEAD_STAGES, PURCHASE_STAGES } from '../../src/core/types.ts';
import type {
  AccountHealth,
  AccountPersona,
  AgentDecision,
  ApprovalPolicy,
  AuditEvent,
  ContactSuppression,
  Conversion,
  ConversationIntent,
  ConversationSlots,
  Dealer,
  DealerKnowledge,
  DealerProfile,
  Evidence,
  FactRef,
  IntentDetection,
  InventoryStatus,
  KnowledgeCategory,
  Lead,
  LeadScore,
  LeadStage,
  LeadStageTransition,
  Offer,
  OfferType,
  Platform,
  PrefilterResult,
  Schedule,
  ScoreComponent,
  ScoreTier,
  ScoringConfig,
  ScoringThresholds,
  ScoringWeights,
  SignalContext,
  Vehicle,
  WorkflowRun,
  WorkflowStep,
  WorkflowTrigger,
  XhsAccount,
  Post,
  Inventory,
} from '../../src/core/types.ts';
import type { LlmProvider } from '../../src/providers/llm/types.ts';
import type { XhsProvider } from '../../src/providers/xhs/types.ts';
import { AGENTS, SKILL_CATEGORIES, SkillRegistry, type SkillDefinition } from '../../src/skills/registry.ts';
import { createTestContext } from '../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture } from '../helpers/fixtures.ts';

import type * as DealerBrain from '../../src/skills/operations/dealer-brain/index.ts';
import type * as AccountBrain from '../../src/skills/operations/account-brain/index.ts';
import type * as AccountHealthMod from '../../src/skills/operations/account-health/index.ts';
import type * as Fixtures from '../helpers/fixtures.ts';
import type * as Simulation from '../../src/providers/xhs/simulation.ts';
import type * as McpClient from '../../src/providers/xhs/mcp-client.ts';
import type * as McpProvider from '../../src/providers/xhs/mcp-provider.ts';
import type * as Juguang from '../../src/providers/xhs/juguang-webhook.ts';
import type * as XhsIndex from '../../src/providers/xhs/index.ts';
import type * as Lexicon from '../../src/domain/automotive-lexicon.ts';
import type * as IntentNlu from '../../src/skills/acquisition/intent-detection/nlu.ts';
import type * as IntentSkill from '../../src/skills/acquisition/intent-detection/index.ts';
import type * as ConversationNlu from '../../src/skills/sales/conversation/nlu.ts';
import type * as Crm from '../../src/skills/operations/crm/index.ts';
import type * as Compliance from '../../src/skills/operations/compliance/index.ts';
import type * as Scoring from '../../src/skills/acquisition/lead-scoring/index.ts';
import type * as Anthropic from '../../src/providers/llm/anthropic.ts';
import type * as LlmIndex from '../../src/providers/llm/index.ts';
import type * as Engine from '../../src/operator/workflow-engine.ts';
import type * as SchedulerMod from '../../src/operator/scheduler.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Compile-time contract (fails `npx tsc --noEmit` when an implementation drifts from §8)
// ─────────────────────────────────────────────────────────────────────────────

/** `Impl` must be assignable to the contract type `Contract`. */
type Conforms<Contract, Impl extends Contract> = Impl;
/** `T` must declare every key in `K`. */
type HasKeys<T, K extends keyof T> = K;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// A1 · dealer-brain
export type A1DealerBrain = [
  HasKeys<DealerBrain.DealerBrainBundle, 'group' | 'dealers' | 'vehicles' | 'inventory' | 'offers' | 'knowledge' | 'accounts'>,
  Conforms<{ group_id: string; dealer_ids: Record<string, string>; account_ids: Record<string, string>; vehicle_ids: Record<string, string>; counts: Record<string, number> }, DealerBrain.ImportSummary>,
  Conforms<(ctx: AppContext, bundle: DealerBrain.DealerBrainBundle) => DealerBrain.ImportSummary, typeof DealerBrain.importDealerBrain>,
  Conforms<(ctx: AppContext, dealerId: string) => Dealer, typeof DealerBrain.getDealer>,
  Conforms<(ctx: AppContext, groupId?: string) => Dealer[], typeof DealerBrain.listDealers>,
  Conforms<(ctx: AppContext, dealerId: string) => DealerProfile, typeof DealerBrain.getDealerProfile>,
  Conforms<(ctx: AppContext, groupId: string, q: { brand?: string; model?: string; trim?: string }) => Vehicle[], typeof DealerBrain.findVehicles>,
  Conforms<(ctx: AppContext, groupId: string, q: { brand?: string; model?: string; trim?: string }) => Vehicle | null, typeof DealerBrain.resolveVehicle>,
  Conforms<{ inventory: Inventory; vehicle: Vehicle }, DealerBrain.InventoryMatch>,
  Conforms<
    (
      ctx: AppContext,
      dealerId: string,
      q: { model?: string; trim?: string; vehicle_id?: string; exterior_color?: string; interior_color?: string; statuses?: InventoryStatus[] },
    ) => DealerBrain.InventoryMatch[],
    typeof DealerBrain.findInventory
  >,
  Conforms<(ctx: AppContext, dealerId: string, q?: { model?: string; vehicle_id?: string; types?: OfferType[] }) => Offer[], typeof DealerBrain.getActiveOffers>,
  Conforms<(ctx: AppContext, dealerId: string, categories?: KnowledgeCategory[]) => DealerKnowledge[], typeof DealerBrain.getKnowledge>,
  Conforms<(ctx: AppContext, dealerId: string) => { phrase: string; reason: string; knowledge_id: string }[], typeof DealerBrain.getProhibitedClaims>,
  Expect<Equal<DealerBrain.FactQuestionKind, 'price' | 'inventory' | 'offer' | 'finance' | 'lease' | 'trade_in' | 'store' | 'spec' | 'highlights'>>,
  Conforms<DealerBrain.FactQuestion, { kind: DealerBrain.FactQuestionKind; model?: string; trim?: string; exterior_color?: string; interior_color?: string }>,
  Conforms<{ found: boolean; text: string; facts: FactRef[]; missing: string[] }, DealerBrain.FactAnswer>,
  Conforms<(ctx: AppContext, dealerId: string, q: DealerBrain.FactQuestion) => DealerBrain.FactAnswer, typeof DealerBrain.answerFact>,
  Conforms<{ passed: boolean; issues: string[]; verified: FactRef[]; unverified_claims: string[] }, DealerBrain.ClaimCheck>,
  Conforms<(ctx: AppContext, dealerId: string, text: string, declared: FactRef[]) => DealerBrain.ClaimCheck, typeof DealerBrain.verifyClaims>,
];

// A1 · account-brain, account-health, fixtures
export type A1AccountBrain = [
  HasKeys<
    AccountBrain.AccountPerformance,
    | 'posts_published_30d'
    | 'avg_engagement_30d'
    | 'leads_owned_active'
    | 'outreach_sent_30d'
    | 'replies_30d'
    | 'reply_rate_30d'
    | 'appointments_90d'
    | 'won_90d'
    | 'conversion_rate_90d'
    | 'negative_feedback_7d'
  >,
  Conforms<{ account: XhsAccount; persona: AccountPersona; health: AccountHealth | null; performance: AccountBrain.AccountPerformance; recent_posts: Post[] }, AccountBrain.AccountBrain>,
  Conforms<(ctx: AppContext, accountId: string) => AccountBrain.AccountBrain, typeof AccountBrain.getAccountBrain>,
  Conforms<(ctx: AppContext, q: { dealer_id?: string; group_id?: string }) => AccountBrain.AccountBrain[], typeof AccountBrain.listFleet>,
  Conforms<(ctx: AppContext, accountId: string) => AccountBrain.AccountPerformance, typeof AccountBrain.getAccountPerformance>,
  Conforms<
    { policy: ApprovalPolicy; daily_limit: number; min_interval_minutes: number; max_unanswered_touches: number; follow_up_after_days: number; auto_send_min_score: number; timezone: string },
    AccountBrain.OutreachPolicy
  >,
  Conforms<(ctx: AppContext, accountId: string) => AccountBrain.OutreachPolicy, typeof AccountBrain.effectiveOutreachPolicy>,
  Conforms<(ctx: AppContext, accountId: string) => { policy: ApprovalPolicy; daily_limit: number; timezone: string }, typeof AccountBrain.effectivePublishPolicy>,
  Conforms<(ctx: AppContext, accountId: string, patch: Partial<AccountPersona>, actor: string) => AccountPersona, typeof AccountBrain.updatePersona>,
  Conforms<(ctx: AppContext, accountId: string) => AccountHealth, typeof AccountHealthMod.computeAccountHealth>,
  Conforms<(ctx: AppContext, dealerId: string) => AccountHealth[], typeof AccountHealthMod.computeFleetHealth>,
  Conforms<(ctx: AppContext, accountId: string) => AccountHealth | null, typeof AccountHealthMod.getLatestHealth>,
  Conforms<(ctx: AppContext, accountId: string) => { ok: boolean; blocking: boolean; reason: string }, typeof AccountHealthMod.isAccountOperable>,
  Conforms<(ctx: AppContext) => DealerBrain.ImportSummary, typeof Fixtures.loadDealerFixture>,
];

// A2 · providers
export type A2Providers = [
  HasKeys<Simulation.SimulationCorpus, 'notes' | 'profiles' | 'inbox_scripts'>,
  Conforms<Simulation.SimulationOptions, { send_messages?: boolean; publish?: boolean; receive_messages?: boolean; reply_comments?: boolean; auth_required_accounts?: string[] }>,
  Conforms<new (clock: Clock, corpus: Simulation.SimulationCorpus, opts?: Simulation.SimulationOptions) => XhsProvider, typeof Simulation.SimulationXhsProvider>,
  Conforms<(clock: Clock, path: string, opts?: Simulation.SimulationOptions) => Simulation.SimulationXhsProvider, typeof Simulation.SimulationXhsProvider.fromFile>,
  Conforms<(accountId: string, platformUserId: string) => void, Simulation.SimulationXhsProvider['recordManualContact']>,
  Conforms<() => { account_id: string; to: string; text: string; at: string }[], Simulation.SimulationXhsProvider['sentMessages']>,
  Conforms<new (opts: { url: string; token?: string; fetchImpl?: typeof fetch; timeoutMs?: number }) => McpClient.McpHttpClient, typeof McpClient.McpHttpClient>,
  Conforms<new (clock: Clock, cfg: McpProvider.McpProviderConfig, fetchImpl?: typeof fetch) => XhsProvider, typeof McpProvider.McpXhsProvider>,
  Conforms<(body: unknown) => Juguang.JuguangLead[], typeof Juguang.parseJuguangLeadPush>,
  Conforms<(clock: Clock, cfg: XhsIndex.XhsProviderConfig) => XhsProvider, typeof XhsIndex.createXhsProvider>,
];

// A3 · lexicon, intent detection, conversation NLU
export type A3Nlu = [
  Conforms<(text: string) => { brand: string; brand_zh: string; quote: string }[], typeof Lexicon.findBrands>,
  Conforms<(text: string) => { brand: string; model: string; quote: string }[], typeof Lexicon.findModels>,
  Conforms<(text: string, model?: string) => { model: string; trim: string; quote: string }[], typeof Lexicon.findTrims>,
  Conforms<(text: string) => { city?: string; province?: string; quote: string } | null, typeof Lexicon.findLocation>,
  Conforms<(ipLocation: string | null | undefined) => string | null, typeof Lexicon.provinceOfIp>,
  Conforms<(brand: string, model: string) => { brand: string; model: string; model_zh: string }[], typeof Lexicon.competitorsOf>,
  Conforms<(brand: string, model: string, lang?: 'zh' | 'en') => string, typeof Lexicon.modelDisplayName>,
  Conforms<Record<string, string>, typeof Lexicon.CITY_PROVINCE>,
  Conforms<(text: string, context?: SignalContext) => PrefilterResult, typeof IntentNlu.prefilter>,
  Conforms<(text: string, context?: SignalContext, dealer?: DealerProfile) => IntentDetection, typeof IntentNlu.detectIntentRules>,
  Conforms<
    (ctx: AppContext, input: { text: string; context?: SignalContext; dealer?: DealerProfile; subject?: { type: string; id: string } }) => Promise<IntentDetection>,
    typeof IntentSkill.detectIntent
  >,
  Conforms<(text: string) => { intents: ConversationIntent[]; evidence: Evidence[] }, typeof ConversationNlu.detectConversationIntents>,
  Conforms<(text: string, opts: { now: Date; tz: string; previous?: ConversationSlots }) => ConversationSlots, typeof ConversationNlu.extractSlots>,
  Conforms<(text: string, now: Date, tz: string) => { at: string | null; text: string | null }, typeof ConversationNlu.resolveAppointmentTime>,
  Conforms<(text: string) => { phone?: string; wechat?: string }, typeof ConversationNlu.detectContactInfo>,
];

// A4 · crm & compliance
export type A4Crm = [
  Conforms<Record<LeadStage, number>, typeof Crm.STAGE_INDEX>,
  Conforms<Record<LeadStage, number>, typeof Crm.STAGE_WIN_PROBABILITY>,
  Conforms<(from: LeadStage, to: LeadStage) => boolean, typeof Crm.canTransition>,
  Conforms<
    (ctx: AppContext, leadId: string, to: LeadStage, meta: { reason: string; actor: string }) => { lead: Lead; changed: boolean; transition: LeadStageTransition | null },
    typeof Crm.transitionLead
  >,
  Conforms<(ctx: AppContext, leadId: string, to: 'CANDIDATE' | 'QUALIFIED', meta: { reason: string; actor: string }) => Lead, typeof Crm.reopenLead>,
  Conforms<(ctx: AppContext, platformUserId: string, platform?: Platform) => ContactSuppression | null, typeof Crm.isSuppressed>,
  Conforms<
    (
      ctx: AppContext,
      input: { platform_user_id: string; reason: string; source: string; actor: string },
    ) => { suppression: ContactSuppression; leads_updated: string[]; outreach_cancelled: string[]; conversations_closed: string[] },
    typeof Crm.suppressContact
  >,
  Conforms<
    (ctx: AppContext, input: { lead_id: string; outcome: 'won' | 'lost'; amount?: number; vehicle_id?: string; lost_reason?: string; actor: string }) => Conversion,
    typeof Crm.recordConversion
  >,
  Conforms<(ctx: AppContext, lead: Lead) => string, typeof Crm.computeNextAction>,
  Conforms<(ctx: AppContext, leadId: string) => Lead, typeof Crm.refreshNextAction>,
  Conforms<(ctx: AppContext, leadId: string) => { transitions: LeadStageTransition[]; events: AuditEvent[]; decisions: AgentDecision[] }, typeof Crm.getLeadTimeline>,
  Conforms<{ code: string; message: string; quote?: string }, Compliance.RuleIssue>,
  Conforms<
    (text: string, opts: { prohibited: { phrase: string; reason: string }[]; max_length: number; channel: 'dm' | 'comment' | 'post' }) => { passed: boolean; issues: Compliance.RuleIssue[] },
    typeof Compliance.checkPlatformRules
  >,
  Conforms<(text: string) => Compliance.RuleIssue[], typeof Compliance.detectContactInfoLeak>,
  Conforms<(text: string, others: string[], threshold?: number) => { duplicate: boolean; max_similarity: number }, typeof Compliance.isNearDuplicate>,
];

// A5 · lead scoring & LLM
export type A5Scoring = [
  Conforms<ScoringWeights, typeof Scoring.DEFAULT_WEIGHTS>,
  Conforms<ScoringThresholds, typeof Scoring.DEFAULT_THRESHOLDS>,
  Conforms<(score: number, t: ScoringThresholds) => ScoreTier, typeof Scoring.tierFor>,
  Conforms<(ctx: AppContext, dealerId: string) => ScoringConfig, typeof Scoring.getScoringConfig>,
  Conforms<
    (ctx: AppContext, dealerId: string, patch: { weights?: Partial<ScoringWeights>; thresholds?: Partial<ScoringThresholds> }, actor: string) => ScoringConfig,
    typeof Scoring.updateScoringConfig
  >,
  Conforms<Scoring.SignalScoreInput, { detection: IntentDetection; signal_at: string; now: string; dealer: DealerProfile; authenticity?: { score: number; reasons: string[] } }>,
  Conforms<
    (input: Scoring.SignalScoreInput, cfg: Pick<ScoringConfig, 'weights' | 'thresholds'>) => { score: number; tier: ScoreTier; components: ScoreComponent[] },
    typeof Scoring.scoreSignal
  >,
  Conforms<(ctx: AppContext, leadId: string) => LeadScore, typeof Scoring.scoreLead>,
  Conforms<
    new (opts: { apiKey: string; model?: string; baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number; maxRetries?: number }) => LlmProvider,
    typeof Anthropic.AnthropicLlmProvider
  >,
  Conforms<(env: Record<string, string | undefined>) => LlmProvider, typeof LlmIndex.createLlmProvider>,
];

// A6 · workflow engine & scheduler
export type A6Operator = [
  Conforms<{ ctx: AppContext; run: WorkflowRun; input: Record<string, unknown>; outputs: Record<string, Record<string, unknown>> }, Engine.StepContext>,
  HasKeys<Engine.WorkflowStepDef, 'key' | 'agent' | 'skill' | 'description' | 'run' | 'retries' | 'optional'>,
  HasKeys<Engine.WorkflowDef, 'name' | 'description' | 'steps'>,
  Conforms<new (defs?: Engine.WorkflowDef[]) => Engine.WorkflowEngine, typeof Engine.WorkflowEngine>,
  Conforms<(def: Engine.WorkflowDef) => void, Engine.WorkflowEngine['register']>,
  Conforms<() => Engine.WorkflowDef[], Engine.WorkflowEngine['list']>,
  Conforms<
    (ctx: AppContext, name: string, input: Record<string, unknown>, opts: { trigger: WorkflowTrigger; dealer_id?: string | null; goal_id?: string | null }) => Promise<WorkflowRun>,
    Engine.WorkflowEngine['start']
  >,
  Conforms<(ctx: AppContext, runId: string) => Promise<WorkflowRun>, Engine.WorkflowEngine['resume']>,
  Conforms<(ctx: AppContext) => WorkflowRun[], Engine.WorkflowEngine['recoverInterrupted']>,
  Conforms<(ctx: AppContext, runId: string) => { run: WorkflowRun; steps: WorkflowStep[] }, Engine.WorkflowEngine['getRun']>,
  Conforms<{ workflow: string; cron: string }[], typeof SchedulerMod.DEFAULT_DAILY_SCHEDULE>,
  Conforms<new (engine: Engine.WorkflowEngine) => SchedulerMod.Scheduler, typeof SchedulerMod.Scheduler>,
  Conforms<(ctx: AppContext, dealerId: string, plan?: { workflow: string; cron: string }[]) => Schedule[], SchedulerMod.Scheduler['ensureSchedules']>,
  Conforms<(ctx: AppContext, now: Date) => Schedule[], SchedulerMod.Scheduler['due']>,
  Conforms<(ctx: AppContext) => Promise<WorkflowRun[]>, SchedulerMod.Scheduler['tick']>,
  Conforms<(ctx: AppContext, intervalMs: number) => () => void, SchedulerMod.Scheduler['start']>,
];

// ─────────────────────────────────────────────────────────────────────────────
// Runtime contract
// ─────────────────────────────────────────────────────────────────────────────

type Kind = 'function' | 'object' | 'string' | 'number' | 'boolean';

interface ModuleContract {
  module: string; // repo-relative path
  exports: Record<string, Kind>;
  /** class export → instance methods (on the prototype) */
  classes?: Record<string, string[]>;
  /** class export → static methods */
  statics?: Record<string, string[]>;
}

const XHS_PROVIDER_METHODS = [
  'capabilities',
  'searchNotes',
  'getNote',
  'getComments',
  'getUserProfile',
  'publishNote',
  'getEngagement',
  'replyToComment',
  'listInboundMessages',
  'sendMessage',
];

const CONTRACT: Record<'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6', ModuleContract[]> = {
  A1: [
    {
      module: 'src/skills/operations/dealer-brain/index.ts',
      exports: {
        importDealerBrain: 'function',
        getDealer: 'function',
        listDealers: 'function',
        getDealerProfile: 'function',
        findVehicles: 'function',
        resolveVehicle: 'function',
        findInventory: 'function',
        getActiveOffers: 'function',
        getKnowledge: 'function',
        getProhibitedClaims: 'function',
        answerFact: 'function',
        verifyClaims: 'function',
        skill: 'object',
      },
    },
    {
      module: 'src/skills/operations/account-brain/index.ts',
      exports: {
        getAccountBrain: 'function',
        listFleet: 'function',
        getAccountPerformance: 'function',
        effectiveOutreachPolicy: 'function',
        effectivePublishPolicy: 'function',
        updatePersona: 'function',
      },
    },
    {
      module: 'src/skills/operations/account-health/index.ts',
      exports: { computeAccountHealth: 'function', computeFleetHealth: 'function', getLatestHealth: 'function', isAccountOperable: 'function' },
    },
    { module: 'test/helpers/fixtures.ts', exports: { loadDealerFixture: 'function' } },
  ],
  A2: [
    {
      module: 'src/providers/xhs/simulation.ts',
      exports: { SimulationXhsProvider: 'function' },
      classes: { SimulationXhsProvider: [...XHS_PROVIDER_METHODS, 'recordManualContact', 'sentMessages'] },
      statics: { SimulationXhsProvider: ['fromFile'] },
    },
    {
      module: 'src/providers/xhs/mcp-client.ts',
      exports: { McpHttpClient: 'function' },
      classes: { McpHttpClient: ['initialize', 'listTools', 'callTool'] },
    },
    {
      module: 'src/providers/xhs/mcp-provider.ts',
      exports: { McpXhsProvider: 'function' },
      classes: { McpXhsProvider: XHS_PROVIDER_METHODS },
    },
    { module: 'src/providers/xhs/juguang-webhook.ts', exports: { parseJuguangLeadPush: 'function' } },
    { module: 'src/providers/xhs/index.ts', exports: { createXhsProvider: 'function' } },
  ],
  A3: [
    {
      module: 'src/domain/automotive-lexicon.ts',
      exports: {
        findBrands: 'function',
        findModels: 'function',
        findTrims: 'function',
        findLocation: 'function',
        provinceOfIp: 'function',
        competitorsOf: 'function',
        modelDisplayName: 'function',
        CITY_PROVINCE: 'object',
      },
    },
    { module: 'src/skills/acquisition/intent-detection/nlu.ts', exports: { prefilter: 'function', detectIntentRules: 'function' } },
    { module: 'src/skills/acquisition/intent-detection/index.ts', exports: { detectIntent: 'function', skill: 'object' } },
    {
      module: 'src/skills/sales/conversation/nlu.ts',
      exports: { detectConversationIntents: 'function', extractSlots: 'function', resolveAppointmentTime: 'function', detectContactInfo: 'function' },
    },
  ],
  A4: [
    {
      module: 'src/skills/operations/crm/index.ts',
      exports: {
        STAGE_INDEX: 'object',
        STAGE_WIN_PROBABILITY: 'object',
        canTransition: 'function',
        transitionLead: 'function',
        reopenLead: 'function',
        isSuppressed: 'function',
        suppressContact: 'function',
        recordConversion: 'function',
        computeNextAction: 'function',
        refreshNextAction: 'function',
        getLeadTimeline: 'function',
        skill: 'object',
      },
    },
    {
      module: 'src/skills/operations/compliance/index.ts',
      exports: { checkPlatformRules: 'function', detectContactInfoLeak: 'function', isNearDuplicate: 'function' },
    },
  ],
  A5: [
    {
      module: 'src/skills/acquisition/lead-scoring/index.ts',
      exports: {
        DEFAULT_WEIGHTS: 'object',
        DEFAULT_THRESHOLDS: 'object',
        tierFor: 'function',
        getScoringConfig: 'function',
        updateScoringConfig: 'function',
        scoreSignal: 'function',
        scoreLead: 'function',
        skill: 'object',
      },
    },
    {
      module: 'src/providers/llm/anthropic.ts',
      exports: { AnthropicLlmProvider: 'function' },
      classes: { AnthropicLlmProvider: ['status', 'completeJson', 'completeText'] },
    },
    { module: 'src/providers/llm/index.ts', exports: { createLlmProvider: 'function', AnthropicLlmProvider: 'function' } },
  ],
  A6: [
    {
      module: 'src/operator/workflow-engine.ts',
      exports: { WorkflowEngine: 'function' },
      classes: { WorkflowEngine: ['register', 'list', 'start', 'resume', 'recoverInterrupted', 'getRun'] },
    },
    {
      module: 'src/operator/scheduler.ts',
      exports: { DEFAULT_DAILY_SCHEDULE: 'object', Scheduler: 'function' },
      classes: { Scheduler: ['ensureSchedules', 'due', 'tick', 'start'] },
    },
  ],
};

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKILLS_ROOT = join(ROOT, 'src', 'skills');

async function importRepoModule(relPath: string): Promise<Record<string, unknown>> {
  const abs = join(ROOT, relPath);
  assert.ok(existsSync(abs), `${relPath} does not exist`);
  return (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
}

/** Wave A skill directories (category/name) that must exist. */
const WAVE_A_SKILLS = [
  'operations/dealer-brain',
  'operations/account-brain',
  'operations/account-health',
  'operations/crm',
  'operations/compliance',
  'acquisition/intent-detection',
  'acquisition/lead-scoring',
];

const SKILL_MD_SECTIONS = ['Responsibility', 'Owning agent', 'Inputs', 'Outputs', 'Validation & guarantees', 'Runtime entry points', 'Failure modes', 'Tests'];

function discoverSkillDirs(): string[] {
  const out: string[] = [];
  for (const category of readdirSync(SKILLS_ROOT)) {
    const catDir = join(SKILLS_ROOT, category);
    if (!statSync(catDir).isDirectory()) continue;
    for (const name of readdirSync(catDir)) {
      const dir = join(catDir, name);
      if (statSync(dir).isDirectory() && existsSync(join(dir, 'index.ts'))) out.push(`${category}/${name}`);
    }
  }
  return out.sort();
}

describe('integration: Wave A module contract (ARCHITECTURE.md §8)', () => {
  for (const [wave, modules] of Object.entries(CONTRACT)) {
    for (const spec of modules) {
      it(`${wave} · ${spec.module} exports the contract API`, async () => {
        const mod = await importRepoModule(spec.module);
        for (const [name, kind] of Object.entries(spec.exports)) {
          assert.ok(name in mod, `${spec.module} is missing export ${name}`);
          assert.equal(typeof mod[name], kind, `${spec.module}: ${name} should be ${kind}`);
        }
        for (const [cls, methods] of Object.entries(spec.classes ?? {})) {
          const proto = (mod[cls] as { prototype: Record<string, unknown> }).prototype;
          for (const m of methods) assert.equal(typeof proto[m], 'function', `${cls}.prototype.${m}`);
        }
        for (const [cls, methods] of Object.entries(spec.statics ?? {})) {
          const ctor = mod[cls] as unknown as Record<string, unknown>;
          for (const m of methods) assert.equal(typeof ctor[m], 'function', `${cls}.${m}`);
        }
      });
    }
  }

  it('agrees across modules on the binding §4/§5 constants', async () => {
    const crm = await importRepoModule('src/skills/operations/crm/index.ts');
    const stageIndex = crm.STAGE_INDEX as Record<string, number>;
    LEAD_STAGES.forEach((stage, i) => assert.equal(stageIndex[stage], i, `STAGE_INDEX.${stage}`));

    const scoring = await importRepoModule('src/skills/acquisition/lead-scoring/index.ts');
    assert.deepEqual(
      { ...(scoring.DEFAULT_WEIGHTS as object) },
      { explicit_purchase_intent: 25, transaction_questions: 15, model_match: 12, inventory_match: 10, location_match: 10, purchase_stage: 12, recency: 6, authenticity: 5, dealer_relevance: 5 },
    );
    assert.deepEqual({ ...(scoring.DEFAULT_THRESHOLDS as object) }, { candidate: 20, qualified: 60, high_intent: 80, immediate: 92 });

    // A3 detection strength anchors and A5 scoring anchors are the same table
    const nlu = await importRepoModule('src/skills/acquisition/intent-detection/nlu.ts');
    const expectedAnchors = { awareness: 0.1, research: 0.2, comparison: 0.4, price_shopping: 0.88, active_shopping: 1, dealer_selection: 1, purchase_imminent: 1 };
    for (const stage of PURCHASE_STAGES) {
      assert.equal((nlu.STAGE_STRENGTH as Record<string, number>)[stage], expectedAnchors[stage], `A3 STAGE_STRENGTH.${stage}`);
      assert.equal((scoring.STRENGTH_ANCHORS as Record<string, number>)[stage], expectedAnchors[stage], `A5 STRENGTH_ANCHORS.${stage}`);
    }

    const scheduler = await importRepoModule('src/operator/scheduler.ts');
    assert.deepEqual(scheduler.DEFAULT_DAILY_SCHEDULE, [
      { workflow: 'refresh_dealer_data', cron: '08:00' },
      { workflow: 'market_research', cron: '08:30' },
      { workflow: 'account_planning', cron: '09:00' },
      { workflow: 'lead_discovery', cron: '09:30' },
      { workflow: 'signal_processing', cron: 'every:60' },
      { workflow: 'reply_processing', cron: 'every:30' },
      { workflow: 'content_publishing', cron: 'every:60' },
      { workflow: 'performance_collection', cron: '18:00' },
      { workflow: 'evening_analysis', cron: '20:00' },
    ]);

    const lexicon = await importRepoModule('src/domain/automotive-lexicon.ts');
    assert.equal((lexicon.CITY_PROVINCE as Record<string, string>)['杭州'], '浙江');
    assert.equal((lexicon.CITY_PROVINCE as Record<string, string>)['上海'], '上海');
    const modelDisplayName = lexicon.modelDisplayName as (b: string, m: string, l?: 'zh' | 'en') => string;
    assert.equal(modelDisplayName('BMW', 'i3', 'en'), 'BMW i3');
    assert.equal(modelDisplayName('BMW', '3 Series', 'zh'), '宝马3系');
  });

  it('builds providers from configuration without faking capabilities', async () => {
    const ctx = createTestContext();
    const xhs = await importRepoModule('src/providers/xhs/index.ts');
    const none = (xhs.createXhsProvider as (c: Clock, cfg: { kind: 'none' }) => XhsProvider)(ctx.clock, { kind: 'none' });
    assert.equal(none.mode, 'none');
    const report = await none.capabilities(null);
    assert.ok(Object.values(report.capabilities).every((c) => c.status === 'UNAVAILABLE'));

    const llm = await importRepoModule('src/providers/llm/index.ts');
    const createLlmProvider = llm.createLlmProvider as (env: Record<string, string | undefined>) => LlmProvider;
    assert.equal(createLlmProvider({}).status().status, 'UNAVAILABLE');
    assert.equal(createLlmProvider({ ANTHROPIC_API_KEY: '   ' }).status().status, 'UNAVAILABLE');
  });
});

describe('integration: Wave A skills', () => {
  const discovered = discoverSkillDirs();

  it('discovers every Wave A skill directory', () => {
    for (const dir of WAVE_A_SKILLS) assert.ok(discovered.includes(dir), `missing skill directory src/skills/${dir}/index.ts`);
  });

  for (const dir of discovered) {
    it(`src/skills/${dir} exports a well-formed skill named after its directory`, async () => {
      const [category, name] = dir.split('/');
      const mod = await importRepoModule(`src/skills/${dir}/index.ts`);
      const skill = mod.skill as SkillDefinition<unknown, unknown> | undefined;
      assert.ok(skill && typeof skill === 'object', `src/skills/${dir}/index.ts must export const skill`);
      assert.equal(skill.name, name, 'skill.name must equal its directory name');
      assert.equal(skill.category, category, 'skill.category must equal its category directory');
      assert.ok((SKILL_CATEGORIES as readonly string[]).includes(skill.category));
      assert.ok((AGENTS as readonly string[]).includes(skill.agent), `unknown agent ${skill.agent}`);
      assert.equal(typeof skill.description, 'string');
      assert.ok(skill.description.trim().length >= 10, 'skill.description must explain the responsibility');
      assert.equal(typeof skill.input, 'function');
      assert.equal(typeof skill.run, 'function');
      if (skill.validateOutput !== undefined) assert.equal(typeof skill.validateOutput, 'function');
      assert.throws(() => skill.input(null, name), ValidationError, 'input validator must reject a non-object');

      const mdPath = join(SKILLS_ROOT, category, name, 'SKILL.md');
      assert.ok(existsSync(mdPath), `src/skills/${dir}/SKILL.md missing`);
      const md = readFileSync(mdPath, 'utf8');
      const headings = new Set([...md.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]));
      for (const section of SKILL_MD_SECTIONS) assert.ok(headings.has(section), `SKILL.md of ${dir} lacks "## ${section}"`);
      assert.match(md, new RegExp(`^#\\s+${name.replace(/[-]/g, '\\-')}\\s*$`, 'm'), `SKILL.md of ${dir} must be titled "# ${name}"`);
      for (const section of SKILL_MD_SECTIONS) {
        const body = md.split(new RegExp(`^##\\s+${section.replace(/[&]/g, '\\&')}\\s*$`, 'm'))[1]?.split(/^##\s+/m)[0] ?? '';
        assert.ok(body.trim().length > 0, `SKILL.md of ${dir}: "## ${section}" is empty`);
      }
    });
  }

  it('registers every skill without name collisions and invokes them through the registry', async () => {
    const registry = new SkillRegistry();
    for (const dir of discovered) {
      const mod = await importRepoModule(`src/skills/${dir}/index.ts`);
      registry.register(mod.skill as SkillDefinition<unknown, unknown>);
    }
    assert.equal(registry.list().length, discovered.length);

    const ctx = createTestContext({ skills: registry });
    const summary = loadDealerFixture(ctx);
    const dealerId = dealerIdByKey(summary, 'hz-bmw');

    const store = await registry.invoke<DealerBrain.FactAnswer>(ctx, 'dealer-brain', { dealer_id: dealerId, question: { kind: 'store' } });
    assert.equal(store.found, true);
    assert.ok(store.facts.length > 0);

    const compliance = await registry.invoke<{ passed: boolean }>(ctx, 'compliance', { text: '加我微信 bmw_hz88 聊', channel: 'dm' });
    assert.equal(compliance.passed, false);

    const intent = await registry.invoke<{ detection: IntentDetection }>(ctx, 'intent-detection', {
      text: '杭州i3 35L白外红内有现车吗？这周想去看看',
      context: { source_type: 'comment', post_title: '宝马i3现在值得买吗？' },
      dealer_id: dealerId,
    });
    assert.equal(intent.detection.is_purchase_signal, true);
    assert.equal(intent.detection.intent.purchase_stage, 'purchase_imminent');

    const health = await registry.invoke<AccountHealth[]>(ctx, 'account-health', { dealer_id: dealerId });
    assert.equal(health.length, 6, 'hz-bmw manages six accounts');

    await assert.rejects(registry.invoke(ctx, 'crm', { action: 'nope' }), ValidationError);
  });
});
