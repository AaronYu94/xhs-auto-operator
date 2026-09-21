/**
 * The public site (yuke-ai.com): what the product does, shown on a real store's console, a real demo-request form,
 * and one way in for existing customers (客户登录 → /login).
 *
 * Constraints it keeps: no script (CSP script-src 'self'; the mobile menu is <details>), no external fonts, images or
 * CDNs (it must load on a mainland network), and no invented numbers or quotes. The screenshots and the case figures
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
    ['111', '篇公开笔记', '按门店的车型和城市搜到的'],
    ['2,594', '条评论', '一条条读过'],
    ['225', '个候选', '像是在问车、问价的人'],
    ['196', '个被排除', '同行销售号、老车主、闲聊的'],
    ['29', '位买家', '进了线索收件箱，每人一个负责账号'],
  ] as [string, string, string][],
  more: [
    ['44', '款在售车型建成卡片，价格和参数都有出处'],
    ['17 → 13', '从门店号自己的 17 篇笔记里，学出 13 条写法'],
  ] as [string, string][],
};

/** What the rest of the product does. Words only: no drawn mock-ups standing in for the real thing. */
const CAPABILITIES: [string, string, string[]][] = [
  [
    '私信与跟进',
    '私信先过 10 道检查，再等你点头',
    ['勿扰名单、是否联系过、账号状态、每日上限、说的价格对不对，逐项检查', '你点头才发，可以由账号自己的登录状态发，也可以销售发完回来登记', '发送结果不确定时绝不自动重发，不会给同一个人发两遍'],
  ],
  [
    '内容运营',
    '每个账号，按它自己的写法发笔记',
    ['先读这个号以前的笔记，学它的标题长短、语气和结尾，写出来还是它的味道', '和旧笔记太像的直接退回重写，不照搬', '同一款车、同一个主题，不会在几个号里重复发'],
  ],
  [
    '车型库',
    '价格和参数，只认门店自己的数据',
    ['指导价、当前售价、参数、颜色、现车、优惠，做成一张张车型卡', 'AI 帮你写介绍和卖点，卡片上没有的数字一律删掉', '归档一款车，它会同时从笔记、私信和回复里退场'],
  ],
  [
    '多账号与消息',
    '5 个号、10 个号，一个人就管得过来',
    ['每个号单独扫码登录，互不影响，内容不会发错号', '评论和@、赞和收藏、新增关注都收进来，评论里要买车的变成线索', '客户属于门店，销售离职或换号，客户自动回到门店重新分配'],
  ],
];

const DAY: [string, string][] = [
  ['08:00', '刷新门店资料，逐个检查账号登录'],
  ['08:30', '看同行和买家最近在聊什么'],
  ['09:00', '给每个账号排好当天的笔记'],
  ['09:30', '按搜索词读公开笔记和评论，找买车的人'],
  ['每小时', '分配客户，写私信草稿，写笔记并核对'],
  ['每 30 分钟', '处理客户回复，起草跟进'],
  ['18:00', '回收已发笔记的数据'],
  ['20:00', '晚间复盘，出经营日报'],
];

const FAQ: [string, string][] = [
  [
    '会不会被小红书封号？',
    '所有动作都用你们自己账号的登录状态完成，节奏接近真人：每个号一次只做一件事，私信和发布都有每日上限，先给人看过再发。但平台规则由小红书决定，没有人能保证一定不被限流，我们也不会这样承诺。',
  ],
  [
    '客户的私信回复能自动收进来吗？',
    '小红书没有给门店开放读取私信的官方接口。现在的做法是销售把客户的话贴进来，AI 接着起草回复；评论、点赞、关注这三类消息可以自动读取。',
  ],
  ['需要准备几个账号？', '一个号就能用起来。我们建议逐步做到 5 个以上定位不同的号：门店官方号、几个销售的个人号、再加一个讲车或讲本地用车的号，覆盖的人群才不一样。'],
  ['价格、库存这些数据从哪里来？', '只从门店自己录入的车型库和库存里来。可以一次性导入价格表，之后在控制台里改。没有录入的数字，AI 一律不说。'],
  ['数据放在哪里？', '部署在你们自己的服务器上，客户资料和账号登录状态都在你们手里。大模型是可选的：不接也能完整运行，接了之后它写的每一句也要先过核对。'],
  ['多久能用起来？', '门店资料和车型导入、账号扫码登录完成后，当天就开始找客户。演示时我们会用你们自己的车型和城市走一遍。'],
  ['怎么收费？', '按门店规模和账号数量报价。预约演示后，我们会根据你们的实际情况给出方案。'],
];

const ACCOUNT_OPTIONS = ['1 个', '2-4 个', '5-9 个', '10 个以上', '还没有开始'];

function demoForm(state: LandingState): string {
  const v = state.values ?? {};
  const val = (k: string) => esc(v[k] ?? '');
  if (state.sent) {
    return `<div class="form-done" role="status"><h3>收到了</h3><p>我们会尽快打电话给你，约一个方便的时间，用你们自己的车型和城市演示一遍。</p></div>`;
  }
  return `<form class="demo-form" method="post" action="/demo-request" novalidate>
  ${state.error ? `<p class="form-error" role="alert">${esc(state.error)}</p>` : ''}
  <div class="field-row">
    <label class="field"><span class="field-label">称呼</span><input name="name" required maxlength="40" autocomplete="name" value="${val('name')}"></label>
    <label class="field"><span class="field-label">手机</span><input name="phone" required maxlength="24" inputmode="tel" autocomplete="tel" value="${val('phone')}"></label>
  </div>
  <label class="field"><span class="field-label">门店或公司</span><input name="company" required maxlength="80" autocomplete="organization" value="${val('company')}"></label>
  <div class="field-row">
    <label class="field"><span class="field-label">所在城市<span class="opt">选填</span></span><input name="city" maxlength="30" value="${val('city')}"></label>
    <label class="field"><span class="field-label">现在运营的小红书号<span class="opt">选填</span></span><select name="accounts"><option value="">请选择</option>${ACCOUNT_OPTIONS.map((o) => `<option${v.accounts === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></label>
  </div>
  <label class="field"><span class="field-label">想重点了解的<span class="opt">选填</span></span><textarea name="message" rows="3" maxlength="500">${val('message')}</textarea></label>
  <button class="btn btn-primary btn-block" type="submit">预约演示</button>
  <p class="form-note">只用于联系你安排演示，不会发给第三方。</p>
</form>`;
}


function lockup(mark: string): string {
  return `<a class="lockup" href="/" aria-label="${BRAND} 首页">${mark}<span class="lockup-zh">驭客</span><span class="lockup-en">STEER</span></a>`;
}

/** A real console screen in a quiet window frame, with the caption that says where it came from. */
function screen(src: string, alt: string, caption: string, w: number, h: number, cls = ''): string {
  return `<figure class="shot ${cls}"><div class="shot-frame"><span class="shot-dots" aria-hidden="true"><i></i><i></i><i></i></span></div><img src="${src}" alt="${esc(alt)}" width="${w}" height="${h}" loading="lazy" decoding="async"><figcaption>${esc(caption)}</figcaption></figure>`;
}

export function landingPage(state: LandingState = {}): string {
  const mark = markSvg('site-mark');
  const links = `<a href="#case">客户案例</a><a href="#product">产品</a><a href="#how">怎么运转</a><a href="#trust">可靠性</a><a href="#faq">常见问题</a>`;
  const masked = `${CASE.name}的真实控制台，客户的名字、头像和原话已打码`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${BRAND}：替汽车门店运营小红书的 AI 员工</title>
<meta name="description" content="在小红书公开笔记和评论里找到正在买车的人，替每个账号写笔记、起草私信。为同时运营多个小红书账号的汽车门店设计。">
<link rel="stylesheet" href="/assets/site.css?v=${ASSET_VERSION}">
</head>
<body class="site">
${SVG_DEFS}
<header class="site-nav">
  <div class="wrap nav-inner">
    ${lockup(mark)}
    <nav class="nav-links" aria-label="页面导航">${links}</nav>
    <div class="nav-cta"><a class="btn btn-ghost" href="/login">客户登录</a><a class="btn btn-primary" href="#demo">预约演示</a></div>
    <details class="nav-menu"><summary aria-label="打开菜单">菜单</summary><div class="nav-menu-body">${links}<a href="/login">客户登录</a><a href="#demo">预约演示</a></div></details>
  </div>
</header>

<main>
<section class="hero">
  <div class="wrap">
    <div class="hero-grid">
      <div class="hero-copy">
        <p class="kicker">Turn intent into customers.</p>
        <h1><span class="nw">在小红书上，</span><span class="nw">找到正在买车的人</span></h1>
      </div>
      <div class="hero-side">
        <p class="hero-sub">驭客是替汽车门店运营小红书的 AI 员工：读公开笔记和评论，把真想买车的人挑出来，交给最合适的账号去跟；再按每个号自己的写法写笔记。你只需要点头。</p>
        <div class="hero-cta"><a class="btn btn-primary btn-lg" href="#demo">预约演示</a><a class="btn btn-ghost btn-lg" href="#case">看真实案例</a></div>
      </div>
    </div>
    ${screen(siteImageUrl('leads.webp'), `${CASE.name}的线索收件箱`, `线索收件箱 · ${masked}`, 2000, 1250, 'shot-hero')}
  </div>
</section>

<section class="case" id="case">
  <div class="wrap">
    <div class="case-head">
      <p class="case-label">客户案例 · ${esc(CASE.name)}</p>
      <h2><span class="nw">上线头三天，</span><span class="nw">从 2,594 条评论里</span><span class="nw">找出 29 位买家</span></h2>
      <p class="case-store">${esc(CASE.store)}，一个门店号，一个找客户用的号。</p>
    </div>
    <ol class="funnel">${CASE.funnel.map(([n, unit, what], i) => `<li${i === CASE.funnel.length - 1 ? ' class="is-end"' : ''}><b>${esc(n)}</b><span class="unit">${esc(unit)}</span><span class="what">${esc(what)}</span></li>`).join('')}</ol>
    <div class="case-more">${CASE.more.map(([n, what]) => `<p><b>${esc(n)}</b><span>${esc(what)}</span></p>`).join('')}</div>
    <p class="case-note">数据时间：${esc(CASE.period)}，读自门店控制台。196 个被排除的人，每一个都记着排除理由。</p>
  </div>
</section>

<section class="section" id="product">
  <div class="wrap">
    <div class="feature">
      <div class="feature-copy">
        <p class="eyebrow">找客户</p>
        <h2><span class="nw">每一个客户，</span><span class="nw">都说得清为什么</span></h2>
        <p>它按门店的车型、城市和竞品生成搜索词，每天去读公开内容。谁在问价、问现车、比车型，谁只是同行或老车主，分得清清楚楚。</p>
        <ul class="ticks">
          <li>购车意向拆成 10 项打分，每一分的依据都写在旁边</li>
          <li>不在你们卖车的地方，分数会被压低</li>
          <li>留着客户自己的原话和原帖，随时点回去看</li>
        </ul>
      </div>
      ${screen(siteImageUrl('lead-score.webp'), '一位客户的意向分拆解', '一位客户的意向分拆解 · 来自舟山小鹏', 965, 1094, 'shot-tall')}
    </div>

    <div class="feature feature-wide">
      <div class="feature-copy">
        <div><p class="eyebrow">复盘</p>
        <h2><span class="nw">哪个搜索词带来客户，</span><span class="nw">一目了然</span></h2></div>
        <p>每个搜索词一笔账：搜了几次、看了多少人、找到几个像要买车的、约到几个、成交几单。效果差的会被换掉，下周搜得更准。</p>
      </div>
      ${screen(siteImageUrl('search-terms.webp'), '按搜索词统计带来的客户', '搜索词效果 · 舟山小鹏的前三天，0 的词还没轮到搜', 1600, 517)}
    </div>

    <div class="caps">
      <h2 class="caps-title">其余的活，它也在做</h2>
      <div class="caps-grid">${CAPABILITIES.map(([tag, title, points]) => `<article class="cap"><p class="eyebrow">${esc(tag)}</p><h3>${esc(title)}</h3><ul>${points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></article>`).join('')}</div>
    </div>
  </div>
</section>

<section class="section section-tint" id="how">
  <div class="wrap how-grid">
    <div class="how-copy">
      <h2><span class="nw">按门店所在城市的时间，</span><span class="nw">每天自己跑</span></h2>
      <p>不用人盯着。每一步做了什么、结果如何都记下来；中途断了，从断的那一步接着做，不会重复发私信或重复发笔记。</p>
      <p class="how-you"><b>你要做的只有一件事：</b>看一眼它写的私信和笔记，点「这样可以」。</p>
    </div>
    <ol class="day">${DAY.map(([t, what]) => `<li><time>${esc(t)}</time><span>${esc(what)}</span></li>`).join('')}</ol>
  </div>
</section>

<section class="section" id="trust">
  <div class="wrap">
    <h2>它不会做的事</h2>
    <div class="rules">
      <div class="rule rule-lead"><h3>不编价格和参数</h3><p>写笔记、发私信、回客户说的每一个数字，都必须在门店的车型库里找得到。找不到就不说，写了也会在发出前被删掉。</p></div>
      <div class="rule"><h3>不冒充「已发送」</h3><p>只有在会话里亲眼看到这条私信，才算发出去。结果不确定时交给人确认，绝不自动重发。</p></div>
      <div class="rule"><h3>不串号</h3><p>每个账号独立登录。一个号的内容和私信，不会从另一个号发出。</p></div>
      <div class="rule"><h3>不把看不到的当成没有</h3><p>账号掉登录，会直接告诉你「要重新扫码」，而不是显示「今天没有新客户」。</p></div>
      <div class="rule"><h3>每一步都有据可查</h3><p>谁是买家、为什么给这个号、这条私信为什么这么写，依据都记着，可以一条条往回查。</p></div>
    </div>
  </div>
</section>

<section class="section section-tint" id="deploy">
  <div class="wrap">
    <div class="deploy-head">
      <h2><span class="nw">部署在</span><span class="nw">你们自己的服务器上</span></h2>
      <p class="deploy-lede">客户资料、账号登录状态、每一次操作记录，都在你们掌控的服务器里。</p>
    </div>
    <div class="deploy-groups">
      <div><h3>怎么用</h3><ul><li>浏览器打开门店自己的域名，HTTPS 加密</li><li>也可以装桌面 App，Mac 和 Windows 都支持</li><li>手机上同样能看、能点头</li></ul></div>
      <div><h3>谁能进</h3><ul><li>每个人用自己的账号登录</li><li>谁在什么时候做了什么，都记在操作记录里</li><li>人员离职，停用账号即可</li></ul></div>
      <div><h3>AI 用在哪</h3><ul><li>大模型是可选的，不接也能完整运行</li><li>接了之后，它写的每一句都要过核对才会用</li></ul></div>
    </div>
  </div>
</section>

<section class="section" id="faq">
  <div class="wrap faq-grid">
    <h2>常见问题</h2>
    <div class="faq">${FAQ.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div>
  </div>
</section>

<section class="demo" id="demo">
  <div class="wrap demo-grid">
    <div class="demo-copy">
      <p class="kicker">Turn intent into customers.</p>
      <h2><span class="nw">用你们自己的车型，</span><span class="nw">看它跑一遍</span></h2>
      <p>留下联系方式，我们约一个时间，用门店真实的车型和城市演示：它会怎么找客户、写出什么样的私信和笔记。</p>
      <p class="demo-login">已经是客户？<a href="/login">客户登录</a></p>
    </div>
    <div class="demo-card">${demoForm(state)}</div>
  </div>
</section>
</main>

<footer class="site-foot">
  <div class="wrap foot-inner">
    ${lockup(mark)}
    <nav aria-label="页脚"><a href="#case">客户案例</a><a href="#product">产品</a><a href="#faq">常见问题</a><a href="#demo">预约演示</a><a href="/login">客户登录</a></nav>
    <p class="foot-copy">© 2026 驭客 Steer</p>
  </div>
</footer>
</body></html>`;
}
