/**
 * post-generation (spec §15, ARCHITECTURE §8 C4): PLANNED | CHANGES_REQUIRED | DRAFTED post → DRAFTED.
 *
 * The deterministic composer is the baseline and complete on its own. When an LLM is AVAILABLE it may rewrite the
 * draft, but the rewrite is only accepted when every factual claim verifies against Dealer Brain rows, platform rules
 * pass, no persona taboo appears and the format rules hold; otherwise the rules draft is kept and the reason recorded.
 */
import type { AppContext } from '../../../app/context.ts';
import { PolicyError } from '../../../core/errors.ts';
import { normalizeText } from '../../../core/text.ts';
import type { Engine, Evidence, FactRef, Post, PostStatus } from '../../../core/types.ts';
import { v } from '../../../core/validate.ts';
import { defineSkill } from '../../registry.ts';
import {
  BODY_MAX_CHARS,
  BODY_MIN_CHARS,
  MAX_TAGS,
  MIN_TAGS,
  PILLAR_LABEL,
  STOCK_WORD_RE,
  TITLE_MAX_CHARS,
  checkText,
  composeDraft,
  dedupeRefs,
  formatIssues,
  tabooHits,
  type ComposedDraft,
} from './composer.ts';

export {
  BODY_MAX_CHARS,
  BODY_MIN_CHARS,
  MAX_TAGS,
  MIN_TAGS,
  PILLAR_LABEL,
  TITLE_MAX_CHARS,
  checkText,
  composeDraft,
  formatIssues,
  tabooHits,
  titleModelLabel,
  type ComposedDraft,
} from './composer.ts';

export const POST_GENERATION_AGENT = 'content-agent';
export const GENERATABLE_STATUSES: readonly PostStatus[] = ['PLANNED', 'CHANGES_REQUIRED', 'DRAFTED'];

export const POST_LLM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'body', 'tags', 'cover_text'],
  properties: {
    title: { type: 'string' },
    body: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    cover_text: { type: 'string' },
  },
};

export interface LlmDraftCheck {
  accepted: boolean;
  issues: string[];
  fact_refs: FactRef[];
}

/**
 * Validate an LLM rewrite against the rules draft's verified facts: only FactRefs whose claim appears verbatim in the
 * rewrite are kept; every claim in the rewrite must verify against them; platform rules, taboo topics and format rules
 * must pass; stock words are only allowed when the rules draft itself carried inventory facts.
 */
export function validateLlmDraft(
  ctx: AppContext,
  post: Post,
  rules: ComposedDraft,
  candidate: { title: string; body: string; tags: string[]; cover_text: string },
): LlmDraftCheck {
  const text = `${candidate.title}\n${candidate.cover_text}\n${candidate.body}`;
  const norm = normalizeText(text);
  const refs = dedupeRefs(rules.fact_refs.filter((r) => norm.includes(normalizeText(r.claim))));
  const issues: string[] = [];
  const check = checkText(ctx, post.dealer_id, text, refs);
  if (!check.passed) issues.push(...check.issues);
  const taboo = tabooHits(rules.inputs.persona, text);
  if (taboo.length > 0) issues.push(`触及人设禁忌话题：${taboo.join('、')}`);
  issues.push(...formatIssues(candidate, rules.inputs.model_label));
  if (!rules.fact_refs.some((r) => r.kind === 'inventory') && STOCK_WORD_RE.test(text)) issues.push('改写包含未经库存数据支持的现车/在途表述');
  if (refs.length === 0 && rules.fact_refs.length > 0) issues.push('改写未使用任何经核实的门店数据');
  return { accepted: issues.length === 0, issues, fact_refs: refs };
}

function llmPrompt(post: Post, rules: ComposedDraft): { system: string; prompt: string } {
  const inp = rules.inputs;
  const p = inp.persona;
  const system = [
    '你是汽车经销商小红书账号的内容编辑，只输出JSON。',
    '硬性规则：只能使用“已核实事实”列表中的原文表述来陈述价格、优惠、金融、库存、日期等事实，不得改写数字，不得新增任何事实；',
    '不得出现电话、微信、二维码、外部链接或“加我”等站外引流；不得出现绝对化用语（最低价、最好、绝对、保证等）；不得计算或承诺落地价；',
    `标题不超过${TITLE_MAX_CHARS}字且包含「${inp.model_label}」；正文${BODY_MIN_CHARS}-${BODY_MAX_CHARS}字；话题标签${MIN_TAGS}-${MAX_TAGS}个（不带#）。`,
  ].join('');
  const prompt = [
    `账号：${inp.account.nickname}（${inp.account.account_type}），人设：${p.persona_name}，语气：${p.tone}`,
    `表达规则：${(p.voice_rules ?? []).join('；') || '无'}`,
    `禁忌话题：${(p.taboo_topics ?? []).join('；') || '无'}`,
    `内容支柱：${PILLAR_LABEL[post.pillar]}，角度：${inp.angle}，车型：${inp.model_full}`,
    '已核实事实（只能原样引用）：',
    ...rules.fact_refs.map((r) => `- ${r.claim}`),
    '参考初稿（可以改写结构和语气，但事实必须来自上面的列表）：',
    `标题：${rules.title}`,
    rules.body,
  ].join('\n');
  return { system, prompt };
}

function parseCandidate(data: unknown): { title: string; body: string; tags: string[]; cover_text: string } | null {
  if (typeof data !== 'object' || data === null) return null;
  const o = data as Record<string, unknown>;
  if (typeof o.title !== 'string' || typeof o.body !== 'string' || typeof o.cover_text !== 'string' || !Array.isArray(o.tags)) return null;
  const tags = [...new Set(o.tags.filter((t): t is string => typeof t === 'string').map((t) => t.replace(/[#\s]/g, '')).filter(Boolean))];
  return { title: o.title.trim(), body: o.body.trim(), tags, cover_text: o.cover_text.trim() };
}

/** Generate the draft for a planned post (async only because of the optional LLM call; persistence is one tx). */
export async function generatePost(ctx: AppContext, postId: string): Promise<Post> {
  const post = ctx.db.table('posts').require(postId);
  if (!GENERATABLE_STATUSES.includes(post.status)) {
    throw new PolicyError('invalid_post_status', `只能为 PLANNED / CHANGES_REQUIRED / DRAFTED 状态的内容生成草稿，当前为 ${post.status}`, {
      post_id: postId,
      status: post.status,
    });
  }

  const rules = composeDraft(ctx, post);
  let final = { title: rules.title, body: rules.body, tags: rules.tags, cover_text: rules.cover_text, fact_refs: rules.fact_refs };
  let engine: Engine = 'rules';
  const llm: Record<string, unknown> = { used: false };

  if (ctx.llm.status().status === 'AVAILABLE') {
    const { system, prompt } = llmPrompt(post, rules);
    try {
      const res = await ctx.llm.completeJson<unknown>({ purpose: 'post_generation', system, prompt, schema: POST_LLM_SCHEMA, max_tokens: 2000 });
      if (!res.ok) llm.fallback_reason = res.reason;
      else {
        const candidate = parseCandidate(res.data);
        if (!candidate) llm.fallback_reason = 'malformed_payload';
        else {
          const verdict = validateLlmDraft(ctx, post, rules, candidate);
          llm.model = res.model;
          if (verdict.accepted) {
            final = { ...candidate, fact_refs: verdict.fact_refs };
            engine = 'llm+rules';
            llm.used = true;
          } else {
            llm.fallback_reason = 'validation_failed';
            llm.rejected_issues = verdict.issues.slice(0, 10);
          }
        }
      }
    } catch (err) {
      llm.fallback_reason = `llm_error: ${(err as Error)?.message ?? String(err)}`;
    }
  }

  const evidence: Evidence[] = final.fact_refs.map((r) => ({ code: 'dealer_fact', label: r.claim, source_ref: `${r.kind}:${r.id}` }));
  return ctx.db.tx(() => {
    const updated = ctx.db.table('posts').update(postId, {
      title: final.title,
      body: final.body,
      tags: final.tags,
      cover_text: final.cover_text,
      fact_refs: final.fact_refs,
      status: 'DRAFTED',
      review: null,
      engine,
    });
    ctx.audit.event({
      actor: `agent:${POST_GENERATION_AGENT}`,
      action: 'post.drafted',
      entity_type: 'post',
      entity_id: postId,
      details: { previous_status: post.status, engine, facts: final.fact_refs.length },
    });
    ctx.audit.decision({
      agent: POST_GENERATION_AGENT,
      skill: 'post-generation',
      decision_type: 'content_generation',
      subject_type: 'post',
      subject_id: postId,
      inputs: {
        account_id: post.account_id,
        account_type: rules.inputs.account.account_type,
        persona: rules.inputs.persona.persona_name,
        tone: rules.inputs.persona.tone,
        pillar: post.pillar,
        angle: rules.inputs.angle,
        model: post.model,
        available_facts: rules.fact_refs.length,
      },
      evidence,
      output: {
        title: final.title,
        body_chars: [...final.body].length,
        tags: final.tags,
        fact_refs: final.fact_refs.length,
        dropped_blocks: rules.dropped,
        engine,
        llm,
      },
      confidence: rules.dropped.length === 0 ? 0.9 : 0.75,
      engine,
    });
    return updated;
  });
}

export const skill = defineSkill<{ post_id: string }, Post>({
  name: 'post-generation',
  category: 'content',
  agent: 'content-agent',
  description:
    '为计划中的小红书笔记生成草稿：按账号人设与账号类型组织结构，价格/优惠/金融/库存/门店信息只取自Dealer Brain并附带可核实的事实引用；可选LLM改写须通过事实核验与平台规则。',
  input: v.object({ post_id: v.string({ min: 1 }) }),
  run(ctx, input) {
    return generatePost(ctx, input.post_id);
  },
  validateOutput(output) {
    if (output.status !== 'DRAFTED') throw new Error(`post-generation: expected DRAFTED, got ${output.status}`);
  },
});
