/** Console page routes. */
import type { Router } from '../http.ts';
import { accountsPage } from './accounts.ts';
import { contentPage, postDetailPage } from './content.ts';
import { conversationDetailPage, conversationsPage } from './conversations.ts';
import { intelPage } from './intel.ts';
import { leadDetailPage, leadsPage } from './leads.ts';
import { overviewPage } from './overview.ts';
import { setupPage } from './setup.ts';
import { vehicleDetailPage, vehiclesPage } from './vehicles.ts';
import type { PageEnv } from './shell.ts';
import { runDetailPage, systemPage } from './system.ts';

export function registerPages(router: Router, env: PageEnv): void {
  router.get('/', (rc) => overviewPage(env, rc));
  router.get('/leads', (rc) => leadsPage(env, rc));
  router.get('/leads/:id', (rc) => leadDetailPage(env, rc));
  router.get('/conversations', (rc) => conversationsPage(env, rc));
  router.get('/conversations/:id', (rc) => conversationDetailPage(env, rc));
  router.get('/content', (rc) => contentPage(env, rc));
  router.get('/content/posts/:id', (rc) => postDetailPage(env, rc));
  router.get('/vehicles', (rc) => vehiclesPage(env, rc));
  router.get('/vehicles/:id', (rc) => vehicleDetailPage(env, rc));
  router.get('/accounts', (rc) => accountsPage(env, rc));
  router.get('/intel', (rc) => intelPage(env, rc));
  router.get('/system', (rc) => systemPage(env, rc));
  router.get('/system/runs/:id', (rc) => runDetailPage(env, rc));
  router.get('/setup', (rc) => setupPage(env, rc));
}
