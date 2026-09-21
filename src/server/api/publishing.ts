/**
 * Publishing & engagement API: images, due publishing through the provider (never marked PUBLISHED without
 * confirmation), manual publish registration with note URL, metrics, and public replies to comments on our own notes.
 */
import { ENGAGEMENT_REPLY_STATUSES, type EngagementReplyStatus } from '../../core/types.ts';
import { ValidationError } from '../../core/errors.ts';
import { v } from '../../core/validate.ts';
import {
  approveEngagementReply,
  cancelEngagementReply,
  draftEngagementReplies,
  markEngagementReplySentManually,
  sendEngagementReply,
} from '../../skills/content/engagement/index.ts';
import {
  MAX_IMAGES,
  collectPerformance,
  markPublishedManually,
  publishDuePosts,
  recordPostMetrics,
  requeuePost,
  setPostImages,
  setPostVideo,
} from '../../skills/content/publishing/index.ts';
import { queryString, type Router } from '../http.ts';
import type { ServerRuntime } from '../runtime.ts';
import { dealerFromQuery, json, paging, readBody, requireDealer, requireRow } from './common.ts';

const dealerBody = v.object({ dealer_id: v.string({ min: 1 }) });
const imagesBody = v.object({ images: v.array(v.string({ min: 1, max: 1000 }), { max: MAX_IMAGES }) });
const videoBody = v.object({ video: v.optional(v.nullable(v.string({ max: 1000 }))) });
const publishedBody = v.object({ platform_note_id: v.optional(v.nullable(v.string({ min: 1, max: 80 }))), url: v.optional(v.nullable(v.string({ min: 1, max: 1000 }))) });
const count = v.optional(v.number({ int: true, min: 0, max: 1_000_000_000 }));
const metricsBody = v.object({ views: count, likes: count, collects: count, comments: count, shares: count });
const messageBody = v.object({ message: v.optional(v.string({ min: 1, max: 500 })) });
const reasonBody = v.object({ reason: v.string({ min: 1, max: 300 }) });

export function registerPublishingRoutes(router: Router, runtime: ServerRuntime): void {
  const { ctx } = runtime;
  const post = (id: string) => requireRow(ctx.db.table('posts').get(id), 'post', id);

  router.post('/api/posts/:id/images', async (rc) => {
    post(rc.params.id);
    const { images } = await readBody(rc, imagesBody);
    return json({ post: setPostImages(ctx, rc.params.id, images, rc.actor) });
  });

  router.post('/api/posts/:id/video', async (rc) => {
    post(rc.params.id);
    const { video } = await readBody(rc, videoBody);
    return json({ post: setPostVideo(ctx, rc.params.id, video ?? null, rc.actor) });
  });

  router.post('/api/posts/publish-due', async (rc) => {
    const { dealer_id } = await readBody(rc, dealerBody);
    return json(await publishDuePosts(ctx, requireDealer(ctx, dealer_id)));
  });

  router.post('/api/posts/:id/mark-published', async (rc) => {
    post(rc.params.id);
    const input = await readBody(rc, publishedBody);
    if (!input.platform_note_id && !input.url) throw new ValidationError('url', '请提供笔记链接或笔记ID');
    return json({ post: markPublishedManually(ctx, rc.params.id, input, rc.actor) });
  });

  router.post('/api/posts/:id/requeue', (rc) => json({ post: requeuePost(ctx, rc.params.id, rc.actor) }));

  router.post('/api/posts/:id/metrics', async (rc) => {
    post(rc.params.id);
    const metrics = await readBody(rc, metricsBody);
    if (Object.keys(metrics).length === 0) throw new ValidationError('body', 'nothing to record');
    return json({ post: recordPostMetrics(ctx, rc.params.id, metrics, rc.actor) });
  });

  router.post('/api/performance/collect', async (rc) => {
    const { dealer_id } = await readBody(rc, dealerBody);
    return json(await collectPerformance(ctx, requireDealer(ctx, dealer_id)));
  });

  router.get('/api/engagement-replies', (rc) => {
    const dealerId = dealerFromQuery(rc, ctx);
    const statusRaw = queryString(rc.query, 'status');
    const statuses = statusRaw ? (statusRaw.split(',') as EngagementReplyStatus[]) : [];
    for (const s of statuses) if (!ENGAGEMENT_REPLY_STATUSES.includes(s)) throw new ValidationError('status', `unknown status ${s}`);
    const { limit, offset } = paging(rc, 100, 500);
    const rows = ctx.db.table('engagement_replies').findMany({ dealer_id: dealerId, status: statuses.length ? statuses : undefined }, { orderBy: 'created_at DESC', limit, offset });
    return json({
      replies: rows.map((r) => {
        const comment = ctx.db.table('public_comments').get(r.public_comment_id);
        const publicPost = comment ? ctx.db.table('public_posts').get(comment.public_post_id) : undefined;
        return { reply: r, comment: comment ?? null, post_title: publicPost?.title ?? null, url: publicPost?.url ?? null };
      }),
    });
  });

  router.post('/api/engagement-replies/draft', async (rc) => {
    const { dealer_id } = await readBody(rc, dealerBody);
    return json({ replies: await draftEngagementReplies(ctx, requireDealer(ctx, dealer_id)) });
  });
  router.post('/api/engagement-replies/:id/approve', async (rc) => {
    const { message } = await readBody(rc, messageBody);
    return json({ reply: await approveEngagementReply(ctx, rc.params.id, rc.actor, message) });
  });
  router.post('/api/engagement-replies/:id/send', async (rc) => json({ reply: await sendEngagementReply(ctx, rc.params.id) }));
  router.post('/api/engagement-replies/:id/mark-sent', (rc) => json({ reply: markEngagementReplySentManually(ctx, rc.params.id, rc.actor) }));
  router.post('/api/engagement-replies/:id/cancel', async (rc) => {
    const { reason } = await readBody(rc, reasonBody);
    return json({ reply: cancelEngagementReply(ctx, rc.params.id, rc.actor, reason) });
  });
}
