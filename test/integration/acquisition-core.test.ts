/**
 * Wave B integration gate — the REAL lead-acquisition core over the simulation corpus, end to end, without the
 * discovery orchestration: dealer fixture + SimulationXhsProvider → every public note author and comment (replies
 * included) → evaluateSignalForDealers over the group (§5.3) → minimal public_posts / public_comments provenance rows
 * → upsertLeadFromSignal (B1) → assignLead (B5) → analytics (B4); then query generation (B2), content planning and
 * Xiaohongshu research (B3) on the same database.
 *
 * Nothing is stubbed: rules NLU, scoring, dedup, Fleet Controller, analytics, planning and research are the
 * production modules; only the ingestion loop (normally lead-discovery) is written out here.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';
import { isVerbatimQuote } from '../../src/core/evidence.ts';
import { findModels } from '../../src/domain/automotive-lexicon.ts';
import { newId } from '../../src/core/ids.ts';
import { DEFAULT_TZ, addDaysToKey, localDateKey, localParts } from '../../src/core/time.ts';
import type { Lead, LeadSignal, Post, PublicComment, PublicPost, SignalContext, SignalSourceType } from '../../src/core/types.ts';
import {
  DEFAULT_SIMULATION_CORPUS_PATH,
  SimulationXhsProvider,
  parseSimulationCorpus,
  type SimComment,
  type SimNote,
} from '../../src/providers/xhs/simulation.ts';
import type { XhsComment } from '../../src/providers/xhs/types.ts';
import { assignLead, getActiveAssignment, type AssignLeadResult } from '../../src/skills/acquisition/account-assignment/index.ts';
import { GENERATED_QUERY_CLASSES, generateQueries } from '../../src/skills/acquisition/automotive-query-generation/index.ts';
import { isNonBuyerRole, prefilter } from '../../src/skills/acquisition/intent-detection/nlu.ts';
import {
  findLeadByIdentity,
  isPurchaseDetection,
  upsertLeadFromSignal,
  type UpsertLeadResult,
} from '../../src/skills/acquisition/lead-deduplication/index.ts';
import {
  evaluateSignalForDealers,
  getScoringConfig,
  listGroupDealerIds,
  type DealerSignalEvaluation,
} from '../../src/skills/acquisition/lead-scoring/index.ts';
import { CANNIBALIZATION_WINDOW_DAYS, dayDiff, planContent } from '../../src/skills/content/content-planning/index.ts';
import { MAX_INBOX_LIMIT, getContentAttribution, getDashboard, getFunnel, getLeadInbox } from '../../src/skills/operations/analytics/index.ts';
import { runXhsResearch } from '../../src/skills/research/xhs-research/index.ts';
import { round } from '../../src/core/text.ts';
import { LEAD_STAGES } from '../../src/core/types.ts';
import { STAGE_INDEX } from '../../src/skills/operations/crm/index.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { accountIdByPlatformId, dealerIdByKey, loadDealerFixture, seedPublishedPost } from '../helpers/fixtures.ts';

const BUYER = 'u-hz-buyer-001'; // 西湖边的小鹿 — comments on ≥3 notes (dedup canon, ARCHITECTURE §9)
const BUYER_PRIMARY = '杭州i3 35L白外红内有现车吗？这周想去看看';
const X3_PRICE_ASKER = 'u-hz-x3-001'; // 余杭的周周 — "X3 25L现在多少钱"
const SPAMMER = 'u-dealer-spam-001'; // 宝马顾问小陈 — competitor salesperson, never a lead
const SHENZHEN_ASKER = 'u-gd-buyer-001'; // 深圳湾跑步的阿辉 (F3)
/** docs/PREVIEW_FINDINGS.md F1/F2/F5: informers and owners the preview wrongly scored as buyers. */
const NON_BUYER_AUTHORS: Record<string, string> = {
  'u-hz-guide-kol-001': '杭州买车指南针',
  'u-hz-blogger-001': '杭州小众探店车',
  'u-kol-ev-001': '电车老司机阿杰',
  'u-kol-suv-001': 'SUV测评君',
  'u-owner-story-001': '第一次买宝马的Coco',
  'u-owner-i3-001': 'i3车主小严',
};
const OWN_NOTES = [
  { note: 'note-own-hz-i3-001', account: 'xhs-hz-i3', model: 'i3' },
  { note: 'note-own-hz-x3-001', account: 'xhs-hz-sales-li', model: 'X3' },
] as const;

interface CorpusItem {
  kind: Extract<SignalSourceType, 'post' | 'comment'>;
  note_id: string;
  author_id: string;
  nickname: string;
  text: string;
  signal_at: string;
  public_post: PublicPost;
  public_comment: PublicComment | null;
  managed: boolean;
  evaluation: { results: DealerSignalEvaluation[]; best: DealerSignalEvaluation } | null;
  upsert: UpsertLeadResult | null;
}

interface Harness {
  ctx: TestContext;
  hz: string;
  sh: string;
  groupId: string;
  acc: (platformAccountId: string) => string;
  notesById: Map<string, SimNote>;
  commentsById: Map<string, SimComment>;
  visibleComments: number;
  items: CorpusItem[];
  ownPosts: Map<string, Post>;
  /** QUALIFIED leads right after ingestion (before the Fleet Controller ran) */
  qualifiedBeforeAssignment: Lead[];
  /** CANDIDATE leads right after ingestion */
  candidatesBeforeAssignment: Lead[];
  assignments: Map<string, AssignLeadResult>;
}

function flatten(list: readonly XhsComment[], parentId: string | null = null, out: XhsComment[] = []): XhsComment[] {
  for (const c of list) {
    if (!out.some((x) => x.platform_comment_id === c.platform_comment_id)) out.push({ ...c, parent_comment_id: c.parent_comment_id ?? parentId });
    flatten(c.sub_comments ?? [], c.platform_comment_id, out);
  }
  return out;
}

function indexCorpus(notes: readonly SimNote[]): { notesById: Map<string, SimNote>; commentsById: Map<string, SimComment> } {
  const notesById = new Map<string, SimNote>();
  const commentsById = new Map<string, SimComment>();
  const walk = (list: readonly SimComment[]) => {
    for (const c of list) {
      commentsById.set(c.platform_comment_id, c);
      walk(c.sub_comments);
    }
  };
  for (const n of notes) {
    notesById.set(n.platform_post_id, n);
    walk(n.comments);
  }
  return { notesById, commentsById };
}

async function runChain(): Promise<Harness> {
  const ctx = createTestContext();
  ctx.xhs = SimulationXhsProvider.fromFile(ctx.clock);
  const summary = loadDealerFixture(ctx);
  const hz = dealerIdByKey(summary, 'hz-bmw');
  const sh = dealerIdByKey(summary, 'sh-bmw');
  const acc = (pid: string) => accountIdByPlatformId(summary, pid);
  const groupId = ctx.db.table('dealers').require(hz).group_id;
  const groupIds = listGroupDealerIds(ctx, hz);
  const managed = new Set(ctx.db.table('xhs_accounts').findMany({ group_id: groupId }).map((a) => a.platform_account_id));

  const corpus = parseSimulationCorpus(JSON.parse(readFileSync(DEFAULT_SIMULATION_CORPUS_PATH, 'utf8')));
  const { notesById, commentsById } = indexCorpus(corpus.notes);
  const nowMs = ctx.clock.now().getTime();
  const visibleComments = [...commentsById.values()].filter((c) => Date.parse(c.published_at) <= nowMs).length;

  // our own published notes (content → lead attribution, spec §16)
  const ownPosts = new Map<string, Post>();
  for (const own of OWN_NOTES) {
    const note = notesById.get(own.note);
    assert.ok(note, `corpus note ${own.note}`);
    const seeded = seedPublishedPost(ctx, { dealer_id: hz, account_id: acc(own.account), published_at: note.published_at });
    ownPosts.set(
      own.note,
      ctx.db.table('posts').update(seeded.id, { platform_note_id: own.note, title: note.title, model: own.model, topic: `${own.model}:model_review:hangzhou` }),
    );
  }

  const items: CorpusItem[] = [];
  for (const note of corpus.notes) {
    const ref = { platform_post_id: note.platform_post_id, xsec_token: note.xsec_token };
    const detail = await ctx.xhs.getNote(ref);
    assert.ok(detail.ok, `getNote ${note.platform_post_id}`);
    const comments = await ctx.xhs.getComments(ref, { include_replies: true, limit: 1000 });
    assert.ok(comments.ok, `getComments ${note.platform_post_id}`);
    const d = detail.data;
    const post = ctx.db.table('public_posts').insert({
      id: newId('ppost'),
      platform: 'xiaohongshu',
      platform_post_id: d.platform_post_id,
      xsec_token: d.xsec_token ?? null,
      url: d.url ?? null,
      title: d.title,
      content: d.content,
      author_platform_user_id: d.author.platform_user_id,
      author_nickname: d.author.nickname,
      author_profile_url: null,
      ip_location: d.ip_location,
      tags: d.tags,
      like_count: d.like_count,
      comment_count: d.comment_count,
      collect_count: d.collect_count,
      published_at: d.published_at ?? null,
      data_mode: 'simulation',
      own_post_id: ownPosts.get(d.platform_post_id)?.id ?? null,
      first_search_run_id: null,
      fetched_at: ctx.clock.iso(),
      raw: {},
    });

    const pending: Omit<CorpusItem, 'managed' | 'evaluation' | 'upsert'>[] = [
      {
        kind: 'post',
        note_id: d.platform_post_id,
        author_id: d.author.platform_user_id ?? '',
        nickname: d.author.nickname ?? '',
        text: `${d.title}\n${d.content}`,
        signal_at: d.published_at ?? ctx.clock.iso(),
        public_post: post,
        public_comment: null,
      },
    ];
    const contexts = new Map<string, SignalContext>();
    contexts.set(`post:${d.platform_post_id}`, {
      source_type: 'post',
      post_title: d.title,
      ip_location: d.ip_location,
      author_nickname: d.author.nickname,
    });
    for (const c of flatten(comments.data)) {
      const context: SignalContext = {
        source_type: 'comment',
        post_title: d.title,
        post_content: d.content,
        ip_location: c.ip_location,
        author_nickname: c.author.nickname,
      };
      const pf = prefilter(c.content, context);
      const row = ctx.db.table('public_comments').insert({
        id: newId('pcmt'),
        platform: 'xiaohongshu',
        platform_comment_id: c.platform_comment_id,
        public_post_id: post.id,
        parent_comment_id: c.parent_comment_id,
        author_platform_user_id: c.author.platform_user_id,
        author_nickname: c.author.nickname,
        content: c.content,
        ip_location: c.ip_location,
        like_count: c.like_count,
        published_at: c.published_at,
        data_mode: 'simulation',
        prefilter_passed: pf.passed,
        prefilter_reason: pf.reason,
        first_search_run_id: null,
        fetched_at: ctx.clock.iso(),
        raw: {},
      });
      contexts.set(`comment:${c.platform_comment_id}`, context);
      pending.push({
        kind: 'comment',
        note_id: d.platform_post_id,
        author_id: c.author.platform_user_id ?? '',
        nickname: c.author.nickname ?? '',
        text: c.content,
        signal_at: c.published_at ?? ctx.clock.iso(),
        public_post: post,
        public_comment: row,
      });
    }

    for (const p of pending) {
      const isManaged = managed.has(p.author_id);
      const item: CorpusItem = { ...p, managed: isManaged, evaluation: null, upsert: null };
      items.push(item);
      if (!p.author_id || isManaged) continue;
      const context = contexts.get(p.public_comment ? `comment:${p.public_comment.platform_comment_id}` : `post:${p.note_id}`)!;
      item.evaluation = evaluateSignalForDealers(ctx, {
        dealer_ids: groupIds,
        text: p.text,
        context,
        signal_at: p.signal_at,
        preferred_dealer_id: hz,
      });
      const { best } = item.evaluation;
      if (!isPurchaseDetection(best.detection) || best.score < getScoringConfig(ctx, best.dealer_id).thresholds.candidate) continue;
      item.upsert = upsertLeadFromSignal(ctx, {
        dealer_id: best.dealer_id,
        identity: { platform_user_id: p.author_id, username: p.nickname || p.author_id },
        signal: {
          source_type: p.kind,
          public_post_id: post.id,
          public_comment_id: p.public_comment?.id ?? null,
          post_title: d.title,
          content: p.text,
          signal_at: p.signal_at,
          detection: best.detection,
        },
        attributed_post_id: post.own_post_id,
      });
    }
  }

  const leadsTable = ctx.db.table('leads');
  const qualifiedBeforeAssignment = leadsTable.findMany({ stage: 'QUALIFIED' }, { orderBy: 'score DESC, created_at ASC, id ASC' });
  const candidatesBeforeAssignment = leadsTable.findMany({ stage: 'CANDIDATE' }, { orderBy: 'score DESC, id ASC' });
  const assignments = new Map<string, AssignLeadResult>();
  for (const lead of qualifiedBeforeAssignment) assignments.set(lead.id, assignLead(ctx, lead.id));

  return {
    ctx,
    hz,
    sh,
    groupId,
    acc,
    notesById,
    commentsById,
    visibleComments,
    items,
    ownPosts,
    qualifiedBeforeAssignment,
    candidatesBeforeAssignment,
    assignments,
  };
}

describe('integration: acquisition core over the simulation corpus (B1 · B2 · B3 · B4 · B5)', () => {
  let h: Harness;
  before(async () => {
    h = await runChain();
  });

  const leadOf = (platformUserId: string): Lead | undefined => findLeadByIdentity(h.ctx, h.groupId, platformUserId);
  const signalsOf = (leadId: string): LeadSignal[] =>
    h.ctx.db.table('lead_signals').findMany({ lead_id: leadId }, { orderBy: 'signal_at ASC, created_at ASC' });
  const accountOf = (accountId: string) => h.ctx.db.table('xhs_accounts').require(accountId);
  const activeCount = (leadId: string): number =>
    Number(h.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM lead_assignments WHERE lead_id = ? AND active = 1', leadId)?.n ?? -1);
  const thresholds = (dealerId: string) => getScoringConfig(h.ctx, dealerId).thresholds;

  it('reads every corpus note and comment (replies included) through the provider and skips managed accounts', () => {
    assert.equal(h.ctx.db.table('public_posts').count(), h.notesById.size, 'one provenance row per note');
    assert.equal(h.ctx.db.table('public_comments').count(), h.visibleComments, 'every published comment and reply');
    assert.ok(h.visibleComments >= 100, `${h.visibleComments} comments`);
    assert.ok(h.items.some((i) => i.public_comment?.parent_comment_id), 'replies are evaluated too');

    const managedItems = h.items.filter((i) => i.managed);
    assert.deepEqual([...new Set(managedItems.map((i) => i.author_id))].sort(), ['xhs-hz-i3', 'xhs-hz-sales-li'], 'our own notes are not leads');
    for (const pid of ['xhs-hz-i3', 'xhs-hz-sales-li', 'xhs-hz-official', 'xhs-sh-official']) assert.equal(leadOf(pid), undefined, pid);

    for (const lead of h.ctx.db.table('leads').findMany({})) {
      for (const s of signalsOf(lead.id)) {
        assert.ok(s.public_post_id, `signal ${s.id} links its note`);
        const post = h.ctx.db.table('public_posts').require(s.public_post_id);
        assert.equal(s.post_title, post.title);
        if (s.source_type === 'comment') {
          const comment = h.ctx.db.table('public_comments').require(s.public_comment_id!);
          assert.equal(comment.author_platform_user_id, lead.platform_user_id, 'identity resolution never crosses users');
          assert.equal(s.content, comment.content, 'verbatim comment text');
          assert.equal(s.content, h.commentsById.get(comment.platform_comment_id)?.content, 'verbatim corpus text');
        } else {
          assert.equal(post.author_platform_user_id, lead.platform_user_id);
          assert.equal(s.content, `${post.title}\n${post.content}`);
        }
      }
    }
  });

  it('merges u-hz-buyer-001 across notes into ONE immediate lead whose primary signal is verbatim', () => {
    const count = h.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM leads WHERE platform_user_id = ?', BUYER)?.n;
    assert.equal(Number(count), 1, 'one lead per user per group');
    const lead = leadOf(BUYER);
    assert.ok(lead);
    assert.equal(lead.dealer_id, h.hz);
    assert.equal(lead.username, '西湖边的小鹿');

    const signals = signalsOf(lead.id);
    assert.ok(signals.length >= 3, `${signals.length} merged signals`);
    assert.equal(lead.signal_count, signals.length);
    assert.ok(new Set(signals.map((s) => s.public_post_id)).size >= 3, 'signals from ≥3 different notes');
    assert.ok(signals.every((s) => s.is_purchase_signal && s.author_role === 'asker'));
    assert.equal(lead.tier, 'immediate');
    assert.ok(lead.score >= thresholds(h.hz).immediate, `score ${lead.score}`);

    const primary = signals.find((s) => s.id === lead.primary_signal_id);
    assert.ok(primary, 'primary signal is one of the lead signals');
    assert.equal(primary.content, BUYER_PRIMARY);
    const corpusComment = h.commentsById.get(h.ctx.db.table('public_comments').require(primary.public_comment_id!).platform_comment_id);
    assert.equal(primary.content, corpusComment?.content, 'primary signal is the corpus text, unchanged');
    assert.equal(lead.intent.model, 'i3');
    assert.equal(lead.intent.trim, 'eDrive35L');
    assert.equal(lead.intent.location, '杭州');
    assert.equal(lead.intent.inventory_intent, true);

    // the non-purchase remark on the coffee note never joined the lead
    const remark = h.items.find((i) => i.author_id === BUYER && i.text === '北山街那家我也去过，超出片');
    assert.ok(remark?.evaluation, 'remark was evaluated');
    assert.equal(remark.upsert, null);
    assert.ok(!signals.some((s) => s.content === remark.text));

    const merges = h.ctx.db.table('agent_decisions').findMany({ decision_type: 'lead_dedup_merge', subject_id: lead.id });
    assert.equal(merges.length, signals.length - 1, 'every merged signal is an audited dedup decision');
  });

  it('never creates a lead for the competitor salesperson, content creators or owners (F1 · F2 · §5.1)', () => {
    const spam = h.items.filter((i) => i.author_id === SPAMMER);
    assert.ok(spam.length >= 5, `${spam.length} spam comments evaluated`);
    for (const s of spam) {
      assert.equal(s.nickname, '宝马顾问小陈');
      assert.equal(s.evaluation?.best.detection.author_role, 'marketing', s.text);
      assert.equal(s.upsert, null);
    }
    assert.equal(leadOf(SPAMMER), undefined);

    for (const [authorId, nickname] of Object.entries(NON_BUYER_AUTHORS)) {
      const own = h.items.filter((i) => i.author_id === authorId);
      assert.ok(own.length >= 1, `${nickname} appears in the corpus`);
      for (const i of own) {
        assert.equal(i.nickname, nickname);
        assert.ok(i.evaluation, `${nickname} evaluated`);
        assert.ok(isNonBuyerRole(i.evaluation.best.detection.author_role), `${nickname} "${i.text.slice(0, 24)}" is ${i.evaluation.best.detection.author_role}`);
        assert.equal(i.upsert, null);
      }
      assert.equal(leadOf(authorId), undefined, `${nickname} must not be a lead`);
    }

    // every lead that exists rests on at least one purchase signal by a prospective buyer
    for (const lead of h.ctx.db.table('leads').findMany({})) {
      assert.ok(
        signalsOf(lead.id).some((s) => s.is_purchase_signal && s.author_role === 'asker'),
        `${lead.username} has an asker purchase signal`,
      );
    }
  });

  it('keeps the explicitly out-of-area 深圳 asker below QUALIFIED and unassigned (F3 · §5.2)', () => {
    const lead = leadOf(SHENZHEN_ASKER);
    assert.ok(lead, 'still a (candidate) buyer');
    assert.equal(lead.username, '深圳湾跑步的阿辉');
    assert.equal(lead.intent.location, '深圳');
    assert.ok(lead.score < thresholds(lead.dealer_id).qualified, `score ${lead.score}`);
    assert.ok(STAGE_INDEX[lead.stage] < STAGE_INDEX.QUALIFIED, `stage ${lead.stage}`);
    assert.equal(h.ctx.db.table('lead_stage_transitions').count({ lead_id: lead.id, to_stage: 'QUALIFIED' }), 0);

    const scores = h.ctx.db.table('agent_decisions').findMany({ decision_type: 'lead_score', subject_id: lead.id }, { orderBy: 'created_at DESC' });
    assert.ok(scores.length > 0);
    assert.equal(scores[0].output.out_of_area_capped, true);

    const result = assignLead(h.ctx, lead.id);
    assert.equal(result.assignment, null);
    assert.match(result.reason, /低于合格阈值/);
    assert.equal(activeCount(lead.id), 0);
  });

  it('routes every lead to the best-scoring dealer of the group (§5.3)', () => {
    const shLeads = h.ctx.db.table('leads').findMany({ dealer_id: h.sh });
    assert.deepEqual(shLeads.map((l) => l.platform_user_id).sort(), ['u-sh-buyer-001', 'u-sh-buyer-002']);
    for (const lead of h.ctx.db.table('leads').findMany({})) {
      const creating = h.items.find((i) => i.upsert?.created && i.upsert.lead.id === lead.id);
      assert.ok(creating?.evaluation, `${lead.username}: creating signal`);
      const top = Math.max(...creating.evaluation.results.map((r) => r.score));
      assert.equal(creating.evaluation.best.score, top);
      assert.equal(lead.dealer_id, creating.evaluation.best.dealer_id, `${lead.username} routed to the best dealer`);
      const decision = h.ctx.db.table('agent_decisions').findOne({ decision_type: 'lead_score', subject_id: lead.id });
      const perDealer = decision?.inputs.group_dealer_scores as { dealer_id: string }[] | undefined;
      assert.deepEqual(perDealer?.map((d) => d.dealer_id).sort(), [h.hz, h.sh].sort(), 'per-dealer scores recorded');
    }
  });

  it('keeps every evidence quote verbatim from the signal (or its note / IP 属地) it cites', () => {
    let checked = 0;
    for (const lead of h.ctx.db.table('leads').findMany({})) {
      const signals = new Map(signalsOf(lead.id).map((s) => [s.id, s]));
      const verify = (quote: string, code: string, signal: LeadSignal, label: string) => {
        const post = h.ctx.db.table('public_posts').require(signal.public_post_id!);
        const comment = signal.public_comment_id ? h.ctx.db.table('public_comments').require(signal.public_comment_id) : null;
        const ip = signal.source_type === 'comment' ? comment?.ip_location : post.ip_location;
        let ok: boolean;
        if (code === 'ip_location') ok = isVerbatimQuote([ip], quote); // the author's own IP 属地, never the note author's
        else if (code === 'model_from_post_context') ok = isVerbatimQuote([signal.post_title, post.title, post.content], quote);
        else ok = isVerbatimQuote([signal.content, signal.post_title], quote);
        assert.ok(ok, `${label}: ${code} quote "${quote}" is not verbatim in its source`);
        checked++;
      };
      assert.ok(lead.evidence.length > 0, `${lead.username} keeps evidence`);
      for (const e of lead.evidence) {
        const signal = e.source_ref ? signals.get(e.source_ref) : undefined;
        assert.ok(signal, `${lead.username}: evidence ${e.code} cites a signal of this lead (source_ref ${e.source_ref})`);
        if (e.quote) verify(e.quote, e.code, signal, lead.username);
      }
      for (const s of signals.values()) for (const e of s.evidence) if (e.quote) verify(e.quote, e.code, s, `${lead.username} signal`);
    }
    assert.ok(checked > 100, `${checked} quotes checked`);
  });

  it('assigns every QUALIFIED lead to exactly one account of its own dealer (B5)', () => {
    assert.ok(h.qualifiedBeforeAssignment.length >= 10, `${h.qualifiedBeforeAssignment.length} qualified leads`);
    for (const before of h.qualifiedBeforeAssignment) {
      const result = h.assignments.get(before.id)!;
      assert.ok(result.assignment, `${before.username}: ${result.reason}`);
      assert.equal(result.changed, true);
      assert.equal(activeCount(before.id), 1, `${before.username}: exactly one active owner`);
      const account = accountOf(result.assignment.account_id);
      assert.equal(account.dealer_id, before.dealer_id, `${before.username} → ${account.nickname} stays within its dealer`);
      assert.equal(h.ctx.db.table('leads').require(before.id).stage, 'ASSIGNED');
      const eligible = result.candidates.filter((c) => c.eligible);
      assert.equal(eligible[0]?.account_id, account.id, 'the top eligible candidate owns the lead');

      // idempotent: a second run keeps the owner and never adds a second active assignment
      const again = assignLead(h.ctx, before.id);
      assert.equal(again.changed, false);
      assert.equal(again.assignment?.account_id, account.id);
      assert.equal(activeCount(before.id), 1);
    }
    const dupes = h.ctx.db.all('SELECT lead_id FROM lead_assignments WHERE active = 1 GROUP BY lead_id HAVING COUNT(*) > 1');
    assert.deepEqual(dupes, []);
    assert.equal(h.ctx.db.table('lead_assignments').count({ active: true }), h.qualifiedBeforeAssignment.length);
    for (const c of h.candidatesBeforeAssignment) assert.equal(activeCount(c.id), 0, `${c.username} (candidate) is not assigned`);
  });

  it('gives the 杭州 i3 inventory lead to 销售小王, an X3 price lead to 李姐 and 上海 leads only to 上海 accounts', () => {
    const buyer = leadOf(BUYER)!;
    assert.equal(buyer.intent.inventory_intent, true);
    assert.equal(getActiveAssignment(h.ctx, buyer.id)?.account_id, h.acc('xhs-hz-sales-wang'));

    const x3 = leadOf(X3_PRICE_ASKER)!;
    assert.equal(x3.dealer_id, h.hz);
    assert.equal(x3.intent.model, 'X3');
    assert.equal(x3.intent.price_intent, true);
    assert.equal(getActiveAssignment(h.ctx, x3.id)?.account_id, h.acc('xhs-hz-sales-li'));

    const shAccounts = new Set(h.ctx.db.table('xhs_accounts').findMany({ dealer_id: h.sh }).map((a) => a.id));
    const shLeads = h.ctx.db.table('leads').findMany({ dealer_id: h.sh });
    assert.ok(shLeads.length >= 2);
    for (const lead of shLeads) {
      const owner = getActiveAssignment(h.ctx, lead.id);
      assert.ok(owner && shAccounts.has(owner.account_id), `${lead.username} → 上海 account`);
      const ranked = h.assignments.get(lead.id)!.candidates;
      assert.ok(ranked.length > 0 && ranked.every((c) => shAccounts.has(c.account_id)), 'only 上海宝马中心 accounts were ranked');
    }
  });

  it('records lead_qualification and account_assignment decisions with evidence for every assigned lead', () => {
    const decisions = h.ctx.db.table('agent_decisions');
    for (const lead of h.qualifiedBeforeAssignment) {
      const qualification = decisions.findMany({ decision_type: 'lead_qualification', subject_type: 'lead', subject_id: lead.id });
      assert.equal(qualification.length, 1, `${lead.username}: one qualification decision`);
      assert.equal(qualification[0].output.stage, 'QUALIFIED');
      assert.ok(Number(qualification[0].output.score) >= thresholds(lead.dealer_id).qualified);
      assert.ok(qualification[0].evidence.length > 0, `${lead.username}: qualification evidence`);

      const assignment = decisions.findMany({ decision_type: 'account_assignment', subject_type: 'lead', subject_id: lead.id });
      assert.equal(assignment.length, 1, `${lead.username}: one assignment decision (re-runs are not re-recorded)`);
      assert.equal(assignment[0].output.assigned, true);
      assert.equal(assignment[0].output.account_id, getActiveAssignment(h.ctx, lead.id)?.account_id);
      assert.ok(assignment[0].evidence.length > 0, `${lead.username}: assignment evidence`);
      assert.ok(Array.isArray(assignment[0].output.ranking) && (assignment[0].output.ranking as unknown[]).length > 0);
    }
  });

  it('shows the original signal and the owning account on every 杭州宝马中心 Lead Inbox card (B4)', () => {
    const cards = getLeadInbox(h.ctx, { dealer_id: h.hz, limit: MAX_INBOX_LIMIT });
    const hzLeads = h.ctx.db.table('leads').findMany({ dealer_id: h.hz });
    assert.equal(cards.length, hzLeads.length);
    assert.ok(cards.every((c) => c.dealer_id === h.hz));
    for (let i = 1; i < cards.length; i++) assert.ok(cards[i - 1].score >= cards[i].score, 'sorted by score');

    for (const card of cards) {
      const signals = signalsOf(card.lead_id);
      assert.ok(card.original_signal.length > 0, `${card.username}: original signal shown`);
      assert.ok(signals.some((s) => s.id === card.original_signal_id && s.content === card.original_signal), `${card.username}: verbatim signal`);
      assert.ok(card.source.post_title, `${card.username}: source note title`);
      const owner = getActiveAssignment(h.ctx, card.lead_id);
      if (owner) {
        assert.equal(card.assigned_account?.id, owner.account_id, `${card.username}: owner on the card`);
        assert.equal(card.assigned_account?.nickname, accountOf(owner.account_id).nickname);
      } else {
        assert.equal(card.assigned_account, null);
      }
      assert.ok(card.next_action.length > 0);
    }

    const top = cards[0];
    assert.equal(top.platform_user_id, BUYER);
    assert.equal(top.original_signal, BUYER_PRIMARY);
    assert.equal(top.assigned_account?.nickname, '销售小王·杭州宝马');
    assert.equal(top.tier, 'immediate');
  });

  it('reports TODAY dashboard and funnel numbers that match the stored transitions and stages', () => {
    const dash = getDashboard(h.ctx, { dealer_id: h.hz });
    assert.equal(dash.period.is_today, true);
    const since = (stage: string) =>
      Number(
        h.ctx.db.get<{ n: number }>(
          `SELECT COUNT(DISTINCT t.lead_id) AS n FROM lead_stage_transitions t JOIN leads l ON l.id = t.lead_id
           WHERE l.dealer_id = ? AND t.to_stage = ? AND t.at >= ? AND t.at < ?`,
          h.hz,
          stage,
          dash.period.from,
          dash.period.to,
        )?.n,
      );
    // every assigned lead passed through QUALIFIED explicitly (no jumps), so to_stage counts are the entered counts
    for (const lead of h.qualifiedBeforeAssignment)
      assert.equal(h.ctx.db.table('lead_stage_transitions').count({ lead_id: lead.id, to_stage: 'QUALIFIED' }), 1);
    const hzQualified = h.qualifiedBeforeAssignment.filter((l) => l.dealer_id === h.hz);
    assert.ok(dash.discovery.qualified > 0);
    assert.equal(dash.discovery.qualified, since('QUALIFIED'));
    assert.equal(dash.discovery.qualified, hzQualified.length);
    assert.equal(dash.discovery.candidates, since('CANDIDATE'));
    const tiers = new Map(h.ctx.db.table('leads').findMany({ dealer_id: h.hz }).map((l) => [l.id, l.tier]));
    assert.equal(dash.discovery.high_intent, hzQualified.filter((l) => ['high_intent', 'immediate'].includes(tiers.get(l.id)!)).length);
    assert.ok(dash.briefing.some((line) => line.includes(`${dash.discovery.qualified} 条合格线索`)));

    const groupDash = getDashboard(h.ctx);
    assert.equal(groupDash.discovery.qualified, h.qualifiedBeforeAssignment.length, 'unfiltered dashboard covers the whole group');

    const funnel = getFunnel(h.ctx, { dealer_id: h.hz });
    assert.deepEqual(funnel.map((r) => r.stage), [...LEAD_STAGES]);
    const stored = new Map(
      h.ctx.db.all<{ stage: string; n: number }>('SELECT stage, COUNT(*) AS n FROM leads WHERE dealer_id = ? GROUP BY stage', h.hz).map((r) => [r.stage, Number(r.n)]),
    );
    for (const row of funnel) assert.equal(row.count, stored.get(row.stage) ?? 0, `funnel count ${row.stage}`);
    assert.equal(funnel.reduce((s, r) => s + r.count, 0), h.ctx.db.table('leads').count({ dealer_id: h.hz }));
    assert.equal(funnel.find((r) => r.stage === 'ASSIGNED')?.count, hzQualified.length);
    const chain = funnel.filter((r) => r.stage !== 'LOST');
    for (let i = 1; i < chain.length; i++) {
      assert.ok(chain[i].reached <= chain[i - 1].reached, `reached is monotone at ${chain[i].stage}`);
      const expected = chain[i - 1].reached > 0 ? round(chain[i].reached / chain[i - 1].reached, 4) : 0;
      assert.equal(chain[i].conversion_from_prev, expected, `conversion at ${chain[i].stage}`);
    }
    assert.equal(chain[0].reached, h.ctx.db.table('leads').count({ dealer_id: h.hz }));
  });

  it('attributes leads to our own published notes (content → lead, spec §16)', () => {
    const rows = getContentAttribution(h.ctx, { dealer_id: h.hz });
    const expectations: Record<string, string[]> = {
      'note-own-hz-i3-001': ['u-hz-buyer-002'],
      'note-own-hz-x3-001': ['u-hz-x3-001', 'u-hz-x3-002', 'u-trade-001'],
    };
    for (const [noteId, users] of Object.entries(expectations)) {
      const post = h.ownPosts.get(noteId)!;
      const row = rows.find((r) => r.post_id === post.id);
      assert.ok(row, `attribution row for ${noteId}`);
      const attributed = h.ctx.db.table('leads').findMany({ attributed_post_id: post.id });
      for (const u of users) assert.ok(attributed.some((l) => l.platform_user_id === u), `${u} attributed to ${noteId}`);
      assert.equal(row.leads, attributed.length);
      assert.equal(row.qualified_leads, attributed.filter((l) => STAGE_INDEX[l.stage] >= STAGE_INDEX.QUALIFIED && l.stage !== 'LOST').length);
      assert.ok(row.comments_collected > 0);
    }
  });

  it('generates persisted queries in all five classes for the 杭州 BMW i3/X3 goal (B2)', () => {
    const goal = { type: 'lead_generation' as const, brand: 'BMW', models: ['i3', 'X3'], location: '杭州' };
    const queries = generateQueries(h.ctx, { dealer_id: h.hz, goal });
    const classes = new Set(queries.map((q) => q.query_class));
    for (const c of GENERATED_QUERY_CLASSES) assert.ok(classes.has(c), `class ${c}`);
    assert.equal(new Set(queries.map((q) => q.text)).size, queries.length, 'dedup by text');
    for (const q of queries) {
      assert.equal(q.dealer_id, h.hz);
      assert.equal(q.status, 'active');
      assert.ok(q.priority >= 0 && q.priority <= 1);
      assert.ok(q.generation_reason.length > 0);
    }
    assert.ok(queries.some((q) => q.query_class === 'direct_model' && q.text.includes('i3')));
    assert.ok(queries.some((q) => q.query_class === 'direct_model' && q.text.includes('X3')));
    assert.ok(queries.filter((q) => q.query_class === 'location').every((q) => /杭州|浙江/.test(q.text)));
    assert.equal(h.ctx.db.table('search_queries').count({ dealer_id: h.hz }), queries.length);

    const again = generateQueries(h.ctx, { dealer_id: h.hz, goal });
    assert.deepEqual(again.map((q) => q.id), queries.map((q) => q.id), 'regeneration is idempotent');
    assert.equal(h.ctx.db.table('search_queries').count({ dealer_id: h.hz }), queries.length);
    assert.ok(h.ctx.db.table('agent_decisions').count({ decision_type: 'query_generation' }) >= 1);
  });

  it("plans next week's posts for every active 杭州 account without cross-account cannibalization (B3)", () => {
    const tz = h.ctx.db.table('dealers').require(h.hz).settings?.timezone || DEFAULT_TZ;
    const now = h.ctx.clock.now();
    const toMonday = (8 - localParts(now, tz).weekday) % 7 || 7;
    const periodStart = addDaysToKey(localDateKey(now, tz), toMonday);
    const periodEnd = addDaysToKey(periodStart, 6);
    assert.equal(periodStart, '2026-09-14');

    const { plans, posts } = planContent(h.ctx, { dealer_id: h.hz, period_start: periodStart, days: 7 });
    const active = h.ctx.db.table('xhs_accounts').findMany({ dealer_id: h.hz, status: 'active' });
    assert.equal(active.length, 6);
    assert.deepEqual(plans.map((p) => p.account_id).sort(), active.map((a) => a.id).sort(), 'one plan per active account');
    for (const account of active) {
      const own = posts.filter((p) => p.account_id === account.id);
      assert.ok(own.length >= 2, `${account.nickname}: ${own.length} posts`);
      for (const p of own) {
        assert.equal(p.status, 'PLANNED');
        assert.ok(p.slot_date >= periodStart && p.slot_date <= periodEnd, `${p.slot_date} within the period`);
      }
    }
    assert.ok(posts.every((p) => p.dealer_id === h.hz));
    for (const a of posts) {
      for (const b of posts) {
        if (a.id >= b.id || a.account_id === b.account_id || a.model !== b.model || a.pillar !== b.pillar) continue;
        assert.ok(
          Math.abs(dayDiff(a.slot_date, b.slot_date)) > CANNIBALIZATION_WINDOW_DAYS,
          `${a.topic}@${a.slot_date} (${accountOf(a.account_id).nickname}) vs ${b.topic}@${b.slot_date} (${accountOf(b.account_id).nickname})`,
        );
      }
    }
  });

  it('persists an xhs research brief whose evidence is verbatim from the corpus (B3)', async () => {
    const brief = await runXhsResearch(h.ctx, { dealer_id: h.hz, models: ['i3'] });
    const stored = h.ctx.db.table('research_briefs').get(brief.id);
    assert.ok(stored, 'brief persisted');
    assert.equal(stored.kind, 'xhs');
    assert.equal(stored.dealer_id, h.hz);
    assert.deepEqual(stored.findings, brief.findings);
    assert.ok(brief.source_counts.posts > 0 && brief.source_counts.comments > 0);
    assert.match(brief.findings.headline, /模拟数据/, 'simulation provenance is labelled');
    assert.ok(brief.findings.insights.length > 0);

    for (const insight of brief.findings.insights) {
      assert.ok(insight.evidence.length > 0, `insight "${insight.text}" carries evidence`);
      for (const e of insight.evidence) {
        assert.ok(e.quote, `${e.code} has a quote`);
        const [kind, ...rest] = (e.source_ref ?? '').split(':');
        const ref = rest.join(':');
        if (kind === 'note') {
          const note = h.notesById.get(ref);
          assert.ok(note, `note ${ref} exists`);
          assert.ok(isVerbatimQuote([note.title, note.content], e.quote), `"${e.quote}" verbatim in note ${ref}`);
        } else if (kind === 'comment') {
          const comment = h.commentsById.get(ref);
          assert.ok(comment, `comment ${ref} exists`);
          assert.ok(isVerbatimQuote(comment.content, e.quote), `"${e.quote}" verbatim in comment ${ref}`);
        } else {
          assert.fail(`unexpected evidence source_ref ${e.source_ref}`);
        }
      }
    }
    // an i3 brief counts questions about i3 (or naming no model) only: '上海X3现在什么价' is not i3 demand
    const questionEvidence = brief.findings.insights.flatMap((i) => i.evidence).filter((e) => e.code.startsWith('buyer_question:') || e.code === 'format_buyer_questions');
    assert.ok(questionEvidence.length > 0);
    for (const e of questionEvidence) {
      const comment = h.commentsById.get((e.source_ref ?? '').slice('comment:'.length));
      assert.ok(comment, `${e.source_ref} is a corpus comment`);
      const named = findModels(comment.content);
      assert.ok(named.length === 0 || named.some((m) => m.model === 'i3'), `"${comment.content}" is not an i3 buyer question`);
    }
    for (const q of brief.findings.top_questions ?? []) {
      assert.ok([...h.commentsById.values()].some((c) => isVerbatimQuote(c.content, q.example_quote)), `example "${q.example_quote}" is verbatim`);
    }
    assert.equal(h.ctx.db.table('agent_decisions').count({ decision_type: 'research', subject_id: brief.id }), 1, 'audited research decision');
  });
});
