import type { AppContext } from '../../../app/context.ts';
import { NotFoundError } from '../../../core/errors.ts';
import type {
  Dealer,
  DealerKnowledge,
  DealerProfile,
  Inventory,
  InventoryStatus,
  KnowledgeCategory,
  Offer,
  OfferType,
  Vehicle,
} from '../../../core/types.ts';
import { buildDealerProfile } from '../../../domain/dealer-profile.ts';
import { colorMatches, dealerTz, isValidAt, matchKey, mergeDealerSettings } from './shared.ts';

export interface VehicleQuery {
  brand?: string;
  model?: string;
  trim?: string;
}

export interface InventoryMatch {
  inventory: Inventory;
  vehicle: Vehicle;
}

export interface InventoryQuery {
  model?: string;
  trim?: string;
  vehicle_id?: string;
  exterior_color?: string;
  interior_color?: string;
  statuses?: InventoryStatus[];
}

export interface OfferQuery {
  model?: string;
  vehicle_id?: string;
  types?: OfferType[];
}

export interface ProhibitedClaim {
  phrase: string;
  reason: string;
  knowledge_id: string;
}

/** Dealer row with settings completed from DEFAULT_DEALER_SETTINGS. */
export function getDealer(ctx: AppContext, dealerId: string): Dealer {
  const dealer = ctx.db.table('dealers').get(dealerId);
  if (!dealer) throw new NotFoundError('dealer', dealerId);
  return { ...dealer, settings: mergeDealerSettings(dealer.settings) };
}

export function listDealers(ctx: AppContext, groupId?: string): Dealer[] {
  return ctx.db
    .table('dealers')
    .findMany(groupId ? { group_id: groupId } : undefined, { orderBy: 'created_at ASC, name ASC' })
    .map((d) => ({ ...d, settings: mergeDealerSettings(d.settings) }));
}

export function getDealerProfile(ctx: AppContext, dealerId: string): DealerProfile {
  return buildDealerProfile(ctx, dealerId);
}

function stripBrandPrefix(key: string, vehicle: Vehicle): string {
  for (const b of [matchKey(vehicle.brand_zh), matchKey(vehicle.brand)]) {
    if (b && key.startsWith(b) && key.length > b.length) return key.slice(b.length);
  }
  return key;
}

/** 0 = no match · 1 = alias match · 2 = canonical model / model_zh match */
function modelMatchRank(vehicle: Vehicle, model: string): number {
  const raw = matchKey(model);
  if (!raw) return 0;
  const q = stripBrandPrefix(raw, vehicle);
  const canonical = [matchKey(vehicle.model), matchKey(vehicle.model_zh)];
  if (canonical.includes(q) || canonical.includes(raw)) return 2;
  const aliases = vehicle.aliases.map(matchKey);
  if (aliases.includes(q) || aliases.includes(raw)) return 1;
  return 0;
}

/**
 * Trim match: exact trim, an alias, model+trim ('i3eDrive35L'), or a letter-bounded suffix of the
 * trim ('35L' → 'eDrive35L', never '5L').
 */
function trimMatches(vehicle: Vehicle, trim: string): boolean {
  const raw = matchKey(trim);
  if (!raw) return false;
  const q = stripBrandPrefix(raw, vehicle);
  const t = matchKey(vehicle.trim);
  if (q === t) return true;
  if (vehicle.aliases.some((a) => matchKey(a) === q)) return true;
  for (const m of [matchKey(vehicle.model), matchKey(vehicle.model_zh)]) {
    if (m && q === m + t) return true;
    if (m && q.startsWith(m) && q.slice(m.length) === t) return true;
  }
  if (q.length >= 3 && /\d/.test(q) && t.endsWith(q)) {
    const before = t.charAt(t.length - q.length - 1);
    if (before && !/[0-9]/.test(before)) return true;
  }
  return false;
}

function brandMatches(vehicle: Vehicle, brand: string): boolean {
  const q = matchKey(brand);
  return q === matchKey(vehicle.brand) || q === matchKey(vehicle.brand_zh);
}

function rankedVehicles(ctx: AppContext, groupId: string, q: VehicleQuery): { vehicle: Vehicle; rank: number }[] {
  const all = ctx.db.table('vehicles').findMany({ group_id: groupId });
  const out: { vehicle: Vehicle; rank: number }[] = [];
  for (const vehicle of all) {
    if (q.brand && !brandMatches(vehicle, q.brand)) continue;
    let rank = 2;
    if (q.model) {
      rank = modelMatchRank(vehicle, q.model);
      if (rank === 0) {
        // a model string that carries the trim ('i3 eDrive35L', '宝马X3 xDrive30L') or a trim alias resolves via the trim
        if (!trimMatches(vehicle, q.model)) continue;
        rank = 1;
      }
    }
    if (q.trim && !trimMatches(vehicle, q.trim)) continue;
    out.push({ vehicle, rank });
  }
  out.sort(
    (a, b) =>
      b.rank - a.rank ||
      a.vehicle.brand.localeCompare(b.vehicle.brand) ||
      a.vehicle.model.localeCompare(b.vehicle.model) ||
      b.vehicle.model_year - a.vehicle.model_year ||
      a.vehicle.msrp - b.vehicle.msrp,
  );
  return out;
}

/** Case/width-insensitive catalog search on model / model_zh / aliases and trim / aliases. */
export function findVehicles(ctx: AppContext, groupId: string, q: VehicleQuery): Vehicle[] {
  return rankedVehicles(ctx, groupId, q).map((r) => r.vehicle);
}

/**
 * Best single vehicle for a query: highest match rank, then newest model_year, then lowest MSRP
 * (so a model without trim resolves to its entry trim). Requires a model or trim.
 */
export function resolveVehicle(ctx: AppContext, groupId: string, q: VehicleQuery): Vehicle | null {
  if (!q.model && !q.trim) return null;
  const ranked = rankedVehicles(ctx, groupId, q);
  if (ranked.length === 0) return null;
  const topRank = ranked[0].rank;
  const best = ranked
    .filter((r) => r.rank === topRank)
    .map((r) => r.vehicle)
    .sort((a, b) => b.model_year - a.model_year || a.msrp - b.msrp);
  return best[0] ?? null;
}

const DEFAULT_SELLABLE: InventoryStatus[] = ['in_stock', 'in_transit'];

export function findInventory(ctx: AppContext, dealerId: string, q: InventoryQuery): InventoryMatch[] {
  const dealer = getDealer(ctx, dealerId);
  let vehicles: Vehicle[];
  if (q.vehicle_id) {
    const veh = ctx.db.table('vehicles').get(q.vehicle_id);
    vehicles = veh && veh.group_id === dealer.group_id ? [veh] : [];
  } else if (q.model || q.trim) {
    vehicles = findVehicles(ctx, dealer.group_id, { model: q.model, trim: q.trim });
  } else {
    vehicles = ctx.db.table('vehicles').findMany({ group_id: dealer.group_id });
  }
  if (vehicles.length === 0) return [];
  const byId = new Map(vehicles.map((veh) => [veh.id, veh]));
  const statuses = q.statuses && q.statuses.length > 0 ? q.statuses : DEFAULT_SELLABLE;
  const statusOrder = (s: InventoryStatus) => ['in_stock', 'in_transit', 'reserved', 'sold'].indexOf(s);

  return ctx.db
    .table('inventory')
    .findMany({ dealer_id: dealerId, vehicle_id: [...byId.keys()], status: statuses })
    .filter(
      (row) =>
        row.quantity > 0 &&
        colorMatches(q.exterior_color, row.exterior_color) &&
        colorMatches(q.interior_color, row.interior_color),
    )
    .map((row) => ({ inventory: row, vehicle: byId.get(row.vehicle_id)! }))
    .sort(
      (a, b) =>
        statusOrder(a.inventory.status) - statusOrder(b.inventory.status) ||
        a.vehicle.msrp - b.vehicle.msrp ||
        a.inventory.exterior_color.localeCompare(b.inventory.exterior_color) ||
        a.inventory.id.localeCompare(b.inventory.id),
    );
}

export function isOfferActive(offer: Offer, dealer: Dealer, now: Date): boolean {
  return isValidAt(offer.valid_from, offer.valid_until, now, dealerTz(dealer));
}

export function isKnowledgeActive(row: DealerKnowledge, dealer: Dealer, now: Date): boolean {
  return isValidAt(row.valid_from, row.valid_until, now, dealerTz(dealer));
}

/** Does an offer apply to this vehicle? trim-level → same vehicle; model-level → same model; neither → all. */
export function offerAppliesToVehicle(offer: Offer, vehicle: Vehicle): boolean {
  if (offer.vehicle_id) return offer.vehicle_id === vehicle.id;
  if (offer.model) {
    const m = matchKey(offer.model);
    return m === matchKey(vehicle.model) || m === matchKey(vehicle.model_zh);
  }
  return true;
}

const OFFER_TYPE_ORDER: OfferType[] = ['cash_discount', 'finance', 'lease', 'trade_in', 'gift', 'campaign'];

/** Offers valid at ctx.clock.now() (valid_from ≤ now ≤ end of valid_until local day). */
export function getActiveOffers(ctx: AppContext, dealerId: string, q: OfferQuery = {}): Offer[] {
  const dealer = getDealer(ctx, dealerId);
  const now = ctx.clock.now();
  let offers = ctx.db
    .table('offers')
    .findMany(q.types && q.types.length > 0 ? { dealer_id: dealerId, type: q.types } : { dealer_id: dealerId })
    .filter((o) => isOfferActive(o, dealer, now));

  if (q.vehicle_id) {
    const vehicle = ctx.db.table('vehicles').get(q.vehicle_id);
    offers = vehicle ? offers.filter((o) => offerAppliesToVehicle(o, vehicle)) : offers.filter((o) => !o.vehicle_id && !o.model);
  } else if (q.model) {
    const vehicles = findVehicles(ctx, dealer.group_id, { model: q.model });
    const qKey = matchKey(q.model);
    offers = offers.filter((o) => {
      if (vehicles.length > 0) return vehicles.some((veh) => offerAppliesToVehicle(o, veh));
      if (o.vehicle_id) return false;
      return !o.model || matchKey(o.model) === qKey;
    });
  }

  return offers.sort(
    (a, b) =>
      OFFER_TYPE_ORDER.indexOf(a.type) - OFFER_TYPE_ORDER.indexOf(b.type) ||
      (b.amount ?? 0) - (a.amount ?? 0) ||
      a.valid_until.localeCompare(b.valid_until) ||
      a.id.localeCompare(b.id),
  );
}

/** Group-wide knowledge plus this dealer's rows, valid now. */
export function getKnowledge(ctx: AppContext, dealerId: string, categories?: KnowledgeCategory[]): DealerKnowledge[] {
  const dealer = getDealer(ctx, dealerId);
  const now = ctx.clock.now();
  const where = categories && categories.length > 0 ? { group_id: dealer.group_id, category: categories } : { group_id: dealer.group_id };
  return ctx.db
    .table('dealer_knowledge')
    .findMany(where, { orderBy: 'category ASC, key ASC' })
    .filter((k) => (k.dealer_id === null || k.dealer_id === dealerId) && isKnowledgeActive(k, dealer, now));
}

export function getProhibitedClaims(ctx: AppContext, dealerId: string): ProhibitedClaim[] {
  const out: ProhibitedClaim[] = [];
  const seen = new Set<string>();
  for (const row of getKnowledge(ctx, dealerId, ['prohibited_claim'])) {
    const phrases: string[] = [];
    if (typeof row.data.phrase === 'string') phrases.push(row.data.phrase);
    if (Array.isArray(row.data.phrases)) for (const p of row.data.phrases) if (typeof p === 'string') phrases.push(p);
    if (phrases.length === 0 && row.title) phrases.push(row.title);
    for (const phrase of phrases) {
      const trimmed = phrase.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push({ phrase: trimmed, reason: row.content || row.title, knowledge_id: row.id });
    }
  }
  return out;
}
