/**
 * Wave A integration gate — simulation corpus (A2) ↔ dealer fixture (A1) ↔ NLU (A3) consistency
 * against the fixture canon (ARCHITECTURE.md §9) and the query classes of PRODUCT_SPEC.md §5.
 */
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import type { XhsComment, XhsNoteDetail } from '../../src/providers/xhs/types.ts';
import {
  DEFAULT_SIMULATION_CORPUS_PATH,
  parseSimulationCorpus,
  SimulationXhsProvider,
  type SimComment,
  type SimulationCorpus,
} from '../../src/providers/xhs/simulation.ts';
import { detectIntentRules, prefilter } from '../../src/skills/acquisition/intent-detection/nlu.ts';
import { detectConversationIntents } from '../../src/skills/sales/conversation/nlu.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { accountIdByPlatformId, dealerIdByKey, loadDealerFixture } from '../helpers/fixtures.ts';

const CORPUS_PATH = fileURLToPath(new URL('../../fixtures/xhs/simulation-corpus.json', import.meta.url));
const REFERENCE_NOTE_TITLE = '宝马i3现在值得买吗？';
const REFERENCE_COMMENTS = ['帅', '这车后排空间怎么样', '现在优惠多少', '现在i3优惠多少'];
const SPAMMER = 'u-dealer-spam-001';

/** PRODUCT_SPEC.md §5 query classes with their example keywords. */
const QUERY_CLASSES: Record<string, string[]> = {
  direct_model: ['宝马i3', '宝马i3价格', '宝马i3落地', 'i3优惠', 'i3值得买吗'],
  competitor: ['i3 vs Model 3', 'X3 vs GLC', 'X3 vs Q5L', '3系还是C级'],
  purchase_scenario: ['25万买什么车', '30万SUV', '第一次买宝马', '家用SUV推荐', '准备换车'],
  transaction_intent: ['落地价', '优惠多少', '有现车吗', '贷款方案', '置换补贴', '什么时候买便宜'],
  location: ['杭州宝马', '杭州宝马优惠', '杭州i3', '杭州买宝马', '浙江宝马价格'],
};

interface LoadedNote {
  detail: XhsNoteDetail;
  comments: XhsComment[];
}

function readCorpus(): SimulationCorpus {
  return parseSimulationCorpus(JSON.parse(readFileSync(CORPUS_PATH, 'utf8')));
}

function flatten(comments: readonly SimComment[]): SimComment[] {
  return comments.flatMap((c) => [c, ...flatten(c.sub_comments)]);
}

async function loadAllNotes(provider: SimulationXhsProvider, corpus: SimulationCorpus): Promise<Map<string, LoadedNote>> {
  const out = new Map<string, LoadedNote>();
  for (const note of corpus.notes) {
    const ref = { platform_post_id: note.platform_post_id, xsec_token: note.xsec_token };
    const detail = await provider.getNote(ref);
    assert.ok(detail.ok, `getNote ${note.platform_post_id}: ${detail.ok ? '' : detail.reason}`);
    const comments = await provider.getComments(ref, { include_replies: true, limit: 1000 });
    assert.ok(comments.ok, `getComments ${note.platform_post_id}: ${comments.ok ? '' : comments.reason}`);
    out.set(note.platform_post_id, { detail: detail.data, comments: comments.data });
  }
  return out;
}

function setup(opts: { receive_messages?: boolean } = {}): { ctx: TestContext; provider: SimulationXhsProvider; corpus: SimulationCorpus } {
  const ctx = createTestContext();
  const provider = SimulationXhsProvider.fromFile(ctx.clock, CORPUS_PATH, opts);
  return { ctx, provider, corpus: readCorpus() };
}

describe('integration: simulation corpus consistency', () => {
  it('loads the canonical corpus as a clearly labelled simulation provider', async () => {
    const { provider, corpus } = setup();
    assert.equal(realpathSync(DEFAULT_SIMULATION_CORPUS_PATH), realpathSync(CORPUS_PATH));
    assert.equal(provider.name, 'simulation');
    assert.equal(provider.mode, 'simulation');
    const report = await provider.capabilities(null);
    assert.equal(report.mode, 'simulation');
    assert.equal(report.capabilities.search_public_content.status, 'AVAILABLE');
    assert.equal(report.capabilities.read_public_comments.status, 'AVAILABLE');
    assert.equal(report.capabilities.send_messages.status, 'UNAVAILABLE', 'DM sending is off unless explicitly enabled');
    assert.ok(corpus.notes.length >= 10);
  });

  it('exposes every corpus note and comment at the test clock (nothing dated in the future)', async () => {
    const { provider, corpus } = setup();
    const loaded = await loadAllNotes(provider, corpus);
    for (const note of corpus.notes) {
      const got = loaded.get(note.platform_post_id)!;
      assert.equal(got.detail.title, note.title);
      assert.equal(got.comments.length, flatten(note.comments).length, `hidden comments on ${note.platform_post_id}`);
    }
  });

  it('carries the four §5 reference comments on "宝马i3现在值得买吗？" from distinct users without IP', async () => {
    const { provider, corpus } = setup();
    const search = await provider.searchNotes('i3值得买吗');
    assert.ok(search.ok);
    const hit = search.data.find((n) => n.title === REFERENCE_NOTE_TITLE);
    assert.ok(hit, 'reference note must be discoverable by a direct-model query');

    const comments = await provider.getComments({ platform_post_id: hit.platform_post_id, xsec_token: hit.xsec_token }, { limit: 1000 });
    assert.ok(comments.ok);
    const authors = new Set<string>();
    for (const text of REFERENCE_COMMENTS) {
      const c: XhsComment | undefined = comments.data.find((x) => x.content === text);
      assert.ok(c, `reference comment "${text}" missing on the reference note`);
      assert.equal(c.ip_location, null, `"${text}" must have no IP (reference fixture assumption)`);
      assert.ok(c.author.platform_user_id);
      authors.add(c.author.platform_user_id);
    }
    assert.equal(authors.size, REFERENCE_COMMENTS.length, 'reference comments come from distinct users');

    // the two high-intent reference comments exist in the corpus too
    const all = corpus.notes.flatMap((n) => flatten(n.comments)).map((c) => c.content);
    assert.ok(all.includes('杭州i3 35L落地多少'));
    assert.ok(all.includes('杭州i3 35L白外红内有现车吗？这周想去看看'));
  });

  it('has u-hz-buyer-001 commenting on at least 3 different notes (dedup scenario)', async () => {
    const { provider, corpus } = setup();
    const loaded = await loadAllNotes(provider, corpus);
    const notes = [...loaded.entries()]
      .filter(([, n]) => n.comments.some((c) => c.author.platform_user_id === 'u-hz-buyer-001'))
      .map(([id]) => id);
    assert.ok(new Set(notes).size >= 3, `u-hz-buyer-001 comments on ${notes.length} notes: ${notes.join(', ')}`);
    const profile = await provider.getUserProfile({ platform_user_id: 'u-hz-buyer-001' });
    assert.ok(profile.ok);
    assert.equal(profile.data.ip_location, '浙江');
  });

  it('attributes own published notes to the fixture accounts named in the canon', async () => {
    const { ctx, provider, corpus } = setup();
    const summary = loadDealerFixture(ctx);
    const hzDealerId = dealerIdByKey(summary, 'hz-bmw');
    const fixtureAccounts = new Set(Object.keys(summary.account_ids));

    const expected: Record<string, string> = { 'note-own-hz-i3-001': 'xhs-hz-i3', 'note-own-hz-x3-001': 'xhs-hz-sales-li' };
    for (const [noteId, platformAccountId] of Object.entries(expected)) {
      const note = await provider.getNote({ platform_post_id: noteId });
      assert.ok(note.ok, `own note ${noteId} missing`);
      assert.equal(note.data.author.platform_user_id, platformAccountId);
      const account = ctx.db.table('xhs_accounts').require(accountIdByPlatformId(summary, platformAccountId));
      assert.equal(account.dealer_id, hzDealerId);
      assert.equal(account.platform_account_id, platformAccountId);
      assert.equal(note.data.author.nickname, account.nickname, 'corpus nickname matches the managed account');
    }

    // every managed-account author in the corpus is a fixture account, and only the canonical notes are "own"
    const ownNotes = corpus.notes.filter((n) => fixtureAccounts.has(n.author.platform_user_id)).map((n) => n.platform_post_id);
    assert.deepEqual(ownNotes.sort(), Object.keys(expected).sort());
    for (const note of corpus.notes) {
      if (note.author.platform_user_id.startsWith('xhs-')) assert.ok(fixtureAccounts.has(note.author.platform_user_id), note.author.platform_user_id);
    }
    for (const p of corpus.profiles) {
      if (p.platform_user_id.startsWith('xhs-')) assert.ok(fixtureAccounts.has(p.platform_user_id), `profile ${p.platform_user_id}`);
    }
  });

  it('scripts inbox replies only from users present in the corpus, releasing them after a recorded contact', async () => {
    const { ctx, provider, corpus } = setup({ receive_messages: true });
    const summary = loadDealerFixture(ctx);
    const fixtureAccounts = new Set(Object.keys(summary.account_ids));
    const known = new Set<string>([
      ...corpus.profiles.map((p) => p.platform_user_id),
      ...corpus.notes.flatMap((n) => flatten(n.comments).map((c) => c.author.platform_user_id)),
    ]);
    assert.ok(corpus.inbox_scripts.length > 0);
    for (const script of corpus.inbox_scripts) {
      assert.ok(known.has(script.from_user_id), `inbox script user ${script.from_user_id} is not in the corpus`);
      if (script.to_account_platform_id !== null) assert.ok(fixtureAccounts.has(script.to_account_platform_id));
    }
    const scriptUsers = new Set(corpus.inbox_scripts.map((s) => s.from_user_id));
    assert.ok(scriptUsers.has('u-hz-buyer-002'));
    assert.ok(scriptUsers.has('u-negative-001'));

    // the canonical suppression reply is understood by conversation NLU (A3)
    const negative = corpus.inbox_scripts.find((s) => s.from_user_id === 'u-negative-001')!;
    assert.ok(detectConversationIntents(negative.content).intents.includes('not_interested'));

    // scripted replies are released only after contact + delay (simulation clock)
    const accountId = 'xhs-hz-sales-wang';
    const before = await provider.listInboundMessages(accountId, null);
    assert.ok(before.ok);
    assert.equal(before.data.length, 0, 'nobody replies before being contacted');
    provider.recordManualContact(accountId, 'u-negative-001');
    ctx.clock.advance({ minutes: negative.delay_minutes - 1 });
    const early = await provider.listInboundMessages(accountId, null);
    assert.ok(early.ok);
    assert.equal(early.data.length, 0, 'reply is not released before its delay');
    ctx.clock.advance({ minutes: 2 });
    const released = await provider.listInboundMessages(accountId, null);
    assert.ok(released.ok);
    assert.equal(released.data.length, 1);
    assert.equal(released.data[0].from_user_id, 'u-negative-001');
    assert.equal(released.data[0].content, negative.content);
  });

  it('marks every u-dealer-spam-001 comment as marketing, and nobody else', async () => {
    const { provider, corpus } = setup();
    const loaded = await loadAllNotes(provider, corpus);
    let spam = 0;
    for (const { detail, comments } of loaded.values()) {
      const context = { source_type: 'comment' as const, post_title: detail.title, post_content: detail.content };
      for (const c of comments) {
        const pf = prefilter(c.content, context);
        if (c.author.platform_user_id === SPAMMER) {
          spam++;
          assert.equal(pf.is_marketing, true, `spam comment not marked marketing: "${c.content}"`);
          assert.equal(pf.passed, false);
          assert.equal(detectIntentRules(c.content, context).is_purchase_signal, false, `spam treated as purchase signal: "${c.content}"`);
        } else {
          assert.equal(pf.is_marketing, false, `false marketing flag on ${c.author.platform_user_id}: "${c.content}"`);
        }
      }
    }
    assert.ok(spam >= 3, `expected several spam comments, found ${spam}`);
  });

  it('returns notes for the PRODUCT_SPEC §5 query classes (≥4 of 5 classes fully covered)', async () => {
    const { provider } = setup();
    const covered: string[] = [];
    const misses: string[] = [];
    for (const [cls, keywords] of Object.entries(QUERY_CLASSES)) {
      let hits = 0;
      for (const keyword of keywords) {
        const res = await provider.searchNotes(keyword);
        assert.ok(res.ok, `search "${keyword}" failed: ${res.ok ? '' : res.reason}`);
        if (res.data.length >= 1) hits++;
        else misses.push(`${cls}:${keyword}`);
      }
      assert.ok(hits >= 1, `query class ${cls} finds nothing`);
      if (hits === keywords.length) covered.push(cls);
    }
    assert.ok(covered.length >= 4, `only ${covered.length}/5 classes fully covered; misses: ${misses.join(', ')}`);

    // spec §19 search-intelligence examples, typed without spaces
    for (const q of ['杭州i3落地', '杭州i3有现车吗']) {
      const res = await provider.searchNotes(q);
      assert.ok(res.ok && res.data.length >= 1, `"${q}" should find at least one note`);
    }
    // an unrelated lifestyle note never matches a car query
    const res = await provider.searchNotes('宝马i3');
    assert.ok(res.ok);
    assert.ok(res.data.some((n) => n.title === REFERENCE_NOTE_TITLE));
    assert.ok(!res.data.some((n) => n.platform_post_id === 'note-hz-cafe-001'));
  });
});
