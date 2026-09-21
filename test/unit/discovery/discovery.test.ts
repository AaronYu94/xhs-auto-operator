import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import type { CapabilityStatus, SearchQuery } from '../../../src/core/types.ts';
import { buildReport } from '../../../src/providers/xhs/unavailable.ts';
import { mapComment, mapFeed, mapNoteDetail, xhsNoteUrl } from '../../../src/providers/xhs/mcp-provider.ts';
import { SimulationXhsProvider } from '../../../src/providers/xhs/simulation.ts';
import type {
  CapabilityReport,
  ProviderResult,
  XhsComment,
  XhsCommentOptions,
  XhsNoteDetail,
  XhsNoteRef,
  XhsNoteSummary,
  XhsProvider,
  XhsSearchOptions,
} from '../../../src/providers/xhs/types.ts';
import { UnavailableXhsProvider } from '../../../src/providers/xhs/unavailable.ts';
import { findLeadByIdentity } from '../../../src/skills/acquisition/lead-deduplication/index.ts';
import {
  MAX_CONSECUTIVE_TRANSIENT_FAILURES,
  NO_QUERIES_REASON,
  LEAD_FRESH_DAYS,
  REFETCH_AFTER_MS,
  SEARCH_RESULTS_CONSIDERED,
  SEARCH_SORT,
  selectNotesToRead,
  ingestPublicContent,
  runDiscovery,
  runSearchQuery,
  skill,
} from '../../../src/skills/acquisition/lead-discovery/index.ts';
import { SkillRegistry } from '../../../src/skills/registry.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { accountIdByPlatformId, dealerIdByKey, loadDealerFixture, seedPublishedPost } from '../../helpers/fixtures.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function setup(provider?: (ctx: TestContext) => XhsProvider) {
  const ctx = createTestContext();
  const summary = loadDealerFixture(ctx);
  ctx.xhs = provider ? provider(ctx) : SimulationXhsProvider.fromFile(ctx.clock);
  return { ctx, summary, hz: dealerIdByKey(summary, 'hz-bmw'), groupId: ctx.db.table('dealers').require(dealerIdByKey(summary, 'hz-bmw')).group_id };
}

function addQuery(ctx: TestContext, dealerId: string, text: string, priority = 0.9): SearchQuery {
  const now = ctx.clock.iso();
  return ctx.db.table('search_queries').insert({
    id: newId('q'),
    dealer_id: dealerId,
    goal_id: null,
    text,
    query_class: 'direct_model',
    brand: 'BMW',
    model: null,
    location: null,
    priority,
    status: 'active',
    parent_query_id: null,
    generation_reason: 'test',
    created_at: now,
    updated_at: now,
  });
}

type Override = Partial<Pick<XhsProvider, 'capabilities' | 'searchNotes' | 'getNote' | 'getComments' | 'getNoteWithComments'>>;

/** Delegates to an inner provider with selected methods replaced. */
class DelegatingProvider implements XhsProvider {
  readonly name: string;
  readonly mode;
  private readonly inner: XhsProvider;
  private readonly o: Override;
  /** present only when overridden, like a provider without the optional single-load read */
  getNoteWithComments?: XhsProvider['getNoteWithComments'];
  constructor(inner: XhsProvider, o: Override, name = 'delegating') {
    this.inner = inner;
    this.o = o;
    if (o.getNoteWithComments) this.getNoteWithComments = o.getNoteWithComments;
    this.name = name;
    this.mode = inner.mode;
  }
  capabilities(a?: string | null) {
    return this.o.capabilities ? this.o.capabilities(a) : this.inner.capabilities(a);
  }
  searchNotes(q: string, opts?: XhsSearchOptions, a?: string | null) {
    return this.o.searchNotes ? this.o.searchNotes(q, opts, a) : this.inner.searchNotes(q, opts, a);
  }
  getNote(ref: XhsNoteRef, a?: string | null) {
    return this.o.getNote ? this.o.getNote(ref, a) : this.inner.getNote(ref, a);
  }
  getComments(ref: XhsNoteRef, opts?: XhsCommentOptions, a?: string | null) {
    return this.o.getComments ? this.o.getComments(ref, opts, a) : this.inner.getComments(ref, opts, a);
  }
  getUserProfile(...args: Parameters<XhsProvider['getUserProfile']>) {
    return this.inner.getUserProfile(...args);
  }
  publishNote(...args: Parameters<XhsProvider['publishNote']>) {
    return this.inner.publishNote(...args);
  }
  getEngagement(...args: Parameters<XhsProvider['getEngagement']>) {
    return this.inner.getEngagement(...args);
  }
  replyToComment(...args: Parameters<XhsProvider['replyToComment']>) {
    return this.inner.replyToComment(...args);
  }
  listInboundMessages(...args: Parameters<XhsProvider['listInboundMessages']>) {
    return this.inner.listInboundMessages(...args);
  }
  sendMessage(...args: Parameters<XhsProvider['sendMessage']>) {
    return this.inner.sendMessage(...args);
  }
}

function reportWith(ctx: TestContext, provider: XhsProvider, status: CapabilityStatus, reason: string): CapabilityReport {
  return buildReport(provider.name, provider.mode, null, ctx.clock, { search_public_content: { status, reason } }, { status, reason });
}

/** Expected users_evaluated computed independently from provider output. */
async function expectedUsers(provider: XhsProvider, query: string, managed: Set<string>): Promise<number> {
  const res = await provider.searchNotes(query, { sort: SEARCH_SORT, limit: SEARCH_RESULTS_CONSIDERED, published_within_days: LEAD_FRESH_DAYS }, null);
  assert.ok(res.ok);
  const users = new Set<string>();
  for (const s of selectNotesToRead(res.data, 10).notes) {
    const d = await provider.getNote(s, null);
    assert.ok(d.ok);
    if (d.data.author.platform_user_id && !managed.has(d.data.author.platform_user_id)) users.add(d.data.author.platform_user_id);
    const c = await provider.getComments(s, { include_replies: true, limit: 50 }, null);
    assert.ok(c.ok);
    for (const x of c.data) if (x.author.platform_user_id && !managed.has(x.author.platform_user_id)) users.add(x.author.platform_user_id);
  }
  return users.size;
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulation corpus
// ─────────────────────────────────────────────────────────────────────────────

describe('lead-discovery: search run over the simulation corpus', () => {
  it('creates ONE lead per buyer with verbatim signals, BUYER actor, simulation provenance and exact counters', async () => {
    const { ctx, hz, groupId } = setup();
    const q = addQuery(ctx, hz, '宝马i3');
    const run = await runSearchQuery(ctx, { dealer_id: hz, query_id: q.id });

    assert.equal(run.status, 'SUCCEEDED', run.error ?? '');
    assert.equal(run.data_mode, 'simulation');
    assert.equal(run.provider, 'simulation');
    assert.ok(run.finished_at);

    const lead = findLeadByIdentity(ctx, groupId, 'u-hz-buyer-001');
    assert.ok(lead, 'u-hz-buyer-001 becomes a lead');
    const signals = ctx.db.table('lead_signals').findMany({ lead_id: lead.id });
    assert.ok(signals.length >= 3, `expected ≥3 merged signals, got ${signals.length}`);
    assert.equal(ctx.db.table('leads').count({ group_id: groupId, platform_user_id: 'u-hz-buyer-001' }), 1);
    assert.equal(lead.actor_type, 'BUYER');
    assert.equal(lead.data_mode, 'simulation');
    for (const s of signals) {
      assert.equal(s.actor_type, 'BUYER');
      assert.equal(s.search_run_id, run.id);
      assert.equal(s.query_id, q.id);
      assert.ok(s.public_comment_id, 'comment signals keep their exact source comment');
      const comment = ctx.db.table('public_comments').require(s.public_comment_id);
      assert.equal(s.content, comment.content, 'signal content is verbatim');
      const post = ctx.db.table('public_posts').require(comment.public_post_id);
      assert.match(post.url ?? '', /^https:\/\/www\.xiaohongshu\.com\/explore\//);
      assert.equal(post.data_mode, 'simulation');
      assert.equal(comment.data_mode, 'simulation');
    }
    assert.ok(signals.some((s) => s.content === '杭州i3 35L白外红内有现车吗？这周想去看看'));

    assert.equal(findLeadByIdentity(ctx, groupId, 'u-dealer-spam-001'), undefined, 'competitor salesperson is never a lead');
    assert.equal(findLeadByIdentity(ctx, groupId, 'xhs-hz-i3'), undefined, 'managed account author is never a lead');

    // counters
    const search = await ctx.xhs.searchNotes('宝马i3', { sort: SEARCH_SORT, limit: SEARCH_RESULTS_CONSIDERED, published_within_days: LEAD_FRESH_DAYS }, null);
    assert.ok(search.ok);
    assert.equal(run.posts_discovered, selectNotesToRead(search.data, 10).notes.length);
    assert.equal(run.posts_new, ctx.db.table('public_posts').count({ first_search_run_id: run.id }));
    assert.equal(run.comments_scanned, ctx.db.table('public_comments').count({ first_search_run_id: run.id }));
    const managed = new Set(ctx.db.table('xhs_accounts').findMany({ group_id: groupId }).map((a) => a.platform_account_id ?? ''));
    assert.equal(run.users_evaluated, await expectedUsers(ctx.xhs, '宝马i3', managed));
    const touched = [...new Set(ctx.db.table('lead_signals').findMany({ search_run_id: run.id }).map((s) => s.lead_id))].map((id) =>
      ctx.db.table('leads').require(id),
    );
    const at = (min: string[]) => touched.filter((l) => min.includes(l.tier)).length;
    assert.equal(run.candidates, at(['candidate', 'qualified', 'high_intent', 'immediate']));
    assert.equal(run.qualified, at(['qualified', 'high_intent', 'immediate']));
    assert.equal(run.high_intent, at(['high_intent', 'immediate']));
    assert.ok(run.qualified >= 1);

    // one lead_prefilter decision per ingested note, stamped with counts
    const decisions = ctx.db.table('agent_decisions').findMany({ decision_type: 'lead_prefilter' });
    assert.equal(decisions.length, run.posts_discovered);
    assert.ok(decisions.every((d) => d.subject_type === 'public_post' && typeof d.output.by_actor_type === 'object'));
    assert.equal(ctx.db.table('audit_events').count({ action: 'search_run.completed', entity_id: run.id }), 1);
  });

  it('is idempotent: re-running the same query adds no rows or signals', async () => {
    const { ctx, hz, groupId } = setup();
    const q = addQuery(ctx, hz, '宝马i3');
    await runSearchQuery(ctx, { dealer_id: hz, query_id: q.id });
    const counts = () => ({
      posts: ctx.db.table('public_posts').count(),
      comments: ctx.db.table('public_comments').count(),
      signals: ctx.db.table('lead_signals').count(),
      leads: ctx.db.table('leads').count(),
    });
    const before = counts();
    const leadBefore = findLeadByIdentity(ctx, groupId, 'u-hz-buyer-001')!;
    ctx.clock.advance({ minutes: 5 });
    const second = await runSearchQuery(ctx, { dealer_id: hz, query_id: q.id });
    assert.equal(second.status, 'SUCCEEDED');
    assert.equal(second.posts_new, 0);
    assert.deepEqual(counts(), before);
    assert.equal(findLeadByIdentity(ctx, groupId, 'u-hz-buyer-001')!.signal_count, leadBefore.signal_count);
    // the first run keeps ownership of the public rows
    assert.equal(ctx.db.table('public_posts').count({ first_search_run_id: second.id }), 0);
  });

  it('attributes own published notes and never evaluates verified managed identities', async () => {
    const { ctx, hz, groupId, summary } = setup();
    const accountId = accountIdByPlatformId(summary, 'xhs-hz-i3');
    const own = seedPublishedPost(ctx, { dealer_id: hz, account_id: accountId });
    ctx.db.table('posts').update(own.id, { platform_note_id: 'note-own-hz-i3-001' });
    // a verified session id equal to a commenter id marks that commenter as our own account
    ctx.db.table('xhs_accounts').update(accountIdByPlatformId(summary, 'xhs-hz-guide'), { platform_user_id: 'u-sh-buyer-001' });

    const q1 = addQuery(ctx, hz, '宝马i3');
    await runSearchQuery(ctx, { dealer_id: hz, query_id: q1.id });
    const ownPublic = ctx.db.table('public_posts').findOne({ platform_post_id: 'note-own-hz-i3-001' });
    assert.ok(ownPublic);
    assert.equal(ownPublic.own_post_id, own.id);

    const q2 = addQuery(ctx, hz, '上海X3');
    const run = await runSearchQuery(ctx, { dealer_id: hz, query_id: q2.id });
    assert.equal(run.status, 'SUCCEEDED');
    assert.equal(ctx.db.table('public_comments').count({ author_platform_user_id: 'u-sh-buyer-001' }), 1, 'comment row still stored');
    assert.equal(findLeadByIdentity(ctx, groupId, 'u-sh-buyer-001'), undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Honest failure states
// ─────────────────────────────────────────────────────────────────────────────

describe('lead-discovery: provider unavailable / login required', () => {
  it('UnavailableXhsProvider → run UNAVAILABLE with the reason and zero public rows', async () => {
    const { ctx, hz } = setup((c) => new UnavailableXhsProvider(c.clock));
    const q = addQuery(ctx, hz, '宝马i3');
    const run = await runSearchQuery(ctx, { dealer_id: hz, query_id: q.id });
    assert.equal(run.status, 'UNAVAILABLE');
    assert.match(run.error ?? '', /^UNAVAILABLE: No Xiaohongshu integration configured/);
    assert.equal(run.data_mode, 'unknown');
    assert.ok(run.finished_at);
    assert.equal(ctx.db.table('public_posts').count(), 0);
    assert.equal(ctx.db.table('public_comments').count(), 0);
    assert.equal(ctx.db.table('audit_events').count({ action: 'search_run.unavailable', entity_id: run.id }), 1);
  });

  it('REQUIRES_AUTH capability blocks discovery after the first query (no hammering)', async () => {
    const { ctx, hz } = setup((c) => {
      const sim = SimulationXhsProvider.fromFile(c.clock);
      const p: DelegatingProvider = new DelegatingProvider(sim, {
        capabilities: async () => reportWith(c, p, 'REQUIRES_AUTH', 'Xiaohongshu session not logged in (log in via get_login_qrcode)'),
      });
      return p;
    });
    addQuery(ctx, hz, '宝马i3', 0.9);
    addQuery(ctx, hz, '宝马X3', 0.8);
    const result = await runDiscovery(ctx, { dealer_id: hz });
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].status, 'UNAVAILABLE');
    assert.ok(result.blocked);
    assert.equal(result.blocked.status, 'REQUIRES_AUTH');
    assert.match(result.blocked.reason, /not logged in/);
    assert.equal(result.blocked.query_id, result.runs[0].query_id);
    assert.equal(ctx.db.table('public_posts').count(), 0);
  });

  it('REQUIRES_AUTH mid-run keeps what was fetched and stops the run as UNAVAILABLE', async () => {
    const { ctx, hz } = setup((c) => {
      const sim = SimulationXhsProvider.fromFile(c.clock);
      let calls = 0;
      return new DelegatingProvider(sim, {
        getComments: async (ref, opts, a) => {
          calls++;
          if (calls >= 2) return { ok: false, status: 'REQUIRES_AUTH', reason: '登录已过期' };
          return sim.getComments(ref, opts, a);
        },
      });
    });
    const q = addQuery(ctx, hz, '宝马i3');
    const run = await runSearchQuery(ctx, { dealer_id: hz, query_id: q.id });
    assert.equal(run.status, 'UNAVAILABLE');
    assert.match(run.error ?? '', /^REQUIRES_AUTH: 登录已过期/);
    assert.equal(ctx.db.table('public_posts').count(), 2, 'the first note (with comments) and the second note detail are stored');
    assert.ok(run.comments_scanned > 0);
    const event = ctx.db.table('audit_events').findOne({ action: 'search_run.unavailable', entity_id: run.id });
    assert.ok(event);
    assert.equal(event.details.notes_failed, 1);
  });

  it('a search failure that is not an availability problem ends FAILED without blocking', async () => {
    const { ctx, hz } = setup((c) => {
      const sim = SimulationXhsProvider.fromFile(c.clock);
      return new DelegatingProvider(sim, {
        searchNotes: async (): Promise<ProviderResult<XhsNoteSummary[]>> => ({ ok: false, status: 'REQUIRES_REVIEW', reason: 'unexpected page layout' }),
      });
    });
    addQuery(ctx, hz, '宝马i3', 0.9);
    addQuery(ctx, hz, '宝马X3', 0.8);
    const result = await runDiscovery(ctx, { dealer_id: hz });
    assert.equal(result.blocked, null);
    assert.equal(result.runs.length, 2);
    assert.ok(result.runs.every((r) => r.status === 'FAILED' && /REQUIRES_REVIEW/.test(r.error ?? '')));
  });

  it('a transient search failure (tool timeout) fails only its query; the batch continues', async () => {
    const timeout: ProviderResult<XhsNoteSummary[]> = {
      ok: false,
      status: 'UNAVAILABLE',
      reason: 'xiaohongshu-mcp tool failed (account a): 工具 search_feeds 执行时发生内部错误: context deadline exceeded',
      retryable: true,
    };
    const { ctx, hz } = setup((c) => {
      const sim = SimulationXhsProvider.fromFile(c.clock);
      let calls = 0;
      return new DelegatingProvider(sim, {
        // both the first attempt and its retry fail: the query fails, the batch continues
        searchNotes: async (q, o, a) => (++calls <= 2 ? timeout : sim.searchNotes(q, o, a)),
      });
    });
    addQuery(ctx, hz, '宝马i3', 0.9);
    addQuery(ctx, hz, '宝马X3', 0.8);
    const result = await runDiscovery(ctx, { dealer_id: hz });
    assert.equal(result.blocked, null);
    assert.deepEqual(
      result.runs.map((r) => r.status),
      ['FAILED', 'SUCCEEDED'],
    );
    assert.match(result.runs[0].error ?? '', /context deadline exceeded/);
  });

  it(`${MAX_CONSECUTIVE_TRANSIENT_FAILURES} transient failures in a row block the rest (no hammering an unhealthy instance)`, async () => {
    let searches = 0;
    const { ctx, hz } = setup((c) => {
      const sim = SimulationXhsProvider.fromFile(c.clock);
      return new DelegatingProvider(sim, {
        searchNotes: async (): Promise<ProviderResult<XhsNoteSummary[]>> => {
          searches++;
          return { ok: false, status: 'UNAVAILABLE', reason: 'xiaohongshu-mcp timeout (account a): request timed out', retryable: true };
        },
      });
    });
    for (const [i, text] of ['宝马i3', '宝马X3', '宝马5系', '宝马X5'].entries()) addQuery(ctx, hz, text, 0.9 - i * 0.1);
    const result = await runDiscovery(ctx, { dealer_id: hz });
    assert.equal(searches, MAX_CONSECUTIVE_TRANSIENT_FAILURES * 2, 'each query is attempted twice before it counts as failed');
    assert.equal(result.runs.length, MAX_CONSECUTIVE_TRANSIENT_FAILURES);
    assert.ok(result.runs.every((r) => r.status === 'FAILED'));
    assert.ok(result.blocked);
    assert.equal(result.blocked.status, 'UNAVAILABLE');
    assert.match(result.blocked.reason, /^连续 2 个搜索词都失败了，其余搜索词本次暂停：UNAVAILABLE: xiaohongshu-mcp timeout/);
    assert.equal(result.blocked.query_id, result.runs.at(-1)?.query_id);
  });

  it('a non-retryable UNAVAILABLE search still blocks at once', async () => {
    const { ctx, hz } = setup((c) => {
      const sim = SimulationXhsProvider.fromFile(c.clock);
      return new DelegatingProvider(sim, {
        searchNotes: async (): Promise<ProviderResult<XhsNoteSummary[]>> => ({ ok: false, status: 'UNAVAILABLE', reason: 'rejected the request: check AUTH_TOKEN' }),
      });
    });
    addQuery(ctx, hz, '宝马i3', 0.9);
    addQuery(ctx, hz, '宝马X3', 0.8);
    const result = await runDiscovery(ctx, { dealer_id: hz });
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].status, 'UNAVAILABLE');
    assert.match(result.blocked?.reason ?? '', /AUTH_TOKEN/);
  });

  it('reads each note with ONE provider call when the provider supports detail + comments together', async () => {
    const counts = { combined: 0, separate: 0 };
    const { ctx, hz } = setup((c) => {
      const sim = SimulationXhsProvider.fromFile(c.clock);
      return new DelegatingProvider(sim, {
        getNote: async (r, a) => (counts.separate++, sim.getNote(r, a)),
        getComments: async (r, o, a) => (counts.separate++, sim.getComments(r, o, a)),
        getNoteWithComments: async (ref, opts, a) => {
          counts.combined++;
          const note = await sim.getNote(ref, a);
          if (!note.ok) return note;
          const comments = await sim.getComments(ref, opts, a);
          return comments.ok ? { ok: true, data: { note: note.data, comments: comments.data } } : comments;
        },
      });
    });
    const run = await runSearchQuery(ctx, { dealer_id: hz, query_id: addQuery(ctx, hz, '宝马i3').id });
    assert.equal(run.status, 'SUCCEEDED', run.error ?? '');
    assert.equal(counts.separate, 0);
    assert.equal(counts.combined, run.posts_discovered);

    const twoCalls = setup();
    const baseline = await runSearchQuery(twoCalls.ctx, { dealer_id: twoCalls.hz, query_id: addQuery(twoCalls.ctx, twoCalls.hz, '宝马i3').id });
    assert.deepEqual(
      [run.posts_discovered, run.comments_scanned, run.users_evaluated, run.qualified],
      [baseline.posts_discovered, baseline.comments_scanned, baseline.users_evaluated, baseline.qualified],
      'same outcome as the two-call path',
    );
  });

  it('notes read in the last 12 hours are not re-read (any query); after that they are', async () => {
    let reads = 0;
    const { ctx, hz } = setup((c) => {
      const sim = SimulationXhsProvider.fromFile(c.clock);
      return new DelegatingProvider(sim, { getNote: async (r, a) => (reads++, sim.getNote(r, a)) });
    });
    const q = addQuery(ctx, hz, '宝马i3');
    const first = await runSearchQuery(ctx, { dealer_id: hz, query_id: q.id });
    const firstReads = reads;
    assert.ok(firstReads > 0 && first.status === 'SUCCEEDED');

    ctx.clock.advance({ ms: REFETCH_AFTER_MS - 60_000 });
    const second = await runSearchQuery(ctx, { dealer_id: hz, query_id: addQuery(ctx, hz, '宝马i3 价格', 0.5).id });
    assert.equal(second.status, 'SUCCEEDED', 'nothing new to read is not a failure');
    const event = ctx.db.table('audit_events').findOne({ action: 'search_run.completed', entity_id: second.id });
    assert.equal(event?.details.notes_skipped_recent, second.posts_discovered - (reads - firstReads));

    const again = await runSearchQuery(ctx, { dealer_id: hz, query_id: q.id });
    const skipped = ctx.db.table('audit_events').findOne({ action: 'search_run.completed', entity_id: again.id });
    assert.equal(skipped?.details.notes_skipped_recent, again.posts_discovered, 'the same query right after: every note skipped');

    ctx.clock.advance({ ms: REFETCH_AFTER_MS + 1 });
    const before = reads;
    const later = await runSearchQuery(ctx, { dealer_id: hz, query_id: q.id });
    assert.equal(reads - before, later.posts_discovered, 'read again once the 12 hours have passed');
  });

  it('reads discussions first: dealer-store notes are skipped, the rest most-commented first', () => {
    const note = (id: string, nickname: string, comment_count: number | null) =>
      ({ platform_post_id: id, xsec_token: 't', title: id, author: { platform_user_id: id, nickname }, like_count: 0, comment_count }) as XhsNoteSummary;
    const results = [
      note('promo', '小鹏汽车 | 小李', 1),
      note('quiet', '路人甲', 2),
      note('hot', '路人乙', 227),
      note('unknown', '路人丙', null),
      note('store', '小鹏汽车舟山某某汽车城销售服务中心', 40),
      note('warm', '路人丁', 64),
    ];
    const { notes, skipped_seller } = selectNotesToRead(results, 3);
    assert.deepEqual(notes.map((n) => n.platform_post_id), ['hot', 'warm', 'quiet']);
    assert.equal(skipped_seller, 2);
    assert.deepEqual(selectNotesToRead(results, 10).notes.map((n) => n.platform_post_id), ['hot', 'warm', 'quiet', 'unknown'], 'unknown counts last');
  });

  it('asks the provider for one results page in 综合 order', async () => {
    let seen: XhsSearchOptions | undefined;
    const { ctx, hz } = setup((c) => {
      const sim = SimulationXhsProvider.fromFile(c.clock);
      return new DelegatingProvider(sim, { searchNotes: async (q, o, a) => ((seen = o), sim.searchNotes(q, o, a)) });
    });
    await runSearchQuery(ctx, { dealer_id: hz, query_id: addQuery(ctx, hz, '宝马i3').id });
    assert.equal(seen?.sort, 'general');
    assert.equal(seen?.limit, SEARCH_RESULTS_CONSIDERED);
  });

  it('a transient search failure is retried once before the query fails', async () => {
    let calls = 0;
    const { ctx, hz } = setup((c) => {
      const sim = SimulationXhsProvider.fromFile(c.clock);
      return new DelegatingProvider(sim, {
        searchNotes: async (q, o, a) =>
          ++calls === 1 ? { ok: false, status: 'UNAVAILABLE', reason: 'xiaohongshu-mcp tool failed: 搜索Feeds失败: 筛选面板里没有「发布时间」这一组', retryable: true } : sim.searchNotes(q, o, a),
      });
    });
    const run = await runSearchQuery(ctx, { dealer_id: hz, query_id: addQuery(ctx, hz, '宝马i3').id });
    assert.equal(calls, 2);
    assert.equal(run.status, 'SUCCEEDED', run.error ?? '');
  });

  it('no active queries → blocked with an actionable Chinese reason', async () => {
    const { ctx, hz } = setup();
    const result = await runDiscovery(ctx, { dealer_id: hz });
    assert.deepEqual(result.runs, []);
    assert.deepEqual(result.blocked, { status: 'UNAVAILABLE', reason: NO_QUERIES_REASON, query_id: null });
  });

  it('rejects queries of another dealer', async () => {
    const { ctx, hz, summary } = setup();
    const q = addQuery(ctx, dealerIdByKey(summary, 'sh-bmw'), '上海宝马');
    await assert.rejects(runSearchQuery(ctx, { dealer_id: hz, query_id: q.id }), ValidationError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Import path & live provenance
// ─────────────────────────────────────────────────────────────────────────────

describe('lead-discovery: import path and live provider provenance', () => {
  const now = Date.parse('2026-09-12T02:00:00.000Z');

  it('ingestPublicContent without a run stores import provenance and validates input', async () => {
    const { ctx, hz, groupId } = setup((c) => new UnavailableXhsProvider(c.clock));
    const summary = await ingestPublicContent(ctx, {
      dealer_id: hz,
      notes: [
        {
          platform_post_id: '66f1a2b3c4d5e6f7a8b9c0d1',
          xsec_token: 'ABimport=',
          title: '宝马i3现在值得买吗？',
          content: '想听听大家意见',
          tags: [],
          author: { platform_user_id: 'real-author-1', nickname: '路人甲' },
          like_count: 3,
          comment_count: 1,
          collect_count: 0,
          ip_location: '浙江',
          published_at: new Date(now - 3_600_000).toISOString(),
          comments: [
            {
              platform_comment_id: 'real-comment-1',
              parent_comment_id: null,
              author: { platform_user_id: 'real-buyer-1', nickname: '钱塘小李' },
              content: '杭州i3 35L落地多少',
              ip_location: '浙江',
              like_count: 0,
              published_at: new Date(now - 1_800_000).toISOString(),
            },
          ],
        },
      ],
    });
    assert.equal(summary.data_mode, 'import');
    // the post author asks a genuine research question ("值得买吗？想听听大家意见") → a BUYER too, besides the commenter
    assert.equal(summary.leads_created, 2);
    assert.equal(ctx.db.table('lead_signals').findOne({ lead_id: findLeadByIdentity(ctx, groupId, 'real-author-1')!.id })!.source_type, 'post');
    const post = ctx.db.table('public_posts').findOne({ platform_post_id: '66f1a2b3c4d5e6f7a8b9c0d1' })!;
    assert.equal(post.data_mode, 'import');
    assert.equal(post.url, 'https://www.xiaohongshu.com/explore/66f1a2b3c4d5e6f7a8b9c0d1?xsec_token=ABimport%3D');
    const lead = findLeadByIdentity(ctx, groupId, 'real-buyer-1')!;
    assert.equal(lead.data_mode, 'import');
    assert.equal(lead.actor_type, 'BUYER');
    assert.equal(lead.profile_url, 'https://www.xiaohongshu.com/user/profile/real-buyer-1');
    assert.equal(ctx.db.table('audit_events').count({ action: 'public_content.ingested' }), 1);

    await assert.rejects(
      ingestPublicContent(ctx, { dealer_id: hz, notes: [{ title: 'x' } as never] }),
      (err: unknown) => err instanceof ValidationError && /platform_post_id/.test(err.message),
    );
  });

  it('a live provider (xiaohongshu-mcp payload shapes) yields live provenance and the real explore URL', async () => {
    const noteId = '68a1b2c3d4e5f6a7b8c9d0e1';
    const token = 'ABliveTok+en=';
    const feed = {
      xsecToken: token,
      id: noteId,
      modelType: 'note',
      noteCard: { displayTitle: '宝马i3外观实拍', user: { userId: 'live-author-1', nickname: '拍车的阿明' }, interactInfo: { likedCount: '1.2万' } },
    };
    const noteRaw = {
      noteId,
      xsecToken: token,
      title: '宝马i3外观实拍',
      desc: '阳光下拍的几张图，颜色很耐看',
      time: now - 7_200_000,
      ipLocation: '浙江',
      user: { userId: 'live-author-1', nickname: '拍车的阿明' },
      interactInfo: { likedCount: '1.2万', commentCount: '2', collectedCount: '30' },
    };
    const commentsRaw = [
      { id: 'lc-1', content: '杭州i3 35L白外红内有现车吗？这周想去看看', createTime: now - 3_600_000, ipLocation: '浙江', likeCount: '0', userInfo: { userId: 'live-user-1', nickname: '西湖边的小鹿' }, subComments: [] },
      { id: 'lc-2', content: '宝马i3底价私信我，杭州4S店销售', createTime: now - 3_000_000, ipLocation: '浙江', likeCount: '0', userInfo: { userId: 'live-spam-1', nickname: '宝马顾问' }, subComments: [] },
    ];
    const { ctx, hz, groupId } = setup((c) => {
      const inner = new UnavailableXhsProvider(c.clock);
      const live: XhsProvider = Object.assign(
        new DelegatingProvider(inner, {
          capabilities: async () => buildReport('xiaohongshu-mcp', 'live', null, c.clock, {}, { status: 'AVAILABLE', reason: 'stub live' }),
          searchNotes: async () => ({ ok: true, data: [mapFeed(feed)!] }),
          getNote: async (ref): Promise<ProviderResult<XhsNoteDetail>> => ({ ok: true, data: mapNoteDetail(noteRaw, ref) }),
          getComments: async (): Promise<ProviderResult<XhsComment[]>> => ({ ok: true, data: commentsRaw.map((x) => mapComment(x)!) }),
        }, 'xiaohongshu-mcp'),
        { mode: 'live' as const },
      );
      return live;
    });
    const q = addQuery(ctx, hz, '宝马i3');
    const run = await runSearchQuery(ctx, { dealer_id: hz, query_id: q.id });
    assert.equal(run.status, 'SUCCEEDED', run.error ?? '');
    assert.equal(run.data_mode, 'live');
    assert.equal(run.provider, 'xiaohongshu-mcp');

    const post = ctx.db.table('public_posts').findOne({ platform_post_id: noteId })!;
    assert.equal(post.data_mode, 'live');
    assert.equal(post.url, xhsNoteUrl(noteId, token));
    assert.equal(post.url, 'https://www.xiaohongshu.com/explore/68a1b2c3d4e5f6a7b8c9d0e1?xsec_token=ABliveTok%2Ben%3D');
    assert.equal(post.like_count, 12_000);

    const lead = findLeadByIdentity(ctx, groupId, 'live-user-1')!;
    assert.ok(lead, 'live buyer becomes a lead');
    assert.equal(lead.data_mode, 'live');
    assert.equal(lead.actor_type, 'BUYER');
    assert.equal(lead.profile_url, 'https://www.xiaohongshu.com/user/profile/live-user-1');
    const signal = ctx.db.table('lead_signals').findOne({ lead_id: lead.id })!;
    assert.equal(signal.content, '杭州i3 35L白外红内有现车吗？这周想去看看');
    assert.equal(ctx.db.table('public_comments').require(signal.public_comment_id!).data_mode, 'live');
    assert.equal(findLeadByIdentity(ctx, groupId, 'live-spam-1'), undefined);
    assert.equal(findLeadByIdentity(ctx, groupId, 'live-author-1'), undefined);
    assert.equal(run.users_evaluated, 3);
    assert.equal(run.comments_scanned, 2);
  });

  it('live provenance is never downgraded by a later import of the same note, and upgrades the lead', async () => {
    const { ctx, hz, groupId } = setup((c) => new UnavailableXhsProvider(c.clock));
    const note = (commentId: string, text: string) => ({
      platform_post_id: 'note-upgrade-1',
      title: '宝马X3值得买吗',
      content: '',
      tags: [],
      author: { platform_user_id: 'author-up', nickname: 'a' },
      like_count: 0,
      comment_count: 0,
      collect_count: 0,
      ip_location: null,
      published_at: new Date(now - 3_600_000).toISOString(),
      comments: [
        { platform_comment_id: commentId, parent_comment_id: null, author: { platform_user_id: 'buyer-up', nickname: 'b' }, content: text, ip_location: '浙江', like_count: 0, published_at: new Date(now - 600_000).toISOString() },
      ],
    });
    await ingestPublicContent(ctx, { dealer_id: hz, notes: [note('up-1', '杭州X3现在优惠多少')], data_mode: 'import' });
    assert.equal(findLeadByIdentity(ctx, groupId, 'buyer-up')!.data_mode, 'import');
    await ingestPublicContent(ctx, { dealer_id: hz, notes: [note('up-2', '杭州X3 25L有现车吗')], data_mode: 'live' });
    assert.equal(findLeadByIdentity(ctx, groupId, 'buyer-up')!.data_mode, 'live');
    await ingestPublicContent(ctx, { dealer_id: hz, notes: [note('up-2', '杭州X3 25L有现车吗')], data_mode: 'import' });
    assert.equal(ctx.db.table('public_posts').findOne({ platform_post_id: 'note-upgrade-1' })!.data_mode, 'live');
    assert.equal(ctx.db.table('public_comments').findOne({ platform_comment_id: 'up-2' })!.data_mode, 'live');
  });
});

describe('lead-discovery: skill', () => {
  it('is registered as lead-discovery and validates input', async () => {
    assert.equal(skill.name, 'lead-discovery');
    assert.equal(skill.agent, 'lead-hunting-agent');
    const { ctx } = setup();
    const registry = new SkillRegistry().register(skill);
    await assert.rejects(registry.invoke(ctx, 'lead-discovery', { max_queries: 3 }), ValidationError);
    await assert.rejects(registry.invoke(ctx, 'lead-discovery', { dealer_id: 'x', max_queries: 0 }), ValidationError);
  });
});
