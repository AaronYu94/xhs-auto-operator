/**
 * LLM screening of discovery candidates (who is actually shopping for a car).
 *
 * The rules (prefilter + intent detection + scoring) only nominate candidates; on real Xiaohongshu comment threads they
 * cannot tell a shopper from an owner who already ordered ("我也定了…"), a salesperson touting prices in the comments,
 * or someone advising another user ("两个车都试驾一下吧") — the first live run turned ~70% of such comments into leads.
 * When an LLM is available, a candidate becomes a lead only if the LLM classifies its author as a buyer, with a
 * verbatim quote from the text and the reply context it was given (post title, the comment it answers).
 *
 * Output is validated like every LLM output in the system: the role must be one of SCREEN_ROLES, the quote and any
 * stated location must be verbatim substrings of the text, unknown ids are ignored; an item without a valid verdict is
 * left unscreened (never a lead).
 */
import type { AppContext } from '../../../app/context.ts';
import type { ActorType } from '../../../core/types.ts';
import { anchorQuote, findLocation, provinceOfIp } from '../../../domain/automotive-lexicon.ts';
import type { LlmJsonRequest } from '../../../providers/llm/types.ts';

export const SCREEN_ROLES = ['buyer', 'owner', 'dealer', 'advice', 'chatter'] as const;
export type ScreenRole = (typeof SCREEN_ROLES)[number];

export const SCREEN_ROLE_ACTOR: Readonly<Record<ScreenRole, ActorType>> = {
  buyer: 'BUYER',
  owner: 'OWNER',
  dealer: 'DEALER_OR_SALES',
  advice: 'ENTHUSIAST',
  chatter: 'UNKNOWN',
};

export const SCREEN_ROLE_LABEL: Readonly<Record<ScreenRole, string>> = {
  buyer: '在市买家',
  owner: '已购车/已下订',
  dealer: '车商/销售',
  advice: '给别人出主意',
  chatter: '闲聊/无购车意向',
};

/**
 * Candidates per LLM call (one note's candidates are usually far fewer). Kept small enough that a batch's answer
 * fits the token budget: truncated answers cost the whole batch (2026-09 cleanup: 3 batches of 20 were truncated).
 */
export const SCREEN_BATCH_SIZE = 12;
/** reply / post context passed to the model is clipped to this many characters */
const CONTEXT_CHARS = 200;
const TEXT_CHARS = 600;

export interface ScreenItem {
  /** stable id within one request, e.g. 'c3' */
  id: string;
  source_type: 'post' | 'comment';
  /** exact text the verdict must quote from */
  text: string;
  author_nickname: string | null;
  ip_location: string | null;
  /** text of the comment this one replies to, if any */
  reply_to: string | null;
}

export interface ScreenNote {
  title: string;
  content: string;
}

export interface ScreenVerdict {
  role: ScreenRole;
  /** place the author states in the text (verbatim), e.g. '浙江', '杭州' */
  location: string | null;
  quote: string;
  reason: string;
}

export interface ScreenOutcome {
  verdicts: Map<string, ScreenVerdict>;
  /** items whose verdict was missing or invalid, or whose batch failed */
  unscreened: number;
  model: string | null;
  failures: string[];
}

const SYSTEM_PROMPT = [
  '你是汽车经销商的获客审核员，审核小红书笔记和评论的发言人是不是「正在考虑买车的人」。宁缺毋滥：拿不准时判为 chatter。',
  '身份只能是以下之一：',
  'buyer：发言人本人还没买、也没下订，正在考虑买车——询价/问落地价/问优惠或金融/问现车或提车周期/比较车型/求推荐/已试驾在犹豫/想买但在观望。',
  '判 buyer 必须有「本人要买」的证据（我想买/在看/纠结/准备/蹲/问自己要买的车的价格、优惠、提车时间）。只评价车、吐槽价格或配置、分享试驾感受、回答别人的问题，都不是 buyer。',
  'owner：发言人本人已经买了或已经下订（交了定金、"定了"、"还没提车"、"提车…"、"开了…"、"我的车"），在分享、吐槽或问用车问题。',
  'dealer：销售、门店、车商、二手车商、中介——报价、招揽、"私我"、"我这边还能再少"、"发报价单"、"异地提车"。',
  'advice：在回答或建议别人（"你去试驾一下"、"别买"、"投诉他就好了"），本人没有表达买车需求。',
  'chatter：其他闲聊、吐槽、玩笑、感叹、与购车无关的讨论。',
  '判断时结合「回复的评论」和「笔记标题」理解上下文：回复里的"我也是"指和被回复的人一样。',
  'quote 必须逐字复制自该条的「原文」（包括标点和表情代码，不要改写），选最能说明身份的一句（不超过 40 字）。',
  'location 只填原文里本人写出的地点（逐字复制，如"浙江"、"杭州"），没写就填 null；不要用 IP 属地推测。',
  'reason 用中文简短说明判断理由（不超过 30 字）。每条输入都要输出一条结果，id 原样返回。只输出 JSON。',
].join('\n');

const SCREEN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'role', 'location', 'quote', 'reason'],
        properties: {
          id: { type: 'string' },
          role: { type: 'string', enum: [...SCREEN_ROLES] },
          location: { type: ['string', 'null'] },
          quote: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function buildScreenRequest(note: ScreenNote, items: ScreenItem[], brands: string[]): LlmJsonRequest {
  const payload = {
    门店经营品牌: brands,
    笔记标题: clip(note.title.trim(), CONTEXT_CHARS),
    笔记正文开头: clip(note.content.trim(), CONTEXT_CHARS),
    待审核: items.map((i) => ({
      id: i.id,
      类型: i.source_type === 'post' ? '笔记正文' : '评论',
      原文: clip(i.text, TEXT_CHARS),
      回复的评论: i.reply_to ? clip(i.reply_to, CONTEXT_CHARS) : null,
      昵称: i.author_nickname,
      IP属地: i.ip_location,
    })),
  };
  return {
    purpose: 'lead_screening',
    system: SYSTEM_PROMPT,
    prompt: `请逐条审核以下小红书内容的发言人身份，按 JSON Schema 输出：\n${JSON.stringify(payload, null, 2)}`,
    schema: SCREEN_SCHEMA,
    max_tokens: 1200 + items.length * 450,
  };
}

/** Xiaohongshu emoji codes ('[笑哭R]', '[doge]') that models tend to drop when quoting. */
const EMOJI_CODE_RE = /\[[^\[\]\s]{1,8}\]/g;

/**
 * The raw substring of `text` a quote refers to when the quote only differs by dropped emoji codes
 * ('估计7k左右结果8k6' → '估计7k左右[呃R]结果8k6'); null when it does not occur. The result is verbatim from `text`.
 */
export function anchorSkippingEmojiCodes(text: string, quote: string): string | null {
  const q = quote.replace(EMOJI_CODE_RE, '').trim();
  if (!q) return null;
  let stripped = '';
  const at: number[] = [];
  let last = 0;
  for (const m of text.matchAll(EMOJI_CODE_RE)) {
    for (let i = last; i < (m.index ?? 0); i++) {
      stripped += text[i];
      at.push(i);
    }
    last = (m.index ?? 0) + m[0].length;
  }
  for (let i = last; i < text.length; i++) {
    stripped += text[i];
    at.push(i);
  }
  const idx = stripped.indexOf(q);
  if (idx < 0) return null;
  return text.slice(at[idx], at[idx + q.length - 1] + 1);
}

/** Validate a model response against the items it was asked about (pure). */
export function validateScreen(raw: unknown, items: ScreenItem[]): Map<string, ScreenVerdict> {
  const out = new Map<string, ScreenVerdict>();
  const byId = new Map(items.map((i) => [i.id, i]));
  const results = raw && typeof raw === 'object' && Array.isArray((raw as { results?: unknown }).results) ? (raw as { results: unknown[] }).results : [];
  for (const r of results) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const item = typeof o.id === 'string' ? byId.get(o.id) : undefined;
    if (!item || out.has(item.id)) continue;
    if (typeof o.role !== 'string' || !(SCREEN_ROLES as readonly string[]).includes(o.role)) continue;
    // re-anchor to the exact raw substring (same equivalence as isVerbatimQuote: NFKC, case, whitespace runs)
    const quote = typeof o.quote === 'string' ? (anchorQuote(item.text, o.quote) ?? anchorSkippingEmojiCodes(item.text, o.quote)) : null;
    if (!quote) continue;
    const location = typeof o.location === 'string' && o.location.trim() ? anchorQuote(item.text, o.location) : null;
    const reason = typeof o.reason === 'string' && o.reason.trim() ? clip(o.reason.trim(), 60) : SCREEN_ROLE_LABEL[o.role as ScreenRole];
    out.set(item.id, { role: o.role as ScreenRole, location, quote, reason });
  }
  return out;
}

/** Screen one note's candidates (batched). Never throws: failures leave items unscreened. */
export async function screenCandidates(ctx: AppContext, note: ScreenNote, items: ScreenItem[], brands: string[]): Promise<ScreenOutcome> {
  const outcome: ScreenOutcome = { verdicts: new Map(), unscreened: 0, model: null, failures: [] };
  for (let i = 0; i < items.length; i += SCREEN_BATCH_SIZE) {
    const batch = items.slice(i, i + SCREEN_BATCH_SIZE);
    let verdicts = new Map<string, ScreenVerdict>();
    try {
      const res = await ctx.llm.completeJson<unknown>(buildScreenRequest(note, batch, brands));
      if (res.ok) {
        outcome.model = res.model;
        verdicts = validateScreen(res.data, batch);
      } else {
        outcome.failures.push(res.reason);
      }
    } catch (err) {
      outcome.failures.push(err instanceof Error ? err.message : String(err));
    }
    for (const [id, v] of verdicts) outcome.verdicts.set(id, v);
    outcome.unscreened += batch.length - verdicts.size;
  }
  return outcome;
}

// ─────────────────────────────────────────────────────────────────────────────
// Target area (from the goal the query serves)
// ─────────────────────────────────────────────────────────────────────────────

/** Where the goal wants buyers; `null` = anywhere (the goal said 全国). */
export interface TargetArea {
  city: string | null;
  province: string | null;
}

export interface AreaCheck {
  inside: boolean;
  /** what decided it: a place the author wrote, the IP 属地, or nothing known (kept) */
  basis: 'anywhere' | 'stated' | 'ip' | 'unknown';
  detail: string;
}

export function areaLabel(area: TargetArea | null): string {
  return area ? (area.city ?? area.province ?? '门店所在地') : '全国';
}

/**
 * Is a buyer inside the goal's area (pure)? A place the author states wins (verbatim, from the screening verdict);
 * otherwise the IP 属地 province (Xiaohongshu shows provinces only, so a city goal accepts its whole province);
 * with neither, the buyer is kept — absence of a location is not evidence of being elsewhere.
 */
export function inTargetArea(area: TargetArea | null, ipLocation: string | null, stated: string | null): AreaCheck {
  if (!area) return { inside: true, basis: 'anywhere', detail: '目标不限地区' };
  const province = area.province ? (provinceOfIp(area.province) ?? area.province) : area.city ? provinceOfIp(area.city) : null;
  const where = areaLabel(area);
  const loc = stated ? findLocation(stated) : null;
  if (loc && (loc.city || loc.province)) {
    const inside = (!!area.city && loc.city === area.city) || (!!province && loc.province === province);
    return { inside, basis: 'stated', detail: `本人写明「${loc.quote}」${inside ? '，在' : '，不在'}目标地区（${where}）` };
  }
  const ipProvince = provinceOfIp(ipLocation);
  if (ipProvince && province) {
    const inside = ipProvince === province;
    return { inside, basis: 'ip', detail: `IP属地 ${ipProvince}${inside ? '，在' : '，不在'}目标地区（${where}）` };
  }
  return { inside: true, basis: 'unknown', detail: '未写明地点且无 IP 属地，暂按目标地区内处理' };
}
