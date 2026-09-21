/**
 * The voice has to reach the writing, or it is just a report. Here: the profile shows up in what the content model is
 * asked, a post that reprints one of the account's own notes is refused, the private message follows the account's
 * own 你/您, and the customer reply does too.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { newId } from '../../../src/core/ids.ts';
import type { AccountVoiceProfile } from '../../../src/core/types.ts';
import type { LlmJsonRequest, LlmProvider, LlmResult, LlmStatus, LlmTextRequest } from '../../../src/providers/llm/types.ts';
import { detectIntentRules } from '../../../src/skills/acquisition/intent-detection/nlu.ts';
import { upsertLeadFromSignal } from '../../../src/skills/acquisition/lead-deduplication/index.ts';
import { generatePost } from '../../../src/skills/content/post-generation/index.ts';
import { applyVoicePronoun, voicePromptBlock, voicePronoun } from '../../../src/skills/content/account-voice/index.ts';
import { transitionLead } from '../../../src/skills/operations/crm/index.ts';
import { getDealerProfile } from '../../../src/skills/operations/dealer-brain/index.ts';
import { processInboundMessage } from '../../../src/skills/sales/conversation/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { accountIdByPlatformId, dealerIdByKey, loadDealerFixture, seedAssignment, seedOutreach } from '../../helpers/fixtures.ts';

/** a profile as `learnAccountVoice` would have stored it, written straight into the table */
function seedVoice(ctx: TestContext, dealerId: string, accountId: string, over: Partial<AccountVoiceProfile> = {}): AccountVoiceProfile {
  const now = ctx.clock.iso();
  return ctx.db.table('account_voice_profiles').insert({
    id: newId('voice'),
    account_id: accountId,
    dealer_id: dealerId,
    sample_count: 4,
    sample_note_ids: ['s1'],
    metrics: { sample_count: 4, you_casual_share: 1, you_formal_share: 0, title_emoji_share: 1, cta_share: 1 } as never,
    rules: [
      { rule: '标题写 10–16 个字', basis: '历史标题中位数 13 字' },
      { rule: '称呼客户用「你」', basis: '100% 的笔记用「你」' },
      { rule: '结尾要有引导，像「评论区扣1」这样', basis: '100% 的笔记结尾有引导' },
    ],
    vocabulary: { openers: [], closers: [], cta_phrases: ['评论区扣1'], tags: ['舟山'], phrases: ['到店看车'], emojis: ['🔥'] },
    examples: [{ platform_note_id: 's1', title: '🔥G6提车实拍', excerpt: '今天又交付一台G6～\n想看实车的评论区扣1。', why: '最接近平常水平' }],
    avoid: ['不要用「您」，这个账号一直用「你」'],
    engine: 'rules',
    analyzed_at: now,
    newest_sample_at: now,
    created_at: now,
    updated_at: now,
    ...over,
  });
}

/** the account's own note, stored where the copy check looks for it */
function seedHistory(ctx: TestContext, accountId: string, noteId: string, title: string, content: string): void {
  const account = ctx.db.table('xhs_accounts').require(accountId);
  ctx.db.table('public_posts').insert({
    id: newId('ppost'),
    platform: 'xiaohongshu',
    platform_post_id: noteId,
    xsec_token: 'tok',
    url: null,
    title,
    content,
    author_platform_user_id: account.platform_user_id ?? account.platform_account_id,
    author_nickname: account.nickname,
    author_profile_url: null,
    ip_location: null,
    tags: [],
    like_count: 0,
    comment_count: 0,
    collect_count: 0,
    published_at: ctx.clock.iso(),
    data_mode: 'live',
    own_post_id: null,
    first_search_run_id: null,
    fetched_at: ctx.clock.iso(),
    raw: {},
  });
}

class ScriptedLlm implements LlmProvider {
  readonly name = 'fake';
  jsonCalls: LlmJsonRequest[] = [];
  textCalls: LlmTextRequest[] = [];
  private readonly json: unknown;
  private readonly text: string | null;
  constructor(json: unknown, text: string | null = null) {
    this.json = json;
    this.text = text;
  }
  status(): LlmStatus {
    return { provider: 'fake', status: 'AVAILABLE', model: 'fake-1', reason: 'test' };
  }
  async completeJson<T>(req: LlmJsonRequest): Promise<LlmResult<T>> {
    this.jsonCalls.push(req);
    return { ok: true, data: this.json as T, model: 'fake-1' };
  }
  async completeText(req: LlmTextRequest): Promise<LlmResult<string>> {
    this.textCalls.push(req);
    return this.text === null ? { ok: false, reason: 'unused' } : { ok: true, data: this.text, model: 'fake-1' };
  }
}

function setup(): { ctx: TestContext; hz: string; wang: string } {
  const ctx = createTestContext();
  const summary = loadDealerFixture(ctx);
  return { ctx, hz: dealerIdByKey(summary, 'hz-bmw'), wang: accountIdByPlatformId(summary, 'xhs-hz-sales-wang') };
}

function plannedPost(ctx: TestContext, dealerId: string, accountId: string): string {
  const now = ctx.clock.iso();
  return ctx.db.table('posts').insert({
    id: newId('post'),
    dealer_id: dealerId,
    account_id: accountId,
    plan_id: null,
    slot_date: '2026-09-12',
    pillar: 'model_review',
    topic: 'i3:model_review',
    angle: '',
    model: 'i3',
    title: '',
    body: '',
    tags: [],
    cover_text: '',
    images: [],
    video: null,
    fact_refs: [],
    status: 'PLANNED',
    review: null,
    approval_policy: 'REVIEW_REQUIRED',
    platform_note_id: null,
    scheduled_for: null,
    published_at: null,
    metrics: { views: 0, likes: 0, collects: 0, comments: 0, shares: 0 },
    metrics_updated_at: null,
    engine: 'rules',
    created_at: now,
    updated_at: now,
  }).id;
}

describe('写笔记时用这个账号自己的写法', () => {
  it('puts the account\'s learned rules and one of its own notes into the prompt', async () => {
    const s = setup();
    seedVoice(s.ctx, s.hz, s.wang);
    const llm = new ScriptedLlm({ title: '宝马i3值不值得买', body: '内容'.repeat(200), tags: ['宝马i3', '杭州', '电车'], cover_text: '封面' });
    s.ctx.llm = llm;
    await generatePost(s.ctx, plannedPost(s.ctx, s.hz, s.wang));
    const prompt = llm.jsonCalls[0].prompt;
    assert.match(prompt, /这个账号自己的写法/);
    assert.match(prompt, /称呼客户用「你」/);
    assert.match(prompt, /不要这样写：.*不要用「您」/);
    assert.match(prompt, /只学写法和语气，内容必须是新的，不能照抄/);
    assert.match(prompt, /🔥G6提车实拍/, '带上它自己的一篇做范例');
  });

  it('refuses a draft that reprints one of the account\'s own notes', async () => {
    const s = setup();
    seedVoice(s.ctx, s.hz, s.wang);
    const own = '今天又交付一台G6～\n星暮紫太出片了！\n\n想看实车的评论区扣1，我拉你进群。';
    seedHistory(s.ctx, s.wang, 's1', '🔥G6提车实拍｜这个配色绝了', own);
    s.ctx.llm = new ScriptedLlm({ title: '🔥G6提车实拍｜这个配色绝了', body: own, tags: ['宝马i3', '杭州', '电车'], cover_text: '封面' });
    const postId = plannedPost(s.ctx, s.hz, s.wang);
    const post = await generatePost(s.ctx, postId);
    assert.notEqual(post.body, own, '抄来的稿子不会被采用');
    assert.equal(post.engine, 'rules', '退回规则引擎写的稿子');
    const decision = s.ctx.db.table('agent_decisions').findOne({ subject_id: postId, decision_type: 'content_generation' });
    assert.equal((decision?.output.llm as Record<string, unknown> | undefined)?.fallback_reason, 'copied_own_note');
  });
});

describe('私信和回复跟着账号的称呼走', () => {
  it('the reply to a customer uses the pronoun this account actually uses', async () => {
    const s = setup();
    const content = '宝马i3 35L现在什么价';
    const detection = detectIntentRules(content, { source_type: 'comment' }, getDealerProfile(s.ctx, s.hz));
    const created = upsertLeadFromSignal(s.ctx, {
      dealer_id: s.hz,
      identity: { platform_user_id: 'u-voice-1', username: 'u-voice-1' },
      signal: { source_type: 'comment', content, signal_at: s.ctx.clock.iso(), detection },
    });
    const lead = transitionLead(s.ctx, created.lead.id, 'CONTACTED', { reason: 'test', actor: 'operator:test' }).lead;
    const assignment = seedAssignment(s.ctx, { lead_id: lead.id, account_id: s.wang });
    seedOutreach(s.ctx, { lead_id: lead.id, account_id: s.wang, assignment_id: assignment.id, status: 'SENT_MANUALLY' });

    const formal = await processInboundMessage(s.ctx, { account_id: s.wang, platform_user_id: 'u-voice-1', content: '35L现在什么价？', source: 'manual' });
    assert.ok(formal.reply_draft);
    assert.match(formal.reply_draft.content, /您/, '没有学过风格时保持原来的写法');

    // now the account's own notes say it always writes 你
    seedVoice(s.ctx, s.hz, s.wang);
    const casual = await processInboundMessage(s.ctx, { account_id: s.wang, platform_user_id: 'u-voice-1', content: '那有现车吗？', source: 'manual' });
    assert.ok(casual.reply_draft);
    assert.doesNotMatch(casual.reply_draft.content, /您/, '学过之后跟着账号自己的称呼');
    assert.match(casual.reply_draft.content, /你/);
  });

  it('applyVoicePronoun only rewrites when the account\'s own notes settle it', () => {
    const s = setup();
    const casual = seedVoice(s.ctx, s.hz, s.wang);
    assert.equal(voicePronoun(casual), '你');
    assert.equal(applyVoicePronoun('您好，您想看哪款？', casual), '你好，你想看哪款？');

    const undecided = { ...casual, metrics: { ...casual.metrics, you_casual_share: 0.2, you_formal_share: 0.2 } };
    assert.equal(voicePronoun(undecided), null);
    assert.equal(applyVoicePronoun('您好', undecided), '您好', '拿不准就不改');
    assert.equal(voicePromptBlock(null), '', '没有画像就不往提示词里塞东西');
  });
});
