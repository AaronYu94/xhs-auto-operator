import { newId } from '../../../src/core/ids.ts';
import type { ApprovalPolicy, ContentPillar, Post, PostStatus, PublicComment, PublicPost } from '../../../src/core/types.ts';
import { SimulationXhsProvider, type SimulationOptions } from '../../../src/providers/xhs/simulation.ts';
import type { XhsProvider } from '../../../src/providers/xhs/types.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { accountIdByPlatformId, dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';
import type { ImportSummary } from '../../../src/skills/operations/dealer-brain/index.ts';

export interface ContentSetup {
  ctx: TestContext;
  summary: ImportSummary;
  dealerId: string;
  sim: SimulationXhsProvider;
  acc: (platformAccountId: string) => string;
}

export function setupContent(simOpts: SimulationOptions = {}): ContentSetup {
  const ctx = createTestContext();
  const summary = loadDealerFixture(ctx);
  const internalToPlatform = Object.fromEntries(Object.entries(summary.account_ids).map(([platform, internal]) => [internal, platform]));
  const sim = SimulationXhsProvider.fromFile(ctx.clock, undefined, { account_platform_ids: internalToPlatform, ...simOpts });
  ctx.xhs = sim;
  return { ctx, summary, dealerId: dealerIdByKey(summary, 'hz-bmw'), sim, acc: (p) => accountIdByPlatformId(summary, p) };
}

export function insertPost(
  ctx: TestContext,
  input: {
    dealer_id: string;
    account_id: string;
    pillar: ContentPillar;
    model: string | null;
    angle?: string;
    slot_date?: string;
    status?: PostStatus;
    title?: string;
    body?: string;
    platform_note_id?: string | null;
    published_at?: string | null;
  },
): Post {
  const now = ctx.clock.iso();
  return ctx.db.table('posts').insert({
    id: newId('post'),
    dealer_id: input.dealer_id,
    account_id: input.account_id,
    plan_id: null,
    slot_date: input.slot_date ?? '2026-09-13',
    pillar: input.pillar,
    topic: `${input.model ?? 'general'}:${input.pillar}:${input.angle ?? ''}`,
    angle: input.angle ?? '',
    model: input.model,
    title: input.title ?? '',
    body: input.body ?? '',
    tags: [],
    cover_text: '',
    fact_refs: [],
    status: input.status ?? 'PLANNED',
    review: null,
    approval_policy: 'REVIEW_REQUIRED',
    platform_note_id: input.platform_note_id ?? null,
    scheduled_for: null,
    published_at: input.published_at ?? null,
    metrics: { views: 0, likes: 0, collects: 0, comments: 0, shares: 0 },
    metrics_updated_at: null,
    engine: 'rules',
    created_at: now,
    updated_at: now,
  });
}

export function setPublishPolicy(ctx: TestContext, dealerId: string, policy: ApprovalPolicy, extra: Record<string, unknown> = {}): void {
  const dealer = ctx.db.table('dealers').require(dealerId);
  ctx.db.table('dealers').update(dealerId, { settings: { ...dealer.settings, publish_approval_policy: policy, ...extra } });
}

export function insertPublicPost(ctx: TestContext, input: Partial<PublicPost> & { platform_post_id: string }): PublicPost {
  const now = ctx.clock.iso();
  return ctx.db.table('public_posts').insert({
    id: newId('ppost'),
    platform: 'xiaohongshu',
    platform_post_id: input.platform_post_id,
    xsec_token: input.xsec_token ?? null,
    url: input.url ?? null,
    title: input.title ?? '',
    content: input.content ?? '',
    author_platform_user_id: input.author_platform_user_id ?? null,
    author_nickname: input.author_nickname ?? null,
    author_profile_url: null,
    ip_location: input.ip_location ?? null,
    tags: [],
    like_count: 0,
    comment_count: 0,
    collect_count: 0,
    published_at: input.published_at ?? null,
    data_mode: input.data_mode ?? 'simulation',
    own_post_id: input.own_post_id ?? null,
    first_search_run_id: null,
    fetched_at: now,
    raw: {},
  });
}

export function insertComment(
  ctx: TestContext,
  input: { public_post_id: string; platform_comment_id: string; author: string; nickname: string; content: string; published_at?: string; ip?: string },
): PublicComment {
  const now = ctx.clock.iso();
  return ctx.db.table('public_comments').insert({
    id: newId('pcmt'),
    platform: 'xiaohongshu',
    platform_comment_id: input.platform_comment_id,
    public_post_id: input.public_post_id,
    parent_comment_id: null,
    author_platform_user_id: input.author,
    author_nickname: input.nickname,
    content: input.content,
    ip_location: input.ip ?? '浙江',
    like_count: 0,
    published_at: input.published_at ?? '2026-09-11T06:30:00.000Z',
    data_mode: 'simulation',
    prefilter_passed: true,
    prefilter_reason: 'keyword_hit',
    first_search_run_id: null,
    fetched_at: now,
    raw: {},
  });
}

/** Delegating provider with selected methods overridden (for failure-mode tests). */
export function withOverrides(base: XhsProvider, o: Partial<Pick<XhsProvider, 'publishNote' | 'getEngagement' | 'replyToComment' | 'capabilities'>>): XhsProvider {
  return {
    name: base.name,
    mode: base.mode,
    capabilities: o.capabilities ?? ((a) => base.capabilities(a)),
    searchNotes: (q, opts, a) => base.searchNotes(q, opts, a),
    getNote: (r, a) => base.getNote(r, a),
    getComments: (r, opts, a) => base.getComments(r, opts, a),
    getUserProfile: (r, a) => base.getUserProfile(r, a),
    publishNote: o.publishNote ?? ((a, d) => base.publishNote(a, d)),
    getEngagement: o.getEngagement ?? ((a, n) => base.getEngagement(a, n)),
    replyToComment: o.replyToComment ?? ((a, r, t) => base.replyToComment(a, r, t)),
    listInboundMessages: (a, s) => base.listInboundMessages(a, s),
    sendMessage: (a, u, t) => base.sendMessage(a, u, t),
  };
}
