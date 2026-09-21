/**
 * 在售车型: the store's line-up the way a dealer looks at it — photo cards, not a table row per price-list line.
 *
 * The list is the product line-up at a glance (cover, price, what it is, how many are on the ground). The detail page
 * is the full card: gallery, price, specs, colours and stock, finance, and the AI-written material that content,
 * private messages and replies all pull from. Facts and material are visually separate, because only one of them may
 * appear as a number in customer-facing text. The page says that in one line; the reasoning sits behind a 「?」.
 */
import type { Dealer, Offer, Vehicle } from '../../core/types.ts';
import { vehicleImageSrc } from '../api/media.ts';
import { listVehicleCards, getVehicleCard, powertrainLabel, type VehicleCard } from '../../skills/operations/vehicle-brain/index.ts';
import type { Reply, RequestContext } from '../http.ts';
import { queryString } from '../http.ts';
import { hint } from '../hint.ts';
import { cny, emptyState, esc, fmtTime, href, pill, sectionHead } from '../render.ts';
import { dealerTz, noDealerBody, renderPage, resolveDealer, type PageEnv } from './shell.ts';

const OFFER_TYPE: Record<Offer['type'], string> = {
  cash_discount: '现金优惠',
  finance: '金融方案',
  lease: '租赁方案',
  trade_in: '置换',
  gift: '赠品',
  campaign: '活动',
};

const SPEC_LABEL: { key: string; label: string; unit: string }[] = [
  { key: 'range_km', label: '纯电续航', unit: '公里' },
  { key: 'combined_range_km', label: '综合续航', unit: '公里' },
  { key: 'motor_kw', label: '电机功率', unit: 'kW' },
  { key: 'battery_kwh', label: '电池', unit: '度' },
  { key: 'horsepower', label: '马力', unit: 'Ps' },
  { key: 'torque_nm', label: '扭矩', unit: 'N·m' },
  { key: 'zero_to_100_s', label: '零百加速', unit: '秒' },
  { key: 'seats', label: '座位', unit: '座' },
  { key: 'length_mm', label: '车长', unit: 'mm' },
  { key: 'wheelbase_mm', label: '轴距', unit: 'mm' },
  { key: 'fuel_l_per_100km', label: '百公里油耗', unit: 'L' },
];

/** The cover: a real photo when the store gave one and it can be displayed, else the model name on a plate. */
function cover(card: VehicleCard, cls = 'veh-cover'): string {
  const first = (card.vehicle.images ?? []).map((i) => vehicleImageSrc(i)).find(Boolean);
  if (first) return `<div class="${cls}"><img src="${esc(first)}" alt="${esc(card.display_name)}" loading="lazy"></div>`;
  const local = (card.vehicle.images ?? []).length > 0;
  return `<div class="${cls} is-empty"><span class="veh-cover-text">${esc(card.vehicle.model_zh)}</span>${local ? '<span class="veh-cover-note">这张图存在本机，网页里看不到</span>' : ''}</div>`;
}

function priceTag(card: VehicleCard): string {
  if (card.price.current === null) return `<span class="veh-price">${esc(cny(card.price.msrp))}</span><span class="veh-price-note">指导价</span>`;
  return `<span class="veh-price">${esc(cny(card.price.current))}</span><span class="veh-price-was">${esc(cny(card.price.msrp))}</span>${
    card.price.price_cut ? `<span class="veh-cut">↓${esc(cny(card.price.price_cut))}</span>` : ''
  }`;
}

function stockLine(card: VehicleCard): string {
  if (card.in_stock > 0) return `<span class="veh-stock is-on">现车 ${esc(card.in_stock)} 台</span>${card.in_transit > 0 ? `<span class="veh-stock">在途 ${esc(card.in_transit)}</span>` : ''}`;
  if (card.in_transit > 0) return `<span class="veh-stock">在途 ${esc(card.in_transit)} 台</span>`;
  return '<span class="veh-stock is-off">暂无车源</span>';
}

function specChips(vehicle: Vehicle, max = 4): string {
  const chips: string[] = [];
  const power = powertrainLabel(vehicle);
  if (power) chips.push(power);
  for (const s of SPEC_LABEL) {
    const value = vehicle.specs[s.key];
    if (typeof value === 'number' && chips.length < max) chips.push(`${s.label} ${value}${s.unit}`);
  }
  return chips.map((c) => `<span class="chip-neutral">${esc(c)}</span>`).join('');
}

/**
 * Two specs on one line, always the same two slots. Four chips of different lengths wrap differently on every card
 * and make a catalogue look ragged; a fixed line keeps every card the same height and scannable down the column.
 */
function specLine(vehicle: Vehicle): string {
  const parts: string[] = [];
  const power = powertrainLabel(vehicle);
  if (power) parts.push(power);
  for (const s of SPEC_LABEL) {
    const value = vehicle.specs[s.key];
    if (typeof value === 'number' && parts.length < 2) parts.push(`${s.label} ${value}${s.unit}`);
  }
  return parts.join(' · ');
}

function card(card_: VehicleCard, dealerId: string): string {
  const veh = card_.vehicle;
  const foot = [
    card_.offers.length > 0 ? `${card_.offers.length} 条政策` : '',
    veh.knowledge_generated_at ? 'AI 已写介绍' : '还没写介绍',
  ].filter(Boolean);
  return `<a class="veh${card_.archived ? ' is-archived' : ''}" href="${esc(href(`/vehicles/${veh.id}`, { dealer: dealerId }))}">
  ${cover(card_)}
  <div class="veh-body">
    <div class="veh-name">${esc(veh.brand_zh)}${esc(veh.model_zh)}<span class="veh-trim">${esc(veh.model_year)}款 ${esc(veh.trim)}</span></div>
    <div class="veh-price-row">${priceTag(card_)}</div>
    <div class="veh-spec-line">${esc(specLine(veh))}</div>
    <div class="veh-foot">${stockLine(card_)}${foot.map((x) => `<span>${esc(x)}</span>`).join('')}${card_.archived ? '<span class="status s-neutral">已归档</span>' : ''}</div>
  </div>
</a>`;
}

// ── list ─────────────────────────────────────────────────────────────────────

const SOURCE_OF_TRUTH_HELP = [
  '写笔记、发私信、回客户时说的价格、参数、颜色和现车，都只从这一页取。',
  'AI 只会用你在这里填的数字。价格、参数、颜色、现车台数，它一个都不会自己编——没填的它就不说。',
  '所以这里改一次，写笔记、发私信、回评论的口径就一起改了；把一款车归档，它也会同时从所有内容里退场。',
];

/** 表头说明 belongs behind the 「?」: the box itself only has to say what to paste. */
const IMPORT_HELP = [
  '把 4S 店的价格表整列复制过来就行：第一行是表头，后面每行一款车。',
  '表头这样写都认：品牌、车型、配置、年款、指导价、当前售价、动力形式、卖点、客户常用叫法、图片、描述。',
  '同一个品牌 + 车型 + 配置 + 年款已经在列表里时，这次导入会更新它，不会多出一条重复的。',
];

function importForm(dealer: Dealer): string {
  return `<details class="adder" id="import">
  <summary class="btn btn-ghost btn-sm">批量导入</summary>
  <form class="stack" data-api="/api/dealers/${esc(dealer.id)}/vehicles/import" data-success-detail="1" data-success="已导入">
    <label>把价格表粘到这里，第一行写表头${hint(IMPORT_HELP)}
      <textarea name="text" rows="8" required placeholder="品牌,车型,配置,年款,指导价,当前售价,动力形式,卖点&#10;小鹏,G6,580 Max,2026,209900,199900,纯电,城市智驾｜800V 快充"></textarea>
    </label>
    <div class="form-actions"><button class="btn btn-ink btn-sm" type="submit">导入</button></div>
  </form>
</details>`;
}

export function vehiclesPage(env: PageEnv, rc: RequestContext): Reply {
  const { ctx } = env.runtime;
  const { dealer, dealers } = resolveDealer(ctx, rc);
  if (!dealer) return renderPage(env, rc, { title: '在售车型', active: 'vehicles', dealer: null, dealers, h1: '在售车型', subtitle: '尚未配置门店', body: noDealerBody() });

  const showArchived = queryString(rc.query, 'archived') === '1';
  const query = queryString(rc.query, 'q') ?? '';
  const all = listVehicleCards(ctx, dealer.id, { include_archived: showArchived, query: query || undefined });
  // 「已归档」is a tab, not an addition: the archived view shows archived cards ONLY, never the live line-up again.
  const cards = showArchived ? all.filter((c) => c.archived) : all;
  const live = all.filter((c) => !c.archived);
  const archivedCount = listVehicleCards(ctx, dealer.id, { include_archived: true }).filter((c) => c.archived).length;
  const withAi = live.filter((c) => c.vehicle.knowledge_generated_at).length;
  const withStock = live.filter((c) => c.in_stock > 0).length;

  const tab = (label: string, on: boolean, params: Record<string, string | undefined>) =>
    `<a class="im-tab${on ? ' is-on' : ''}" href="${esc(href('/vehicles', { dealer: dealer.id, ...params }))}">${esc(label)}</a>`;

  const empty = showArchived
    ? emptyState(query ? '归档里没有匹配的车型' : '还没有归档的车型。')
    : emptyState(query ? '没有匹配的车型' : '还没有车型。先在「设置 → 在售车型」添加，或在这里批量导入。');

  // Everything that steers this page sits on one line: which list, how to narrow it, how to add to it.
  const body = `<div class="toolbar">
  <div class="view-tabs">${tab('在售', !showArchived, {})}${tab(`已归档${archivedCount > 0 ? ` ${archivedCount}` : ''}`, showArchived, { archived: '1' })}</div>
  <form class="row" method="get" action="/vehicles" style="gap:6px">
    <input type="hidden" name="dealer" value="${esc(dealer.id)}">
    ${showArchived ? '<input type="hidden" name="archived" value="1">' : ''}
    <input type="search" name="q" value="${esc(query)}" placeholder="搜车型、配置、卖点" style="width:200px" aria-label="搜车型">
    <button class="btn btn-ghost btn-sm" type="submit">搜索</button>
  </form>
  <span class="spacer"></span>
  <span class="veh-stat-row"><span class="veh-stat"><b>${esc(live.length)}</b> 款在售</span><span class="veh-stat"><b>${esc(withStock)}</b> 款有现车</span><span class="veh-stat"><b>${esc(withAi)}</b> 款有 AI 介绍</span></span>
  <a class="btn btn-ink btn-sm" href="${esc(href('/setup', { dealer: dealer.id }))}#vehicles">添加车型</a>
</div>
${importForm(dealer)}
${cards.length === 0 ? empty : `<div class="veh-grid">${cards.map((c) => card(c, dealer.id)).join('')}</div>`}`;

  return renderPage(env, rc, {
    title: '在售车型',
    active: 'vehicles',
    dealer,
    dealers,
    h1: '在售车型',
    help: SOURCE_OF_TRUTH_HELP,
    subtitle: dealer.name,
    body,
  });
}

// ── detail ───────────────────────────────────────────────────────────────────

const listBlock = (title: string, items: readonly string[], empty: string): string =>
  `<div class="veh-block"><h3>${esc(title)}</h3>${items.length > 0 ? `<ul class="veh-list">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : `<p class="muted small">${esc(empty)}</p>`}</div>`;

function offerLine(o: Offer): string {
  const parts: string[] = [];
  if (o.amount !== null) parts.push(cny(o.amount));
  if (o.apr !== null) parts.push(`年化 ${(o.apr * 100).toFixed(2)}%`);
  if (o.term_months !== null) parts.push(`${o.term_months} 期`);
  if (o.down_payment_pct !== null) parts.push(`首付 ${Math.round(o.down_payment_pct * 100)}%`);
  return `<li><b>${esc(o.title)}</b> ${pill(OFFER_TYPE[o.type], o.type === 'finance' || o.type === 'lease' ? 'violet' : 'neutral')} ${esc(parts.join(' · '))}${
    o.conditions.trim() ? `<span class="muted small"> · ${esc(o.conditions.trim())}</span>` : ''
  }<span class="muted small"> · 截止 ${esc(o.valid_until)}</span></li>`;
}

function editForm(card_: VehicleCard): string {
  const veh = card_.vehicle;
  const specValue = (key: string) => {
    const value = veh.specs[key];
    return typeof value === 'number' ? String(value) : '';
  };
  return `<form class="stack" data-api="/api/vehicles/${esc(veh.id)}" data-method="PATCH" data-success="车型已更新">
  <div class="fields">
    <label><span>配置/版本</span><input type="text" name="trim" value="${esc(veh.trim)}" maxlength="60"></label>
    <label><span>年款</span><input type="number" name="model_year" value="${esc(veh.model_year)}" min="1990" max="2100"></label>
    <label><span>厂商指导价（元）</span><input type="number" name="msrp" value="${esc(veh.msrp)}" min="1"></label>
    <label><span>当前售价（元）<span class="opt">选填</span></span><input type="number" name="current_price" value="${esc(veh.current_price ?? '')}" min="1" data-optional placeholder="不填＝按指导价"></label>
    ${SPEC_LABEL.map((s) => `<label><span>${esc(s.label)}（${esc(s.unit)}）<span class="opt">选填</span></span><input type="number" step="any" name="specs.${esc(s.key)}" value="${esc(specValue(s.key))}" data-optional></label>`).join('')}
    <label class="wide"><span>客户常用叫法<span class="opt">选填</span></span><textarea name="aliases" data-type="lines" rows="2" placeholder="每行一个">${esc(veh.aliases.join('\n'))}</textarea></label>
    <label class="wide"><span>图片${hint('每行放一张图：网页图片链接（https 开头），或这台电脑上的图片文件位置。第一张就是卡片封面。')}<span class="opt">选填</span></span><textarea name="images" data-type="lines" rows="3">${esc((veh.images ?? []).join('\n'))}</textarea></label>
    <label class="wide"><span>核心卖点<span class="opt">选填</span></span><textarea name="highlights" data-type="lines" rows="3" placeholder="每行一条">${esc(veh.highlights.join('\n'))}</textarea></label>
    <label class="wide"><span>适合人群<span class="opt">选填</span></span><textarea name="target_customers" data-type="lines" rows="2" placeholder="每行一条">${esc((veh.target_customers ?? []).join('\n'))}</textarea></label>
    <label class="wide"><span>小红书选题角度<span class="opt">选填</span></span><textarea name="content_angles" data-type="lines" rows="2" placeholder="每行一条">${esc((veh.content_angles ?? []).join('\n'))}</textarea></label>
    <label class="wide"><span>详细描述<span class="opt">选填</span></span><textarea name="description" rows="5" maxlength="2000">${esc(veh.description ?? '')}</textarea></label>
  </div>
  <div class="form-actions"><span class="st-help">价格、参数、现车只有人能改，AI 只写文字。</span><button class="btn btn-ink btn-sm" type="submit">保存</button></div>
</form>`;
}

export function vehicleDetailPage(env: PageEnv, rc: RequestContext): Reply {
  const { ctx } = env.runtime;
  const { dealer: current, dealers } = resolveDealer(ctx, rc);
  const row = ctx.db.table('vehicles').get(rc.params.id);
  if (!row) return renderPage(env, rc, { title: '车型', active: 'vehicles', dealer: null, dealers, h1: '车型', subtitle: '', body: emptyState('这款车已经不在列表里了') });
  // The catalog belongs to the group, the stock and the offers belong to ONE store: show the store that was asked for.
  const dealer = current && current.group_id === row.group_id ? current : (dealers.find((d) => d.group_id === row.group_id) ?? null);
  if (!dealer) return renderPage(env, rc, { title: '车型', active: 'vehicles', dealer: null, dealers, h1: '车型', subtitle: '', body: emptyState('该车型不属于当前门店') });

  const card_ = getVehicleCard(ctx, dealer.id, row.id);
  const veh = card_.vehicle;
  const tz = dealerTz(dealer);
  const gallery = (veh.images ?? []).map((i) => vehicleImageSrc(i)).filter(Boolean) as string[];
  const specs = SPEC_LABEL.map((s) => ({ ...s, value: veh.specs[s.key] })).filter((s) => typeof s.value === 'number');

  const colorRows = card_.colors.length
    ? `<ul class="veh-colors">${card_.colors
        .map(
          (c) =>
            `<li><span class="veh-color-name">${esc(c.exterior_color)}${c.interior_color ? ` / ${esc(c.interior_color)}` : ''}</span>${pill(c.status === 'in_stock' ? '现车' : '在途', c.status === 'in_stock' ? 'green' : 'amber')}<span class="num">${esc(c.quantity)} 台</span></li>`,
        )
        .join('')}</ul>`
    : '<p class="muted small">这款车现在没有现车。没有现车时，AI 不会在任何内容里说「现车」。</p>';

  const body = `<div class="veh-detail">
  <div class="veh-hero">
    ${cover(card_, 'veh-hero-cover')}
    <div class="veh-hero-body">
      <div class="row">${pill(`${veh.model_year}款`, 'neutral')}${card_.powertrain_label ? pill(card_.powertrain_label, 'violet') : ''}${card_.archived ? pill('已归档', 'red') : ''}</div>
      <h2 class="veh-hero-name">${esc(veh.brand_zh)}${esc(veh.model_zh)} ${esc(veh.trim)}</h2>
      <div class="veh-price-row veh-price-lg">${priceTag(card_)}</div>
      <div class="veh-foot">${stockLine(card_)}</div>
      <div class="chips">${specChips(veh, 6)}</div>
      <div class="row">
        <button class="btn btn-ink btn-sm" data-action="call" data-url="/api/vehicles/${esc(veh.id)}/generate" data-body='${esc(JSON.stringify({ dealer_id: dealer.id }))}' data-pending="正在写…" data-success-detail="1" data-success="介绍已写好">让 AI 写一份介绍</button>
        ${card_.archived
          ? `<button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/vehicles/${esc(veh.id)}/restore" data-success-detail="1" data-success="已恢复">恢复在售</button>`
          : `<button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/vehicles/${esc(veh.id)}/archive" data-confirm="归档后不再用于内容和回复，确认？" data-success-detail="1" data-success="已归档">归档</button>`}
      </div>
      <p class="tiny muted">资料更新于 ${esc(fmtTime(veh.updated_at, tz))} · ${
        veh.knowledge_generated_at ? `AI 介绍写于 ${esc(fmtTime(veh.knowledge_generated_at, tz))}` : 'AI 还没写介绍'
      }</p>
    </div>
  </div>

  ${gallery.length > 1 ? `<div class="veh-gallery">${gallery.map((g) => `<img src="${esc(g)}" alt="${esc(card_.display_name)}" loading="lazy">`).join('')}</div>` : ''}

  <div class="veh-cols">
    <div class="stack">
      <div class="panel stack">
        ${sectionHead('事实', {
          help: ['只有这一栏里的数字，才允许出现在给客户看的笔记、私信和评论里。', '右边那一栏是文字介绍，里面不会出现没在这里填过的价格和参数。'],
        })}
        <div class="veh-block"><h3>核心参数</h3>${
          specs.length > 0
            ? `<div class="veh-specs">${specs.map((s) => `<div><span class="veh-spec-label">${esc(s.label)}</span><span class="veh-spec-value">${esc(String(s.value))}<i>${esc(s.unit)}</i></span></div>`).join('')}</div>`
            : '<p class="muted small">还没有录入参数，可以在下面「编辑」里补充。</p>'
        }</div>
        <div class="veh-block"><h3>颜色与库存</h3>${colorRows}</div>
        <div class="veh-block"><h3>金融 / 租赁方案</h3>${
          card_.finance_offers.length > 0 ? `<ul class="veh-offers">${card_.finance_offers.map(offerLine).join('')}</ul>` : '<p class="muted small">还没有有效的金融或租赁方案。</p>'
        }</div>
        <div class="veh-block"><h3>其他优惠政策</h3>${
          card_.offers.filter((o) => o.type !== 'finance' && o.type !== 'lease').length > 0
            ? `<ul class="veh-offers">${card_.offers.filter((o) => o.type !== 'finance' && o.type !== 'lease').map(offerLine).join('')}</ul>`
            : '<p class="muted small">当前没有有效优惠。</p>'
        }</div>
      </div>
      <div class="panel stack">
        ${sectionHead('修改这款车')}
        ${editForm(card_)}
      </div>
    </div>

    <div class="stack">
      <div class="panel stack">
        ${sectionHead('介绍文案', {
          help: ['这些话 AI 写、你随时可以改，是写笔记和回客户时的说法。', '里面出现的每个数字都要能在左边「事实」里找到，找不到的会被丢掉，不会发出去。'],
        })}
        <div class="veh-block"><h3>车型描述</h3>${veh.description?.trim() ? `<p class="veh-desc">${esc(veh.description)}</p>` : '<p class="muted small">还没有描述。点上面的「让 AI 写一份介绍」，或者在左边自己写。</p>'}</div>
        ${listBlock('核心卖点', veh.highlights, '还没有卖点')}
        ${listBlock('适合人群', veh.target_customers ?? [], '还没有人群画像')}
        <div class="veh-block"><h3>竞品对比</h3>${
          (veh.competitors ?? []).length > 0
            ? `<ul class="veh-list">${(veh.competitors ?? []).map((c) => `<li><b>${esc(c.name)}</b>${c.note ? ` — ${esc(c.note)}` : ''}</li>`).join('')}</ul>`
            : '<p class="muted small">还没有竞品对比。</p>'
        }</div>
        <div class="veh-block"><h3>常见问题</h3>${
          (veh.faqs ?? []).length > 0
            ? `<dl class="veh-faq">${(veh.faqs ?? []).map((f) => `<dt>${esc(f.question)}</dt><dd>${esc(f.answer)}</dd>`).join('')}</dl>`
            : '<p class="muted small">还没有常见问题。</p>'
        }</div>
        ${listBlock('小红书选题角度', veh.content_angles ?? [], '还没有选题角度')}
      </div>
    </div>
  </div>
</div>`;

  return renderPage(env, rc, {
    title: `车型 ${card_.display_name}`,
    active: 'vehicles',
    dealer,
    dealers,
    h1: esc(card_.display_name),
    help: SOURCE_OF_TRUTH_HELP,
    subtitle: dealer.name,
    body,
  });
}
