/**
 * AI 车型知识生成 — the prose half of a vehicle card, written from the store's own data and never beyond it.
 *
 * What the model is asked for: a description, selling points, who the trim is for, the questions customers ask with
 * their answers, how it compares to what it is cross-shopped against, and angles a Xiaohongshu note could take.
 *
 * What it is not allowed to do: invent a number. Two guards run on every generated string before it is stored:
 *  1. `verifyClaims` (Dealer Brain): every price, discount, rate, term, stock and date claim must be backed by a real
 *     row of this store — the same verifier the published content goes through.
 *  2. `unsupportedMeasurements`: every "number + unit" in the text (续航/马力/座/公里/度/秒/期/成/%/台/万/元) must match a
 *     value that actually exists on this card. This is what `verifyClaims` alone cannot see: a plausible-sounding
 *     "续航 700 公里" on a car with 526 km is not a price claim, but it is still a lie.
 *
 * A string that fails either guard is dropped and reported in `rejected` — never silently fixed, never stored. If
 * everything is rejected, the card keeps what it had.
 */
import type { AppContext } from '../../../app/context.ts';
import type { Vehicle, VehicleCompetitor, VehicleFaq } from '../../../core/types.ts';
import { competitorsOf } from '../../../domain/automotive-lexicon.ts';
import type { LlmJsonRequest } from '../../../providers/llm/types.ts';
import { getDealer, getProhibitedClaims } from '../dealer-brain/queries.ts';
import { verifyClaims } from '../dealer-brain/verify.ts';
import { getVehicleCard, requireVehicle, updateVehicle, vehicleContext, type VehicleCard } from './index.ts';

export interface VehicleKnowledgeDraft {
  description: string;
  highlights: string[];
  target_customers: string[];
  competitors: VehicleCompetitor[];
  faqs: VehicleFaq[];
  content_angles: string[];
}

export interface RejectedText {
  field: keyof VehicleKnowledgeDraft;
  text: string;
  reason: string;
}

export interface VehicleKnowledgeResult {
  vehicle: Vehicle;
  /** what was kept and stored (empty fields = everything there was rejected) */
  applied: VehicleKnowledgeDraft;
  /** every dropped string with the guard that dropped it */
  rejected: RejectedText[];
  /** 'llm:<model>' when generated, null when the LLM was not available */
  engine: string | null;
  status: 'AVAILABLE' | 'UNAVAILABLE';
  reason: string;
}

const EMPTY_DRAFT = (): VehicleKnowledgeDraft => ({ description: '', highlights: [], target_customers: [], competitors: [], faqs: [], content_angles: [] });

// ─────────────────────────────────────────────────────────────────────────────
// Guard 2: every measurement must exist on the card
// ─────────────────────────────────────────────────────────────────────────────

const UNIT_CLASS: Record<string, string> = {
  万: 'money', 万元: 'money', 元: 'money', 块: 'money',
  公里: 'distance', km: 'distance', KM: 'distance', 千米: 'distance',
  毫米: 'length', mm: 'length',
  度: 'energy', kwh: 'energy', 'kWh': 'energy', 'KWH': 'energy',
  马力: 'power', 匹: 'power', ps: 'power', PS: 'power', 牛米: 'torque', 'N·m': 'torque', nm: 'torque',
  kW: 'power_kw', kw: 'power_kw', KW: 'power_kw', 千瓦: 'power_kw',
  秒: 'time', s: 'time',
  座: 'seats',
  期: 'term', 个月: 'term',
  '%': 'rate', 折: 'rate',
  成: 'down_payment',
  台: 'count', 辆: 'count',
  L: 'volume', 升: 'volume',
};
const MEASURE_RE = /(\d+(?:\.\d+)?)\s*(万元|万|元|块|公里|千米|km|KM|毫米|mm|kWh|KWH|kwh|kW|KW|kw|千瓦|度|马力|匹|PS|ps|牛米|N·m|nm|秒|座|个月|期|%|折|成|台|辆|升|L)/g;

/** Canonical (class, value) pairs this card can back. */
export function allowedMeasurements(card: VehicleCard): Set<string> {
  const out = new Set<string>();
  const add = (cls: string, value: number | null | undefined) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    out.add(`${cls}:${round(value)}`);
  };
  const veh = card.vehicle;
  add('money', veh.msrp);
  add('money', card.price.current);
  // price_cut is arithmetic on two prices, not a row anyone can verify — the store's 优惠 rows are the only discounts.
  const specs = veh.specs;
  add('distance', specs.range_km);
  add('distance', specs.combined_range_km);
  add('power_kw', specs.motor_kw);
  add('length', specs.length_mm);
  add('length', specs.wheelbase_mm);
  add('energy', specs.battery_kwh);
  add('power', specs.horsepower);
  add('torque', specs.torque_nm);
  add('time', specs.zero_to_100_s);
  add('seats', specs.seats);
  add('volume', specs.fuel_l_per_100km);
  for (const c of card.colors) add('count', c.quantity);
  add('count', card.in_stock);
  add('count', card.in_transit);
  for (const o of card.offers) {
    add('money', o.amount);
    if (o.apr !== null) add('rate', o.apr * 100);
    add('term', o.term_months);
    if (o.down_payment_pct !== null) add('down_payment', o.down_payment_pct * 10);
    if (o.down_payment_pct !== null) add('rate', o.down_payment_pct * 100);
  }
  return out;
}

const round = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));

/**
 * Measurements in `text` that the card cannot back. `万` is resolved to yuan, `成` to tenths, so "35.39万" and
 * "353900元" are the same fact and "首付3成" matches a 0.3 down payment.
 */
export function unsupportedMeasurements(text: string, allowed: ReadonlySet<string>, modelYear: number, names: readonly string[] = []): string[] {
  const bad: string[] = [];
  // A trim name carries digits and a letter that reads like a unit ('eDrive35L'); it is identity, not a measurement.
  let normalized = text.normalize('NFKC');
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    if (name.trim().length >= 2) normalized = normalized.split(name).join(' ');
  }
  for (const m of normalized.matchAll(MEASURE_RE)) {
    const raw = m[0];
    const value = Number(m[1]);
    const unit = m[2];
    // A digit glued to a letter belongs to a name, not to a measurement: '理想L9 L9主打…' is not '9 升',
    // and only OUR names are stripped above — a competitor's model number would otherwise be read as a unit.
    if (/[A-Za-z]/.test(normalized[(m.index ?? 0) - 1] ?? '')) continue;
    const cls = UNIT_CLASS[unit] ?? UNIT_CLASS[unit.toLowerCase()];
    if (!cls || !Number.isFinite(value)) continue;
    const candidates: string[] = [];
    if (cls === 'money') {
      candidates.push(`money:${round(unit === '万' || unit === '万元' ? value * 10_000 : value)}`);
    } else if (cls === 'down_payment') {
      candidates.push(`down_payment:${round(value)}`, `rate:${round(value * 10)}`);
    } else if (cls === 'rate' && unit === '折') {
      candidates.push(`rate:${round((10 - value) * 10)}`);
    } else {
      candidates.push(`${cls}:${round(value)}`);
    }
    if (candidates.some((c) => allowed.has(c))) continue;
    // 年款 is a fact of the row itself ('2026款'), not a measurement.
    if (value === modelYear) continue;
    bad.push(raw);
  }
  return [...new Set(bad)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM = [
  '你是汽车经销商的产品专家，为门店的一款在售车型写内部资料。资料会被用来生成小红书内容、私信和销售话术。',
  '只能使用「事实」里给出的数字。价格、优惠、利率、期数、首付、续航、马力、零百、座位数、电池、库存台数——一个数字都不能自己编，也不能四舍五入或换算。',
  '事实里没有的数字，就不要写数字，用文字描述（例如写"续航充足"，不要写"续航约700公里"）。',
  '不要承诺落地价、到手价，不要写"最低价""全网最低""保证""一定"这类绝对化表述。',
  '不要自己做减法：不要写"比指导价少多少""降了多少"，优惠只能照抄「事实」里写明的优惠政策。',
  '不要写"XX万级""十几万"这种价格档位，那是四舍五入出来的数字；要提价格就照抄事实里的原价。',
  '不要写现车、库存、颜色有没有货——库存每天都在变，系统回答客户时会实时读当天的库存，资料里写死反而会说错。',
  '不要提到具体的竞品价格或竞品参数（我们没有这些数据）。竞品只写定位和体验上的差别。',
  'description：200-400 字，讲清楚这台车是什么、开起来/用起来怎么样、适合什么场景。',
  'highlights：4-6 条核心卖点，每条不超过 20 字，尽量落在事实里的参数和配置上。',
  'target_customers：3-5 类真实人群画像，每条不超过 20 字（例如"每天通勤 40 公里的上班族"要写成"每天通勤距离不长的上班族"，因为 40 不是事实里的数字）。',
  'faqs：4-6 组客户真实会问的问题和回答，回答控制在 120 字内，涉及价格库存时只能复述事实。',
  'competitors：2-4 个同级竞品，note 写我们这台车相比它的差别，不超过 40 字，不要出现数字。',
  'content_angles：4-6 个小红书选题角度，每条不超过 25 字。',
  '全部用简体中文。只输出 JSON。',
].join('\n');

const SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['description', 'highlights', 'target_customers', 'faqs', 'competitors', 'content_angles'],
  properties: {
    description: { type: 'string' },
    highlights: { type: 'array', items: { type: 'string' } },
    target_customers: { type: 'array', items: { type: 'string' } },
    faqs: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['question', 'answer'], properties: { question: { type: 'string' }, answer: { type: 'string' } } },
    },
    competitors: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['name', 'note'], properties: { name: { type: 'string' }, note: { type: 'string' } } },
    },
    content_angles: { type: 'array', items: { type: 'string' } },
  },
};

export function buildKnowledgeRequest(ctx: AppContext, dealerId: string, card: VehicleCard): LlmJsonRequest {
  const dealer = getDealer(ctx, dealerId);
  const facts = vehicleContext([card], { max: 1 }).text;
  const rivals = competitorsOf(card.vehicle.brand, card.vehicle.model).map((c) => c.model_zh);
  const prohibited = getProhibitedClaims(ctx, dealerId).map((p) => p.phrase);
  const prompt = [
    `门店：${dealer.name}（${dealer.city}）`,
    `车型：${card.display_name}`,
    '',
    '【事实】以下是门店数据库里的真实数据，只有这里的数字可以写进资料：',
    facts,
    '',
    rivals.length > 0 ? `同级常见竞品（仅供参考，可选用）：${rivals.join('、')}` : '',
    prohibited.length > 0 ? `门店禁用表述（绝对不能出现）：${prohibited.join('、')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  // A full card is a lot of Chinese: description + 6 selling points + 5 audiences + 6 FAQ + competitors + angles.
  // 2500 tokens truncated the answer on a real run, which loses the whole batch, so this is sized for the worst case.
  return { purpose: 'vehicle_knowledge', system: SYSTEM, prompt, schema: SCHEMA, max_tokens: 6000 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation + generation
// ─────────────────────────────────────────────────────────────────────────────

const str = (x: unknown, max: number): string => (typeof x === 'string' ? x.trim().slice(0, max) : '');
const list = (x: unknown, max: number, itemMax: number): string[] =>
  Array.isArray(x) ? [...new Set(x.map((i) => str(i, itemMax)).filter(Boolean))].slice(0, max) : [];

/** Shape the raw model output into a draft; anything malformed is simply absent. */
export function parseKnowledgeDraft(raw: unknown): VehicleKnowledgeDraft {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    description: str(o.description, 2000),
    highlights: list(o.highlights, 8, 80),
    target_customers: list(o.target_customers, 8, 40),
    content_angles: list(o.content_angles, 10, 60),
    competitors: Array.isArray(o.competitors)
      ? o.competitors
          .map((c) => ({ name: str((c as Record<string, unknown>)?.name, 40), note: str((c as Record<string, unknown>)?.note, 160) }))
          .filter((c) => c.name)
          .slice(0, 6)
      : [],
    faqs: Array.isArray(o.faqs)
      ? o.faqs
          .map((f) => ({ question: str((f as Record<string, unknown>)?.question, 80), answer: str((f as Record<string, unknown>)?.answer, 400) }))
          .filter((f) => f.question && f.answer)
          .slice(0, 10)
      : [],
  };
}

/**
 * Drop everything the store's data cannot back. Both guards run on every string; the first failure is the reason.
 */
export function validateKnowledgeDraft(
  ctx: AppContext,
  dealerId: string,
  card: VehicleCard,
  draft: VehicleKnowledgeDraft,
): { applied: VehicleKnowledgeDraft; rejected: RejectedText[] } {
  const allowed = allowedMeasurements(card);
  const year = card.vehicle.model_year;
  const names = [card.display_name, card.vehicle.trim, card.vehicle.model, card.vehicle.model_zh, ...card.vehicle.aliases];
  const rejected: RejectedText[] = [];

  const check = (field: keyof VehicleKnowledgeDraft, text: string): boolean => {
    const numbers = unsupportedMeasurements(text, allowed, year, names);
    if (numbers.length > 0) {
      rejected.push({ field, text, reason: `出现了门店数据里没有的数字：${numbers.join('、')}` });
      return false;
    }
    const verdict = verifyClaims(ctx, dealerId, text, card.fact_refs);
    if (!verdict.passed) {
      rejected.push({ field, text, reason: verdict.issues[0] ?? '未通过事实核查' });
      return false;
    }
    return true;
  };

  const applied = EMPTY_DRAFT();
  if (draft.description && check('description', draft.description)) applied.description = draft.description;
  applied.highlights = draft.highlights.filter((x) => check('highlights', x));
  applied.target_customers = draft.target_customers.filter((x) => check('target_customers', x));
  applied.content_angles = draft.content_angles.filter((x) => check('content_angles', x));
  applied.competitors = draft.competitors.filter((c) => check('competitors', `${c.name} ${c.note}`));
  applied.faqs = draft.faqs.filter((f) => check('faqs', `${f.question} ${f.answer}`));
  return { applied, rejected };
}

export interface GenerateOptions {
  /** false = return the draft without storing it (the console previews before it saves) */
  apply?: boolean;
  /** keep the fields a human already wrote instead of replacing them */
  keep_existing?: boolean;
}

/**
 * Generate this card's prose with the LLM and store what survives both guards.
 *
 * Without an LLM configured nothing is generated and nothing is stored — the deterministic parts of the product keep
 * working, and the card simply keeps whatever a human wrote.
 */
export async function generateVehicleKnowledge(
  ctx: AppContext,
  dealerId: string,
  vehicleId: string,
  actor: string,
  opts: GenerateOptions = {},
): Promise<VehicleKnowledgeResult> {
  const card = getVehicleCard(ctx, dealerId, vehicleId);
  const status = ctx.llm.status();
  if (status.status !== 'AVAILABLE') {
    return { vehicle: card.vehicle, applied: EMPTY_DRAFT(), rejected: [], engine: null, status: 'UNAVAILABLE', reason: `没有可用的大模型：${status.reason}` };
  }
  const res = await ctx.llm.completeJson<unknown>(buildKnowledgeRequest(ctx, dealerId, card));
  if (!res.ok) {
    return { vehicle: card.vehicle, applied: EMPTY_DRAFT(), rejected: [], engine: null, status: 'UNAVAILABLE', reason: `生成失败：${res.reason}` };
  }
  const draft = parseKnowledgeDraft(res.data);
  const { applied, rejected } = validateKnowledgeDraft(ctx, dealerId, card, draft);
  const engine = `llm:${res.model}`;

  ctx.audit.decision({
    agent: 'account-strategy-agent',
    skill: 'vehicle-brain',
    decision_type: 'content_generation',
    subject_type: 'vehicle',
    subject_id: vehicleId,
    inputs: { vehicle: card.display_name, model: res.model, rejected: rejected.length },
    evidence: card.fact_refs.map((r) => ({ code: r.kind, label: r.claim, quote: r.id })),
    output: {
      applied: { description: Boolean(applied.description), highlights: applied.highlights.length, faqs: applied.faqs.length, competitors: applied.competitors.length },
      rejected,
    },
    confidence: rejected.length === 0 ? 0.9 : 0.6,
    engine: 'llm',
  });

  if (opts.apply === false) {
    return { vehicle: card.vehicle, applied, rejected, engine, status: 'AVAILABLE', reason: '' };
  }
  const veh = requireVehicle(ctx, vehicleId);
  const patch: Record<string, unknown> = {};
  const keep = opts.keep_existing === true;
  if (applied.description && (!keep || !veh.description?.trim())) patch.description = applied.description;
  if (applied.highlights.length > 0 && (!keep || veh.highlights.length === 0)) patch.highlights = applied.highlights;
  if (applied.target_customers.length > 0 && (!keep || (veh.target_customers ?? []).length === 0)) patch.target_customers = applied.target_customers;
  if (applied.competitors.length > 0 && (!keep || (veh.competitors ?? []).length === 0)) patch.competitors = applied.competitors;
  if (applied.faqs.length > 0 && (!keep || (veh.faqs ?? []).length === 0)) patch.faqs = applied.faqs;
  if (applied.content_angles.length > 0 && (!keep || (veh.content_angles ?? []).length === 0)) patch.content_angles = applied.content_angles;
  if (Object.keys(patch).length === 0) {
    return {
      vehicle: veh,
      applied,
      rejected,
      engine,
      status: 'AVAILABLE',
      reason: rejected.length > 0 ? '生成的内容都没有通过事实核查，车型资料保持原样' : '没有新的内容可写入',
    };
  }
  const updated = updateVehicle(ctx, vehicleId, patch, actor);
  const stamped = ctx.db.tx(() => ctx.db.table('vehicles').update(vehicleId, { knowledge_generated_at: ctx.clock.iso(), knowledge_engine: engine }));
  ctx.audit.event({
    actor,
    action: 'vehicle.knowledge_generated',
    entity_type: 'vehicle',
    entity_id: vehicleId,
    details: { engine, fields: Object.keys(patch), rejected: rejected.length },
  });
  void updated;
  return { vehicle: stamped, applied, rejected, engine, status: 'AVAILABLE', reason: '' };
}
