import type { AppContext } from '../../../app/context.ts';
import { normalizeText } from '../../../core/text.ts';
import type { Dealer, FactRef, Offer, OfferType, Vehicle, VehicleSpecs } from '../../../core/types.ts';
import {
  findInventory,
  findVehicles,
  getActiveOffers,
  getDealer,
  getKnowledge,
  getProhibitedClaims,
  offerAppliesToVehicle,
} from './queries.ts';
import {
  COLOR_CHARS,
  colorPairLabel,
  colorSynonym,
  dealerTz,
  exactCny,
  formatMonthDay,
  localDateOf,
  matchKey,
} from './shared.ts';

export const FACT_QUESTION_KINDS = [
  'price',
  'inventory',
  'offer',
  'finance',
  'lease',
  'trade_in',
  'store',
  'spec',
  'highlights',
] as const;
export type FactQuestionKind = (typeof FACT_QUESTION_KINDS)[number];

export interface FactQuestion {
  kind: FactQuestionKind;
  model?: string;
  trim?: string;
  exterior_color?: string;
  interior_color?: string;
}

export interface FactAnswer {
  found: boolean;
  text: string;
  facts: FactRef[];
  missing: string[];
}

/** Accumulates answer text and FactRefs; every claim is checked to be a verbatim substring. */
class AnswerBuilder {
  private text = '';
  private readonly facts: FactRef[] = [];
  private readonly seen = new Set<string>();

  append(segment: string): this {
    this.text += segment;
    return this;
  }

  /** Append a segment and register the claims it contains. */
  segment(segment: string, claims: { kind: FactRef['kind']; id: string; claim: string }[]): this {
    for (const c of claims) {
      if (!segment.includes(c.claim)) throw new Error(`dealer-brain: claim "${c.claim}" is not part of segment "${segment}"`);
    }
    this.text += segment;
    for (const c of claims) this.fact(c.kind, c.id, c.claim);
    return this;
  }

  fact(kind: FactRef['kind'], id: string, claim: string): void {
    const key = `${kind}:${id}:${claim}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.facts.push({ kind, id, claim });
  }

  build(found: boolean, missing: string[]): FactAnswer {
    for (const f of this.facts) {
      if (!this.text.includes(f.claim)) throw new Error(`dealer-brain: fact claim "${f.claim}" missing from answer text`);
    }
    return { found, text: this.text, facts: [...this.facts], missing: [...new Set(missing)] };
  }
}

const notFound = (text: string, missing: string[]): FactAnswer => ({ found: false, text, facts: [], missing });

const COLOR_WORD_RE = new RegExp(`[${COLOR_CHARS}]`, 'u');

/**
 * A user-supplied colour is echoed back only when it reads as a colour name (≤ 6 Han characters containing a
 * colour character, or a known English colour) and carries no prohibited phrase; anything else is omitted so
 * arbitrary question text never becomes customer-facing copy.
 */
function colourLabel(ctx: AppContext, dealer: Dealer, input: string | undefined): string {
  if (!input) return '';
  const english = colorSynonym(input);
  if (english) return english;
  const core = normalizeText(input).replace(/\s+/g, '');
  if (!/^\p{Script=Han}{1,6}$/u.test(core) || !COLOR_WORD_RE.test(core)) return '';
  if (getProhibitedClaims(ctx, dealer.id).some((p) => core.includes(normalizeText(p.phrase)))) return '';
  return core;
}

export function vehicleDisplayName(vehicle: Vehicle): string {
  return `${vehicle.brand_zh}${vehicle.model_zh} ${vehicle.trim}`;
}

function modelDisplayName(vehicle: Vehicle): string {
  return `${vehicle.brand_zh}${vehicle.model_zh}`;
}

function carriedVehicles(dealer: Dealer, vehicles: Vehicle[]): Vehicle[] {
  if (dealer.brands.length === 0) return vehicles;
  const brands = new Set(dealer.brands.map(matchKey));
  return vehicles.filter((veh) => brands.has(matchKey(veh.brand)) || brands.has(matchKey(veh.brand_zh)));
}

/**
 * Current catalog only: newest model year per model line, or — when a trim was asked — per model+trim, so a
 * superseded model year's price is never quoted as current.
 */
function newestYearOnly(vehicles: Vehicle[], perTrim: boolean): Vehicle[] {
  const keyOf = (veh: Vehicle) => (perTrim ? `${veh.brand}|${veh.model}|${veh.trim}` : `${veh.brand}|${veh.model}`);
  const newest = new Map<string, number>();
  for (const veh of vehicles) newest.set(keyOf(veh), Math.max(newest.get(keyOf(veh)) ?? 0, veh.model_year));
  return vehicles.filter((veh) => veh.model_year === newest.get(keyOf(veh)));
}

function questionVehicles(ctx: AppContext, dealer: Dealer, q: FactQuestion): Vehicle[] {
  const list = carriedVehicles(dealer, findVehicles(ctx, dealer.group_id, { model: q.model, trim: q.trim }));
  return newestYearOnly(list, Boolean(q.trim)).sort((a, b) => a.model.localeCompare(b.model) || a.msrp - b.msrp);
}

function formatPct(ratio: number): string {
  return `${Number((ratio * 100).toFixed(2))}%`;
}

function downPaymentLabel(pct: number): string {
  if (pct === 0) return '零首付';
  const tenths = pct * 10;
  if (Math.abs(tenths - Math.round(tenths)) < 1e-9) return `首付${Math.round(tenths)}成`;
  return `首付${formatPct(pct)}`;
}

function offerScopeLabel(ctx: AppContext, dealer: Dealer, offer: Offer): string {
  if (offer.vehicle_id) {
    const veh = ctx.db.table('vehicles').get(offer.vehicle_id);
    if (veh) return vehicleDisplayName(veh);
  }
  if (offer.model) {
    const veh = findVehicles(ctx, dealer.group_id, { model: offer.model })[0];
    return veh ? `${modelDisplayName(veh)}全系` : `${offer.model}全系`;
  }
  return '全车系';
}

/** One offer rendered as a sentence fragment with its verifiable claims. */
function describeOffer(ctx: AppContext, dealer: Dealer, offer: Offer): { segment: string; claims: string[] } {
  const parts: string[] = [];
  const claims: string[] = [];
  const push = (phrase: string) => {
    parts.push(phrase);
    claims.push(phrase);
  };
  const amount = offer.amount;
  switch (offer.type) {
    case 'cash_discount':
      if (amount !== null) push(`优惠${exactCny(amount)}`);
      break;
    case 'trade_in':
      if (amount !== null) push(`补贴${exactCny(amount)}`);
      break;
    case 'finance':
      if (offer.term_months !== null) push(`${offer.term_months}期`);
      if (offer.apr !== null) push(offer.apr === 0 ? '0息' : `年利率${formatPct(offer.apr)}`);
      if (offer.down_payment_pct !== null) push(downPaymentLabel(offer.down_payment_pct));
      if (amount !== null) push(`优惠${exactCny(amount)}`);
      break;
    case 'lease':
      if (amount !== null) push(`月供${exactCny(amount)}`);
      if (offer.term_months !== null) push(`${offer.term_months}期`);
      if (offer.down_payment_pct !== null) push(downPaymentLabel(offer.down_payment_pct));
      break;
    case 'gift':
    case 'campaign':
      if (offer.description.trim()) push(offer.description.trim().replace(/[。；;]+$/u, ''));
      if (amount !== null) push(`价值${exactCny(amount)}`);
      break;
  }
  const conditions = offer.conditions.trim().replace(/[。；;]+$/u, '');
  if (conditions) parts.push(conditions);
  const expiry = `截止日期${formatMonthDay(localDateOf(offer.valid_until, dealerTz(dealer)))}`;
  push(expiry);
  return { segment: `${offer.title}（${offerScopeLabel(ctx, dealer, offer)}）：${parts.join('，')}`, claims };
}

function appendOffers(b: AnswerBuilder, ctx: AppContext, dealer: Dealer, offers: Offer[]): void {
  offers.forEach((offer, i) => {
    const { segment, claims } = describeOffer(ctx, dealer, offer);
    if (i > 0) b.append('；');
    b.segment(segment, claims.map((claim) => ({ kind: 'offer' as const, id: offer.id, claim })));
  });
}

const POWERTRAIN_LABEL: Record<string, string> = { EV: '纯电动', PHEV: '插电混动', HEV: '油电混动', ICE: '燃油' };

function specPhrases(specs: VehicleSpecs): string[] {
  const out: string[] = [];
  const known = new Set([
    'powertrain',
    'body_type',
    'range_km',
    'horsepower',
    'torque_nm',
    'zero_to_100_s',
    'seats',
    'length_mm',
    'wheelbase_mm',
    'battery_kwh',
    'fuel_l_per_100km',
  ]);
  if (specs.powertrain) out.push(POWERTRAIN_LABEL[specs.powertrain] ?? specs.powertrain);
  if (specs.body_type) out.push(String(specs.body_type));
  if (specs.range_km !== undefined) out.push(`CLTC续航${specs.range_km}km`);
  if (specs.horsepower !== undefined) out.push(`最大功率${specs.horsepower}马力`);
  if (specs.torque_nm !== undefined) out.push(`峰值扭矩${specs.torque_nm}N·m`);
  if (specs.zero_to_100_s !== undefined) out.push(`百公里加速${specs.zero_to_100_s}秒`);
  if (specs.seats !== undefined) out.push(`${specs.seats}座`);
  if (specs.length_mm !== undefined) out.push(`车长${specs.length_mm}mm`);
  if (specs.wheelbase_mm !== undefined) out.push(`轴距${specs.wheelbase_mm}mm`);
  if (specs.battery_kwh !== undefined) out.push(`电池容量${specs.battery_kwh}kWh`);
  if (specs.fuel_l_per_100km !== undefined) out.push(`百公里油耗${specs.fuel_l_per_100km}L`);
  for (const [k, val] of Object.entries(specs)) {
    if (known.has(k) || val === undefined) continue;
    out.push(typeof val === 'boolean' ? `${k}：${val ? '是' : '否'}` : `${k}：${val}`);
  }
  return out;
}

const NEED_MODEL_TEXT = '请告诉我具体想了解的车型，我按门店资料为您核实。';
const UNKNOWN_VEHICLE_TEXT = '暂未在门店车型资料中查到该车型，需要进一步向门店确认。';
const LANDING_PRICE_TEXT = '落地价需结合上牌、保险及金融方案等因素综合核算，我们会根据您的具体方案单独报价。';

const OFFER_KIND_TYPES: Record<'finance' | 'lease' | 'trade_in', { types: OfferType[]; label: string }> = {
  finance: { types: ['finance'], label: '金融贷款方案' },
  lease: { types: ['lease'], label: '以租代购/租赁方案' },
  trade_in: { types: ['trade_in'], label: '置换补贴方案' },
};

/**
 * Answer a factual question ONLY from structured Dealer Brain rows. Every factual phrase in `text`
 * is returned as a FactRef whose `claim` is a verbatim substring of `text`. Landing price (落地价) is
 * never computed.
 */
export function answerFact(ctx: AppContext, dealerId: string, q: FactQuestion): FactAnswer {
  const dealer = getDealer(ctx, dealerId);
  switch (q.kind) {
    case 'price':
      return answerPrice(ctx, dealer, q);
    case 'inventory':
      return answerInventory(ctx, dealer, q);
    case 'offer':
      return answerOffers(ctx, dealer, q);
    case 'finance':
    case 'lease':
    case 'trade_in':
      return answerProgram(ctx, dealer, q, q.kind);
    case 'store':
      return answerStore(ctx, dealer);
    case 'spec':
      return answerSpec(ctx, dealer, q);
    case 'highlights':
      return answerHighlights(ctx, dealer, q);
  }
}

function answerPrice(ctx: AppContext, dealer: Dealer, q: FactQuestion): FactAnswer {
  if (!q.model && !q.trim) return notFound(`${NEED_MODEL_TEXT}${LANDING_PRICE_TEXT}`, ['model', 'landing_price']);
  const vehicles = questionVehicles(ctx, dealer, q);
  if (vehicles.length === 0) return notFound(`${UNKNOWN_VEHICLE_TEXT}${LANDING_PRICE_TEXT}`, ['vehicle', 'landing_price']);

  const b = new AnswerBuilder();
  vehicles.forEach((veh, i) => {
    const price = `指导价${exactCny(veh.msrp)}`;
    if (i > 0) b.append('；');
    b.segment(`${vehicleDisplayName(veh)}${price}`, [{ kind: 'vehicle', id: veh.id, claim: `${veh.trim}${price}` }]);
  });
  b.append('。');

  const offers = new Map<string, Offer>();
  for (const veh of vehicles) {
    for (const o of getActiveOffers(ctx, dealer.id, { vehicle_id: veh.id, types: ['cash_discount'] })) offers.set(o.id, o);
  }
  if (offers.size > 0) {
    b.append('当前门店优惠：');
    appendOffers(b, ctx, dealer, [...offers.values()]);
    b.append('。');
  } else {
    b.append('目前暂无进行中的现金优惠活动。');
  }
  b.append(LANDING_PRICE_TEXT);
  return b.build(true, ['landing_price']);
}

function answerInventory(ctx: AppContext, dealer: Dealer, q: FactQuestion): FactAnswer {
  let vehicles: Vehicle[] | null = null;
  if (q.model || q.trim) {
    vehicles = carriedVehicles(dealer, findVehicles(ctx, dealer.group_id, { model: q.model, trim: q.trim }));
    if (vehicles.length === 0) return notFound(UNKNOWN_VEHICLE_TEXT, ['vehicle']);
  }
  const allowed = vehicles ? new Set(vehicles.map((veh) => veh.id)) : null;
  const matches = findInventory(ctx, dealer.id, {
    model: q.model,
    trim: q.trim,
    exterior_color: q.exterior_color,
    interior_color: q.interior_color,
  }).filter((m) => !allowed || allowed.has(m.vehicle.id));

  if (matches.length === 0) {
    let desc = '符合条件';
    if (vehicles) {
      const models = new Set(vehicles.map((veh) => veh.model));
      desc = vehicles.length === 1 ? vehicleDisplayName(vehicles[0]) : models.size === 1 ? modelDisplayName(vehicles[0]) : '所询车型';
    }
    const ext = colourLabel(ctx, dealer, q.exterior_color);
    const int = colourLabel(ctx, dealer, q.interior_color);
    const colours = ext || int ? `（${[ext && `外观${ext}`, int && `内饰${int}`].filter(Boolean).join('、')}）` : '';
    return notFound(
      `目前${dealer.name}暂无${desc}${colours}的现车或在途车辆，可以先为您登记需求，有匹配车源时第一时间告知。`,
      ['inventory'],
    );
  }

  const groups = new Map<string, { label: string; status: string; qty: number; ids: string[]; name: string }>();
  for (const m of matches) {
    const key = `${m.vehicle.id}|${m.inventory.exterior_color}|${m.inventory.interior_color}|${m.inventory.status}`;
    const g = groups.get(key) ?? {
      label: colorPairLabel(m.inventory.exterior_color, m.inventory.interior_color),
      status: m.inventory.status === 'in_stock' ? '现车' : '在途',
      qty: 0,
      ids: [],
      name: vehicleDisplayName(m.vehicle),
    };
    g.qty += m.inventory.quantity;
    g.ids.push(m.inventory.id);
    groups.set(key, g);
  }
  const b = new AnswerBuilder();
  b.append(`${dealer.name}目前可售车源：`);
  [...groups.values()].forEach((g, i) => {
    const claim = `${g.label}${g.status}${g.qty}台`;
    if (i > 0) b.append('；');
    b.segment(
      `${g.name} ${claim}`,
      g.ids.map((id) => ({ kind: 'inventory' as const, id, claim })),
    );
  });
  b.append('。车源实时变动，请以门店当日确认为准。');
  return b.build(true, []);
}

function offerScopeForQuestion(ctx: AppContext, dealer: Dealer, q: FactQuestion): { vehicle_id?: string; model?: string; label: string } | null {
  if (!q.model && !q.trim) return { label: '' };
  const vehicles = questionVehicles(ctx, dealer, q);
  if (vehicles.length === 0) return null;
  if (q.trim && vehicles.length === 1) return { vehicle_id: vehicles[0].id, label: vehicleDisplayName(vehicles[0]) };
  return { model: vehicles[0].model, label: modelDisplayName(vehicles[0]) };
}

function answerOffers(ctx: AppContext, dealer: Dealer, q: FactQuestion): FactAnswer {
  const scope = offerScopeForQuestion(ctx, dealer, q);
  if (!scope) return notFound(UNKNOWN_VEHICLE_TEXT, ['vehicle']);
  const offers = getActiveOffers(ctx, dealer.id, { vehicle_id: scope.vehicle_id, model: scope.model });
  if (offers.length === 0)
    return notFound(`目前${dealer.name}暂无进行中的${scope.label}优惠活动，最新政策以门店书面报价为准。`, ['offer']);
  const b = new AnswerBuilder();
  b.append(`${dealer.name}当前进行中的${scope.label}优惠：`);
  appendOffers(b, ctx, dealer, offers);
  b.append('。具体以门店书面合同为准。');
  return b.build(true, []);
}

function answerProgram(ctx: AppContext, dealer: Dealer, q: FactQuestion, kind: 'finance' | 'lease' | 'trade_in'): FactAnswer {
  const cfg = OFFER_KIND_TYPES[kind];
  const scope = offerScopeForQuestion(ctx, dealer, q);
  if (!scope) return notFound(UNKNOWN_VEHICLE_TEXT, ['vehicle']);
  let offers = getActiveOffers(ctx, dealer.id, { vehicle_id: scope.vehicle_id, model: scope.model, types: cfg.types });
  if (scope.vehicle_id) {
    const veh = ctx.db.table('vehicles').require(scope.vehicle_id);
    offers = offers.filter((o) => offerAppliesToVehicle(o, veh));
  }
  const tail =
    kind === 'finance'
      ? '具体月供需根据车型价格和首付比例单独测算。最终以金融机构审批及书面合同为准。'
      : kind === 'lease'
        ? '最终以租赁公司审批及书面合同为准。'
        : '旧车价值以门店评估为准，最终以书面合同为准。';
  const missing = kind === 'finance' ? ['monthly_payment'] : [];
  if (offers.length === 0)
    return notFound(
      `目前${dealer.name}暂无进行中的${scope.label}${cfg.label}，可到店由金融专员结合您的情况单独评估。`,
      [kind, ...missing],
    );
  const b = new AnswerBuilder();
  b.append(`${dealer.name}当前${scope.label}${cfg.label}：`);
  appendOffers(b, ctx, dealer, offers);
  b.append('。');
  b.append(tail);
  return b.build(true, missing);
}

function answerStore(ctx: AppContext, dealer: Dealer): FactAnswer {
  const b = new AnswerBuilder();
  const parts: { segment: string; claim: string }[] = [];
  if (dealer.address.trim()) parts.push({ segment: `地址：${dealer.address}`, claim: dealer.address });
  if (dealer.business_hours.trim()) parts.push({ segment: `营业时间：${dealer.business_hours}`, claim: dealer.business_hours });
  if (dealer.phone && dealer.phone.trim()) parts.push({ segment: `门店电话：${dealer.phone}`, claim: dealer.phone });
  const knowledge = getKnowledge(ctx, dealer.id, ['store']).filter((k) => k.content.trim());

  if (parts.length === 0 && knowledge.length === 0) return notFound(`暂未查到${dealer.name}的门店地址与营业时间资料。`, ['store']);
  b.append(dealer.name);
  parts.forEach((p, i) => {
    b.append(i === 0 ? '' : '；');
    b.segment(p.segment, [{ kind: 'dealer', id: dealer.id, claim: p.claim }]);
  });
  if (parts.length > 0) b.append('。');
  for (const k of knowledge) {
    const content = k.content.trim();
    b.segment(`${k.title}：${content}`, [{ kind: 'knowledge', id: k.id, claim: content }]);
    if (!/[。！？]$/u.test(content)) b.append('。');
  }
  return b.build(true, []);
}

function answerSpec(ctx: AppContext, dealer: Dealer, q: FactQuestion): FactAnswer {
  if (!q.model && !q.trim) return notFound(NEED_MODEL_TEXT, ['model']);
  const vehicles = questionVehicles(ctx, dealer, q);
  if (vehicles.length === 0) return notFound(UNKNOWN_VEHICLE_TEXT, ['vehicle']);
  const b = new AnswerBuilder();
  let any = false;
  for (const veh of vehicles) {
    const phrases = specPhrases(veh.specs);
    if (phrases.length === 0) continue;
    any = true;
    b.segment(
      `${vehicleDisplayName(veh)}：${phrases.join('，')}。`,
      phrases.map((claim) => ({ kind: 'vehicle' as const, id: veh.id, claim })),
    );
  }
  if (!any) return notFound('暂未录入该车型的配置参数，需要向门店产品专员确认。', ['spec']);
  return b.build(true, []);
}

function answerHighlights(ctx: AppContext, dealer: Dealer, q: FactQuestion): FactAnswer {
  if (!q.model && !q.trim) return notFound(NEED_MODEL_TEXT, ['model']);
  const vehicles = questionVehicles(ctx, dealer, q);
  if (vehicles.length === 0) return notFound(UNKNOWN_VEHICLE_TEXT, ['vehicle']);
  const b = new AnswerBuilder();
  let any = false;
  for (const veh of vehicles) {
    const highlights = veh.highlights.map((h) => h.trim()).filter(Boolean);
    if (highlights.length === 0) continue;
    any = true;
    b.segment(
      `${vehicleDisplayName(veh)}亮点：${highlights.join('；')}。`,
      highlights.map((claim) => ({ kind: 'vehicle' as const, id: veh.id, claim })),
    );
  }
  if (!any) return notFound('暂未录入该车型的产品亮点资料。', ['highlights']);
  return b.build(true, []);
}
