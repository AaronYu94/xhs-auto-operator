/** Onboarding API: the dealer's own store, models and Xiaohongshu accounts, and whether the store is ready to run. */
import {
  addAccount,
  addVehicle,
  createDealer,
  deleteDealer,
  deleteVehicle,
  getSetupStatus,
  removeAccount,
  updateDealer,
} from '../../operator/onboarding.ts';
import type { Router } from '../http.ts';
import type { ServerRuntime } from '../runtime.ts';
import { json, requireDealer } from './common.ts';

export function registerSetupRoutes(router: Router, runtime: ServerRuntime): void {
  const { ctx } = runtime;

  router.get('/api/dealers/:id/setup', (rc) => json(getSetupStatus(ctx, requireDealer(ctx, rc.params.id))));

  router.post('/api/dealers', async (rc) => {
    const dealer = createDealer(ctx, await rc.json(), rc.actor);
    return json({ id: dealer.id, dealer }, 201);
  });
  router.patch('/api/dealers/:id', async (rc) => json({ dealer: updateDealer(ctx, rc.params.id, await rc.json(), rc.actor) }));
  router.delete('/api/dealers/:id', (rc) => json(deleteDealer(ctx, rc.params.id, rc.actor)));

  router.post('/api/dealers/:id/vehicles', async (rc) => json({ vehicle: addVehicle(ctx, rc.params.id, await rc.json(), rc.actor) }, 201));
  router.delete('/api/vehicles/:id', (rc) => json(deleteVehicle(ctx, rc.params.id, rc.actor)));

  router.post('/api/dealers/:id/accounts', async (rc) => {
    const account = addAccount(ctx, rc.params.id, await rc.json(), rc.actor);
    return json({ id: account.id, account }, 201);
  });
  router.delete('/api/accounts/:id', (rc) => json(removeAccount(ctx, rc.params.id, rc.actor)));
}
