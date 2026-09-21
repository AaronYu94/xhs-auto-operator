/**
 * Learning a voice end to end: reading an account's own history through the provider, keeping one profile per
 * account, two accounts never sharing a voice, re-learning when new notes appear, and the evidence rule on anything
 * an LLM adds.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LlmJsonRequest, LlmProvider, LlmResult, LlmStatus } from '../../../src/providers/llm/types.ts';
import type { ProviderMode, ProviderResult, XhsAuthApi, XhsLoginStatus, XhsNoteDetail, XhsNoteRef, XhsProvider } from '../../../src/providers/xhs/types.ts';
import { UnavailableXhsProvider } from '../../../src/providers/xhs/unavailable.ts';
import {
  getAccountVoice,
  learnAccountVoice,
  needsVoiceRefresh,
  refreshDealerVoices,
  validateVoiceDraft,
  voiceCopyCheck,
  voicePromptBlock,
} from '../../../src/skills/content/account-voice/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { accountIdByPlatformId, dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';

interface FakeNote {
  id: string;
  title: string;
  content: string;
  tags?: string[];
  published_at?: string;
}

/**
 * A provider that has a logged-in session and a set of own notes per account. Everything else delegates to the
 * unavailable provider, so this stub only has to describe what the voice skill actually reads.
 */
class VoiceProvider implements XhsProvider {
  readonly name = 'voice-stub';
  readonly mode: ProviderMode = 'live';
  notes: Record<string, FakeNote[]> = {};
  loggedIn = true;
  readonly reads: string[] = [];
  private readonly inner: UnavailableXhsProvider;
  readonly auth: XhsAuthApi;

  constructor(clock: TestContext['clock']) {
    this.inner = new UnavailableXhsProvider(clock);
    this.auth = {
      status: async (accountId): Promise<ProviderResult<XhsLoginStatus>> => {
        if (!this.loggedIn) return { ok: false, status: 'REQUIRES_AUTH', reason: 'Xiaohongshu session not logged in' };
        const notes = this.notes[accountId ?? ''] ?? [];
        return {
          ok: true,
          data: {
            logged_in: true,
            username: 'acc',
            platform_user_id: 'u-acc',
            red_id: null,
            detail: 'logged in',
            endpoint_label: 'test',
            profile: {
              nickname: 'acc',
              red_id: null,
              avatar_url: null,
              bio: null,
              ip_location: null,
              follows: null,
              fans: null,
              liked_and_collected: null,
              notes: notes.map((n) => ({
                platform_note_id: n.id,
                title: n.title,
                xsec_token: `tok-${n.id}`,
                url: `https://www.xiaohongshu.com/explore/${n.id}`,
                cover_url: null,
                liked_count: null,
                collected_count: null,
                comment_count: null,
              })),
            },
          },
        };
      },
      loginQrcode: async () => ({ ok: false, status: 'UNAVAILABLE', reason: 'not used' }),
    };
  }

  capabilities(accountId?: string | null) {
    return this.inner.capabilities(accountId ?? null);
  }
  async getNote(ref: XhsNoteRef, accountId?: string | null): Promise<ProviderResult<XhsNoteDetail>> {
    this.reads.push(ref.platform_post_id);
    const note = (this.notes[accountId ?? ''] ?? []).find((n) => n.id === ref.platform_post_id);
    if (!note) return { ok: false, status: 'UNAVAILABLE', reason: 'not found' };
    return {
      ok: true,
      data: {
        platform_post_id: note.id,
        xsec_token: ref.xsec_token ?? null,
        url: `https://www.xiaohongshu.com/explore/${note.id}`,
        title: note.title,
        content: note.content,
        author: { platform_user_id: 'u-acc', nickname: 'acc', profile_url: null, avatar_url: null },
        ip_location: null,
        tags: note.tags ?? [],
        like_count: 0,
        comment_count: 0,
        collect_count: 0,
        published_at: note.published_at ?? '2026-09-01T00:00:00.000Z',
        raw: {},
      },
    };
  }
  searchNotes(...args: Parameters<XhsProvider['searchNotes']>) {
    return this.inner.searchNotes(...args);
  }
  getComments(...args: Parameters<XhsProvider['getComments']>) {
    return this.inner.getComments(...args);
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

class FakeLlm implements LlmProvider {
  readonly name = 'fake';
  calls: LlmJsonRequest[] = [];
  private readonly payload: unknown;
  constructor(payload: unknown) {
    this.payload = payload;
  }
  status(): LlmStatus {
    return { provider: 'fake', status: 'AVAILABLE', model: 'fake-1', reason: 'test' };
  }
  async completeJson<T>(req: LlmJsonRequest): Promise<LlmResult<T>> {
    this.calls.push(req);
    return { ok: true, data: this.payload as T, model: 'fake-1' };
  }
  async completeText(): Promise<LlmResult<string>> {
    return { ok: false, reason: 'unused' };
  }
}

const SALES_NOTES: FakeNote[] = [
  { id: 's1', title: '🔥G6提车实拍｜这个配色绝了', content: '今天又交付一台G6～\n星暮紫太出片了！\n\n想看实车的评论区扣1，我拉你进群。', tags: ['小鹏G6', '舟山'] },
  { id: 's2', title: '✨这周到店的新车都在这了', content: '本周到店三台～\n都在店里随时能看。\n\n想试驾的私信我，帮你安排。', tags: ['试驾', '舟山'] },
  { id: 's3', title: '🚗你以为的智驾VS实际的智驾', content: '好多朋友问我智驾好不好用～\n我每天上下班都在开。\n\n想体验的评论区找我。', tags: ['智驾', '舟山'] },
  { id: 's4', title: '🎉又一位车主提车啦', content: '恭喜王哥提车～\n选的是长续航版本。\n\n有想看的朋友私信我。', tags: ['提车', '舟山'] },
];

const EXPERT_NOTES: FakeNote[] = [
  { id: 'e1', title: '关于增程与纯电的选择建议', content: '很多用户在增程和纯电之间犹豫。如果您每天的通勤距离不长，家里也具备充电条件，纯电在使用成本上更有优势。如果您经常跑长途，增程在补能上会更从容一些。', tags: ['购车指南'] },
  { id: 'e2', title: '交付前需要确认的几项内容', content: '在交付之前，建议您重点确认车辆的生产日期、随车资料是否齐全，以及交付时的电池健康状态。这些信息门店都可以提供，您也可以现场核对。', tags: ['交付'] },
  { id: 'e3', title: '智能辅助驾驶的使用边界', content: '辅助驾驶并不是自动驾驶，使用时您仍然需要保持对路面的关注。我们建议您在熟悉的路段先体验，逐步了解系统的能力边界之后再扩大使用范围。', tags: ['用车知识'] },
  { id: 'e4', title: '保养周期与常见问题', content: '关于保养，建议您按照厂家给出的周期到店检查。如果您平时用车强度较大，可以适当提前，具体以门店检测结果为准。', tags: ['用车知识'] },
];

function setup(): { ctx: TestContext; hz: string; sales: string; expert: string; xhs: VoiceProvider } {
  const ctx = createTestContext();
  const summary = loadDealerFixture(ctx);
  const xhs = new VoiceProvider(ctx.clock);
  ctx.xhs = xhs;
  const sales = accountIdByPlatformId(summary, 'xhs-hz-sales-wang');
  const expert = accountIdByPlatformId(summary, 'xhs-hz-official');
  xhs.notes[sales] = SALES_NOTES;
  xhs.notes[expert] = EXPERT_NOTES;
  return { ctx, hz: dealerIdByKey(summary, 'hz-bmw'), sales, expert, xhs };
}

describe('读取历史内容并学习', () => {
  it('reads the account\'s own notes and stores one profile for it', async () => {
    const s = setup();
    const result = await learnAccountVoice(s.ctx, s.sales, 'operator:li');
    assert.equal(result.status, 'AVAILABLE');
    assert.equal(result.used, 4);
    assert.equal(result.engine, 'rules', '没有大模型时也能学出完整画像');
    const profile = getAccountVoice(s.ctx, s.sales)!;
    assert.equal(profile.account_id, s.sales);
    assert.equal(profile.sample_count, 4);
    assert.deepEqual(profile.sample_note_ids.sort(), ['s1', 's2', 's3', 's4']);
    assert.ok(profile.rules.length >= 5);
    assert.ok(profile.examples.length >= 1);
    // the notes themselves are kept, so the profile can be rebuilt and the copy check has something to compare with
    assert.equal(s.ctx.db.table('public_posts').findMany({ platform_post_id: ['s1', 's2', 's3', 's4'] }).length, 4);
    assert.ok(s.ctx.audit.eventsFor('xhs_account', s.sales).some((e) => e.action === 'account.voice_learned'));
  });

  it('a logged-out account gets no profile and an honest reason', async () => {
    const s = setup();
    s.xhs.loggedIn = false;
    const result = await learnAccountVoice(s.ctx, s.sales, 'operator:li');
    assert.equal(result.status, 'REQUIRES_AUTH');
    assert.equal(getAccountVoice(s.ctx, s.sales), null);
  });

  it('too little history → nothing is stored, and it says how much is missing', async () => {
    const s = setup();
    s.xhs.notes[s.sales] = SALES_NOTES.slice(0, 2);
    const result = await learnAccountVoice(s.ctx, s.sales, 'operator:li');
    assert.equal(result.status, 'UNAVAILABLE');
    assert.match(result.reason, /至少要 3 篇/);
    assert.equal(getAccountVoice(s.ctx, s.sales), null);
  });

  it('never learns from what this system published itself', async () => {
    const s = setup();
    // a note this system published earlier, now sitting in the account's history
    s.ctx.db.table('posts').insert({
      id: 'post_voice_own',
      dealer_id: s.hz,
      account_id: s.sales,
      plan_id: null,
      slot_date: '2026-09-01',
      pillar: 'model_review',
      topic: 'g6:model_review',
      angle: '',
      model: 'G6',
      title: '🔥G6提车实拍｜这个配色绝了',
      body: '系统写的稿子',
      tags: [],
      cover_text: '',
      images: [],
      video: null,
      fact_refs: [],
      status: 'PUBLISHED',
      review: null,
      approval_policy: 'REVIEW_REQUIRED',
      platform_note_id: 's1',
      scheduled_for: null,
      published_at: s.ctx.clock.iso(),
      metrics: { views: 0, likes: 0, collects: 0, comments: 0, shares: 0 },
      metrics_updated_at: null,
      engine: 'llm+rules',
      created_at: s.ctx.clock.iso(),
      updated_at: s.ctx.clock.iso(),
    });
    const result = await learnAccountVoice(s.ctx, s.sales, 'operator:li');
    assert.equal(result.skipped_own, 1);
    assert.ok(!getAccountVoice(s.ctx, s.sales)!.sample_note_ids.includes('s1'));
  });
});

describe('每个账号一套自己的风格', () => {
  it('two accounts of the same store end up with different rules', async () => {
    const s = setup();
    await learnAccountVoice(s.ctx, s.sales, 'operator:li');
    await learnAccountVoice(s.ctx, s.expert, 'operator:li');
    const sales = getAccountVoice(s.ctx, s.sales)!;
    const expert = getAccountVoice(s.ctx, s.expert)!;
    assert.notEqual(sales.id, expert.id);
    const salesRules = sales.rules.map((r) => r.rule).join(' | ');
    const expertRules = expert.rules.map((r) => r.rule).join(' | ');
    assert.match(salesRules, /称呼客户用「你」/);
    assert.match(expertRules, /称呼客户用「您」/);
    assert.match(salesRules, /标题里带 emoji/);
    assert.ok(!/标题里带 emoji/.test(expertRules));
    assert.ok(expert.avoid.some((a) => /emoji/.test(a)));
    assert.notDeepEqual(sales.examples.map((e) => e.platform_note_id), expert.examples.map((e) => e.platform_note_id));
    assert.notEqual(voicePromptBlock(sales), voicePromptBlock(expert));
  });

  it('a dealer refresh gives every account its own profile and skips the fresh ones', async () => {
    const s = setup();
    const first = await refreshDealerVoices(s.ctx, s.hz, 'agent:test');
    const learned = first.filter((r) => r.status === 'AVAILABLE');
    assert.ok(learned.length >= 2);
    assert.equal(new Set(learned.map((r) => getAccountVoice(s.ctx, r.account_id)!.id)).size, learned.length, '每个账号一行');
    assert.equal(needsVoiceRefresh(s.ctx, s.sales), false);
    assert.equal((await refreshDealerVoices(s.ctx, s.hz, 'agent:test')).length, first.length - learned.length, '刚学过的不再重复读取');
  });
});

describe('持续学习', () => {
  it('re-learning picks up new notes and moves the profile with them', async () => {
    const s = setup();
    await learnAccountVoice(s.ctx, s.sales, 'operator:li');
    const before = getAccountVoice(s.ctx, s.sales)!;
    assert.equal(before.sample_count, 4);

    s.xhs.notes[s.sales] = [
      ...SALES_NOTES,
      { id: 's5', title: '🚙周末到店活动', content: '周末两天都在店里～\n有礼品可以领。\n\n想来的评论区扣1。', tags: ['活动'], published_at: '2026-09-10T00:00:00.000Z' },
    ];
    s.ctx.clock.advance({ days: 8 });
    assert.equal(needsVoiceRefresh(s.ctx, s.sales), true, '一周后需要重新学');
    await learnAccountVoice(s.ctx, s.sales, 'operator:li');
    const after = getAccountVoice(s.ctx, s.sales)!;
    assert.equal(after.sample_count, 5);
    assert.ok(after.sample_note_ids.includes('s5'));
    assert.equal(after.newest_sample_at, '2026-09-10T00:00:00.000Z');
    assert.equal(s.ctx.db.table('account_voice_profiles').findMany({ account_id: s.sales }).length, 1, '还是同一行，不会堆出第二套风格');
  });
});

describe('大模型补充的规则要有出处', () => {
  it('keeps rules quoting the account\'s own words and drops the rest', async () => {
    const s = setup();
    s.ctx.llm = new FakeLlm({
      rules: [
        { rule: '交付类笔记先恭喜车主，再说车', evidence: '恭喜王哥提车' },
        { rule: '价格一律写 18.68 万起', evidence: '想看实车的评论区扣1' },
        { rule: '经常用专业术语解释参数', evidence: '这句话历史笔记里根本没有' },
      ],
      avoid: ['不要用官方腔', '不要写 9 万优惠'],
    });
    const result = await learnAccountVoice(s.ctx, s.sales, 'operator:li');
    assert.match(result.engine, /^llm:/);
    const rules = result.profile!.rules.map((r) => r.rule);
    assert.ok(rules.includes('交付类笔记先恭喜车主，再说车'), '有出处的规则保留');
    assert.ok(!rules.some((r) => /18\.68/.test(r)), '带价格的规则丢掉（数字只能来自车型库）');
    assert.ok(!rules.some((r) => /专业术语/.test(r)), '找不到出处的规则丢掉');
    assert.ok(result.profile!.avoid.includes('不要用官方腔'));
    assert.ok(!result.profile!.avoid.some((a) => /9 万/.test(a)));
  });

  it('validateVoiceDraft is the guard, and it counts what it dropped', () => {
    const samples = SALES_NOTES.map((n) => ({ platform_note_id: n.id, title: n.title, content: n.content, tags: n.tags ?? [], published_at: null }));
    const checked = validateVoiceDraft({ rules: [{ rule: 'ok', evidence: '评论区扣1' }, { rule: 'bad', evidence: '不存在的话' }], avoid: ['x'] }, samples);
    assert.equal(checked.rules.length, 1);
    assert.equal(checked.rejected, 1);
    assert.match(checked.rules[0].basis, /历史原文/);
  });
});

describe('不复制历史内容', () => {
  it('flags a reprint of the account\'s own note, and only for that account', async () => {
    const s = setup();
    await learnAccountVoice(s.ctx, s.sales, 'operator:li');
    await learnAccountVoice(s.ctx, s.expert, 'operator:li');
    const reprint = voiceCopyCheck(s.ctx, s.sales, SALES_NOTES[0].content);
    assert.equal(reprint.copied, true);
    assert.equal(reprint.platform_note_id, 's1');
    // the same text is not "copied" for another account: it never published it
    assert.equal(voiceCopyCheck(s.ctx, s.expert, SALES_NOTES[0].content).copied, false);
    assert.equal(voiceCopyCheck(s.ctx, s.sales, '本周到店两台新车，想看的朋友随时联系我们。').copied, false);
  });
});
