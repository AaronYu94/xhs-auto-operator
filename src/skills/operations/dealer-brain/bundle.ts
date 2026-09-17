import type { AppContext } from '../../../app/context.ts';
import { ValidationError } from '../../../core/errors.ts';
import {
  ACCOUNT_STATUSES,
  ACCOUNT_TYPES,
  APPROVAL_POLICIES,
  AUTH_STATES,
  CONTENT_PILLARS,
  INVENTORY_STATUSES,
  KNOWLEDGE_CATEGORIES,
  OFFER_TYPES,
  type AccountPersona,
  type AccountStatus,
  type AccountType,
  type ApprovalPolicy,
  type AuthState,
  type ContentPillar,
  type Dealer,
  type DealerKnowledge,
  type DealerSettings,
  type Inventory,
  type InventoryStatus,
  type KnowledgeCategory,
  type Offer,
  type OfferType,
  type Vehicle,
  type VehicleSpecs,
  type XhsAccount,
} from '../../../core/types.ts';
import { v, type Validator } from '../../../core/validate.ts';
import type { Table } from '../../../db/database.ts';
import {
  DEALER_SETTING_KEYS,
  isValidDateValue,
  matchKey,
  mergeDealerSettings,
  stableId,
  stableStringify,
  validityEndMs,
  validityStartMs,
} from './shared.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Seed types (natural keys)
// ─────────────────────────────────────────────────────────────────────────────

export interface GroupSeed {
  key: string;
  name: string;
}

export interface DealerSeed {
  key: string;
  name: string;
  brands: string[];
  city: string;
  province: string;
  address: string;
  business_hours: string;
  phone: string | null;
  settings?: Partial<DealerSettings>;
}

export interface VehicleSeed {
  key: string;
  brand: string;
  brand_zh: string;
  model: string;
  model_zh: string;
  trim: string;
  model_year: number;
  msrp: number;
  specs: VehicleSpecs;
  highlights: string[];
  aliases: string[];
  source: string;
}

export interface InventorySeed {
  /** dealer key */
  dealer: string;
  /** vehicle key */
  vehicle: string;
  vin: string | null;
  exterior_color: string;
  interior_color: string;
  status: InventoryStatus;
  quantity: number;
  list_price: number | null;
  source: string;
}

export interface OfferSeed {
  key: string;
  /** dealer key */
  dealer: string;
  /** vehicle key for a trim-specific offer */
  vehicle?: string | null;
  /** canonical model for a model-line offer; null + no vehicle = all models */
  model?: string | null;
  type: OfferType;
  title: string;
  description: string;
  amount: number | null;
  apr: number | null;
  term_months: number | null;
  down_payment_pct: number | null;
  conditions: string;
  valid_from: string;
  valid_until: string;
  source: string;
}

export interface KnowledgeSeed {
  /** dealer key; null/absent = group-wide */
  dealer?: string | null;
  category: KnowledgeCategory;
  key: string;
  title: string;
  content: string;
  data: Record<string, unknown>;
  source: string;
  valid_from: string | null;
  valid_until: string | null;
}

export interface PersonaSeed {
  persona_name: string;
  bio: string;
  tone: string;
  voice_rules: string[];
  target_customers: string[];
  focus_brands: string[];
  focus_models: string[];
  content_positioning: string;
  content_mix: Partial<Record<ContentPillar, number>>;
  goals: AccountPersona['goals'];
  signature_phrases: string[];
  taboo_topics: string[];
}

export interface AccountSeed {
  /** dealer key */
  dealer: string;
  platform_account_id: string;
  nickname: string;
  account_type: AccountType;
  status: AccountStatus;
  auth_state: AuthState;
  city: string;
  salesperson_name: string | null;
  outreach_approval_policy: ApprovalPolicy | null;
  daily_outreach_limit: number | null;
  daily_publish_limit: number | null;
  persona: PersonaSeed;
}

export interface DealerBrainBundle {
  group: GroupSeed;
  dealers: DealerSeed[];
  vehicles: VehicleSeed[];
  inventory: InventorySeed[];
  offers: OfferSeed[];
  knowledge: KnowledgeSeed[];
  accounts: AccountSeed[];
}

export interface ImportSummary {
  group_id: string;
  /** dealer key → dealer id */
  dealer_ids: Record<string, string>;
  /** platform_account_id → account id */
  account_ids: Record<string, string>;
  /** vehicle key → vehicle id */
  vehicle_ids: Record<string, string>;
  /**
   * seeds processed per entity, inserted / updated / unchanged row totals, plus `inventory_retired` (stock rows
   * missing from a snapshot set to quantity 0), `account_state_preserved` (accounts whose stricter live
   * status/auth_state was kept) and `personas_preserved` (existing personas not overwritten)
   */
  counts: Record<string, number>;
}

export interface ImportOptions {
  /**
   * 'snapshot' (default): the bundle's inventory is the complete current stock of every dealer listed in the
   * bundle — that dealer's rows missing from it are retired (quantity 0, kept for history) so sold cars are never
   * offered again. 'merge': upsert only.
   */
  inventory_mode?: 'snapshot' | 'merge';
  /**
   * 'seed' (default): personas are created when missing but an existing persona (owned by Account Brain /
   * operators via updatePersona) is never overwritten. 'overwrite': changed persona fields are replaced and
   * audited as 'account.persona_updated'.
   */
  persona_mode?: 'seed' | 'overwrite';
}

const IMPORT_ACTOR = 'system:dealer-brain-import';

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

const text = (min = 1) => v.string({ min });
const dateValue: Validator<string> = (value, path = '') => {
  const s = v.string()(value, path);
  if (!isValidDateValue(s)) throw new ValidationError(path, `invalid date "${s}" (expected a real YYYY-MM-DD day or ISO-8601 timestamp)`);
  return s;
};
const money = v.number({ int: true, min: 0 });
const ratio = v.number({ min: 0, max: 1 });

const timezoneValidator: Validator<string> = (value, path = '') => {
  const tz = v.string({ min: 1 })(value, path);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new ValidationError(path, `unknown timezone "${tz}"`);
  }
  return tz;
};

const settingsShape = v.object({
  outreach_approval_policy: v.optional(v.literal(APPROVAL_POLICIES)),
  publish_approval_policy: v.optional(v.literal(APPROVAL_POLICIES)),
  daily_outreach_limit: v.optional(v.number({ int: true, min: 0 })),
  min_outreach_interval_minutes: v.optional(v.number({ int: true, min: 0 })),
  max_unanswered_touches: v.optional(v.number({ int: true, min: 0 })),
  follow_up_after_days: v.optional(v.number({ min: 0 })),
  daily_publish_limit: v.optional(v.number({ int: true, min: 0 })),
  max_ai_conversation_turns: v.optional(v.number({ int: true, min: 0 })),
  auto_send_min_score: v.optional(v.number({ min: 0, max: 100 })),
  timezone: v.optional(timezoneValidator),
});

/** Partial dealer settings; unknown keys are rejected so a typo never silently falls back to a default limit. */
const settingsValidator: Validator<Partial<DealerSettings>> = (value, path = '') => {
  const parsed = settingsShape(value, path) as Partial<DealerSettings>;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!(DEALER_SETTING_KEYS as string[]).includes(key))
      throw new ValidationError(`${path}.${key}`, `unknown setting (allowed: ${DEALER_SETTING_KEYS.join(', ')})`);
  }
  return parsed;
};

const POWERTRAINS = ['EV', 'PHEV', 'HEV', 'ICE'] as const;

const specsValidator: Validator<VehicleSpecs> = (value, path = '') => {
  const raw = v.record(v.unknown())(value, path);
  const out: VehicleSpecs = {};
  for (const [k, val] of Object.entries(raw)) {
    const p = `${path}.${k}`;
    if (val === undefined) continue;
    if (k === 'powertrain') {
      out.powertrain = v.literal(POWERTRAINS)(val, p);
      continue;
    }
    if (typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean')
      throw new ValidationError(p, 'spec values must be string, number or boolean');
    if (typeof val === 'number' && !Number.isFinite(val)) throw new ValidationError(p, 'spec number must be finite');
    out[k] = val;
  }
  return out;
};

/** Content mix: at least one pillar; keys must be CONTENT_PILLARS, weights 0..1 summing to 1 (±0.01). */
export const contentMixValidator: Validator<Partial<Record<ContentPillar, number>>> = (value, path = '') => {
  const raw = v.record(v.number({ min: 0, max: 1 }))(value, path);
  const out: Partial<Record<ContentPillar, number>> = {};
  let sum = 0;
  for (const [k, weight] of Object.entries(raw)) {
    const pillar = v.literal(CONTENT_PILLARS)(k, `${path}.${k}`);
    out[pillar] = weight;
    sum += weight;
  }
  if (Object.keys(out).length === 0) throw new ValidationError(path, 'must contain at least one pillar');
  if (Math.abs(sum - 1) > 0.01)
    throw new ValidationError(path, `content_mix weights must sum to 1 (got ${Math.round(sum * 1000) / 1000})`);
  return out;
};

const goalsValidator: Validator<AccountPersona['goals']> = v.object({
  monthly_qualified_leads: v.optional(v.number({ int: true, min: 0 })),
  monthly_posts: v.optional(v.number({ int: true, min: 0 })),
  monthly_appointments: v.optional(v.number({ int: true, min: 0 })),
});

const personaValidator: Validator<PersonaSeed> = v.object({
  persona_name: text(),
  bio: v.string(),
  tone: text(),
  voice_rules: v.array(text()),
  target_customers: v.array(text()),
  focus_brands: v.array(text()),
  focus_models: v.array(text()),
  content_positioning: text(),
  content_mix: contentMixValidator,
  goals: goalsValidator,
  signature_phrases: v.array(text()),
  taboo_topics: v.array(text()),
});

const bundleShape = v.object({
  group: v.object({ key: text(), name: text() }),
  dealers: v.array(
    v.object({
      key: text(),
      name: text(),
      brands: v.array(text()),
      city: text(),
      province: text(),
      address: v.string(),
      business_hours: v.string(),
      phone: v.nullable(v.string()),
      settings: v.optional(settingsValidator),
    }),
    { min: 1 },
  ),
  vehicles: v.array(
    v.object({
      key: text(),
      brand: text(),
      brand_zh: text(),
      model: text(),
      model_zh: text(),
      trim: text(),
      model_year: v.number({ int: true, min: 1990, max: 2100 }),
      msrp: money,
      specs: specsValidator,
      highlights: v.array(text()),
      aliases: v.array(text()),
      source: text(),
    }),
  ),
  inventory: v.array(
    v.object({
      dealer: text(),
      vehicle: text(),
      vin: v.nullable(v.string({ pattern: /^[A-Za-z0-9]{8,17}$/ })),
      exterior_color: text(),
      interior_color: text(),
      status: v.literal(INVENTORY_STATUSES),
      quantity: v.number({ int: true, min: 0 }),
      list_price: v.nullable(money),
      source: text(),
    }),
  ),
  offers: v.array(
    v.object({
      key: text(),
      dealer: text(),
      vehicle: v.optional(v.nullable(text())),
      model: v.optional(v.nullable(text())),
      type: v.literal(OFFER_TYPES),
      title: text(),
      description: v.string(),
      amount: v.nullable(money),
      apr: v.nullable(ratio),
      term_months: v.nullable(v.number({ int: true, min: 1, max: 120 })),
      down_payment_pct: v.nullable(ratio),
      conditions: v.string(),
      valid_from: dateValue,
      valid_until: dateValue,
      source: text(),
    }),
  ),
  knowledge: v.array(
    v.object({
      dealer: v.optional(v.nullable(text())),
      category: v.literal(KNOWLEDGE_CATEGORIES),
      key: text(),
      title: text(),
      content: v.string(),
      data: v.record(v.unknown()),
      source: text(),
      valid_from: v.nullable(dateValue),
      valid_until: v.nullable(dateValue),
    }),
  ),
  accounts: v.array(
    v.object({
      dealer: text(),
      platform_account_id: text(),
      nickname: text(),
      account_type: v.literal(ACCOUNT_TYPES),
      status: v.literal(ACCOUNT_STATUSES),
      auth_state: v.literal(AUTH_STATES),
      city: text(),
      salesperson_name: v.nullable(text()),
      outreach_approval_policy: v.nullable(v.literal(APPROVAL_POLICIES)),
      daily_outreach_limit: v.nullable(v.number({ int: true, min: 0 })),
      daily_publish_limit: v.nullable(v.number({ int: true, min: 0 })),
      persona: personaValidator,
    }),
  ),
});

function assertUnique(values: string[], path: (i: number) => string, label: string): void {
  const seen = new Map<string, number>();
  values.forEach((val, i) => {
    const prev = seen.get(val);
    if (prev !== undefined) throw new ValidationError(path(i), `duplicate ${label} "${val}" (also at index ${prev})`);
    seen.set(val, i);
  });
}

/**
 * Validates shape, enum values, uniqueness of natural keys and every cross-reference
 * (inventory/offer/knowledge/account → dealer key, inventory/offer → vehicle key).
 */
export function parseDealerBrainBundle(value: unknown): DealerBrainBundle {
  const b = bundleShape(value, '') as DealerBrainBundle;
  // A VIN identifies one car regardless of spelling: store it upper-case so re-imports never duplicate it.
  b.inventory = b.inventory.map((row) => (row.vin ? { ...row, vin: row.vin.toUpperCase() } : row));

  assertUnique(b.dealers.map((d) => d.key), (i) => `dealers[${i}].key`, 'dealer key');
  assertUnique(b.vehicles.map((x) => x.key), (i) => `vehicles[${i}].key`, 'vehicle key');
  assertUnique(
    b.vehicles.map((x) => `${x.brand}|${x.model}|${x.trim}|${x.model_year}`),
    (i) => `vehicles[${i}]`,
    'vehicle (brand, model, trim, model_year)',
  );
  assertUnique(b.offers.map((o) => `${o.dealer}|${o.key}`), (i) => `offers[${i}].key`, 'offer key');
  assertUnique(b.knowledge.map((k) => `${k.dealer ?? '*'}|${k.key}`), (i) => `knowledge[${i}].key`, 'knowledge key');
  assertUnique(b.accounts.map((a) => a.platform_account_id), (i) => `accounts[${i}].platform_account_id`, 'platform_account_id');
  assertUnique(
    b.inventory.map(inventoryNaturalKey),
    (i) => `inventory[${i}]`,
    'inventory row (dealer, vin | vehicle+colours+status)',
  );

  const dealerKeys = new Map(b.dealers.map((d) => [d.key, d]));
  const vehicleSeeds = new Map(b.vehicles.map((x) => [x.key, x]));
  const vehicleKeys = new Set(vehicleSeeds.keys());
  const tzOf = (dealerKey: string) => mergeDealerSettings(dealerKeys.get(dealerKey)?.settings).timezone;

  b.inventory.forEach((row, i) => {
    if (!dealerKeys.has(row.dealer)) throw new ValidationError(`inventory[${i}].dealer`, `unknown dealer key "${row.dealer}"`);
    if (!vehicleKeys.has(row.vehicle))
      throw new ValidationError(`inventory[${i}].vehicle`, `unknown vehicle key "${row.vehicle}"`);
    if (row.vin && row.quantity > 1)
      throw new ValidationError(`inventory[${i}].quantity`, 'a row with a VIN identifies one vehicle (quantity must be 0 or 1)');
  });
  b.offers.forEach((o, i) => {
    if (!dealerKeys.has(o.dealer)) throw new ValidationError(`offers[${i}].dealer`, `unknown dealer key "${o.dealer}"`);
    if (o.vehicle && !vehicleKeys.has(o.vehicle))
      throw new ValidationError(`offers[${i}].vehicle`, `unknown vehicle key "${o.vehicle}"`);
    if (o.vehicle && o.model) {
      const veh = vehicleSeeds.get(o.vehicle)!;
      if (![veh.model, veh.model_zh].some((m) => matchKey(m) === matchKey(o.model)))
        throw new ValidationError(`offers[${i}].model`, `does not match vehicle "${o.vehicle}" (model ${veh.model})`);
    }
    const tz = tzOf(o.dealer);
    if (validityStartMs(o.valid_from, tz) > validityEndMs(o.valid_until, tz))
      throw new ValidationError(`offers[${i}].valid_until`, 'valid_until is before valid_from');
    if ((o.type === 'cash_discount' || o.type === 'trade_in') && o.amount === null)
      throw new ValidationError(`offers[${i}].amount`, `${o.type} offers require an amount`);
    if ((o.type === 'finance' || o.type === 'lease') && o.term_months === null)
      throw new ValidationError(`offers[${i}].term_months`, `${o.type} offers require term_months`);
  });
  b.knowledge.forEach((k, i) => {
    if (k.dealer && !dealerKeys.has(k.dealer))
      throw new ValidationError(`knowledge[${i}].dealer`, `unknown dealer key "${k.dealer}"`);
    if (k.category === 'prohibited_claim') {
      const phrase = k.data.phrase;
      if (typeof phrase !== 'string' || phrase.trim() === '')
        throw new ValidationError(`knowledge[${i}].data.phrase`, 'prohibited_claim rows require data.phrase');
    }
    if (k.valid_from && k.valid_until) {
      const tz = k.dealer ? tzOf(k.dealer) : mergeDealerSettings(undefined).timezone;
      if (validityStartMs(k.valid_from, tz) > validityEndMs(k.valid_until, tz))
        throw new ValidationError(`knowledge[${i}].valid_until`, 'valid_until is before valid_from');
    }
  });
  b.accounts.forEach((a, i) => {
    if (!dealerKeys.has(a.dealer)) throw new ValidationError(`accounts[${i}].dealer`, `unknown dealer key "${a.dealer}"`);
    if (a.account_type === 'salesperson' && !a.salesperson_name)
      throw new ValidationError(`accounts[${i}].salesperson_name`, 'salesperson accounts require salesperson_name');
  });
  return b;
}

function inventoryNaturalKey(row: InventorySeed): string {
  return row.vin
    ? `vin:${row.vin.toUpperCase()}`
    : `${row.dealer}|${row.vehicle}|${row.exterior_color}|${row.interior_color}|${row.status}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Import (idempotent upsert)
// ─────────────────────────────────────────────────────────────────────────────

interface UpsertStats {
  inserted: number;
  updated: number;
  unchanged: number;
}

const SKIP_COMPARE = new Set(['id', 'created_at', 'updated_at']);

function upsertRow<T extends { id: string }>(table: Table<T>, desired: T, existing: T | undefined, stats: UpsertStats): T {
  if (!existing) {
    stats.inserted++;
    return table.insert(desired);
  }
  const patch: Record<string, unknown> = {};
  const src = desired as unknown as Record<string, unknown>;
  const cur = existing as unknown as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    if (SKIP_COMPARE.has(key)) continue;
    if (stableStringify(cur[key] ?? null) !== stableStringify(src[key] ?? null)) patch[key] = src[key];
  }
  if (Object.keys(patch).length === 0) {
    stats.unchanged++;
    return existing;
  }
  stats.updated++;
  const nullCols = Object.keys(patch).filter((k) => patch[k] === null) as (keyof T & string)[];
  const nonNull = Object.fromEntries(Object.entries(patch).filter(([, val]) => val !== null)) as Partial<T>;
  let row = table.update(existing.id, nonNull);
  if (nullCols.length > 0) row = table.setNull(existing.id, nullCols);
  return row;
}

/** Changed fields of `desired` relative to `existing` (JSON-aware, ignoring id / timestamps). */
function diffFields<T extends object>(desired: T, existing: T): string[] {
  const src = desired as unknown as Record<string, unknown>;
  const cur = existing as unknown as Record<string, unknown>;
  return Object.keys(src).filter((key) => !SKIP_COMPARE.has(key) && stableStringify(cur[key] ?? null) !== stableStringify(src[key] ?? null));
}

const STATUS_STRICTNESS: Record<AccountStatus, number> = { active: 0, paused: 1, cooldown: 1, disabled: 2 };
const AUTH_STRICTNESS: Record<AuthState, number> = { authenticated: 0, unknown: 1, requires_auth: 2 };

/**
 * Import a Dealer Brain bundle. Idempotent: ids are derived from natural keys and every row is
 * upserted (insert when missing, update only changed fields) in ONE transaction. Rows that already exist
 * under a different id but the same natural unique key (vehicle model/trim/year, knowledge key, VIN,
 * platform_account_id, persona per account) are adopted rather than duplicated.
 *
 * Operational safety on re-import: inventory is a snapshot per listed dealer (missing rows retired) unless
 * `inventory_mode: 'merge'`; an account's live `status` / `auth_state` is never loosened by a bundle (a disabled
 * account is not re-enabled, a lost authorization is not reset) while stricter bundle values are applied and
 * audited; existing personas are kept unless `persona_mode: 'overwrite'`.
 */
export function importDealerBrain(ctx: AppContext, input: DealerBrainBundle, opts: ImportOptions = {}): ImportSummary {
  const bundle = parseDealerBrainBundle(input);
  const inventoryMode = opts.inventory_mode ?? 'snapshot';
  const personaMode = opts.persona_mode ?? 'seed';
  const gk = bundle.group.key;
  const now = ctx.clock.iso();
  const stats: UpsertStats = { inserted: 0, updated: 0, unchanged: 0 };
  let inventoryRetired = 0;
  let accountStatePreserved = 0;
  let personasPreserved = 0;
  const db = ctx.db;

  const summary = db.tx((): ImportSummary => {
    // group
    const groupId = stableId('grp', gk, 'group');
    const groups = db.table('dealer_groups');
    upsertRow(groups, { id: groupId, name: bundle.group.name, created_at: now }, groups.get(groupId), stats);

    // dealers
    const dealers = db.table('dealers');
    const dealerIds: Record<string, string> = {};
    const dealerTzs: Record<string, string> = {};
    for (const seed of bundle.dealers) {
      const id = stableId('dlr', gk, `dealer:${seed.key}`);
      const desired: Dealer = {
        id,
        group_id: groupId,
        name: seed.name,
        brands: seed.brands,
        city: seed.city,
        province: seed.province,
        address: seed.address,
        business_hours: seed.business_hours,
        phone: seed.phone,
        settings: mergeDealerSettings(seed.settings),
        created_at: now,
        updated_at: now,
      };
      const row = upsertRow(dealers, desired, dealers.get(id), stats);
      dealerIds[seed.key] = row.id;
      dealerTzs[seed.key] = row.settings.timezone;
    }

    // vehicles
    const vehicles = db.table('vehicles');
    const vehicleIds: Record<string, string> = {};
    for (const seed of bundle.vehicles) {
      const id = stableId('veh', gk, `vehicle:${seed.key}`);
      const existing =
        vehicles.get(id) ??
        vehicles.findOne({
          group_id: groupId,
          brand: seed.brand,
          model: seed.model,
          trim: seed.trim,
          model_year: seed.model_year,
        });
      const desired: Vehicle = {
        id,
        group_id: groupId,
        brand: seed.brand,
        brand_zh: seed.brand_zh,
        model: seed.model,
        model_zh: seed.model_zh,
        trim: seed.trim,
        model_year: seed.model_year,
        msrp: seed.msrp,
        specs: seed.specs,
        highlights: seed.highlights,
        aliases: seed.aliases,
        source: seed.source,
        updated_at: now,
      };
      vehicleIds[seed.key] = upsertRow(vehicles, desired, existing, stats).id;
    }

    // inventory
    const inventory = db.table('inventory');
    const seenInventory = new Set<string>();
    for (const seed of bundle.inventory) {
      const dealerId = dealerIds[seed.dealer];
      const id = stableId('inv', gk, `inventory:${seed.dealer}:${inventoryNaturalKey(seed)}`);
      const existing = inventory.get(id) ?? (seed.vin ? inventory.findOne({ vin: seed.vin }) : undefined);
      if (existing && existing.dealer_id !== dealerId) {
        const owner = dealers.get(existing.dealer_id);
        if (owner && owner.group_id !== groupId)
          throw new ValidationError('inventory', `VIN ${seed.vin} is registered to a dealer of another group`);
      }
      const desired: Inventory = {
        id,
        dealer_id: dealerId,
        vehicle_id: vehicleIds[seed.vehicle],
        vin: seed.vin,
        exterior_color: seed.exterior_color,
        interior_color: seed.interior_color,
        status: seed.status,
        quantity: seed.quantity,
        list_price: seed.list_price,
        source: seed.source,
        updated_at: now,
      };
      seenInventory.add(upsertRow(inventory, desired, existing, stats).id);
    }
    if (inventoryMode === 'snapshot') {
      for (const dealerId of Object.values(dealerIds)) {
        for (const row of inventory.findMany({ dealer_id: dealerId })) {
          if (seenInventory.has(row.id) || row.quantity === 0) continue;
          inventory.update(row.id, { quantity: 0 });
          stats.updated++;
          inventoryRetired++;
        }
      }
    }

    // offers — a model-line offer must name a model that exists in the group catalog (else it applies to nothing)
    const catalogModels = new Set(
      vehicles.findMany({ group_id: groupId }).flatMap((veh) => [matchKey(veh.model), matchKey(veh.model_zh)]),
    );
    bundle.offers.forEach((seed, i) => {
      if (!seed.vehicle && seed.model && !catalogModels.has(matchKey(seed.model)))
        throw new ValidationError(`offers[${i}].model`, `no vehicle in the catalog matches model "${seed.model}"`);
    });
    const offers = db.table('offers');
    for (const seed of bundle.offers) {
      const id = stableId('ofr', gk, `offer:${seed.dealer}:${seed.key}`);
      const desired: Offer = {
        id,
        dealer_id: dealerIds[seed.dealer],
        vehicle_id: seed.vehicle ? vehicleIds[seed.vehicle] : null,
        model: seed.model ?? null,
        type: seed.type,
        title: seed.title,
        description: seed.description,
        amount: seed.amount,
        apr: seed.apr,
        term_months: seed.term_months,
        down_payment_pct: seed.down_payment_pct,
        conditions: seed.conditions,
        valid_from: seed.valid_from,
        valid_until: seed.valid_until,
        source: seed.source,
        updated_at: now,
      };
      upsertRow(offers, desired, offers.get(id), stats);
    }

    // knowledge
    const knowledge = db.table('dealer_knowledge');
    for (const seed of bundle.knowledge) {
      const dealerId = seed.dealer ? dealerIds[seed.dealer] : null;
      const id = stableId('kn', gk, `knowledge:${seed.dealer ?? '*'}:${seed.key}`);
      const existing =
        knowledge.get(id) ?? knowledge.findOne({ group_id: groupId, dealer_id: dealerId, key: seed.key });
      const desired: DealerKnowledge = {
        id,
        group_id: groupId,
        dealer_id: dealerId,
        category: seed.category,
        key: seed.key,
        title: seed.title,
        content: seed.content,
        data: seed.data,
        source: seed.source,
        valid_from: seed.valid_from,
        valid_until: seed.valid_until,
        updated_at: now,
      };
      upsertRow(knowledge, desired, existing, stats);
    }

    // accounts + personas
    const accounts = db.table('xhs_accounts');
    const personas = db.table('account_personas');
    const accountIds: Record<string, string> = {};
    for (const seed of bundle.accounts) {
      const id = stableId('acc', gk, `account:${seed.platform_account_id}`);
      const existing = accounts.get(id) ?? accounts.findOne({ platform_account_id: seed.platform_account_id });
      if (existing && existing.group_id !== groupId)
        throw new ValidationError(
          'accounts',
          `platform_account_id "${seed.platform_account_id}" is already registered to another dealer group`,
        );
      // live operational state is only ever tightened by a bundle, never loosened
      let status = seed.status;
      let authState = seed.auth_state;
      if (existing) {
        if (STATUS_STRICTNESS[seed.status] < STATUS_STRICTNESS[existing.status]) status = existing.status;
        if (AUTH_STRICTNESS[seed.auth_state] < AUTH_STRICTNESS[existing.auth_state]) authState = existing.auth_state;
        if (status !== seed.status || authState !== seed.auth_state) accountStatePreserved++;
      }
      const desired: XhsAccount = {
        id,
        group_id: groupId,
        dealer_id: dealerIds[seed.dealer],
        platform_account_id: seed.platform_account_id,
        nickname: seed.nickname,
        account_type: seed.account_type,
        status,
        auth_state: authState,
        city: seed.city,
        salesperson_name: seed.salesperson_name,
        outreach_approval_policy: seed.outreach_approval_policy,
        daily_outreach_limit: seed.daily_outreach_limit,
        daily_publish_limit: seed.daily_publish_limit,
        created_at: now,
        updated_at: now,
      };
      const account = upsertRow(accounts, desired, existing, stats);
      accountIds[seed.platform_account_id] = account.id;
      if (existing && (existing.status !== account.status || existing.auth_state !== account.auth_state)) {
        const details: Record<string, unknown> = { platform_account_id: seed.platform_account_id, source: 'dealer_brain_import' };
        if (existing.status !== account.status) details.status = { from: existing.status, to: account.status };
        if (existing.auth_state !== account.auth_state) details.auth_state = { from: existing.auth_state, to: account.auth_state };
        ctx.audit.event({ actor: IMPORT_ACTOR, action: 'account.state_changed', entity_type: 'xhs_account', entity_id: account.id, details });
      }

      const personaId = stableId('per', gk, `persona:${seed.platform_account_id}`);
      const p = seed.persona;
      const persona: AccountPersona = {
        id: personaId,
        account_id: account.id,
        persona_name: p.persona_name,
        bio: p.bio,
        tone: p.tone,
        voice_rules: p.voice_rules,
        target_customers: p.target_customers,
        focus_brands: p.focus_brands,
        focus_models: p.focus_models,
        content_positioning: p.content_positioning,
        content_mix: p.content_mix,
        goals: p.goals,
        signature_phrases: p.signature_phrases,
        taboo_topics: p.taboo_topics,
        updated_at: now,
      };
      const existingPersona = personas.findOne({ account_id: account.id });
      const changed = existingPersona ? diffFields(persona, existingPersona).filter((k) => k !== 'account_id') : [];
      if (!existingPersona || changed.length === 0) {
        upsertRow(personas, persona, existingPersona, stats);
      } else if (personaMode === 'seed') {
        stats.unchanged++;
        personasPreserved++;
      } else {
        const before = existingPersona as unknown as Record<string, unknown>;
        const after = persona as unknown as Record<string, unknown>;
        upsertRow(personas, persona, existingPersona, stats);
        ctx.audit.event({
          actor: IMPORT_ACTOR,
          action: 'account.persona_updated',
          entity_type: 'xhs_account',
          entity_id: account.id,
          details: {
            persona_id: existingPersona.id,
            changed_fields: changed,
            changes: Object.fromEntries(changed.map((k) => [k, { before: before[k], after: after[k] }])),
          },
        });
      }
    }

    const result: ImportSummary = {
      group_id: groupId,
      dealer_ids: dealerIds,
      account_ids: accountIds,
      vehicle_ids: vehicleIds,
      counts: {
        dealers: bundle.dealers.length,
        vehicles: bundle.vehicles.length,
        inventory: bundle.inventory.length,
        offers: bundle.offers.length,
        knowledge: bundle.knowledge.length,
        accounts: bundle.accounts.length,
        personas: bundle.accounts.length,
        inserted: stats.inserted,
        updated: stats.updated,
        unchanged: stats.unchanged,
        inventory_retired: inventoryRetired,
        account_state_preserved: accountStatePreserved,
        personas_preserved: personasPreserved,
      },
    };
    ctx.audit.event({
      actor: IMPORT_ACTOR,
      action: 'dealer_brain.imported',
      entity_type: 'dealer_group',
      entity_id: groupId,
      details: {
        group_key: gk,
        counts: result.counts,
        dealer_ids: dealerIds,
        inventory_mode: inventoryMode,
        persona_mode: personaMode,
      },
    });
    return result;
  });

  return summary;
}
