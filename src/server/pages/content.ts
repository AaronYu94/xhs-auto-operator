/** 内容: per-account week calendar, review queue, publishing, content → sales attribution and engagement replies. */
import { addDaysToKey, localDateKey } from '../../core/time.ts';
import type { EngagementReply, Post, PostStatus } from '../../core/types.ts';
import { getContentAttribution } from '../../skills/operations/analytics/index.ts';
import type { Reply, RequestContext } from '../http.ts';
import { queryString } from '../http.ts';
import { hint } from '../hint.ts';
import {
  ACCOUNT_TYPE,
  POST_STATUS,
  cny,
  dataBody,
  emptyState,
  esc,
  fmtTime,
  href,
  pill,
  postStatusPill,
  sectionHead,
  sourceLink,
  unfinishedBlock,
  unfinishedButton,
} from '../render.ts';
import { resultBox } from './components.ts';
import { dealerTz, latestCapability, noDealerBody, renderPage, resolveDealer, type PageEnv } from './shell.ts';

const PILLAR: Record<string, string> = {
  model_review: '车型评测',
  price_offer: '价格优惠',
  inventory_showcase: '现车展示',
  comparison: '竞品对比',
  buying_guide: '购车攻略',
  finance_explainer: '金融方案',
  customer_story: '车主故事',
  local_life: '本地生活',
  dealer_event: '门店活动',
  ownership_tips: '用车知识',
};

const ENGAGEMENT_STATUS: Record<EngagementReply['status'], [string, 'green' | 'amber' | 'red' | 'neutral']> = {
  DRAFT: ['还没发', 'neutral'],
  BLOCKED: ['已拦下', 'red'],
  READY_FOR_REVIEW: ['等你看一眼', 'amber'],
  APPROVED: ['你已通过·等发出', 'amber'],
  SENT: ['已发出', 'green'],
  SENT_MANUALLY: ['已人工发出', 'green'],
  CANCELLED: ['已取消', 'neutral'],
};

/** 发布规则 a salesperson only needs when something goes wrong: one click away, never on the page. */
const PUBLISH_HELP = [
  '图文笔记至少要有一张图片；想发视频笔记就只放一个视频文件，两者二选一。',
  '只有小红书那边确认发出去了，这里才会写「已发布」——所以不会出现「显示发了其实没发」。',
  '小红书发完不回笔记链接，所以发布后请把链接粘回来，这样才能看到这篇带来了多少客户。',
  '自动发不了的时候，就用对应账号的小红书 App 手动发一次，再回来登记链接。',
];

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function runButton(workflow: string, dealerId: string, label: string, primary = false): string {
  return `<button class="btn ${primary ? 'btn-ink' : 'btn-ghost'} btn-sm" data-action="call" data-url="/api/workflows/${esc(workflow)}/run" data-body="${dataBody({ dealer_id: dealerId })}" data-success="任务已启动，可在系统页查看进度">${esc(label)}</button>`;
}

function apiButton(url: string, dealerId: string, label: string, success: string, primary = false): string {
  return `<button class="btn ${primary ? 'btn-ink' : 'btn-ghost'} btn-sm" data-action="call" data-url="${esc(url)}" data-body="${dataBody({ dealer_id: dealerId })}" data-success="${esc(success)}">${esc(label)}</button>`;
}

/** Posts where a person is the blocker: approve it, fix it, or publish it. */
const TODO_STATUSES = ['IN_REVIEW', 'CHANGES_REQUIRED', 'READY_TO_PUBLISH', 'FAILED'] as const satisfies readonly PostStatus[];

const VIEWS = ['week', 'todo', 'published', 'replies'] as const;
type View = (typeof VIEWS)[number];

/**
 * A note the way Xiaohongshu shows one: a cover tile carrying the cover line, then the title. Before the AI writes,
 * the cover shows the topic, so an empty plan still looks like the note it will become.
 */
function noteCard(p: Post, accountName: string, dealerId: string, extra = ''): string {
  // The cover carries the cover line only. Printing the title twice (once inside the cover, once under it) read as
  // a rendering bug, and a note with no cover line has none yet — say that instead of repeating the title.
  const cover = (p.cover_text ?? '').trim();
  return `<a class="note" href="${esc(href(`/content/posts/${p.id}`, { dealer: dealerId }))}">
  <span class="note-cover${cover ? '' : ' is-blank'}">${cover ? `<span class="note-cover-text">${esc(cover.slice(0, 28))}</span>` : '<span class="note-cover-note">还没有封面</span>'}</span>
  <span class="note-body">
    <span class="note-title">${esc(p.title || p.topic.split(':').at(-1) || '待生成正文')}</span>
    <span class="note-meta">${postStatusPill(p.status)}<span class="note-meta-text">${esc(PILLAR[p.pillar] ?? p.pillar)} · ${esc(p.slot_date.slice(5))}</span></span>
    <span class="note-meta-text">${esc(accountName)}</span>
    ${extra}
  </span>
</a>`;
}

/** The week board: one row per account, one column per day, notes sitting in their slot. */
function weekBoard(posts: Post[], accounts: { id: string; nickname: string; account_type: string }[], days: string[], today: string, dealerId: string): string {
  const byCell = new Map<string, Post[]>();
  for (const p of posts) byCell.set(`${p.account_id}|${p.slot_date}`, [...(byCell.get(`${p.account_id}|${p.slot_date}`) ?? []), p]);
  return `<div class="table-wrap"><div class="board">
  <div class="board-head"></div>${days
    .map((d) => `<div class="board-head${d === today ? ' is-today' : ''}">${esc(WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()])}<span class="board-date">${esc(d.slice(5))}</span></div>`)
    .join('')}
  ${accounts
    .map((a) => {
      const week = days.reduce((n, d) => n + (byCell.get(`${a.id}|${d}`)?.length ?? 0), 0);
      return `<div class="board-acct"><span class="board-acct-name">${esc(a.nickname)}</span><span class="note-meta-text">${esc(ACCOUNT_TYPE[a.account_type as keyof typeof ACCOUNT_TYPE] ?? a.account_type)} · 本周 ${esc(week)} 篇</span></div>${days
        .map((d) => {
          const cell = byCell.get(`${a.id}|${d}`) ?? [];
          return `<div class="board-cell${d === today ? ' is-today' : ''}">${cell.length ? cell.map((p) => noteCard(p, a.nickname, dealerId)).join('') : '<span class="board-empty">—</span>'}</div>`;
        })
        .join('')}`;
    })
    .join('')}
</div></div>`;
}

function reviewResult(p: Post): string {
  if (!p.review) return '<span class="note-meta-text">还没核查过</span>';
  const ok = (label: string, passed: boolean) => `<span class="note-check${passed ? '' : ' is-bad'}">${passed ? '✓' : '✕'} ${esc(label)}</span>`;
  return `<span class="note-checks">${ok('事实核查', p.review.fact_check.passed)}${ok('合规', p.review.compliance.passed)}</span>`;
}

export function contentPage(env: PageEnv, rc: RequestContext): Reply {
  const { ctx } = env.runtime;
  const { dealer, dealers } = resolveDealer(ctx, rc);
  if (!dealer) return renderPage(env, rc, { title: '内容', active: 'content', dealer: null, dealers, h1: '内容', subtitle: '尚未配置门店', body: noDealerBody() });
  const tz = dealerTz(dealer);
  const today = localDateKey(ctx.clock.now(), tz);
  const weekParam = queryString(rc.query, 'week', 10);
  const start = weekParam && DATE_KEY.test(weekParam) ? weekParam : today;
  const days = Array.from({ length: 7 }, (_, i) => addDaysToKey(start, i));
  const accounts = ctx.db.table('xhs_accounts').findMany({ dealer_id: dealer.id, removed_at: null }, { orderBy: 'created_at ASC' });
  const accountName = new Map(accounts.map((a) => [a.id, a.nickname]));
  const weekPosts = ctx.db.table('posts').query('dealer_id = ? AND slot_date >= ? AND slot_date <= ?', [dealer.id, days[0], days[6]], { orderBy: 'slot_date ASC, created_at ASC' });
  const todo = ctx.db.table('posts').findMany({ dealer_id: dealer.id, status: [...TODO_STATUSES] }, { orderBy: 'slot_date ASC', limit: 60 });
  const replies = ctx.db.table('engagement_replies').findMany({ dealer_id: dealer.id, status: ['READY_FOR_REVIEW', 'APPROVED', 'BLOCKED'] }, { orderBy: 'created_at DESC', limit: 50 });
  const attribution = getContentAttribution(ctx, { dealer_id: dealer.id, from: addDaysToKey(today, -90) });
  const vehicles = Number(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM vehicles WHERE group_id = ?', dealer.group_id)?.n ?? 0);
  const planned = Number(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM posts WHERE dealer_id = ? AND status IN ('PLANNED', 'DRAFTED')", dealer.id)?.n ?? 0);

  const counts = { week: weekPosts.length, todo: todo.length, published: attribution.length, replies: replies.length };
  const wanted = queryString(rc.query, 'view');
  // Land where the work is: an operator opening this page should see what waits for them, not an empty calendar.
  const view: View = (VIEWS as readonly string[]).includes(wanted ?? '') ? (wanted as View) : counts.todo > 0 ? 'todo' : 'week';

  const banner =
    accounts.length === 0
      ? `<div class="banner banner-amber"><b>还没有账号</b>：笔记是按账号排期的。先在「账号」页添加并登录一个小红书账号。</div>`
      : vehicles === 0
        ? `<div class="banner banner-amber"><b>还没有车型资料</b>：AI 不会编价格和现车，现在只能写不涉及这些的内容。${hint('AI 说的价格、指导价、现车台数和优惠，只能来自你在「车型」里填的那些。一条都没填，它就一个数字都不敢写。')}<a class="link" href="${esc(href('/setup', { dealer: dealer.id }))}#vehicles">去添加车型</a></div>`
        : '';

  // One action, and never the tab the operator is already looking at.
  const primary =
    accounts.length === 0
      ? `<a class="btn btn-ink btn-sm" href="${esc(href('/accounts', { dealer: dealer.id }))}">去账号页</a>`
      : counts.todo > 0 && view !== 'todo'
        ? `<a class="btn btn-ink btn-sm" href="${esc(href('/content', { dealer: dealer.id, view: 'todo' }))}">处理 ${counts.todo} 篇等你的笔记</a>`
        : planned > 0
          ? runButton('content_publishing', dealer.id, `撰写并核查 ${planned} 篇选题`, true)
          : runButton('account_planning', dealer.id, '让 AI 排下周选题', true);
  const more = `<details class="filters-more"><summary>更多操作</summary><div class="filters-more-row">
  ${runButton('account_planning', dealer.id, '排下周选题')}
  ${runButton('content_publishing', dealer.id, '撰写并核查到期选题')}
  ${apiButton('/api/posts/publish-due', dealer.id, '发布到期笔记', '到期的都处理了；缺图片或要手动发的会单独标出来')}
  ${apiButton('/api/performance/collect', dealer.id, '更新笔记数据', '能读到的点赞、收藏、评论已经更新')}
</div></details>`;

  const tab = (key: View, label: string, n: number) =>
    `<a class="im-tab${view === key ? ' is-on' : ''}" href="${esc(href('/content', { dealer: dealer.id, view: key, week: key === 'week' && weekParam ? weekParam : undefined }))}">${esc(label)}${n > 0 ? `<span class="tab-n">${esc(n)}</span>` : ''}</a>`;
  const tabs = `<div class="view-tabs">${tab('week', '本周要发什么', counts.week)}${tab('todo', '等你处理', counts.todo)}${tab('published', '发出去之后', counts.published)}${tab('replies', '评论回复', counts.replies)}</div>`;

  let main = '';
  if (view === 'week') {
    const nav = `<a class="btn btn-ghost btn-sm" href="${esc(href('/content', { dealer: dealer.id, week: addDaysToKey(start, -7) }))}">← 上一周</a><a class="btn btn-ghost btn-sm" href="${esc(href('/content', { dealer: dealer.id }))}">本周</a><a class="btn btn-ghost btn-sm" href="${esc(href('/content', { dealer: dealer.id, week: addDaysToKey(start, 7) }))}">下一周 →</a>`;
    main = `${sectionHead(`${days[0]} 至 ${days[6]}`, {
      help: ['一行是一个账号，一列是一天，格子里就是那天要发的笔记。', '同一款车、同一个主题不会在几个账号里重复发，避免几个号看起来像一个号。'],
      right: nav,
    })}
${accounts.length ? weekBoard(weekPosts, accounts, days, today, dealer.id) : emptyState('还没有账号，先在「账号」页添加。')}
${accounts.length && counts.week === 0 ? `<p class="st-help" style="margin-top:12px">这一周还没有排选题。点上面的「让 AI 排下周选题」，它会按每个账号的人设和主推车型排出一周不重复的选题。</p>` : ''}`;
  } else if (view === 'todo') {
    main = `${sectionHead('等你处理', {
      live: true,
      help: [
        '「事实核查」查这篇里的价格、现车、优惠是不是都能在你填的车型和门店资料里找到。',
        '「合规」查有没有平台不让说的话，比如绝对化用语、承诺收益这类。',
        '两项都打勾，也还要你点一下头才会发。',
      ],
    })}
${
      todo.length
        ? `<div class="note-grid">${todo
            .map((p) =>
              noteCard(
                p,
                accountName.get(p.account_id) ?? '',
                dealer.id,
                `<span class="note-foot">${reviewResult(p)}<span class="btn btn-ghost btn-sm">${p.status === 'IN_REVIEW' ? '去看一眼' : p.status === 'READY_TO_PUBLISH' ? '去发布' : '去处理'}</span></span>`,
              ),
            )
            .join('')}</div>`
        : emptyState('没有等你处理的笔记。AI 写完并通过事实与合规核查后，笔记会排在这里等你点头。')
    }`;
  } else if (view === 'published') {
    const rows = [...attribution].sort((a, b) => b.won - a.won || b.appointments - a.appointments || b.qualified_leads - a.qualified_leads);
    main = `${sectionHead('发出去之后', {
      note: '近 90 天，按成交排前面',
      help: ['排序看的是成交、到店预约和有效客户，不是点赞收藏。', '哪篇真的带来了人，就排在最前面。'],
    })}
${
      rows.length
        ? `<div class="note-grid">${rows
            .map((r) => {
              const post = ctx.db.table('posts').get(r.post_id);
              const stat = (label: string, value: string) => `<span class="note-stat"><b>${esc(value)}</b>${esc(label)}</span>`;
              const foot = `<span class="note-stats">${stat('线索', String(r.leads))}${stat('预约', String(r.appointments))}${stat('成交', String(r.won))}${r.won_value > 0 ? stat('成交额', cny(r.won_value)) : ''}</span>`;
              return post ? noteCard(post, r.account_nickname, dealer.id, foot) : '';
            })
            .join('')}</div>`
        : emptyState('还没有已发布的笔记。发布并跑一段时间后，这里按每篇带来的线索、预约和成交排序。')
    }
<div class="block">${unfinishedBlock('own_note_reconcile')}</div>`;
  } else {
    const replyCap = latestCapability(ctx, 'reply_comments', null);
    const cards = replies.map((r) => {
      const comment = ctx.db.table('public_comments').get(r.public_comment_id);
      const pp = comment ? ctx.db.table('public_posts').get(comment.public_post_id) : undefined;
      const [label, tone] = ENGAGEMENT_STATUS[r.status];
      const editable = r.status === 'READY_FOR_REVIEW' || r.status === 'APPROVED';
      return `<div class="reply-card" id="er-${esc(r.id)}">
  <div class="reply-quote">“${esc(comment?.content ?? '')}”</div>
  <div class="note-meta-text">${esc(comment?.author_nickname ?? '')} 在《${esc(pp?.title ?? '')}》下 ${sourceLink(pp?.url)} · ${pill(label, tone)}</div>
  ${editable ? `<textarea name="message" id="er-text-${esc(r.id)}">${esc(r.message)}</textarea>` : `<div class="reply-text">${esc(r.message)}</div>`}
  ${
    editable
      ? `<div class="row">
    <button class="btn btn-ghost btn-sm" data-action="copy" data-target="#er-text-${esc(r.id)}">复制</button>
    ${r.status === 'READY_FOR_REVIEW' ? `<button class="btn btn-ink btn-sm" data-action="call" data-url="/api/engagement-replies/${esc(r.id)}/approve" data-form="#er-${esc(r.id)}" data-success="已通过">这样可以，通过</button>` : ''}
    ${r.status === 'APPROVED' && replyCap?.status === 'AVAILABLE' ? `<button class="btn btn-primary btn-sm" data-action="call" data-url="/api/engagement-replies/${esc(r.id)}/send" data-success="已提交，以平台确认为准">通过平台回复</button>` : ''}
    <button class="btn btn-primary btn-sm" data-action="call" data-url="/api/engagement-replies/${esc(r.id)}/mark-sent" data-confirm="确认已在小红书回复？再点一次" data-success="已登记">我已在小红书回复</button>
    <span class="spacer"></span>
    <button class="btn btn-danger btn-sm" data-action="call" data-url="/api/engagement-replies/${esc(r.id)}/cancel" data-body="${dataBody({ reason: '运营取消' })}" data-success="已取消">取消</button>
  </div>`
      : ''
  }
</div>`;
    });
    main = `${sectionHead('评论回复', {
      note: '只回自己笔记下的评论',
      help: ['我们不去陌生人的笔记下面刷评论，只回自家笔记下客户问的问题。', 'AI 先写好，你改一改点通过；能自动发的就自动发，不能的你复制去小红书发完回来点一下。'],
      right: `<button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/engagement-replies/draft" data-body="${dataBody({ dealer_id: dealer.id })}" data-success="已起草回复">起草评论回复</button>`,
    })}
${cards.length ? `<div class="reply-list">${cards.join('')}</div>` : emptyState('没有待回复的评论。采集到自家笔记下的新评论后，AI 会先起草回复，你审核后发出。')}`;
  }

  // One toolbar: what you are looking at on the left, what you can do on the right.
  const body = `<div class="toolbar">${tabs}<span class="spacer"></span>${more}${primary}</div>
${banner}
${main}`;
  return renderPage(env, rc, {
    title: '内容',
    active: 'content',
    dealer,
    dealers,
    h1: '内容',
    help: [
      '这里管的是每个号发什么：AI 先排选题、写正文，再自己核对里面说的价格和参数对不对，然后等你点头，通过了才发出去。',
      '发出去之后还会回来看数据，哪篇带来了客户、哪篇带来了成交，都记在这一页。',
      '你要做的只有一件事：看一眼写得对不对，点「这样可以」或者「退回重写」。',
    ],
    subtitle: dealer.name,
    body,
  });
}

export function postDetailPage(env: PageEnv, rc: RequestContext): Reply {
  const { ctx } = env.runtime;
  const post = ctx.db.table('posts').require(rc.params.id);
  const { dealers } = resolveDealer(ctx, rc);
  const dealer = dealers.find((d) => d.id === post.dealer_id) ?? null;
  const tz = dealerTz(dealer);
  const account = ctx.db.table('xhs_accounts').get(post.account_id);
  const images = post.images ?? [];
  const review = post.review;
  const canGenerate = ['PLANNED', 'CHANGES_REQUIRED', 'DRAFTED'].includes(post.status);
  const canReview = ['DRAFTED', 'CHANGES_REQUIRED'].includes(post.status);
  const canApprove = post.status === 'IN_REVIEW';
  const canPublishManually = ['APPROVED', 'SCHEDULED', 'READY_TO_PUBLISH'].includes(post.status) || (post.status === 'PUBLISHED' && !post.platform_note_id);
  const reviewHtml = review
    ? `<ul class="guards">
  <li><span class="${review.fact_check.passed ? 'g-ok' : 'g-block'}">${review.fact_check.passed ? '✓' : '✕'}</span><span><b>事实核查</b> ${esc(review.fact_check.issues.join('；') || '所有价格/库存/优惠均来自门店数据')}</span></li>
  <li><span class="${review.duplicate_check.passed ? 'g-ok' : 'g-block'}">${review.duplicate_check.passed ? '✓' : '✕'}</span><span><b>撞车检查</b> 和已发过的笔记最像的一篇，像 ${esc(Math.round(review.duplicate_check.max_similarity * 100))}%</span></li>
  <li><span class="${review.compliance.passed ? 'g-ok' : 'g-block'}">${review.compliance.passed ? '✓' : '✕'}</span><span><b>合规</b> ${esc(review.compliance.issues.join('；') || '无问题')}</span></li>
</ul><p class="tiny muted">核查于 ${esc(fmtTime(review.reviewed_at, tz))}</p>`
    : '<p class="muted small">还没核查过</p>';
  const body = `<div class="detail-grid">
  <div class="panel stack">
    <div class="row">${postStatusPill(post.status)} ${pill(PILLAR[post.pillar] ?? post.pillar, 'neutral')} ${post.model ? pill(post.model, 'violet') : ''}<span class="spacer"></span><span class="small muted">${esc(account?.nickname ?? '')} · ${esc(post.slot_date)}</span></div>
    ${post.title ? `<h2 class="section-title">${esc(post.title)}</h2>` : '<p class="muted">还没写正文</p>'}
    ${post.cover_text ? `<div class="small"><b>封面文字：</b>${esc(post.cover_text)}</div>` : ''}
    ${post.body ? `<div class="quote"><p>${esc(post.body)}</p></div>` : ''}
    ${post.tags.length ? `<div class="chips">${post.tags.map((t) => `<span class="chip-neutral">#${esc(t)}</span>`).join('')}</div>` : ''}
    ${post.fact_refs.length ? `<div class="small muted">引用门店事实：${post.fact_refs.map((f) => esc(f.claim)).join('、')}</div>` : ''}
    <div class="row">
      ${canGenerate ? `<button class="btn btn-ink btn-sm" data-action="call" data-url="/api/posts/${esc(post.id)}/generate" data-success="已写好">让 AI 写正文</button>` : ''}
      ${canReview ? `<button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/posts/${esc(post.id)}/review" data-success="核查完成">做事实与合规核查</button>` : ''}
      ${canApprove ? `<button class="btn btn-primary btn-sm" data-action="call" data-url="/api/posts/${esc(post.id)}/approve" data-success="已通过">这样可以，通过</button>` : ''}
    </div>
    ${canApprove || canReview ? `<div class="inline-form" id="reject-form"><input type="text" name="reason" placeholder="哪里要改"><button class="btn btn-danger btn-sm" data-action="call" data-url="/api/posts/${esc(post.id)}/reject" data-form="#reject-form" data-success="已退回">退回重写</button></div>` : ''}
  </div>
  <div class="stack">
    <div class="panel"><h2 class="panel-title">核查结果${hint([
      '「事实核查」看价格、现车、优惠是不是都来自你填的车型和门店资料。',
      '「撞车检查」看这篇和自己以前发过的是不是太像。',
      '「合规」看有没有平台不让说的话。',
    ])}</h2>${reviewHtml}</div>
    <div class="panel stack"><h2 class="panel-title">发布${hint(PUBLISH_HELP)}</h2>
      <div class="row">${unfinishedButton('post_images', '上传 / 生成配图')}</div>
      <form class="stack" data-api="/api/posts/${esc(post.id)}/images" data-success="图片已保存"><label>图片${hint('每行放一张：网页图片链接，或这台电脑上的图片文件位置。最多 18 张，第一张是封面。')}<textarea name="images" data-type="lines">${esc(images.join('\n'))}</textarea></label><button class="btn btn-ghost btn-sm" type="submit">保存图片</button></form>
      <form class="stack" data-api="/api/posts/${esc(post.id)}/video" data-success="视频已保存"><label>视频${hint('想发视频笔记就在这里填一个视频文件在这台电脑上的位置。填了就按视频笔记发，不再带图片。')}<input type="text" name="video" placeholder="视频文件位置，例如 /Users/you/videos/提车日.mp4" value="${esc(post.video ?? '')}"></label><button class="btn btn-ghost btn-sm" type="submit">保存视频</button></form>
      ${canPublishManually ? `<form class="stack" data-api="/api/posts/${esc(post.id)}/mark-published" data-success="已登记发布"><label>已发出去的笔记链接${hint('在小红书上打开这篇笔记，点分享复制链接，粘到这里。有了链接才能算出它带来了多少客户。')}<input type="url" name="url" placeholder="https://www.xiaohongshu.com/explore/…" required></label><button class="btn btn-primary btn-sm" type="submit">登记为已发布</button></form>` : ''}
      ${post.platform_note_id ? `<div class="small">已在小红书发出 · ${esc(fmtTime(post.published_at, tz))}</div>` : ''}
      ${post.status === 'READY_TO_PUBLISH' || post.status === 'FAILED' ? `<div class="row"><span class="small muted">补好图片、确认上次没发成功之后，可以再让系统发一次。${hint('上一次的结果不确定时，先去小红书账号里看看这篇是不是已经发出去了，别发重了。')}</span><button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/posts/${esc(post.id)}/requeue" data-confirm="确认小红书上还没有这篇，再发一次？" data-success="已排队">再发一次</button></div>` : ''}
    </div>
    ${post.status === 'PUBLISHED' ? `<div class="panel"><h2 class="panel-title">这篇的数据${hint('能自动读到的会自动更新；小红书不给浏览量时，以你在这里手填的为准。')}</h2><form class="form-grid" data-api="/api/posts/${esc(post.id)}/metrics" data-success="已记录">
      ${(['views', 'likes', 'collects', 'comments', 'shares'] as const).map((k) => `<label>${esc({ views: '浏览', likes: '点赞', collects: '收藏', comments: '评论', shares: '分享' }[k])}<input type="number" min="0" name="${k}" value="${esc(post.metrics[k])}"></label>`).join('')}
      <button class="btn btn-ghost btn-sm" type="submit">手动记录</button></form>${resultBox}<p class="tiny muted">${post.metrics_updated_at ? `最近更新 ${esc(fmtTime(post.metrics_updated_at, tz))}` : '还没有数据'}</p></div>` : ''}
  </div>
</div>`;
  return renderPage(env, rc, {
    title: '内容详情',
    active: 'content',
    dealer,
    dealers,
    h1: `${esc(POST_STATUS[post.status][0])}<span class="h1-meta">${esc(account?.nickname ?? '')}</span>`,
    // `topic` is stored as `<model>:<pillar>:<题目>` — the store only ever sees the 题目 and the Chinese pillar name.
    subtitle: [...new Set([PILLAR[post.pillar] ?? '', post.topic.split(':').at(-1) ?? '', post.angle].map((s) => s.trim()).filter(Boolean))].join(' · '),
    body,
  });
}
