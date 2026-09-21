/**
 * Automotive query planning (spec §5): turns a dealer goal plus structured Dealer Brain rows (catalog, inventory,
 * active offers, store location) and the automotive lexicon (competitors, body/powertrain) into search query texts
 * across the five query classes. Read-only — persistence and dedup against stored rows live in index.ts.
 *
 * Every generated text is grounded in real rows: trim variants only for in-stock trims, finance / lease / trade-in
 * queries only when such an offer is active, budget brackets from MSRP minus the best active cash offer.
 */
import type { AppContext } from '../../../app/context.ts';
import { ValidationError } from '../../../core/errors.ts';
import { clamp, normalizeText, round } from '../../../core/text.ts';
import type { Dealer, Evidence, GoalSpec, Offer, QueryClass, Vehicle } from '../../../core/types.ts';
import {
  competitorsOf,
  findLocation,
  getBrandInfo,
  getModelInfo,
  modelDisplayName,
  modelShortLabel,
  resolveModelName,
} from '../../../domain/automotive-lexicon.ts';
import {
  exactCny,
  findInventory,
  findVehicles,
  getActiveOffers,
  listDealers,
  offerAppliesToVehicle,
  type InventoryMatch,
} from '../../operations/dealer-brain/index.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Class priors (initial priority before evidence). `derived` inherits its parent's prior when the parent exists. */
export const QUERY_CLASS_PRIORS: Readonly<Record<QueryClass, number>> = Object.freeze({
  location: 0.8,
  transaction_intent: 0.75,
  direct_model: 0.6,
  competitor: 0.55,
  purchase_scenario: 0.4,
  derived: 0.6,
});

/** The five template classes produced by generation (`derived` is produced only by the feedback loop). */
export const GENERATED_QUERY_CLASSES = [
  'direct_model',
  'competitor',
  'purchase_scenario',
  'transaction_intent',
  'location',
] as const satisfies readonly QueryClass[];
export type GeneratedQueryClass = (typeof GENERATED_QUERY_CLASSES)[number];

/** Added to model-bound queries of the goal's priority models. */
export const PRIORITY_MODEL_BOOST = 0.1;
/** Competitors per model taken from the lexicon's competitive set (in the lexicon's order). */
export const MAX_COMPETITORS_PER_MODEL = 3;
/** Budget brackets are multiples of this many 万 (rounded DOWN: a 26.39万 net price is a '25万' buyer query). */
export const BUDGET_BRACKET_WAN = 5;
/** Without goal models and without any sellable inventory, at most this many catalog models are planned. */
export const FALLBACK_MODEL_CAP = 6;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface InStockTrim {
  vehicle: Vehicle;
  /** short trim alias used in search text, e.g. '35L' */
  alias: string;
  quantity: number;
}

export interface EntryPrice {
  vehicle: Vehicle;
  cash_offer: Offer | null;
  /** MSRP minus the best active cash discount (CNY) */
  net_price: number;
  /** budget bracket in 万, or null when the price is below one bracket */
  bracket_wan: number | null;
}

export interface ModelTarget {
  brand: string;
  brand_zh: string;
  model: string;
  model_zh: string;
  /** '宝马i3' */
  full_name: string;
  /** text used inside queries: model_zh, or brand_zh+model_zh for single-character model names */
  label: string;
  vehicles: Vehicle[];
  in_stock_quantity: number;
  in_transit_quantity: number;
  in_stock_trims: InStockTrim[];
  body: 'suv' | 'sedan' | null;
  body_label: string | null;
  electric: boolean;
  range_km: number | null;
  entry: EntryPrice | null;
  cash_offers: Offer[];
  finance_offers: Offer[];
  lease_offers: Offer[];
  /** goal priority model (goal.models) or, without goal models, a model with in-stock inventory */
  priority: boolean;
}

export interface BrandTarget {
  brand: string;
  brand_zh: string;
  models: ModelTarget[];
}

export interface GroupDealerRef {
  dealer_id: string;
  name: string;
  city: string;
  province: string;
}

/**
 * Who serves the target province (ARCHITECTURE §5.2 / §5.3):
 * - dealer: the dealer's own province
 * - group_dealer: another store of the group — discovered leads route to that store (§5.3)
 * - out_of_area: no store of the group — explicitly stated out-of-area buyers are capped below Qualified (§5.2)
 * - unknown: the target province could not be resolved (e.g. a district name without a province)
 */
export interface TargetArea {
  status: 'dealer' | 'group_dealer' | 'out_of_area' | 'unknown';
  group_dealers: GroupDealerRef[];
}

export interface QueryPlanTargets {
  dealer: Dealer;
  brands: BrandTarget[];
  city: string | null;
  province: string | null;
  location_source: 'goal' | 'dealer';
  /** normalized goal.province that was dropped because the stated city lies in another province */
  ignored_province: string | null;
  area: TargetArea;
  model_source: 'goal' | 'inventory';
  /** goal models the dealer's catalog does not carry (no queries generated for them) */
  skipped_models: string[];
  /** carried catalog models left out of an inventory-fallback plan (no sellable stock, or beyond FALLBACK_MODEL_CAP) */
  omitted_models: string[];
  trade_in_offers: Offer[];
}

export interface PlannedQuery {
  text: string;
  query_class: GeneratedQueryClass;
  brand: string | null;
  model: string | null;
  location: string | null;
  priority: number;
  generation_reason: string;
}

export interface QueryPlan {
  targets: QueryPlanTargets;
  queries: PlannedQuery[];
  evidence: Evidence[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Dedup key for query texts: NFKC, lower-case, whitespace removed ('I3 35L' ≡ 'i335l'). */
export function queryKey(text: string): string {
  return normalizeText(text).replace(/\s+/g, '');
}

/** Budget bracket (万) for a net price: floor to a multiple of BUDGET_BRACKET_WAN; null below one bracket. */
export function budgetBracketWan(netPrice: number): number | null {
  if (!Number.isFinite(netPrice) || netPrice <= 0) return null;
  const bracket = Math.floor(netPrice / (BUDGET_BRACKET_WAN * 10_000)) * BUDGET_BRACKET_WAN;
  return bracket >= BUDGET_BRACKET_WAN ? bracket : null;
}

/**
 * Short trim alias for search text: the shortest Dealer-Brain alias that does not already contain the model name
 * ('35L' for i3 eDrive35L, '325Li' for 3系325Li); falls back to the trim itself.
 */
export function trimAlias(vehicle: Vehicle): string {
  const modelKeys = [queryKey(vehicle.model), queryKey(vehicle.model_zh)].filter(Boolean);
  const candidates = vehicle.aliases
    .map((a) => a.trim())
    .filter((a) => a.length > 0 && !modelKeys.some((k) => queryKey(a).includes(k)));
  candidates.sort((a, b) => [...a].length - [...b].length || a.localeCompare(b));
  return candidates[0] ?? vehicle.trim;
}

function brandsMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (queryKey(a) === queryKey(b)) return true;
  const ia = getBrandInfo(a);
  const ib = getBrandInfo(b);
  return ia !== undefined && ib !== undefined && ia.brand === ib.brand;
}

function stockPhrase(m: ModelTarget): string {
  if (m.in_stock_quantity > 0) {
    return `本店现车${m.in_stock_quantity}台${m.in_transit_quantity > 0 ? `、在途${m.in_transit_quantity}台` : ''}`;
  }
  if (m.in_transit_quantity > 0) return `本店在途${m.in_transit_quantity}台`;
  return '本店暂无现车';
}

function offerPhrase(o: Offer): string {
  const amount = o.type === 'cash_discount' || o.type === 'trade_in' ? (o.amount && o.amount > 0 ? `${exactCny(o.amount)}，` : '') : '';
  return `「${o.title}」（${amount}有效期至${o.valid_until}）`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Target resolution (goal + Dealer Brain)
// ─────────────────────────────────────────────────────────────────────────────

function carriedVehicles(ctx: AppContext, dealer: Dealer): Vehicle[] {
  const all = ctx.db
    .table('vehicles')
    .findMany({ group_id: dealer.group_id }, { orderBy: 'brand ASC, model ASC, msrp ASC, trim ASC' });
  if (dealer.brands.length === 0) return all;
  return all.filter((veh) => dealer.brands.some((b) => brandsMatch(b, veh.brand) || brandsMatch(b, veh.brand_zh)));
}

function resolveGoalBrand(goalBrand: string, dealer: Dealer, vehicles: Vehicle[]): string {
  const fromVehicle = vehicles.find((veh) => brandsMatch(goalBrand, veh.brand) || brandsMatch(goalBrand, veh.brand_zh));
  if (fromVehicle) return fromVehicle.brand;
  const fromDealer = dealer.brands.find((b) => brandsMatch(goalBrand, b));
  if (fromDealer) return getBrandInfo(fromDealer)?.brand ?? fromDealer;
  throw new ValidationError('goal.brand', `brand "${goalBrand}" is not carried by dealer ${dealer.name}`);
}

function brandZhOf(brand: string, vehicles: Vehicle[]): string {
  return vehicles.find((veh) => veh.brand === brand)?.brand_zh || getBrandInfo(brand)?.brand_zh || brand;
}

const ADMIN_SUFFIX_RE = /(特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|省|市)$/u;

/** Short province name: '浙江省' → '浙江', '上海市' → '上海', a known city → its province; unknown text loses its admin suffix. */
function normalizeProvince(raw: string | null | undefined): string | null {
  const text = raw?.trim();
  if (!text) return null;
  const found = findLocation(text);
  if (found?.province) return found.province;
  return text.replace(ADMIN_SUFFIX_RE, '') || text;
}

type ResolvedLocation = Pick<QueryPlanTargets, 'city' | 'province' | 'location_source' | 'ignored_province'>;

function resolveLocation(dealer: Dealer, goal: GoalSpec): ResolvedLocation {
  const raw = goal.location?.trim();
  const goalProvince = normalizeProvince(goal.province);
  const dealerProvince = normalizeProvince(dealer.province);
  if (raw) {
    const found = findLocation(raw);
    if (found?.city) {
      // the lexicon province of a stated city is authoritative; a conflicting goal.province is dropped (and recorded)
      const province = found.province ?? goalProvince;
      const ignored = goalProvince !== null && province !== null && goalProvince !== province ? goalProvince : null;
      return { city: found.city, province, location_source: 'goal', ignored_province: ignored };
    }
    if (found?.province) {
      const ignored = goalProvince !== null && goalProvince !== found.province ? goalProvince : null;
      return {
        city: dealerProvince === found.province ? dealer.city || null : null,
        province: found.province,
        location_source: 'goal',
        ignored_province: ignored,
      };
    }
    // a place the lexicon does not know (e.g. a district) is used literally as the target city
    return { city: raw.replace(/市$/u, '') || raw, province: goalProvince, location_source: 'goal', ignored_province: null };
  }
  if (goalProvince) {
    return {
      city: dealerProvince === goalProvince ? dealer.city || null : null,
      province: goalProvince,
      location_source: 'goal',
      ignored_province: null,
    };
  }
  return { city: dealer.city || null, province: dealerProvince, location_source: 'dealer', ignored_province: null };
}

/** Which store of the group serves the target province (§5.2 out-of-area cap / §5.3 group-level dealer matching). */
function resolveArea(ctx: AppContext, dealer: Dealer, province: string | null): TargetArea {
  const own = normalizeProvince(dealer.province);
  if (!province || !own) return { status: 'unknown', group_dealers: [] };
  if (province === own) return { status: 'dealer', group_dealers: [] };
  const others = listDealers(ctx, dealer.group_id)
    .filter((d) => d.id !== dealer.id && normalizeProvince(d.province) === province)
    .map((d) => ({ dealer_id: d.id, name: d.name, city: d.city, province: d.province }));
  return others.length > 0 ? { status: 'group_dealer', group_dealers: others } : { status: 'out_of_area', group_dealers: [] };
}

function bestCashOffer(ctx: AppContext, dealerId: string, vehicle: Vehicle): Offer | null {
  const offers = getActiveOffers(ctx, dealerId, { vehicle_id: vehicle.id, types: ['cash_discount'] }).filter(
    (o) => (o.amount ?? 0) > 0,
  );
  offers.sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0) || a.id.localeCompare(b.id));
  return offers[0] ?? null;
}

function buildModelTarget(
  ctx: AppContext,
  dealer: Dealer,
  model: string,
  vehicles: Vehicle[],
  stock: InventoryMatch[],
  priority: boolean,
): ModelTarget {
  const vs = vehicles.filter((veh) => veh.model === model).sort((a, b) => a.msrp - b.msrp || a.trim.localeCompare(b.trim));
  const first = vs[0];
  const brand = first.brand;
  const brandZh = first.brand_zh || getBrandInfo(brand)?.brand_zh || brand;
  const modelZh = first.model_zh || model;
  const fullName = modelZh.startsWith(brandZh) ? modelZh : `${brandZh}${modelZh}`;
  const label = [...modelZh].length < 2 ? fullName : modelZh;
  const ids = new Set(vs.map((veh) => veh.id));
  const rows = stock.filter((m) => ids.has(m.vehicle.id));

  let inStock = 0;
  let inTransit = 0;
  const trimQty = new Map<string, number>();
  for (const r of rows) {
    if (r.inventory.status === 'in_stock') {
      inStock += r.inventory.quantity;
      trimQty.set(r.vehicle.id, (trimQty.get(r.vehicle.id) ?? 0) + r.inventory.quantity);
    } else if (r.inventory.status === 'in_transit') {
      inTransit += r.inventory.quantity;
    }
  }
  const inStockTrims: InStockTrim[] = vs
    .filter((veh) => (trimQty.get(veh.id) ?? 0) > 0)
    .map((veh) => ({ vehicle: veh, alias: trimAlias(veh), quantity: trimQty.get(veh.id) ?? 0 }))
    .sort((a, b) => b.quantity - a.quantity || a.vehicle.msrp - b.vehicle.msrp || a.alias.localeCompare(b.alias));

  const lex = getModelInfo(model);
  const specs = first.specs ?? {};
  const bodyText = typeof specs.body_type === 'string' ? specs.body_type : null;
  // Query phrasing only distinguishes 轿车 from SUV; anything else (an MPV) stays null and is phrased by model name.
  let body: 'suv' | 'sedan' | null = null;
  if (bodyText && /suv/i.test(bodyText)) body = 'suv';
  else if (bodyText && /轿/u.test(bodyText)) body = 'sedan';
  else if (lex && (lex.body === 'suv' || lex.body === 'sedan')) body = lex.body;
  const electric = specs.powertrain ? specs.powertrain === 'EV' : lex?.powertrain === 'EV';
  const rangeKm = typeof specs.range_km === 'number' && specs.range_km > 0 ? specs.range_km : null;

  const pool = inStockTrims.length > 0 ? inStockTrims.map((t) => t.vehicle) : vs;
  let entry: EntryPrice | null = null;
  for (const veh of pool) {
    if (!(veh.msrp > 0)) continue;
    const cash = bestCashOffer(ctx, dealer.id, veh);
    const net = veh.msrp - (cash?.amount ?? 0);
    if (!entry || net < entry.net_price || (net === entry.net_price && veh.msrp < entry.vehicle.msrp)) {
      entry = { vehicle: veh, cash_offer: cash, net_price: net, bracket_wan: budgetBracketWan(net) };
    }
  }

  return {
    brand,
    brand_zh: brandZh,
    model,
    model_zh: modelZh,
    full_name: fullName,
    label,
    vehicles: vs,
    in_stock_quantity: inStock,
    in_transit_quantity: inTransit,
    in_stock_trims: inStockTrims,
    body,
    body_label: bodyText ?? (body === 'suv' ? 'SUV' : body === 'sedan' ? '轿车' : null),
    electric,
    range_km: rangeKm,
    entry,
    cash_offers: getActiveOffers(ctx, dealer.id, { model, types: ['cash_discount'] }).filter((o) => (o.amount ?? 0) > 0),
    finance_offers: getActiveOffers(ctx, dealer.id, { model, types: ['finance'] }),
    lease_offers: getActiveOffers(ctx, dealer.id, { model, types: ['lease'] }),
    priority,
  };
}

/** Resolve brand, models, location and offers for a goal from Dealer Brain rows. */
export function resolveQueryTargets(ctx: AppContext, dealer: Dealer, goal: GoalSpec): QueryPlanTargets {
  const vehicles = carriedVehicles(ctx, dealer);
  const goalBrand = goal.brand?.trim() ? resolveGoalBrand(goal.brand.trim(), dealer, vehicles) : null;
  const scoped = goalBrand ? vehicles.filter((veh) => veh.brand === goalBrand) : vehicles;
  const carriedIds = new Set(scoped.map((veh) => veh.id));
  const stock = findInventory(ctx, dealer.id, { statuses: ['in_stock', 'in_transit'] }).filter((m) =>
    carriedIds.has(m.vehicle.id),
  );

  const skipped: string[] = [];
  const omitted: string[] = [];
  let models: { model: string; priority: boolean }[] = [];
  let modelSource: 'goal' | 'inventory' = 'goal';
  const goalModels = (goal.models ?? []).map((m) => m.trim()).filter((m) => m.length > 0);
  const carriedMatches = (name: string) =>
    findVehicles(ctx, dealer.group_id, { brand: goalBrand ?? undefined, model: name }).filter((veh) => carriedIds.has(veh.id));

  if (goalModels.length > 0) {
    for (const name of goalModels) {
      let matches = carriedMatches(name);
      if (matches.length === 0) {
        // colloquial names the catalog aliases do not list ('三系', '五系') resolve through the automotive lexicon
        const canonical = resolveModelName(name);
        if (canonical && canonical !== name) matches = carriedMatches(canonical);
      }
      if (matches.length === 0) {
        if (!skipped.includes(name)) skipped.push(name);
        continue;
      }
      const model = matches[0].model;
      if (!models.some((m) => m.model === model)) models.push({ model, priority: true });
    }
    if (models.length === 0) {
      throw new ValidationError('goal.models', `none of the goal models (${goalModels.join(', ')}) are carried by dealer ${dealer.name}`);
    }
  } else {
    modelSource = 'inventory';
    const qty = new Map<string, { in_stock: number; in_transit: number }>();
    for (const veh of scoped) if (!qty.has(veh.model)) qty.set(veh.model, { in_stock: 0, in_transit: 0 });
    for (const r of stock) {
      const q = qty.get(r.vehicle.model);
      if (!q) continue;
      if (r.inventory.status === 'in_stock') q.in_stock += r.inventory.quantity;
      else if (r.inventory.status === 'in_transit') q.in_transit += r.inventory.quantity;
    }
    const sellable = [...qty.entries()]
      .filter(([, q]) => q.in_stock + q.in_transit > 0)
      .sort((a, b) => b[1].in_stock - a[1].in_stock || b[1].in_transit - a[1].in_transit || a[0].localeCompare(b[0]));
    let chosen: string[];
    if (sellable.length > 0) {
      chosen = sellable.map(([model]) => model);
    } else {
      // nothing sellable: models the store is actively pushing (a model- or trim-specific active offer) first, then
      // the lowest entry MSRP (widest buyer pool); capped — the rest is recorded as omitted, never dropped silently
      const offerModels = new Set<string>();
      for (const o of getActiveOffers(ctx, dealer.id)) {
        if (!o.model && !o.vehicle_id) continue;
        for (const veh of scoped) if (offerAppliesToVehicle(o, veh)) offerModels.add(veh.model);
      }
      const entryMsrp = (model: string) =>
        Math.min(Number.POSITIVE_INFINITY, ...scoped.filter((veh) => veh.model === model && veh.msrp > 0).map((veh) => veh.msrp));
      chosen = [...qty.keys()]
        .sort(
          (a, b) =>
            Number(offerModels.has(b)) - Number(offerModels.has(a)) || entryMsrp(a) - entryMsrp(b) || a.localeCompare(b),
        )
        .slice(0, FALLBACK_MODEL_CAP);
    }
    models = chosen.map((model) => ({ model, priority: (qty.get(model)?.in_stock ?? 0) > 0 }));
    for (const model of qty.keys()) if (!chosen.includes(model)) omitted.push(model);
  }

  const modelTargets = models.map((m) => buildModelTarget(ctx, dealer, m.model, scoped, stock, m.priority));
  let brandNames: string[];
  if (goalBrand) brandNames = [goalBrand];
  else if (goalModels.length > 0) brandNames = [...new Set(modelTargets.map((m) => m.brand))];
  else {
    const fromDealer = dealer.brands.map((b) => vehicles.find((veh) => brandsMatch(b, veh.brand))?.brand ?? getBrandInfo(b)?.brand ?? b);
    brandNames = [...new Set(fromDealer.length > 0 ? fromDealer : vehicles.map((veh) => veh.brand))];
  }
  if (brandNames.length === 0) {
    throw new ValidationError('goal.brand', `dealer ${dealer.name} has no brand in Dealer Brain; set goal.brand or import vehicles`);
  }

  const brands: BrandTarget[] = brandNames.map((brand) => ({
    brand,
    brand_zh: brandZhOf(brand, vehicles),
    models: modelTargets.filter((m) => m.brand === brand),
  }));

  const location = resolveLocation(dealer, goal);
  return {
    dealer,
    brands,
    ...location,
    area: resolveArea(ctx, dealer, location.province),
    model_source: modelSource,
    skipped_models: skipped,
    omitted_models: omitted,
    trade_in_offers: getActiveOffers(ctx, dealer.id, { types: ['trade_in'] }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────────────

class PlanBuilder {
  private readonly byKey = new Map<string, PlannedQuery>();

  add(input: Omit<PlannedQuery, 'priority'> & { boost: boolean }): void {
    const text = input.text.replace(/\s+/g, ' ').trim();
    const key = queryKey(text);
    if (!key) return;
    const priority = round(clamp(QUERY_CLASS_PRIORS[input.query_class] + (input.boost ? PRIORITY_MODEL_BOOST : 0), 0, 1), 4);
    const planned: PlannedQuery = {
      text,
      query_class: input.query_class,
      brand: input.brand,
      model: input.model,
      location: input.location,
      priority,
      generation_reason: input.generation_reason,
    };
    const existing = this.byKey.get(key);
    // the same text from a higher-priority source (e.g. a goal priority model) replaces the earlier entry in place
    if (!existing || priority > existing.priority) this.byKey.set(key, existing ? { ...planned, text: existing.text } : planned);
  }

  list(): PlannedQuery[] {
    return [...this.byKey.values()];
  }
}

function boostNote(m: ModelTarget, source: 'goal' | 'inventory'): string {
  if (!m.priority) return '';
  return source === 'goal' ? '；目标重点车型，优先级+0.1' : '；有现车的主推车型，优先级+0.1';
}

function cashNote(m: ModelTarget): string {
  const o = m.cash_offers[0];
  return o ? `本店当期有${offerPhrase(o)}` : '本店暂无现金优惠，仍可捕捉询问优惠的在市买家';
}

/** Build every template query for the resolved targets (deduplicated by queryKey, spec §5 class order). */
export function buildPlannedQueries(t: QueryPlanTargets): PlannedQuery[] {
  const b = new PlanBuilder();
  const allModels = t.brands.flatMap((br) => br.models);
  const src = t.model_source;
  const areaNote =
    t.area.status === 'out_of_area'
      ? '，集团在该省无门店，发现的异地线索不会成为本店合格线索'
      : t.area.status === 'group_dealer'
        ? `，线索按集团门店匹配分配给${t.area.group_dealers.map((d) => d.name).join('、')}`
        : '';
  const locSrc = `${t.location_source === 'goal' ? '经营目标指定地域' : '门店所在地'}${areaNote}`;

  // DIRECT MODEL
  for (const m of allModels) {
    const base = { query_class: 'direct_model' as const, brand: m.brand, model: m.model, location: null, boost: m.priority };
    const note = boostNote(m, src);
    b.add({ ...base, text: m.full_name, generation_reason: `直接车型词「品牌+车型」：${m.full_name}为本店在售车型（Dealer Brain车型库${m.vehicles.length}个配置，${stockPhrase(m)}）${note}` });
    b.add({ ...base, text: `${m.full_name}价格`, generation_reason: `直接车型词「品牌+车型+价格」：捕捉询问${m.full_name}价格的在市买家（${stockPhrase(m)}）${note}` });
    b.add({ ...base, text: `${m.full_name}落地`, generation_reason: `直接车型词「品牌+车型+落地」：捕捉关心${m.full_name}落地价、处于比价阶段的买家${note}` });
    b.add({ ...base, text: `${m.label}优惠`, generation_reason: `直接车型词「车型+优惠」：${cashNote(m)}${note}` });
    b.add({ ...base, text: `${m.label}值得买吗`, generation_reason: `直接车型词「车型+值得买吗」：研究阶段买家的常见问法，提前发现${m.full_name}潜在买家${note}` });
    for (const trim of m.in_stock_trims) {
      b.add({
        ...base,
        text: `${m.label} ${trim.alias}`,
        generation_reason: `配置词「车型+配置简称」：${m.full_name} ${trim.vehicle.trim}（简称${trim.alias}）本店现车${trim.quantity}台（库存表）${note}`,
      });
    }
  }

  // COMPETITOR
  for (const m of allModels) {
    const base = { query_class: 'competitor' as const, brand: m.brand, model: m.model, location: null, boost: m.priority };
    for (const c of competitorsOf(m.brand, m.model).slice(0, MAX_COMPETITORS_PER_MODEL)) {
      const compLabel = modelShortLabel(c.model);
      const compFull = modelDisplayName(c.brand, c.model, 'zh');
      const why = `${compFull}是${m.full_name}的主要竞品（汽车词库竞品关系），对比中的买家处于比较阶段${boostNote(m, src)}`;
      b.add({ ...base, text: `${m.label} vs ${compLabel}`, generation_reason: `竞品对比词「车型 vs 竞品」：${why}` });
      b.add({ ...base, text: `${m.label}还是${compLabel}`, generation_reason: `竞品对比词「车型还是竞品」：${why}` });
    }
  }

  // PURCHASE SCENARIO
  for (const m of allModels) {
    const base = { query_class: 'purchase_scenario' as const, brand: m.brand, model: m.model, location: null, boost: m.priority };
    const note = boostNote(m, src);
    const e = m.entry;
    if (e && e.bracket_wan !== null) {
      const price =
        `${m.full_name} ${e.vehicle.trim}指导价${exactCny(e.vehicle.msrp)}` +
        (e.cash_offer ? `，减本店当期「${e.cash_offer.title}」${exactCny(e.cash_offer.amount ?? 0)}后约${exactCny(e.net_price)}` : '，本店暂无现金优惠') +
        `，归入${e.bracket_wan}万价位段`;
      b.add({ ...base, text: `${e.bracket_wan}万买什么车`, generation_reason: `预算场景词「N万买什么车」：${price}${note}` });
      if (m.body === 'suv') {
        b.add({ ...base, text: `${e.bracket_wan}万SUV`, generation_reason: `预算场景词「N万SUV」：${m.full_name}为${m.body_label ?? 'SUV'}（车型参数）；${price}${note}` });
      }
    }
    if (m.body === 'suv') {
      b.add({ ...base, text: '家用SUV推荐', generation_reason: `车型场景词「家用SUV推荐」：${m.full_name}为${m.body_label ?? 'SUV'}（车型参数），匹配家庭SUV选购需求${note}` });
    }
    if (m.electric) {
      const range = m.range_km ? `，续航${m.range_km}km` : '';
      b.add({ ...base, text: '电车推荐', generation_reason: `新能源场景词「电车推荐」：${m.full_name}为纯电车型（车型参数${range}）${note}` });
      if (m.body === 'sedan') {
        b.add({ ...base, text: '纯电轿车推荐', generation_reason: `新能源场景词「纯电轿车推荐」：${m.full_name}为${m.body_label ?? '纯电轿车'}（车型参数${range}）${note}` });
      } else if (m.body === 'suv') {
        b.add({ ...base, text: '纯电SUV推荐', generation_reason: `新能源场景词「纯电SUV推荐」：${m.full_name}为${m.body_label ?? '纯电SUV'}（车型参数${range}）${note}` });
      }
    }
  }
  for (const br of t.brands) {
    const base = { query_class: 'purchase_scenario' as const, brand: br.brand, model: null, location: null, boost: false };
    b.add({ ...base, text: `第一次买${br.brand_zh}`, generation_reason: `购车场景词「第一次买${br.brand_zh}」：首次购买${br.brand_zh}的买家通常处于研究与选店阶段，本店经营${br.brand_zh}（Dealer Brain品牌）` });
    const tradeIn = t.trade_in_offers[0];
    b.add({ ...base, text: '准备换车', generation_reason: `购车场景词「准备换车」：换购人群的常见表达${tradeIn ? `；本店当期置换政策${offerPhrase(tradeIn)}` : ''}` });
  }

  // TRANSACTION INTENT
  for (const m of allModels) {
    const base = { query_class: 'transaction_intent' as const, brand: m.brand, model: m.model, location: null, boost: m.priority };
    const note = boostNote(m, src);
    b.add({ ...base, text: `${m.label}落地价`, generation_reason: `交易意图词「车型+落地价」：询问${m.full_name}落地价的买家处于比价/成交阶段${note}` });
    b.add({ ...base, text: `${m.label}优惠多少`, generation_reason: `交易意图词「车型+优惠多少」：${cashNote(m)}${note}` });
    if (m.in_stock_quantity + m.in_transit_quantity > 0) {
      b.add({ ...base, text: `${m.label}有现车吗`, generation_reason: `交易意图词「车型+有现车吗」：${stockPhrase(m)}（库存表），可承接询问现车的买家${note}` });
    }
    const finance = m.finance_offers[0];
    if (finance) {
      b.add({ ...base, text: `${m.label}贷款方案`, generation_reason: `交易意图词「车型+贷款方案」：本店当期金融方案${offerPhrase(finance)}${note}` });
    }
    const lease = m.lease_offers[0];
    if (lease) {
      b.add({ ...base, text: `${m.label}以租代购`, generation_reason: `交易意图词「车型+以租代购」：本店当期租赁方案${offerPhrase(lease)}${note}` });
    }
  }
  for (const br of t.brands) {
    const base = { query_class: 'transaction_intent' as const, brand: br.brand, model: null, location: null, boost: false };
    const tradeIn = t.trade_in_offers[0];
    if (tradeIn) {
      b.add({ ...base, text: `${br.brand_zh}置换补贴`, generation_reason: `交易意图词「品牌+置换补贴」：本店当期置换政策${offerPhrase(tradeIn)}` });
    }
    b.add({ ...base, text: '什么时候买便宜', generation_reason: '交易意图词「什么时候买便宜」：关注购车时机的价格敏感买家，常处于临近下单阶段' });
  }

  // BRAND-LEVEL BUYER QUESTIONS — only while the Dealer Brain has no vehicles for the brand: without models the other
  // classes fall back to 城市+品牌 words, which on Xiaohongshu return mostly dealer stores' promotion posts (2026-09 live
  // capture). Buyers write questions instead. Model-level words replace these once vehicles are entered in 设置.
  for (const br of t.brands.filter((x) => x.models.length === 0)) {
    const why = `本店尚未在门店资料中录入${br.brand_zh}车型，先按品牌用买家常用问法搜索；录入车型后改用车型级搜索词`;
    b.add({ query_class: 'direct_model', brand: br.brand, model: null, location: null, boost: false, text: `${br.brand_zh}值得买吗`, generation_reason: `买家问法「品牌+值得买吗」：研究阶段买家的常见问法，讨论帖评论区集中了在比较的买家；${why}` });
    b.add({ query_class: 'purchase_scenario', brand: br.brand, model: null, location: null, boost: false, text: `${br.brand_zh}哪款值得买`, generation_reason: `买家问法「品牌+哪款值得买」：在${br.brand_zh}车型之间挑选的买家；${why}` });
    b.add({ query_class: 'transaction_intent', brand: br.brand, model: null, location: null, boost: false, text: `${br.brand_zh}落地价`, generation_reason: `买家问法「品牌+落地价」：询问落地价的买家处于比价/成交阶段；${why}` });
    b.add({ query_class: 'purchase_scenario', brand: br.brand, model: null, location: null, boost: false, text: `${br.brand_zh}求推荐`, generation_reason: `买家问法「品牌+求推荐」：请网友帮忙选车的买家；${why}` });
  }

  // LOCATION
  for (const br of t.brands) {
    const base = { query_class: 'location' as const, brand: br.brand, model: null, boost: false };
    if (t.city) {
      const cashCount = new Set(br.models.flatMap((m) => m.cash_offers.map((o) => o.id))).size;
      b.add({ ...base, location: t.city, text: `${t.city}${br.brand_zh}`, generation_reason: `地域词「城市+品牌」：锁定${t.city}本地的${br.brand_zh}买家（${locSrc}）` });
      b.add({
        ...base,
        location: t.city,
        text: `${t.city}${br.brand_zh}优惠`,
        generation_reason: `地域词「城市+品牌+优惠」：锁定${t.city}询问${br.brand_zh}优惠的买家（${locSrc}）${cashCount > 0 ? `；目标车型当期有${cashCount}项现金优惠` : ''}`,
      });
      b.add({ ...base, location: t.city, text: `${t.city}买${br.brand_zh}`, generation_reason: `地域词「城市+买+品牌」：锁定在${t.city}选店购车的买家（${locSrc}）` });
    }
    if (t.province) {
      b.add({ ...base, location: t.province, text: `${t.province}${br.brand_zh}价格`, generation_reason: `地域词「省份+品牌+价格」：覆盖${t.province}范围内比较${br.brand_zh}价格的买家（${locSrc}）` });
    }
  }
  if (t.city) {
    for (const m of allModels) {
      const base = { query_class: 'location' as const, brand: m.brand, model: m.model, location: t.city, boost: m.priority };
      const note = boostNote(m, src);
      b.add({ ...base, text: `${t.city}${m.label}`, generation_reason: `地域词「城市+车型」：锁定${t.city}关注${m.full_name}的买家（${locSrc}）${note}` });
      b.add({ ...base, text: `${t.city}${m.label}落地`, generation_reason: `地域词「城市+车型+落地」：锁定${t.city}询问${m.full_name}落地价的高意向买家（${locSrc}）${note}` });
      if (m.in_stock_quantity + m.in_transit_quantity > 0) {
        b.add({ ...base, text: `${t.city}${m.label}有现车吗`, generation_reason: `地域词「城市+车型+有现车吗」：${t.city}买家询问现车，${stockPhrase(m)}（库存表）${note}` });
      }
    }
  }

  return b.list();
}

function planEvidence(t: QueryPlanTargets): Evidence[] {
  const out: Evidence[] = [];
  const seenOffers = new Set<string>();
  const offerEvidence = (o: Offer) => {
    if (seenOffers.has(o.id)) return;
    seenOffers.add(o.id);
    out.push({ code: 'active_offer', label: `本店当期政策${offerPhrase(o)}`, source_ref: o.id });
  };
  for (const br of t.brands) {
    for (const m of br.models) {
      out.push({
        code: 'carried_model',
        label: `${m.full_name}：${m.vehicles.length}个在售配置，${stockPhrase(m)}${m.in_stock_trims.length ? `（现车配置：${m.in_stock_trims.map((x) => x.alias).join('、')}）` : ''}`,
        source_ref: m.vehicles[0]?.id,
      });
      if (m.entry?.cash_offer) offerEvidence(m.entry.cash_offer);
      for (const o of [...m.finance_offers.slice(0, 1), ...m.lease_offers.slice(0, 1)]) offerEvidence(o);
    }
  }
  if (t.trade_in_offers[0]) offerEvidence(t.trade_in_offers[0]);
  out.push({
    code: 'target_location',
    label: `目标地域：${[t.city, t.province && t.province !== t.city ? `（${t.province}）` : ''].filter(Boolean).join('') || '未指定'}，来源：${t.location_source === 'goal' ? '经营目标' : '门店信息'}`,
    source_ref: t.dealer.id,
  });
  const place = t.city ?? t.province ?? '';
  if (t.ignored_province !== null && t.province !== null) {
    out.push({
      code: 'goal_province_ignored',
      label: `经营目标省份「${t.ignored_province}」与目标地域「${place}」所在省份（${t.province}）不一致，已按${t.province}生成查询`,
      source_ref: t.dealer.id,
    });
  }
  if (t.area.status === 'out_of_area') {
    out.push({
      code: 'out_of_area_location',
      label: `目标地域「${place}」（${t.province}）不在本店所在省份（${t.dealer.province}），集团在该省也没有门店：明确表示在该地购车的买家按异地买家规则不会成为本店合格线索`,
      source_ref: t.dealer.id,
    });
  } else if (t.area.status === 'group_dealer') {
    out.push({
      code: 'group_dealer_location',
      label: `目标地域「${place}」（${t.province}）由集团内${t.area.group_dealers.map((d) => d.name).join('、')}服务：发现的线索将按集团门店匹配分配给该门店`,
      source_ref: t.area.group_dealers[0]?.dealer_id ?? t.dealer.id,
    });
  }
  for (const name of t.skipped_models) {
    out.push({ code: 'model_not_carried', label: `目标车型「${name}」不在本店车型库，未生成查询`, source_ref: t.dealer.id });
  }
  if (t.omitted_models.length > 0) {
    const names = t.omitted_models.map((m) => modelDisplayName('', m, 'zh')).join('、');
    const anySellable = t.brands.some((br) => br.models.some((m) => m.in_stock_quantity + m.in_transit_quantity > 0));
    out.push({
      code: 'models_omitted',
      label: anySellable
        ? `经营目标未指定车型，按库存规划有现车或在途的车型；暂无库存、未生成查询的车型：${names}`
        : `本店暂无现车或在途库存，按当期车型政策与入门价最多规划${FALLBACK_MODEL_CAP}个车型；未规划：${names}`,
      source_ref: t.dealer.id,
    });
  }
  return out;
}

/** Resolve targets and build the (unpersisted) query plan for a goal. */
export function buildQueryPlan(ctx: AppContext, dealer: Dealer, goal: GoalSpec): QueryPlan {
  const targets = resolveQueryTargets(ctx, dealer, goal);
  const queries = buildPlannedQueries(targets);
  return { targets, queries, evidence: planEvidence(targets) };
}
