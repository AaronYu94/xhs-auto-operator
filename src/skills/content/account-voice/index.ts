/**
 * 账号语言学习 / Account Voice — each account keeps writing the way it already writes.
 *
 * A persona says what the store wants an account to sound like. A voice profile says what it measurably sounds like:
 * it is learned from that account's own published notes, one profile per account, never shared and never merged.
 * `analyze.ts` does the measuring; this module reads the history, keeps the profile, hands it to the writers, and
 * refuses to let a learned voice turn into a reprint of an old post.
 *
 * Deliberate choices:
 * - **Only the account's own human-written history.** Notes this system published are excluded, so the voice never
 *   learns from itself and drifts away from the person who actually built the account.
 * - **Robust to one odd post.** Medians and shares, a support threshold per rule, and few-shot examples picked by
 *   typicality rather than by likes (see `analyze.ts`).
 * - **Style, not text.** Every generated piece is checked against the account's own history before it can be used
 *   (`voiceCopyCheck`): a high similarity, or one long verbatim passage, means it is a copy and is refused.
 * - Without an LLM the profile is still complete: the measured rules, the vocabulary and the examples are all
 *   deterministic. The LLM only adds rules it can quote evidence for.
 */
import type { AppContext } from '../../../app/context.ts';
import { NotFoundError, PolicyError, ValidationError } from '../../../core/errors.ts';
import { newId } from '../../../core/ids.ts';
import { normalizeText, truncate } from '../../../core/text.ts';
import type { AccountVoiceProfile, VoiceExample, VoiceRule, XhsAccount } from '../../../core/types.ts';
import { v } from '../../../core/validate.ts';
import type { LlmJsonRequest } from '../../../providers/llm/types.ts';
import { requireAccount } from '../../operations/account-brain/index.ts';
import { getDealer } from '../../operations/dealer-brain/index.ts';
import { defineSkill } from '../../registry.ts';
import { MIN_SAMPLES, checkCopy, deriveRules, measure, pickExamples, usableSamples, vocabulary, type CopyCheck, type VoiceSample } from './analyze.ts';

export const VOICE_AGENT = 'account-strategy-agent';
/** How many of the account's own notes a profile is built from. */
export const DEFAULT_SAMPLE_LIMIT = 20;
/** A profile older than this is refreshed by the daily workflow. */
export const VOICE_REFRESH_DAYS = 7;

export interface VoiceLearnResult {
  account_id: string;
  account_name: string;
  status: 'AVAILABLE' | 'UNAVAILABLE' | 'REQUIRES_AUTH';
  reason: string;
  profile: AccountVoiceProfile | null;
  /** notes read from Xiaohongshu this time */
  fetched: number;
  /** notes long enough to carry style */
  used: number;
  /** notes skipped because this system published them (the voice never learns from itself) */
  skipped_own: number;
  engine: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the account's own history
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The account's own notes, with their bodies. The profile read gives the list (id, title, token); each body needs its
 * own detail read, which is why this is capped and why a note without a token is skipped rather than guessed at.
 */
export async function collectAccountNotes(
  ctx: AppContext,
  accountId: string,
  opts: { limit?: number } = {},
): Promise<{ samples: VoiceSample[]; fetched: number; skipped_own: number; status: VoiceLearnResult['status']; reason: string }> {
  const account = requireAccount(ctx, accountId);
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_SAMPLE_LIMIT)), 50);
  const empty = (status: VoiceLearnResult['status'], reason: string) => ({ samples: [], fetched: 0, skipped_own: 0, status, reason });
  if (!ctx.xhs.auth) return empty('UNAVAILABLE', `当前数据源（${ctx.xhs.name}）读不到账号自己的历史笔记`);

  const status = await ctx.xhs.auth.status(account.id);
  if (!status.ok) return empty(status.status === 'REQUIRES_AUTH' ? 'REQUIRES_AUTH' : 'UNAVAILABLE', status.reason);
  if (!status.data.logged_in) return empty('REQUIRES_AUTH', '账号没有登录，登录后才能读到它自己的历史笔记');
  const notes = status.data.profile?.notes ?? [];
  if (notes.length === 0) return empty('UNAVAILABLE', '这个账号主页上还没有笔记');

  // Notes this system published are excluded: a voice learned from its own output drifts away from the real author.
  const ownPublished = new Set(
    ctx.db
      .table('posts')
      .findMany({ account_id: account.id, status: 'PUBLISHED' })
      .map((p) => p.platform_note_id)
      .filter((x): x is string => Boolean(x)),
  );

  const samples: VoiceSample[] = [];
  let fetched = 0;
  let skippedOwn = 0;
  for (const note of notes.slice(0, limit)) {
    if (ownPublished.has(note.platform_note_id)) {
      skippedOwn++;
      continue;
    }
    const token = note.xsec_token ?? null;
    if (!token) continue;
    const detail = await ctx.xhs.getNote({ platform_post_id: note.platform_note_id, xsec_token: token }, account.id);
    if (!detail.ok) continue;
    fetched++;
    const sample: VoiceSample = {
      platform_note_id: note.platform_note_id,
      title: (detail.data.title || note.title || '').trim(),
      content: (detail.data.content ?? '').trim(),
      tags: detail.data.tags ?? [],
      published_at: detail.data.published_at ?? null,
    };
    samples.push(sample);
    storeSample(ctx, account, sample, detail.data.url ?? note.url, token);
  }
  if (samples.length === 0) return { samples, fetched, skipped_own: skippedOwn, status: 'UNAVAILABLE', reason: '没能读到这个账号笔记的正文' };
  return { samples, fetched, skipped_own: skippedOwn, status: 'AVAILABLE', reason: '' };
}

/** Keep the note where every other public note lives, so the profile can be rebuilt without going back to the platform. */
function storeSample(ctx: AppContext, account: XhsAccount, sample: VoiceSample, url: string | null, token: string | null): void {
  ctx.db.tx(() => {
    const table = ctx.db.table('public_posts');
    const existing = table.findOne({ platform: 'xiaohongshu', platform_post_id: sample.platform_note_id });
    const row = {
      xsec_token: token,
      url: url ?? null,
      title: sample.title,
      content: sample.content,
      tags: sample.tags,
      author_platform_user_id: account.platform_user_id ?? account.platform_account_id,
      author_nickname: account.nickname,
      published_at: sample.published_at,
      data_mode: ctx.xhs.mode === 'live' ? ('live' as const) : ('unknown' as const),
      fetched_at: ctx.clock.iso(),
    };
    if (existing) {
      table.update(existing.id, row);
      return;
    }
    table.insert({
      id: newId('ppost'),
      platform: 'xiaohongshu',
      platform_post_id: sample.platform_note_id,
      author_profile_url: null,
      ip_location: null,
      like_count: 0,
      comment_count: 0,
      collect_count: 0,
      own_post_id: null,
      first_search_run_id: null,
      raw: {},
      ...row,
    });
  });
}

/** The stored samples a profile was built from (used by the copy guard and by a re-analysis without a new fetch). */
export function storedSamples(ctx: AppContext, profile: AccountVoiceProfile): VoiceSample[] {
  if (profile.sample_note_ids.length === 0) return [];
  const rows = ctx.db.table('public_posts').findMany({ platform_post_id: profile.sample_note_ids });
  return rows.map((r) => ({ platform_note_id: r.platform_post_id, title: r.title, content: r.content, tags: r.tags, published_at: r.published_at }));
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM enrichment (optional, evidence-checked)
// ─────────────────────────────────────────────────────────────────────────────

const LLM_SYSTEM = [
  '你在帮一个小红书账号总结「它自己怎么写东西」，给之后的写手当规则用。',
  '只看给你的历史笔记，总结出可执行的写作规则：用词、句式、讲车的方式、销售话术的说法、开头结尾的习惯、明确不会出现的表达。',
  '每条规则必须能在历史笔记里找到依据，evidence 要逐字复制笔记里的一小段原文（不超过 20 字）。',
  '规则要具体到能照着写，例如「讲配置时先说使用场景再报参数」，不要写「专业」「年轻」这种标签。',
  '不要在规则里写价格、续航、马力这类具体数字——那些由车型库提供。',
  'avoid 写这个账号明显不会用的表达方式（不超过 5 条）。',
  '全部用简体中文，只输出 JSON。',
].join('\n');

const LLM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['rules', 'avoid'],
  properties: {
    rules: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rule', 'evidence'],
        properties: { rule: { type: 'string' }, evidence: { type: 'string' } },
      },
    },
    avoid: { type: 'array', items: { type: 'string' } },
  },
};

export function buildVoiceRequest(account: XhsAccount, samples: readonly VoiceSample[]): LlmJsonRequest {
  const notes = samples
    .slice(0, 8)
    .map((s, i) => `【笔记${i + 1}】标题：${s.title}\n${truncate(s.content, 500)}${s.tags.length ? `\n标签：${s.tags.map((t) => `#${t}`).join(' ')}` : ''}`)
    .join('\n\n');
  return {
    purpose: 'account_voice',
    system: LLM_SYSTEM,
    prompt: `账号：${account.nickname}（${account.account_type}）\n\n${notes}`,
    schema: LLM_SCHEMA,
    max_tokens: 1500,
  };
}

const NUMBER_CLAIM_RE = /\d+(?:\.\d+)?\s*(?:万|元|公里|km|度|kWh|马力|匹|秒|座|期|%|成|台)/iu;

/**
 * Keep only what the notes actually show: every rule must quote a passage that appears verbatim in one of them, and
 * no rule may smuggle in a price or a spec (those come from the vehicle library, never from a style profile).
 */
export function validateVoiceDraft(raw: unknown, samples: readonly VoiceSample[]): { rules: VoiceRule[]; avoid: string[]; rejected: number } {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const corpus = normalizeText(samples.map((s) => `${s.title}\n${s.content}`).join('\n'));
  const rules: VoiceRule[] = [];
  let rejected = 0;
  for (const item of Array.isArray(o.rules) ? o.rules : []) {
    const rule = typeof (item as Record<string, unknown>)?.rule === 'string' ? ((item as Record<string, unknown>).rule as string).trim() : '';
    const evidence = typeof (item as Record<string, unknown>)?.evidence === 'string' ? ((item as Record<string, unknown>).evidence as string).trim() : '';
    if (!rule || rule.length > 60 || NUMBER_CLAIM_RE.test(rule)) {
      rejected++;
      continue;
    }
    if (!evidence || !corpus.includes(normalizeText(evidence))) {
      rejected++;
      continue;
    }
    rules.push({ rule, basis: `历史原文「${truncate(evidence, 20)}」` });
    if (rules.length >= 8) break;
  }
  const avoid: string[] = [];
  for (const item of Array.isArray(o.avoid) ? o.avoid : []) {
    const text = typeof item === 'string' ? item.trim() : '';
    if (!text || text.length > 40 || NUMBER_CLAIM_RE.test(text)) {
      rejected++;
      continue;
    }
    avoid.push(text);
    if (avoid.length >= 5) break;
  }
  return { rules, avoid, rejected };
}

// ─────────────────────────────────────────────────────────────────────────────
// Learning and keeping the profile
// ─────────────────────────────────────────────────────────────────────────────

export function getAccountVoice(ctx: AppContext, accountId: string): AccountVoiceProfile | null {
  return ctx.db.table('account_voice_profiles').findOne({ account_id: accountId }) ?? null;
}

export function listDealerVoices(ctx: AppContext, dealerId: string): AccountVoiceProfile[] {
  return ctx.db.table('account_voice_profiles').findMany({ dealer_id: dealerId }, { orderBy: 'analyzed_at DESC' });
}

/** True when the account has never been analysed, or its profile is older than the refresh window. */
export function needsVoiceRefresh(ctx: AppContext, accountId: string): boolean {
  const profile = getAccountVoice(ctx, accountId);
  if (!profile) return true;
  const age = ctx.clock.now().getTime() - Date.parse(profile.analyzed_at);
  return !Number.isFinite(age) || age > VOICE_REFRESH_DAYS * 24 * 60 * 60_000;
}

/** Read this account's own notes, measure how it writes, and keep the result as its voice profile. */
export async function learnAccountVoice(
  ctx: AppContext,
  accountId: string,
  actor: string,
  opts: { limit?: number; use_llm?: boolean } = {},
): Promise<VoiceLearnResult> {
  const account = requireAccount(ctx, accountId);
  if (account.removed_at) throw new PolicyError('account_removed', '该账号已从车队移除', { account_id: accountId });
  const base: VoiceLearnResult = {
    account_id: account.id,
    account_name: account.nickname,
    status: 'AVAILABLE',
    reason: '',
    profile: getAccountVoice(ctx, account.id),
    fetched: 0,
    used: 0,
    skipped_own: 0,
    engine: 'rules',
  };

  const collected = await collectAccountNotes(ctx, account.id, { limit: opts.limit });
  base.fetched = collected.fetched;
  base.skipped_own = collected.skipped_own;
  if (collected.status !== 'AVAILABLE') return { ...base, status: collected.status, reason: collected.reason };

  const used = usableSamples(collected.samples);
  base.used = used.length;
  if (used.length < MIN_SAMPLES) {
    return { ...base, status: 'UNAVAILABLE', reason: `这个账号只有 ${used.length} 篇够长的笔记，至少要 ${MIN_SAMPLES} 篇才能学出稳定的风格` };
  }

  const metrics = measure(used);
  const vocab = vocabulary(used);
  const derived = deriveRules(metrics, vocab);
  const examples = pickExamples(used, metrics);
  let rules = derived.rules;
  let avoid = derived.avoid;
  let engine = 'rules';

  if (opts.use_llm !== false && ctx.llm.status().status === 'AVAILABLE') {
    const res = await ctx.llm.completeJson<unknown>(buildVoiceRequest(account, used));
    if (res.ok) {
      const checked = validateVoiceDraft(res.data, used);
      rules = [...rules, ...checked.rules];
      avoid = [...new Set([...avoid, ...checked.avoid])];
      engine = `llm:${res.model}`;
    }
  }

  const now = ctx.clock.iso();
  const newest = used.map((s) => s.published_at).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
  const profile = ctx.db.tx(() => {
    const table = ctx.db.table('account_voice_profiles');
    const existing = table.findOne({ account_id: account.id });
    const row = {
      sample_count: used.length,
      sample_note_ids: used.map((s) => s.platform_note_id),
      metrics,
      rules,
      vocabulary: vocab,
      examples,
      avoid,
      engine,
      analyzed_at: now,
      newest_sample_at: newest,
      updated_at: now,
    };
    return existing
      ? table.update(existing.id, row)
      : table.insert({ id: newId('voice'), account_id: account.id, dealer_id: account.dealer_id, created_at: now, ...row });
  });

  ctx.audit.decision({
    agent: VOICE_AGENT,
    skill: 'account-voice',
    decision_type: 'content_strategy',
    subject_type: 'account',
    subject_id: account.id,
    inputs: { samples: used.length, fetched: collected.fetched, skipped_own: collected.skipped_own },
    evidence: examples.map((e) => ({ code: 'sample', label: e.title || e.platform_note_id, quote: truncate(e.excerpt, 60) })),
    output: { rules: rules.length, avoid: avoid.length, examples: examples.length, metrics },
    confidence: Math.min(0.95, 0.5 + used.length * 0.05),
    engine: engine.startsWith('llm') ? 'llm+rules' : 'rules',
  });
  ctx.audit.event({
    actor,
    action: 'account.voice_learned',
    entity_type: 'xhs_account',
    entity_id: account.id,
    details: { samples: used.length, rules: rules.length, engine },
  });
  return { ...base, profile, engine, status: 'AVAILABLE', reason: '' };
}

/** Refresh every account of a dealer whose profile is missing or stale. */
export async function refreshDealerVoices(ctx: AppContext, dealerId: string, actor: string, opts: { force?: boolean } = {}): Promise<VoiceLearnResult[]> {
  getDealer(ctx, dealerId);
  const accounts = ctx.db.table('xhs_accounts').findMany({ dealer_id: dealerId, removed_at: null }, { orderBy: 'created_at ASC, id ASC' });
  const out: VoiceLearnResult[] = [];
  for (const account of accounts) {
    if (account.status === 'disabled') continue;
    if (!opts.force && !needsVoiceRefresh(ctx, account.id)) continue;
    out.push(await learnAccountVoice(ctx, account.id, actor));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Using the voice
// ─────────────────────────────────────────────────────────────────────────────

export interface VoiceBlockOptions {
  /** how many of the account's own notes to show as few-shot material */
  examples?: number;
  /** a private message is short: rules only, no long excerpts */
  compact?: boolean;
}

/**
 * The block a prompt carries. It ends with the line that matters most: learn the way it writes, do not reuse what it
 * wrote — and `voiceCopyCheck` enforces that afterwards regardless of what the model did with the instruction.
 */
export function voicePromptBlock(profile: AccountVoiceProfile | null, opts: VoiceBlockOptions = {}): string {
  if (!profile || profile.rules.length === 0) return '';
  const lines = [`【这个账号自己的写法】（从它已发布的 ${profile.sample_count} 篇笔记里学到的）`];
  for (const r of profile.rules.slice(0, opts.compact ? 6 : 14)) lines.push(`- ${r.rule}`);
  if (profile.avoid.length > 0) lines.push(`不要这样写：${profile.avoid.join('；')}`);
  const examples = profile.examples.slice(0, opts.compact ? 0 : (opts.examples ?? 2));
  if (examples.length > 0) {
    lines.push('它平时写成这样（只学写法和语气，内容必须是新的，不能照抄）：');
    for (const e of examples) lines.push(`《${e.title}》\n${e.excerpt}`);
  }
  return lines.join('\n');
}

/** 你 / 您 — which one this account actually uses. `null` when its own notes do not settle it. */
export function voicePronoun(profile: AccountVoiceProfile | null): '你' | '您' | null {
  const m = profile?.metrics;
  if (!m) return null;
  if (m.you_formal_share >= 0.4 && m.you_formal_share > m.you_casual_share) return '您';
  if (m.you_casual_share >= 0.4 && m.you_casual_share > m.you_formal_share) return '你';
  return null;
}

/** Rewrite the second person to the one this account uses; leaves text alone when its history does not settle it. */
export function applyVoicePronoun(text: string, profile: AccountVoiceProfile | null): string {
  const pronoun = voicePronoun(profile);
  if (!pronoun || !text) return text;
  return pronoun === '您' ? text.replace(/你/gu, '您') : text.replace(/您/gu, '你');
}

/**
 * Did this come out as new writing, or as a reprint? Checked against the very notes the voice was learned from.
 * Nothing generated is allowed to reuse an old note, however well it matches the style.
 */
export function voiceCopyCheck(ctx: AppContext, accountId: string, text: string): CopyCheck {
  const profile = getAccountVoice(ctx, accountId);
  if (!profile) return { copied: false, similarity: 0, platform_note_id: null, shared: null };
  return checkCopy(text, storedSamples(ctx, profile));
}

// ─────────────────────────────────────────────────────────────────────────────

interface VoiceSkillInput {
  dealer_id?: string;
  account_id?: string;
  force?: boolean;
  limit?: number;
}

export const skill = defineSkill<VoiceSkillInput, VoiceLearnResult[]>({
  name: 'account-voice',
  category: 'content',
  agent: VOICE_AGENT,
  description: '读取每个小红书账号自己已发布的笔记，量化它的写作习惯（标题、句式、emoji、结构、引导语、称呼、讲车方式），生成该账号独有的写作规则和范例，供写笔记、发私信和回复客户时使用。',
  input: v.object({
    dealer_id: v.optional(v.string({ min: 1 })),
    account_id: v.optional(v.string({ min: 1 })),
    force: v.optional(v.boolean()),
    limit: v.optional(v.number({ int: true, min: 3, max: 50 })),
  }),
  async run(ctx, input) {
    if (input.account_id) return [await learnAccountVoice(ctx, input.account_id, `agent:${VOICE_AGENT}`, { limit: input.limit })];
    if (input.dealer_id) return refreshDealerVoices(ctx, input.dealer_id, `agent:${VOICE_AGENT}`, { force: input.force });
    throw new ValidationError('dealer_id', 'dealer_id 或 account_id 必填');
  },
});

export { checkCopy, measure, MIN_SAMPLES, type CopyCheck, type VoiceSample } from './analyze.ts';
