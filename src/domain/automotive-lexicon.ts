/**
 * Automotive lexicon (A3): canonical brands / models / trims / competitors / locations plus the
 * shared, offset-preserving text matching used by every deterministic Chinese NLU in the system.
 *
 * Matching model
 * - Text is normalized per code point (NFKC + lower-case) while keeping a map back to the raw
 *   string, so every `quote` returned here is a VERBATIM substring of the input.
 * - Aliases are matched longest-first without overlaps. Latin/digit aliases are word-boundary aware
 *   ('i3' never matches inside 'i30' or 'mi3'; 'x3' never matches inside 'ix3').
 * - Ambiguous aliases (e.g. 'M3' — Tesla Model 3 slang but also BMW M3) only resolve with explicit
 *   brand context.
 * - Calendar time expressions ('9月底', '国庆前') are resolved against an explicit `now` / timezone only.
 */
import { DAY_MS, DEFAULT_TZ, localParts, type LocalParts } from '../core/time.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Offset-preserving normalized text
// ─────────────────────────────────────────────────────────────────────────────

export interface MappedText {
  readonly raw: string;
  /** NFKC + lower-case, same code-point order as `raw` */
  readonly norm: string;
  /** for every UTF-16 unit of `norm`: start offset of the originating code point in `raw` */
  readonly starts: readonly number[];
  /** for every UTF-16 unit of `norm`: end offset (exclusive) of the originating code point in `raw` */
  readonly ends: readonly number[];
}

export function mapText(raw: string): MappedText {
  let norm = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const ch of raw) {
    const n = ch.normalize('NFKC').toLowerCase();
    for (let k = 0; k < n.length; k++) {
      starts.push(offset);
      ends.push(offset + ch.length);
    }
    norm += n;
    offset += ch.length;
  }
  return { raw, norm, starts, ends };
}

/** Raw (verbatim) substring covering normalized offsets [start, end). */
export function rawSlice(mt: MappedText, start: number, end: number): string {
  if (end <= start || start < 0 || end > mt.norm.length) return '';
  return mt.raw.slice(mt.starts[start], mt.ends[end - 1]);
}

export interface TextHit {
  /** normalized offsets */
  start: number;
  end: number;
  /** normalized matched text */
  text: string;
  /** verbatim raw substring */
  quote: string;
  /** normalized capture groups (index 0 = whole match) */
  groups: (string | undefined)[];
  /** normalized offsets of capture groups */
  groupRanges: ([number, number] | undefined)[];
}

const globalCache = new WeakMap<RegExp, RegExp>();

function globalVersion(re: RegExp): RegExp {
  let g = globalCache.get(re);
  if (!g) {
    let flags = re.flags;
    if (!flags.includes('g')) flags += 'g';
    if (!flags.includes('d')) flags += 'd';
    g = new RegExp(re.source, flags);
    globalCache.set(re, g);
  }
  return g;
}

/** All non-empty matches of `re` against the normalized text (patterns must be written for normalized text). */
export function findMatches(mt: MappedText, re: RegExp): TextHit[] {
  const g = globalVersion(re);
  g.lastIndex = 0;
  const out: TextHit[] = [];
  let m: RegExpExecArray | null;
  while ((m = g.exec(mt.norm)) !== null) {
    if (m[0].length === 0) {
      g.lastIndex++;
      continue;
    }
    const start = m.index;
    const end = start + m[0].length;
    const indices = m.indices;
    out.push({
      start,
      end,
      text: m[0],
      quote: rawSlice(mt, start, end),
      groups: [...m],
      groupRanges: indices ? [...indices].map((r) => (r ? ([r[0], r[1]] as [number, number]) : undefined)) : [],
    });
  }
  return out;
}

export function findFirst(mt: MappedText, re: RegExp): TextHit | null {
  return findMatches(mt, re)[0] ?? null;
}

/** Verbatim quote of capture group `i` of a hit (empty string when the group did not participate). */
export function groupQuote(mt: MappedText, hit: TextHit, i: number): string {
  const r = hit.groupRanges[i];
  return r ? rawSlice(mt, r[0], r[1]) : '';
}

const CLAUSE_BREAK = /[,。!?;\n、]/;

/** Normalized clause (between punctuation) containing position `pos`. */
export function clauseAt(mt: MappedText, pos: number): { start: number; end: number; text: string } {
  let s = pos;
  while (s > 0 && !CLAUSE_BREAK.test(mt.norm[s - 1])) s--;
  let e = pos;
  while (e < mt.norm.length && !CLAUSE_BREAK.test(mt.norm[e])) e++;
  // a question mark / 吗 closing the clause belongs to it
  let tail = e;
  if (tail < mt.norm.length && /[?]/.test(mt.norm[tail])) tail++;
  return { start: s, end: tail, text: mt.norm.slice(s, tail) };
}

const NEGATOR_RE = /(不需要|不需|不用|不要|不想|不打算|不考虑|无需|不必|不去|不|没有|没)(办|做|走|用|搞|去)?$/;

/**
 * True when the keyword starting at normalized offset `start` is directly negated
 * ('不需要贷款', '不置换', '没有旧车'). Handles A-不-A questions ('要不要贷款', '需不需要置换', '贷不贷款')
 * and treats '没/没有' inside a question ('没有优惠吗') as NOT negated.
 */
export function isNegatedAt(mt: MappedText, start: number): boolean {
  return negationStart(mt, start) !== null;
}

/** Normalized offset where the negator governing the keyword at `start` begins, or null when not negated. */
export function negationStart(mt: MappedText, start: number): number | null {
  const windowStart = Math.max(0, start - 6);
  const before = mt.norm.slice(windowStart, start);
  const m = NEGATOR_RE.exec(before);
  if (!m) return null;
  const negator = m[1];
  const idx = m.index;
  const prevChar = idx > 0 ? before[idx - 1] : '';
  if (negator.startsWith('不')) {
    const afterBu = negator.length > 1 ? negator[1] : (m[2]?.[0] ?? mt.norm[start]);
    if (prevChar && prevChar === afterBu) return null; // A不A question form
  }
  if (negator.startsWith('没')) {
    const clause = clauseAt(mt, start).text;
    if (/[吗么呢?]/.test(clause)) return null;
  }
  return windowStart + idx;
}

// ─────────────────────────────────────────────────────────────────────────────
// Alias compilation & scanning
// ─────────────────────────────────────────────────────────────────────────────

export interface AliasSpec {
  alias: string;
  /** regex source; alias rejected when immediately followed by it */
  notFollowedBy?: string;
  /** regex source; alias rejected when immediately preceded by it */
  notPrecededBy?: string;
  /** alias only resolves when the named brand context is present */
  needsBrandContext?: string;
}
export type AliasInput = string | AliasSpec;

interface CompiledAlias<T> {
  target: T;
  alias: string;
  re: RegExp;
  needsBrandContext?: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function normalizeAlias(alias: string): string {
  return alias.normalize('NFKC').toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
}

function compileAlias(input: AliasInput): { re: RegExp; alias: string; needsBrandContext?: string } {
  const spec: AliasSpec = typeof input === 'string' ? { alias: input } : input;
  const a = normalizeAlias(spec.alias);
  let src = a.split(' ').map(escapeRe).join('[ \\t_-]*');
  if (/^[a-z0-9]/.test(a)) src = `(?<![a-z0-9])${src}`;
  if (/[a-z0-9]$/.test(a)) src = `${src}(?![a-z0-9])`;
  if (spec.notPrecededBy) src = `(?<!${spec.notPrecededBy})${src}`;
  if (spec.notFollowedBy) src = `${src}(?!${spec.notFollowedBy})`;
  return { re: new RegExp(src, 'g'), alias: a, needsBrandContext: spec.needsBrandContext };
}

function compileAliases<T>(target: T, aliases: readonly AliasInput[]): CompiledAlias<T>[] {
  return aliases.map((a) => ({ target, ...compileAlias(a) }));
}

interface AliasHit<T> {
  target: T;
  start: number;
  end: number;
  quote: string;
}

function scanAliases<T>(
  mt: MappedText,
  entries: readonly CompiledAlias<T>[],
  accept?: (entry: CompiledAlias<T>) => boolean,
): AliasHit<T>[] {
  const cands: { entry: CompiledAlias<T>; start: number; end: number }[] = [];
  for (const entry of entries) {
    if (accept && !accept(entry)) continue;
    entry.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = entry.re.exec(mt.norm)) !== null) {
      if (m[0].length === 0) {
        entry.re.lastIndex++;
        continue;
      }
      cands.push({ entry, start: m.index, end: m.index + m[0].length });
    }
  }
  cands.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const taken: typeof cands = [];
  for (const c of cands) {
    if (!taken.some((t) => c.start < t.end && t.start < c.end)) taken.push(c);
  }
  taken.sort((a, b) => a.start - b.start);
  return taken.map((t) => ({ target: t.entry.target, start: t.start, end: t.end, quote: rawSlice(mt, t.start, t.end) }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Brands, models, trims
// ─────────────────────────────────────────────────────────────────────────────

export interface BrandInfo {
  brand: string;
  brand_zh: string;
  aliases: readonly AliasInput[];
}

export const BRANDS: readonly BrandInfo[] = [
  { brand: 'BMW', brand_zh: '宝马', aliases: ['宝马', '寶馬', 'bmw', '别摸我'] },
  { brand: 'Tesla', brand_zh: '特斯拉', aliases: ['特斯拉', 'tesla'] },
  { brand: 'BYD', brand_zh: '比亚迪', aliases: ['比亚迪', 'byd'] },
  { brand: 'Xiaomi', brand_zh: '小米', aliases: ['小米汽车'] },
  { brand: 'NIO', brand_zh: '蔚来', aliases: ['蔚来', 'nio'] },
  {
    brand: 'Mercedes-Benz',
    brand_zh: '奔驰',
    aliases: ['梅赛德斯-奔驰', '梅赛德斯', '奔驰', '大奔', 'mercedes-benz', 'mercedes', 'benz'],
  },
  { brand: 'Audi', brand_zh: '奥迪', aliases: ['奥迪', 'audi'] },
  { brand: 'Volvo', brand_zh: '沃尔沃', aliases: ['沃尔沃', 'volvo'] },
  { brand: 'Lexus', brand_zh: '雷克萨斯', aliases: ['雷克萨斯', '凌志', 'lexus'] },
  { brand: 'Li Auto', brand_zh: '理想', aliases: ['理想汽车'] },
  // Other mainstream brands without catalog models: recognizing them keeps a comment about a different brand
  // from inheriting the post's model ('北京现代i30多少钱' under a BMW i3 post). Ambiguous common words
  // ('大众', '吉利', '长城', '红旗') are only matched in unambiguous compound forms.
  { brand: 'Hyundai', brand_zh: '现代', aliases: ['北京现代', '现代汽车', 'hyundai'] },
  { brand: 'Volkswagen', brand_zh: '大众', aliases: ['上汽大众', '一汽大众', '上海大众', '大众汽车', 'volkswagen'] },
  { brand: 'Toyota', brand_zh: '丰田', aliases: ['广汽丰田', '一汽丰田', '丰田', 'toyota'] },
  { brand: 'Honda', brand_zh: '本田', aliases: ['广汽本田', '东风本田', '本田', 'honda'] },
  { brand: 'Nissan', brand_zh: '日产', aliases: ['东风日产', { alias: '日产', notFollowedBy: '量|能|值' }, 'nissan'] },
  { brand: 'Buick', brand_zh: '别克', aliases: ['别克', 'buick'] },
  { brand: 'Porsche', brand_zh: '保时捷', aliases: ['保时捷', 'porsche'] },
  { brand: 'Land Rover', brand_zh: '路虎', aliases: ['路虎', 'land rover'] },
  { brand: 'Cadillac', brand_zh: '凯迪拉克', aliases: ['凯迪拉克', 'cadillac'] },
  { brand: 'Geely', brand_zh: '吉利', aliases: ['吉利汽车', 'geely'] },
  { brand: 'AITO', brand_zh: '问界', aliases: ['问界', 'aito'] },
  { brand: 'XPeng', brand_zh: '小鹏', aliases: ['小鹏汽车', '小鹏', 'xpeng'] },
  { brand: 'Zeekr', brand_zh: '极氪', aliases: ['极氪', 'zeekr'] },
  { brand: 'Lynk & Co', brand_zh: '领克', aliases: ['领克', 'lynk'] },
];

export type Powertrain = 'EV' | 'ICE' | 'PHEV' | 'EREV';
export type BodyType = 'sedan' | 'suv';

export interface ModelInfo {
  brand: string;
  model: string;
  model_zh: string;
  body: BodyType;
  powertrain: Powertrain;
  aliases: readonly AliasInput[];
}

const TESLA = 'Tesla';
/** 'M3' / 'MY' directly after 宝马/BMW are BMW performance models, never Tesla slang. */
const BMW_PREFIX = '宝马 ?|寶馬 ?|bmw ?';

export const MODELS: readonly ModelInfo[] = [
  // BMW — dealer brand
  { brand: 'BMW', model: 'i3', model_zh: 'i3', body: 'sedan', powertrain: 'EV', aliases: ['宝马i3', 'bmw i3', '新i3', 'i3'] },
  { brand: 'BMW', model: 'i4', model_zh: 'i4', body: 'sedan', powertrain: 'EV', aliases: ['宝马i4', 'bmw i4', 'i4'] },
  { brand: 'BMW', model: 'iX3', model_zh: 'iX3', body: 'suv', powertrain: 'EV', aliases: ['宝马ix3', 'bmw ix3', '新ix3', 'ix3'] },
  { brand: 'BMW', model: 'X1', model_zh: 'X1', body: 'suv', powertrain: 'ICE', aliases: ['宝马x1', 'bmw x1', '新x1', 'x1'] },
  { brand: 'BMW', model: 'X3', model_zh: 'X3', body: 'suv', powertrain: 'ICE', aliases: ['宝马x3', 'bmw x3', '新x3', 'x3'] },
  { brand: 'BMW', model: 'X5', model_zh: 'X5', body: 'suv', powertrain: 'ICE', aliases: ['宝马x5', 'bmw x5', '新x5', 'x5l', 'x5'] },
  {
    brand: 'BMW',
    model: '3 Series',
    model_zh: '3系',
    body: 'sedan',
    powertrain: 'ICE',
    aliases: ['宝马3系', 'bmw 3系', '新3系', '3系', '三系', '3 series', '320li', '325li', '330li', '325i'],
  },
  {
    brand: 'BMW',
    model: '5 Series',
    model_zh: '5系',
    body: 'sedan',
    powertrain: 'ICE',
    aliases: ['宝马5系', 'bmw 5系', '新5系', '5系', '五系', '5 series', '525li', '530li', '535li'],
  },
  // Tesla
  {
    brand: TESLA,
    model: 'Model 3',
    model_zh: 'Model 3',
    body: 'sedan',
    powertrain: 'EV',
    aliases: [
      '特斯拉model 3',
      'tesla model 3',
      'model 3',
      '毛豆3',
      { alias: 'm3', needsBrandContext: TESLA, notPrecededBy: BMW_PREFIX },
    ],
  },
  {
    brand: TESLA,
    model: 'Model Y',
    model_zh: 'Model Y',
    body: 'suv',
    powertrain: 'EV',
    aliases: [
      '特斯拉model y',
      'tesla model y',
      'model y',
      '毛豆y',
      { alias: 'my', needsBrandContext: TESLA, notPrecededBy: BMW_PREFIX },
    ],
  },
  // BYD
  {
    brand: 'BYD',
    model: 'Han',
    model_zh: '汉',
    body: 'sedan',
    powertrain: 'EV',
    aliases: [
      '比亚迪汉',
      { alias: '汉ev', notPrecededBy: '武' },
      { alias: '汉 dm i', notPrecededBy: '武' },
      { alias: '汉dm', notPrecededBy: '武' },
      { alias: '汉l', notPrecededBy: '武' },
    ],
  },
  // Xiaomi
  { brand: 'Xiaomi', model: 'SU7', model_zh: 'SU7', body: 'sedan', powertrain: 'EV', aliases: ['小米su7', 'su7'] },
  { brand: 'Xiaomi', model: 'YU7', model_zh: 'YU7', body: 'suv', powertrain: 'EV', aliases: ['小米yu7', 'yu7'] },
  // NIO
  { brand: 'NIO', model: 'ET5', model_zh: 'ET5', body: 'sedan', powertrain: 'EV', aliases: ['蔚来et5', 'et5t', 'et5'] },
  { brand: 'NIO', model: 'ES6', model_zh: 'ES6', body: 'suv', powertrain: 'EV', aliases: ['蔚来es6', 'es6'] },
  // Mercedes-Benz
  {
    brand: 'Mercedes-Benz',
    model: 'C-Class',
    model_zh: 'C级',
    body: 'sedan',
    powertrain: 'ICE',
    aliases: ['奔驰c级', { alias: 'c级', notFollowedBy: '车' }, '奔驰c', 'c200l', 'c260l', 'c260', 'c300l'],
  },
  {
    brand: 'Mercedes-Benz',
    model: 'E-Class',
    model_zh: 'E级',
    body: 'sedan',
    powertrain: 'ICE',
    aliases: ['奔驰e级', { alias: 'e级', notFollowedBy: '车' }, '奔驰e', 'e260l', 'e300l'],
  },
  {
    brand: 'Mercedes-Benz',
    model: 'GLA',
    model_zh: 'GLA',
    body: 'suv',
    powertrain: 'ICE',
    aliases: ['奔驰gla', 'gla200', 'gla220', 'gla'],
  },
  {
    brand: 'Mercedes-Benz',
    model: 'GLC',
    model_zh: 'GLC',
    body: 'suv',
    powertrain: 'ICE',
    aliases: ['奔驰glc', 'glc260l', 'glc300l', 'glc260', 'glc300', 'glc'],
  },
  {
    brand: 'Mercedes-Benz',
    model: 'GLE',
    model_zh: 'GLE',
    body: 'suv',
    powertrain: 'ICE',
    aliases: ['奔驰gle', 'gle350', 'gle450', 'gle'],
  },
  // Audi
  { brand: 'Audi', model: 'A4L', model_zh: 'A4L', body: 'sedan', powertrain: 'ICE', aliases: ['奥迪a4l', '奥迪a4', 'a4l'] },
  { brand: 'Audi', model: 'A6L', model_zh: 'A6L', body: 'sedan', powertrain: 'ICE', aliases: ['奥迪a6l', '奥迪a6', 'a6l'] },
  { brand: 'Audi', model: 'Q3', model_zh: 'Q3', body: 'suv', powertrain: 'ICE', aliases: ['奥迪q3', 'q3'] },
  { brand: 'Audi', model: 'Q5L', model_zh: 'Q5L', body: 'suv', powertrain: 'ICE', aliases: ['奥迪q5l', '奥迪q5', 'q5l', 'q5'] },
  { brand: 'Audi', model: 'Q7', model_zh: 'Q7', body: 'suv', powertrain: 'ICE', aliases: ['奥迪q7', 'q7'] },
  // Volvo
  { brand: 'Volvo', model: 'XC60', model_zh: 'XC60', body: 'suv', powertrain: 'ICE', aliases: ['沃尔沃xc60', 'xc60'] },
  { brand: 'Volvo', model: 'XC90', model_zh: 'XC90', body: 'suv', powertrain: 'ICE', aliases: ['沃尔沃xc90', 'xc90'] },
  // Lexus
  {
    brand: 'Lexus',
    model: 'NX',
    model_zh: 'NX',
    body: 'suv',
    powertrain: 'PHEV',
    aliases: ['雷克萨斯nx', 'nx260', 'nx350h', 'nx400h', 'nx'],
  },
  {
    brand: 'Lexus',
    model: 'RX',
    model_zh: 'RX',
    body: 'suv',
    powertrain: 'PHEV',
    aliases: ['雷克萨斯rx', 'rx300', 'rx350h', 'rx500h'],
  },
  // Li Auto
  { brand: 'Li Auto', model: 'L6', model_zh: 'L6', body: 'suv', powertrain: 'EREV', aliases: ['理想l6'] },
  { brand: 'Li Auto', model: 'L9', model_zh: 'L9', body: 'suv', powertrain: 'EREV', aliases: ['理想l9'] },
];

export interface TrimInfo {
  model: string;
  trim: string;
  aliases: readonly string[];
}

export const TRIMS: readonly TrimInfo[] = [
  { model: 'i3', trim: 'eDrive35L', aliases: ['edrive 35l', 'i3 35l', '35l'] },
  { model: 'i3', trim: 'eDrive40L', aliases: ['edrive 40l', 'i3 40l', '40l'] },
  { model: 'X3', trim: 'xDrive25L', aliases: ['xdrive 25l', 'x3 25l', '25l'] },
  { model: 'X3', trim: 'xDrive30L', aliases: ['xdrive 30l', 'x3 30l', '30l'] },
  { model: '3 Series', trim: '325Li', aliases: ['325li'] },
  { model: '3 Series', trim: '330Li', aliases: ['330li'] },
];

/** Undirected competitive relationships; `competitorsOf` uses the symmetric closure. */
const COMPETITOR_EDGES: readonly [string, readonly string[]][] = [
  ['i3', ['Model 3', 'SU7', 'Han', 'ET5']],
  ['i4', ['Model 3', 'SU7', 'ET5']],
  ['iX3', ['Model Y', 'YU7', 'ES6']],
  ['X1', ['Q3', 'GLA']],
  ['X3', ['GLC', 'Q5L', 'XC60', 'NX', 'L6']],
  ['X5', ['GLE', 'Q7', 'XC90', 'RX', 'L9']],
  ['3 Series', ['C-Class', 'A4L', 'Model 3']],
  ['5 Series', ['E-Class', 'A6L']],
  ['Model 3', ['SU7', 'Han', 'ET5']],
  ['Model Y', ['YU7', 'ES6']],
];

const modelKey = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, '');

const BRAND_BY_KEY = new Map<string, BrandInfo>();
for (const b of BRANDS) {
  BRAND_BY_KEY.set(modelKey(b.brand), b);
  BRAND_BY_KEY.set(modelKey(b.brand_zh), b);
}
const MODEL_BY_KEY = new Map<string, ModelInfo>(MODELS.map((m) => [modelKey(m.model), m]));

const COMPETITORS = new Map<string, Set<string>>();
for (const [a, list] of COMPETITOR_EDGES) {
  for (const b of list) {
    if (!COMPETITORS.has(a)) COMPETITORS.set(a, new Set());
    if (!COMPETITORS.has(b)) COMPETITORS.set(b, new Set());
    COMPETITORS.get(a)!.add(b);
    COMPETITORS.get(b)!.add(a);
  }
}

const BRAND_ENTRIES = BRANDS.flatMap((b) => compileAliases(b, b.aliases));
const MODEL_ENTRIES = MODELS.flatMap((m) => compileAliases(m, m.aliases));
const TRIM_ENTRIES = TRIMS.flatMap((t) => compileAliases(t, t.aliases.length ? [...t.aliases, t.trim] : [t.trim]));
const TESLA_CONTEXT_RE = /特斯拉|tesla|毛豆|model/;

export function getBrandInfo(brand: string): BrandInfo | undefined {
  return BRAND_BY_KEY.get(modelKey(brand));
}

/** Canonical model info by canonical name (case/space-insensitive: 'model3' → Model 3). */
export function getModelInfo(model: string): ModelInfo | undefined {
  return MODEL_BY_KEY.get(modelKey(model));
}

/** Resolve a canonical model name from a canonical name or any alias ('宝马3系' → '3 Series'). */
export function resolveModelName(nameOrAlias: string): string | null {
  const direct = getModelInfo(nameOrAlias);
  if (direct) return direct.model;
  const hits = findModels(nameOrAlias, { context: TESLA });
  return hits.length === 1 ? hits[0].model : null;
}

export function findBrands(text: string): { brand: string; brand_zh: string; quote: string }[] {
  const mt = mapText(text);
  const seen = new Set<string>();
  const out: { brand: string; brand_zh: string; quote: string }[] = [];
  for (const hit of scanAliases(mt, BRAND_ENTRIES)) {
    if (seen.has(hit.target.brand)) continue;
    seen.add(hit.target.brand);
    out.push({ brand: hit.target.brand, brand_zh: hit.target.brand_zh, quote: hit.quote });
  }
  return out;
}

export interface ExtraModel {
  brand: string;
  model: string;
  aliases?: readonly string[];
}

export interface FindModelsOptions {
  /** extra text (e.g. post title) that provides brand context for ambiguous aliases such as 'M3' */
  context?: string | null;
  /** additional catalog models (e.g. a dealer's vehicles not in the lexicon) */
  extra?: readonly ExtraModel[];
}

/** Models mentioned in `text`, in order of first appearance, unique by model. */
export function findModels(
  text: string,
  opts: FindModelsOptions = {},
): { brand: string; model: string; quote: string; start: number; end: number }[] {
  const mt = mapText(text);
  const ctxNorm = `${mt.norm}\n${(opts.context ?? '').normalize('NFKC').toLowerCase()}`;
  const hasTesla = TESLA_CONTEXT_RE.test(ctxNorm);
  let entries: readonly CompiledAlias<{ brand: string; model: string }>[] = MODEL_ENTRIES;
  if (opts.extra && opts.extra.length > 0) {
    const extra = opts.extra
      .filter((x) => !getModelInfo(x.model))
      .flatMap((x) => compileAliases({ brand: x.brand, model: x.model }, [x.model, ...(x.aliases ?? [])]));
    entries = [...MODEL_ENTRIES, ...extra];
  }
  const seen = new Set<string>();
  const out: { brand: string; model: string; quote: string; start: number; end: number }[] = [];
  for (const hit of scanAliases(mt, entries, (e) => !e.needsBrandContext || (e.needsBrandContext === TESLA && hasTesla))) {
    if (seen.has(hit.target.model)) continue;
    seen.add(hit.target.model);
    out.push({ brand: hit.target.brand, model: hit.target.model, quote: hit.quote, start: hit.start, end: hit.end });
  }
  return out;
}

/**
 * Trims mentioned in `text`. When `model` is given only that model's trims are considered.
 * `extra` adds catalog trims (e.g. DealerProfile.trims with Dealer-Brain aliases).
 */
export function findTrims(
  text: string,
  model?: string,
  extra?: readonly TrimInfo[],
): { model: string; trim: string; quote: string }[] {
  const mt = mapText(text);
  let entries: readonly CompiledAlias<TrimInfo>[] = TRIM_ENTRIES;
  if (extra && extra.length > 0) {
    // Dealer-Brain trims: canonical lexicon trim wins as the target so names stay consistent;
    // duplicate aliases resolve to the same span and are collapsed by the overlap pass.
    const additional = extra.flatMap((t) => {
      const lex = TRIMS.find((x) => modelKey(x.model) === modelKey(t.model) && modelKey(x.trim) === modelKey(t.trim));
      const aliases = [t.trim, ...t.aliases].filter((a) => normalizeAlias(a).length >= 2);
      return compileAliases<TrimInfo>(lex ?? { model: t.model, trim: t.trim, aliases: t.aliases }, aliases);
    });
    entries = [...TRIM_ENTRIES, ...additional];
  }
  const wanted = model ? modelKey(model) : null;
  const seen = new Set<string>();
  const out: { model: string; trim: string; quote: string }[] = [];
  for (const hit of scanAliases(mt, entries, (e) => wanted === null || modelKey(e.target.model) === wanted)) {
    const key = `${hit.target.model}|${hit.target.trim}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ model: hit.target.model, trim: hit.target.trim, quote: hit.quote });
  }
  return out;
}

export function competitorsOf(brand: string, model: string): { brand: string; model: string; model_zh: string }[] {
  const info = getModelInfo(model);
  if (!info) return [];
  const brandInfo = getBrandInfo(brand);
  if (brand && brandInfo && brandInfo.brand !== info.brand) return [];
  return [...(COMPETITORS.get(info.model) ?? [])]
    .map((m) => getModelInfo(m))
    .filter((m): m is ModelInfo => m !== undefined)
    .map((m) => ({ brand: m.brand, model: m.model, model_zh: m.model_zh }));
}

/** 'BMW i3' (en) / '宝马i3', '宝马3系', '特斯拉Model 3' (zh, default). Unknown names fall back gracefully. */
export function modelDisplayName(brand: string, model: string, lang: 'zh' | 'en' = 'zh'): string {
  const info = getModelInfo(model);
  const brandInfo = getBrandInfo(brand) ?? (info ? getBrandInfo(info.brand) : undefined);
  if (lang === 'en') {
    const b = brandInfo?.brand ?? brand;
    const m = info?.model ?? model;
    return [b, m].filter(Boolean).join(' ');
  }
  const bz = brandInfo?.brand_zh ?? brand;
  const mz = info?.model_zh ?? model;
  if (!bz) return mz;
  if (!mz) return bz;
  return `${bz}${mz}`;
}

/** Short Chinese label for UI evidence: 'Model 3', '3系', 'C级', '比亚迪汉' (single-char names get the brand). */
export function modelShortLabel(model: string): string {
  const info = getModelInfo(model);
  if (!info) return model;
  return [...info.model_zh].length < 2 ? modelDisplayName(info.brand, info.model, 'zh') : info.model_zh;
}

// ─────────────────────────────────────────────────────────────────────────────
// Locations
// ─────────────────────────────────────────────────────────────────────────────

/** All 34 provincial-level divisions (short names). */
export const PROVINCES: readonly string[] = [
  '北京', '天津', '上海', '重庆', '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北',
  '湖南', '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃', '青海', '台湾', '内蒙古', '广西', '西藏', '宁夏', '新疆', '香港', '澳门',
];

export const CITY_PROVINCE: Record<string, string> = {
  杭州: '浙江', 宁波: '浙江', 温州: '浙江', 绍兴: '浙江', 嘉兴: '浙江', 湖州: '浙江', 金华: '浙江', 台州: '浙江', 衢州: '浙江', 丽水: '浙江',
  舟山: '浙江', 义乌: '浙江',
  上海: '上海', 北京: '北京', 天津: '天津', 重庆: '重庆', 香港: '香港', 澳门: '澳门',
  深圳: '广东', 广州: '广东', 东莞: '广东', 佛山: '广东', 珠海: '广东', 惠州: '广东', 中山: '广东',
  苏州: '江苏', 南京: '江苏', 无锡: '江苏', 常州: '江苏', 南通: '江苏', 徐州: '江苏', 扬州: '江苏', 泰州: '江苏', 昆山: '江苏',
  成都: '四川', 武汉: '湖北', 西安: '陕西', 长沙: '湖南', 合肥: '安徽', 郑州: '河南', 济南: '山东', 青岛: '山东', 烟台: '山东',
  厦门: '福建', 福州: '福建', 泉州: '福建', 石家庄: '河北', 太原: '山西', 沈阳: '辽宁', 大连: '辽宁', 长春: '吉林', 哈尔滨: '黑龙江',
  南昌: '江西', 南宁: '广西', 海口: '海南', 三亚: '海南', 贵阳: '贵州', 昆明: '云南', 兰州: '甘肃', 西宁: '青海', 银川: '宁夏',
  乌鲁木齐: '新疆', 呼和浩特: '内蒙古', 拉萨: '西藏',
};

/** Colloquial city names. ('杭' alone is too ambiguous — only '杭城'.) */
export const CITY_ALIASES: Record<string, string> = {
  魔都: '上海', 沪上: '上海', 帝都: '北京', 杭城: '杭州', 甬城: '宁波', 蓉城: '成都', 鹏城: '深圳', 羊城: '广州', 鹭岛: '厦门',
  榕城: '福州', 金陵: '南京', 姑苏: '苏州', 星城: '长沙', 泉城: '济南', 岛城: '青岛', 津门: '天津', 山城: '重庆', 冰城: '哈尔滨',
  春城: '昆明',
};

const PROVINCE_FULL_NAMES: Record<string, string> = {
  内蒙古自治区: '内蒙古', 广西壮族自治区: '广西', 西藏自治区: '西藏', 宁夏回族自治区: '宁夏', 新疆维吾尔自治区: '新疆',
  香港特别行政区: '香港', 澳门特别行政区: '澳门',
};

const PROVINCE_SET = new Set(PROVINCES);

/**
 * Street / proper-noun uses of place names that are not a stated location, including joint-venture car brand
 * names ('北京现代', '上海大众', '北京越野').
 */
const PLACE_NOT_FOLLOWED =
  '[东西南北中]?路(?!况|上|过|边|途|费|线)|大道|大街|大学|公园|时间|拉面|火腿|烤鸭|装|现代|大众|通用|越野|吉普';
const PLACE_GUARDS: Record<string, { notPrecededBy?: string }> = {
  海口: { notPrecededBy: '入' },
  湖北: { notPrecededBy: '西' },
  山东: { notPrecededBy: '中' },
  海南: { notPrecededBy: '上' },
};

interface PlaceTarget {
  city?: string;
  province: string;
}

function placeAliases(names: string[]): AliasSpec[] {
  return names.map((alias) => {
    const short = alias.replace(/(省|市)$/, '');
    return { alias, notFollowedBy: PLACE_NOT_FOLLOWED, notPrecededBy: PLACE_GUARDS[short]?.notPrecededBy };
  });
}

const LOCATION_ENTRIES: CompiledAlias<PlaceTarget>[] = [
  ...Object.entries(CITY_PROVINCE).flatMap(([city, province]) =>
    compileAliases<PlaceTarget>({ city, province }, placeAliases([`${city}市`, city])),
  ),
  ...Object.entries(CITY_ALIASES).flatMap(([alias, city]) =>
    compileAliases<PlaceTarget>({ city, province: CITY_PROVINCE[city] }, placeAliases([alias])),
  ),
  ...PROVINCES.filter((p) => !(p in CITY_PROVINCE)).flatMap((province) =>
    compileAliases<PlaceTarget>({ province }, placeAliases([`${province}省`, province])),
  ),
  ...Object.entries(PROVINCE_FULL_NAMES).map(([full, province]) => ({
    target: { province } as PlaceTarget,
    ...compileAlias(full),
  })),
];

export interface LocationMention {
  city?: string;
  province?: string;
  quote: string;
  start: number;
  end: number;
}

/** Location mentions (normalized offsets) in order of appearance. */
export function findLocationsMapped(mt: MappedText): LocationMention[] {
  return scanAliases(mt, LOCATION_ENTRIES).map((h) => ({
    ...(h.target.city ? { city: h.target.city } : {}),
    province: h.target.province,
    quote: h.quote,
    start: h.start,
    end: h.end,
  }));
}

/** First stated city (with its province); else first stated province. */
export function findLocation(text: string): { city?: string; province?: string; quote: string } | null {
  const all = findLocationsMapped(mapText(text));
  const pick = all.find((l) => l.city) ?? all[0];
  if (!pick) return null;
  return { ...(pick.city ? { city: pick.city } : {}), ...(pick.province ? { province: pick.province } : {}), quote: pick.quote };
}

/** 'IP属地：浙江' | '浙江' | '浙江省' | '广西壮族自治区' → province short name; unknown / foreign → null. */
export function provinceOfIp(ipLocation: string | null | undefined): string | null {
  if (!ipLocation) return null;
  const s = ipLocation
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/^(ip)?(归属地|属地)?[:]?/i, '');
  if (!s) return null;
  if (PROVINCE_FULL_NAMES[s]) return PROVINCE_FULL_NAMES[s];
  const short = s.replace(/(特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|省|市)$/, '');
  if (PROVINCE_SET.has(short)) return short;
  if (CITY_PROVINCE[short]) return CITY_PROVINCE[short];
  return findLocation(s)?.province ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Numbers, budget, purchase timeframe
// ─────────────────────────────────────────────────────────────────────────────

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

/** '25' | '25.5' | '二十五' | '十五' | '一百零五' | '二五' → number; otherwise null. */
export function parseChineseNumber(input: string): number | null {
  const s = input.normalize('NFKC').trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  if (!/^[零〇一二两三四五六七八九十百千]+$/.test(s)) return null;
  if (![...s].some((c) => c in CN_UNIT)) {
    return Number([...s].map((c) => CN_DIGIT[c]).join(''));
  }
  let total = 0;
  let digit: number | null = null;
  for (const c of s) {
    if (c in CN_DIGIT) digit = CN_DIGIT[c];
    else {
      total += (digit ?? 1) * CN_UNIT[c];
      digit = null;
    }
  }
  return total + (digit ?? 0);
}

export interface BudgetMention {
  budget_min?: number;
  budget_max?: number;
  quote: string;
  start: number;
  end: number;
}

const CN_NUM_SRC = '[零〇一二两三四五六七八九十百]+';
const NUM_SRC = `(?:\\d+(?:\\.\\d+)?|${CN_NUM_SRC})`;
const BUDGET_RANGE_RE = new RegExp(
  `(?<![\\d.几数上好])(${NUM_SRC}) *(?:万|w)? *(?:-|~|到|至) *(${NUM_SRC}) *(?:个)?(?:万|w)(?![a-z])(?:元|块)?(左右|以内|以下|之内|上下)?`,
);
const BUDGET_SINGLE_RE = new RegExp(
  `(?<![\\d.几数上好])(${NUM_SRC}) *(多|来)? *(?:个)?(?:万|w)(?![a-z])(?:元|块)?(左右|以内|以下|之内|以上|上下|出头|内)?`,
);
const BUDGET_BARE_RE = /预算(?:在|是|大概|大约|差不多|控制在|:)? *(\d{1,3}(?:\.\d+)?)(?![\d.]|万|w)(左右|以内|以下|之内|以上|上下)?/;
const BUDGET_KEYWORD_BEFORE_RE = /预算|budget|价位/;
const BUDGET_EXCLUDE_BEFORE_RE =
  /(优惠|便宜|降价|降了|降|让利|补贴|首付|月供|贷款|贷|差价|少了|多了|贵了|贵|指导价|官方价|裸车价|裸车|报价|售价|价格|卖|花了|送|返|现金|落地价|落地|要|里程|公里|跑了|开了|保险|购置税|定金|订金|尾款|赔|亏) *:? *$/;
const BUDGET_EXCLUDE_AFTER_RE = /^ *(能落地|落地|的优惠|优惠|补贴|首付|月供|公里|km|定金|订金|尾款|的首付)/;
const MIN_BUDGET = 30_000;
const MAX_BUDGET = 5_000_000;

const wan = (n: number) => Math.round(n * 10_000);
const roundK = (n: number) => Math.round(n / 1000) * 1000;

function budgetFromQualifier(value: number, approx: string | undefined, qualifier: string | undefined): {
  budget_min?: number;
  budget_max?: number;
} {
  const base = wan(value);
  if (approx === '多' || approx === '来' || qualifier === '出头') {
    const step = qualifier === '出头' ? Math.max(1, value * 0.2) : value >= 10 ? 10 : 1;
    return { budget_min: base, budget_max: wan(value + step) };
  }
  switch (qualifier) {
    case '以内':
    case '以下':
    case '之内':
    case '内':
      return { budget_max: base };
    case '以上':
      return { budget_min: base };
    case '左右':
    case '上下':
      return { budget_min: roundK(base * 0.9), budget_max: roundK(base * 1.1) };
    default:
      return { budget_min: base, budget_max: base };
  }
}

function budgetInRange(b: { budget_min?: number; budget_max?: number }): boolean {
  const vals = [b.budget_min, b.budget_max].filter((x): x is number => x !== undefined);
  return vals.length > 0 && vals.every((x) => x >= MIN_BUDGET && x <= MAX_BUDGET);
}

function budgetContextOk(mt: MappedText, start: number, end: number): boolean {
  const before = mt.norm.slice(Math.max(0, start - 10), start);
  if (BUDGET_KEYWORD_BEFORE_RE.test(before) || /^ *(的)?预算/.test(mt.norm.slice(end, end + 4))) return true;
  if (BUDGET_EXCLUDE_BEFORE_RE.test(mt.norm.slice(Math.max(0, start - 5), start))) return false;
  if (BUDGET_EXCLUDE_AFTER_RE.test(mt.norm.slice(end, end + 5))) return false;
  return true;
}

/** Purchase budget stated in the text (first valid mention), in CNY. Prices, discounts and down payments are excluded. */
export function parseBudgetMapped(mt: MappedText): BudgetMention | null {
  const cands: BudgetMention[] = [];
  for (const h of findMatches(mt, BUDGET_RANGE_RE)) {
    const a = parseChineseNumber(h.groups[1] ?? '');
    const b = parseChineseNumber(h.groups[2] ?? '');
    if (a === null || b === null || !budgetContextOk(mt, h.start, h.end)) continue;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const budget = { budget_min: wan(lo), budget_max: wan(hi) };
    if (budgetInRange(budget)) cands.push({ ...budget, quote: h.quote, start: h.start, end: h.end });
  }
  for (const h of findMatches(mt, BUDGET_SINGLE_RE)) {
    if (cands.some((c) => h.start < c.end && c.start < h.end)) continue;
    const n = parseChineseNumber(h.groups[1] ?? '');
    if (n === null || !budgetContextOk(mt, h.start, h.end)) continue;
    const budget = budgetFromQualifier(n, h.groups[2], h.groups[3]);
    if (budgetInRange(budget)) cands.push({ ...budget, quote: h.quote, start: h.start, end: h.end });
  }
  for (const h of findMatches(mt, BUDGET_BARE_RE)) {
    if (cands.some((c) => h.start < c.end && c.start < h.end)) continue;
    const n = parseChineseNumber(h.groups[1] ?? '');
    if (n === null || n < 3 || n > 500) continue;
    const budget = budgetFromQualifier(n, undefined, h.groups[2]);
    if (budgetInRange(budget)) cands.push({ ...budget, quote: h.quote, start: h.start, end: h.end });
  }
  cands.sort((a, b) => a.start - b.start);
  return cands[0] ?? null;
}

export function parseBudget(text: string): BudgetMention | null {
  return parseBudgetMapped(mapText(text));
}

export const TIMEFRAMES = ['this_week', 'soon', 'this_month', 'within_3_months', 'later'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** Terms that only express purchase timing when followed by a purchase/visit verb ('最近想买' vs '最近优惠多少'). */
const SOFT_TIME_TERMS = new Set(['最近', '近期', '这段时间', '今天', '这两天', '这几天', '马上', '随时']);
const SOFT_TIME_VERB_RE = /^.{0,4}?(买|入手|提|订|下定|定车|看车|去|过去|到店|换车|购车|准备|打算|想|计划|要|考虑|试驾)/;

/** Past or recurring qualifiers: '上周六', '每周末', '上个月底' describe what happened, not when they will buy. */
const PAST_OR_RECURRING = '上个?|每个?';
/** A number before 年前/年内 makes it a duration ('三年前买的', '两年内不换'), not a purchase deadline. */
const YEAR_COUNT = '[\\d零〇一二两三四五六七八九十百几多半]|去|前|明|后|今';
const OTHER_YEAR = '去年|前年|明年|后年|每年';
const notPast = (alias: string): AliasSpec => ({ alias, notPrecededBy: PAST_OR_RECURRING });

const TIMEFRAME_TERMS: Record<Timeframe, readonly AliasInput[]> = {
  this_week: [
    // '一个周末' / '两个周末' are durations ('开了一个周末'), not this weekend; '这个周末' / '下个周末' are longer aliases
    '这周末', '这个周末', '本周末', { alias: '周末', notPrecededBy: `${PAST_OR_RECURRING}|个` }, '这周', '本周', '这个星期', '这星期', '今天', '明天', '后天', '今晚', '明晚',
    '这两天', '这几天', notPast('周六'), notPast('周日'), notPast('星期六'), notPast('星期天'),
  ],
  soon: [
    '下周末', '下个周末', '下周', '下个星期', '下星期', '最近', '近期', { alias: '马上', notPrecededBy: '宝' }, '尽快', '这段时间',
    '近两周', '两周内', '一两周', '随时',
  ],
  this_month: [
    '这个月底', '本月底', '这个月内', '一个月内', '1个月内', '本月', '这个月', '这月',
    { alias: '月底', notPrecededBy: `${PAST_OR_RECURRING}|个|${OTHER_YEAR}` },
    { alias: '月内', notPrecededBy: '个|上' },
  ],
  within_3_months: [
    '下个月', '下月', '三个月内', '3个月内', '两个月内', '2个月内',
    { alias: '年底前', notPrecededBy: OTHER_YEAR },
    { alias: '年底', notPrecededBy: OTHER_YEAR },
    '过年前',
    { alias: '年前', notPrecededBy: YEAR_COUNT },
    { alias: '年内', notPrecededBy: YEAR_COUNT },
  ],
  later: ['明年', '年后', '过段时间', '过一阵', '以后再', '再等等', '观望', '等等看', '不急', '半年内', '半年后'],
};

const TIMEFRAME_ENTRIES = TIMEFRAMES.flatMap((tf) =>
  TIMEFRAME_TERMS[tf].map((a) => ({ target: tf, ...compileAlias(a) })),
);

export interface TimeframeMention {
  timeframe: Timeframe;
  quote: string;
  start: number;
  end: number;
}

export interface TimeframeOptions {
  /**
   * Reference instant for calendar expressions ('9月底', '10月份', '明年3月', '国庆前'). Without it those expressions
   * cannot be placed relative to today and are ignored (never guessed); relative terms ('这周', '下个月') still resolve.
   */
  now?: Date;
  /** IANA timezone whose local calendar date `now` is read in (default Asia/Shanghai) */
  tz?: string;
}

type CalendarPart = 'whole' | 'early' | 'mid' | 'late';
type CalendarRelation = 'within' | 'before' | 'after';

/** A calendar-anchored purchase time ('9月底前', '明年3月', '国庆'), resolved against `now` only on demand. */
interface CalendarMention {
  start: number;
  end: number;
  quote: string;
  month: number;
  /** inclusive local day range inside the month; `null` end = last day of the month */
  days: readonly [number, number | null];
  relation: CalendarRelation;
  /** for relation 'before': the deadline is the START of the period ('10月前', '国庆前') instead of its end ('10月底前') */
  before_start: boolean;
  /** explicit year ('2027年'), 'next' ('明年'), 'this' ('今年') or null (nearest upcoming occurrence) */
  year: number | 'next' | 'this' | null;
}

const MONTH_NUM_SRC = '1[0-2]|0?[1-9]|十[一二]?|[一二三四五六七八九]';
const RELATION_SRC = '之前|以前|之后|以后|前(?!排|面|脸|期)|后(?!排|备|面|悔|续|期|座)';
/**
 * '9月底' · '10月份' · '十二月初' · '明年3月' · '2027年3月' · '10月前' · '9月底之前'.
 * Not calendar months: dates ('9月20号' — appointment NLU resolves those), durations ('3个月'), past or recurring
 * qualifiers ('去年12月', '上个月', '每月'), and words that merely contain 月 ('月供', '月租', '月薪', '五月天').
 */
const MONTH_MENTION_RE = new RegExp(
  `(?:(\\d{4})年|(明年|今年)|(?<![\\d.年/个每上去前十一二三四五六七八九两]))(${MONTH_NUM_SRC})月(份)?(初|上旬|中旬|中|下旬|底|末)?(${RELATION_SRC})?(?![\\d一二三四五六七八九十两]|号|日|薪|供|租|费|付|卡|票|饼|光|亮|球|季|度|天|经)`,
);
/** National Day golden week (Oct 1–7): '国庆前' · '国庆节期间' · '十一前' ('十一' alone is just a number). */
const HOLIDAY_RE = new RegExp(`(国庆节?|十一(?=之前|以前|前|假期|长假|期间|黄金周))(${RELATION_SRC}|假期|长假|期间|黄金周|的时候)?`);

const PART_DAYS: Record<CalendarPart, readonly [number, number | null]> = {
  whole: [1, null],
  early: [1, 10],
  mid: [11, 20],
  late: [21, null],
};

function partOf(word: string | undefined): CalendarPart {
  if (!word) return 'whole';
  if (word === '初' || word === '上旬') return 'early';
  if (word === '中' || word === '中旬') return 'mid';
  return 'late';
}

function relationOf(word: string | undefined): CalendarRelation {
  if (!word) return 'within';
  if (/前/.test(word)) return 'before';
  if (/后/.test(word)) return 'after';
  return 'within';
}

function findCalendarMentions(mt: MappedText): CalendarMention[] {
  const out: CalendarMention[] = [];
  for (const h of findMatches(mt, MONTH_MENTION_RE)) {
    const month = parseChineseNumber(h.groups[3] ?? '');
    if (month === null || !Number.isInteger(month) || month < 1 || month > 12) continue;
    const yearNum = h.groups[1] ? Number(h.groups[1]) : null;
    const year = yearNum !== null ? yearNum : h.groups[2] === '明年' ? 'next' : h.groups[2] === '今年' ? 'this' : null;
    const part = partOf(h.groups[5]);
    out.push({
      start: h.start,
      end: h.end,
      quote: h.quote,
      month,
      days: PART_DAYS[part],
      relation: relationOf(h.groups[6]),
      before_start: part === 'whole',
      year,
    });
  }
  for (const h of findMatches(mt, HOLIDAY_RE)) {
    if (out.some((c) => h.start < c.end && c.start < h.end)) continue;
    out.push({
      start: h.start,
      end: h.end,
      quote: h.quote,
      month: 10,
      days: [1, 7],
      relation: relationOf(h.groups[2]),
      before_start: true,
      year: null,
    });
  }
  return out;
}

const dayNumber = (y: number, m: number, d: number): number => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
const lastDayOfMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Places a calendar mention relative to the local date of `now`; null when it lies in the past. */
function resolveCalendarMention(c: CalendarMention, now: Date, tz: string): Timeframe | null {
  let lp: LocalParts;
  try {
    lp = localParts(now, tz);
  } catch {
    lp = localParts(now, DEFAULT_TZ);
  }
  const today = dayNumber(lp.year, lp.month, lp.day);
  let year: number;
  if (typeof c.year === 'number') year = c.year;
  else if (c.year === 'next') year = lp.year + 1;
  else if (c.year === 'this') year = lp.year;
  else if (c.month >= lp.month) year = lp.year;
  else if (c.month + 12 - lp.month <= 5) year = lp.year + 1; // up to 5 months ahead across the new year ('3月' said in December)
  else return null; // a month 1–6 months back describes the recent past, not a purchase plan
  if (year < lp.year || (year === lp.year && c.month < lp.month)) return null;

  const firstDay = c.days[0];
  const lastDay = c.days[1] ?? lastDayOfMonth(year, c.month);
  const periodStart = dayNumber(year, c.month, firstDay);
  const periodEnd = dayNumber(year, c.month, Math.min(lastDay, lastDayOfMonth(year, c.month)));
  const nextMonthStart = lp.month === 12 ? dayNumber(lp.year + 1, 1, 1) : dayNumber(lp.year, lp.month + 1, 1);
  const ahead = (day: number): Timeframe => (day <= nextMonthStart - 1 ? 'this_month' : day - today <= 92 ? 'within_3_months' : 'later');

  if (c.relation === 'before') {
    // exclusive deadline: '10月前' / '国庆前' → before the period starts · '10月底前' / '10月中前' → by the end of that part
    const deadline = c.before_start ? periodStart : periodEnd + 1;
    if (deadline <= today) return null;
    return ahead(deadline - 1);
  }
  if (c.relation === 'after') {
    const from = periodEnd + 1;
    if (from <= today) return null;
    return ahead(from);
  }
  if (periodEnd < today) return null;
  return ahead(Math.max(periodStart, today));
}

/**
 * Nearest purchase timeframe expressed in the text. Calendar expressions ('9月底', '国庆前') are resolved against
 * `opts.now` in `opts.tz`; without `now` they are ignored rather than mapped to a fixed bucket.
 */
export function detectTimeframeMapped(mt: MappedText, opts: TimeframeOptions = {}): TimeframeMention | null {
  const calendar = findCalendarMentions(mt);
  const insideCalendar = (h: { start: number; end: number }) => calendar.some((c) => h.start < c.end && c.start < h.end);
  const hits: { target: Timeframe; start: number; end: number; quote: string }[] = scanAliases(mt, TIMEFRAME_ENTRIES).filter((h) => {
    // '9月底' is a calendar month, never the relative '月底' (this month)
    if (insideCalendar(h)) return false;
    const term = mt.norm.slice(h.start, h.end);
    if (!SOFT_TIME_TERMS.has(term)) return true;
    return SOFT_TIME_VERB_RE.test(mt.norm.slice(h.end, h.end + 8));
  });
  if (opts.now && Number.isFinite(opts.now.getTime())) {
    const tz = opts.tz?.trim() || DEFAULT_TZ;
    for (const c of calendar) {
      const target = resolveCalendarMention(c, opts.now, tz);
      if (target) hits.push({ target, start: c.start, end: c.end, quote: c.quote });
    }
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => TIMEFRAMES.indexOf(a.target) - TIMEFRAMES.indexOf(b.target) || a.start - b.start);
  const h = hits[0];
  return { timeframe: h.target, quote: h.quote, start: h.start, end: h.end };
}

export function detectTimeframe(text: string, opts: TimeframeOptions = {}): TimeframeMention | null {
  return detectTimeframeMapped(mapText(text), opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// Refusal scope & quote anchoring
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Words that may surround a refusal without giving it an object: politeness, pronouns, time adverbs and
 * references to buying / being contacted. '不需要了，谢谢' is a refusal; '不需要四驱' / '不考虑电车' decline a
 * feature and are NOT.
 */
const REFUSAL_FILLER_TOKENS = [
  '了', '啦', '啊', '呀', '哈', '呢', '吧', '哦', '噢', '喔', '嗯', '的', '呐', '哟', '谢谢', '谢了', '感谢', '多谢', '谢', '算了',
  '算啦', '先', '暂时', '暂且', '目前', '现在', '最近', '近期', '今年', '短期内', '这段时间', '已经', '真的', '真', '实在', '都', '也',
  '就', '还', '其实', '确实', '我', '我们', '我家', '本人', '对', '这个', '这款', '这台', '这辆', '这车', '那个', '车子', '车', '买车',
  '购车', '换车', '看车', '买', '购买', '入手', '了解', '推荐', '推销', '联系', '打扰', '考虑', '再', '你们', '您', '服务', '消息',
  '信息', '私信', '广告', '回复', '发', '不好意思', '抱歉', '好的', '好', 'ok', '没事', '太贵了', '太贵', '有点贵', '贵',
].sort((a, b) => b.length - a.length);
const REFUSAL_FILLER_RE = new RegExp(`^(?:${REFUSAL_FILLER_TOKENS.map(escapeRe).join('|')})*$`);
const XHS_CODE_NORM_RE = /\[[\p{Script=Han}a-z]{1,6}r?\]/gu;

function refusalRemainder(segment: string, ignore: readonly string[]): string {
  let out = segment.replace(XHS_CODE_NORM_RE, '').replace(/[\p{P}\p{S}\s]/gu, '');
  for (const q of ignore) {
    const n = q.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
    if (n) out = out.split(n).join('');
  }
  return out;
}

/**
 * True when the refusal phrase at normalized offsets [start, end) has no object of its own inside its clause —
 * everything before and after it is politeness / pronouns / time adverbs / purchase-or-contact words.
 * `ignore` lists entity quotes that may appear as the refused object (e.g. the dealer's own model: 'i3不买了').
 */
export function isStandaloneRefusal(mt: MappedText, start: number, end: number, ignore: readonly string[] = []): boolean {
  const clause = clauseAt(mt, start);
  const before = refusalRemainder(mt.norm.slice(clause.start, start), ignore);
  const after = refusalRemainder(mt.norm.slice(end, Math.max(end, clause.end)), ignore);
  return REFUSAL_FILLER_RE.test(before) && REFUSAL_FILLER_RE.test(after);
}

/**
 * Map a (possibly re-typed) quote back to the exact raw substring of `source` using the same equivalence as
 * `isVerbatimQuote` (NFKC, case-insensitive, whitespace runs collapsed). Returns null when it does not occur.
 */
export function anchorQuote(source: string, quote: string): string | null {
  const q = quote.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!q || !source) return null;
  const hit = findFirst(mapText(source), new RegExp(q.split(' ').map(escapeRe).join('\\s+')));
  return hit ? hit.quote : null;
}
