import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ManualClock } from '../../../src/core/clock.ts';
import { XHS_CAPABILITIES } from '../../../src/core/types.ts';
import {
  DEFAULT_SIMULATION_CORPUS_PATH,
  parseSimulationCorpus,
  simulationQueryGroups,
  SimulationXhsProvider,
  type SimulationCorpus,
  type SimulationOptions,
} from '../../../src/providers/xhs/simulation.ts';
import { createXhsProvider, xhsProviderConfigFromEnv } from '../../../src/providers/xhs/index.ts';
import type { ProviderResult, XhsComment, XhsNoteSummary } from '../../../src/providers/xhs/types.ts';
import { ValidationError } from '../../../src/core/errors.ts';
import { TEST_NOW } from '../../helpers/context.ts';

function provider(opts: SimulationOptions = {}, now = TEST_NOW) {
  const clock = new ManualClock(now);
  return { clock, sim: SimulationXhsProvider.fromFile(clock, DEFAULT_SIMULATION_CORPUS_PATH, opts) };
}

function unwrap<T>(res: ProviderResult<T>): T {
  if (!res.ok) assert.fail(`expected ok result, got ${res.status}: ${res.reason}`);
  return res.data;
}

async function searchIds(sim: SimulationXhsProvider, q: string, opts = {}): Promise<string[]> {
  return unwrap(await sim.searchNotes(q, opts)).map((n: XhsNoteSummary) => n.platform_post_id);
}

async function allComments(sim: SimulationXhsProvider): Promise<(XhsComment & { note: string })[]> {
  const out: (XhsComment & { note: string })[] = [];
  const notes = unwrap(await sim.searchNotes('宝马', { limit: 100 }));
  const extra = ['note-i3-vs-m3-001', 'note-25w-budget-001', 'note-hz-cafe-001', 'note-3series-vs-c-001', 'note-x3-vs-glc-001', 'note-buyer-suv-001'];
  const ids = new Set([...notes.map((n) => n.platform_post_id), ...extra]);
  for (const id of ids) {
    for (const c of unwrap(await sim.getComments({ platform_post_id: id }, { include_replies: true }))) out.push({ ...c, note: id });
  }
  return out;
}

describe('simulation corpus fixture', () => {
  it('validates and meets size/time canon', async () => {
    const { readFileSync } = await import('node:fs');
    const corpus = parseSimulationCorpus(JSON.parse(readFileSync(DEFAULT_SIMULATION_CORPUS_PATH, 'utf8')));
    assert.ok(corpus.notes.length >= 14, `notes ${corpus.notes.length}`);
    let comments = 0;
    const stamps: string[] = [];
    const walk = (list: SimulationCorpus['notes'][number]['comments']) => {
      for (const c of list) {
        comments++;
        stamps.push(c.published_at);
        walk(c.sub_comments);
      }
    };
    for (const n of corpus.notes) {
      stamps.push(n.published_at);
      walk(n.comments);
    }
    assert.ok(comments >= 90, `comments ${comments}`);
    stamps.sort();
    assert.equal(stamps.at(-1), '2026-09-12T01:00:00.000Z');
    assert.ok(stamps[0].startsWith('2026-06'), 'has older content for recency tests');
    assert.ok(stamps.filter((s) => s >= '2026-09-05').length > stamps.length * 0.9);
  });

  it('rejects structurally broken corpora', () => {
    const good = {
      notes: [
        {
          platform_post_id: 'n1', xsec_token: 't', title: 'x', content: 'y', author: { platform_user_id: 'u', nickname: 'a' },
          published_at: '2026-09-01T00:00:00Z',
          comments: [{ platform_comment_id: 'c1', author: { platform_user_id: 'u2', nickname: 'b' }, content: 'hi', published_at: '2026-09-01T01:00:00Z' }],
        },
      ],
    };
    assert.equal(parseSimulationCorpus(good).notes[0].comments[0].sub_comments.length, 0);
    const dupComment = structuredClone(good);
    dupComment.notes[0].comments.push({ ...dupComment.notes[0].comments[0] });
    assert.throws(() => parseSimulationCorpus(dupComment), /duplicate comment id c1/);
    const badTime = structuredClone(good);
    badTime.notes[0].published_at = 'yesterday-ish';
    assert.throws(() => parseSimulationCorpus(badTime), /invalid ISO timestamp/);
    assert.throws(() => parseSimulationCorpus({ ...good, profiles: [{ platform_user_id: 'u', nickname: 'a', recent_note_ids: ['nope'] }] }), /unknown note nope/);
    assert.throws(() => parseSimulationCorpus({ notes: 'x' }), /corpus.notes/);
  });
});

describe('SimulationXhsProvider search', () => {
  it('finds relevant notes for every query class', async () => {
    const { sim } = provider();
    const expectations: Record<string, string[]> = {
      // direct model
      宝马i3: ['note-i3-worth-001', 'note-hz-i3-testdrive-001', 'note-own-hz-i3-001'],
      i3值得买吗: ['note-i3-worth-001', 'note-hz-i3-testdrive-001'],
      宝马X3: ['note-x3-vs-glc-001', 'note-own-hz-x3-001', 'note-buyer-suv-001'],
      '3系': ['note-3series-vs-c-001', 'note-first-bmw-001'],
      // competitor
      'i3 vs Model 3': ['note-i3-vs-m3-001'],
      'X3 vs GLC': ['note-x3-vs-glc-001'],
      'X3 vs Q5L': ['note-buyer-suv-001'],
      '3系还是C级': ['note-3series-vs-c-001'],
      // purchase scenario
      '25万买什么车': ['note-25w-budget-001'],
      '30万SUV': ['note-x3-vs-glc-001', 'note-buyer-suv-001', 'note-own-hz-x3-001'],
      家用SUV推荐: ['note-x3-vs-glc-001', 'note-buyer-suv-001'],
      准备换车: ['note-25w-budget-001', 'note-buyer-suv-001'],
      第一次买宝马: ['note-first-bmw-001', 'note-3series-vs-c-001'],
      // transaction
      落地价: ['note-first-bmw-001', 'note-sh-x3-pickup-001', 'note-hz-buying-guide-001'],
      优惠多少: ['note-first-bmw-001', 'note-bmw-finance-001'],
      有现车吗: ['note-own-hz-i3-001', 'note-own-hz-x3-001', 'note-hz-buying-guide-001'],
      贷款方案: ['note-bmw-finance-001', 'note-first-bmw-001'],
      置换补贴: ['note-bmw-finance-001', 'note-own-hz-x3-001'],
      // location
      杭州宝马: ['note-own-hz-i3-001', 'note-own-hz-x3-001', 'note-hz-buying-guide-001'],
      杭州i3: ['note-own-hz-i3-001', 'note-hz-i3-testdrive-001'],
      杭州买宝马: ['note-hz-buying-guide-001', 'note-first-bmw-001', 'note-buyer-suv-001'],
      上海宝马: ['note-sh-x3-pickup-001'],
      上海X3: ['note-sh-x3-pickup-001'],
    };
    for (const [query, expected] of Object.entries(expectations)) {
      const ids = await searchIds(sim, query);
      for (const id of expected) assert.ok(ids.includes(id), `query "${query}" should find ${id}; got ${ids.join(', ')}`);
      assert.ok(!ids.includes('note-hz-cafe-001'), `off-topic note must not match "${query}"`);
    }
    assert.ok(!(await searchIds(sim, '上海X3')).includes('note-own-hz-x3-001'), 'Hangzhou X3 note is not a Shanghai result');
    assert.deepEqual(await searchIds(sim, '保时捷卡宴'), []);
  });

  it('ranks by relevance, recency or likes and honours limit and publish window', async () => {
    const { sim } = provider();
    const general = await searchIds(sim, '宝马i3现在值得买吗');
    assert.equal(general[0], 'note-i3-worth-001');

    const latest = unwrap(await sim.searchNotes('宝马i3', { sort: 'latest' }));
    const times = latest.map((n) => n.published_at!);
    assert.deepEqual(times, [...times].sort().reverse());

    const popular = unwrap(await sim.searchNotes('宝马i3', { sort: 'popular' }));
    const likes = popular.map((n) => n.like_count);
    assert.deepEqual(likes, [...likes].sort((a, b) => b - a));

    assert.equal(unwrap(await sim.searchNotes('宝马i3', { limit: 2 })).length, 2);
    const all = await searchIds(sim, 'i3值得买吗');
    assert.ok(all.includes('note-i3-one-year-001'), 'old June note is found without a window');
    const recent = await searchIds(sim, 'i3值得买吗', { published_within_days: 30 });
    assert.ok(!recent.includes('note-i3-one-year-001'), 'old note excluded by published_within_days');

    const first = latest[0];
    assert.equal(first.author.profile_url, `https://www.xiaohongshu.com/user/profile/${first.author.platform_user_id}`);
    assert.ok(first.url?.startsWith(`https://www.xiaohongshu.com/explore/${first.platform_post_id}?xsec_token=`));
    const blank = await sim.searchNotes('  ？？ ');
    assert.equal(blank.ok, false);
  });

  it('hides content that is not yet published at clock time', async () => {
    const { sim } = provider({}, '2026-09-09T00:00:00Z');
    const ids = await searchIds(sim, '杭州i3');
    assert.ok(!ids.includes('note-hz-i3-testdrive-001'), 'note published 2026-09-10 is not visible on 09-09');
    const res = await sim.getNote({ platform_post_id: 'note-hz-i3-testdrive-001' });
    assert.equal(res.ok, false);
    const comments = unwrap(await sim.getComments({ platform_post_id: 'note-i3-worth-001' }));
    assert.ok(!comments.some((c) => c.content === '帅'), 'comment from 09-10 not visible yet');
  });
});

describe('SimulationXhsProvider reads', () => {
  it('serves the reference note with distinct reference commenters', async () => {
    const { sim } = provider();
    const hit = unwrap(await sim.searchNotes('宝马i3现在值得买吗？')).find((n) => n.title === '宝马i3现在值得买吗？');
    assert.ok(hit, 'reference note searchable by title');
    const note = unwrap(await sim.getNote({ platform_post_id: hit.platform_post_id, xsec_token: hit.xsec_token }));
    assert.equal(note.title, '宝马i3现在值得买吗？');
    assert.ok(note.tags.includes('宝马i3'));
    assert.ok(note.comment_count >= 13);
    const comments = unwrap(await sim.getComments(hit));
    const refs = ['帅', '这车后排空间怎么样', '现在优惠多少', '现在i3优惠多少'];
    const authors = refs.map((text) => {
      const c = comments.find((x) => x.content === text);
      assert.ok(c, `reference comment ${text} present`);
      return c.author.platform_user_id;
    });
    assert.equal(new Set(authors).size, refs.length, 'each reference comment has a distinct author');
    assert.ok(comments.some((c) => c.content === '杭州i3 35L落地多少' && c.author.platform_user_id === 'u-hz-buyer-001' && c.ip_location === '浙江'));
  });

  it('flattens replies with parent ids only when include_replies', async () => {
    const { sim } = provider();
    const ref = { platform_post_id: 'note-i3-worth-001' };
    const tops = unwrap(await sim.getComments(ref));
    assert.ok(tops.every((c) => c.parent_comment_id === null && c.sub_comments === undefined));
    const flat = unwrap(await sim.getComments(ref, { include_replies: true }));
    assert.ok(flat.length > tops.length);
    const r1 = flat.find((c) => c.platform_comment_id === 'c-i3worth-002-r1');
    const r2 = flat.find((c) => c.platform_comment_id === 'c-i3worth-002-r2');
    assert.equal(r1?.parent_comment_id, 'c-i3worth-002');
    assert.equal(r2?.parent_comment_id, 'c-i3worth-002-r1', 'explicit parent reference preserved');
    const parentIdx = flat.findIndex((c) => c.platform_comment_id === 'c-i3worth-002');
    assert.equal(flat[parentIdx + 1].platform_comment_id, 'c-i3worth-002-r1', 'replies follow their parent');
    const limited = unwrap(await sim.getComments(ref, { limit: 2 }));
    assert.equal(limited.length, 2);
  });

  it('models the canonical users across notes', async () => {
    const { sim } = provider();
    const comments = await allComments(sim);
    const buyer1 = comments.filter((c) => c.author.platform_user_id === 'u-hz-buyer-001');
    const buyer1Notes = new Set(buyer1.map((c) => c.note));
    assert.ok(buyer1Notes.size >= 3, 'u-hz-buyer-001 appears on >= 3 notes');
    for (const text of ['i3和Model 3到底选哪个，纠结死了', '杭州i3 35L落地多少', '杭州i3 35L白外红内有现车吗？这周想去看看']) {
      assert.ok(buyer1.some((c) => c.content === text), `buyer1 says ${text}`);
    }
    const own = comments.filter((c) => c.note === 'note-own-hz-i3-001');
    assert.ok(own.some((c) => c.author.platform_user_id === 'u-hz-buyer-002' && c.content === '这台白色35L还在吗？多少钱'));
    const spam = comments.filter((c) => c.author.platform_user_id === 'u-dealer-spam-001');
    assert.ok(new Set(spam.map((c) => c.note)).size >= 3);
    assert.ok(comments.some((c) => c.author.platform_user_id === 'u-gd-buyer-001' && c.ip_location === '广东' && c.content === '深圳i3 35L落地多少'));
    for (const text of ['上海X3现在什么价', '上海哪家宝马店靠谱']) {
      assert.ok(comments.some((c) => c.content === text && c.ip_location === '上海'), text);
    }
    for (const text of ['i3贷款方案怎么样，首付多少', 'X3可以以租代购吗', '旧车置换宝马X3有补贴吗', 'X3和GLC选哪个', '3系还是C级，预算30万', '杭州哪家宝马店靠谱，求推荐销售', 'X3 25L现在多少钱', '有白色现车吗', '已经提了Model Y 很香']) {
      assert.ok(comments.some((c) => c.content === text), `corpus contains ${text}`);
    }
    const buyerPost = unwrap(await sim.getNote({ platform_post_id: 'note-buyer-suv-001' }));
    assert.equal(buyerPost.author.platform_user_id, 'u-hz-author-001');
    assert.equal(buyerPost.ip_location, '浙江');
    const ownX3 = unwrap(await sim.getNote({ platform_post_id: 'note-own-hz-x3-001' }));
    assert.equal(ownX3.author.platform_user_id, 'xhs-hz-sales-li');
    assert.equal(ownX3.author.nickname, '李姐聊宝马');
  });

  it('returns stored profiles and derives minimal ones from comments', async () => {
    const { sim } = provider();
    const spam = unwrap(await sim.getUserProfile({ platform_user_id: 'u-dealer-spam-001' }));
    assert.equal(spam.bio, '杭州某宝马4S店销售顾问｜买车找我');
    const buyer = unwrap(await sim.getUserProfile({ platform_user_id: 'u-hz-buyer-001' }));
    assert.equal(buyer.bio, '杭州｜准备换电车');
    assert.equal(buyer.ip_location, '浙江');
    const author = unwrap(await sim.getUserProfile({ platform_user_id: 'u-hz-author-001' }));
    assert.deepEqual(author.recent_notes.map((n) => n.platform_post_id), ['note-buyer-suv-001']);
    for (const id of ['u-hz-buyer-002', 'u-negative-001', 'u-gd-buyer-001']) assert.equal((await sim.getUserProfile({ platform_user_id: id })).ok, true);

    const derived = unwrap(await sim.getUserProfile({ platform_user_id: 'u-sh-buyer-001' }));
    assert.equal(derived.nickname, '魔都打工仔');
    assert.equal(derived.ip_location, '上海');
    assert.equal(derived.bio, null);
    assert.equal(derived.follower_count, null);
    const kol = unwrap(await sim.getUserProfile({ platform_user_id: 'u-kol-ev-001' }));
    assert.deepEqual(kol.recent_notes.map((n) => n.platform_post_id), ['note-i3-worth-001']);
    const missing = await sim.getUserProfile({ platform_user_id: 'nobody' });
    assert.equal(missing.ok, false);
  });
});

describe('SimulationXhsProvider capabilities & actions', () => {
  it('defaults: reads AVAILABLE, write-like capabilities UNAVAILABLE with honest reasons', async () => {
    const { sim } = provider();
    const report = await sim.capabilities('acc_1');
    assert.equal(report.mode, 'simulation');
    assert.equal(report.provider, 'simulation');
    for (const cap of ['search_public_content', 'read_public_post', 'read_public_comments', 'read_public_profile', 'read_engagement'] as const) {
      assert.equal(report.capabilities[cap].status, 'AVAILABLE', cap);
    }
    for (const cap of ['send_messages', 'receive_messages', 'publish_content', 'reply_comments'] as const) {
      assert.equal(report.capabilities[cap].status, 'UNAVAILABLE', cap);
    }
    assert.match(report.capabilities.send_messages.reason, /mirrors the live platform/);
    assert.match(report.capabilities.send_messages.reason, /no authorized API/);
    const send = await sim.sendMessage('acc_1', 'u-hz-buyer-001', '你好');
    assert.equal(send.ok, false);
    if (!send.ok) assert.equal(send.status, 'UNAVAILABLE');
    assert.equal((await sim.publishNote('acc_1', { title: 't', body: 'b', tags: [] })).ok, false);
    assert.equal((await sim.replyToComment('acc_1', { platform_post_id: 'note-own-hz-i3-001', platform_comment_id: 'c-own-i3-001' }, '在的')).ok, false);
    assert.equal((await sim.listInboundMessages('acc_1', null)).ok, false);
    assert.deepEqual(sim.sentMessages(), [], 'nothing recorded for refused sends');
  });

  it('enables write-like capabilities through options', async () => {
    const { sim } = provider({ send_messages: true, publish: true, receive_messages: true, reply_comments: true });
    const report = await sim.capabilities('acc_1');
    // Everything an option can enable; the notification centre is not one of them — it exists only for a real account.
    for (const cap of XHS_CAPABILITIES.filter((c) => c !== 'read_notifications')) assert.equal(report.capabilities[cap].status, 'AVAILABLE', cap);
    assert.equal(report.capabilities.read_notifications.status, 'UNAVAILABLE');
    assert.match(report.capabilities.read_notifications.reason, /real logged-in account/);
    const reply = unwrap(await sim.replyToComment('acc_1', { platform_post_id: 'note-own-hz-i3-001', platform_comment_id: 'c-own-i3-001' }, '在的，欢迎到店看车'));
    assert.equal(reply.provider_message_id, 'sim-reply-1');
    assert.equal(sim.sentReplies()[0].platform_comment_id, 'c-own-i3-001');
    const badReply = await sim.replyToComment('acc_1', { platform_post_id: 'note-own-hz-i3-001', platform_comment_id: 'nope' }, 'x');
    assert.equal(badReply.ok, false);
  });

  it('REQUIRES_AUTH per account (internal or platform id)', async () => {
    const { sim } = provider({ send_messages: true, auth_required_accounts: ['xhs-hz-official'], account_platform_ids: { acc_off: 'xhs-hz-official', acc_i3: 'xhs-hz-i3' } });
    const locked = await sim.capabilities('acc_off');
    assert.equal(locked.capabilities.search_public_content.status, 'REQUIRES_AUTH');
    assert.equal(locked.capabilities.send_messages.status, 'REQUIRES_AUTH');
    assert.equal(locked.capabilities.publish_content.status, 'UNAVAILABLE', 'disabled stays UNAVAILABLE');
    const other = await sim.capabilities('acc_i3');
    assert.equal(other.capabilities.send_messages.status, 'AVAILABLE');
    const provLevel = await sim.capabilities(null);
    assert.equal(provLevel.capabilities.search_public_content.status, 'AVAILABLE');
    const res = await sim.sendMessage('acc_off', 'u-hz-buyer-001', '你好');
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.status, 'REQUIRES_AUTH');
    const search = await sim.searchNotes('宝马i3', {}, 'xhs-hz-official');
    assert.equal(search.ok, false);
    assert.equal((await sim.searchNotes('宝马i3', {}, null)).ok, true);
  });

  it('releases scripted inbox replies after the delay, only to the contacting account, in order', async () => {
    const { sim, clock } = provider({ send_messages: true, receive_messages: true });
    const sent = unwrap(await sim.sendMessage('acc_wang', 'u-hz-buyer-002', '您好，看到您问白色35L，这台还在店里'));
    assert.equal(sent.provider_message_id, 'sim-msg-1');
    assert.deepEqual(sim.sentMessages(), [{ account_id: 'acc_wang', to: 'u-hz-buyer-002', text: '您好，看到您问白色35L，这台还在店里', at: TEST_NOW }]);
    assert.deepEqual(unwrap(await sim.listInboundMessages('acc_wang', null)), []);

    clock.advance({ minutes: 29 });
    assert.deepEqual(unwrap(await sim.listInboundMessages('acc_wang', null)), []);
    clock.advance({ minutes: 1 });
    const first = unwrap(await sim.listInboundMessages('acc_wang', null));
    assert.equal(first.length, 1);
    assert.equal(first[0].provider_message_id, 'sim-in-u-hz-buyer-002-0');
    assert.equal(first[0].content, '在的话我想了解下，白外红内那台还在吗？落地大概多少');
    assert.equal(first[0].sent_at, '2026-09-12T02:30:00.000Z');
    assert.equal(first[0].from_nickname, '钱塘江的风');
    assert.equal(first[0].account_id, 'acc_wang');
    assert.deepEqual(unwrap(await sim.listInboundMessages('acc_li', null)), [], 'other accounts see nothing');

    // a later outbound message does not move the original contact time
    clock.advance({ minutes: 10 });
    unwrap(await sim.sendMessage('acc_wang', 'u-hz-buyer-002', '落地价我帮您核算下'));
    clock.advance({ minutes: 50 });
    const both = unwrap(await sim.listInboundMessages('acc_wang', null));
    assert.deepEqual(both.map((m) => m.provider_message_id), ['sim-in-u-hz-buyer-002-0', 'sim-in-u-hz-buyer-002-1']);
    assert.match(both[1].content, /13800001234/);
    const since = unwrap(await sim.listInboundMessages('acc_wang', first[0].sent_at));
    assert.deepEqual(since.map((m) => m.provider_message_id), ['sim-in-u-hz-buyer-002-1']);
    assert.equal((await sim.listInboundMessages('acc_wang', 'not-a-date')).ok, false);
  });

  it('respects explicit script targets resolved through account_platform_ids; null targets reach only the first contact', async () => {
    const clock = new ManualClock(TEST_NOW);
    const corpus: SimulationCorpus = {
      notes: [],
      profiles: [],
      inbox_scripts: [
        { from_user_id: 'u1', to_account_platform_id: 'xhs-hz-i3', delay_minutes: 5, content: '只回复i3账号' },
        { from_user_id: 'u1', to_account_platform_id: null, delay_minutes: 1, content: '任何账号' },
      ],
    };
    const sim = new SimulationXhsProvider(clock, corpus, { receive_messages: true, account_platform_ids: { acc_i3: 'xhs-hz-i3', acc_li: 'xhs-hz-sales-li' } });
    // same instant: insertion order decides who contacted first
    sim.recordManualContact('acc_i3', 'u1');
    sim.recordManualContact('acc_li', 'u1');
    clock.advance({ minutes: 10 });
    const i3 = unwrap(await sim.listInboundMessages('acc_i3', null));
    // released in order: the second script (1 min) may not precede the first (5 min), so both land at +5 min
    assert.deepEqual(i3.map((m) => m.content), ['只回复i3账号', '任何账号']);
    assert.equal(i3[0].sent_at, '2026-09-12T02:05:00.000Z');
    assert.equal(i3[1].sent_at, i3[0].sent_at);
    assert.deepEqual(i3.map((m) => m.provider_message_id), ['sim-in-u1-0', 'sim-in-u1-1']);
    const li = unwrap(await sim.listInboundMessages('acc_li', null));
    assert.deepEqual(li, [], 'the later contact neither gets the targeted script nor a duplicate of the null-target reply');
    assert.equal(sim.contactedAt('xhs-hz-i3', 'u1'), TEST_NOW, 'platform id and internal id share contact state');
    const viaPlatformId = unwrap(await sim.listInboundMessages('xhs-hz-i3', null));
    assert.deepEqual(viaPlatformId.map((m) => m.provider_message_id), ['sim-in-u1-0', 'sim-in-u1-1']);
  });

  it('recordManualContact releases replies without sending anything (negative reply)', async () => {
    const { sim, clock } = provider({ receive_messages: true });
    sim.recordManualContact('acc_wang', 'u-negative-001');
    assert.deepEqual(sim.sentMessages(), []);
    clock.advance({ minutes: 20 });
    const msgs = unwrap(await sim.listInboundMessages('acc_wang', null));
    assert.deepEqual(msgs.map((m) => [m.from_user_id, m.content]), [['u-negative-001', '不需要，别再发了']]);
    assert.throws(() => sim.recordManualContact('', 'u'), /accountId/);
  });

  it('publishes searchable notes with growing deterministic engagement', async () => {
    const { sim, clock } = provider({ publish: true, account_platform_ids: { acc_i3: 'xhs-hz-i3' } });
    const pub = unwrap(await sim.publishNote('acc_i3', { title: '杭州i4到店实拍', body: '宝马i4 eDrive35 到店，欢迎来看车', tags: ['杭州宝马', '宝马i4'] }));
    assert.equal(pub.platform_note_id, 'sim-note-1');
    assert.match(pub.url ?? '', /^https:\/\/www\.xiaohongshu\.com\/explore\/sim-note-1\?xsec_token=/);
    const found = unwrap(await sim.searchNotes('宝马i4'));
    assert.equal(found[0].platform_post_id, 'sim-note-1');
    assert.equal(found[0].author.nickname, 'i3电车研究所');
    assert.deepEqual(unwrap(await sim.getComments({ platform_post_id: 'sim-note-1' })), []);
    const e0 = unwrap(await sim.getEngagement('acc_i3', 'sim-note-1'));
    assert.equal(e0.likes, 0);
    clock.advance({ hours: 6 });
    const e6 = unwrap(await sim.getEngagement('acc_i3', 'sim-note-1'));
    clock.advance({ hours: 18 });
    const e24 = unwrap(await sim.getEngagement('acc_i3', 'sim-note-1'));
    assert.ok(e6.views! > 0 && e24.views! > e6.views! && e24.likes >= e6.likes && e24.likes > 0);
    assert.deepEqual(unwrap(await sim.getEngagement('acc_i3', 'sim-note-1')), e24, 'deterministic');
    const corpusNote = unwrap(await sim.getEngagement('acc_i3', 'note-own-hz-i3-001'));
    assert.deepEqual([corpusNote.views, corpusNote.likes, corpusNote.collects], [null, 368, 142]);
    assert.equal((await sim.getEngagement('acc_i3', 'missing')).ok, false);
    assert.equal(sim.publishedNotes().length, 1);
    assert.equal((await sim.publishNote('acc_i3', { title: ' ', body: 'x', tags: [] })).ok, false);
  });

  it('rebase_to_now shifts every timestamp so the newest is now − 1h', async () => {
    const now = '2026-11-20T08:00:00.000Z';
    const { sim } = provider({ rebase_to_now: true }, now);
    const comments = unwrap(await sim.getComments({ platform_post_id: 'note-hz-i3-testdrive-001' }));
    const newest = comments.find((c) => c.author.platform_user_id === 'u-hz-buyer-001');
    assert.equal(newest?.published_at, '2026-11-20T07:00:00.000Z');
    const shiftMs = Date.parse('2026-11-20T07:00:00Z') - Date.parse('2026-09-12T01:00:00Z');
    assert.equal(sim.rebaseOffsetMs, shiftMs);
    const note = unwrap(await sim.getNote({ platform_post_id: 'note-i3-worth-001' }));
    assert.equal(note.published_at, new Date(Date.parse('2026-09-08T11:30:00Z') + shiftMs).toISOString());
    const recent = await searchIds(sim, '宝马i3', { published_within_days: 7 });
    assert.ok(recent.includes('note-i3-worth-001'), 'rebased content counts as recent');

    const { sim: plain } = provider({}, now);
    assert.equal(plain.rebaseOffsetMs, 0);
    assert.deepEqual(await searchIds(plain, '宝马i3', { published_within_days: 7 }), []);
  });

  it('id_namespace keeps generated ids unique across demo restarts', async () => {
    const { sim } = provider({ send_messages: true, id_namespace: 'r2' });
    assert.equal(unwrap(await sim.sendMessage('a', 'u', 'hi')).provider_message_id, 'sim-msg-r2-1');
  });
});

describe('createXhsProvider / env config', () => {
  it('builds providers from config and env', async () => {
    const clock = new ManualClock(TEST_NOW);
    const none = createXhsProvider(clock, { kind: 'none' });
    assert.equal(none.mode, 'none');
    const cfg = xhsProviderConfigFromEnv({ XHS_PROVIDER: 'simulation', XHS_SIM_SEND_MESSAGES: 'true', XHS_SIM_AUTH_REQUIRED_ACCOUNTS: 'a,b' });
    assert.equal(cfg.kind, 'simulation');
    const sim = createXhsProvider(clock, cfg);
    assert.equal(sim.mode, 'simulation');
    assert.equal((await sim.capabilities('x')).capabilities.send_messages.status, 'AVAILABLE');
    assert.equal((await sim.capabilities('a')).capabilities.send_messages.status, 'REQUIRES_AUTH');

    const mcp = xhsProviderConfigFromEnv({
      XHS_PROVIDER: 'mcp',
      XHS_MCP_TOKEN: 'secret',
      XHS_MCP_ACCOUNTS: 'xhs-hz-official=http://127.0.0.1:18061/mcp,xhs-hz-i3=http://127.0.0.1:18062/mcp',
      XHS_MCP_RESEARCH_URL: 'http://127.0.0.1:18060/mcp',
      XHS_MCP_TIMEOUT_MS: '90000',
    });
    assert.ok(mcp.kind === 'mcp');
    assert.deepEqual(mcp.mcp.account_endpoints['xhs-hz-i3'], { url: 'http://127.0.0.1:18062/mcp', token: 'secret' });
    assert.equal(mcp.mcp.timeout_ms, 90000);
    assert.equal(createXhsProvider(clock, mcp).mode, 'live');
    const json = xhsProviderConfigFromEnv({ XHS_PROVIDER: 'mcp', XHS_MCP_ACCOUNTS: '{"xhs-sh-official":{"url":"http://10.0.0.2:18060/mcp","token":"t2"}}' });
    assert.ok(json.kind === 'mcp');
    assert.deepEqual(json.mcp.account_endpoints['xhs-sh-official'], { url: 'http://10.0.0.2:18060/mcp', token: 't2' });
    // v3 (ARCHITECTURE §10.3): endpoints may come from xhs_accounts.mcp_endpoint_url, so an mcp config without env
    // endpoints is valid; the provider then reports the missing endpoint explicitly instead of failing at startup.
    const dbOnly = xhsProviderConfigFromEnv({ XHS_PROVIDER: 'mcp' });
    assert.ok(dbOnly.kind === 'mcp');
    assert.deepEqual(dbOnly.mcp.account_endpoints, {});
    const dbOnlyReport = await createXhsProvider(clock, dbOnly).capabilities(null);
    assert.equal(dbOnlyReport.capabilities.search_public_content.status, 'UNAVAILABLE');
    assert.match(dbOnlyReport.capabilities.search_public_content.reason, /XHS_MCP_RESEARCH_URL/);
    assert.throws(() => xhsProviderConfigFromEnv({ XHS_PROVIDER: 'magic' }), /unknown provider/);
    assert.throws(() => xhsProviderConfigFromEnv({ XHS_PROVIDER: 'simulation', XHS_SIM_PUBLISH: 'maybe' }), /boolean/);
    assert.deepEqual(xhsProviderConfigFromEnv({}), { kind: 'none' });
  });
});

describe('SimulationXhsProvider hardening', () => {
  const tinyNote = (id: string, published_at: string, comments: SimulationCorpus['notes'][number]['comments']) => ({
    platform_post_id: id,
    xsec_token: `tok-${id}`,
    title: `标题${id}`,
    content: '正文',
    tags: [],
    keywords: [],
    author: { platform_user_id: `author-${id}`, nickname: '作者' },
    ip_location: null,
    like_count: 0,
    comment_count: comments.length,
    collect_count: 0,
    published_at,
    comments,
  });
  const tinyComment = (id: string, user: string, published_at: string, ip: string | null, subs: SimulationCorpus['notes'][number]['comments'] = []) => ({
    platform_comment_id: id,
    author: { platform_user_id: user, nickname: `昵称${id}` },
    content: `评论${id}`,
    ip_location: ip,
    like_count: 0,
    published_at,
    sub_comments: subs,
  });

  it('splits mixed CJK/Latin queries into token groups (spec query examples without spaces)', async () => {
    assert.deepEqual(simulationQueryGroups('杭州i3落地'), ['杭州', 'i3', '落地']);
    assert.deepEqual(simulationQueryGroups('3系还是C级'), ['3', '系', 'c', '级']);
    assert.deepEqual(simulationQueryGroups('X3和GLC'), ['x3', 'glc']);
    assert.deepEqual(simulationQueryGroups('i3 vs Model 3'), ['i3', 'model', '3']);
    assert.deepEqual(simulationQueryGroups('ｉ３值得买吗😍'), ['i3', '值得买吗'], 'full-width folded, emoji dropped');

    const { sim } = provider();
    const cases: Record<string, { include: string[]; exclude?: string[] }> = {
      宝马i3落地: { include: ['note-i3-worth-001'] },
      杭州i3落地: { include: ['note-hz-buying-guide-001'], exclude: ['note-sh-x3-pickup-001'] },
      杭州i3有现车吗: { include: ['note-own-hz-i3-001', 'note-hz-buying-guide-001'] },
      杭州X3: { include: ['note-own-hz-x3-001', 'note-buyer-suv-001'], exclude: ['note-sh-x3-pickup-001', 'note-x3-vs-glc-001'] },
      宝马i3价格: { include: ['note-i3-worth-001'] },
    };
    for (const [query, { include, exclude = [] }] of Object.entries(cases)) {
      const ids = await searchIds(sim, query);
      for (const id of include) assert.ok(ids.includes(id), `"${query}" should find ${id}; got ${ids.join(', ')}`);
      for (const id of [...exclude, 'note-hz-cafe-001']) assert.ok(!ids.includes(id), `"${query}" must not find ${id}`);
    }
    assert.deepEqual(await searchIds(sim, 'ｉ３值得买吗'), await searchIds(sim, 'i3值得买吗'), 'full-width query equals half-width query');
    const exact = await searchIds(sim, '杭州i3有现车吗');
    assert.equal(exact[0], 'note-own-hz-i3-001', 'keyword/contiguous match ranks first');
  });

  it('sanitizes a non-finite limit instead of returning nothing', async () => {
    const { sim } = provider();
    const res = unwrap(await sim.searchNotes('宝马', { limit: Number.NaN }));
    assert.ok(res.length > 0 && res.length <= 20, `got ${res.length}`);
    const comments = unwrap(await sim.getComments({ platform_post_id: 'note-i3-worth-001' }, { limit: Number.NaN }));
    assert.ok(comments.length >= 13);
  });

  it('never delivers the same scripted inbound message to two accounts (provider_message_id stays unique)', async () => {
    const { sim, clock } = provider({ send_messages: true, receive_messages: true });
    unwrap(await sim.sendMessage('acc_wang', 'u-hz-buyer-002', '您好，白色35L还在店里'));
    clock.advance({ minutes: 5 });
    sim.recordManualContact('acc_li', 'u-hz-buyer-002');
    clock.advance({ hours: 3 });
    const wang = unwrap(await sim.listInboundMessages('acc_wang', null));
    const li = unwrap(await sim.listInboundMessages('acc_li', null));
    assert.deepEqual(wang.map((m) => m.provider_message_id), ['sim-in-u-hz-buyer-002-0', 'sim-in-u-hz-buyer-002-1']);
    assert.deepEqual(li, [], 'second contacting account gets no copy of the replies');
    const all = [...wang, ...li].map((m) => m.provider_message_id);
    assert.equal(new Set(all).size, all.length);
  });

  it('derived profile uses the latest known IP even when the newest comment has none (order independent)', async () => {
    const clock = new ManualClock(TEST_NOW);
    const corpus = {
      notes: [
        tinyNote('n-a', '2026-09-01T00:00:00Z', [tinyComment('ca', 'u-x', '2026-09-10T10:00:00Z', null)]),
        tinyNote('n-b', '2026-09-01T00:00:00Z', [tinyComment('cb', 'u-x', '2026-09-09T09:00:00Z', '浙江')]),
        tinyNote('n-c', '2026-09-01T00:00:00Z', [tinyComment('cc', 'u-x', '2026-09-08T09:00:00Z', '上海')]),
      ],
    };
    const sim = new SimulationXhsProvider(clock, corpus as unknown as SimulationCorpus);
    const p = unwrap(await sim.getUserProfile({ platform_user_id: 'u-x' }));
    assert.equal(p.ip_location, '浙江', 'most recent comment that carries an IP');
    assert.equal(p.nickname, '昵称ca', 'nickname from the most recent comment');
    assert.equal(p.bio, null);
    assert.deepEqual(p.raw, { source: 'simulation', derived: true });
  });

  it('parsed corpora never share default arrays', () => {
    const a = parseSimulationCorpus({ notes: [] });
    const b = parseSimulationCorpus({ notes: [] });
    a.profiles.push({ platform_user_id: 'x', nickname: 'x', bio: null, ip_location: null, follower_count: null, note_count: null, recent_note_ids: [] });
    a.inbox_scripts.push({ from_user_id: 'x', to_account_platform_id: null, delay_minutes: 1, content: 'hi' });
    assert.equal(b.profiles.length, 0);
    assert.equal(b.inbox_scripts.length, 0);
    const c = parseSimulationCorpus({ notes: [tinyNote('n1', '2026-09-01T00:00:00Z', [])], profiles: [{ platform_user_id: 'p1', nickname: 'p' }, { platform_user_id: 'p2', nickname: 'q' }] });
    c.profiles[0].recent_note_ids.push('n1');
    assert.deepEqual(c.profiles[1].recent_note_ids, []);
  });

  it('rejects parent references that leave the thread or sit on top-level comments', () => {
    const base = (subParent: string | undefined, topParent?: string) => ({
      notes: [
        tinyNote('n1', '2026-09-01T00:00:00Z', [
          { ...tinyComment('t1', 'u1', '2026-09-02T00:00:00Z', null, [{ ...tinyComment('t1r', 'u2', '2026-09-02T01:00:00Z', null), parent_comment_id: subParent }]), parent_comment_id: topParent },
          tinyComment('t2', 'u3', '2026-09-02T02:00:00Z', null),
        ]),
      ],
    });
    assert.doesNotThrow(() => parseSimulationCorpus(base('t1')));
    assert.throws(() => parseSimulationCorpus(base('t2')), (e: unknown) => e instanceof ValidationError && /same thread/.test(e.message) && /comments\[0\]\.sub_comments\[0\]\.parent_comment_id/.test(e.message));
    assert.throws(() => parseSimulationCorpus(base('t1r')), /same thread/, 'self reference');
    assert.throws(() => parseSimulationCorpus(base(undefined, 't2')), /top-level comment cannot reference a parent/);
  });

  it('refuses to reply to a comment that is not yet published at clock time', async () => {
    const { sim } = provider({ reply_comments: true }, '2026-09-10T00:00:00Z');
    const future = await sim.replyToComment('acc_i3', { platform_post_id: 'note-own-hz-i3-001', platform_comment_id: 'c-own-i3-001' }, '在的');
    assert.ok(!future.ok && /comment not found/.test(future.reason));
    const visible = unwrap(await sim.replyToComment('acc_i3', { platform_post_id: 'note-own-hz-i3-001', platform_comment_id: 'c-own-i3-002' }, '谢谢喜欢'));
    assert.equal(visible.provider_message_id, 'sim-reply-1');
    assert.equal(sim.sentReplies().length, 1, 'refused reply recorded nothing');
  });
});
