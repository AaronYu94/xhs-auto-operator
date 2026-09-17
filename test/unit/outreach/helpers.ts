import { newId } from '../../../src/core/ids.ts';
import type { AutomotiveIntent, DataMode, Lead, LeadStage } from '../../../src/core/types.ts';
import { SimulationXhsProvider, type SimulationOptions } from '../../../src/providers/xhs/simulation.ts';
import type { ImportSummary } from '../../../src/skills/operations/dealer-brain/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { accountIdByPlatformId, dealerIdByKey, loadDealerFixture, seedAssignment, seedLead } from '../../helpers/fixtures.ts';

export const BUYER_TEXT = '杭州i3 35L白外红内有现车吗？这周想去看看';
export const BUYER_QUOTE = '杭州i3 35L白外红内有现车吗';
export const POST_TITLE = '宝马i3现在值得买吗？';
export const IMMEDIATE_INTENT: AutomotiveIntent = {
  brand: 'BMW',
  model: 'i3',
  trim: 'eDrive35L',
  location: '杭州',
  province: '浙江',
  inventory_intent: true,
  color_intent: '白外红内',
  visit_intent: true,
  purchase_stage: 'purchase_imminent',
};

export interface World {
  ctx: TestContext;
  summary: ImportSummary;
  dealerId: string;
  sim: SimulationXhsProvider;
  account(platformAccountId: string): string;
}

export function createWorld(opts: SimulationOptions = {}): World {
  const ctx = createTestContext();
  const summary = loadDealerFixture(ctx);
  const internalToPlatform = Object.fromEntries(Object.entries(summary.account_ids).map(([p, i]) => [i, p]));
  const sim = SimulationXhsProvider.fromFile(ctx.clock, undefined, { account_platform_ids: internalToPlatform, ...opts });
  ctx.xhs = sim;
  return {
    ctx,
    summary,
    dealerId: dealerIdByKey(summary, 'hz-bmw'),
    sim,
    account: (pid) => accountIdByPlatformId(summary, pid),
  };
}

export interface SeedSignalLeadInput {
  user: string;
  /** owning account (platform id); omitted → no assignment */
  owner?: string | null;
  text?: string;
  post_title?: string;
  intent?: AutomotiveIntent;
  score?: number;
  stage?: LeadStage;
  data_mode?: DataMode;
}

/** A lead with a real-looking public comment signal on a public post (provenance URL), optionally assigned. */
export function seedSignalLead(w: World, input: SeedSignalLeadInput): Lead {
  const { ctx } = w;
  const now = ctx.clock.iso();
  const intent = input.intent ?? IMMEDIATE_INTENT;
  const lead = seedLead(ctx, { dealer_id: w.dealerId, platform_user_id: input.user, stage: input.stage ?? 'ASSIGNED' });
  const noteId = `note-${input.user}`;
  const post = ctx.db.table('public_posts').insert({
    id: newId('ppost'),
    platform: 'xiaohongshu',
    platform_post_id: noteId,
    xsec_token: 'tok',
    url: `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=tok`,
    title: input.post_title ?? POST_TITLE,
    content: '',
    author_platform_user_id: `author-${input.user}`,
    author_nickname: '车评作者',
    author_profile_url: null,
    ip_location: null,
    tags: [],
    like_count: 0,
    comment_count: 1,
    collect_count: 0,
    published_at: now,
    own_post_id: null,
    first_search_run_id: null,
    fetched_at: now,
    raw: {},
    data_mode: input.data_mode ?? 'live',
  });
  const signal = ctx.db.table('lead_signals').insert({
    id: newId('sig'),
    lead_id: lead.id,
    source_type: 'comment',
    public_post_id: post.id,
    public_comment_id: null,
    post_title: input.post_title ?? POST_TITLE,
    content: input.text ?? BUYER_TEXT,
    signal_at: now,
    search_run_id: null,
    query_id: null,
    intent,
    signal_score: input.score ?? 96,
    evidence: [],
    engine: 'rules',
    is_purchase_signal: true,
    strength: 1,
    transaction_questions: [],
    author_role: 'asker',
    actor_type: 'BUYER',
    created_at: now,
  });
  const score = input.score ?? 96;
  const updated = ctx.db.table('leads').update(lead.id, {
    intent,
    score,
    tier: score >= 92 ? 'immediate' : score >= 80 ? 'high_intent' : score >= 60 ? 'qualified' : 'candidate',
    primary_signal_id: signal.id,
    username: `用户${input.user}`,
    profile_url: `https://www.xiaohongshu.com/user/profile/${input.user}`,
    data_mode: input.data_mode ?? 'live',
    actor_type: 'BUYER',
  });
  if (input.owner) seedAssignment(ctx, { lead_id: lead.id, account_id: w.account(input.owner) });
  return updated;
}

export function setDealerSetting(w: World, patch: Record<string, unknown>): void {
  const dealer = w.ctx.db.table('dealers').require(w.dealerId);
  w.ctx.db.table('dealers').update(w.dealerId, { settings: { ...dealer.settings, ...patch } });
}
