/**
 * Content → lead attribution (spec §16): for every PUBLISHED post, the comments, commenter profiles, leads,
 * qualified leads, conversations, appointments and sales it generated — ranked by sales, not likes.
 *
 * Attribution is single-touch so rows can be summed: a lead belongs to `lead.attributed_post_id` when set, otherwise
 * to the own post of its earliest signal on one of our published notes. A won conversion is credited to
 * `conversions.attributed_post_id` when recorded, else to its lead's post.
 */
import type { AppContext } from '../../../app/context.ts';
import type { Post } from '../../../core/types.ts';
import { STAGE_INDEX } from '../crm/index.ts';
import {
  chunked,
  joinAnd,
  normalizeFilters,
  num,
  placeholders,
  postScope,
  reachedStageSql,
  stageIndexSql,
  type SqlFragment,
} from './filters.ts';
import type { AnalyticsFilters, ContentAttributionRow } from './types.ts';

const CHUNK = 400;

const finite = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

function engagementOf(post: Post): number {
  const m = post.metrics;
  return finite(m?.likes) + finite(m?.collects) + finite(m?.comments) + finite(m?.shares);
}

/**
 * True when a public comment (alias `pc`) was written by one of our managed accounts: the legacy account key
 * (`platform_account_id`) or the Xiaohongshu user id verified from the logged-in session (`platform_user_id`, v3).
 */
const MANAGED_COMMENT_AUTHOR = `(pc.author_platform_user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM xhs_accounts x
  WHERE x.platform_account_id = pc.author_platform_user_id OR x.platform_user_id = pc.author_platform_user_id))`;

/** Resolves the public post a signal belongs to (comment signals may only carry the comment id). */
const SIGNAL_PUBLIC_POST_JOIN = `LEFT JOIN public_comments spc ON spc.id = s.public_comment_id
  JOIN public_posts pp ON pp.id = COALESCE(s.public_post_id, spc.public_post_id)`;

export function getContentAttribution(ctx: AppContext, f: AnalyticsFilters = {}): ContentAttributionRow[] {
  const n = normalizeFilters(ctx, f);
  const db = ctx.db;
  const parts: SqlFragment[] = [{ sql: `p.status = 'PUBLISHED'`, params: [] }, postScope(n, 'p')];
  if (n.from !== undefined) parts.push({ sql: 'p.published_at >= ?', params: [n.from] });
  if (n.to !== undefined) parts.push({ sql: 'p.published_at < ?', params: [n.to] });
  const where = joinAnd(parts);
  const postTable = db.table('posts');
  const posts = db.all(`SELECT p.* FROM posts p WHERE ${where.sql}`, ...where.params).map((row) => postTable.decode(row));
  if (posts.length === 0) return [];

  const postIds = posts.map((p) => p.id);
  const postIdSet = new Set(postIds);

  const accountIds = [...new Set(posts.map((p) => p.account_id))];
  const nicknames = new Map(
    chunked(accountIds, CHUNK, (chunk) =>
      db.all<{ id: string; nickname: string }>(`SELECT id, nickname FROM xhs_accounts WHERE id IN (${placeholders(chunk.length)})`, ...chunk),
    ).map((r) => [r.id, r.nickname]),
  );

  // Customer comments and distinct commenters on the matching public_posts rows. Replies written by our own managed
  // accounts (matched by the account key or the verified Xiaohongshu user id) are neither comments the content generated
  // nor commenter profiles.
  const commentStats = new Map<string, { comments: number; commenters: number }>();
  for (const row of chunked(postIds, CHUNK, (chunk) =>
    db.all(
      `SELECT pp.own_post_id AS post_id,
              COUNT(CASE WHEN NOT ${MANAGED_COMMENT_AUTHOR} THEN 1 END) AS comments,
              COUNT(DISTINCT CASE WHEN pc.author_platform_user_id IS NOT NULL AND NOT ${MANAGED_COMMENT_AUTHOR}
                THEN pc.author_platform_user_id END) AS commenters
       FROM public_posts pp JOIN public_comments pc ON pc.public_post_id = pp.id
       WHERE pp.own_post_id IN (${placeholders(chunk.length)})
       GROUP BY pp.own_post_id`,
      ...chunk,
    ),
  )) {
    commentStats.set(String(row.post_id), { comments: num(row, 'comments'), commenters: num(row, 'commenters') });
  }

  // Lead attribution: explicit attributed_post_id, else the earliest signal on any of our own notes.
  const leadPost = new Map<string, string>();
  for (const row of chunked(postIds, CHUNK, (chunk) =>
    db.all<{ lead_id: string; post_id: string }>(
      `SELECT id AS lead_id, attributed_post_id AS post_id FROM leads WHERE attributed_post_id IN (${placeholders(chunk.length)})`,
      ...chunk,
    ),
  )) {
    leadPost.set(row.lead_id, row.post_id);
  }
  const implicitCandidates = [
    ...new Set(
      chunked(postIds, CHUNK, (chunk) =>
        db.all<{ lead_id: string }>(
          `SELECT DISTINCT s.lead_id AS lead_id FROM lead_signals s
             JOIN leads l ON l.id = s.lead_id
             ${SIGNAL_PUBLIC_POST_JOIN}
           WHERE l.attributed_post_id IS NULL AND pp.own_post_id IN (${placeholders(chunk.length)})`,
          ...chunk,
        ),
      ).map((r) => r.lead_id),
    ),
  ];
  const firstTouch = new Map<string, string>();
  for (const row of chunked(implicitCandidates, CHUNK, (chunk) =>
    db.all<{ lead_id: string; post_id: string }>(
      `SELECT s.lead_id AS lead_id, pp.own_post_id AS post_id FROM lead_signals s
         ${SIGNAL_PUBLIC_POST_JOIN}
       WHERE s.lead_id IN (${placeholders(chunk.length)}) AND pp.own_post_id IS NOT NULL
       ORDER BY s.lead_id ASC, s.signal_at ASC, s.created_at ASC, s.rowid ASC`,
      ...chunk,
    ),
  )) {
    if (!firstTouch.has(row.lead_id)) firstTouch.set(row.lead_id, row.post_id);
  }
  for (const [leadId, postId] of firstTouch) if (postIdSet.has(postId)) leadPost.set(leadId, postId);

  // Outcomes of attributed leads.
  const qIdx = STAGE_INDEX.QUALIFIED;
  const deepNonTerminal = (col: string) => `(${col} NOT IN ('WON', 'LOST') AND ${stageIndexSql(col)} >= ${qIdx})`;
  const leadIds = [...leadPost.keys()];
  const leadStats = new Map<string, { stage: string; qualified: boolean; conversations: number; appointments: number }>();
  for (const row of chunked(leadIds, CHUNK, (chunk) =>
    db.all(
      `SELECT l.id AS id, l.stage AS stage,
              CASE WHEN ${reachedStageSql('QUALIFIED', 'l.stage')} OR EXISTS (
                SELECT 1 FROM lead_stage_transitions t
                WHERE t.lead_id = l.id AND (${deepNonTerminal('t.to_stage')} OR ${deepNonTerminal('t.from_stage')})
              ) THEN 1 ELSE 0 END AS qualified,
              (SELECT COUNT(*) FROM conversations c WHERE c.lead_id = l.id) AS conversations,
              (SELECT COUNT(*) FROM appointments a WHERE a.lead_id = l.id AND a.status <> 'cancelled') AS appointments
       FROM leads l WHERE l.id IN (${placeholders(chunk.length)})`,
      ...chunk,
    ),
  )) {
    leadStats.set(String(row.id), {
      stage: String(row.stage),
      qualified: num(row, 'qualified') === 1,
      conversations: num(row, 'conversations'),
      appointments: num(row, 'appointments'),
    });
  }

  // Won conversions credited to one of these posts, plus EVERY won conversion of the attributed leads (so a sale recorded
  // against another post is never credited a second time to the lead's post). Keyed by conversion id: no double rows.
  type WonRow = { id: string; lead_id: string; post_id: string | null; amount: number | null };
  const wonById = new Map<string, WonRow>();
  for (const row of chunked(postIds, CHUNK, (chunk) =>
    db.all<WonRow>(
      `SELECT id, lead_id, attributed_post_id AS post_id, amount FROM conversions
       WHERE outcome = 'won' AND attributed_post_id IN (${placeholders(chunk.length)})`,
      ...chunk,
    ),
  ))
    wonById.set(row.id, row);
  for (const row of chunked(leadIds, CHUNK, (chunk) =>
    db.all<WonRow>(
      `SELECT id, lead_id, attributed_post_id AS post_id, amount FROM conversions
       WHERE outcome = 'won' AND lead_id IN (${placeholders(chunk.length)})`,
      ...chunk,
    ),
  ))
    wonById.set(row.id, row);
  const leadsWithWonConversion = new Set([...wonById.values()].map((r) => r.lead_id));

  interface Acc {
    leads: number;
    qualified: number;
    conversations: number;
    appointments: number;
    wonLeads: Set<string>;
    wonValue: number;
  }
  const acc = new Map<string, Acc>(
    postIds.map((id) => [id, { leads: 0, qualified: 0, conversations: 0, appointments: 0, wonLeads: new Set<string>(), wonValue: 0 }]),
  );
  for (const [leadId, postId] of leadPost) {
    const a = acc.get(postId);
    const stats = leadStats.get(leadId);
    if (!a || !stats) continue;
    a.leads++;
    if (stats.qualified) a.qualified++;
    a.conversations += stats.conversations;
    a.appointments += stats.appointments;
    // a WON lead without any won conversion row still counts (value unknown → 0); otherwise the conversion decides the post
    if (stats.stage === 'WON' && !leadsWithWonConversion.has(leadId)) a.wonLeads.add(leadId);
  }
  for (const row of wonById.values()) {
    const postId = row.post_id ?? leadPost.get(row.lead_id);
    const a = postId ? acc.get(postId) : undefined;
    if (!a) continue;
    a.wonLeads.add(row.lead_id);
    a.wonValue += finite(row.amount);
  }

  const rows: ContentAttributionRow[] = posts.map((post) => {
    const a = acc.get(post.id) as Acc;
    const comments = commentStats.get(post.id);
    return {
      post_id: post.id,
      dealer_id: post.dealer_id,
      account_id: post.account_id,
      account_nickname: nicknames.get(post.account_id) ?? '',
      title: post.title,
      pillar: post.pillar,
      model: post.model,
      published_at: post.published_at,
      platform_note_id: post.platform_note_id,
      views: finite(post.metrics?.views),
      engagement: engagementOf(post),
      comments_collected: comments?.comments ?? 0,
      commenter_profiles: comments?.commenters ?? 0,
      leads: a.leads,
      qualified_leads: a.qualified,
      conversations: a.conversations,
      appointments: a.appointments,
      won: a.wonLeads.size,
      won_value: a.wonValue,
    };
  });
  rows.sort(
    (x, y) =>
      y.won - x.won ||
      y.appointments - x.appointments ||
      y.qualified_leads - x.qualified_leads ||
      y.engagement - x.engagement ||
      (y.published_at ?? '').localeCompare(x.published_at ?? '') ||
      x.post_id.localeCompare(y.post_id),
  );
  return rows;
}
