import type { AppContext } from '../app/context.ts';
import { NotFoundError } from '../core/errors.ts';
import type { DealerProfile } from '../core/types.ts';

/**
 * Derive the scoring-relevant DealerProfile from structured Dealer Brain rows:
 * brands carried, catalog models/trims (group vehicles of those brands) and sellable inventory
 * (in_stock / in_transit with quantity > 0) at this dealer.
 */
export function buildDealerProfile(ctx: AppContext, dealerId: string): DealerProfile {
  const dealer = ctx.db.table('dealers').get(dealerId);
  if (!dealer) throw new NotFoundError('dealer', dealerId);

  const vehicles = ctx.db
    .table('vehicles')
    .findMany(
      dealer.brands.length > 0 ? { group_id: dealer.group_id, brand: dealer.brands } : { group_id: dealer.group_id },
      { orderBy: 'model ASC, trim ASC' },
    );
  const byId = new Map(vehicles.map((veh) => [veh.id, veh]));

  const inventory = ctx.db
    .table('inventory')
    .findMany({ dealer_id: dealerId, status: ['in_stock', 'in_transit'] })
    .filter((row) => row.quantity > 0 && byId.has(row.vehicle_id))
    .map((row) => {
      const veh = byId.get(row.vehicle_id)!;
      return {
        model: veh.model,
        trim: veh.trim,
        exterior_color: row.exterior_color,
        interior_color: row.interior_color,
        status: row.status,
        quantity: row.quantity,
      };
    });

  return {
    dealer_id: dealer.id,
    brands: dealer.brands.length > 0 ? [...dealer.brands] : [...new Set(vehicles.map((veh) => veh.brand))],
    models: [...new Set(vehicles.map((veh) => veh.model))],
    trims: vehicles.map((veh) => ({ model: veh.model, trim: veh.trim, aliases: veh.aliases })),
    inventory,
    city: dealer.city,
    province: dealer.province,
  };
}
