/**
 * Wave B integration gate — module contract (ARCHITECTURE.md §8, B1–B5, plus the §5.3 group-matching exports of A5).
 *
 * 1. Compile time: `npx tsc --noEmit` checks every §8 B signature is assignable from the implementation (type-only
 *    imports; erased at runtime). Implementations may be supersets (additive exports / fields / optional params).
 * 2. Runtime: dynamically imports every Wave B module and checks each contract export exists with the right `typeof`,
 *    that the contract's async functions are async and its sync functions are not.
 * 3. Skills: every Wave B skill directory exports a `skill` named after its directory, owned by the §2 agent.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AppContext } from '../../src/app/context.ts';
import type {
  AssignmentCandidate,
  AutomotiveIntent,
  ContentPlan,
  GoalSpec,
  IntentDetection,
  Lead,
  LeadAssignment,
  LeadSignal,
  LeadStage,
  Post,
  ResearchBrief,
  ScoreComponent,
  ScoreTier,
  SearchQuery,
  SignalContext,
  SignalSourceType,
} from '../../src/core/types.ts';
import type { SkillDefinition } from '../../src/skills/registry.ts';

import type * as Dedup from '../../src/skills/acquisition/lead-deduplication/index.ts';
import type * as LeadResearch from '../../src/skills/acquisition/lead-research/index.ts';
import type * as QueryGen from '../../src/skills/acquisition/automotive-query-generation/index.ts';
import type * as XhsResearch from '../../src/skills/research/xhs-research/index.ts';
import type * as CompetitorResearch from '../../src/skills/research/competitor-research/index.ts';
import type * as MarketResearch from '../../src/skills/research/automotive-market-research/index.ts';
import type * as TrendDetection from '../../src/skills/research/trend-detection/index.ts';
import type * as AccountStrategy from '../../src/skills/content/account-strategy/index.ts';
import type * as ContentPlanning from '../../src/skills/content/content-planning/index.ts';
import type * as Analytics from '../../src/skills/operations/analytics/index.ts';
import type * as Fleet from '../../src/skills/acquisition/account-assignment/index.ts';
import type * as Scoring from '../../src/skills/acquisition/lead-scoring/index.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Compile-time contract (fails `npx tsc --noEmit` when an implementation drifts from §8)
// ─────────────────────────────────────────────────────────────────────────────

/** `Impl` must be assignable to the contract type `Contract`. */
type Conforms<Contract, Impl extends Contract> = Impl;
/** `T` must declare every key in `K`. */
type HasKeys<T, K extends keyof T> = K;

type ContractSignalInput = {
  source_type: SignalSourceType;
  public_post_id?: string | null;
  public_comment_id?: string | null;
  post_title?: string | null;
  content: string;
  signal_at: string;
  search_run_id?: string | null;
  query_id?: string | null;
  detection: IntentDetection;
};
type ContractUpsertResult = { lead: Lead; signal: LeadSignal | null; created: boolean; merged: boolean; stage_changes: LeadStage[] };

// A5 · group-level dealer matching (§5.3)
type ContractDealerEvaluation = { dealer_id: string; detection: IntentDetection; score: number; tier: ScoreTier; components: ScoreComponent[] };
export type A5GroupMatching = [
  Conforms<(ctx: AppContext, dealerId: string) => string[], typeof Scoring.listGroupDealerIds>,
  Conforms<
    (
      ctx: AppContext,
      input: {
        dealer_ids: string[];
        text: string;
        context: SignalContext;
        signal_at: string;
        authenticity?: { score: number; reasons: string[] };
        preferred_dealer_id?: string | null;
      },
    ) => { results: ContractDealerEvaluation[]; best: ContractDealerEvaluation },
    typeof Scoring.evaluateSignalForDealers
  >,
];

// B1 · lead-deduplication & lead-research
export type B1Dedup = [
  HasKeys<Dedup.SignalInput, keyof ContractSignalInput>,
  Conforms<ContractSignalInput, Dedup.SignalInput>,
  Conforms<ContractUpsertResult, Dedup.UpsertLeadResult>,
  Conforms<
    (
      ctx: AppContext,
      input: {
        dealer_id: string;
        identity: { platform_user_id: string; username: string; profile_url?: string | null };
        signal: ContractSignalInput;
        attributed_post_id?: string | null;
      },
    ) => ContractUpsertResult,
    typeof Dedup.upsertLeadFromSignal
  >,
  Conforms<(base: AutomotiveIntent, next: AutomotiveIntent) => AutomotiveIntent, typeof Dedup.mergeIntents>,
  Conforms<(ctx: AppContext, groupId: string, platformUserId: string) => Lead | undefined, typeof Dedup.findLeadByIdentity>,
  Conforms<
    {
      lead_id: string;
      status: 'researched' | 'skipped';
      reason: string;
      authenticity: { score: number; reasons: string[] };
      added_signals: number;
      industry_account: boolean;
    },
    LeadResearch.LeadResearchResult
  >,
  Conforms<(ctx: AppContext, leadId: string) => Promise<LeadResearch.LeadResearchResult>, typeof LeadResearch.researchLead>,
];

// B2 · automotive-query-generation
type ContractQueryPlanInput = { dealer_id: string; goal: GoalSpec; goal_id?: string | null };
type ContractQueryEffectiveness = {
  query: SearchQuery;
  runs: number;
  posts_discovered: number;
  comments_scanned: number;
  users_evaluated: number;
  candidates: number;
  qualified: number;
  high_intent: number;
  lead_density: number;
  candidate_rate: number;
  appointments: number;
  won: number;
  conversion_rate: number;
  smoothed_density: number;
};
export type B2QueryGeneration = [
  Conforms<ContractQueryPlanInput, QueryGen.QueryPlanInput>,
  Conforms<(ctx: AppContext, input: ContractQueryPlanInput) => SearchQuery[], typeof QueryGen.generateQueries>,
  Conforms<ContractQueryEffectiveness, QueryGen.QueryEffectiveness>,
  Conforms<(ctx: AppContext, dealerId: string, opts?: { from?: string; to?: string }) => ContractQueryEffectiveness[], typeof QueryGen.getQueryEffectiveness>,
  Conforms<(ctx: AppContext, dealerId: string) => { reprioritized: number; derived: SearchQuery[]; retired: SearchQuery[] }, typeof QueryGen.evolveQueries>,
  Conforms<(ctx: AppContext, dealerId: string, limit: number, goalId?: string | null) => SearchQuery[], typeof QueryGen.selectQueriesToRun>,
];

// B3 · research, strategy, planning
type ContractResearchInput = { dealer_id: string; models?: string[]; location?: string | null; window_days?: number };
export type B3ResearchPlanning = [
  Conforms<(ctx: AppContext, input: ContractResearchInput) => Promise<ResearchBrief>, typeof XhsResearch.runXhsResearch>,
  Conforms<(ctx: AppContext, input: ContractResearchInput) => Promise<ResearchBrief>, typeof CompetitorResearch.runCompetitorResearch>,
  Conforms<(ctx: AppContext, input: ContractResearchInput) => Promise<ResearchBrief>, typeof MarketResearch.runMarketResearch>,
  Conforms<(ctx: AppContext, input: ContractResearchInput) => ResearchBrief, typeof TrendDetection.runTrendDetection>,
  Conforms<
    (ctx: AppContext, accountId: string, opts?: { goal?: GoalSpec; goal_id?: string | null }) => ContentPlan['strategy'],
    typeof AccountStrategy.buildAccountStrategy
  >,
  Conforms<
    (ctx: AppContext, input: { dealer_id: string; period_start: string; days?: number; goal_id?: string | null }) => { plans: ContentPlan[]; posts: Post[] },
    typeof ContentPlanning.planContent
  >,
];

// B4 · analytics
type ContractFilters = {
  dealer_id?: string;
  account_id?: string;
  brand?: string;
  model?: string;
  location?: string;
  from?: string;
  to?: string;
  source_type?: SignalSourceType;
  stage?: LeadStage;
};
export type B4Analytics = [
  Conforms<ContractFilters, Analytics.AnalyticsFilters>,
  Conforms<Analytics.AnalyticsFilters, ContractFilters>,
  Conforms<(ctx: AppContext, f: ContractFilters) => { from: string; to: string }, typeof Analytics.resolvePeriod>,
  Conforms<(ctx: AppContext, f: ContractFilters) => Analytics.DashboardMetrics, typeof Analytics.getDashboard>,
  Conforms<(ctx: AppContext, f: ContractFilters & { tier?: ScoreTier; limit?: number; offset?: number }) => Analytics.LeadCard[], typeof Analytics.getLeadInbox>,
  Conforms<(ctx: AppContext, leadId: string) => Analytics.LeadDetail, typeof Analytics.getLeadDetail>,
  Conforms<(ctx: AppContext, f: ContractFilters) => Analytics.ContentAttributionRow[], typeof Analytics.getContentAttribution>,
  Conforms<(ctx: AppContext, f: ContractFilters) => { stage: LeadStage; count: number; conversion_from_prev: number }[], typeof Analytics.getFunnel>,
  Conforms<(ctx: AppContext, dealerId?: string) => Analytics.AccountOverviewRow[], typeof Analytics.getAccountsOverview>,
];

// B5 · account-assignment (Fleet Controller)
export type B5Fleet = [
  Conforms<(ctx: AppContext, lead: Lead) => AssignmentCandidate[], typeof Fleet.rankAccountsForLead>,
  Conforms<
    (
      ctx: AppContext,
      leadId: string,
      opts?: { reassign_to?: string; actor?: string; reason?: string },
    ) => { assignment: LeadAssignment | null; candidates: AssignmentCandidate[]; changed: boolean; reason: string },
    typeof Fleet.assignLead
  >,
  Conforms<(ctx: AppContext, leadId: string) => LeadAssignment | undefined, typeof Fleet.getActiveAssignment>,
  Conforms<(ctx: AppContext, leadId: string, reason: string, actor: string) => void, typeof Fleet.releaseAssignment>,
];

// ─────────────────────────────────────────────────────────────────────────────
// Runtime contract
// ─────────────────────────────────────────────────────────────────────────────

type Kind = 'function' | 'async' | 'object';

interface ModuleContract {
  module: string; // repo-relative path
  exports: Record<string, Kind>;
  /** skill directory name and owning agent when the module is a skill entry point */
  skill?: { name: string; category: string; agent: string };
}

const CONTRACT: Record<'A5' | 'B1' | 'B2' | 'B3' | 'B4' | 'B5', ModuleContract[]> = {
  A5: [
    {
      module: 'src/skills/acquisition/lead-scoring/index.ts',
      exports: { evaluateSignalForDealers: 'function', listGroupDealerIds: 'function' },
    },
  ],
  B1: [
    {
      module: 'src/skills/acquisition/lead-deduplication/index.ts',
      exports: { upsertLeadFromSignal: 'function', mergeIntents: 'function', findLeadByIdentity: 'function', skill: 'object' },
      skill: { name: 'lead-deduplication', category: 'acquisition', agent: 'lead-hunting-agent' },
    },
    {
      module: 'src/skills/acquisition/lead-research/index.ts',
      exports: { researchLead: 'async', skill: 'object' },
      skill: { name: 'lead-research', category: 'acquisition', agent: 'lead-research-agent' },
    },
  ],
  B2: [
    {
      module: 'src/skills/acquisition/automotive-query-generation/index.ts',
      exports: {
        generateQueries: 'function',
        getQueryEffectiveness: 'function',
        evolveQueries: 'function',
        selectQueriesToRun: 'function',
        skill: 'object',
      },
      skill: { name: 'automotive-query-generation', category: 'acquisition', agent: 'lead-hunting-agent' },
    },
  ],
  B3: [
    {
      module: 'src/skills/research/xhs-research/index.ts',
      exports: { runXhsResearch: 'async', skill: 'object' },
      skill: { name: 'xhs-research', category: 'research', agent: 'research-agent' },
    },
    {
      module: 'src/skills/research/competitor-research/index.ts',
      exports: { runCompetitorResearch: 'async', skill: 'object' },
      skill: { name: 'competitor-research', category: 'research', agent: 'research-agent' },
    },
    {
      module: 'src/skills/research/automotive-market-research/index.ts',
      exports: { runMarketResearch: 'async', skill: 'object' },
      skill: { name: 'automotive-market-research', category: 'research', agent: 'research-agent' },
    },
    {
      module: 'src/skills/research/trend-detection/index.ts',
      exports: { runTrendDetection: 'function', skill: 'object' },
      skill: { name: 'trend-detection', category: 'research', agent: 'research-agent' },
    },
    {
      module: 'src/skills/content/account-strategy/index.ts',
      exports: { buildAccountStrategy: 'function', skill: 'object' },
      skill: { name: 'account-strategy', category: 'content', agent: 'account-strategy-agent' },
    },
    {
      module: 'src/skills/content/content-planning/index.ts',
      exports: { planContent: 'function', skill: 'object' },
      skill: { name: 'content-planning', category: 'content', agent: 'account-strategy-agent' },
    },
  ],
  B4: [
    {
      module: 'src/skills/operations/analytics/index.ts',
      exports: {
        resolvePeriod: 'function',
        getDashboard: 'function',
        getLeadInbox: 'function',
        getLeadDetail: 'function',
        getContentAttribution: 'function',
        getFunnel: 'function',
        getAccountsOverview: 'function',
        skill: 'object',
      },
      skill: { name: 'analytics', category: 'operations', agent: 'analytics-agent' },
    },
  ],
  B5: [
    {
      module: 'src/skills/acquisition/account-assignment/index.ts',
      exports: {
        rankAccountsForLead: 'function',
        assignLead: 'function',
        getActiveAssignment: 'function',
        releaseAssignment: 'function',
        skill: 'object',
      },
      skill: { name: 'account-assignment', category: 'acquisition', agent: 'fleet-controller' },
    },
  ],
};

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

async function importRepoModule(relPath: string): Promise<Record<string, unknown>> {
  const abs = join(ROOT, relPath);
  assert.ok(existsSync(abs), `${relPath} does not exist`);
  return (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
}

const isAsyncFunction = (fn: unknown): boolean => typeof fn === 'function' && fn.constructor.name === 'AsyncFunction';

describe('integration: Wave B module contract (ARCHITECTURE.md §8 B1–B5, §5.3)', () => {
  for (const [wave, modules] of Object.entries(CONTRACT)) {
    for (const spec of modules) {
      it(`${wave} · ${spec.module} exports the contract API`, async () => {
        const mod = await importRepoModule(spec.module);
        for (const [name, kind] of Object.entries(spec.exports)) {
          assert.ok(name in mod, `${spec.module} is missing export ${name}`);
          if (kind === 'object') {
            assert.equal(typeof mod[name], 'object', `${spec.module}: ${name} should be an object`);
            assert.notEqual(mod[name], null);
            continue;
          }
          assert.equal(typeof mod[name], 'function', `${spec.module}: ${name} should be a function`);
          assert.equal(
            isAsyncFunction(mod[name]),
            kind === 'async',
            `${spec.module}: ${name} is ${kind === 'async' ? 'async (returns a Promise)' : 'synchronous'} in §8`,
          );
        }
        if (spec.skill) {
          const skill = mod.skill as SkillDefinition<unknown, unknown>;
          assert.equal(skill.name, spec.skill.name);
          assert.equal(skill.category, spec.skill.category);
          assert.equal(skill.agent, spec.skill.agent, `${spec.skill.name} is owned by ${spec.skill.agent}`);
          assert.equal(typeof skill.run, 'function');
          assert.equal(typeof skill.input, 'function');
          assert.ok(existsSync(join(ROOT, spec.module.replace(/index\.ts$/, 'SKILL.md'))), `${spec.skill.name}/SKILL.md exists`);
        }
      });
    }
  }
});
