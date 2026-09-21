/**
 * 车型库 / Vehicle Brain — the store's live line-up, and the retrieval layer every agent asks before it writes.
 *
 * A catalog row used to be a price-list line (brand / model / trim / MSRP). A store does not sell from a price list:
 * it sells from a card — photos, the price it is actually asking today, what the car is, who it is for, what it is
 * cross-shopped against, the questions customers keep asking, and the angles a note can be written from. That card is
 * what this module assembles, keeps and retrieves.
 *
 * The split that makes it safe:
 * - **Facts** (price, discount, specs, colours, stock, finance terms) come only from `vehicles`, `inventory` and
 *   `offers`. Nothing here invents one, and `fact_refs` carries the row that backs every number on the card.
 * - **Prose** (description, selling points, target customers, competitor notes, FAQ, content angles) may be written by
 *   the LLM (`knowledge.ts`), but every sentence is verified against those same rows before it is stored.
 *
 * Retrieval (`retrieveVehicles`) is deterministic and lexical: the catalog's own model names, aliases and trims decide
 * a match first, and the card's text (highlights, description, who it is for, FAQ questions, angles) breaks ties by
 * character-bigram overlap. There are no embeddings and no vector store — with a few dozen trims per store, the
 * catalog's own vocabulary is the index, and a deterministic match is auditable, which a nearest-neighbour hit is not.
 */
import type { AppContext } from '../../../app/context.ts';
import { NotFoundError, PolicyError, ValidationError } from '../../../core/errors.ts';
import { newId } from '../../../core/ids.ts';
import { charNgrams, normalizeText } from '../../../core/text.ts';
import type { FactRef, Inventory, InventoryStatus, Offer, Vehicle, VehicleCompetitor, VehicleFaq, VehicleSpecs } from '../../../core/types.ts';
import { v } from '../../../core/validate.ts';
import { getBrandInfo } from '../../../domain/automotive-lexicon.ts';
import { defineSkill } from '../../registry.ts';
import { exactCny, matchKey } from '../dealer-brain/shared.ts';
import { vehicleDisplayName } from '../dealer-brain/facts.ts';
import { findInventory, findVehicles, getActiveOffers, getDealer, offerAppliesToVehicle, type InventoryMatch } from '../dealer-brain/queries.ts';

export const VEHICLE_BRAIN_AGENT = 'account-strategy-agent';
export const MAX_IMAGES_PER_VEHICLE = 12;
export const MAX_HIGHLIGHTS = 12;
export const MAX_TARGET_CUSTOMERS = 8;
export const MAX_COMPETITORS = 8;
export const MAX_FAQS = 12;
export const MAX_CONTENT_ANGLES = 12;
export const MAX_DESCRIPTION_CHARS = 2000;
/**
 * Share of the query's *discriminating* terms a card must contain to count as a text match (see `retrieveVehicles`).
 * Terms no card has, and terms every card has, are ignored — they say nothing about which car is meant.
 */
export const MIN_RETRIEVAL_SCORE = 0.5;
/** …and at least this many of them, so one accidental syllable is never a match. */
export const MIN_TEXT_TERM_HITS = 2;

const POWERTRAIN_LABEL: Record<string, string> = { EV: '纯电', PHEV: '插电混动', HEV: '油电混动', ICE: '燃油' };

/**
 * What to call this car's powertrain. A range extender (增程) is stored as PHEV, but calling it 插电混动 in front of a
 * customer is wrong in the way that matters to them — so when the store's own 车身形式 says 增程, that word wins.
 */
export function powertrainLabel(vehicle: Vehicle): string | null {
  const body = typeof vehicle.specs.body_type === 'string' ? vehicle.specs.body_type : '';
  if (vehicle.specs.powertrain === 'PHEV' && /增程/.test(body)) return '增程';
  return vehicle.specs.powertrain ? (POWERTRAIN_LABEL[vehicle.specs.powertrain] ?? vehicle.specs.powertrain) : null;
}
const SELLABLE: InventoryStatus[] = ['in_stock', 'in_transit'];

// ─────────────────────────────────────────────────────────────────────────────
// The card
// ─────────────────────────────────────────────────────────────────────────────

export interface VehiclePrice {
  /** 厂商指导价 */
  msrp: number;
  /** 当前售价 when the store set one, else null (= 按指导价) */
  current: number | null;
  /** msrp − current when both exist and differ, else null. Offers are listed separately. */
  price_cut: number | null;
}

export interface VehicleColorStock {
  exterior_color: string;
  interior_color: string;
  status: InventoryStatus;
  quantity: number;
  inventory_id: string;
}

/** Everything the store knows about one trim, with the rows that back it. */
export interface VehicleCard {
  vehicle: Vehicle;
  display_name: string;
  price: VehiclePrice;
  powertrain_label: string | null;
  colors: VehicleColorStock[];
  /** total quantity with status in_stock */
  in_stock: number;
  /** total quantity with status in_transit */
  in_transit: number;
  /** active offers that apply to this trim (cash, finance, lease, trade-in, gift, campaign) */
  offers: Offer[];
  /** the finance / lease subset, which the card shows as 金融/租赁方案 */
  finance_offers: Offer[];
  /** every row that can back a claim about this card */
  fact_refs: FactRef[];
  archived: boolean;
}

function colorRows(matches: InventoryMatch[]): VehicleColorStock[] {
  return matches.map((m) => ({
    exterior_color: m.inventory.exterior_color,
    interior_color: m.inventory.interior_color,
    status: m.inventory.status,
    quantity: m.inventory.quantity,
    inventory_id: m.inventory.id,
  }));
}

function priceOf(vehicle: Vehicle): VehiclePrice {
  const current = typeof vehicle.current_price === 'number' && vehicle.current_price > 0 ? vehicle.current_price : null;
  return { msrp: vehicle.msrp, current, price_cut: current !== null && current < vehicle.msrp ? vehicle.msrp - current : null };
}

/** Assemble one card: the catalog row plus this dealer's live stock and active offers for it. */
export function buildVehicleCard(ctx: AppContext, dealerId: string, vehicle: Vehicle, stock: InventoryMatch[], offers: Offer[]): VehicleCard {
  const mine = stock.filter((m) => m.vehicle.id === vehicle.id && m.inventory.quantity > 0);
  const applies = offers.filter((o) => offerAppliesToVehicle(o, vehicle));
  const price = priceOf(vehicle);
  const refs: FactRef[] = [{ kind: 'vehicle', id: vehicle.id, claim: `${vehicle.trim}指导价${exactCny(vehicle.msrp)}` }];
  if (price.current !== null) refs.push({ kind: 'vehicle', id: vehicle.id, claim: `${vehicle.trim}现售价${exactCny(price.current)}` });
  for (const m of mine) refs.push({ kind: 'inventory', id: m.inventory.id, claim: `${m.inventory.exterior_color}${m.inventory.interior_color ? `/${m.inventory.interior_color}` : ''}现车` });
  for (const o of applies) refs.push({ kind: 'offer', id: o.id, claim: o.title });
  return {
    vehicle,
    display_name: vehicleDisplayName(vehicle),
    price,
    powertrain_label: powertrainLabel(vehicle),
    colors: colorRows(mine),
    in_stock: mine.filter((m) => m.inventory.status === 'in_stock').reduce((n, m) => n + m.inventory.quantity, 0),
    in_transit: mine.filter((m) => m.inventory.status === 'in_transit').reduce((n, m) => n + m.inventory.quantity, 0),
    offers: applies,
    finance_offers: applies.filter((o) => o.type === 'finance' || o.type === 'lease'),
    fact_refs: refs,
    archived: Boolean(vehicle.archived_at),
    // dealerId is implicit in stock/offers, which were queried for it
  };
}

export interface VehicleListOptions {
  include_archived?: boolean;
  brand?: string;
  /** free text filter over the card (model, trim, aliases, highlights, description) */
  query?: string;
}

/** Every trim of the store's line-up, newest model year first within a model. */
export function listVehicleCards(ctx: AppContext, dealerId: string, opts: VehicleListOptions = {}): VehicleCard[] {
  const dealer = getDealer(ctx, dealerId);
  const all = ctx.db
    .table('vehicles')
    .findMany({ group_id: dealer.group_id }, { orderBy: 'brand ASC, model ASC, model_year DESC, msrp ASC, trim ASC' })
    .filter((veh) => (opts.include_archived ? true : !veh.archived_at));
  const filtered = all.filter((veh) => {
    if (opts.brand && matchKey(opts.brand) !== matchKey(veh.brand) && matchKey(opts.brand) !== matchKey(veh.brand_zh)) return false;
    if (opts.query?.trim() && !cardBlob(veh).includes(normalizeText(opts.query))) return false;
    return true;
  });
  if (filtered.length === 0) return [];
  const stock = findInventory(ctx, dealerId, { statuses: SELLABLE });
  const offers = getActiveOffers(ctx, dealerId);
  return filtered.map((veh) => buildVehicleCard(ctx, dealerId, veh, stock, offers));
}

export function requireVehicle(ctx: AppContext, vehicleId: string): Vehicle {
  const row = ctx.db.table('vehicles').get(vehicleId);
  if (!row) throw new NotFoundError('vehicle', vehicleId);
  return row;
}

export function getVehicleCard(ctx: AppContext, dealerId: string, vehicleId: string): VehicleCard {
  const dealer = getDealer(ctx, dealerId);
  const vehicle = requireVehicle(ctx, vehicleId);
  if (vehicle.group_id !== dealer.group_id) throw new NotFoundError('vehicle', vehicleId);
  const stock = findInventory(ctx, dealerId, { vehicle_id: vehicle.id, statuses: SELLABLE });
  const offers = getActiveOffers(ctx, dealerId);
  return buildVehicleCard(ctx, dealerId, vehicle, stock, offers);
}

// ─────────────────────────────────────────────────────────────────────────────
// Retrieval (what the agents call)
// ─────────────────────────────────────────────────────────────────────────────

/** All the text a card can be found by. Facts are searchable too, but only the catalog's own words. */
function cardBlob(vehicle: Vehicle): string {
  return normalizeText(
    [
      vehicle.brand,
      vehicle.brand_zh,
      vehicle.model,
      vehicle.model_zh,
      vehicle.trim,
      `${vehicle.model_year}款`,
      ...vehicle.aliases,
      ...vehicle.highlights,
      ...(vehicle.target_customers ?? []),
      ...(vehicle.content_angles ?? []),
      ...(vehicle.competitors ?? []).map((c) => `${c.name} ${c.note}`),
      ...(vehicle.faqs ?? []).map((f) => `${f.question} ${f.answer}`),
      vehicle.description ?? '',
      vehicle.specs.powertrain ? (POWERTRAIN_LABEL[vehicle.specs.powertrain] ?? '') : '',
      // 车身形式 is how customers ask for a kind of car ('增程SUV', 'MPV') before they know a model name.
      typeof vehicle.specs.body_type === 'string' ? vehicle.specs.body_type : '',
    ].join(' '),
  );
}

export interface VehicleRetrievalQuery {
  /** what the customer / the plan actually said, e.g. '想看看i3，预算35万左右' */
  text?: string;
  brand?: string;
  model?: string;
  trim?: string;
  limit?: number;
  include_archived?: boolean;
}

export interface VehicleMatch {
  card: VehicleCard;
  /** 0..1 — 1 = the catalog's own name / alias was used */
  score: number;
  /** why it matched, for the audit trail ('model:i3', 'alias:35L', 'text') */
  matched_on: string[];
}

/**
 * The retrieval every agent uses: turn "what the customer said" into the store's own cards.
 *
 * A structured hit (brand / model / trim from intent detection) always wins — those come from the catalog's own
 * vocabulary. Free text is then scored by character-bigram overlap with the card's text, which finds a card by its
 * selling points ("充电快"), by who it is for ("二胎家庭") or by an FAQ question, not only by its name.
 */
export function retrieveVehicles(ctx: AppContext, dealerId: string, q: VehicleRetrievalQuery): VehicleMatch[] {
  const dealer = getDealer(ctx, dealerId);
  const limit = Math.min(Math.max(1, Math.floor(q.limit ?? 5)), 50);
  const live = (veh: Vehicle) => (q.include_archived ? true : !veh.archived_at);

  const scored = new Map<string, { vehicle: Vehicle; score: number; matched_on: string[] }>();
  const add = (veh: Vehicle, score: number, reason: string) => {
    const prev = scored.get(veh.id);
    if (prev) {
      prev.score = Math.max(prev.score, score);
      if (!prev.matched_on.includes(reason)) prev.matched_on.push(reason);
      return;
    }
    scored.set(veh.id, { vehicle: veh, score, matched_on: [reason] });
  };

  if (q.model || q.trim) {
    for (const veh of findVehicles(ctx, dealer.group_id, { brand: q.brand, model: q.model, trim: q.trim }).filter(live)) {
      add(veh, 1, q.trim ? `trim:${q.trim}` : `model:${q.model}`);
    }
  }
  const text = (q.text ?? '').trim();
  if (text) {
    const candidates = ctx.db
      .table('vehicles')
      .findMany({ group_id: dealer.group_id })
      .filter(live)
      .filter((veh) => !q.brand || matchKey(q.brand) === matchKey(veh.brand) || matchKey(q.brand) === matchKey(veh.brand_zh))
      .map((veh) => ({ veh, terms: charNgrams(cardBlob(veh)) }));
    for (const { veh } of candidates) {
      // A name the customer typed verbatim is a hit, whatever the score says.
      const named = [veh.model, veh.model_zh, veh.trim, ...veh.aliases].filter((n) => n.length >= 2 && blobHasName(text, n));
      if (named.length > 0) add(veh, 1, `name:${named[0]}`);
    }
    // Which of the query's terms actually tell the cards apart: not the ones nobody wrote, not the ones everybody
    // wrote. '通勤' and '充电' decide a match; '宝马' and '的电' decide nothing.
    const asked = [...charNgrams(normalizeText(text))];
    const discriminating = asked.filter((term) => {
      const df = candidates.reduce((n, c) => n + (c.terms.has(term) ? 1 : 0), 0);
      return df > 0 && df < candidates.length;
    });
    if (discriminating.length > 0) {
      for (const { veh, terms } of candidates) {
        const hits = discriminating.filter((term) => terms.has(term)).length;
        const score = hits / discriminating.length;
        if (hits >= MIN_TEXT_TERM_HITS && score >= MIN_RETRIEVAL_SCORE) add(veh, Math.min(0.95, score), 'text');
      }
    }
  }
  if (scored.size === 0) return [];

  const stock = findInventory(ctx, dealerId, { statuses: SELLABLE });
  const offers = getActiveOffers(ctx, dealerId);
  return [...scored.values()]
    .sort((a, b) => b.score - a.score || b.vehicle.model_year - a.vehicle.model_year || a.vehicle.msrp - b.vehicle.msrp)
    .slice(0, limit)
    .map((r) => ({ card: buildVehicleCard(ctx, dealerId, r.vehicle, stock, offers), score: Number(r.score.toFixed(3)), matched_on: r.matched_on }));
}

const blobHasName = (text: string, name: string): boolean => normalizeText(text).includes(normalizeText(name));

/** Share of one bigram set the other contains (0..1) — used to pair a question with a stored FAQ. */
function coverage(needle: ReadonlySet<string>, hay: ReadonlySet<string>): number {
  if (needle.size === 0) return 0;
  let hits = 0;
  for (const g of needle) if (hay.has(g)) hits++;
  return hits / needle.size;
}

/** The single best card for what a customer said, or null when the line-up has nothing close. */
export function matchVehicle(ctx: AppContext, dealerId: string, q: VehicleRetrievalQuery): VehicleCard | null {
  return retrieveVehicles(ctx, dealerId, { ...q, limit: 1 })[0]?.card ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Grounded context for the LLM
// ─────────────────────────────────────────────────────────────────────────────

export interface VehicleContext {
  /** the block handed to the model: facts first, prose second, both labelled */
  text: string;
  fact_refs: FactRef[];
  cards: VehicleCard[];
}

function factLines(card: VehicleCard): string[] {
  const veh = card.vehicle;
  const lines = [`${card.display_name}（${veh.model_year}款）指导价 ${exactCny(veh.msrp)}`];
  // The difference between two prices is arithmetic, not a fact the store can show a row for — it is not offered here.
  if (card.price.current !== null) lines.push(`当前售价 ${exactCny(card.price.current)}`);
  const specs: string[] = [];
  if (card.powertrain_label) specs.push(card.powertrain_label);
  if (typeof veh.specs.range_km === 'number') specs.push(`纯电续航 ${veh.specs.range_km} 公里`);
  if (typeof veh.specs.combined_range_km === 'number') specs.push(`综合续航 ${veh.specs.combined_range_km} 公里`);
  if (typeof veh.specs.horsepower === 'number') specs.push(`${veh.specs.horsepower} 马力`);
  if (typeof veh.specs.motor_kw === 'number') specs.push(`电机 ${veh.specs.motor_kw} kW`);
  if (typeof veh.specs.zero_to_100_s === 'number') specs.push(`零百 ${veh.specs.zero_to_100_s} 秒`);
  if (typeof veh.specs.seats === 'number') specs.push(`${veh.specs.seats} 座`);
  if (typeof veh.specs.battery_kwh === 'number') specs.push(`电池 ${veh.specs.battery_kwh} 度`);
  if (specs.length > 0) lines.push(`参数：${specs.join('、')}`);
  if (card.colors.length > 0) {
    lines.push(
      `车源：${card.colors
        .map((c) => `${c.exterior_color}${c.interior_color ? `/${c.interior_color}` : ''} ${c.status === 'in_stock' ? '现车' : '在途'} ${c.quantity} 台`)
        .join('；')}`,
    );
  } else {
    lines.push('车源：当前没有可售库存，不能说现车');
  }
  for (const o of card.offers) {
    const parts = [o.title];
    if (o.amount !== null) parts.push(exactCny(o.amount));
    if (o.apr !== null) parts.push(`年化 ${(o.apr * 100).toFixed(2)}%`);
    if (o.term_months !== null) parts.push(`${o.term_months} 期`);
    if (o.down_payment_pct !== null) parts.push(`首付 ${Math.round(o.down_payment_pct * 100)}%`);
    if (o.conditions.trim()) parts.push(`条件：${o.conditions.trim()}`);
    lines.push(`政策：${parts.join('，')}（截止 ${o.valid_until}）`);
  }
  return lines;
}

function proseLines(card: VehicleCard): string[] {
  const veh = card.vehicle;
  const lines: string[] = [];
  if (veh.description?.trim()) lines.push(`介绍：${veh.description.trim()}`);
  if (veh.highlights.length > 0) lines.push(`卖点：${veh.highlights.join('；')}`);
  if ((veh.target_customers ?? []).length > 0) lines.push(`适合人群：${(veh.target_customers ?? []).join('；')}`);
  if ((veh.competitors ?? []).length > 0) lines.push(`竞品：${(veh.competitors ?? []).map((c) => `${c.name}（${c.note}）`).join('；')}`);
  for (const f of veh.faqs ?? []) lines.push(`常见问题：${f.question} → ${f.answer}`);
  return lines;
}

/**
 * The grounded block a prompt carries. Facts and prose are labelled separately and the rule is stated in the block
 * itself: numbers may only come from the 事实 lines. Everything here is already stored data — nothing is invented to
 * fill a gap, and a card with no stock says so rather than staying silent.
 */
export function vehicleContext(cards: readonly VehicleCard[], opts: { max?: number } = {}): VehicleContext {
  const list = cards.slice(0, Math.max(1, opts.max ?? 3));
  const blocks = list.map((card) => [`【${card.display_name}】`, ...factLines(card).map((l) => `事实：${l}`), ...proseLines(card).map((l) => `素材：${l}`)].join('\n'));
  return {
    text: blocks.join('\n\n'),
    fact_refs: list.flatMap((c) => c.fact_refs),
    cards: [...list],
  };
}

/** Best stored FAQ for a question, or null. Used to answer with text a human already approved. */
export function vehicleFaqAnswer(card: VehicleCard, question: string): { faq: VehicleFaq; score: number } | null {
  const q = charNgrams(normalizeText(question));
  let best: { faq: VehicleFaq; score: number } | null = null;
  for (const faq of card.vehicle.faqs ?? []) {
    // Both directions matter here: the customer's wording and the stored question must be about the same thing.
    const stored = charNgrams(normalizeText(faq.question));
    const score = Math.min(coverage(q, stored), coverage(stored, q));
    if (score >= 0.34 && (!best || score > best.score)) best = { faq, score: Number(score.toFixed(3)) };
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Editing
// ─────────────────────────────────────────────────────────────────────────────

const imageValidator = (value: unknown, path = 'image'): string => {
  const s = v.string({ min: 1, max: 1000 })(value, path);
  if (!/^https?:\/\/\S+$/i.test(s) && !/^\/\S/.test(s) && !/^[A-Za-z]:\\/.test(s)) {
    throw new ValidationError(path, '图片必须是 http(s) 链接或绝对文件路径');
  }
  return s;
};

const specsValidator = v.object({
  powertrain: v.optional(v.literal(['EV', 'PHEV', 'HEV', 'ICE'] as const)),
  body_type: v.optional(v.string({ max: 40 })),
  range_km: v.optional(v.nullable(v.number({ int: true, min: 0, max: 5000 }))),
  combined_range_km: v.optional(v.nullable(v.number({ int: true, min: 0, max: 5000 }))),
  motor_kw: v.optional(v.nullable(v.number({ min: 0, max: 2000 }))),
  horsepower: v.optional(v.nullable(v.number({ int: true, min: 0, max: 5000 }))),
  torque_nm: v.optional(v.nullable(v.number({ int: true, min: 0, max: 20_000 }))),
  zero_to_100_s: v.optional(v.nullable(v.number({ min: 0, max: 60 }))),
  seats: v.optional(v.nullable(v.number({ int: true, min: 1, max: 12 }))),
  length_mm: v.optional(v.nullable(v.number({ int: true, min: 0, max: 10_000 }))),
  wheelbase_mm: v.optional(v.nullable(v.number({ int: true, min: 0, max: 10_000 }))),
  battery_kwh: v.optional(v.nullable(v.number({ min: 0, max: 500 }))),
  fuel_l_per_100km: v.optional(v.nullable(v.number({ min: 0, max: 100 }))),
});

export const vehiclePatchValidator = v.object({
  trim: v.optional(v.string({ min: 1, max: 60 })),
  model_year: v.optional(v.number({ int: true, min: 1990, max: 2100 })),
  msrp: v.optional(v.number({ int: true, min: 1, max: 100_000_000 })),
  current_price: v.optional(v.nullable(v.number({ int: true, min: 1, max: 100_000_000 }))),
  images: v.optional(v.array(imageValidator, { max: MAX_IMAGES_PER_VEHICLE })),
  description: v.optional(v.string({ max: MAX_DESCRIPTION_CHARS })),
  highlights: v.optional(v.array(v.string({ min: 1, max: 80 }), { max: MAX_HIGHLIGHTS })),
  target_customers: v.optional(v.array(v.string({ min: 1, max: 40 }), { max: MAX_TARGET_CUSTOMERS })),
  competitors: v.optional(
    v.array(v.object({ name: v.string({ min: 1, max: 40 }), note: v.string({ max: 160 }) }), { max: MAX_COMPETITORS }),
  ),
  faqs: v.optional(v.array(v.object({ question: v.string({ min: 1, max: 80 }), answer: v.string({ min: 1, max: 400 }) }), { max: MAX_FAQS })),
  content_angles: v.optional(v.array(v.string({ min: 1, max: 60 }), { max: MAX_CONTENT_ANGLES })),
  aliases: v.optional(v.array(v.string({ min: 1, max: 40 }), { max: 12 })),
  specs: v.optional(specsValidator),
  /** where these facts come from, e.g. '厂商价格表 2026-09' — shown on the card as 数据来源 */
  source: v.optional(v.string({ min: 1, max: 200 })),
});

export type VehiclePatch = ReturnType<typeof vehiclePatchValidator>;

/** Drop null spec values (the console clears a spec by sending null) and keep the rest. */
function mergeSpecs(current: VehicleSpecs, patch: Record<string, unknown>): VehicleSpecs {
  const out: VehicleSpecs = { ...current };
  for (const [k, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === '') delete out[k];
    else out[k] = value as string | number | boolean;
  }
  return out;
}

/**
 * Edit one card. Facts and prose are edited the same way here — a human typing a price is as authoritative as the
 * import that created the row — but changing a fact invalidates nothing silently: `source` records who last touched it.
 */
export function updateVehicle(ctx: AppContext, vehicleId: string, raw: unknown, actor: string): Vehicle {
  if (!actor?.trim()) throw new ValidationError('actor', 'required');
  const vehicle = requireVehicle(ctx, vehicleId);
  const patch = vehiclePatchValidator(raw, 'body');
  const next: Partial<Vehicle> = {};
  if (patch.trim !== undefined) next.trim = patch.trim.trim();
  if (patch.model_year !== undefined) next.model_year = patch.model_year;
  if (patch.msrp !== undefined) next.msrp = patch.msrp;
  if (patch.current_price !== undefined) next.current_price = patch.current_price;
  if (patch.images !== undefined) next.images = [...new Set(patch.images.map((i) => i.trim()))];
  if (patch.description !== undefined) next.description = patch.description.trim();
  if (patch.highlights !== undefined) next.highlights = dedupe(patch.highlights);
  if (patch.target_customers !== undefined) next.target_customers = dedupe(patch.target_customers);
  if (patch.competitors !== undefined) next.competitors = patch.competitors.map((c) => ({ name: c.name.trim(), note: c.note.trim() }));
  if (patch.faqs !== undefined) next.faqs = patch.faqs.map((f) => ({ question: f.question.trim(), answer: f.answer.trim() }));
  if (patch.content_angles !== undefined) next.content_angles = dedupe(patch.content_angles);
  if (patch.aliases !== undefined) next.aliases = dedupe(patch.aliases);
  if (patch.specs !== undefined) next.specs = mergeSpecs(vehicle.specs, patch.specs as Record<string, unknown>);
  if (patch.source !== undefined) next.source = patch.source.trim();
  const price = next.msrp ?? vehicle.msrp;
  const current = next.current_price !== undefined ? next.current_price : (vehicle.current_price ?? null);
  if (current !== null && current > price) throw new ValidationError('current_price', '当前售价不能高于厂商指导价');
  if (Object.keys(next).length === 0) return vehicle;

  return ctx.db.tx(() => {
    // A stated source wins: whoever typed the numbers says where they are from, otherwise it is this console edit.
    const row = ctx.db.table('vehicles').update(vehicleId, { source: `console:${actor}`, ...next, updated_at: ctx.clock.iso() });
    ctx.audit.event({
      actor,
      action: 'vehicle.updated',
      entity_type: 'vehicle',
      entity_id: vehicleId,
      details: { fields: Object.keys(next), msrp: row.msrp, current_price: row.current_price ?? null },
    });
    return row;
  });
}

const dedupe = (list: readonly string[]): string[] => [...new Set(list.map((x) => x.trim()).filter(Boolean))];

/** Take a trim out of the line-up without losing its history (stock, offers, published notes keep pointing at it). */
export function archiveVehicle(ctx: AppContext, vehicleId: string, actor: string): Vehicle {
  const vehicle = requireVehicle(ctx, vehicleId);
  if (vehicle.archived_at) return vehicle;
  return ctx.db.tx(() => {
    const row = ctx.db.table('vehicles').update(vehicleId, { archived_at: ctx.clock.iso(), updated_at: ctx.clock.iso() });
    ctx.audit.event({ actor, action: 'vehicle.archived', entity_type: 'vehicle', entity_id: vehicleId, details: { display: vehicleDisplayName(row) } });
    return row;
  });
}

export function restoreVehicle(ctx: AppContext, vehicleId: string, actor: string): Vehicle {
  const vehicle = requireVehicle(ctx, vehicleId);
  if (!vehicle.archived_at) return vehicle;
  return ctx.db.tx(() => {
    const row = ctx.db.table('vehicles').update(vehicleId, { archived_at: null, updated_at: ctx.clock.iso() });
    ctx.audit.event({ actor, action: 'vehicle.restored', entity_type: 'vehicle', entity_id: vehicleId, details: { display: vehicleDisplayName(row) } });
    return row;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch import
// ─────────────────────────────────────────────────────────────────────────────

export interface VehicleImportRow {
  brand?: string;
  model?: string;
  trim?: string;
  model_year?: number | string;
  msrp?: number | string;
  current_price?: number | string | null;
  powertrain?: string;
  highlights?: string | string[];
  aliases?: string | string[];
  images?: string | string[];
  description?: string;
  [k: string]: unknown;
}

export interface VehicleImportResult {
  created: number;
  updated: number;
  failed: { row: number; reason: string }[];
  vehicles: Vehicle[];
}

const IMPORT_HEADERS: Record<string, keyof VehicleImportRow> = {
  品牌: 'brand',
  brand: 'brand',
  车型: 'model',
  model: 'model',
  配置: 'trim',
  配置名: 'trim',
  版本: 'trim',
  trim: 'trim',
  年款: 'model_year',
  model_year: 'model_year',
  year: 'model_year',
  指导价: 'msrp',
  厂商指导价: 'msrp',
  msrp: 'msrp',
  price: 'msrp',
  当前售价: 'current_price',
  现售价: 'current_price',
  current_price: 'current_price',
  动力类型: 'powertrain',
  动力: 'powertrain',
  powertrain: 'powertrain',
  卖点: 'highlights',
  核心卖点: 'highlights',
  highlights: 'highlights',
  别名: 'aliases',
  叫法: 'aliases',
  aliases: 'aliases',
  图片: 'images',
  images: 'images',
  描述: 'description',
  简介: 'description',
  description: 'description',
};

/**
 * Parse a pasted vehicle list: a JSON array, or a CSV / TSV whose header names the columns (Chinese or English).
 * Whatever a dealer exports from their DMS lands as one of these two.
 */
export function parseVehicleRows(text: string): VehicleImportRow[] {
  const body = (text ?? '').trim();
  if (!body) throw new ValidationError('text', '没有内容');
  if (body.startsWith('[') || body.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      throw new ValidationError('text', `JSON 解析失败：${(err as Error).message}`);
    }
    const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { vehicles?: unknown }).vehicles) ? (parsed as { vehicles: unknown[] }).vehicles : null;
    if (!list) throw new ValidationError('text', 'JSON 需要是车型数组，或 {"vehicles": [...]}');
    return list.map((row, i) => {
      if (typeof row !== 'object' || row === null) throw new ValidationError(`text[${i}]`, '每一项需要是对象');
      return row as VehicleImportRow;
    });
  }
  const lines = body.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new ValidationError('text', '表格需要表头和至少一行数据');
  const sep = lines[0].includes('\t') ? '\t' : ',';
  const headers = splitRow(lines[0], sep).map((h) => IMPORT_HEADERS[h.trim().toLowerCase()] ?? IMPORT_HEADERS[h.trim()] ?? null);
  if (!headers.some((h) => h === 'model')) throw new ValidationError('text', '表头里找不到「车型」列');
  return lines.slice(1).map((line) => {
    const cells = splitRow(line, sep);
    const row: VehicleImportRow = {};
    headers.forEach((key, i) => {
      if (!key) return;
      const value = (cells[i] ?? '').trim();
      if (value) (row as Record<string, unknown>)[key] = value;
    });
    return row;
  });
}

/** CSV with quoted cells ("宝马 i3, 35L" stays one cell). */
function splitRow(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
      continue;
    }
    if (ch === sep && !quoted) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const asList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map((x) => String(x).trim()).filter(Boolean)
    : typeof value === 'string'
      ? value.split(/[\n,，、;；|]/).map((x) => x.trim()).filter(Boolean)
      : [];

const asInt = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[,，\s元]/g, '');
  const wan = /^(\d+(?:\.\d+)?)万$/.exec(cleaned);
  if (wan) return Math.round(Number(wan[1]) * 10_000);
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n) : null;
};

/**
 * Import many trims at once. A row that names an existing trim (same brand / model / trim / year) updates it instead
 * of creating a duplicate, and a row that cannot be understood is reported with its line number rather than dropped.
 * `addVehicle` (onboarding) stays the single place that decides canonical brand / model names.
 */
export function importVehicles(
  ctx: AppContext,
  dealerId: string,
  rows: readonly VehicleImportRow[],
  actor: string,
  addVehicle: (ctx: AppContext, dealerId: string, raw: unknown, actor: string) => Vehicle,
): VehicleImportResult {
  const dealer = getDealer(ctx, dealerId);
  const result: VehicleImportResult = { created: 0, updated: 0, failed: [], vehicles: [] };
  rows.forEach((row, i) => {
    const line = i + 1;
    try {
      const brand = String(row.brand ?? dealer.brands[0] ?? '').trim();
      const model = String(row.model ?? '').trim();
      const trim = String(row.trim ?? '').trim();
      const year = asInt(row.model_year);
      const msrp = asInt(row.msrp);
      if (!model) throw new ValidationError('model', '缺少车型');
      if (!trim) throw new ValidationError('trim', '缺少配置/版本');
      if (year === null) throw new ValidationError('model_year', '缺少年款');
      if (msrp === null) throw new ValidationError('msrp', '缺少厂商指导价');
      const canonical = getBrandInfo(brand)?.brand ?? brand;
      const existing = ctx.db
        .table('vehicles')
        .findMany({ group_id: dealer.group_id, model_year: year })
        .find((veh) => matchKey(veh.brand) === matchKey(canonical) && sameName(veh, model) && matchKey(veh.trim) === matchKey(trim));
      const extra = {
        current_price: row.current_price === undefined || row.current_price === null ? undefined : asInt(row.current_price),
        images: asList(row.images),
        description: typeof row.description === 'string' ? row.description.trim() : undefined,
        highlights: asList(row.highlights),
        aliases: asList(row.aliases),
      };
      if (existing) {
        const patch: Record<string, unknown> = { msrp };
        if (extra.current_price !== undefined && extra.current_price !== null) patch.current_price = extra.current_price;
        if (extra.images.length > 0) patch.images = extra.images;
        if (extra.description) patch.description = extra.description;
        if (extra.highlights.length > 0) patch.highlights = extra.highlights;
        if (extra.aliases.length > 0) patch.aliases = [...new Set([...existing.aliases, ...extra.aliases])];
        const updated = updateVehicle(ctx, existing.id, patch, actor);
        result.updated++;
        result.vehicles.push(updated);
        return;
      }
      const created = addVehicle(
        ctx,
        dealerId,
        {
          brand,
          model,
          trim,
          model_year: year,
          msrp,
          powertrain: typeof row.powertrain === 'string' ? normalizePowertrain(row.powertrain) : undefined,
          highlights: extra.highlights.join('\n'),
          aliases: extra.aliases.join(','),
        },
        actor,
      );
      const patch: Record<string, unknown> = {};
      if (extra.current_price !== undefined && extra.current_price !== null) patch.current_price = extra.current_price;
      if (extra.images.length > 0) patch.images = extra.images;
      if (extra.description) patch.description = extra.description;
      const final = Object.keys(patch).length > 0 ? updateVehicle(ctx, created.id, patch, actor) : created;
      result.created++;
      result.vehicles.push(final);
    } catch (err) {
      result.failed.push({ row: line, reason: err instanceof Error ? err.message : String(err) });
    }
  });
  ctx.audit.event({
    actor,
    action: 'vehicle.imported',
    entity_type: 'dealer',
    entity_id: dealerId,
    details: { created: result.created, updated: result.updated, failed: result.failed.length },
  });
  return result;
}

const sameName = (veh: Vehicle, name: string): boolean =>
  matchKey(veh.model) === matchKey(name) || matchKey(veh.model_zh) === matchKey(name) || veh.aliases.some((a) => matchKey(a) === matchKey(name));

/**
 * 增程 (REEV / range extender) is a series plug-in hybrid, which is what `PHEV` means in this schema — the exact
 * wording a manufacturer uses stays in the trim name and the specs, so nothing is lost by mapping it here.
 */
const POWERTRAIN_FROM_ZH: Record<string, string> = {
  纯电: 'EV',
  纯电动: 'EV',
  电动: 'EV',
  增程: 'PHEV',
  增程式: 'PHEV',
  增程式电动: 'PHEV',
  插电混动: 'PHEV',
  插混: 'PHEV',
  油电混动: 'HEV',
  混动: 'HEV',
  燃油: 'ICE',
  汽油: 'ICE',
};
const POWERTRAIN_FROM_EN: Record<string, string> = { EV: 'EV', BEV: 'EV', PHEV: 'PHEV', REEV: 'PHEV', EREV: 'PHEV', HEV: 'HEV', ICE: 'ICE' };
const normalizePowertrain = (value: string): string | undefined => {
  const s = value.trim();
  if (!s) return undefined;
  return POWERTRAIN_FROM_EN[s.toUpperCase()] ?? POWERTRAIN_FROM_ZH[s];
};

// ─────────────────────────────────────────────────────────────────────────────

interface VehicleBrainSkillInput {
  dealer_id: string;
  text?: string;
  brand?: string;
  model?: string;
  trim?: string;
  limit?: number;
}

export const skill = defineSkill<VehicleBrainSkillInput, { matches: VehicleMatch[]; context: string }>({
  name: 'vehicle-brain',
  category: 'operations',
  agent: VEHICLE_BRAIN_AGENT,
  description: '在门店的在售车型库里检索与客户意向匹配的车型卡片，返回真实价格、参数、颜色库存、金融政策和可用素材，供内容、获客、私信和对话使用。',
  input: v.object({
    dealer_id: v.string({ min: 1 }),
    text: v.optional(v.string({ max: 1000 })),
    brand: v.optional(v.string({ max: 40 })),
    model: v.optional(v.string({ max: 60 })),
    trim: v.optional(v.string({ max: 60 })),
    limit: v.optional(v.number({ int: true, min: 1, max: 20 })),
  }),
  run(ctx, input) {
    const matches = retrieveVehicles(ctx, input.dealer_id, input);
    return { matches, context: vehicleContext(matches.map((m) => m.card)).text };
  },
});
