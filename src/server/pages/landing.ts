/**
 * The public site (yuke-ai.com): what the product does, shown on a real store's console, a real demo-request form,
 * and one way in for existing customers (客户登录 → /login).
 *
 * Constraints it keeps: no external fonts, images or CDNs (it must load on a mainland network); one same-origin script
 * that only adds pointer tilt to the 3D pieces, so the page is whole without it (the flow is SMIL, the tilt-on-scroll
 * is a CSS scroll timeline, the mobile menu is <details>); and no invented numbers or quotes. The screenshots and the case figures
 * come from one customer store that agreed to be named (CASE); every Xiaohongshu user in them is blurred, and the
 * figures carry the dates they were read on.
 */
import { ASSET_VERSION } from '../assets.ts';
import { BRAND, SVG_DEFS, esc, markSvg } from '../render.ts';
import { siteImageUrl } from '../site-images.ts';

export interface LandingState {
  /** the demo request was stored */
  sent?: boolean;
  /** what went wrong with the submitted form, in the visitor's language */
  error?: string | null;
  /** the visitor's own input, echoed back when the form is shown again */
  values?: Record<string, string>;
}

/**
 * The one customer on the page. Figures were read from that store's console for the dates given and are never
 * rounded up; the screenshots on the page were taken on the same console.
 */
const CASE = {
  name: '舟山小鹏',
  store: '小鹏汽车舟山甬东汽车城销售服务中心',
  period: '2026 年 9 月 19 日至 21 日',
  funnel: [
    ['111', '篇公开笔记', '按车型和城市搜索'],
    ['2,594', '条评论', '逐条读取分析'],
    ['225', '位候选', '有问价、问车迹象'],
    ['196', '位已排除', '同行、车主、闲聊'],
    ['29', '位意向客户', '专属账号跟进'],
  ] as [string, string, string][],
  more: [
    ['44', '款在售车型建档，价格参数有据可查'],
    ['17 → 13', '学习门店号 17 篇历史笔记，总结出 13 条写作风格'],
  ] as [string, string][],
};

/** What the rest of the product does. Words only: no drawn mock-ups standing in for the real thing. */
const CAPABILITIES: [string, string, string[]][] = [
  [
    '私信跟进',
    '10 道发送前检查，安全触达',
    ['勿扰名单、重复联系、账号状态、每日上限、价格准确性，逐项核查', '确认后发送：由账号自动发出，或销售手动发送后登记', '发送结果不明时不重发，杜绝重复打扰客户'],
  ],
  [
    '内容运营',
    '学习账号风格，笔记不串味',
    ['分析每个号的历史笔记：标题长度、语气、表情、结尾引导', '与历史内容过于相似的，自动退回重写', '同车型、同主题，不在多个号重复发布'],
  ],
  [
    '车型库',
    '价格参数，只用门店真实数据',
    ['指导价、售价、参数、颜色、现车、优惠，一车一档', 'AI 撰写卖点与介绍，无出处的数字自动删除', '车型下架后，笔记、私信、回复同步停用'],
  ],
  [
    '多账号管理',
    '5 个、10 个账号，一人轻松管理',
    ['每个号独立扫码登录，互不干扰，杜绝发错号', '评论和@、赞和收藏、新增关注统一收取，意向评论自动转为线索', '客户归门店所有，销售离职，客户不流失'],
  ],
];

const DAY: [string, string][] = [
  ['08:00', '更新门店资料，检查各账号登录状态'],
  ['08:30', '分析同行与买家近期关注的话题'],
  ['09:00', '为各账号排好当日笔记'],
  ['09:30', '读取公开笔记和评论，筛选意向客户'],
  ['每小时', '分配线索，起草私信，撰写并核查笔记'],
  ['每 30 分钟', '处理客户回复，起草跟进话术'],
  ['18:00', '回收已发笔记数据'],
  ['20:00', '晚间复盘，生成经营日报'],
];

const FAQ: [string, string][] = [
  [
    '会不会被小红书封号？',
    '所有操作都通过贵店自己账号的登录状态完成，节奏接近真人：每个账号同一时间只执行一项任务，私信和发布均设有每日上限，并经人工确认后发出。平台规则以小红书为准，任何工具都无法保证一定不被限流，我们也不做这样的承诺。',
  ],
  [
    '客户的私信回复能自动收取吗？',
    '小红书目前没有向门店开放读取私信的官方接口。客户回复需由销售粘贴到系统中，AI 据此起草回复；评论和@、赞和收藏、新增关注三类消息可以自动读取。',
  ],
  ['需要准备几个账号？', '1 个账号即可上手。建议逐步扩展到 5 个以上定位不同的账号，例如门店官方号、销售个人号、车型讲解号，覆盖更多人群。'],
  ['价格、库存数据从哪里来？', '全部来自门店自行录入的车型库和库存，支持价格表批量导入，之后可在后台随时修改。未录入的数字，AI 一律不写。'],
  ['数据存放在哪里？', '部署在贵店自己的服务器上，客户资料和账号登录状态由您掌控。大模型为可选项：不接入也能完整运行；接入后，AI 写的每一句话同样要先经过核查。'],
  ['多久能上线？', '导入门店资料和车型、完成账号扫码登录后，当天即可开始获客。演示时，我们会用贵店的车型和城市实际运行一遍。'],
  ['如何收费？', '根据门店规模和账号数量定制报价。预约演示后，我们会结合贵店的实际情况提供方案。'],
];

const ACCOUNT_OPTIONS = ['1 个', '2-4 个', '5-9 个', '10 个以上', '暂未开设'];

function demoForm(state: LandingState): string {
  const v = state.values ?? {};
  const val = (k: string) => esc(v[k] ?? '');
  if (state.sent) {
    return `<div class="form-done" role="status"><h3>提交成功</h3><p>我们会尽快致电您，约定演示时间，用贵店的真实车型和城市现场演示。</p></div>`;
  }
  return `<form class="demo-form" method="post" action="/demo-request" novalidate>
  ${state.error ? `<p class="form-error" role="alert">${esc(state.error)}</p>` : ''}
  <div class="field-row">
    <label class="field"><span class="field-label">您的称呼</span><input name="name" required maxlength="40" autocomplete="name" value="${val('name')}"></label>
    <label class="field"><span class="field-label">手机号</span><input name="phone" required maxlength="24" inputmode="tel" autocomplete="tel" value="${val('phone')}"></label>
  </div>
  <label class="field"><span class="field-label">门店 / 公司名称</span><input name="company" required maxlength="80" autocomplete="organization" value="${val('company')}"></label>
  <div class="field-row">
    <label class="field"><span class="field-label">所在城市<span class="opt">选填</span></span><input name="city" maxlength="30" value="${val('city')}"></label>
    <label class="field"><span class="field-label">目前运营的小红书账号<span class="opt">选填</span></span><select name="accounts"><option value="">请选择</option>${ACCOUNT_OPTIONS.map((o) => `<option${v.accounts === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></label>
  </div>
  <label class="field"><span class="field-label">想重点了解的功能<span class="opt">选填</span></span><textarea name="message" rows="3" maxlength="500">${val('message')}</textarea></label>
  <button class="btn btn-primary btn-block" type="submit">立即预约</button>
  <p class="form-note">信息仅用于安排演示，不会提供给任何第三方。</p>
</form>`;
}

function lockup(mark: string): string {
  return `<a class="lockup" href="/" aria-label="${BRAND} 首页">${mark}<span class="lockup-zh">驭客</span><span class="lockup-en">STEER</span></a>`;
}

/** A light cut of the mark for the dark band: the shared symbol's gradients are fixed to the page's own theme. */
const LIGHT_MARK = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<linearGradient id="lm-u" x1="250" y1="30" x2="60" y2="220" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#F1EEE7"/><stop offset="1" stop-color="#C9C4BA"/></linearGradient>
<radialGradient id="lm-f" cx="95" cy="205" r="80" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#8E897F"/><stop offset="1" stop-color="#E9E6DF"/></radialGradient>
<linearGradient id="lm-l" x1="272" y1="205" x2="55" y2="355" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#E6D2AE"/><stop offset=".45" stop-color="#C4A97F"/><stop offset="1" stop-color="#6F6A61"/></linearGradient>
<symbol id="lm" viewBox="28 12 256 368"><path fill="url(#lm-u)" d="M234 22C256 14 274 36 265 61C261 72 253 80 243 86L101 167L56 202C38 189 28 169 31 147C34 125 46 109 63 100Z"/><path fill="url(#lm-f)" d="M106 171L212 186L108 234L58 205C50 200 44 194 40 187C52 178 78 172 106 171Z"/><path fill="url(#lm-l)" d="M213 184C247 176 276 196 279 226C281 246 272 258 257 267L86 367C64 379 44 372 42 350C40 328 48 309 66 297Z"/></symbol>
</defs></svg>`;

/** The mark as a solid: the same outline stacked in depth, so it turns like an object rather than a sticker. */
function solidMark(): string {
  const layers = Array.from({ length: 18 }, (_, i) => `<svg class="solid-layer" style="--z:${i}" aria-hidden="true"><use href="#lm"/></svg>`).join('');
  return `<div class="solid" data-tilt><div class="solid-spin">${layers}</div></div>`;
}

/**
 * The flow from the brand kit, drawn edge to edge with one store's real counts: public notes and comments run into
 * Steer, one lead comes out. The lead on the chip is a real one from that store, reduced to facts that name nobody.
 */
function flow(): string {
  const ys = [34, 74, 114, 154, 194, 234, 270];
  const lanes = ys.map((y, i) => `<path class="lane" id="fl${i}" d="M0 ${y} C300 ${y} 330 150 560 150"/>`).join('');
  const dots = [
    [0, 5.2, 0.3], [1, 6.1, 2.2], [2, 5.4, 4.1], [3, 5.8, 1.1], [4, 5.0, 3.3], [5, 6.3, 0.7], [6, 5.6, 2.9],
    [1, 5.5, 4.6], [3, 6.0, 5.1], [5, 5.1, 1.8], [2, 6.4, 3.7], [4, 5.9, 5.6],
  ] as const;
  const particle = (cls: string, r: number, path: string, dur: number, begin: number, peak: number) =>
    `<circle class="${cls}" r="${r}" opacity="0"><animateMotion dur="${dur}s" begin="-${begin}s" repeatCount="indefinite"><mpath href="#${path}"/></animateMotion><animate attributeName="opacity" values="0;${peak};${peak};0" keyTimes="0;.12;.86;1" dur="${dur}s" begin="-${begin}s" repeatCount="indefinite"/></circle>`;
  const incoming = dots.map(([lane, dur, begin]) => particle('p-in', 3, `fl${lane}`, dur, begin, 0.65)).join('');
  const outgoing = [0, 1.4, 2.8].map((b) => particle('p-out', 4.5, 'flOut', 4.2, b, 1)).join('');
  return `<figure class="flow" aria-label="舟山小鹏：从 111 篇公开笔记和 2,594 条评论中，筛出一位新线索">
<svg viewBox="0 0 1600 304" preserveAspectRatio="xMinYMid meet" aria-hidden="true">
  <text class="src" x="70" y="20">公开笔记 111</text>
  <text class="src" x="70" y="298">评论 2,594</text>
  ${lanes}
  <path class="spine" id="flSpine" d="M560 150 L752 150"/>
  <path class="spine-out" id="flOut" d="M848 150 C960 150 990 206 1110 206 L1226 206"/>
  <g class="particles">${incoming}${outgoing}</g>
  <g class="static"><circle class="p-in" r="3" cx="180" cy="36"/><circle class="p-in" r="3" cx="250" cy="120"/><circle class="p-in" r="3" cx="130" cy="232"/><circle class="p-in" r="3" cx="470" cy="150"/><circle class="p-out" r="4.5" cx="1060" cy="190"/></g>
  <circle class="halo" cx="800" cy="150" r="48"/>
  <circle class="node" cx="800" cy="150" r="48"/>
  <use href="#st-mark" x="782" y="124" width="36" height="52"/>
  <rect class="chip" x="1232" y="164" width="344" height="84" rx="10"/>
  <text class="chip-t1" x="1260" y="199">新线索</text>
  <text class="chip-score" x="1334" y="199">意向 77</text>
  <text class="chip-t2" x="1260" y="229">温州｜意向小鹏｜咨询现车</text>
</svg>
<figcaption>${esc(CASE.name)}门店实际运行数据，统计时间 ${esc(CASE.period)}</figcaption>
</figure>`;
}

/** A real console screen in a quiet window frame. */
function screen(src: string, alt: string, w: number, h: number, cls = ''): string {
  return `<div class="shot ${cls}"><div class="shot-frame"><span class="shot-dots" aria-hidden="true"><i></i><i></i><i></i></span></div><img src="${src}" alt="${esc(alt)}" width="${w}" height="${h}" decoding="async"></div>`;
}

export function landingPage(state: LandingState = {}): string {
  const mark = markSvg('site-mark');
  const links = `<a href="#product">产品功能</a><a href="#case">客户案例</a><a href="#how">工作方式</a><a href="#trust">安全可靠</a><a href="#faq">常见问题</a>`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>驭客 Steer｜汽车门店小红书 AI 获客与运营</title>
<meta name="description" content="驭客是汽车门店的小红书 AI 运营官：从公开笔记和评论中筛出真实购车客户，线索自动分配，私信自动起草，笔记按账号风格撰写。专为多账号运营的汽车门店打造。">
<link rel="stylesheet" href="/assets/site.css?v=${ASSET_VERSION}">
<script src="/assets/site.js?v=${ASSET_VERSION}" defer></script>
</head>
<body class="site">
${SVG_DEFS}
${LIGHT_MARK}
<header class="site-nav">
  <div class="bleed nav-inner">
    ${lockup(mark)}
    <nav class="nav-links" aria-label="页面导航">${links}</nav>
    <div class="nav-cta"><a class="btn btn-ghost" href="/login">客户登录</a><a class="btn btn-primary" href="#demo">预约演示</a></div>
    <details class="nav-menu"><summary aria-label="打开菜单">菜单</summary><div class="nav-menu-body">${links}<a href="/login">客户登录</a><a href="#demo">预约演示</a></div></details>
  </div>
</header>

<main>
<section class="hero">
  <div class="bleed hero-top">
    <h1><span class="nw">汽车门店的</span><span class="nw">小红书 AI 运营官</span></h1>
    <div class="hero-side">
      <p class="kicker">专为多账号运营的汽车门店打造</p>
      <p class="hero-sub">从公开笔记和评论中筛出真实购车客户，线索自动分配，私信自动起草，笔记按账号风格撰写。多个账号，一个人就能管好。</p>
      <div class="hero-cta"><a class="btn btn-primary btn-lg" href="#demo">预约演示</a><a class="btn btn-ghost btn-lg" href="#case">查看客户案例</a></div>
    </div>
  </div>
  ${flow()}
</section>

<section class="stage" aria-label="控制台">
  <div class="bleed stage-inner" data-tilt>
    <div class="stage-tilt">${screen(siteImageUrl('leads.webp'), `${CASE.name}的线索收件箱`, 2000, 1250, 'shot-stage')}</div>
  </div>
  <p class="bleed stage-cap">线索收件箱实拍（${esc(CASE.name)}），客户信息已打码</p>
</section>

<section class="case" id="case">
  <div class="bleed case-grid">
    <div class="case-copy">
      <p class="case-label">客户案例｜${esc(CASE.name)}</p>
      <h2><span class="nw">上线 3 天，</span><span class="nw">从 2,594 条评论中</span><span class="nw">筛出 29 位意向客户</span></h2>
      <p class="case-store">${esc(CASE.store)}｜1 个门店号 + 1 个获客号</p>
      <ol class="funnel">${CASE.funnel.map(([n, unit, what], i) => `<li${i === CASE.funnel.length - 1 ? ' class="is-end"' : ''}><b>${esc(n)}</b><span class="unit">${esc(unit)}</span><span class="what">${esc(what)}</span></li>`).join('')}</ol>
      <div class="case-more">${CASE.more.map(([n, what]) => `<p><b>${esc(n)}</b><span>${esc(what)}</span></p>`).join('')}</div>
      <p class="case-note">数据来源：门店控制台，统计时间 ${esc(CASE.period)}。每位被排除的用户均有排除理由可查。</p>
    </div>
    ${solidMark()}
  </div>
</section>

<section class="product" id="product">
  <div class="bleed product-grid">
    <div class="product-copy">
      <h2><span class="nw">意向评分透明，</span><span class="nw">每条线索有据可查</span></h2>
      <p>按门店车型、城市和竞品自动生成搜索词，每天读取公开内容。问价、问现车、比车型的客户留下，同行和老车主自动排除。</p>
      <ul class="ticks">
        <li>10 项维度打分，每一分都有依据</li>
        <li>非本地用户自动降权，线索更精准</li>
        <li>搜索词效果可量化，低效词自动替换</li>
      </ul>
    </div>
    <div class="fan" data-tilt>
      <div class="fan-card fan-back">${screen(siteImageUrl('search-terms.webp'), '按搜索词统计带来的客户', 1600, 517)}</div>
      <div class="fan-card fan-front">${screen(siteImageUrl('lead-score.webp'), '一位客户的意向分拆解', 965, 1094)}</div>
    </div>
  </div>
  <div class="bleed caps">${CAPABILITIES.map(([tag, title, points]) => `<article class="cap"><h3>${esc(tag)}</h3><p class="cap-title">${esc(title)}</p><ul>${points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></article>`).join('')}</div>
</section>

<section class="how" id="how">
  <div class="bleed">
    <div class="how-head">
      <h2><span class="nw">每日自动运行，</span><span class="nw">关键环节由您把关</span></h2>
      <p>按门店所在城市的作息自动执行，中断后从断点继续，不会重复发送私信和笔记。<b>私信和笔记经您审核通过后才会发出。</b></p>
    </div>
    <ol class="day">${DAY.map(([t, what]) => `<li><time>${esc(t)}</time><span>${esc(what)}</span></li>`).join('')}</ol>
  </div>
</section>

<section class="section" id="trust">
  <div class="bleed trust-grid">
    <h2>安全可靠，边界清晰</h2>
    <div class="rules">
      <div class="rule rule-lead"><h3>价格参数，绝不编造</h3><p>笔记、私信和回复中出现的每个数字，都必须在门店车型库中有据可查；查不到的一律删除，不会发出。</p></div>
      <div class="rule"><h3>发送状态真实</h3><p>在会话中确认看到这条私信，才标记为已发送；结果不明时转人工确认，绝不自动重发。</p></div>
      <div class="rule"><h3>账号隔离</h3><p>每个账号独立登录，内容和私信只从对应账号发出，不会串号。</p></div>
      <div class="rule"><h3>异常及时提醒</h3><p>账号掉线会直接提示重新扫码，不会误报为「今日无新客户」。</p></div>
      <div class="rule"><h3>全程留痕</h3><p>买家判定、账号分配、私信措辞，每一步的依据都有记录，随时可追溯。</p></div>
    </div>
  </div>
</section>

<section class="section section-tint" id="deploy">
  <div class="bleed deploy-grid">
    <div class="deploy-head">
      <h2><span class="nw">私有化部署，</span><span class="nw">数据自主可控</span></h2>
      <p class="deploy-lede">客户资料、账号登录状态和操作记录，全部保存在贵店自己的服务器上。</p>
    </div>
    <div class="deploy-groups">
      <div><h3>使用方式</h3><ul><li>浏览器访问门店专属域名，全程 HTTPS 加密</li><li>支持 Mac、Windows 桌面客户端</li><li>手机端同样可以查看和审批</li></ul></div>
      <div><h3>权限管理</h3><ul><li>员工使用独立账号登录</li><li>所有操作全程留痕</li><li>人员离职，一键停用</li></ul></div>
      <div><h3>AI 能力</h3><ul><li>大模型可选配，不接入也能完整运行</li><li>AI 生成的内容须经核查后才会使用</li></ul></div>
    </div>
  </div>
</section>

<section class="section" id="faq">
  <div class="bleed faq-grid">
    <h2>常见问题</h2>
    <div class="faq">${FAQ.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div>
  </div>
</section>

<section class="demo" id="demo">
  <div class="bleed demo-grid">
    <div class="demo-copy">
      <h2><span class="nw">预约专属演示</span></h2>
      <p>留下联系方式，我们将尽快与您联系，用贵店的真实车型和城市现场演示：如何找客户、私信怎么写、笔记怎么发。</p>
      <p class="demo-login">已是客户？<a href="/login">客户登录</a></p>
    </div>
    <div class="demo-card">${demoForm(state)}</div>
  </div>
</section>
</main>

<footer class="site-foot">
  <div class="bleed foot-inner">
    ${lockup(mark)}
    <nav aria-label="页脚"><a href="#product">产品功能</a><a href="#case">客户案例</a><a href="#faq">常见问题</a><a href="#demo">预约演示</a><a href="/login">客户登录</a></nav>
    <p class="foot-copy">Turn intent into customers. © 2026 驭客 Steer</p>
  </div>
</footer>
</body></html>`;
}
