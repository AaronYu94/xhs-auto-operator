/** 账号: the dealer's own Xiaohongshu accounts — add, QR login, persona, focus, health, workload and performance. */
import { ACCOUNT_TYPES, type AuthState, type XhsCapability } from '../../core/types.ts';
import { listFleet } from '../../skills/operations/account-brain/index.ts';
import { getAccountSessions } from '../../skills/operations/account-sessions/index.ts';
import { getAccountsOverview } from '../../skills/operations/analytics/index.ts';
import type { Reply, RequestContext } from '../http.ts';
import { ACCOUNT_TYPE, CAPABILITY_NAME, ago, capabilityPill, dataBody, esc, healthPill, pct, pill, sectionHead } from '../render.ts';
import { noDealerBody, renderPage, resolveDealer, type PageEnv } from './shell.ts';

const AUTH: Record<AuthState, [string, 'green' | 'amber' | 'neutral']> = {
  authenticated: ['已登录', 'green'],
  requires_auth: ['需要扫码登录', 'amber'],
  unknown: ['登录状态未知', 'neutral'],
};
const KEY_CAPS: XhsCapability[] = ['search_public_content', 'read_public_comments', 'publish_content', 'reply_comments', 'send_messages'];
const RECOMMENDED_FLEET = 5;

export function accountsPage(env: PageEnv, rc: RequestContext): Reply {
  const { ctx } = env.runtime;
  const { dealer, dealers } = resolveDealer(ctx, rc);
  if (!dealer) return renderPage(env, rc, { title: '账号', active: 'accounts', dealer: null, dealers, h1: '账号', subtitle: '尚未配置门店', body: noDealerBody() });
  const sessions = getAccountSessions(ctx, dealer.id);
  const overview = new Map(getAccountsOverview(ctx, dealer.id).map((r) => [r.account_id, r]));
  const fleet = new Map(listFleet(ctx, { dealer_id: dealer.id }).map((b) => [b.account.id, b]));
  const nowMs = ctx.clock.now().getTime();
  const loginApi = sessions[0]?.provider.login_api ?? Boolean(ctx.xhs.auth);

  const cards = sessions
    .map((s) => {
      const o = overview.get(s.account_id);
      const brain = fleet.get(s.account_id);
      const persona = brain?.persona;
      const account = brain?.account;
      // Never present an imported / assumed login as fact: until a live probe has run, the state is "not checked".
      const [authLabel, authTone] = s.auth_checked_at ? AUTH[s.auth_state] : (['登录未检测', 'neutral'] as [string, 'neutral']);
      const caps = KEY_CAPS.map((cap) => {
        const view = s.capabilities[cap];
        return `<span class="tiny">${esc(CAPABILITY_NAME[cap])} ${capabilityPill(view?.status, view?.reason)}</span>`;
      }).join(' ');
      const endpoint =
        s.endpoint.source === 'env'
          ? `<span class="tiny muted">实例（环境变量）：<span class="mono">${esc(s.endpoint.url ?? '')}</span></span>`
          : `<div class="inline-form" id="ep-${esc(s.account_id)}"><input type="url" name="url" value="${esc(s.configured_endpoint_url ?? '')}" placeholder="http://127.0.0.1:18061/mcp" aria-label="实例地址"><button class="btn btn-ghost btn-sm" data-action="call" data-method="PUT" data-url="/api/accounts/${esc(s.account_id)}/endpoint" data-form="#ep-${esc(s.account_id)}" data-success="实例地址已保存">保存实例地址</button></div>`;
      const needsEndpoint = loginApi && s.endpoint.source === 'none';
      const loginButtons = loginApi
        ? `<button class="btn btn-primary btn-sm" data-action="qr-login" data-url="/api/accounts/${esc(s.account_id)}/login" data-sync-url="/api/accounts/${esc(s.account_id)}/sync" data-account="${esc(s.nickname)}">扫码登录</button>`
        : '<span class="tiny muted">当前数据源不需要扫码登录（不适用）</span>';
      const paused = s.status !== 'active';
      return `<article class="acct">
  <div class="acct-top"><span class="acct-avatar">${esc(Array.from(s.nickname)[0] ?? '号')}</span><div><div class="primary">${esc(s.nickname)}</div><div class="secondary">${esc(ACCOUNT_TYPE[s.account_type])}${account?.salesperson_name ? ` · ${esc(account.salesperson_name)}` : ''} · ${esc(account?.city ?? '')} · <span class="mono">${esc(s.platform_account_id ?? '')}</span></div></div></div>
  <p class="acct-pos">${esc(persona?.content_positioning || persona?.bio || '')}</p>
  <div class="chips">${(persona?.focus_models ?? []).map((m) => `<span class="chip-neutral">${esc(m)}</span>`).join('')}${persona?.tone ? `<span class="ev">${esc(persona.tone)}</span>` : ''}</div>
  <div class="acct-meta">
    <span>负责线索 ${esc(o?.active_leads ?? 0)}</span><span>30天私信 ${esc(o?.outreach_sent_30d ?? 0)}</span>
    <span>回复率 ${esc(pct(o?.reply_rate_30d ?? 0))}</span><span>90天预约 ${esc(o?.appointments_90d ?? 0)}</span>
    <span>90天成交 ${esc(o?.won_90d ?? 0)}</span><span>30天发布 ${esc(o?.posts_published_30d ?? 0)}</span>
  </div>
  <div class="row">${healthPill(o?.health_state ?? null, o?.health_score ?? null)} ${pill(authLabel, authTone)} ${paused ? pill(s.status === 'paused' ? '已暂停' : s.status, 'red') : ''}</div>
  ${o?.health_issues?.length ? `<div class="tiny muted">${esc(o.health_issues.join('；'))}</div>` : ''}
  <div class="tiny muted">${s.auth_checked_at ? `登录检测 ${esc(ago(s.auth_checked_at, nowMs))}：${esc(s.auth_detail ?? '')}` : '尚未检测登录状态'}</div>
  <div class="stack" style="gap:6px">${caps}</div>
  ${endpoint}
  ${needsEndpoint ? '<div class="tiny" style="color:var(--amber)">还没有实例地址：请先填写并保存该账号的 xiaohongshu-mcp 实例地址，再点「扫码登录」。</div>' : ''}
  <div class="acct-foot">
    <button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/accounts/${esc(s.account_id)}/sync" data-success="已完成检测">检测登录状态</button>
    ${loginButtons}
    <button class="btn btn-ghost btn-sm" data-action="call" data-method="PATCH" data-url="/api/accounts/${esc(s.account_id)}" data-body="${dataBody({ status: paused ? 'active' : 'paused' })}" data-confirm="${paused ? '恢复运营？' : '暂停后该账号不会被分配线索或发布，确认？'}" data-success="已更新">${paused ? '恢复' : '暂停'}</button>
    <button class="btn btn-ghost btn-sm" data-action="call" data-method="DELETE" data-url="/api/accounts/${esc(s.account_id)}" data-confirm="确认删除该账号？再点一次" data-success="账号已删除">删除</button>
  </div>
</article>`;
    })
    .join('');

  const addForm = `<form class="card stack" id="add-account" data-api="/api/dealers/${esc(dealer.id)}/accounts" data-success="账号已添加，下一步：扫码登录">
  <h3>添加您的小红书账号</h3>
  <div class="form-grid">
    <label>小红书昵称<input type="text" name="nickname" required maxlength="40" placeholder="与小红书 App 中显示的一致"></label>
    <label>账号类型<select name="account_type">${ACCOUNT_TYPES.map((t) => `<option value="${t}">${esc(ACCOUNT_TYPE[t])}</option>`).join('')}</select></label>
    <label>销售姓名（销售号必填）<input type="text" name="salesperson_name" maxlength="20" data-optional></label>
    <label>所在城市（可空，默认${esc(dealer.city)}）<input type="text" name="city" maxlength="30" data-optional></label>
    ${loginApi ? '<label>xiaohongshu-mcp 实例地址（可稍后填写）<input type="url" name="mcp_endpoint_url" maxlength="300" data-optional placeholder="http://127.0.0.1:18061/mcp"></label>' : ''}
    <label>账号标识（可空，自动生成）<input type="text" name="platform_account_id" maxlength="64" data-optional pattern="[A-Za-z0-9._\\-]{2,64}" title="字母、数字、点、下划线、短横线"></label>
  </div>
  <p class="small muted">${loginApi ? '添加后点账号卡片上的「扫码登录」，用<b>该账号本人的小红书 App</b> 扫码；二维码只显示在弹窗中，不会保存。每个账号需要一个独立的 xiaohongshu-mcp 实例（独立端口和 cookies）。' : '当前数据源没有登录会话，添加后即可使用。'}用环境变量 XHS_MCP_ACCOUNTS 配置实例时，账号标识需与其中的 id 一致。</p>
  <div class="row"><span class="spacer"></span><button class="btn btn-primary btn-sm" type="submit">添加账号</button></div>
</form>`;

  const extra =
    sessions.length > 0 && sessions.length < RECOMMENDED_FLEET
      ? [{ tone: 'amber' as const, html: `当前有 ${sessions.length} 个账号，建议逐步增加到至少 ${RECOMMENDED_FLEET} 个定位不同的账号（官方、销售、车型专家、本地攻略、车主故事），可在下方继续添加。` }]
      : [];
  const research = loginApi
    ? `<div class="card row"><div><div class="primary" style="font-size:16px">研究实例（公开内容搜索）</div><div class="tiny muted">未为某个账号单独配置实例时，公开搜索、笔记与评论读取使用研究实例。</div></div><span class="spacer"></span>
  <button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/research-session/status" data-redirect="none" data-success="已检测，结果见上方提示或系统页">检测研究实例</button>
  <button class="btn btn-primary btn-sm" data-action="qr-login" data-url="/api/research-session/login" data-sync-url="/api/research-session/status" data-account="研究实例">研究实例扫码登录</button></div>`
    : '';
  const body = `${sectionHead('账号矩阵', {
    note: sessions.length ? `${sessions.length} 个账号 · 人设、定位与负载各不相同` : '还没有账号',
    right: sessions.length ? `<button class="btn btn-ink btn-sm" data-action="call" data-url="/api/accounts/sync" data-body="${dataBody({ dealer_id: dealer.id })}" data-success="已检测全部账号">检测全部账号</button>` : '',
  })}
${sessions.length ? '' : `<div style="margin-bottom:20px">${addForm}</div>`}
${research}
${sessions.length ? `<div class="acct-grid" style="margin-top:20px">${cards}</div><div class="block">${addForm}</div>` : ''}
<p class="footnote">每个账号必须使用自己独立的 xiaohongshu-mcp 实例（独立端口和 cookies），否则操作会落到别的账号上。二维码只在弹窗中显示，不会被保存或写入日志；请使用该账号本人的小红书 App 扫码。</p>`;
  return renderPage(env, rc, { title: '账号', active: 'accounts', dealer, dealers, h1: '账号 <span class="grad">矩阵</span>', subtitle: `${dealer.name} · 登录状态来自真实检测，从不假设`, body, extraBanners: extra });
}
