import { ValidationError } from '../../core/errors.ts';
import { zonedTimeToUtc } from '../../core/time.ts';

/**
 * Parser for the official 聚光 (Juguang) "私信API对接" lead push.
 *
 * When a customer-service agent marks a DM conversation as a valid lead in 聚光/私信通, Xiaohongshu
 * POSTs the lead record (not the messages) to a configured webhook. The exact field keys are
 * UNVERIFIED (vendor docs show Chinese labels), so this parser is deliberately tolerant: Chinese
 * labels and English snake_case / camelCase variants are accepted, payloads may be a single object,
 * an array, or wrapped in envelopes like {data: [...]} / {code, data: {list: [...]}}. Contact details
 * here were voluntarily provided by the user through 留资卡 / conversation and may be stored on the
 * CRM lead.
 *
 * Person fields (identity, nickname, contact, region) are only read from the record itself or from
 * a nested person container ({user: {...}}, {lead_info: {...}}) — never from nested note / ad /
 * receiver objects, so a note author or the receiving account can not be mistaken for the lead.
 */

export interface JuguangLead {
  /** user id when provided, else the 小红书号 (see red_id) */
  platform_user_id: string | null;
  /** 小红书号 (public Red ID) when provided; distinct from the internal user id */
  red_id: string | null;
  nickname: string | null;
  province: string | null;
  city: string | null;
  tags: string[];
  phone: string | null;
  wechat: string | null;
  remark: string | null;
  note_url: string | null;
  note_id: string | null;
  campaign_id: string | null;
  unit_id: string | null;
  creative_id: string | null;
  receiver: string | null;
  /** 操作类型 when present (e.g. 新增/修改) */
  operation: string | null;
  occurred_at: string | null;
  raw: Record<string, unknown>;
}

export interface JuguangParseResult {
  leads: JuguangLead[];
  rejected: { index: number; reason: string }[];
}

type Field =
  | 'platform_user_id'
  | 'red_id'
  | 'nickname'
  | 'province'
  | 'city'
  | 'tags'
  | 'phone'
  | 'wechat'
  | 'remark'
  | 'note_url'
  | 'campaign_id'
  | 'unit_id'
  | 'creative_id'
  | 'receiver'
  | 'operation'
  | 'time';

/** Key aliases in priority order. Keys are compared after normalization (NFKC, lower-case, no _ - space). */
const ALIASES: Record<Field, string[]> = {
  platform_user_id: ['user_id', 'userId', 'xhs_user_id', '用户id', '用户ID', 'uid'],
  red_id: ['小红书号', 'red_id', 'redId', 'xhs_id', '小红书id'],
  nickname: ['用户昵称', '昵称', 'nickname', 'nick_name', 'user_nickname', 'user_name', 'username'],
  province: ['省份', '省', 'province'],
  city: ['城市', '市', 'city'],
  tags: ['线索标签', '标签', 'tags', 'lead_tags', 'tag', 'labels', 'label'],
  phone: ['电话', '手机号', '手机', '手机号码', '联系电话', 'phone', 'mobile', 'phone_number', 'tel', 'telephone'],
  wechat: ['微信', '微信号', 'wechat', 'wechat_id', 'weixin', 'wx'],
  remark: ['备注', 'remark', 'remarks', 'memo'],
  note_url: ['笔记链接', '笔记url', 'note_url', 'note_link', 'noteUrl', 'note_link_url'],
  campaign_id: ['广告计划ID', '计划ID', '广告计划id', 'campaign_id', 'campaignId', 'plan_id', 'planId'],
  unit_id: ['单元ID', '广告单元ID', '单元id', 'unit_id', 'unitId'],
  creative_id: ['创意ID', '广告创意ID', '创意id', 'creative_id', 'creativeId', 'creativity_id'],
  receiver: ['私信接收人', '私信接收人ID', '私信接收人id', '接收人', 'receiver', 'receiver_id', 'receiverId', 'receive_user'],
  operation: ['操作类型', 'operation', 'operation_type', 'operate_type', 'action'],
  time: ['时间', '推送时间', '线索时间', 'time', 'push_time', 'pushTime', 'create_time', 'createTime', 'created_at', 'timestamp'],
};

const PERSON_FIELDS = new Set<Field>(['platform_user_id', 'red_id', 'nickname', 'province', 'city', 'tags', 'phone', 'wechat', 'remark']);
/** nested containers that describe the lead person */
const PERSON_CONTAINER_RE = /user|lead|customer|clue|contact|client|用户|线索|客户|联系/i;
/** nested containers that describe something else (never a source of person fields) */
const NON_PERSON_CONTAINER_RE = /receiv|接收|note|笔记|advert|^ad$|^ads$|campaign|计划|unit|单元|creative|创意|account|投放|客服|agent|staff|seller|sales|author|作者/i;

const normKey = (k: string) => k.normalize('NFKC').toLowerCase().replace(/[\s_\-]/g, '');
const NORMALIZED_ALIASES: Record<Field, string[]> = Object.fromEntries(
  Object.entries(ALIASES).map(([f, keys]) => [f, keys.map(normKey)]),
) as Record<Field, string[]>;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const present = (x: unknown) => x !== undefined && x !== null && x !== '';

function lookupTop(obj: Record<string, unknown>, field: Field): unknown {
  const byKey = new Map<string, unknown>();
  for (const [k, val] of Object.entries(obj)) {
    const nk = normKey(k);
    if (!byKey.has(nk) || !present(byKey.get(nk))) byKey.set(nk, val);
  }
  for (const alias of NORMALIZED_ALIASES[field]) {
    const val = byKey.get(alias);
    if (present(val) && !isObject(val) && !Array.isArray(val)) return val;
    if (field === 'tags' && Array.isArray(val) && val.length > 0) return val;
  }
  return undefined;
}

/** One level of nesting (e.g. {user: {...}, ad: {...}}), scoped so person fields come only from person containers. */
function lookupNested(obj: Record<string, unknown>, field: Field): unknown {
  for (const [containerKey, val] of Object.entries(obj)) {
    if (!isObject(val)) continue;
    if (PERSON_FIELDS.has(field)) {
      if (NON_PERSON_CONTAINER_RE.test(containerKey) || !PERSON_CONTAINER_RE.test(containerKey)) continue;
    }
    const found = lookupTop(val, field);
    if (found !== undefined) return found;
  }
  return undefined;
}

function lookup(obj: Record<string, unknown>, field: Field): unknown {
  return lookupTop(obj, field) ?? lookupNested(obj, field);
}

function str(val: unknown): string | null {
  if (typeof val === 'string') {
    const t = val.trim();
    return t ? t : null;
  }
  if (typeof val === 'number' && Number.isFinite(val)) return String(val);
  if (typeof val === 'bigint') return val.toString();
  return null;
}

function tagsOf(val: unknown): string[] {
  const parts: string[] = [];
  const push = (x: unknown) => {
    const s = isObject(x) ? str(x.name ?? x.tag ?? x.label ?? x.value) : str(x);
    if (!s) return;
    for (const p of s.split(/[,，、;；|\/]/)) {
      const t = p.trim();
      if (t && !parts.includes(t)) parts.push(t);
    }
  };
  if (Array.isArray(val)) val.forEach(push);
  else push(val);
  return parts;
}

function phoneOf(val: unknown): string | null {
  const s = str(val);
  if (!s) return null;
  const compact = s.normalize('NFKC').replace(/[\s\-()（）]/g, '');
  return compact || null;
}

/** Extract the note id from https://www.xiaohongshu.com/explore/<id>?xsec_token=… and similar URLs. */
export function noteIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  const path = /\/(?:explore|discovery\/item|item|notes?)\/([0-9A-Za-z_-]{6,64})/.exec(url);
  if (path) return path[1];
  const q = /[?&](?:note_?id|noteId|feed_?id)=([0-9A-Za-z_-]{6,64})/i.exec(url);
  return q ? q[1] : null;
}

const TZ = 'Asia/Shanghai';

function shanghaiLocalToIso(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null; // e.g. 02-30
  const base = zonedTimeToUtc(y, mo, d, h, mi, TZ);
  const t = base.getTime() + s * 1000 + ms;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Digit-only timestamps: 10 = epoch s, 13 = epoch ms, 16 = epoch µs, 8/12/14 = compact yyyyMMdd[HHmm[ss]] (Asia/Shanghai). */
function digitsToIso(digits: string): string | null {
  const num = (a: number, b: number) => Number(digits.slice(a, b));
  switch (digits.length) {
    case 10:
      return new Date(Number(digits) * 1000).toISOString();
    case 13:
      return new Date(Number(digits)).toISOString();
    case 16:
      return new Date(Math.floor(Number(digits) / 1000)).toISOString();
    case 8:
      return shanghaiLocalToIso(num(0, 4), num(4, 6), num(6, 8));
    case 12:
      return shanghaiLocalToIso(num(0, 4), num(4, 6), num(6, 8), num(8, 10), num(10, 12));
    case 14:
      return shanghaiLocalToIso(num(0, 4), num(4, 6), num(6, 8), num(8, 10), num(10, 12), num(12, 14));
    default:
      return null;
  }
}

const LOCAL_DATETIME_RE =
  /^(\d{4})(?:[-/.]|年)(\d{1,2})(?:[-/.]|月)(\d{1,2})日?(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?$/;
const ZONED_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Convert push times to ISO. Accepts epoch s/ms/µs (number or digits), compact yyyyMMdd[HHmm[ss]],
 * 'YYYY-MM-DD HH:mm[:ss[.SSS]]' / 'YYYY/MM/DD' / 'YYYY年M月D日 HH:mm' read as Asia/Shanghai, and ISO
 * strings with an explicit offset. Anything else (including zone-less free text, whose meaning would
 * depend on the server's timezone) and impossible dates return null.
 */
export function juguangTimeToIso(val: unknown): string | null {
  if (val === undefined || val === null || val === '') return null;
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || val <= 0) return null;
    return digitsToIso(String(Math.trunc(val)));
  }
  if (typeof val !== 'string') return null;
  const s = val.normalize('NFKC').trim();
  if (/^\d+$/.test(s)) return digitsToIso(s);
  const local = LOCAL_DATETIME_RE.exec(s);
  if (local) {
    const [, y, mo, d, h, mi, sec, frac] = local;
    const ms = frac ? Number(frac.slice(0, 3).padEnd(3, '0')) : 0;
    return shanghaiLocalToIso(Number(y), Number(mo), Number(d), Number(h ?? 0), Number(mi ?? 0), Number(sec ?? 0), ms);
  }
  if (ZONED_ISO_RE.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
}

const ENVELOPE_KEYS = ['data', 'leads', 'list', 'records', 'items', 'result', 'rows'];
const IDENTITY_FIELDS: Field[] = ['platform_user_id', 'red_id', 'nickname', 'phone', 'wechat'];

function hasLeadFields(obj: Record<string, unknown>): boolean {
  return IDENTITY_FIELDS.some((f) => lookupTop(obj, f) !== undefined);
}

function unwrap(body: unknown, depth = 0): unknown[] {
  let value = body;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new ValidationError('body', 'juguang lead push is not valid JSON');
    }
  }
  if (Array.isArray(value)) return value;
  if (!isObject(value)) throw new ValidationError('body', 'juguang lead push must be an object or array');
  if (depth >= 4 || hasLeadFields(value)) return [value];
  for (const key of ENVELOPE_KEYS) {
    const inner = value[key];
    if (Array.isArray(inner)) return inner;
    if (isObject(inner) || (typeof inner === 'string' && /^\s*[[{]/.test(inner))) return unwrap(inner, depth + 1);
  }
  return [value];
}

function parseItem(item: unknown): JuguangLead | string {
  if (!isObject(item)) return 'lead item is not an object';
  const note_url = str(lookup(item, 'note_url'));
  const topUserId = str(lookupTop(item, 'platform_user_id'));
  const topRedId = str(lookupTop(item, 'red_id'));
  const nestedUserId = str(lookupNested(item, 'platform_user_id'));
  const red_id = topRedId ?? str(lookupNested(item, 'red_id'));
  const lead: JuguangLead = {
    platform_user_id: topUserId ?? topRedId ?? nestedUserId ?? red_id,
    red_id,
    nickname: str(lookup(item, 'nickname')),
    province: str(lookup(item, 'province')),
    city: str(lookup(item, 'city')),
    tags: tagsOf(lookup(item, 'tags')),
    phone: phoneOf(lookup(item, 'phone')),
    wechat: str(lookup(item, 'wechat')),
    remark: str(lookup(item, 'remark')),
    note_url,
    note_id: noteIdFromUrl(note_url),
    campaign_id: str(lookup(item, 'campaign_id')),
    unit_id: str(lookup(item, 'unit_id')),
    creative_id: str(lookup(item, 'creative_id')),
    receiver: str(lookup(item, 'receiver')),
    operation: str(lookup(item, 'operation')),
    occurred_at: juguangTimeToIso(lookup(item, 'time')),
    raw: item,
  };
  if (!lead.platform_user_id && !lead.nickname && !lead.phone && !lead.wechat) {
    return 'lead has no user identity (小红书号/user_id/昵称) and no contact (电话/微信)';
  }
  return lead;
}

/** Detailed variant: usable leads plus the reasons unusable items were rejected. */
export function parseJuguangLeadPushDetailed(body: unknown): JuguangParseResult {
  const items = unwrap(body);
  const leads: JuguangLead[] = [];
  const rejected: { index: number; reason: string }[] = [];
  items.forEach((item, index) => {
    const parsed = parseItem(item);
    if (typeof parsed === 'string') rejected.push({ index, reason: parsed });
    else leads.push(parsed);
  });
  return { leads, rejected };
}

/**
 * Parse a 聚光 lead push. Throws ValidationError when the payload contains no usable lead
 * (every item lacks both an identity and a contact). Use parseJuguangLeadPushDetailed to also
 * receive per-item rejection reasons for partially usable batches.
 */
export function parseJuguangLeadPush(body: unknown): JuguangLead[] {
  const { leads, rejected } = parseJuguangLeadPushDetailed(body);
  if (leads.length === 0) {
    const why = rejected.length > 0 ? rejected.map((r) => `[${r.index}] ${r.reason}`).join('; ') : 'no lead records found';
    throw new ValidationError('body', `unusable juguang lead push: ${why}`);
  }
  return leads;
}
