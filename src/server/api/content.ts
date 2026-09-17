/** Content operations API: per-account calendar, generation, fact/duplicate/compliance review and approval. */
import { ValidationError } from '../../core/errors.ts';
import { POST_STATUSES, type PostStatus } from '../../core/types.ts';
import { v } from '../../core/validate.ts';
import { approvePost, listReviewQueue, rejectPost, reviewPost } from '../../skills/content/content-review/index.ts';
import { generatePost } from '../../skills/content/post-generation/index.ts';
import { queryString, type Router } from '../http.ts';
import type { ServerRuntime } from '../runtime.ts';
import { dealerFromQuery, json, paging, readBody, requireRow } from './common.ts';

const reasonBody = v.object({ reason: v.string({ min: 1, max: 300 }) });
const dateKey = /^\d{4}-\d{2}-\d{2}$/;

export function registerContentRoutes(router: Router, runtime: ServerRuntime): void {
  const { ctx } = runtime;
  const post = (id: string) => requireRow(ctx.db.table('posts').get(id), 'post', id);

  router.get('/api/posts', (rc) => {
    const dealerId = dealerFromQuery(rc, ctx);
    const from = queryString(rc.query, 'from', 10);
    const to = queryString(rc.query, 'to', 10);
    if (from && !dateKey.test(from)) throw new ValidationError('from', 'expected YYYY-MM-DD');
    if (to && !dateKey.test(to)) throw new ValidationError('to', 'expected YYYY-MM-DD');
    const statusRaw = queryString(rc.query, 'status');
    const statuses = statusRaw ? (statusRaw.split(',') as PostStatus[]) : [];
    for (const s of statuses) if (!POST_STATUSES.includes(s)) throw new ValidationError('status', `unknown status ${s}`);
    const where: string[] = ['dealer_id = ?'];
    const params: string[] = [dealerId];
    if (from) {
      where.push('slot_date >= ?');
      params.push(from);
    }
    if (to) {
      where.push('slot_date <= ?');
      params.push(to);
    }
    const accountId = queryString(rc.query, 'account_id');
    if (accountId) {
      where.push('account_id = ?');
      params.push(accountId);
    }
    if (statuses.length > 0) {
      where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    const { limit, offset } = paging(rc, 200, 1000);
    return json({ posts: ctx.db.table('posts').query(where.join(' AND '), params, { orderBy: 'slot_date ASC, account_id ASC, created_at ASC', limit, offset }) });
  });

  router.get('/api/posts/:id', (rc) => json({ post: post(rc.params.id) }));
  router.get('/api/content/review-queue', (rc) => json({ posts: listReviewQueue(ctx, dealerFromQuery(rc, ctx)) }));

  router.post('/api/posts/:id/generate', async (rc) => {
    post(rc.params.id);
    return json({ post: await generatePost(ctx, rc.params.id) });
  });
  router.post('/api/posts/:id/review', (rc) => {
    post(rc.params.id);
    return json({ post: reviewPost(ctx, rc.params.id) });
  });
  router.post('/api/posts/:id/approve', (rc) => json({ post: approvePost(ctx, rc.params.id, rc.actor) }));
  router.post('/api/posts/:id/reject', async (rc) => {
    const { reason } = await readBody(rc, reasonBody);
    return json({ post: rejectPost(ctx, rc.params.id, rc.actor, reason) });
  });
}
