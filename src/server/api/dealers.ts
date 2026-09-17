/**
 * Dealer Brain administration: dealers, bundle import (with dry run) and export, inventory and offer maintenance,
 * vehicles and knowledge. Structured rows are the only source of dealer facts; every edit is validated and audited.
 */
import type { AppContext } from '../../app/context.ts';
import { ValidationError } from '../../core/errors.ts';
import { newId } from '../../core/ids.ts';
import { INVENTORY_STATUSES, OFFER_TYPES, type Inventory, type Offer } from '../../core/types.ts';
import { v } from '../../core/validate.ts';
import { listFleet } from '../../skills/operations/account-brain/index.ts';
import {
  getDealer,
  importDealerBrain,
  isOfferActive,
  isValidDateValue,
  listDealers,
  parseDealerBrainBundle,
  type DealerBrainBundle,
} from '../../skills/operations/dealer-brain/index.ts';
import { queryString, type Router } from '../http.ts';
import type { ServerRuntime } from '../runtime.ts';
import { json, readBody, requireDealer, requireRow } from './common.ts';

/**
 * Snapshot of a dealer group as a Dealer Brain bundle. Natural keys are not stored in the database, so the export
 * uses row ids as keys: it is a backup / migration artefact for a fresh instance. To update a live dealer, re-import
 * the original bundle file that carries your natural keys.
 */
export function exportDealerBrainBundle(ctx: AppContext, groupId: string): DealerBrainBundle {
  const group = requireRow(ctx.db.table('dealer_groups').get(groupId), 'dealer_group', groupId);
  const dealers = ctx.db.table('dealers').findMany({ group_id: groupId }, { orderBy: 'created_at ASC, id ASC' });
  const dealerIds = new Set(dealers.map((d) => d.id));
  const vehicles = ctx.db.table('vehicles').findMany({ group_id: groupId }, { orderBy: 'brand ASC, model ASC, trim ASC' });
  const vehicleIds = new Set(vehicles.map((x) => x.id));
  const inventory = ctx.db.table('inventory').findMany({ dealer_id: [...dealerIds] }, { orderBy: 'dealer_id ASC, vehicle_id ASC, id ASC' });
  const offers = ctx.db.table('offers').findMany({ dealer_id: [...dealerIds] }, { orderBy: 'dealer_id ASC, valid_from ASC, id ASC' });
  const knowledge = ctx.db.table('dealer_knowledge').findMany({ group_id: groupId }, { orderBy: 'category ASC, key ASC' });
  const fleet = listFleet(ctx, { group_id: groupId });
  return {
    group: { key: group.id, name: group.name },
    dealers: dealers.map((d) => ({
      key: d.id,
      name: d.name,
      brands: d.brands,
      city: d.city,
      province: d.province,
      address: d.address,
      business_hours: d.business_hours,
      phone: d.phone,
      settings: d.settings,
    })),
    vehicles: vehicles.map((x) => ({
      key: x.id,
      brand: x.brand,
      brand_zh: x.brand_zh,
      model: x.model,
      model_zh: x.model_zh,
      trim: x.trim,
      model_year: x.model_year,
      msrp: x.msrp,
      specs: x.specs,
      highlights: x.highlights,
      aliases: x.aliases,
      source: x.source,
    })),
    inventory: inventory
      .filter((r) => vehicleIds.has(r.vehicle_id))
      .map((r) => ({
        dealer: r.dealer_id,
        vehicle: r.vehicle_id,
        vin: r.vin,
        exterior_color: r.exterior_color,
        interior_color: r.interior_color,
        status: r.status,
        quantity: r.quantity,
        list_price: r.list_price,
        source: r.source,
      })),
    offers: offers.map((o) => ({
      key: o.id,
      dealer: o.dealer_id,
      vehicle: o.vehicle_id,
      model: o.model,
      type: o.type,
      title: o.title,
      description: o.description,
      amount: o.amount,
      apr: o.apr,
      term_months: o.term_months,
      down_payment_pct: o.down_payment_pct,
      conditions: o.conditions,
      valid_from: o.valid_from,
      valid_until: o.valid_until,
      source: o.source,
    })),
    knowledge: knowledge.map((k) => ({
      dealer: k.dealer_id,
      category: k.category,
      key: k.key,
      title: k.title,
      content: k.content,
      data: k.data,
      source: k.source,
      valid_from: k.valid_from,
      valid_until: k.valid_until,
    })),
    accounts: fleet
      .filter((b) => dealerIds.has(b.account.dealer_id) && b.account.platform_account_id)
      .map((b) => ({
        dealer: b.account.dealer_id,
        platform_account_id: b.account.platform_account_id as string,
        nickname: b.account.nickname,
        account_type: b.account.account_type,
        status: b.account.status,
        auth_state: b.account.auth_state,
        city: b.account.city,
        salesperson_name: b.account.salesperson_name,
        outreach_approval_policy: b.account.outreach_approval_policy,
        daily_outreach_limit: b.account.daily_outreach_limit,
        daily_publish_limit: b.account.daily_publish_limit,
        persona: {
          persona_name: b.persona.persona_name,
          bio: b.persona.bio,
          tone: b.persona.tone,
          voice_rules: b.persona.voice_rules,
          target_customers: b.persona.target_customers,
          focus_brands: b.persona.focus_brands,
          focus_models: b.persona.focus_models,
          content_positioning: b.persona.content_positioning,
          content_mix: b.persona.content_mix,
          goals: b.persona.goals,
          signature_phrases: b.persona.signature_phrases,
          taboo_topics: b.persona.taboo_topics,
        },
      })),
  };
}

const importBody = v.object({
  bundle: v.unknown(),
  dry_run: v.optional(v.boolean()),
  inventory_mode: v.optional(v.literal(['snapshot', 'merge'] as const)),
  persona_mode: v.optional(v.literal(['seed', 'overwrite'] as const)),
});

const inventoryPatch = v.object({
  status: v.optional(v.literal(INVENTORY_STATUSES)),
  quantity: v.optional(v.number({ int: true, min: 0, max: 10_000 })),
  list_price: v.optional(v.nullable(v.number({ int: true, min: 0, max: 100_000_000 }))),
});

const dateText = (path: string) => (value: unknown, p = path): string => {
  const s = v.string({ min: 10, max: 30 })(value, p);
  if (!isValidDateValue(s)) throw new ValidationError(p, `invalid date ${JSON.stringify(s)} (YYYY-MM-DD or ISO)`);
  return s;
};

const offerFields = {
  vehicle_id: v.optional(v.nullable(v.string({ min: 1, max: 80 }))),
  model: v.optional(v.nullable(v.string({ min: 1, max: 60 }))),
  type: v.literal(OFFER_TYPES),
  title: v.string({ min: 1, max: 80 }),
  description: v.withDefault(v.string({ max: 500 }), ''),
  amount: v.withDefault(v.nullable(v.number({ int: true, min: 0, max: 10_000_000 })), null),
  apr: v.withDefault(v.nullable(v.number({ min: 0, max: 1 })), null),
  term_months: v.withDefault(v.nullable(v.number({ int: true, min: 1, max: 120 })), null),
  down_payment_pct: v.withDefault(v.nullable(v.number({ min: 0, max: 1 })), null),
  conditions: v.withDefault(v.string({ max: 500 }), ''),
  valid_from: dateText('valid_from'),
  valid_until: dateText('valid_until'),
  source: v.optional(v.string({ min: 1, max: 200 })),
};
const offerCreate = v.object(offerFields);

function checkOffer(ctx: AppContext, dealerId: string, o: Pick<Offer, 'vehicle_id' | 'valid_from' | 'valid_until'>): void {
  if (o.valid_until.slice(0, 10) < o.valid_from.slice(0, 10)) throw new ValidationError('valid_until', 'must not be before valid_from');
  if (o.vehicle_id) {
    const dealer = getDealer(ctx, dealerId);
    const vehicle = ctx.db.table('vehicles').get(o.vehicle_id);
    if (!vehicle || vehicle.group_id !== dealer.group_id) throw new ValidationError('vehicle_id', 'unknown vehicle for this dealer group');
  }
}

export function registerDealerRoutes(router: Router, runtime: ServerRuntime): void {
  const { ctx } = runtime;

  router.get('/api/dealers', () => {
    const groups = new Map(ctx.db.table('dealer_groups').findMany().map((g) => [g.id, g.name]));
    return json({ dealers: listDealers(ctx).map((d) => ({ ...d, group_name: groups.get(d.group_id) ?? null })) });
  });

  router.get('/api/dealers/:id', (rc) => {
    const dealer = getDealer(ctx, rc.params.id);
    const now = ctx.clock.now();
    const offers = ctx.db.table('offers').findMany({ dealer_id: dealer.id });
    return json({
      dealer,
      counts: {
        vehicles: ctx.db.table('vehicles').count({ group_id: dealer.group_id }),
        inventory_rows: ctx.db.table('inventory').count({ dealer_id: dealer.id }),
        offers: offers.length,
        active_offers: offers.filter((o) => isOfferActive(o, dealer, now)).length,
        knowledge: ctx.db.table('dealer_knowledge').count({ group_id: dealer.group_id }),
        accounts: ctx.db.table('xhs_accounts').count({ dealer_id: dealer.id }),
      },
    });
  });

  router.post('/api/dealer-brain/import', async (rc) => {
    const input = await readBody(rc, importBody);
    const bundle = parseDealerBrainBundle(input.bundle);
    const counts = {
      dealers: bundle.dealers.length,
      vehicles: bundle.vehicles.length,
      inventory: bundle.inventory.length,
      offers: bundle.offers.length,
      knowledge: bundle.knowledge.length,
      accounts: bundle.accounts.length,
    };
    if (input.dry_run) return json({ valid: true, dry_run: true, group: bundle.group, counts });
    const summary = importDealerBrain(ctx, bundle, { inventory_mode: input.inventory_mode, persona_mode: input.persona_mode });
    const scheduleWarnings: string[] = [];
    for (const dealerId of Object.values(summary.dealer_ids)) {
      try {
        runtime.scheduler.ensureSchedules(ctx, dealerId);
      } catch (err) {
        scheduleWarnings.push(`${dealerId}: ${(err as Error).message}`);
      }
    }
    ctx.audit.event({
      actor: rc.actor,
      action: 'dealer_brain.imported_via_console',
      entity_type: 'dealer_group',
      entity_id: summary.group_id,
      details: { group_key: bundle.group.key, counts: summary.counts, inventory_mode: input.inventory_mode ?? 'snapshot' },
    });
    return json({ valid: true, dry_run: false, summary, schedule_warnings: scheduleWarnings });
  });

  router.get('/api/dealer-brain/export', (rc) => {
    const dealerId = queryString(rc.query, 'dealer_id');
    const groupId = queryString(rc.query, 'group_id') ?? (dealerId ? getDealer(ctx, dealerId).group_id : undefined);
    if (!groupId) throw new ValidationError('group_id', 'group_id or dealer_id is required');
    const bundle = exportDealerBrainBundle(ctx, groupId);
    return {
      json: bundle,
      headers: { 'content-disposition': `attachment; filename="dealer-brain-${groupId}.json"` },
    };
  });

  router.get('/api/dealers/:id/vehicles', (rc) => {
    const dealer = getDealer(ctx, rc.params.id);
    return json({ vehicles: ctx.db.table('vehicles').findMany({ group_id: dealer.group_id }, { orderBy: 'brand ASC, model ASC, msrp ASC' }) });
  });

  router.get('/api/dealers/:id/inventory', (rc) => {
    const dealer = getDealer(ctx, rc.params.id);
    const vehicles = new Map(ctx.db.table('vehicles').findMany({ group_id: dealer.group_id }).map((x) => [x.id, x]));
    const rows = ctx.db.table('inventory').findMany({ dealer_id: dealer.id }, { orderBy: 'status ASC, vehicle_id ASC' });
    return json({ inventory: rows.map((r) => ({ ...r, vehicle: vehicles.get(r.vehicle_id) ?? null })) });
  });

  router.patch('/api/inventory/:id', async (rc) => {
    const row = requireRow(ctx.db.table('inventory').get(rc.params.id), 'inventory', rc.params.id);
    const patch = await readBody(rc, inventoryPatch);
    if (Object.keys(patch).length === 0) throw new ValidationError('body', 'nothing to update (status, quantity, list_price)');
    const updated = ctx.db.tx(() => {
      const next = ctx.db.table('inventory').update(row.id, { ...patch, source: `console:${rc.operator}` } as Partial<Inventory>);
      ctx.audit.event({
        actor: rc.actor,
        action: 'inventory.updated',
        entity_type: 'inventory',
        entity_id: row.id,
        details: { before: { status: row.status, quantity: row.quantity, list_price: row.list_price }, after: patch },
      });
      return next;
    });
    return json({ inventory: updated });
  });

  router.get('/api/dealers/:id/offers', (rc) => {
    const dealer = getDealer(ctx, rc.params.id);
    const now = ctx.clock.now();
    const offers = ctx.db.table('offers').findMany({ dealer_id: dealer.id }, { orderBy: 'valid_until DESC, title ASC' });
    return json({ offers: offers.map((o) => ({ ...o, active: isOfferActive(o, dealer, now) })) });
  });

  router.post('/api/dealers/:id/offers', async (rc) => {
    const dealerId = requireDealer(ctx, rc.params.id);
    const input = await readBody(rc, offerCreate);
    const offer: Offer = {
      id: newId('ofr'),
      dealer_id: dealerId,
      vehicle_id: input.vehicle_id ?? null,
      model: input.model ?? null,
      type: input.type,
      title: input.title,
      description: input.description,
      amount: input.amount,
      apr: input.apr,
      term_months: input.term_months,
      down_payment_pct: input.down_payment_pct,
      conditions: input.conditions,
      valid_from: input.valid_from,
      valid_until: input.valid_until,
      source: input.source ?? `console:${rc.operator}`,
      updated_at: ctx.clock.iso(),
    };
    checkOffer(ctx, dealerId, offer);
    const created = ctx.db.tx(() => {
      const row = ctx.db.table('offers').insert(offer);
      ctx.audit.event({ actor: rc.actor, action: 'offer.created', entity_type: 'offer', entity_id: row.id, details: { title: row.title, type: row.type } });
      return row;
    });
    return json({ offer: created }, 201);
  });

  router.patch('/api/offers/:id', async (rc) => {
    const current = requireRow(ctx.db.table('offers').get(rc.params.id), 'offer', rc.params.id);
    const raw = await rc.json();
    const merged = offerCreate({ ...current, ...(typeof raw === 'object' && raw !== null ? raw : {}) }, 'body');
    const next: Partial<Offer> = {
      vehicle_id: merged.vehicle_id ?? null,
      model: merged.model ?? null,
      type: merged.type,
      title: merged.title,
      description: merged.description,
      amount: merged.amount,
      apr: merged.apr,
      term_months: merged.term_months,
      down_payment_pct: merged.down_payment_pct,
      conditions: merged.conditions,
      valid_from: merged.valid_from,
      valid_until: merged.valid_until,
      source: `console:${rc.operator}`,
    };
    checkOffer(ctx, current.dealer_id, { vehicle_id: next.vehicle_id ?? null, valid_from: merged.valid_from, valid_until: merged.valid_until });
    const updated = ctx.db.tx(() => {
      const nullCols = (['vehicle_id', 'model', 'amount', 'apr', 'term_months', 'down_payment_pct'] as const).filter((k) => next[k] === null);
      const row = ctx.db.table('offers').update(current.id, next);
      const out = nullCols.length > 0 ? ctx.db.table('offers').setNull(current.id, [...nullCols]) : row;
      ctx.audit.event({ actor: rc.actor, action: 'offer.updated', entity_type: 'offer', entity_id: current.id, details: { before: current, after: next } });
      return out;
    });
    return json({ offer: updated });
  });

  router.get('/api/dealers/:id/knowledge', (rc) => {
    const dealer = getDealer(ctx, rc.params.id);
    const rows = ctx.db
      .table('dealer_knowledge')
      .query('group_id = ? AND (dealer_id IS NULL OR dealer_id = ?)', [dealer.group_id, dealer.id], { orderBy: 'category ASC, key ASC' });
    return json({ knowledge: rows });
  });
}
