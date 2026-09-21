/**
 * 车型库 API: the store's line-up as cards, editing, archiving, batch import, retrieval and AI knowledge generation.
 * Facts are only ever written by a human here; the AI route writes prose and only the part that passed both guards.
 */
import { ValidationError } from '../../core/errors.ts';
import { humanProblem, scrubInternals } from '../humanize.ts';
import { v } from '../../core/validate.ts';
import { addVehicle } from '../../operator/onboarding.ts';
import {
  archiveVehicle,
  getVehicleCard,
  importVehicles,
  listVehicleCards,
  parseVehicleRows,
  restoreVehicle,
  retrieveVehicles,
  updateVehicle,
  vehicleContext,
  vehiclePatchValidator,
  type VehicleImportRow,
} from '../../skills/operations/vehicle-brain/index.ts';
import { generateVehicleKnowledge } from '../../skills/operations/vehicle-brain/knowledge.ts';
import { getDealer } from '../../skills/operations/dealer-brain/index.ts';
import { queryString, type Router } from '../http.ts';
import type { ServerRuntime } from '../runtime.ts';
import { json, readBody, requireDealer, requireRow } from './common.ts';

const importBody = v.object({
  text: v.optional(v.string({ min: 1, max: 500_000 })),
  rows: v.optional(v.array(v.record(v.unknown()), { max: 2000 })),
});
const retrieveBody = v.object({
  text: v.optional(v.string({ max: 2000 })),
  brand: v.optional(v.string({ max: 40 })),
  model: v.optional(v.string({ max: 60 })),
  trim: v.optional(v.string({ max: 60 })),
  limit: v.optional(v.number({ int: true, min: 1, max: 20 })),
});
const generateBody = v.object({
  dealer_id: v.string({ min: 1 }),
  apply: v.optional(v.boolean()),
  keep_existing: v.optional(v.boolean()),
});

export function registerVehicleRoutes(router: Router, runtime: ServerRuntime): void {
  const { ctx } = runtime;
  const vehicle = (id: string) => requireRow(ctx.db.table('vehicles').get(id), 'vehicle', id);

  router.get('/api/dealers/:id/vehicle-cards', (rc) => {
    const dealerId = requireDealer(ctx, rc.params.id);
    return json({
      vehicles: listVehicleCards(ctx, dealerId, {
        include_archived: queryString(rc.query, 'include_archived') === '1',
        brand: queryString(rc.query, 'brand') ?? undefined,
        query: queryString(rc.query, 'query') ?? undefined,
      }),
    });
  });

  router.get('/api/dealers/:id/vehicle-cards/:vehicleId', (rc) => {
    const dealerId = requireDealer(ctx, rc.params.id);
    return json({ vehicle: getVehicleCard(ctx, dealerId, rc.params.vehicleId) });
  });

  router.patch('/api/vehicles/:id', async (rc) => {
    vehicle(rc.params.id);
    const patch = await readBody(rc, vehiclePatchValidator);
    return json({ vehicle: updateVehicle(ctx, rc.params.id, patch, rc.actor) });
  });

  router.post('/api/vehicles/:id/archive', (rc) => {
    vehicle(rc.params.id);
    return json({ vehicle: archiveVehicle(ctx, rc.params.id, rc.actor), detail: '车型已归档，不再用于内容和回复' });
  });

  router.post('/api/vehicles/:id/restore', (rc) => {
    vehicle(rc.params.id);
    return json({ vehicle: restoreVehicle(ctx, rc.params.id, rc.actor), detail: '车型已恢复在售' });
  });

  /** AI 车型知识生成. Only what passed the fact guards is stored; what was dropped comes back in `rejected`. */
  router.post('/api/vehicles/:id/generate', async (rc) => {
    vehicle(rc.params.id);
    const body = await readBody(rc, generateBody);
    const dealerId = requireDealer(ctx, body.dealer_id);
    const result = await generateVehicleKnowledge(ctx, dealerId, rc.params.id, rc.actor, { apply: body.apply, keep_existing: body.keep_existing });
    const kept = result.applied.highlights.length + result.applied.faqs.length + result.applied.target_customers.length + result.applied.content_angles.length;
    return json({
      ...result,
      detail:
        result.status !== 'AVAILABLE'
          ? // Whatever the model or the connection said is not for a salesperson to read.
            (humanProblem(result.reason) ?? scrubInternals(result.reason) ?? '这次没写成，过一会儿再试一次')
          : result.rejected.length === 0
            ? `写好了，共 ${kept} 条`
            : `写好了 ${kept} 条；另有 ${result.rejected.length} 条和你填的车型数据对不上，已经扔掉了`,
    });
  });

  router.post('/api/dealers/:id/vehicles/import', async (rc) => {
    const dealerId = requireDealer(ctx, rc.params.id);
    const body = await readBody(rc, importBody);
    const rows: VehicleImportRow[] = body.rows ? (body.rows as VehicleImportRow[]) : body.text ? parseVehicleRows(body.text) : [];
    if (rows.length === 0) throw new ValidationError('text', '没有可导入的车型');
    const result = importVehicles(ctx, dealerId, rows, rc.actor, addVehicle);
    return json({
      ...result,
      detail: `新增 ${result.created} 个、更新 ${result.updated} 个车型${result.failed.length > 0 ? `，${result.failed.length} 行失败` : ''}`,
    });
  });

  /** What the agents see for a given customer sentence — also the console's "试一下检索" box. */
  router.post('/api/dealers/:id/vehicles/retrieve', async (rc) => {
    const dealerId = requireDealer(ctx, rc.params.id);
    const q = await readBody(rc, retrieveBody);
    getDealer(ctx, dealerId);
    const matches = retrieveVehicles(ctx, dealerId, q);
    return json({ matches, context: vehicleContext(matches.map((m) => m.card)).text });
  });
}
