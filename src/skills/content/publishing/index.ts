/**
 * publishing (spec §15 Scheduling/Publishing + Performance Collection, ARCHITECTURE §8 C4).
 *
 * A post becomes PUBLISHED only when the provider confirms the publish, or when a human records that they published
 * it in the Xiaohongshu app. Everything the system cannot do itself (no publish capability, no images, unknown
 * outcome, DISABLED policy) becomes READY_TO_PUBLISH with the reason in the audit trail — never a fake success.
 */
import type { AppContext } from '../../../app/context.ts';
import { PolicyError, ValidationError } from '../../../core/errors.ts';
import { addDays, startOfLocalDay } from '../../../core/time.ts';
import type { CapabilityStatus, Post, PostMetrics, PostStatus } from '../../../core/types.ts';
import { v } from '../../../core/validate.ts';
import type { CapabilityReport } from '../../../providers/xhs/types.ts';
import { effectivePublishPolicy, requireAccount } from '../../operations/account-brain/index.ts';
import { isAccountOperable } from '../../operations/account-health/index.ts';
import { getDealer, verifyClaims } from '../../operations/dealer-brain/index.ts';
import { dealerTz } from '../../operations/dealer-brain/shared.ts';
import { defineSkill } from '../../registry.ts';

export const PUBLISHING_AGENT = 'publishing-agent';
export const NO_IMAGE_REASON = '小红书发布需要至少一张图片（或一个视频文件），请上传后再发，或人工发布后登记笔记链接';
/** Video notes: Xiaohongshu's video publisher takes exactly one local file on the instance's host. */
export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm'] as const;
export const UNKNOWN_OUTCOME_REASON = '发布结果未知，请到小红书账号核实，避免重复发布';
export const DISABLED_PUBLISH_REASON = '发布审批策略为DISABLED，系统不自动发布，请人工发布后登记笔记链接';
export const MAX_IMAGES = 18;
export const PUBLISHABLE_STATUSES: readonly PostStatus[] = ['APPROVED', 'SCHEDULED'];
const MANUAL_PUBLISH_STATUSES: readonly PostStatus[] = ['APPROVED', 'SCHEDULED', 'READY_TO_PUBLISH', 'FAILED'];
/** Xiaohongshu note ids are 24 hex chars; provider-local ids (e.g. simulation) may contain '-' / '_'. */
const NOTE_ID_RE = /^[0-9A-Za-z][0-9A-Za-z_-]{5,63}$/;
const actorOf = () => `agent:${PUBLISHING_AGENT}`;

export interface PublishRunResult {
  published: Post[];
  ready_to_publish: Post[];
  skipped: { post_id: string; reason: string }[];
  /** facts no longer verify at publish time (e.g. an offer expired) */
  changes_required: Post[];
  failed: Post[];
}

const postText = (p: Pick<Post, 'title' | 'cover_text' | 'body'>) => `${p.title}\n${p.cover_text}\n${p.body}`;

function publishedTodayCount(ctx: AppContext, accountId: string, tz: string): number {
  const start = startOfLocalDay(ctx.clock.now(), tz);
  const end = addDays(start, 1);
  const row = ctx.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND status = 'PUBLISHED' AND published_at >= ? AND published_at < ?`,
    accountId,
    start.toISOString(),
    end.toISOString(),
  );
  return Number(row?.n ?? 0);
}

function markReady(ctx: AppContext, post: Post, reason: string, details: Record<string, unknown> = {}): Post {
  return ctx.db.tx(() => {
    const updated = ctx.db.table('posts').update(post.id, { status: 'READY_TO_PUBLISH' });
    ctx.audit.event({
      actor: actorOf(),
      action: 'post.ready_to_publish',
      entity_type: 'post',
      entity_id: post.id,
      details: { previous_status: post.status, reason, ...details },
    });
    return updated;
  });
}

/** Publish every APPROVED/SCHEDULED post of the dealer that is due, within each account's daily publish limit. */
export async function publishDuePosts(ctx: AppContext, dealerId: string): Promise<PublishRunResult> {
  const dealer = getDealer(ctx, dealerId);
  const tz = dealerTz(dealer);
  const nowIso = ctx.clock.iso();
  const due = ctx.db
    .table('posts')
    .query(`dealer_id = ? AND status IN ('APPROVED', 'SCHEDULED') AND (scheduled_for IS NULL OR scheduled_for <= ?)`, [dealerId, nowIso], {
      orderBy: 'scheduled_for ASC, created_at ASC',
    });
  const result: PublishRunResult = { published: [], ready_to_publish: [], skipped: [], changes_required: [], failed: [] };
  const caps = new Map<string, CapabilityReport>();
  const counts = new Map<string, number>();

  for (const post of due) {
    const account = requireAccount(ctx, post.account_id);
    const policy = effectivePublishPolicy(ctx, account.id);
    const count = counts.get(account.id) ?? publishedTodayCount(ctx, account.id, tz);
    counts.set(account.id, count);
    if (count >= policy.daily_limit) {
      result.skipped.push({ post_id: post.id, reason: `账号「${account.nickname}」已达今日发布上限（${policy.daily_limit}篇）` });
      continue;
    }
    const operable = isAccountOperable(ctx, account.id);
    if (operable.blocking) {
      result.skipped.push({ post_id: post.id, reason: `账号不可用：${operable.reason}` });
      continue;
    }

    const facts = verifyClaims(ctx, dealerId, postText(post), post.fact_refs);
    if (!facts.passed) {
      const updated = ctx.db.tx(() => {
        const review = post.review
          ? { ...post.review, fact_check: { passed: false, issues: facts.issues, verified_claims: facts.verified }, reviewed_at: nowIso }
          : null;
        const row = ctx.db.table('posts').update(post.id, { status: 'CHANGES_REQUIRED', ...(review ? { review } : {}) });
        ctx.audit.event({
          actor: actorOf(),
          action: 'post.facts_invalid_at_publish',
          entity_type: 'post',
          entity_id: post.id,
          details: { issues: facts.issues, unverified_claims: facts.unverified_claims },
        });
        return row;
      });
      result.changes_required.push(updated);
      continue;
    }

    if (policy.policy === 'DISABLED') {
      result.ready_to_publish.push(markReady(ctx, post, DISABLED_PUBLISH_REASON));
      continue;
    }

    let report = caps.get(account.id);
    if (!report) {
      report = await ctx.xhs.capabilities(account.id);
      caps.set(account.id, report);
    }
    const cap = report.capabilities.publish_content;
    if (cap.status !== 'AVAILABLE') {
      result.ready_to_publish.push(
        markReady(ctx, post, `发布能力不可用（${cap.status}）：${cap.reason}`, { capability_status: cap.status, provider: report.provider, mode: report.mode }),
      );
      continue;
    }
    const images = (post.images ?? []).filter((i) => typeof i === 'string' && i.trim());
    const video = typeof post.video === 'string' ? post.video.trim() : '';
    if (images.length === 0 && !video) {
      result.ready_to_publish.push(markReady(ctx, post, NO_IMAGE_REASON));
      continue;
    }

    // A video note is published by a different publisher and carries no images.
    const res = await ctx.xhs.publishNote(account.id, { title: post.title, body: post.body, tags: post.tags, images, video: video || null });
    if (res.ok) {
      const updated = ctx.db.tx(() => {
        let noteId = res.data.platform_note_id;
        const conflict = noteId ? ctx.db.table('posts').findOne({ platform_note_id: noteId }) : undefined;
        if (conflict && conflict.id !== post.id) {
          ctx.audit.event({
            actor: actorOf(),
            action: 'post.note_id_conflict',
            entity_type: 'post',
            entity_id: post.id,
            details: { platform_note_id: noteId, other_post_id: conflict.id },
          });
          noteId = null;
        }
        const row = ctx.db.table('posts').update(post.id, { status: 'PUBLISHED', published_at: nowIso, ...(noteId ? { platform_note_id: noteId } : {}) });
        ctx.audit.event({
          actor: actorOf(),
          action: 'post.published',
          entity_type: 'post',
          entity_id: post.id,
          details: { provider: ctx.xhs.name, mode: ctx.xhs.mode, platform_note_id: noteId, url: res.data.url, images: images.length, video: video || null },
        });
        if (!noteId) {
          ctx.audit.event({
            actor: actorOf(),
            action: 'post.published_unreconciled',
            entity_type: 'post',
            entity_id: post.id,
            details: { reason: '平台确认发布成功但未返回笔记ID，请在小红书找到该笔记并登记链接' },
          });
        }
        return row;
      });
      counts.set(account.id, count + 1);
      result.published.push(updated);
      continue;
    }

    if (res.status === 'REQUIRES_REVIEW') {
      result.ready_to_publish.push(markReady(ctx, post, `${UNKNOWN_OUTCOME_REASON}（${res.reason}）`, { outcome_unknown: true }));
    } else if (res.status === 'REQUIRES_AUTH') {
      result.ready_to_publish.push(markReady(ctx, post, `账号需要重新登录小红书：${res.reason}`, { capability_status: res.status }));
    } else if (res.retryable) {
      ctx.audit.event({ actor: actorOf(), action: 'post.publish_retry_later', entity_type: 'post', entity_id: post.id, details: { reason: res.reason } });
      result.skipped.push({ post_id: post.id, reason: `暂时无法发布，稍后重试：${res.reason}` });
    } else {
      const failed = ctx.db.tx(() => {
        const row = ctx.db.table('posts').update(post.id, { status: 'FAILED' });
        ctx.audit.event({ actor: actorOf(), action: 'post.publish_failed', entity_type: 'post', entity_id: post.id, details: { status: res.status, reason: res.reason } });
        return row;
      });
      result.failed.push(failed);
    }
  }
  return result;
}

/** Note id from a Xiaohongshu note URL (explore / discovery/item / item); null for short links or other hosts. */
export function parseNoteIdFromUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (!/(^|\.)xiaohongshu\.com$/i.test(u.hostname)) return null;
  const m = /^\/(?:explore|discovery\/item|item)\/([0-9A-Za-z]+)\/?$/.exec(u.pathname);
  return m && NOTE_ID_RE.test(m[1]) ? m[1] : null;
}

/**
 * A human published the post in the Xiaohongshu app (or found the note of an unreconciled publish). Records
 * PUBLISHED with the note id parsed from the URL or given explicitly; for an already PUBLISHED post without a note id
 * this reconciles the id.
 */
export function markPublishedManually(
  ctx: AppContext,
  postId: string,
  input: { platform_note_id?: string | null; url?: string | null },
  actor: string,
): Post {
  if (!actor?.trim()) throw new ValidationError('actor', 'required');
  const post = ctx.db.table('posts').require(postId);
  const reconcile = post.status === 'PUBLISHED' && !post.platform_note_id;
  if (!reconcile && !MANUAL_PUBLISH_STATUSES.includes(post.status)) {
    throw new PolicyError('invalid_post_status', `状态为 ${post.status} 的内容不能登记为已发布（需先审核通过）`, { post_id: postId, status: post.status });
  }
  const explicit = input.platform_note_id?.trim() || null;
  if (explicit && !NOTE_ID_RE.test(explicit)) throw new ValidationError('platform_note_id', '笔记ID格式不正确');
  const url = input.url?.trim() || null;
  const fromUrl = url ? parseNoteIdFromUrl(url) : null;
  if (url && !fromUrl && !explicit) {
    throw new ValidationError('url', '无法从链接中解析笔记ID，请粘贴 https://www.xiaohongshu.com/explore/<笔记ID> 格式的链接或直接填写笔记ID');
  }
  if (explicit && fromUrl && explicit !== fromUrl) throw new ValidationError('platform_note_id', `笔记ID与链接不一致（${explicit} ≠ ${fromUrl}）`);
  const noteId = explicit ?? fromUrl;
  if (reconcile && !noteId) throw new ValidationError('platform_note_id', '补登笔记ID时必须提供笔记ID或链接');
  if (noteId) {
    const other = ctx.db.table('posts').findOne({ platform_note_id: noteId });
    if (other && other.id !== postId) throw new PolicyError('duplicate_note_id', `笔记 ${noteId} 已登记在另一条内容上`, { other_post_id: other.id });
  }
  return ctx.db.tx(() => {
    const updated = ctx.db.table('posts').update(postId, {
      status: 'PUBLISHED',
      ...(post.published_at ? {} : { published_at: ctx.clock.iso() }),
      ...(noteId ? { platform_note_id: noteId } : {}),
    });
    ctx.audit.event({
      actor,
      action: reconcile ? 'post.note_reconciled' : 'post.published_manually',
      entity_type: 'post',
      entity_id: postId,
      details: { previous_status: post.status, platform_note_id: noteId, url },
    });
    if (!noteId) {
      ctx.audit.event({
        actor,
        action: 'post.published_unreconciled',
        entity_type: 'post',
        entity_id: postId,
        details: { reason: '人工登记已发布但未提供笔记ID，无法采集互动数据' },
      });
    }
    return updated;
  });
}

/** READY_TO_PUBLISH / FAILED → SCHEDULED (due now). For an unknown outcome the human confirms the note does NOT exist. */
export function requeuePost(ctx: AppContext, postId: string, actor: string): Post {
  if (!actor?.trim()) throw new ValidationError('actor', 'required');
  const post = ctx.db.table('posts').require(postId);
  if (post.status !== 'READY_TO_PUBLISH' && post.status !== 'FAILED') {
    throw new PolicyError('invalid_post_status', `只有待发布或发布失败的内容可以重新排期，当前为 ${post.status}`, { post_id: postId, status: post.status });
  }
  return ctx.db.tx(() => {
    const updated = ctx.db.table('posts').update(postId, { status: 'SCHEDULED', scheduled_for: ctx.clock.iso() });
    ctx.audit.event({ actor, action: 'post.requeued', entity_type: 'post', entity_id: postId, details: { previous_status: post.status } });
    return updated;
  });
}

/** Attach images (http(s) URLs or absolute file paths on the xiaohongshu-mcp host). */
export function setPostImages(ctx: AppContext, postId: string, images: string[], actor: string): Post {
  if (!actor?.trim()) throw new ValidationError('actor', 'required');
  if (!Array.isArray(images)) throw new ValidationError('images', 'expected array');
  const clean = [...new Set(images.map((i) => (typeof i === 'string' ? i.trim() : '')))].filter(Boolean);
  if (clean.length > MAX_IMAGES) throw new ValidationError('images', `最多${MAX_IMAGES}张图片`);
  for (const [i, img] of clean.entries()) {
    if (!/^https?:\/\/\S+$/i.test(img) && !/^\/\S/.test(img) && !/^[A-Za-z]:\\/.test(img)) {
      throw new ValidationError(`images[${i}]`, '图片必须是 http(s) 链接或绝对文件路径');
    }
  }
  const post = ctx.db.table('posts').require(postId);
  if (post.status === 'PUBLISHED' || post.status === 'REJECTED') {
    throw new PolicyError('invalid_post_status', `状态为 ${post.status} 的内容不能修改图片`, { post_id: postId, status: post.status });
  }
  return ctx.db.tx(() => {
    const updated = ctx.db.table('posts').update(postId, { images: clean });
    ctx.audit.event({ actor, action: 'post.images_updated', entity_type: 'post', entity_id: postId, details: { count: clean.length } });
    return updated;
  });
}

/**
 * Attach (or clear) the video of a video note. Xiaohongshu's video publisher takes ONE local file on the host that
 * runs the account's instance — a URL cannot be published, so it is refused here rather than at send time.
 */
export function setPostVideo(ctx: AppContext, postId: string, video: string | null, actor: string): Post {
  if (!actor?.trim()) throw new ValidationError('actor', 'required');
  const clean = typeof video === 'string' ? video.trim() : '';
  if (clean) {
    if (/^https?:\/\//i.test(clean)) throw new ValidationError('video', '视频必须是实例所在机器上的绝对路径，不能是链接');
    if (!/^\/\S/.test(clean) && !/^[A-Za-z]:\\/.test(clean)) throw new ValidationError('video', '视频必须是绝对文件路径');
    if (!VIDEO_EXTENSIONS.some((ext) => clean.toLowerCase().endsWith(ext))) {
      throw new ValidationError('video', `视频文件后缀需为 ${VIDEO_EXTENSIONS.join(' / ')}`);
    }
  }
  const post = ctx.db.table('posts').require(postId);
  if (post.status === 'PUBLISHED' || post.status === 'REJECTED') {
    throw new PolicyError('invalid_post_status', `状态为 ${post.status} 的内容不能修改视频`, { post_id: postId, status: post.status });
  }
  return ctx.db.tx(() => {
    const updated = ctx.db.table('posts').update(postId, { video: clean || null });
    ctx.audit.event({ actor, action: 'post.video_updated', entity_type: 'post', entity_id: postId, details: { video: clean || null } });
    return updated;
  });
}

export interface PerformanceResult {
  updated: number;
  status: CapabilityStatus;
  reason: string;
  /** PUBLISHED posts without a note id (engagement cannot be read until reconciled) */
  unreconciled: number;
  /** posts whose provider exposed no view count (views kept as before) */
  views_unavailable: number;
  failures: { account_id: string; post_id: string | null; status: CapabilityStatus; reason: string }[];
}

/** Read engagement for the dealer's published notes through each owning account's session. */
export async function collectPerformance(ctx: AppContext, dealerId: string): Promise<PerformanceResult> {
  getDealer(ctx, dealerId);
  const published = ctx.db.table('posts').findMany({ dealer_id: dealerId, status: 'PUBLISHED' }, { orderBy: 'published_at ASC' });
  const withId = published.filter((p) => p.platform_note_id);
  const unreconciled = published.length - withId.length;
  const failures: PerformanceResult['failures'] = [];
  const updates: { post: Post; metrics: PostMetrics }[] = [];
  let viewsUnavailable = 0;

  const byAccount = new Map<string, Post[]>();
  for (const p of withId) byAccount.set(p.account_id, [...(byAccount.get(p.account_id) ?? []), p]);
  for (const [accountId, posts] of byAccount) {
    const cap = (await ctx.xhs.capabilities(accountId)).capabilities.read_engagement;
    if (cap.status !== 'AVAILABLE') {
      failures.push({ account_id: accountId, post_id: null, status: cap.status, reason: cap.reason });
      continue;
    }
    for (const post of posts) {
      const res = await ctx.xhs.getEngagement(accountId, post.platform_note_id!);
      if (!res.ok) {
        failures.push({ account_id: accountId, post_id: post.id, status: res.status, reason: res.reason });
        continue;
      }
      if (res.data.views === null) viewsUnavailable++;
      updates.push({
        post,
        metrics: {
          views: res.data.views ?? post.metrics.views,
          likes: res.data.likes,
          collects: res.data.collects,
          comments: res.data.comments,
          shares: res.data.shares,
        },
      });
    }
  }

  const now = ctx.clock.iso();
  if (updates.length > 0) {
    ctx.db.tx(() => {
      for (const u of updates) ctx.db.table('posts').update(u.post.id, { metrics: u.metrics, metrics_updated_at: now });
      ctx.audit.event({
        actor: actorOf(),
        action: 'posts.performance_collected',
        entity_type: 'dealer',
        entity_id: dealerId,
        details: { updated: updates.length, failures: failures.length, unreconciled, views_unavailable: viewsUnavailable },
      });
    });
  }

  const notes: string[] = [];
  if (unreconciled > 0) notes.push(`${unreconciled}篇已发布内容缺少笔记ID，请登记笔记链接后才能采集数据`);
  if (viewsUnavailable > 0) notes.push(`${viewsUnavailable}篇笔记平台未提供浏览量，保留原浏览量`);
  let status: CapabilityStatus = 'AVAILABLE';
  let reason: string;
  if (withId.length === 0) reason = published.length === 0 ? '没有已发布的内容' : '没有可采集互动数据的已发布笔记';
  else if (updates.length > 0) reason = `已更新${updates.length}篇笔记的互动数据${failures.length > 0 ? `，${failures.length}项采集失败` : ''}`;
  else {
    status = failures[0]?.status ?? 'UNAVAILABLE';
    reason = `互动数据采集失败：${failures.map((f) => f.reason).slice(0, 3).join('；')}`;
  }
  return { updated: updates.length, status, reason: [reason, ...notes].join('；'), unreconciled, views_unavailable: viewsUnavailable, failures };
}

const metricsValidator = v.object({
  views: v.optional(v.number({ int: true, min: 0 })),
  likes: v.optional(v.number({ int: true, min: 0 })),
  collects: v.optional(v.number({ int: true, min: 0 })),
  comments: v.optional(v.number({ int: true, min: 0 })),
  shares: v.optional(v.number({ int: true, min: 0 })),
});

/** Human-entered metrics (e.g. read from the Xiaohongshu creator center) for a PUBLISHED post. */
export function recordPostMetrics(ctx: AppContext, postId: string, metrics: Partial<PostMetrics>, actor: string): Post {
  if (!actor?.trim()) throw new ValidationError('actor', 'required');
  const clean = metricsValidator(metrics, 'metrics');
  if (Object.keys(clean).length === 0) throw new ValidationError('metrics', '至少填写一项数据');
  const post = ctx.db.table('posts').require(postId);
  if (post.status !== 'PUBLISHED') throw new PolicyError('invalid_post_status', `只能为已发布内容登记数据，当前为 ${post.status}`, { post_id: postId });
  return ctx.db.tx(() => {
    const updated = ctx.db.table('posts').update(postId, { metrics: { ...post.metrics, ...clean }, metrics_updated_at: ctx.clock.iso() });
    ctx.audit.event({ actor, action: 'post.metrics_recorded', entity_type: 'post', entity_id: postId, details: { before: post.metrics, set: clean } });
    return updated;
  });
}

const publishingInput = v.object({
  dealer_id: v.string({ min: 1 }),
  action: v.withDefault(v.literal(['publish_due', 'collect_performance'] as const), 'publish_due'),
});

export const skill = defineSkill({
  name: 'publishing',
  category: 'content',
  agent: 'publishing-agent',
  description:
    '发布到期的已审核笔记（仅在平台确认成功时记为已发布；无发布能力/无图片/结果未知时转为待人工发布并说明原因），并通过各账号会话采集已发布笔记的互动数据。',
  input: publishingInput,
  async run(ctx, input): Promise<PublishRunResult | PerformanceResult> {
    if (input.action === 'collect_performance') return collectPerformance(ctx, input.dealer_id);
    return publishDuePosts(ctx, input.dealer_id);
  },
});
