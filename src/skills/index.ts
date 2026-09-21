/**
 * Skill registry wiring (ARCHITECTURE §8 D1). Every `src/skills/<category>/<name>/index.ts` exports a `skill`;
 * `registerAllSkills` registers all of them so the Operator and the API can invoke skills by name.
 * test/unit/operator/workflows.test.ts asserts that every skill directory on disk is registered here.
 */
import type { SkillDefinition } from './registry.ts';
import { SkillRegistry } from './registry.ts';
import { skill as accountAssignment } from './acquisition/account-assignment/index.ts';
import { skill as queryGeneration } from './acquisition/automotive-query-generation/index.ts';
import { skill as intentDetection } from './acquisition/intent-detection/index.ts';
import { skill as leadDeduplication } from './acquisition/lead-deduplication/index.ts';
import { skill as leadDiscovery } from './acquisition/lead-discovery/index.ts';
import { skill as leadResearch } from './acquisition/lead-research/index.ts';
import { skill as leadScoring } from './acquisition/lead-scoring/index.ts';
import { skill as accountStrategy } from './content/account-strategy/index.ts';
import { skill as accountVoice } from './content/account-voice/index.ts';
import { skill as contentPlanning } from './content/content-planning/index.ts';
import { skill as contentReview } from './content/content-review/index.ts';
import { skill as engagement } from './content/engagement/index.ts';
import { skill as postGeneration } from './content/post-generation/index.ts';
import { skill as publishing } from './content/publishing/index.ts';
import { skill as accountBrain } from './operations/account-brain/index.ts';
import { skill as accountHealth } from './operations/account-health/index.ts';
import { skill as accountSessions } from './operations/account-sessions/index.ts';
import { skill as analytics } from './operations/analytics/index.ts';
import { skill as compliance } from './operations/compliance/index.ts';
import { skill as crm } from './operations/crm/index.ts';
import { skill as dealerBrain } from './operations/dealer-brain/index.ts';
import { skill as notificationInbox } from './operations/notification-inbox/index.ts';
import { skill as vehicleBrain } from './operations/vehicle-brain/index.ts';
import { skill as optimization } from './operations/optimization/index.ts';
import { skill as reporting } from './operations/reporting/index.ts';
import { skill as automotiveMarketResearch } from './research/automotive-market-research/index.ts';
import { skill as competitorResearch } from './research/competitor-research/index.ts';
import { skill as trendDetection } from './research/trend-detection/index.ts';
import { skill as xhsResearch } from './research/xhs-research/index.ts';
import { skill as appointment } from './sales/appointment/index.ts';
import { skill as conversation } from './sales/conversation/index.ts';
import { skill as followUp } from './sales/follow-up/index.ts';
import { skill as outreach } from './sales/outreach/index.ts';
import { skill as qualification } from './sales/qualification/index.ts';

// Heterogeneous skill definitions share one registry; their precise input/output types stay in each module.
type AnySkill = SkillDefinition<never, unknown>;

export const ALL_SKILLS: readonly AnySkill[] = [
  // research
  xhsResearch,
  competitorResearch,
  automotiveMarketResearch,
  trendDetection,
  // content
  accountStrategy,
  accountVoice,
  contentPlanning,
  postGeneration,
  contentReview,
  publishing,
  engagement,
  // acquisition
  queryGeneration,
  leadDiscovery,
  intentDetection,
  leadResearch,
  leadScoring,
  leadDeduplication,
  accountAssignment,
  // sales
  outreach,
  followUp,
  conversation,
  qualification,
  appointment,
  // operations
  dealerBrain,
  vehicleBrain,
  accountBrain,
  accountHealth,
  accountSessions,
  notificationInbox,
  crm,
  compliance,
  analytics,
  reporting,
  optimization,
] as unknown as AnySkill[];

/** Register every skill (idempotent per registry: already-registered names are left as they are). */
export function registerAllSkills(registry: SkillRegistry = new SkillRegistry()): SkillRegistry {
  for (const s of ALL_SKILLS) {
    if (!registry.has(s.name)) registry.register(s as unknown as SkillDefinition<unknown, unknown>);
  }
  return registry;
}
