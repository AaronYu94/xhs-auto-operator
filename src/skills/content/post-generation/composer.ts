/**
 * Deterministic post composer (spec §15, ARCHITECTURE §3 content loop).
 *
 * A post is assembled from BLOCKS. Fact blocks are built only from structured Dealer Brain rows (vehicles, inventory,
 * active offers, store data, knowledge) and carry the FactRefs whose `claim` text appears verbatim in the block.
 * Voice blocks (intro, section headers, advice, closing) are persona- and account-type specific and contain no
 * factual claims. Every block is checked with verifyClaims + platform rules; a block that does not verify is
 * dropped instead of being published, so the composer can never emit an unverifiable dealer fact.
 */
import type { AppContext } from '../../../app/context.ts';
import { normalizeText } from '../../../core/text.ts';
import type {
  AccountPersona,
  AccountType,
  ContentPillar,
  Dealer,
  DealerKnowledge,
  FactRef,
  Offer,
  Post,
  Vehicle,
  XhsAccount,
} from '../../../core/types.ts';
import { competitorsOf, getBrandInfo, getModelInfo, modelShortLabel } from '../../../domain/automotive-lexicon.ts';
import { ensurePersona, requireAccount } from '../../operations/account-brain/index.ts';
import { checkPlatformRules } from '../../operations/compliance/index.ts';
import {
  exactCny,
  findInventory,
  findVehicles,
  getActiveOffers,
  getDealer,
  getKnowledge,
  getProhibitedClaims,
  verifyClaims,
  type InventoryMatch,
} from '../../operations/dealer-brain/index.ts';
import { colorPairLabel, dealerTz, formatMonthDay, localDateOf } from '../../operations/dealer-brain/shared.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const TITLE_MAX_CHARS = 20;
export const BODY_MIN_CHARS = 300;
export const BODY_MAX_CHARS = 800;
export const MIN_TAGS = 3;
export const MAX_TAGS = 8;
export const POST_MAX_LENGTH = 1000;

export const PILLAR_LABEL: Readonly<Record<ContentPillar, string>> = {
  model_review: '车型解读',
  price_offer: '购车政策',
  inventory_showcase: '实车展示',
  comparison: '车型对比',
  buying_guide: '买车攻略',
  finance_explainer: '金融方案',
  customer_story: '车主故事',
  local_life: '城市用车',
  dealer_event: '门店活动',
  ownership_tips: '用车技巧',
};

const PILLAR_TAG: Readonly<Record<ContentPillar, string>> = {
  model_review: '车型解读',
  price_offer: '购车优惠',
  inventory_showcase: '新车实拍',
  comparison: '车型对比',
  buying_guide: '买车攻略',
  finance_explainer: '汽车金融',
  customer_story: '车主故事',
  local_life: '城市出行',
  dealer_event: '门店活动',
  ownership_tips: '用车技巧',
};

const ACCOUNT_TYPE_TAG: Readonly<Record<AccountType, string>> = {
  official: '4S店资讯',
  salesperson: '汽车销售日常',
  model_specialist: '汽车知识',
  local_guide: '本地买车攻略',
  customer_story: '车主日常',
};

const DEFAULT_ANGLE: Readonly<Record<ContentPillar, string>> = {
  model_review: '车型亮点解读',
  price_offer: '当月购车政策',
  inventory_showcase: '实车细节',
  comparison: '版本怎么选',
  buying_guide: '买车流程攻略',
  finance_explainer: '金融方案解读',
  customer_story: '车主故事征集',
  local_life: '城市用车场景',
  dealer_event: '门店活动预告',
  ownership_tips: '用车小技巧',
};

/** Words that the claim verifier reads as inventory claims; only allowed when backed by stock rows. */
const IN_STOCK_WORDS: [RegExp, string][] = [
  [/现车/gu, '实车'],
  [/现货/gu, '实车'],
  [/有货/gu, '可看车'],
  [/库存/gu, '车源'],
];
const IN_TRANSIT_WORDS: [RegExp, string][] = [[/在途/gu, '新到']];

// Advice pools: persona-neutral guidance WITHOUT any factual claim (no amounts, rates, terms, stock or dates).
const ADVICE: Readonly<Record<ContentPillar, readonly string[]>> = {
  model_review: [
    '看车时建议重点体验座椅支撑、后排空间和车机响应，这些比参数表更影响日常感受。',
    '试驾尽量选自己平时常走的路线，高架、拥堵路段和停车场都走一遍。',
    '不同配置之间的差异主要在动力、续航或舒适配置，按自己的用车场景取舍就好。',
    '如果家里有老人小孩，记得把后排进出和安全座椅接口也看一看。',
    '多看几次实车再做决定，照片和视频很难完全体现质感。',
    '有具体问题可以在评论区留言，我们会按门店资料逐条回复。',
  ],
  price_offer: [
    '看优惠别只看数字：每项政策都有适用车型和签约时间，能否同享要逐条确认。',
    '落地价需结合上牌、保险及金融方案单独核算，建议到店拿书面报价再比较。',
    '全款和贷款的总成本不一样，贷款方案还要看审批结果，签约前算清楚再决定。',
    '政策有截止时间，想在活动期内签约的朋友可以提前预约，避免临近截止排队。',
    '有置换需求的，建议提前准备好旧车行驶证和保养记录，评估会更顺利。',
    '所有价格和优惠以门店书面合同为准，口头说法不作为依据。',
  ],
  inventory_showcase: [
    '车源每天都在变化，到店前建议先预约，让顾问提前确认好你想看的颜色和配置。',
    '看实车时可以在自然光下看漆面颜色，室内灯光下颜色会有偏差。',
    '内饰颜色建议坐进去感受一下，浅色和深色内饰的日常打理方式不太一样。',
    '确定配置后，交付时间、随车物品和上牌安排都可以提前和顾问沟通清楚。',
    '想对比不同颜色搭配的，可以提前说明，门店会尽量安排实车对照。',
    '提车前记得约好验车时间，逐项检查外观、内饰和随车资料。',
  ],
  comparison: [
    '对比车型时建议列一张表：预算、用车场景、空间需求和补能条件，逐项打分会更清楚。',
    '参数只是参考，同一段路分别试驾，感受差异最直接。',
    '版本差价值不值，关键看多出来的配置你是否每天都用得上。',
    '不同品牌各有侧重，选适合自己的比追求参数更重要。',
    '对比时把保养、保险和补能成本一起考虑，长期用车账会更完整。',
    '有具体纠结的两款车，可以在评论区说说你的用车场景，我们帮你一起分析。',
  ],
  buying_guide: [
    '先确定预算区间和主要用车场景，比如通勤、家用还是长途。',
    '预约试驾时带上常坐车的家人，重点感受后排和后备箱。',
    '谈方案时把车价、金融、置换、上牌保险分项写清楚。',
    '签合同前逐条核对配置、交付时间和优惠条件。',
    '提车时对照清单检查漆面、内饰、随车工具和资料。',
    '全程保留书面报价和合同，有疑问及时找顾问确认。',
  ],
  finance_explainer: [
    '贷款购车先看三件事：首付比例、期数和审批条件，适合自己的才是好方案。',
    '金融方案都需要金融机构审批，最终方案以审批结果和书面合同为准。',
    '月供不是越低越好，还要结合尾款、手续费和提前还款规则一起算。',
    '置换时旧车评估价以门店检测为准，建议提前准备好车辆手续。',
    '全款和贷款可以都算一遍总成本，再结合自己的资金安排决定。',
    '以租代购适合想降低前期资金压力的朋友，期满后的选择要提前了解清楚。',
  ],
  customer_story: [
    '每位车主的用车经历都不一样，我们想把真实的选车、提车和用车细节记录下来。',
    '分享内容会先和车主本人确认，经本人授权后才会发布，不会编写任何未经确认的经历。',
    '无论是纠结选车的过程，还是用车一段时间后的真实感受，都欢迎来聊聊。',
    '如果你愿意，也可以带着爱车回店，我们一起拍一组纪念照。',
    '车主的真实反馈，也会帮助正在选车的朋友少走弯路。',
    '报名方式：在评论区留言或私信我们，我们会逐一联系确认。',
  ],
  local_life: [
    '日常通勤建议提前规划补能和停车，常去的地点附近有没有充电桩、停车位都值得提前了解。',
    '周末自驾出发前检查胎压和补能情况，路线规划好服务区更安心。',
    '城市里经常走走停停，选车时可以多关注低速平顺性和泊车辅助。',
    '雨天出行放慢车速、保持车距，出发前确认雨刮和灯光工作正常。',
    '带家人出游的话，后备箱空间和后排舒适性会很影响体验。',
    '有想了解的本地用车问题，欢迎在评论区告诉我们。',
  ],
  dealer_event: [
    '活动名额和礼品以门店实际安排为准，建议提前预约锁定时间。',
    '到店参加活动可以顺便安排试驾，把想看的车型提前告诉顾问。',
    '活动期间来店的朋友较多，工作日到店体验会更从容。',
    '参加试驾需要携带本人有效驾驶证原件。',
    '想了解活动详情，可以在评论区留言，我们会统一回复。',
    '活动信息如有调整，以门店最新通知为准。',
  ],
  ownership_tips: [
    '新车磨合期建议平顺驾驶，避免长时间急加速和急刹车。',
    '按车辆智能保养提示按时保养，保养记录也会影响日后的置换评估。',
    '换季时检查胎压、雨刮和空调滤芯，出行更安心。',
    '纯电车型日常补能保持适当电量区间，长途出发前规划好补能点。',
    '车机和驾驶辅助功能建议先在空旷路段熟悉，再在日常道路使用。',
    '用车中遇到问题，可以预约门店服务顾问检查。',
  ],
};

const ACCOUNT_TYPE_ORDER: readonly AccountType[] = ['official', 'salesperson', 'model_specialist', 'local_guide', 'customer_story'];
const CN_ORDINALS = ['一', '二', '三', '四', '五', '六', '七', '八'];
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧'];

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type BlockKind =
  | 'price'
  | 'cash_offer'
  | 'finance'
  | 'lease'
  | 'trade_in'
  | 'inventory'
  | 'highlights'
  | 'spec'
  | 'store'
  | 'campaign'
  | 'faq'
  | 'competitors'
  | 'advice';

export interface FactBlock {
  kind: BlockKind;
  /** section header label (Chinese) */
  label: string;
  text: string;
  refs: FactRef[];
  /** lower = more important (kept when the body is too long) */
  priority: number;
}

export interface ComposeInputs {
  dealer: Dealer;
  account: XhsAccount;
  persona: AccountPersona;
  pillar: ContentPillar;
  angle: string;
  model: string | null;
  brand: string;
  brand_zh: string;
  /** short model label for titles, e.g. 'i3', '3系', '宝马' when no model */
  model_label: string;
  /** full model name for body text, e.g. '宝马i3', '宝马3系' */
  model_full: string;
  electric: boolean;
  vehicles: Vehicle[];
  lead_vehicle: Vehicle | null;
  stock: InventoryMatch[];
  offers: Offer[];
  campaigns: DealerKnowledge[];
  faqs: DealerKnowledge[];
  /**
   * 车型库 material for the lead trim: what it is, what it is good at, who it is for and which angles it supports.
   * This is **not** facts — no number may be taken from it — but it is what makes a note read like the店 knows the car.
   */
  material: VehicleMaterial;
}

export interface VehicleMaterial {
  description: string;
  highlights: string[];
  target_customers: string[];
  content_angles: string[];
  competitors: string[];
}

export interface ComposedDraft {
  title: string;
  body: string;
  tags: string[];
  cover_text: string;
  fact_refs: FactRef[];
  /** blocks removed because they failed verification / platform rules (with reasons) */
  dropped: { kind: string; reason: string }[];
  inputs: ComposeInputs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const charLen = (s: string) => [...s].length;
const cut = (s: string, max: number) => [...s].slice(0, Math.max(0, max)).join('');
const uniq = <T>(xs: readonly T[]) => [...new Set(xs)];

function hashIndex(seed: string, mod: number): number {
  let h = 2166136261;
  for (const ch of seed) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 16777619);
  }
  return mod > 0 ? (h >>> 0) % mod : 0;
}

function formatPct(ratio: number): string {
  return `${Number((ratio * 100).toFixed(2))}%`;
}

function downPaymentLabel(pct: number): string {
  if (pct === 0) return '零首付';
  const tenths = pct * 10;
  if (Math.abs(tenths - Math.round(tenths)) < 1e-9) return `首付${Math.round(tenths)}成`;
  return `首付${formatPct(pct)}`;
}

function sameText(a: string, b: string): boolean {
  return normalizeText(a).replace(/\s+/g, '') === normalizeText(b).replace(/\s+/g, '');
}

function carriesBrand(dealer: Dealer, vehicle: Vehicle): boolean {
  if (dealer.brands.length === 0) return true;
  return dealer.brands.some((b) => sameText(b, vehicle.brand) || sameText(b, vehicle.brand_zh));
}

function newestPerTrim(vehicles: Vehicle[]): Vehicle[] {
  const newest = new Map<string, number>();
  const key = (veh: Vehicle) => `${veh.brand}|${veh.model}|${veh.trim}`;
  for (const veh of vehicles) newest.set(key(veh), Math.max(newest.get(key(veh)) ?? 0, veh.model_year));
  return vehicles.filter((veh) => veh.model_year === newest.get(key(veh)));
}

/** Replace inventory words in free text (angles, titles) that the dealer's stock cannot back. */
export function sanitizeStockWords(text: string, stock: readonly InventoryMatch[]): string {
  let out = text;
  if (!stock.some((m) => m.inventory.status === 'in_stock')) for (const [re, rep] of IN_STOCK_WORDS) out = out.replace(re, rep);
  if (!stock.some((m) => m.inventory.status === 'in_transit')) for (const [re, rep] of IN_TRANSIT_WORDS) out = out.replace(re, rep);
  // '库存' is read as a claim for any status; keep it only when some stock exists
  if (stock.length === 0) out = out.replace(/库存/gu, '车源');
  return out;
}

/** Contains any word the verifier treats as an inventory claim. */
export const STOCK_WORD_RE = /现车|现货|有货|库存|在途/u;

// ─────────────────────────────────────────────────────────────────────────────
// Inputs (Dealer Brain retrieval)
// ─────────────────────────────────────────────────────────────────────────────

export function gatherInputs(ctx: AppContext, post: Post): ComposeInputs {
  const account = requireAccount(ctx, post.account_id);
  const dealer = getDealer(ctx, post.dealer_id);
  const persona = ensurePersona(ctx, account);
  const brandRaw = dealer.brands[0] ?? '';
  const brandInfo = getBrandInfo(brandRaw);
  const brand = brandInfo?.brand ?? brandRaw;

  let vehicles: Vehicle[] = [];
  if (post.model) {
    vehicles = newestPerTrim(findVehicles(ctx, dealer.group_id, { model: post.model }).filter((veh) => carriesBrand(dealer, veh)));
    vehicles.sort((a, b) => a.msrp - b.msrp || a.trim.localeCompare(b.trim));
  }
  const brandZh = vehicles[0]?.brand_zh || brandInfo?.brand_zh || brandRaw;
  const stock = post.model
    ? findInventory(ctx, dealer.id, { model: post.model, statuses: ['in_stock', 'in_transit'] }).filter(
        (m) => m.inventory.quantity > 0 && vehicles.some((veh) => veh.id === m.vehicle.id),
      )
    : [];
  const stockQty = new Map<string, number>();
  for (const m of stock) if (m.inventory.status === 'in_stock') stockQty.set(m.vehicle.id, (stockQty.get(m.vehicle.id) ?? 0) + m.inventory.quantity);
  const lead =
    [...vehicles].sort((a, b) => (stockQty.get(b.id) ?? 0) - (stockQty.get(a.id) ?? 0) || a.msrp - b.msrp)[0] ?? null;

  const modelZh = vehicles[0]?.model_zh || (post.model ? (getModelInfo(post.model)?.model_zh ?? post.model) : '');
  const modelFull = post.model ? (modelZh.startsWith(brandZh) ? modelZh : `${brandZh}${modelZh}`) : brandZh;
  const modelLabel = post.model ? ([...modelZh].length < 2 ? modelFull : modelZh) : brandZh;
  const electric = lead?.specs.powertrain ? lead.specs.powertrain === 'EV' : post.model ? getModelInfo(post.model)?.powertrain === 'EV' : false;

  const offers = post.model ? getActiveOffers(ctx, dealer.id, { model: post.model }) : getActiveOffers(ctx, dealer.id).filter((o) => !o.vehicle_id && !o.model);
  const knowledge = getKnowledge(ctx, dealer.id, ['campaign', 'faq']);
  const material = materialOf(lead ?? vehicles[0] ?? null);

  return {
    dealer,
    account,
    persona,
    pillar: post.pillar,
    angle: post.angle?.trim() || material.content_angles[0] || DEFAULT_ANGLE[post.pillar],
    model: post.model,
    brand,
    brand_zh: brandZh,
    model_label: post.model ? modelLabel || modelShortLabel(post.model) : brandZh,
    model_full: modelFull,
    electric,
    vehicles,
    lead_vehicle: lead,
    stock,
    offers,
    campaigns: knowledge.filter((k) => k.category === 'campaign'),
    faqs: knowledge.filter((k) => k.category === 'faq'),
    material,
  };
}

/** The card's own words for this trim; empty when nobody has written them yet. */
function materialOf(vehicle: Vehicle | null): VehicleMaterial {
  if (!vehicle || vehicle.archived_at) return { description: '', highlights: [], target_customers: [], content_angles: [], competitors: [] };
  return {
    description: (vehicle.description ?? '').trim(),
    highlights: vehicle.highlights,
    target_customers: vehicle.target_customers ?? [],
    content_angles: vehicle.content_angles ?? [],
    competitors: (vehicle.competitors ?? []).map((c) => `${c.name}${c.note ? `（${c.note}）` : ''}`),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fact blocks
// ─────────────────────────────────────────────────────────────────────────────

function expiryPhrase(dealer: Dealer, offer: Offer): string {
  return `截止日期${formatMonthDay(localDateOf(offer.valid_until, dealerTz(dealer)))}`;
}

function offerScope(inp: ComposeInputs, offer: Offer): string {
  if (offer.vehicle_id) {
    const veh = inp.vehicles.find((x) => x.id === offer.vehicle_id);
    if (veh) return `${inp.model_full} ${veh.trim}`;
  }
  if (offer.model) return inp.model_full;
  return '全车系';
}

function conditionsSuffix(offer: Offer): string {
  const c = offer.conditions.trim().replace(/[。；;，,]+$/u, '');
  return c ? `（${c}）` : '';
}

export function priceBlock(inp: ComposeInputs, max = 2): FactBlock | null {
  const list = inp.vehicles.slice(0, max);
  if (list.length === 0) return null;
  const refs: FactRef[] = [];
  const parts = list.map((veh, i) => {
    const claim = `${veh.trim}指导价${exactCny(veh.msrp)}`;
    refs.push({ kind: 'vehicle', id: veh.id, claim });
    return i === 0 ? `${inp.model_full} ${claim}` : claim;
  });
  return { kind: 'price', label: '指导价', text: `${parts.join('，')}。`, refs, priority: 2 };
}

export function cashOfferBlocks(inp: ComposeInputs, max = 2): FactBlock[] {
  return inp.offers
    .filter((o) => o.type === 'cash_discount' && o.amount !== null && o.amount > 0)
    .slice(0, max)
    .map((o) => {
      const amount = `优惠${exactCny(o.amount ?? 0)}`;
      const expiry = expiryPhrase(inp.dealer, o);
      return {
        kind: 'cash_offer' as const,
        label: '当期优惠',
        text: `「${o.title}」${offerScope(inp, o)}购车${amount}，${expiry}${conditionsSuffix(o)}。`,
        refs: [
          { kind: 'offer' as const, id: o.id, claim: amount },
          { kind: 'offer' as const, id: o.id, claim: expiry },
        ],
        priority: 1,
      };
    });
}

export function financeBlocks(inp: ComposeInputs, type: 'finance' | 'lease', max = 1): FactBlock[] {
  return inp.offers
    .filter((o) => o.type === type)
    .slice(0, max)
    .map((o) => {
      const claims: string[] = [];
      if (type === 'lease' && o.amount !== null) claims.push(`月供${exactCny(o.amount)}`);
      if (o.term_months !== null) claims.push(`${o.term_months}期`);
      if (type === 'finance' && o.apr !== null) claims.push(o.apr === 0 ? '0息' : `年利率${formatPct(o.apr)}`);
      if (o.down_payment_pct !== null) claims.push(downPaymentLabel(o.down_payment_pct));
      if (type === 'finance' && o.amount !== null && o.amount > 0) claims.push(`优惠${exactCny(o.amount)}`);
      const expiry = expiryPhrase(inp.dealer, o);
      claims.push(expiry);
      const body = claims.slice(0, -1).join('、');
      return {
        kind: type,
        label: type === 'finance' ? '金融方案' : '以租代购方案',
        text: `「${o.title}」${offerScope(inp, o)} ${body}，${expiry}${conditionsSuffix(o)}。`,
        refs: claims.map((claim) => ({ kind: 'offer' as const, id: o.id, claim })),
        priority: 2,
      };
    });
}

export function tradeInBlock(inp: ComposeInputs): FactBlock | null {
  const o = inp.offers.find((x) => x.type === 'trade_in' && x.amount !== null && x.amount > 0);
  if (!o) return null;
  const amount = `补贴${exactCny(o.amount ?? 0)}`;
  const expiry = expiryPhrase(inp.dealer, o);
  const desc = o.description.trim().replace(/[。；;，,]+$/u, '');
  return {
    kind: 'trade_in',
    label: '置换补贴',
    text: `「${o.title}」${desc ? `${desc}，` : ''}${amount}，${expiry}${conditionsSuffix(o)}。`,
    refs: [
      { kind: 'offer', id: o.id, claim: amount },
      { kind: 'offer', id: o.id, claim: expiry },
    ],
    priority: 3,
  };
}

export function inventoryBlock(inp: ComposeInputs): FactBlock | null {
  if (inp.stock.length === 0) return null;
  const groups = new Map<string, { veh: Vehicle; label: string; status: string; qty: number; ids: string[] }>();
  for (const m of inp.stock) {
    const key = `${m.vehicle.id}|${m.inventory.exterior_color}|${m.inventory.interior_color}|${m.inventory.status}`;
    const g = groups.get(key) ?? {
      veh: m.vehicle,
      label: colorPairLabel(m.inventory.exterior_color, m.inventory.interior_color),
      status: m.inventory.status === 'in_stock' ? '现车' : '在途',
      qty: 0,
      ids: [],
    };
    g.qty += m.inventory.quantity;
    g.ids.push(m.inventory.id);
    groups.set(key, g);
  }
  const ordered = [...groups.values()].sort((a, b) => (a.status === b.status ? b.qty - a.qty : a.status === '现车' ? -1 : 1)).slice(0, 4);
  const refs: FactRef[] = [];
  const lines = ordered.map((g) => {
    const claim = `${g.label}${g.status}${g.qty}台`;
    for (const id of g.ids) refs.push({ kind: 'inventory', id, claim });
    return `${inp.model_full} ${g.veh.trim} ${claim}`;
  });
  return {
    kind: 'inventory',
    label: '门店车源',
    text: `${lines.join('；')}。车源实时变动，以门店当日确认为准。`,
    refs,
    priority: 1,
  };
}

export function highlightsBlock(inp: ComposeInputs, max = 3): FactBlock | null {
  const veh = inp.lead_vehicle;
  if (!veh) return null;
  const list = veh.highlights.map((h) => h.trim().replace(/[。；;]+$/u, '')).filter(Boolean).slice(0, max);
  if (list.length === 0) return null;
  return {
    kind: 'highlights',
    label: '车型亮点',
    text: `${inp.model_full}的亮点：${list.join('；')}。`,
    refs: list.map((claim) => ({ kind: 'vehicle' as const, id: veh.id, claim })),
    priority: 2,
  };
}

const POWERTRAIN_LABEL: Record<string, string> = { EV: '纯电动', PHEV: '插电混动', HEV: '油电混动', ICE: '燃油' };

function specPhrases(veh: Vehicle): string[] {
  const s = veh.specs;
  const out: string[] = [];
  if (s.powertrain) out.push(POWERTRAIN_LABEL[s.powertrain] ?? String(s.powertrain));
  if (s.body_type) out.push(String(s.body_type));
  if (s.range_km !== undefined) out.push(`CLTC续航${s.range_km}km`);
  if (s.horsepower !== undefined) out.push(`最大功率${s.horsepower}马力`);
  if (s.battery_kwh !== undefined) out.push(`电池容量${s.battery_kwh}kWh`);
  if (s.fuel_l_per_100km !== undefined) out.push(`百公里油耗${s.fuel_l_per_100km}L`);
  if (s.wheelbase_mm !== undefined) out.push(`轴距${s.wheelbase_mm}mm`);
  if (s.seats !== undefined) out.push(`${s.seats}座`);
  return out;
}

export function specBlock(inp: ComposeInputs, vehicles: Vehicle[] = inp.lead_vehicle ? [inp.lead_vehicle] : []): FactBlock | null {
  const refs: FactRef[] = [];
  const lines: string[] = [];
  for (const veh of vehicles) {
    const phrases = specPhrases(veh);
    if (phrases.length === 0) continue;
    for (const claim of phrases) refs.push({ kind: 'vehicle', id: veh.id, claim });
    lines.push(`${inp.model_full} ${veh.trim}：${phrases.join('，')}`);
  }
  if (lines.length === 0) return null;
  return { kind: 'spec', label: vehicles.length > 1 ? '版本参数对比' : '核心参数', text: `${lines.join('。\n')}。`, refs, priority: 2 };
}

export function storeBlock(inp: ComposeInputs): FactBlock | null {
  const d = inp.dealer;
  const refs: FactRef[] = [];
  const parts: string[] = [];
  if (d.address.trim()) {
    parts.push(`地址：${d.address.trim()}`);
    refs.push({ kind: 'dealer', id: d.id, claim: d.address.trim() });
  }
  if (d.business_hours.trim()) {
    parts.push(`营业时间：${d.business_hours.trim()}`);
    refs.push({ kind: 'dealer', id: d.id, claim: d.business_hours.trim() });
  }
  if (parts.length === 0) return null;
  // Never the store phone number: Xiaohongshu forbids phone numbers in content (contact must go through 留资卡).
  return { kind: 'store', label: '门店信息', text: `${d.name}${parts.join('，')}。`, refs, priority: 4 };
}

export function campaignBlocks(inp: ComposeInputs, max = 1): FactBlock[] {
  return inp.campaigns.slice(0, max).map((k) => {
    const content = k.content.trim();
    return {
      kind: 'campaign' as const,
      label: '门店活动',
      text: `「${k.title}」${content}${/[。！？]$/u.test(content) ? '' : '。'}`,
      refs: [{ kind: 'knowledge' as const, id: k.id, claim: content }],
      priority: 1,
    };
  });
}

export function faqBlocks(inp: ComposeInputs, max = 2): FactBlock[] {
  return inp.faqs.slice(0, max).map((k) => {
    const content = k.content.trim();
    return {
      kind: 'faq' as const,
      label: '用车小知识',
      text: `${k.title}：${content}${/[。！？]$/u.test(content) ? '' : '。'}`,
      refs: [{ kind: 'knowledge' as const, id: k.id, claim: content }],
      priority: 1,
    };
  });
}

export function competitorBlock(inp: ComposeInputs): FactBlock | null {
  if (!inp.model) return null;
  const comps = competitorsOf(inp.brand, inp.model).slice(0, 2).map((c) => c.model_zh || c.model);
  if (comps.length === 0) return null;
  return {
    kind: 'competitors',
    label: '横向对比建议',
    text: `如果你也在看${comps.join('、')}，建议把续航或油耗、空间、用车成本放在一起比较，同一段路分别试驾，感受最直接。`,
    refs: [],
    priority: 5,
  };
}

/** The fact plan for a pillar: ordered candidate blocks (null entries are skipped). */
function pillarFacts(inp: ComposeInputs): FactBlock[] {
  const f = (xs: (FactBlock | null)[]) => xs.filter((x): x is FactBlock => x !== null);
  switch (inp.pillar) {
    case 'model_review':
      return f([highlightsBlock(inp, 3), specBlock(inp), priceBlock(inp, 2)]);
    case 'price_offer':
      return f([priceBlock(inp, 2), ...cashOfferBlocks(inp, 2), ...financeBlocks(inp, 'finance', 1), tradeInBlock(inp)]);
    case 'inventory_showcase':
      return f([inventoryBlock(inp), priceBlock(inp, 2), highlightsBlock(inp, 2), inventoryBlock(inp) ? null : storeBlock(inp)]);
    case 'comparison':
      return f([specBlock(inp, inp.vehicles.slice(0, 2)), priceBlock(inp, 2), competitorBlock(inp)]);
    case 'buying_guide':
      return f([storeBlock(inp), ...cashOfferBlocks(inp, 1), tradeInBlock(inp), ...financeBlocks(inp, 'finance', 1)]);
    case 'finance_explainer':
      return f([...financeBlocks(inp, 'finance', 1), ...financeBlocks(inp, 'lease', 1), tradeInBlock(inp), priceBlock(inp, 1)]);
    case 'customer_story':
      return f([highlightsBlock(inp, 2), storeBlock(inp)]);
    case 'local_life':
      return f([highlightsBlock(inp, 2), inp.electric ? specBlock(inp) : null, storeBlock(inp)]);
    case 'dealer_event':
      return f([...campaignBlocks(inp, 1), storeBlock(inp), ...cashOfferBlocks(inp, 1)]);
    case 'ownership_tips':
      return f([...faqBlocks(inp, 2), highlightsBlock(inp, 1)]);
  }
}

/** Extra verified facts used only to reach the minimum body length. */
function fillerFacts(inp: ComposeInputs, used: Set<BlockKind>): FactBlock[] {
  const out = [highlightsBlock(inp, 3), specBlock(inp), storeBlock(inp), priceBlock(inp, 1)].filter(
    (x): x is FactBlock => x !== null && !used.has(x.kind),
  );
  return out.map((b) => ({ ...b, priority: 6 }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Voices (account type × persona)
// ─────────────────────────────────────────────────────────────────────────────

interface Voice {
  intro: string;
  header: (label: string, i: number) => string;
  adviceHeader: string;
  closing: string;
  title: string;
  cover: string;
}

function voiceFor(inp: ComposeInputs): Voice {
  const p = inp.persona;
  const sig = (p.signature_phrases ?? []).map((s) => s.trim()).find(Boolean) ?? '';
  const city = inp.account.city || inp.dealer.city;
  const pillarWord = PILLAR_LABEL[inp.pillar];
  const angle = inp.angle;
  const m = inp.model_full;
  const label = inp.model_label;
  const titleWith = (prefix: string, rest: string) => `${prefix}${cut(rest, TITLE_MAX_CHARS - charLen(prefix))}`;

  switch (inp.account.account_type) {
    case 'official':
      return {
        intro: `【${inp.dealer.name}】${angle}：我们整理了${m}的${pillarWord}信息，方便大家到店前先了解。`,
        header: (l, i) => `${CN_ORDINALS[i] ?? String(i + 1)}、${l}`,
        adviceHeader: '购车提示',
        closing: `以上信息均以门店书面政策为准，欢迎通过主页留资卡预约到店品鉴。${sig}`,
        title: titleWith(label, angle),
        cover: cut(`${label}${pillarWord}官方说明`, 14),
      };
    case 'salesperson':
      return {
        intro: `${p.persona_name || inp.account.nickname}来聊${m}：${angle}，这是客户问我最多的话题，今天一次说清👇`,
        header: (l, i) => `${CIRCLED[i] ?? '•'} ${l}`,
        adviceHeader: '销售的真心话',
        closing: `我的建议是不着急下决定，多看多比，适合自己最重要。${sig}`,
        title: titleWith(`${label}｜`, angle),
        cover: cut(`${label}${pillarWord}真实讲`, 14),
      };
    case 'model_specialist':
      return {
        intro: `${angle}｜${m}。先看数据，再说结论。`,
        header: (l, i) => (i === 0 ? `📊 ${l}` : `▪ ${l}`),
        adviceHeader: '研究所解读',
        closing: `结论：${m}更适合看重${inp.electric ? '纯电通勤和驾驶质感' : '驾驶质感和空间'}的用户，最终建议以试驾体验为准。${sig}`,
        title: titleWith(`【${label}】`, angle),
        cover: cut(`${label}${angle}`, 14),
      };
    case 'local_guide':
      return {
        intro: `${city}买${m}先看这篇：${angle}，收藏起来少走弯路。`,
        header: (l) => `✅ ${l}`,
        adviceHeader: '避坑提醒',
        closing: `以上政策信息以官方和门店发布为准。${sig}`,
        title: titleWith(`${city}${label}｜`, angle),
        cover: cut(`${city}买${label}攻略`, 14),
      };
    case 'customer_story':
      return {
        intro: `【车主故事征集】${angle.includes('征集') ? '' : `${angle}：`}我们正在寻找${city}的${m}车主，记录真实的选车与用车经历。`,
        header: (l) => `✦ ${l}`,
        adviceHeader: '征集说明',
        closing: `所有车主故事都会先和车主本人确认，经授权后才会发布。${sig}`,
        title: titleWith(label, '车主故事征集'),
        cover: cut(`${label}车主故事征集`, 14),
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Verification of blocks
// ─────────────────────────────────────────────────────────────────────────────

export interface TextCheck {
  passed: boolean;
  issues: string[];
}

/** Claims verify against the declared refs AND platform rules pass (channel 'post'). */
export function checkText(ctx: AppContext, dealerId: string, text: string, refs: FactRef[]): TextCheck {
  const issues: string[] = [];
  const facts = verifyClaims(ctx, dealerId, text, refs);
  if (!facts.passed) issues.push(...facts.issues);
  const rules = checkPlatformRules(text, { prohibited: getProhibitedClaims(ctx, dealerId), max_length: POST_MAX_LENGTH, channel: 'post' });
  if (!rules.passed) issues.push(...rules.issues.map((i) => i.message));
  return { passed: issues.length === 0, issues };
}

/** Taboo topics of the persona that literally occur in the text. */
export function tabooHits(persona: Pick<AccountPersona, 'taboo_topics'>, text: string): string[] {
  const t = normalizeText(text);
  return (persona.taboo_topics ?? []).map((x) => x.trim()).filter((x) => charLen(x) >= 2 && t.includes(normalizeText(x)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembly
// ─────────────────────────────────────────────────────────────────────────────

function adviceFor(inp: ComposeInputs, count: number): string[] {
  const pool = ADVICE[inp.pillar];
  const typeIdx = Math.max(0, ACCOUNT_TYPE_ORDER.indexOf(inp.account.account_type));
  const start = (typeIdx * 2 + hashIndex(`${inp.account.id}|${inp.angle}`, pool.length)) % pool.length;
  const out: string[] = [];
  for (let i = 0; i < pool.length && out.length < count; i++) {
    const line = pool[(start + i) % pool.length];
    if (inp.pillar === 'ownership_tips' && !inp.electric && line.includes('纯电')) continue;
    out.push(line);
  }
  return out;
}

function renderBody(voice: Voice, facts: FactBlock[], advice: string[], accountType: AccountType): string {
  const lines: string[] = [voice.intro, ''];
  facts.forEach((b, i) => {
    lines.push(voice.header(b.label, i));
    lines.push(b.text);
    lines.push('');
  });
  if (advice.length > 0) {
    lines.push(voice.header(voice.adviceHeader, facts.length));
    advice.forEach((a, i) => lines.push(accountType === 'local_guide' ? `${i + 1}. ${a}` : `· ${a}`));
    lines.push('');
  }
  if (voice.closing.trim()) lines.push(voice.closing.trim());
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function buildTags(inp: ComposeInputs): string[] {
  const city = inp.account.city || inp.dealer.city;
  const tags = [
    inp.model ? inp.model_full : `${inp.brand_zh}`,
    `${city}${inp.brand_zh}`,
    `${city}买车`,
    PILLAR_TAG[inp.pillar],
    ACCOUNT_TYPE_TAG[inp.account.account_type],
  ];
  if (inp.model && inp.electric) tags.push('纯电车');
  const body = inp.lead_vehicle?.specs.body_type;
  if (typeof body === 'string' && /suv/i.test(body)) tags.push('SUV');
  return uniq(tags.map((t) => t.replace(/[#\s]/g, '')).filter((t) => t.length >= 2)).slice(0, MAX_TAGS);
}

/**
 * Compose a rules-based draft for a PLANNED post. Never throws for missing data: blocks that cannot be backed are
 * simply absent (e.g. no inventory rows → no stock sentence and no stock words anywhere).
 */
export function composeDraft(ctx: AppContext, post: Post): ComposedDraft {
  const inp = gatherInputs(ctx, post);
  inp.angle = sanitizeStockWords(inp.angle, inp.stock);
  const voice = voiceFor(inp);
  const dropped: { kind: string; reason: string }[] = [];

  const accept = (b: FactBlock): boolean => {
    const check = checkText(ctx, inp.dealer.id, b.text, b.refs);
    if (!check.passed) dropped.push({ kind: b.kind, reason: check.issues.join('；') });
    return check.passed;
  };

  const voiceParts = [voice.intro, voice.closing, voice.title, voice.cover];
  for (const part of voiceParts) {
    const check = checkText(ctx, inp.dealer.id, part, []);
    if (!check.passed) dropped.push({ kind: 'voice', reason: check.issues.join('；') });
  }
  const safe = (s: string, fallback: string) => (checkText(ctx, inp.dealer.id, s, []).passed ? s : fallback);
  voice.intro = safe(voice.intro, `${inp.model_full}${PILLAR_LABEL[inp.pillar]}整理。`);
  voice.closing = safe(voice.closing, '以上信息以门店书面政策为准。');
  voice.title = safe(sanitizeStockWords(voice.title, inp.stock), cut(`${inp.model_label}${PILLAR_LABEL[inp.pillar]}`, TITLE_MAX_CHARS));
  voice.cover = safe(sanitizeStockWords(voice.cover, inp.stock), cut(`${inp.model_label}${PILLAR_LABEL[inp.pillar]}`, 14));

  let facts = pillarFacts(inp).filter(accept);
  let adviceCount = 3;
  let body = renderBody(voice, facts, adviceFor(inp, adviceCount), inp.account.account_type);

  // reach the minimum length: more advice first, then extra verified facts
  while (charLen(body) < BODY_MIN_CHARS && adviceCount < ADVICE[inp.pillar].length) {
    adviceCount++;
    body = renderBody(voice, facts, adviceFor(inp, adviceCount), inp.account.account_type);
  }
  if (charLen(body) < BODY_MIN_CHARS) {
    const used = new Set(facts.map((b) => b.kind));
    for (const extra of fillerFacts(inp, used)) {
      if (charLen(body) >= BODY_MIN_CHARS) break;
      if (!accept(extra)) continue;
      facts = [...facts, extra];
      body = renderBody(voice, facts, adviceFor(inp, adviceCount), inp.account.account_type);
    }
  }
  // respect the maximum: drop advice, then the least important fact blocks
  while (charLen(body) > BODY_MAX_CHARS && adviceCount > 1) {
    adviceCount--;
    body = renderBody(voice, facts, adviceFor(inp, adviceCount), inp.account.account_type);
  }
  while (charLen(body) > BODY_MAX_CHARS && facts.length > 1) {
    const worst = [...facts].sort((a, b) => b.priority - a.priority)[0];
    facts = facts.filter((b) => b !== worst);
    dropped.push({ kind: worst.kind, reason: `正文超过${BODY_MAX_CHARS}字，移除次要信息` });
    body = renderBody(voice, facts, adviceFor(inp, adviceCount), inp.account.account_type);
  }

  const title = voice.title;
  const refs = dedupeRefs(facts.flatMap((b) => b.refs)).filter((r) => normalizeText(`${title}\n${body}`).includes(normalizeText(r.claim)));
  return { title, body, tags: buildTags(inp), cover_text: voice.cover, fact_refs: refs, dropped, inputs: inp };
}

export function dedupeRefs(refs: readonly FactRef[]): FactRef[] {
  const seen = new Set<string>();
  const out: FactRef[] = [];
  for (const r of refs) {
    const key = `${r.kind}:${r.id}:${r.claim}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Format rules (shared by generation validation and content review)
// ─────────────────────────────────────────────────────────────────────────────

/** Structural checks: title length + model name, body length, tag count. Returns Chinese issue strings. */
export function formatIssues(post: Pick<Post, 'title' | 'body' | 'tags'>, modelLabel: string): string[] {
  const issues: string[] = [];
  if (!post.title.trim()) issues.push('格式：标题为空');
  else if (charLen(post.title) > TITLE_MAX_CHARS) issues.push(`格式：标题${charLen(post.title)}字，超过${TITLE_MAX_CHARS}字上限`);
  if (modelLabel && !normalizeText(post.title).includes(normalizeText(modelLabel))) issues.push(`格式：标题未包含车型名称「${modelLabel}」`);
  const len = charLen(post.body.trim());
  if (len < BODY_MIN_CHARS) issues.push(`格式：正文${len}字，少于${BODY_MIN_CHARS}字`);
  if (len > BODY_MAX_CHARS) issues.push(`格式：正文${len}字，超过${BODY_MAX_CHARS}字`);
  if (post.tags.length < MIN_TAGS || post.tags.length > MAX_TAGS) issues.push(`格式：话题标签${post.tags.length}个，应为${MIN_TAGS}-${MAX_TAGS}个`);
  return issues;
}

/** The label a post title must contain (model short label, or the brand for general posts). */
export function titleModelLabel(ctx: AppContext, post: Pick<Post, 'dealer_id' | 'account_id' | 'model' | 'pillar' | 'angle'> & Partial<Post>): string {
  const inp = gatherInputs(ctx, post as Post);
  return inp.model_label;
}
