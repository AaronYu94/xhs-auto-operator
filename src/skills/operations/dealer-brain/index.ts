/**
 * Dealer Brain (spec §2): centralized, structured, source-aware dealership knowledge.
 * Every factual claim used by content, outreach and conversations is retrieved from — and verified
 * against — these rows. The LLM never invents dealership facts.
 */
import { v } from '../../../core/validate.ts';
import { defineSkill } from '../../registry.ts';
import { FACT_QUESTION_KINDS, answerFact, type FactAnswer, type FactQuestion } from './facts.ts';

export {
  contentMixValidator,
  importDealerBrain,
  parseDealerBrainBundle,
  type AccountSeed,
  type DealerBrainBundle,
  type DealerSeed,
  type GroupSeed,
  type ImportOptions,
  type ImportSummary,
  type InventorySeed,
  type KnowledgeSeed,
  type OfferSeed,
  type PersonaSeed,
  type VehicleSeed,
} from './bundle.ts';
export {
  findInventory,
  findVehicles,
  getActiveOffers,
  getDealer,
  getDealerProfile,
  getKnowledge,
  getProhibitedClaims,
  isKnowledgeActive,
  isOfferActive,
  listDealers,
  offerAppliesToVehicle,
  resolveVehicle,
  type InventoryMatch,
  type InventoryQuery,
  type OfferQuery,
  type ProhibitedClaim,
  type VehicleQuery,
} from './queries.ts';
export {
  FACT_QUESTION_KINDS,
  answerFact,
  vehicleDisplayName,
  type FactAnswer,
  type FactQuestion,
  type FactQuestionKind,
} from './facts.ts';
export {
  extractClaims,
  verifyClaims,
  type ClaimCheck,
  type ClaimType,
  type ExtractedClaim,
  type MoneyRole,
} from './verify.ts';
export {
  DEALER_SETTING_KEYS,
  DEFAULT_DEALER_SETTINGS,
  colorMatches,
  exactCny,
  isValidAt,
  isValidDateValue,
  mergeDealerSettings,
  stableId,
} from './shared.ts';

const optionalText = v.optional(v.string({ min: 1, max: 100 }));

export const factQuestionValidator = v.object({
  kind: v.literal(FACT_QUESTION_KINDS),
  model: optionalText,
  trim: optionalText,
  exterior_color: optionalText,
  interior_color: optionalText,
});

export const skill = defineSkill<{ dealer_id: string; question: FactQuestion }, FactAnswer>({
  name: 'dealer-brain',
  category: 'operations',
  agent: 'automotive-operator',
  description:
    '从结构化门店数据（车型、库存、优惠、金融/租赁/置换方案、门店信息）检索事实并生成可溯源的中文答复；不计算落地价，不编造数据。',
  input: v.object({
    dealer_id: v.string({ min: 1 }),
    question: factQuestionValidator,
  }),
  run(ctx, input) {
    return answerFact(ctx, input.dealer_id, input.question);
  },
  validateOutput(output) {
    for (const f of output.facts) {
      if (!output.text.includes(f.claim)) throw new Error(`dealer-brain: fact claim "${f.claim}" is not in the answer text`);
    }
  },
});
