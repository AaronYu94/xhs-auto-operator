/**
 * Intent Detection skill (A3): rules-first purchase-intent detection with optional, strictly validated
 * LLM refinement and an auditable decision per analyzed subject.
 */
import type { AppContext } from '../../../app/context.ts';
import { dedupeEvidence, isVerbatimQuote } from '../../../core/evidence.ts';
import { clamp, round, truncate } from '../../../core/text.ts';
import { DEFAULT_TZ } from '../../../core/time.ts';
import {
  PURCHASE_STAGES,
  SIGNAL_SOURCE_TYPES,
  TRANSACTION_QUESTIONS,
  type AuthorRole,
  type AutomotiveIntent,
  type DealerProfile,
  type Evidence,
  type IntentDetection,
  type PrefilterResult,
  type PurchaseStage,
  type SignalContext,
  type TransactionQuestion,
} from '../../../core/types.ts';
import { v, type Infer } from '../../../core/validate.ts';
import {
  anchorQuote,
  detectTimeframe,
  findLocation,
  findModels,
  findTrims,
  getModelInfo,
  modelShortLabel,
  parseBudget,
  resolveModelName,
} from '../../../domain/automotive-lexicon.ts';
import { buildDealerProfile } from '../../../domain/dealer-profile.ts';
import type { LlmJsonRequest } from '../../../providers/llm/types.ts';
import { defineSkill } from '../../registry.ts';
import {
  QUESTION_EVIDENCE,
  STAGE_STRENGTH,
  analyzeSignal,
  isNonBuyerRole,
  locationLabel,
  prefilter,
  stageIndex,
  type IntentRuleOptions,
  type SignalAnalysis,
} from './nlu.ts';

export { analyzeSignal, detectIntentRules, isNonBuyerRole, NON_BUYER_ROLES, prefilter, STAGE_STRENGTH, type IntentRuleOptions } from './nlu.ts';

export interface DetectIntentInput {
  text: string;
  context?: SignalContext;
  dealer?: DealerProfile;
  /** when given, an `intent_detection` AgentDecision is recorded for this subject */
  subject?: { type: string; id: string };
  /** IANA timezone for calendar expressions ('9月底'); default: the dealer's configured timezone, else Asia/Shanghai */
  tz?: string;
}

const AGENT = 'intent-detection-agent';
const SKILL = 'intent-detection';
/** LLM refinement is skipped when rules are already this sure AND a model is known. */
const LLM_STRENGTH_CEILING = 0.9;

// ─────────────────────────────────────────────────────────────────────────────
// LLM request / validation
// ─────────────────────────────────────────────────────────────────────────────

const LLM_FIELDS = ['model', 'trim', 'location', 'budget', 'timeframe', 'competing_models', 'stage', 'negative', ...TRANSACTION_QUESTIONS] as const;
/** LLM-claimed negative feedback must quote an actual refusal / purchase-elsewhere expression. */
const NEGATIVE_CUE_RE = /不|别|没|算了|放弃|拒|无需|免了|退订|拉黑|举报|骚扰|已经|已|买了|提了|订了|入手了|太贵|再说/;

export const INTENT_LLM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    is_purchase_signal: { type: 'boolean' },
    purchase_stage: { type: ['string', 'null'], enum: [...PURCHASE_STAGES, null] },
    negative: { type: 'boolean' },
    model: { type: ['string', 'null'] },
    trim: { type: ['string', 'null'] },
    city: { type: ['string', 'null'] },
    province: { type: ['string', 'null'] },
    competing_models: { type: 'array', items: { type: 'string' } },
    transaction_questions: { type: 'array', items: { type: 'string', enum: [...TRANSACTION_QUESTIONS] } },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          field: { type: 'string', enum: [...LLM_FIELDS] },
          label: { type: 'string' },
          quote: { type: 'string' },
        },
        required: ['field', 'label', 'quote'],
      },
    },
  },
  required: ['is_purchase_signal', 'purchase_stage', 'evidence'],
};

const SYSTEM_PROMPT = [
  '你是汽车经销商的小红书购车意向分析员。只根据给定的用户原文判断购车意向，绝不编造。',
  '购车阶段（由浅到深）：awareness 种草/心动；research 询问产品细节（空间、续航、质量、值不值得买）；comparison 多车型对比；',
  'price_shopping 询问价格/落地价/优惠但未指定配置或地点；active_shopping 指定配置/颜色/城市问价、问现车、问贷款置换、想试驾；',
  'dealer_selection 询问去哪家店买；purchase_imminent 准备下定或近期（本周/近期）到店/提车。',
  '每条 evidence 的 quote 必须逐字复制自“用户原文”（车型字段可引用“帖子标题”），field 表示该证据支持的字段。',
  '没有逐字证据支持的车型、配置、地点、预算一律不要输出。只输出 JSON。',
].join('\n');

function buildLlmRequest(analysis: SignalAnalysis, input: DetectIntentInput): LlmJsonRequest {
  const d = analysis.detection;
  const payload = {
    用户原文: analysis.analyzed_text,
    来源类型: input.context?.source_type ?? 'unknown',
    帖子标题: input.context?.source_type === 'post' ? null : (input.context?.post_title ?? null),
    经销商在售车型: input.dealer?.models ?? [],
    规则引擎结果: {
      purchase_stage: d.intent.purchase_stage ?? null,
      model: d.intent.model ?? null,
      trim: d.intent.trim ?? null,
      location: d.intent.location ?? d.intent.province ?? null,
      transaction_questions: d.transaction_questions,
      negative: d.negative,
    },
  };
  return {
    purpose: 'intent_refinement',
    system: SYSTEM_PROMPT,
    prompt: `请分析以下小红书内容的购车意向，按 JSON Schema 输出：\n${JSON.stringify(payload, null, 2)}`,
    schema: INTENT_LLM_SCHEMA,
    max_tokens: 800,
  };
}

interface LlmEvidence {
  field: string;
  label: string;
  quote: string;
}

interface LlmIntentPayload {
  is_purchase_signal?: boolean;
  purchase_stage?: PurchaseStage | null;
  negative?: boolean;
  model?: string;
  trim?: string;
  city?: string;
  province?: string;
  competing_models: string[];
  transaction_questions: TransactionQuestion[];
  evidence: LlmEvidence[];
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown): string | undefined => (typeof x === 'string' && x.trim().length > 0 ? x.trim() : undefined);

/** Structural validation of untrusted LLM JSON; malformed parts are dropped, never trusted. */
export function parseLlmIntentPayload(data: unknown): LlmIntentPayload | null {
  if (!isObj(data)) return null;
  const stageRaw = data.purchase_stage;
  const stage =
    stageRaw === null ? null : typeof stageRaw === 'string' && (PURCHASE_STAGES as readonly string[]).includes(stageRaw) ? (stageRaw as PurchaseStage) : undefined;
  const evidence = Array.isArray(data.evidence)
    ? data.evidence.flatMap((e): LlmEvidence[] => {
        if (!isObj(e)) return [];
        const field = str(e.field);
        const quote = typeof e.quote === 'string' ? e.quote : undefined;
        if (!field || !quote || !(LLM_FIELDS as readonly string[]).includes(field)) return [];
        return [{ field, quote, label: truncate(str(e.label) ?? '', 40) }];
      })
    : [];
  return {
    is_purchase_signal: typeof data.is_purchase_signal === 'boolean' ? data.is_purchase_signal : undefined,
    purchase_stage: stage,
    negative: typeof data.negative === 'boolean' ? data.negative : undefined,
    model: str(data.model),
    trim: str(data.trim),
    city: str(data.city),
    province: str(data.province),
    competing_models: Array.isArray(data.competing_models) ? data.competing_models.flatMap((m) => (str(m) ? [str(m)!] : [])) : [],
    transaction_questions: Array.isArray(data.transaction_questions)
      ? data.transaction_questions.filter((q): q is TransactionQuestion => typeof q === 'string' && (TRANSACTION_QUESTIONS as readonly string[]).includes(q))
      : [],
    evidence,
  };
}

export interface LlmRefinement {
  detection: IntentDetection;
  accepted: string[];
  rejected: string[];
}

/**
 * Merge validated LLM output into the rules detection (pure).
 * - evidence quotes must be verbatim substrings of the analyzed text (model evidence may quote the post title)
 * - model / trim / location / budget / timeframe are only accepted when a verbatim quote re-parses to that value
 * - purchase stage may move at most one step from the rules stage; the LLM may add, never remove, negative feedback
 * - an owner / creator / marketing author (ARCHITECTURE §5.1) is never turned into a purchase signal: the rules
 *   detection is returned unchanged with the rejection `non_buyer_author_role`
 */
export function refineWithLlm(
  analysis: SignalAnalysis,
  data: unknown,
  context?: SignalContext,
  dealer?: DealerProfile,
  opts: IntentRuleOptions = {},
): LlmRefinement {
  const rules = analysis.detection;
  const payload = parseLlmIntentPayload(data);
  if (!payload) return { detection: rules, accepted: [], rejected: ['malformed_payload'] };
  if (rules.is_marketing === true || isNonBuyerRole(rules.author_role)) {
    return { detection: rules, accepted: [], rejected: ['non_buyer_author_role'] };
  }

  const text = analysis.analyzed_text;
  const postSources = context?.source_type === 'post' ? [] : [context?.post_title, context?.post_content];
  const inText = (q: string) => isVerbatimQuote(text, q);
  // LLM quotes are re-anchored to the exact raw substring (the model may change case, width or spacing)
  const anchored = (quote: string, sources: readonly (string | null | undefined)[]): string => {
    for (const s of sources) {
      const hit = s ? anchorQuote(s, quote) : null;
      if (hit) return hit;
    }
    return quote;
  };
  const verified = (field: string) =>
    payload.evidence.filter((e) => e.field === field && inText(e.quote)).map((e) => ({ ...e, quote: anchored(e.quote, [text]) }));
  const accepted: string[] = [];
  const rejected: string[] = [];
  const intent: AutomotiveIntent = { ...rules.intent };
  const inferred = new Set(intent.inferred_fields ?? []);
  const evidence: Evidence[] = [...rules.evidence];
  const questions = new Set(rules.transaction_questions);
  const extra = dealer ? dealer.models.filter((m) => !getModelInfo(m)).map((m) => ({ brand: dealer.brands[0] ?? '', model: m })) : [];
  const canonicalModel = (name: string): string | null =>
    resolveModelName(name) ?? dealer?.models.find((m) => m.toLowerCase() === name.toLowerCase()) ?? null;
  const quoteHasModel = (quote: string, model: string) =>
    findModels(quote, { context: `${text}\n${postSources.filter(Boolean).join('\n')}`, extra }).some((m) => m.model === model);

  // model
  if (!intent.model && payload.model) {
    const model = canonicalModel(payload.model);
    const supports = model ? payload.evidence.filter((e) => e.field === 'model' && quoteHasModel(e.quote, model)) : [];
    const statedEv = supports.find((e) => inText(e.quote));
    const contextEv = supports.find((e) => isVerbatimQuote(postSources, e.quote));
    if (model && (statedEv || contextEv)) {
      intent.model = model;
      intent.brand = getModelInfo(model)?.brand ?? dealer?.brands[0] ?? intent.brand;
      if (statedEv) {
        evidence.push({ code: 'stated_model', label: `提及车型 ${modelShortLabel(model)}`, quote: anchored(statedEv.quote, [text]) });
      } else if (contextEv) {
        inferred.add('brand');
        inferred.add('model');
        evidence.push({
          code: 'model_from_post_context',
          label: '车型来自帖子上下文',
          quote: anchored(contextEv.quote, postSources),
          source_ref: 'post_context',
        });
      }
      accepted.push('model');
    } else rejected.push('model');
  }

  // trim
  if (!intent.trim && payload.trim) {
    // the quote must re-parse (lexicon or Dealer-Brain aliases) to the SAME trim the LLM claims
    const wanted = payload.trim.toLowerCase().replace(/\s+/g, '');
    const sameTrim = (canonical: string) => {
      const c = canonical.toLowerCase();
      return c === wanted || c.endsWith(wanted) || wanted.endsWith(c);
    };
    const cand = intent.model
      ? verified('trim')
          .map((e) => ({ e, t: findTrims(e.quote, intent.model, dealer?.trims)[0] }))
          .find((x) => x.t !== undefined && sameTrim(x.t.trim))
      : undefined;
    if (cand?.t) {
      intent.trim = cand.t.trim;
      evidence.push({ code: 'specified_trim', label: `指定配置 ${cand.t.trim}`, quote: cand.e.quote });
      accepted.push('trim');
    } else rejected.push('trim');
  }

  // location
  const hasStatedLocation = !!intent.location || (!!intent.province && !inferred.has('province'));
  if (!hasStatedLocation && (payload.city || payload.province)) {
    const match = verified('location')
      .map((e) => ({ e, loc: findLocation(e.quote) }))
      .find(({ loc }) => loc && (payload.city ? loc.city === payload.city.replace(/市$/, '') : loc.province === payload.province!.replace(/省$/, '')));
    if (match?.loc) {
      if (match.loc.city) intent.location = match.loc.city;
      if (match.loc.province) intent.province = match.loc.province;
      inferred.delete('province');
      evidence.push({ code: 'stated_location', label: locationLabel(match.loc, dealer), quote: match.e.quote });
      accepted.push('location');
    } else rejected.push('location');
  }

  // budget (values come from re-parsing the verbatim quote, never from the LLM)
  if (intent.budget_min === undefined && intent.budget_max === undefined) {
    const cand = verified('budget')
      .map((e) => ({ e, b: parseBudget(e.quote) }))
      .find((x) => x.b);
    if (cand?.b) {
      if (cand.b.budget_min !== undefined) intent.budget_min = cand.b.budget_min;
      if (cand.b.budget_max !== undefined) intent.budget_max = cand.b.budget_max;
      evidence.push({ code: 'budget', label: '预算', quote: cand.e.quote });
      accepted.push('budget');
    } else if (payload.evidence.some((e) => e.field === 'budget')) rejected.push('budget');
  }

  // timeframe (calendar expressions are placed relative to the same `now` as the rules pass)
  if (!intent.purchase_timeframe) {
    const cand = verified('timeframe')
      .map((e) => ({ e, t: detectTimeframe(e.quote, opts) }))
      .find((x) => x.t);
    if (cand?.t) {
      intent.purchase_timeframe = cand.t.timeframe;
      evidence.push({ code: 'purchase_timeframe', label: '购车时间', quote: cand.e.quote });
      accepted.push('timeframe');
    } else if (payload.evidence.some((e) => e.field === 'timeframe')) rejected.push('timeframe');
  }

  // competing models
  for (const name of payload.competing_models) {
    const model = canonicalModel(name);
    if (!model || model === intent.model || intent.competing_models?.includes(model)) continue;
    const ev = verified('competing_models').find((e) => quoteHasModel(e.quote, model));
    if (ev) {
      intent.competing_models = [...(intent.competing_models ?? []), model];
      evidence.push({ code: 'competing_model', label: `对比 ${modelShortLabel(model)}`, quote: ev.quote });
      accepted.push(`competing:${model}`);
    } else rejected.push(`competing:${model}`);
  }

  // transaction questions
  for (const q of payload.transaction_questions) {
    if (questions.has(q)) continue;
    const ev = verified(q)[0];
    if (!ev) {
      rejected.push(`question:${q}`);
      continue;
    }
    questions.add(q);
    evidence.push({ code: QUESTION_EVIDENCE[q].code, label: QUESTION_EVIDENCE[q].label, quote: ev.quote });
    if (q === 'price' || q === 'landing_price') intent.price_intent = true;
    if (q === 'discount') intent.discount_intent = true;
    if (q === 'inventory') intent.inventory_intent = true;
    if (q === 'finance') intent.financing_intent = true;
    if (q === 'lease') intent.leasing_intent = true;
    if (q === 'trade_in') intent.trade_in_intent = true;
    if (q === 'dealer_location') intent.dealer_selection_intent = true;
    if (q === 'test_drive') intent.visit_intent = true;
    accepted.push(`question:${q}`);
  }

  // negative feedback: the LLM may only make the result MORE conservative
  let negative = rules.negative;
  if (!negative && payload.negative === true) {
    const ev = verified('negative').find((e) => NEGATIVE_CUE_RE.test(e.quote.normalize('NFKC')));
    if (ev) {
      negative = true;
      evidence.push({ code: 'not_interested', label: '表示不需要/不考虑', quote: ev.quote });
      accepted.push('negative');
    } else rejected.push('negative');
  }

  // purchase stage: at most one step from the rules stage, and only with verbatim support
  const ruleIdx = stageIndex(rules.intent.purchase_stage);
  let llmIdx = ruleIdx;
  if (payload.is_purchase_signal === false) llmIdx = -1;
  else if (payload.purchase_stage) llmIdx = stageIndex(payload.purchase_stage);
  else if (payload.purchase_stage === null) llmIdx = -1;
  let finalIdx = ruleIdx;
  if (llmIdx !== ruleIdx) {
    const support = payload.evidence.filter((e) => inText(e.quote));
    if (support.length > 0) {
      finalIdx = clamp(llmIdx, Math.max(-1, ruleIdx - 1), Math.min(PURCHASE_STAGES.length - 1, ruleIdx + 1));
      const stageEv = support.find((e) => e.field === 'stage') ?? support[0];
      if (finalIdx !== ruleIdx) {
        evidence.push({ code: 'stage_rationale', label: stageEv.label || '模型判断购车阶段', quote: anchored(stageEv.quote, [text]) });
        accepted.push(`stage:${finalIdx >= 0 ? PURCHASE_STAGES[finalIdx] : 'none'}`);
      }
      if (finalIdx !== llmIdx) rejected.push('stage_jump_clamped');
    } else rejected.push('stage_unsupported');
  }
  const stage = negative || finalIdx < 0 ? undefined : PURCHASE_STAGES[finalIdx];
  if (stage) intent.purchase_stage = stage;
  else delete intent.purchase_stage;
  if (inferred.size > 0) intent.inferred_fields = [...inferred];
  intent.confidence = round(Math.min(0.97, (rules.intent.confidence ?? 0.5) + 0.03 + 0.02 * accepted.length), 2);

  // a buyer's own need or refusal makes the author an asker; otherwise keep the rules classification
  const role: AuthorRole = stage !== undefined || negative ? 'asker' : (rules.author_role ?? 'unknown');
  const sources = [text, ...postSources, context?.ip_location, context?.author_nickname];
  const detection: IntentDetection = {
    is_purchase_signal: !negative && stage !== undefined,
    intent,
    evidence: dedupeEvidence(evidence.filter((e) => !e.quote || isVerbatimQuote(sources, e.quote))),
    transaction_questions: TRANSACTION_QUESTIONS.filter((q) => questions.has(q)),
    strength: stage ? STAGE_STRENGTH[stage] : 0,
    negative,
    engine: 'llm+rules',
    is_marketing: false,
    author_role: role,
  };
  return { detection, accepted, rejected };
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime entry
// ─────────────────────────────────────────────────────────────────────────────

/** Timezone for calendar expressions: explicit input, else the dealer's configured timezone, else Asia/Shanghai. */
function detectionTimezone(ctx: AppContext, input: DetectIntentInput): string {
  const explicit = input.tz?.trim();
  if (explicit) return explicit;
  if (input.dealer?.dealer_id) {
    const configured = ctx.db.table('dealers').get(input.dealer.dealer_id)?.settings?.timezone;
    if (typeof configured === 'string' && configured.trim()) return configured.trim();
  }
  return DEFAULT_TZ;
}

export async function detectIntent(ctx: AppContext, input: DetectIntentInput): Promise<IntentDetection> {
  const opts: IntentRuleOptions = { now: ctx.clock.now(), tz: detectionTimezone(ctx, input) };
  const analysis = analyzeSignal(input.text, input.context, input.dealer, opts);
  let detection = analysis.detection;
  let llm: Record<string, unknown> = { used: false };

  // owners / creators / marketing accounts are settled by the rules: an LLM can never make them purchase signals
  const buyerVoice = detection.is_marketing !== true && !isNonBuyerRole(detection.author_role);
  const wantsLlm =
    analysis.prefilter.passed && buyerVoice && (detection.strength < LLM_STRENGTH_CEILING || !detection.intent.model);
  if (wantsLlm && ctx.llm.status().status === 'AVAILABLE') {
    try {
      const res = await ctx.llm.completeJson<unknown>(buildLlmRequest(analysis, input));
      if (res.ok) {
        const refined = refineWithLlm(analysis, res.data, input.context, input.dealer, opts);
        if (refined.rejected.includes('malformed_payload')) {
          llm = { used: false, fallback_reason: 'malformed_payload', model: res.model };
        } else {
          detection = refined.detection;
          llm = { used: true, model: res.model, accepted: refined.accepted, rejected: refined.rejected };
        }
      } else {
        llm = { used: false, fallback_reason: res.reason };
      }
    } catch (err) {
      llm = { used: false, fallback_reason: err instanceof Error ? err.message : String(err) };
    }
    if (llm.used !== true) ctx.log.debug('intent-detection: LLM refinement unavailable, rules result kept', llm);
  } else if (!buyerVoice) {
    llm = { used: false, skipped_reason: `author_role:${detection.author_role ?? 'marketing'}` };
  }

  if (input.subject) {
    ctx.audit.decision({
      agent: AGENT,
      skill: SKILL,
      decision_type: 'intent_detection',
      subject_type: input.subject.type,
      subject_id: input.subject.id,
      inputs: {
        text: input.text,
        context: input.context ?? null,
        dealer_id: input.dealer?.dealer_id ?? null,
        evaluated_at: ctx.clock.iso(),
        timezone: opts.tz,
        prefilter: analysis.prefilter,
        llm,
      },
      evidence: detection.evidence,
      output: {
        is_purchase_signal: detection.is_purchase_signal,
        author_role: detection.author_role ?? null,
        is_marketing: detection.is_marketing ?? false,
        purchase_stage: detection.intent.purchase_stage ?? null,
        strength: detection.strength,
        negative: detection.negative,
        transaction_questions: detection.transaction_questions,
        intent: detection.intent,
      },
      confidence: detection.intent.confidence ?? 0,
      engine: detection.engine,
    });
  }
  return detection;
}

const contextValidator = v.object({
  source_type: v.literal(SIGNAL_SOURCE_TYPES),
  post_title: v.optional(v.nullable(v.string({ max: 2000 }))),
  post_content: v.optional(v.nullable(v.string({ max: 20000 }))),
  ip_location: v.optional(v.nullable(v.string({ max: 100 }))),
  author_nickname: v.optional(v.nullable(v.string({ max: 200 }))),
});

export interface IntentDetectionSkillOutput {
  prefilter: PrefilterResult;
  detection: IntentDetection;
}

const skillInput = v.object({
  text: v.string({ max: 10000 }),
  context: v.optional(contextValidator),
  dealer_id: v.optional(v.string({ min: 1 })),
  subject: v.optional(v.object({ type: v.string({ min: 1 }), id: v.string({ min: 1 }) })),
});
export type IntentDetectionSkillInput = Infer<typeof skillInput>;

export const skill = defineSkill<IntentDetectionSkillInput, IntentDetectionSkillOutput>({
  name: 'intent-detection',
  category: 'acquisition',
  agent: 'intent-detection-agent',
  description:
    '判断一条小红书公开帖子/评论的购车意向：预过滤（夸赞/营销/无信号）、发言者身份（咨询者/车主/内容创作者/营销号）、车型/配置/地点/预算/时间/交易问题抽取、购车阶段与强度，全部附逐字证据；可选 LLM 细化（严格校验）。',
  input: skillInput,
  async run(ctx, input) {
    const dealer = input.dealer_id ? buildDealerProfile(ctx, input.dealer_id) : undefined;
    const detection = await detectIntent(ctx, { text: input.text, context: input.context, dealer, subject: input.subject });
    return { prefilter: prefilter(input.text, input.context), detection };
  },
  validateOutput(output) {
    if (output.detection.strength < 0 || output.detection.strength > 1) throw new Error('intent-detection: strength out of range');
    if (!output.detection.is_purchase_signal && output.detection.strength !== 0) throw new Error('intent-detection: non-signals carry strength 0');
  },
});
