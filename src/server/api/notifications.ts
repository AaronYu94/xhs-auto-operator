/**
 * 消息中心 API: sync the platform's notification centre for a store or one account, and act on a single notification
 * (public reply, like, turn into a lead, mark handled, ignore). Nothing here fabricates an outcome — a reply only
 * counts when the provider confirmed it, and the sync reports each tab's own status.
 */
import { NOTIFICATION_TABS } from '../../core/types.ts';
import { v } from '../../core/validate.ts';
import {
  ignoreNotification,
  likeNotification,
  listNotifications,
  markNotificationHandled,
  promoteNotificationToLead,
  replyToNotification,
  syncAccountNotifications,
  syncDealerNotifications,
  unreadCounts,
} from '../../skills/operations/notification-inbox/index.ts';
import { queryString, type Router } from '../http.ts';
import type { ServerRuntime } from '../runtime.ts';
import { humanProblem, scrubInternals } from '../humanize.ts';
import { dealerFromQuery, json, readBody, requireDealer, requireRow } from './common.ts';

const syncBody = v.object({
  dealer_id: v.optional(v.string({ min: 1 })),
  account_id: v.optional(v.string({ min: 1 })),
  limit: v.optional(v.number({ int: true, min: 1, max: 100 })),
  tabs: v.optional(v.array(v.literal(NOTIFICATION_TABS))),
});
const replyBody = v.object({ text: v.string({ min: 1, max: 500 }) });
const likeBody = v.object({ unlike: v.optional(v.boolean()) });

export function registerNotificationRoutes(router: Router, runtime: ServerRuntime): void {
  const { ctx } = runtime;
  const row = (id: string) => requireRow(ctx.db.table('xhs_notifications').get(id), 'xhs_notification', id);

  router.get('/api/notifications', (rc) => {
    const dealerId = dealerFromQuery(rc, ctx);
    const tab = queryString(rc.query, 'tab');
    const status = queryString(rc.query, 'status');
    return json({
      notifications: listNotifications(ctx, dealerId, {
        tab: (NOTIFICATION_TABS as readonly string[]).includes(tab ?? '') ? (tab as (typeof NOTIFICATION_TABS)[number]) : undefined,
        status: status === 'NEW' || status === 'HANDLED' || status === 'IGNORED' ? status : undefined,
        account_id: queryString(rc.query, 'account') ?? undefined,
      }),
    });
  });

  router.get('/api/accounts/:id/unread', async (rc) => json(await unreadCounts(ctx, rc.params.id)));

  router.post('/api/notifications/sync', async (rc) => {
    const input = await readBody(rc, syncBody);
    if (input.account_id) return json({ results: [await syncAccountNotifications(ctx, input.account_id, { limit: input.limit, tabs: input.tabs })] });
    const dealerId = requireDealer(ctx, input.dealer_id ?? '');
    return json({ results: await syncDealerNotifications(ctx, dealerId, { limit: input.limit, tabs: input.tabs }) });
  });

  router.post('/api/notifications/:id/reply', async (rc) => {
    row(rc.params.id);
    const { text } = await readBody(rc, replyBody);
    const result = await replyToNotification(ctx, rc.params.id, text, rc.actor);
    // The console shows what actually happened: a refused or unconfirmed reply never toasts as sent.
    return json({ ...result, detail: result.status === 'AVAILABLE' ? '回复已发出' : `没发出去：${humanProblem(result.reason) ?? scrubInternals(result.reason) ?? '稍后再试一次'}` });
  });

  router.post('/api/notifications/:id/like', async (rc) => {
    row(rc.params.id);
    const { unlike } = await readBody(rc, likeBody);
    const result = await likeNotification(ctx, rc.params.id, rc.actor, unlike === true);
    return json({ ...result, detail: result.status === 'AVAILABLE' ? (unlike === true ? '已取消点赞' : '已点赞') : `没成功：${humanProblem(result.reason) ?? scrubInternals(result.reason) ?? '稍后再试一次'}` });
  });

  router.post('/api/notifications/:id/promote', (rc) => {
    row(rc.params.id);
    return json(promoteNotificationToLead(ctx, rc.params.id, rc.actor));
  });

  router.post('/api/notifications/:id/handled', (rc) => {
    row(rc.params.id);
    return json({ notification: markNotificationHandled(ctx, rc.params.id, rc.actor) });
  });

  router.post('/api/notifications/:id/ignore', (rc) => {
    row(rc.params.id);
    return json({ notification: ignoreNotification(ctx, rc.params.id, rc.actor) });
  });
}
