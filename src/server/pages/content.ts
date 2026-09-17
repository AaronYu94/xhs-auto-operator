/** 内容: per-account week calendar, review queue, publishing, content → sales attribution and engagement replies. */
import { addDaysToKey, localDateKey } from '../../core/time.ts';
import type { EngagementReply, Post } from '../../core/types.ts';
import { getContentAttribution } from '../../skills/operations/analytics/index.ts';
import type { Reply, RequestContext } from '../http.ts';
import { queryString } from '../http.ts';
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
  table,
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
  DRAFT: ['草稿', 'neutral'],
  BLOCKED: ['已拦截', 'red'],
  READY_FOR_REVIEW: ['待审核', 'amber'],
  APPROVED: ['已通过·待发送', 'amber'],
  SENT: ['已发送（平台确认）', 'green'],
  SENT_MANUALLY: ['已人工发送', 'green'],
  CANCELLED: ['已取消', 'neutral'],
};

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function runButton(workflow: string, dealerId: string, label: string): string {
  return `<button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/workflows/${esc(workflow)}/run" data-body="${dataBody({ dealer_id: dealerId })}" data-success="任务已启动，可在系统页查看进度">${esc(label)}</button>`;
}

export function contentPage(env: PageEnv, rc: RequestContext): Reply {
  const { ctx } = env.runtime;
  const { dealer, dealers } = resolveDealer(ctx, rc);
  if (!dealer) return renderPage(env, rc, { title: '内容', active: 'content', dealer: null, dealers, h1: '内容', subtitle: '尚未配置门店', body: noDealerBody() });
  const tz = dealerTz(dealer);
  const weekParam = queryString(rc.query, 'week', 10);
  const start = weekParam && DATE_KEY.test(weekParam) ? weekParam : localDateKey(ctx.clock.now(), tz);
  const days = Array.from({ length: 7 }, (_, i) => addDaysToKey(start, i));
  const accounts = ctx.db.table('xhs_accounts').findMany({ dealer_id: dealer.id }, { orderBy: 'created_at ASC' });
  const posts = ctx.db.table('posts').query('dealer_id = ? AND slot_date >= ? AND slot_date <= ?', [dealer.id, days[0], days[6]], { orderBy: 'slot_date ASC, created_at ASC' });
  const byCell = new Map<string, Post[]>();
  for (const p of posts) byCell.set(`${p.account_id}|${p.slot_date}`, [...(byCell.get(`${p.account_id}|${p.slot_date}`) ?? []), p]);

  const calendar = `<div class="table-wrap"><div class="calendar">
  <div class="cal-head">账号</div>${days.map((d) => `<div class="cal-head">${esc(d.slice(5))}</div>`).join('')}
  ${accounts
    .map(
      (a) =>
        `<div class="cal-acct">${esc(a.nickname)}<div class="tiny muted">${esc(ACCOUNT_TYPE[a.account_type])}</div></div>${days
          .map((d) => {
            const cell = byCell.get(`${a.id}|${d}`) ?? [];
            return `<div class="cal-cell">${cell
              .map((p) => `<a class="cal-post" href="${esc(href(`/content/posts/${p.id}`, { dealer: dealer.id }))}"><div>${esc(p.title || `${PILLAR[p.pillar] ?? p.pillar}${p.model ? ` · ${p.model}` : ''}`)}</div><div style="margin-top:4px">${postStatusPill(p.status)}</div></a>`)
              .join('')}</div>`;
          })
          .join('')}`,
    )
    .join('')}
</div></div>`;

  const queue = ctx.db.table('posts').findMany({ dealer_id: dealer.id, status: ['IN_REVIEW', 'CHANGES_REQUIRED', 'READY_TO_PUBLISH', 'DRAFTED'] }, { orderBy: 'slot_date ASC', limit: 100 });
  const accountName = new Map(accounts.map((a) => [a.id, a.nickname]));
  const queueRows = queue.map((p) => [
    `<div class="primary" style="font-size:15px">${esc(p.title || p.topic)}</div><div class="secondary">${esc(accountName.get(p.account_id) ?? '')} · ${esc(p.slot_date)} · ${esc(PILLAR[p.pillar] ?? p.pillar)}</div>`,
    postStatusPill(p.status),
    p.review ? `${pill(p.review.fact_check.passed ? '事实核查通过' : '事实核查未通过', p.review.fact_check.passed ? 'green' : 'red')} ${pill(p.review.compliance.passed ? '合规' : '合规问题', p.review.compliance.passed ? 'green' : 'red')}` : '<span class="muted small">未审核</span>',
    `<a class="btn btn-ghost btn-sm" href="${esc(href(`/content/posts/${p.id}`, { dealer: dealer.id }))}">处理</a>`,
  ]);

  const attribution = getContentAttribution(ctx, { dealer_id: dealer.id, from: addDaysToKey(localDateKey(ctx.clock.now(), tz), -90) });
  const attrRows = attribution.slice(0, 30).map((r) => [
    `<div class="primary" style="font-size:15px">${esc(r.title)}</div><div class="secondary">${esc(r.account_nickname)} · ${esc(PILLAR[r.pillar] ?? r.pillar)}${r.model ? ` · ${esc(r.model)}` : ''}</div>`,
    `<span class="num">${esc(r.views)}</span>`,
    `<span class="num">${esc(r.engagement)}</span>`,
    `<span class="num">${esc(r.leads)} / ${esc(r.qualified_leads)}</span>`,
    `<span class="num">${esc(r.appointments)}</span>`,
    `<span class="num">${esc(r.won)}</span>`,
    esc(cny(r.won_value)),
  ]);

  const replies = ctx.db.table('engagement_replies').findMany({ dealer_id: dealer.id, status: ['READY_FOR_REVIEW', 'APPROVED', 'BLOCKED'] }, { orderBy: 'created_at DESC', limit: 50 });
  const replyCap = latestCapability(ctx, 'reply_comments', null);
  const replyRows = replies.map((r) => {
    const comment = ctx.db.table('public_comments').get(r.public_comment_id);
    const pp = comment ? ctx.db.table('public_posts').get(comment.public_post_id) : undefined;
    const [label, tone] = ENGAGEMENT_STATUS[r.status];
    const actions =
      r.status === 'READY_FOR_REVIEW' || r.status === 'APPROVED'
        ? `<div class="row" id="er-${esc(r.id)}"><textarea name="message" id="er-text-${esc(r.id)}" style="min-height:60px">${esc(r.message)}</textarea>
  <button class="btn btn-ghost btn-sm" data-action="copy" data-target="#er-text-${esc(r.id)}">复制</button>
  ${r.status === 'READY_FOR_REVIEW' ? `<button class="btn btn-ink btn-sm" data-action="call" data-url="/api/engagement-replies/${esc(r.id)}/approve" data-form="#er-${esc(r.id)}" data-success="已审核">审核通过</button>` : ''}
  ${r.status === 'APPROVED' && replyCap?.status === 'AVAILABLE' ? `<button class="btn btn-primary btn-sm" data-action="call" data-url="/api/engagement-replies/${esc(r.id)}/send" data-success="已提交，以平台确认为准">通过平台回复</button>` : ''}
  <button class="btn btn-primary btn-sm" data-action="call" data-url="/api/engagement-replies/${esc(r.id)}/mark-sent" data-confirm="确认已在小红书回复？再点一次" data-success="已登记">我已在小红书回复</button>
  <button class="btn btn-danger btn-sm" data-action="call" data-url="/api/engagement-replies/${esc(r.id)}/cancel" data-body="${dataBody({ reason: '运营取消' })}" data-success="已取消">取消</button></div>`
        : '';
    return [
      `<div class="quote-cell">“${esc(comment?.content ?? '')}”</div><div class="tiny muted">${esc(comment?.author_nickname ?? '')} · 《${esc(pp?.title ?? '')}》 ${sourceLink(pp?.url)}</div>`,
      pill(label, tone),
      actions || esc(r.message),
    ];
  });

  const body = `
<div class="row" style="margin-bottom:18px">
  <a class="btn btn-ghost btn-sm" href="${esc(href('/content', { dealer: dealer.id, week: addDaysToKey(start, -7) }))}">← 上一周</a>
  <a class="btn btn-ghost btn-sm" href="${esc(href('/content', { dealer: dealer.id }))}">本周</a>
  <a class="btn btn-ghost btn-sm" href="${esc(href('/content', { dealer: dealer.id, week: addDaysToKey(start, 7) }))}">下一周 →</a>
  <span class="spacer"></span>
  ${runButton('account_planning', dealer.id, '生成账号内容计划')}
  ${runButton('content_publishing', dealer.id, '撰写并审核到期内容')}
  <button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/posts/publish-due" data-body="${dataBody({ dealer_id: dealer.id })}" data-success="已处理到期内容（需图片或人工发布的会标记待人工发布）">发布到期内容</button>
  <button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/performance/collect" data-body="${dataBody({ dealer_id: dealer.id })}" data-success="已采集可读取的互动数据">采集表现</button>
</div>
${sectionHead('内容日历', { note: `${days[0]} 至 ${days[6]} · 同一车型/主题不会在多个账号近期重复` })}
${accounts.length ? calendar : emptyState('还没有账号')}
<div class="block">${sectionHead('待处理内容', { live: true })}${table(['内容', '状态', '审核结果', ''], queueRows, { empty: '没有待处理的内容' })}</div>
<div class="block">${sectionHead('哪些内容真正带来成交', { note: '近 90 天发布内容 · 按成交、预约、合格线索排序，而不是按点赞' })}${table(['内容', '浏览', '互动', '线索/合格', '预约', '成交', '成交额'], attrRows, { compact: true, empty: '还没有已发布内容的归因数据' })}</div>
<div class="block">${sectionHead('评论回复', { note: '只回复我们自己笔记下的评论，不做陌生人评论营销', right: `<button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/engagement-replies/draft" data-body="${dataBody({ dealer_id: dealer.id })}" data-success="已起草回复">起草评论回复</button>` })}${table(['评论', '状态', '回复'], replyRows, { empty: '没有待处理的评论回复' })}</div>`;
  return renderPage(env, rc, { title: '内容', active: 'content', dealer, dealers, h1: '内容 <span class="grad">运营</span>', subtitle: `${dealer.name} · 研究 → 账号计划 → 撰写 → 事实与合规审核 → 发布 → 表现 → 优化`, body });
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
  <li><span class="${review.duplicate_check.passed ? 'g-ok' : 'g-block'}">${review.duplicate_check.passed ? '✓' : '✕'}</span><span><b>查重</b> 最高相似度 ${esc(Math.round(review.duplicate_check.max_similarity * 100))}%</span></li>
  <li><span class="${review.compliance.passed ? 'g-ok' : 'g-block'}">${review.compliance.passed ? '✓' : '✕'}</span><span><b>合规</b> ${esc(review.compliance.issues.join('；') || '无问题')}</span></li>
</ul><p class="tiny muted">审核于 ${esc(fmtTime(review.reviewed_at, tz))}</p>`
    : '<p class="muted small">尚未审核</p>';
  const body = `<div class="detail-grid">
  <div class="panel stack">
    <div class="row">${postStatusPill(post.status)} ${pill(PILLAR[post.pillar] ?? post.pillar, 'neutral')} ${post.model ? pill(post.model, 'violet') : ''}<span class="spacer"></span><span class="small muted">${esc(account?.nickname ?? '')} · ${esc(post.slot_date)}</span></div>
    ${post.title ? `<h2 class="section-title">${esc(post.title)}</h2>` : '<p class="muted">尚未生成正文</p>'}
    ${post.cover_text ? `<div class="small"><b>封面文字：</b>${esc(post.cover_text)}</div>` : ''}
    ${post.body ? `<div class="quote"><p>${esc(post.body)}</p></div>` : ''}
    ${post.tags.length ? `<div class="chips">${post.tags.map((t) => `<span class="chip-neutral">#${esc(t)}</span>`).join('')}</div>` : ''}
    ${post.fact_refs.length ? `<div class="small muted">引用门店事实：${post.fact_refs.map((f) => esc(f.claim)).join('、')}</div>` : ''}
    <div class="row">
      ${canGenerate ? `<button class="btn btn-ink btn-sm" data-action="call" data-url="/api/posts/${esc(post.id)}/generate" data-success="已生成">生成正文</button>` : ''}
      ${canReview ? `<button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/posts/${esc(post.id)}/review" data-success="审核完成">事实与合规审核</button>` : ''}
      ${canApprove ? `<button class="btn btn-primary btn-sm" data-action="call" data-url="/api/posts/${esc(post.id)}/approve" data-success="已批准">批准</button>` : ''}
    </div>
    ${canApprove || canReview ? `<div class="inline-form" id="reject-form"><input type="text" name="reason" placeholder="驳回原因"><button class="btn btn-danger btn-sm" data-action="call" data-url="/api/posts/${esc(post.id)}/reject" data-form="#reject-form" data-success="已驳回">驳回</button></div>` : ''}
  </div>
  <div class="stack">
    <div class="panel"><h2 class="panel-title">审核结果</h2>${reviewHtml}</div>
    <div class="panel stack"><h2 class="panel-title">发布</h2>
      <p class="small muted">小红书发布需要至少一张图片；系统只有在平台确认成功后才会标记为已发布。无法自动发布时，请在对应账号的 App 中发布，然后登记笔记链接。</p>
      <form class="stack" data-api="/api/posts/${esc(post.id)}/images" data-success="图片已保存"><label>图片（每行一个本地路径或 URL，最多 18 张）<textarea name="images" data-type="lines">${esc(images.join('\n'))}</textarea></label><button class="btn btn-ghost btn-sm" type="submit">保存图片</button></form>
      ${canPublishManually ? `<form class="stack" data-api="/api/posts/${esc(post.id)}/mark-published" data-success="已登记发布"><label>已发布的笔记链接<input type="url" name="url" placeholder="https://www.xiaohongshu.com/explore/…" required></label><button class="btn btn-primary btn-sm" type="submit">登记为已发布</button></form>` : ''}
      ${post.platform_note_id ? `<div class="small">笔记ID <span class="mono">${esc(post.platform_note_id)}</span> · 发布于 ${esc(fmtTime(post.published_at, tz))}</div>` : ''}
      ${post.status === 'READY_TO_PUBLISH' || post.status === 'FAILED' ? `<div class="row"><span class="small muted">已上传图片或确认上次发布未成功后，可重新排队由系统发布（发布结果未知时请先到小红书账号核实，避免重复发布）。</span><button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/posts/${esc(post.id)}/requeue" data-confirm="确认已核实未发布成功，重新排队？" data-success="已重新排队">重新排队发布</button></div>` : ''}
    </div>
    ${post.status === 'PUBLISHED' ? `<div class="panel"><h2 class="panel-title">表现</h2><form class="form-grid" data-api="/api/posts/${esc(post.id)}/metrics" data-success="已记录">
      ${(['views', 'likes', 'collects', 'comments', 'shares'] as const).map((k) => `<label>${esc({ views: '浏览', likes: '点赞', collects: '收藏', comments: '评论', shares: '分享' }[k])}<input type="number" min="0" name="${k}" value="${esc(post.metrics[k])}"></label>`).join('')}
      <button class="btn btn-ghost btn-sm" type="submit">手动记录</button></form>${resultBox}<p class="tiny muted">${post.metrics_updated_at ? `最近更新 ${esc(fmtTime(post.metrics_updated_at, tz))}` : '尚无数据'} · 小红书接口不提供浏览量时保持为人工记录值</p></div>` : ''}
  </div>
</div>`;
  return renderPage(env, rc, {
    title: '内容详情',
    active: 'content',
    dealer,
    dealers,
    h1: `${esc(POST_STATUS[post.status][0])} · <span class="grad">${esc(account?.nickname ?? '')}</span>`,
    subtitle: `${post.topic} · ${post.angle}`,
    body,
  });
}
