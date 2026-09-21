import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AppContext } from '../../src/app/context.ts';
import { newId } from '../../src/core/ids.ts';
import type {
  Appointment,
  Conversation,
  ConversationMessage,
  Conversion,
  Lead,
  LeadAssignment,
  LeadStage,
  Outreach,
  OutreachStatus,
  Post,
} from '../../src/core/types.ts';
import {
  importDealerBrain,
  parseDealerBrainBundle,
  type DealerBrainBundle,
  type ImportSummary,
} from '../../src/skills/operations/dealer-brain/index.ts';

export const DEALER_FIXTURE_PATH = fileURLToPath(new URL('../../fixtures/dealers/hangzhou-bmw-group.json', import.meta.url));

/** Parsed + validated canonical dealer fixture (fresh object on every call, safe to mutate). */
export function readDealerFixture(): DealerBrainBundle {
  return parseDealerBrainBundle(JSON.parse(readFileSync(DEALER_FIXTURE_PATH, 'utf8')));
}

/** Imports fixtures/dealers/hangzhou-bmw-group.json into the context's database. */
export function loadDealerFixture(ctx: AppContext): ImportSummary {
  return importDealerBrain(ctx, readDealerFixture());
}

export function dealerIdByKey(summary: ImportSummary, key: string): string {
  const id = summary.dealer_ids[key];
  if (!id) throw new Error(`fixture: unknown dealer key ${key}`);
  return id;
}

export function accountIdByPlatformId(summary: ImportSummary, platformAccountId: string): string {
  const id = summary.account_ids[platformAccountId];
  if (!id) throw new Error(`fixture: unknown platform_account_id ${platformAccountId}`);
  return id;
}

export function vehicleIdByKey(summary: ImportSummary, key: string): string {
  const id = summary.vehicle_ids[key];
  if (!id) throw new Error(`fixture: unknown vehicle key ${key}`);
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal sales-data seeders for tests that need history (leads, outreach, replies, …)
// ─────────────────────────────────────────────────────────────────────────────

export function seedLead(
  ctx: AppContext,
  input: { dealer_id: string; platform_user_id: string; stage?: LeadStage; suppressed?: boolean; at?: string },
): Lead {
  const dealer = ctx.db.table('dealers').require(input.dealer_id);
  const at = input.at ?? ctx.clock.iso();
  return ctx.db.table('leads').insert({
    id: newId('lead'),
    group_id: dealer.group_id,
    dealer_id: dealer.id,
    platform: 'xiaohongshu',
    platform_user_id: input.platform_user_id,
    username: input.platform_user_id,
    profile_url: null,
    avatar_url: null,
    stage: input.stage ?? 'QUALIFIED',
    score: 70,
    tier: 'qualified',
    intent: {},
    evidence: [],
    primary_signal_id: null,
    signal_count: 1,
    first_seen_at: at,
    last_signal_at: at,
    suppressed: input.suppressed ?? false,
    suppression_reason: null,
    contact: {},
    lost_reason: null,
    estimated_value: 0,
    attributed_post_id: null,
    attributed_query_id: null,
    next_action: null,
    created_at: at,
    updated_at: at,
  });
}

export function seedAssignment(
  ctx: AppContext,
  input: { lead_id: string; account_id: string; active?: boolean; at?: string; released_at?: string | null },
): LeadAssignment {
  const at = input.at ?? ctx.clock.iso();
  return ctx.db.table('lead_assignments').insert({
    id: newId('asg'),
    lead_id: input.lead_id,
    account_id: input.account_id,
    active: input.active ?? true,
    reason: 'test',
    candidates: [],
    assigned_by: 'agent:fleet-controller',
    assigned_at: at,
    released_at: input.released_at ?? null,
    released_reason: input.released_at ? 'test release' : null,
  });
}

export function seedOutreach(
  ctx: AppContext,
  input: { lead_id: string; account_id: string; assignment_id: string; status?: OutreachStatus; sent_at?: string | null; kind?: 'first_touch' | 'follow_up' },
): Outreach {
  const status = input.status ?? 'SENT';
  const sentAt = input.sent_at === undefined ? (status === 'SENT' || status === 'SENT_MANUALLY' ? ctx.clock.iso() : null) : input.sent_at;
  const now = ctx.clock.iso();
  return ctx.db.table('outreach').insert({
    id: newId('out'),
    lead_id: input.lead_id,
    account_id: input.account_id,
    assignment_id: input.assignment_id,
    kind: input.kind ?? 'first_touch',
    message: '您好，看到您在关注宝马i3，有需要可以随时问我。',
    personalization: [],
    fact_refs: [],
    guard_results: [],
    approval_policy: 'REVIEW_REQUIRED',
    status,
    capability_status: 'UNAVAILABLE',
    provider_message_id: status === 'SENT' ? newId('pmsg') : null,
    blocked_reason: null,
    approved_by: null,
    approved_at: null,
    sent_at: sentAt,
    engine: 'rules',
    created_at: sentAt ?? now,
    updated_at: sentAt ?? now,
  });
}

export function seedInboundReply(
  ctx: AppContext,
  input: { lead_id: string; account_id: string; at?: string; content?: string },
): { conversation: Conversation; message: ConversationMessage } {
  const at = input.at ?? ctx.clock.iso();
  const conversations = ctx.db.table('conversations');
  const conversation =
    conversations.findOne({ lead_id: input.lead_id, account_id: input.account_id }) ??
    conversations.insert({
      id: newId('conv'),
      lead_id: input.lead_id,
      account_id: input.account_id,
      status: 'open',
      slots: {},
      ai_turns: 0,
      needs_human: false,
      handoff_reason: null,
      last_message_at: at,
      created_at: at,
      updated_at: at,
    });
  const message = ctx.db.table('conversation_messages').insert({
    id: newId('msg'),
    conversation_id: conversation.id,
    direction: 'inbound',
    content: input.content ?? '有现车吗？',
    intents: [],
    extracted: {},
    status: 'received',
    fact_refs: [],
    provider_message_id: null,
    engine: 'rules',
    created_at: at,
  });
  return { conversation, message };
}

export function seedAppointment(
  ctx: AppContext,
  input: { lead_id: string; dealer_id: string; account_id: string; at?: string; status?: Appointment['status'] },
): Appointment {
  const at = input.at ?? ctx.clock.iso();
  return ctx.db.table('appointments').insert({
    id: newId('appt'),
    lead_id: input.lead_id,
    dealer_id: input.dealer_id,
    account_id: input.account_id,
    conversation_id: null,
    scheduled_for: null,
    time_text: '这周六下午',
    store: '杭州宝马中心',
    vehicle_interest: 'BMW i3 eDrive35L',
    status: input.status ?? 'proposed',
    notes: '',
    created_at: at,
    updated_at: at,
  });
}

export function seedConversion(
  ctx: AppContext,
  input: { lead_id: string; dealer_id: string; account_id: string | null; outcome?: 'won' | 'lost'; at?: string },
): Conversion {
  return ctx.db.table('conversions').insert({
    id: newId('cvn'),
    lead_id: input.lead_id,
    dealer_id: input.dealer_id,
    outcome: input.outcome ?? 'won',
    vehicle_id: null,
    amount: null,
    lost_reason: input.outcome === 'lost' ? '价格' : null,
    attributed_post_id: null,
    attributed_query_id: null,
    account_id: input.account_id,
    occurred_at: input.at ?? ctx.clock.iso(),
  });
}

export function seedSuppression(ctx: AppContext, platformUserId: string, at?: string): void {
  ctx.db.table('contact_suppressions').insert({
    id: newId('sup'),
    platform: 'xiaohongshu',
    platform_user_id: platformUserId,
    reason: '用户回复：不需要，别再发了',
    source: 'test',
    created_at: at ?? ctx.clock.iso(),
  });
}

export function seedPublishedPost(
  ctx: AppContext,
  input: { dealer_id: string; account_id: string; published_at?: string; likes?: number; collects?: number; comments?: number; shares?: number },
): Post {
  const at = input.published_at ?? ctx.clock.iso();
  return ctx.db.table('posts').insert({
    id: newId('post'),
    dealer_id: input.dealer_id,
    account_id: input.account_id,
    plan_id: null,
    slot_date: at.slice(0, 10),
    pillar: 'model_review',
    topic: 'i3:model_review:hangzhou',
    angle: '',
    model: 'i3',
    title: '宝马i3一周通勤体验',
    body: '正文',
    tags: [],
    cover_text: '',
    fact_refs: [],
    status: 'PUBLISHED',
    review: null,
    approval_policy: 'REVIEW_REQUIRED',
    platform_note_id: null,
    scheduled_for: null,
    published_at: at,
    metrics: {
      views: 0,
      likes: input.likes ?? 0,
      collects: input.collects ?? 0,
      comments: input.comments ?? 0,
      shares: input.shares ?? 0,
    },
    metrics_updated_at: at,
    engine: 'rules',
    created_at: at,
    updated_at: at,
  });
}
