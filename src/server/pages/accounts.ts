/** 账号: the dealer's own Xiaohongshu accounts — add, QR login, persona, focus, health, workload and performance. */
import type { AppContext } from '../../app/context.ts';
import { ACCOUNT_TYPES, type AuthState, type XhsCapability } from '../../core/types.ts';
import { getAccountVoice } from '../../skills/content/account-voice/index.ts';
import { listFleet } from '../../skills/operations/account-brain/index.ts';
import { getAccountSessions } from '../../skills/operations/account-sessions/index.ts';
import { getAccountsOverview } from '../../skills/operations/analytics/index.ts';
import type { Reply, RequestContext } from '../http.ts';
import { ACCOUNT_TYPE, ago, capabilityPill, dataBody, esc, healthPill, hint, pct, pill, sectionHead, unfinishedButton, unfinishedTag } from '../render.ts';
import { CAPABILITY_NAME, humanCapability, humanProblem, scrubInternals } from '../humanize.ts';
import { xhsImageSrc } from '../api/media.ts';
import { noDealerBody, renderPage, resolveDealer, type PageEnv } from './shell.ts';

const AUTH: Record<AuthState, [string, 'green' | 'amber' | 'neutral']> = {
  authenticated: ['已登录', 'green'],
  requires_auth: ['需要扫码登录', 'amber'],
  unknown: ['登录状态未知', 'neutral'],
};
/** A session on this very machine: its address is plumbing, and there is nothing for a store to set. */
const LOCAL_ENDPOINT_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:\/|$)/i;

const KEY_CAPS: XhsCapability[] = ['search_public_content', 'read_public_comments', 'publish_content', 'reply_comments', 'send_messages'];
const RECOMMENDED_FLEET = 5;

/**
 * 账号语言风格: what this account's own notes taught the system about how it writes. Shown as the rules a person can
 * check, never as a label like「专业」—— and with the sample it was learned from, so it can be argued with.
 */
function voiceBlock(ctx: AppContext, accountId: string, nowMs: number): string {
  const profile = getAccountVoice(ctx, accountId);
  const learn = (label: string, cls: string) =>
    `<button class="btn ${cls} btn-sm" data-action="call" data-url="/api/accounts/${esc(accountId)}/voice" data-pending="正在读取历史笔记…" data-success-detail="1" data-success="已学习">${label}</button>`;
  if (!profile) {
    return `<details class="acct-voice"><summary class="tiny muted">语言风格 <span class="veh-flag is-todo">未学习</span></summary>
      <p class="tiny muted">学它自己笔记的写法${hint('读这个账号已经发过的笔记，记下它的标题写法、句式长短、emoji 和结尾引导语的习惯。学完以后，写笔记、发私信、回客户都照它自己的写法来，每个账号各学各的，不会串。')}</p>
      <div class="row">${learn('学习语言风格', 'btn-ink')}</div></details>`;
  }
  const rules = profile.rules.slice(0, 6).map((r) => `<li>${esc(r.rule)}<span class="tiny muted"> · ${esc(r.basis)}</span></li>`).join('');
  const example = profile.examples[0];
  return `<details class="acct-voice"><summary class="tiny muted">语言风格 <span class="veh-flag is-ai">学自 ${esc(profile.sample_count)} 篇</span> <span class="tiny muted">${esc(ago(profile.analyzed_at, nowMs))}</span></summary>
    <ul class="veh-list">${rules}</ul>
    ${profile.avoid.length > 0 ? `<p class="tiny muted">不这样写：${esc(profile.avoid.join('；'))}</p>` : ''}
    ${example ? `<p class="tiny muted">它平时的样子：《${esc(example.title)}》${esc(example.excerpt.slice(0, 60))}…</p>` : ''}
    <div class="row">${learn('重新学习', 'btn-ghost')}</div>
  </details>`;
}

export function accountsPage(env: PageEnv, rc: RequestContext): Reply {
  const { ctx } = env.runtime;
  const { dealer, dealers } = resolveDealer(ctx, rc);
  if (!dealer) return renderPage(env, rc, { title: '账号', active: 'accounts', dealer: null, dealers, h1: '账号', subtitle: '尚未配置门店', body: noDealerBody() });
  const sessions = getAccountSessions(ctx, dealer.id);
  const overview = new Map(getAccountsOverview(ctx, dealer.id).map((r) => [r.account_id, r]));
  const fleet = new Map(listFleet(ctx, { dealer_id: dealer.id }).map((b) => [b.account.id, b]));
  const nowMs = ctx.clock.now().getTime();
  const loginApi = sessions[0]?.provider.login_api ?? Boolean(ctx.xhs.auth);
  // Xiaohongshu rejects QR logins scanned from the instance's headless browser: prefer the visible login window when this
  // host can open one, keep the in-console QR code as the fallback.
  const loginWindow = sessions[0]?.provider.login_window ?? Boolean(ctx.xhs.auth?.visibleLogin);
  // This host runs the instances itself: the console can start an account's own instance instead of the fleet script.
  const localInstances = sessions[0]?.provider.local_instances ?? Boolean(ctx.xhs.auth?.localInstance);

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
        return `<span class="tiny">${esc(CAPABILITY_NAME[cap])} ${capabilityPill(view?.status, view ? humanCapability(cap, view.status, view.reason) : undefined)}</span>`;
      }).join(' ');
      const needsEndpoint = loginApi && s.endpoint.source === 'none';
      // Where this account's session actually runs is infrastructure: the card says whether it is connected, and the
      // address lives in 高级设置 for the rare case of a session on another machine.
      const endpoint = !loginApi
        ? ''
        : needsEndpoint
          ? ''
          : s.endpoint.source === 'env' || !s.configured_endpoint_url || LOCAL_ENDPOINT_RE.test(s.configured_endpoint_url)
            ? '' // runs on this machine: no address to show and nothing to set
            : `<details class="acct-adv"><summary class="tiny muted">高级设置</summary><div class="inline-form" id="ep-${esc(s.account_id)}"><input type="url" name="url" value="${esc(s.configured_endpoint_url ?? '')}" placeholder="留空＝这台电脑" aria-label="这个账号登录在哪台电脑"><button class="btn btn-ghost btn-sm" data-action="call" data-method="PUT" data-url="/api/accounts/${esc(s.account_id)}/endpoint" data-form="#ep-${esc(s.account_id)}" data-success="已保存">保存</button></div><p class="tiny muted">这个账号的登录默认放在这台电脑上，只有放在另一台电脑时才要填。</p></details>`;
      // Env-pinned instances are not ours to start or move; everything else on this host can be started from here.
      const startInstance =
        localInstances && s.endpoint.source !== 'env'
          ? `<button class="btn ${needsEndpoint ? 'btn-primary' : 'btn-ghost'} btn-sm" data-action="call" data-url="/api/accounts/${esc(s.account_id)}/instance" data-pending="正在准备…" data-success="准备好了，接下来扫码登录" title="给这个账号单独准备一个登录环境，和别的账号互不影响">${needsEndpoint ? '准备登录环境' : '重新准备'}</button>`
          : '';
      // No instance yet: logging in cannot work, the hint below says what to do first.
      const disabled = needsEndpoint ? ` disabled title="请先${localInstances ? '点「准备登录环境」' : '在高级设置里填写这个账号登录在哪台电脑'}"` : '';
      const qrButton = (label: string, cls: string) =>
        `<button class="btn ${cls} btn-sm"${disabled} data-action="qr-login" data-url="/api/accounts/${esc(s.account_id)}/login" data-sync-url="/api/accounts/${esc(s.account_id)}/sync" data-account="${esc(s.nickname)}">${label}</button>`;
      const loginButtons = !loginApi
        ? '<span class="tiny muted">现在没接小红书，不用登录</span>'
        : loginWindow
          ? `<button class="btn btn-primary btn-sm"${disabled} data-action="window-login" data-url="/api/accounts/${esc(s.account_id)}/login-window" data-status-url="/api/accounts/${esc(s.account_id)}/login-window/status" data-sync-url="/api/accounts/${esc(s.account_id)}/sync" data-account="${esc(s.nickname)}">扫码登录（登录窗口）</button>${qrButton('二维码（备用）', 'btn-ghost')}`
          : qrButton('扫码登录', 'btn-primary');
      // Real Xiaohongshu profile from the account's last confirmed login check; nothing is shown before one ran.
      const profile = s.platform_profile;
      const letter = esc(Array.from(profile?.nickname ?? s.nickname)[0] ?? '号');
      const avatarSrc = xhsImageSrc(profile?.avatar_url);
      // Status dot = real login state only; an unchecked session is a hollow dot, never drawn as logged in.
      const dot = !s.auth_checked_at ? 'st-dot-idle' : s.auth_state === 'authenticated' ? 'st-dot-ok' : s.auth_state === 'requires_auth' ? 'st-dot-warn' : 'st-dot-idle';
      const avatar = `<span class="acct-avatar">${letter}${avatarSrc ? `<img src="${esc(avatarSrc)}" alt="" loading="lazy">` : ''}<span class="st-dot ${dot}" title="${esc(authLabel)}"></span></span>`;
      const count = (n: number | null) => (n === null ? '未知' : esc(n));
      const xhsBlock = profile
        ? `<div class="acct-xhs">
    ${profile.bio ? `<p class="acct-bio">${esc(profile.bio)}</p>` : ''}
    <div class="acct-stats"><span><b>${count(profile.fans)}</b> 粉丝</span><span><b>${count(profile.follows)}</b> 关注</span><span><b>${count(profile.liked_and_collected)}</b> 获赞与收藏</span></div>
    <div class="tiny muted">${profile.red_id ? `小红书号 ${esc(profile.red_id)} · ` : ''}${profile.ip_location ? `IP属地 ${esc(profile.ip_location)} · ` : ''}小红书资料 ${esc(ago(s.platform_profile_at, nowMs))}同步</div>
    ${
      profile.notes.length
        ? `<div class="acct-notes">${profile.notes
            .slice(0, 6)
            .map((n) => {
              const cover = xhsImageSrc(n.cover_url);
              return `<a class="acct-note" href="${esc(n.url)}" target="_blank" rel="noopener noreferrer" title="${esc(n.title)}">${cover ? `<img src="${esc(cover)}" alt="" loading="lazy">` : '<span class="acct-note-empty"></span>'}<span class="acct-note-title">${esc(n.title || '（无标题）')}</span><span class="tiny muted">${n.liked_count === null ? '赞 未知' : `赞 ${esc(n.liked_count)}`}</span></a>`;
            })
            .join('')}</div>`
        : '<div class="tiny muted">主页上还没有公开笔记</div>'
    }
    ${unfinishedTag('account_history_ingest')}
  </div>`
        : `<div class="tiny muted">${s.auth_checked_at ? '登录之后这里会显示它在小红书上的真实资料' : '点下面「检测登录状态」，这里会显示它在小红书上的头像、粉丝和笔记'}</div>`;
      const paused = s.status !== 'active';
      return `<article class="acct">
  <div class="acct-top">${avatar}<div><div class="primary">${esc(profile?.nickname ?? s.nickname)}</div><div class="secondary">${esc(ACCOUNT_TYPE[s.account_type])}${account?.salesperson_name ? ` · ${esc(account.salesperson_name)}` : ''} · ${esc(account?.city ?? '')}</div>${profile?.nickname && profile.nickname !== s.nickname ? `<div class="tiny muted">控制台记录的昵称：${esc(s.nickname)}</div>` : ''}</div></div>
  ${xhsBlock}
  <p class="acct-pos">${persona?.content_positioning || persona?.bio ? `运营定位：${esc(persona?.content_positioning || persona?.bio || '')}` : ''}</p>
  <div class="chips">${(persona?.focus_models ?? []).map((m) => `<span class="chip-neutral">${esc(m)}</span>`).join('')}${persona?.tone ? `<span class="ev">${esc(persona.tone)}</span>` : ''}</div>
  <div class="acct-meta">
    <span>手上客户 ${esc(o?.active_leads ?? 0)}</span><span>30天私信 ${esc(o?.outreach_sent_30d ?? 0)}</span>
    <span>回复率 ${esc(pct(o?.reply_rate_30d ?? 0))}</span><span>90天预约 ${esc(o?.appointments_90d ?? 0)}</span>
    <span>90天成交 ${esc(o?.won_90d ?? 0)}</span><span>30天发笔记 ${esc(o?.posts_published_30d ?? 0)}</span>
  </div>
  <div class="row">${healthPill(o?.health_state ?? null, o?.health_score ?? null)} ${pill(authLabel, authTone)} ${paused ? pill(s.status === 'paused' ? '已暂停' : s.status, 'red') : ''}</div>
  ${o?.health_issues?.length ? `<div class="tiny muted">${esc(o.health_issues.join('；'))}</div>` : ''}
  <div class="tiny muted">${s.auth_checked_at ? `${esc(ago(s.auth_checked_at, nowMs))}查过${s.auth_state === 'authenticated' ? '：已登录' : `：${esc(humanProblem(s.auth_detail) ?? scrubInternals(s.auth_detail) ?? '')}`}` : '尚未检测登录状态'}</div>
  <div class="stack" style="gap:6px">${caps}</div>
  ${voiceBlock(ctx, s.account_id, nowMs)}
  ${endpoint}
  ${
        needsEndpoint
          ? localInstances
            ? '<div class="tiny" style="color:var(--amber)">这个账号还没连上：点「连接这个账号」，系统会为它准备一个独立的登录环境，然后再扫码登录。</div>'
            : '<div class="tiny" style="color:var(--amber)">这个账号还没连上：请在「高级设置」里填写它的账号服务地址，再扫码登录。</div>'
          : ''
      }
  <div class="acct-foot">
    <button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/accounts/${esc(s.account_id)}/sync" data-success="已完成检测">检测登录状态</button>
    ${startInstance}
    ${loginButtons}
    ${loginApi && !needsEndpoint ? `<button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/accounts/${esc(s.account_id)}/logout" data-confirm="退出后这个账号要重新扫码登录，确认？" data-success-detail="1" data-success="已退出登录" title="清掉这个账号保存下来的登录状态。换人接手、或者登错号了才用">退出登录</button>` : ''}
    <button class="btn btn-ghost btn-sm" data-action="call" data-method="PATCH" data-url="/api/accounts/${esc(s.account_id)}" data-body="${dataBody({ status: paused ? 'active' : 'paused' })}" data-confirm="${paused ? '恢复运营？' : '暂停后该账号不会被分配线索或发布，确认？'}" data-success="已更新">${paused ? '恢复' : '暂停'}</button>
    <button class="btn btn-ghost btn-sm" data-action="call" data-method="DELETE" data-url="/api/accounts/${esc(s.account_id)}" data-confirm="确认移除该账号？它负责的线索会回到线索池，再点一次" data-success-detail="1" data-success="账号已移除，线索保留在门店线索池" title="线索属于门店，不会随账号删除；已联系过客户的账号会保留历史记录">移除账号</button>
    ${unfinishedButton('account_persona_edit', '编辑人设')}
    ${unfinishedButton('account_policy_edit', '审批策略与限额')}
  </div>
</article>`;
    })
    .join('');

  const addForm = `<form class="card stack" id="add-account" data-api="/api/dealers/${esc(dealer.id)}/accounts" data-success="账号已添加，下一步：扫码登录">
  <h3>添加一个小红书号${hint(['填的昵称和小红书 App 里显示的一致就行，其他的后面都能改。', '添加之后在账号卡片上点「扫码登录」，用这个号本人的手机扫。二维码只出现在弹窗里，不会被保存，也不会写进记录。', '每个号的登录各自独立，不会把内容发到别的号上。'])}</h3>
  <div class="form-grid">
    <label>小红书昵称<input type="text" name="nickname" required maxlength="40" placeholder="和小红书 App 里显示的一样"></label>
    <label>账号类型<select name="account_type">${ACCOUNT_TYPES.map((t) => `<option value="${t}">${esc(ACCOUNT_TYPE[t])}</option>`).join('')}</select></label>
    <label>这个号是谁在用<input type="text" name="salesperson_name" maxlength="20" data-optional placeholder="销售姓名，门店官方号可不填"></label>
    <label>所在城市<input type="text" name="city" maxlength="30" data-optional placeholder="不填就按${esc(dealer.city)}算"></label>
  </div>
  <div class="row"><span class="spacer"></span><button class="btn btn-primary btn-sm" type="submit">添加账号</button></div>
</form>`;

  const extra =
    sessions.length > 0 && sessions.length < RECOMMENDED_FLEET
      ? [{ tone: 'amber' as const, html: `现在只有 ${sessions.length} 个号，建议加到 ${RECOMMENDED_FLEET} 个以上${hint('门店官方号、几个销售的个人号，再加一个专门讲车或讲本地用车的号：覆盖的人不一样，找到的客户也不一样。同一个号发太多同类内容，曝光还会变差。')}` }]
      : [];
  const research = loginApi
    ? `<div class="card row"><div><div class="primary" style="font-size:16px">找客户用的号${hint(['系统要在小红书上搜帖子、看评论，才能找到正在看车的人。这件事不用你们的运营号去做，而是用这里单独登录的一个号，免得打扰到正在经营的账号。', '这个号只负责看，不发笔记也不发私信。它一旦掉登录，就搜不到新客户了。'])}</div><div class="tiny muted">专门用来搜帖子、看评论，不发内容</div></div><span class="spacer"></span>
  <button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/research-session/status" data-redirect="none" data-success="已检测，结果见上方提示">检测登录状态</button>
  ${
    loginWindow
      ? `<button class="btn btn-primary btn-sm" data-action="window-login" data-url="/api/research-session/login-window" data-status-url="/api/research-session/login-window/status" data-sync-url="/api/research-session/status" data-account="找客户用的号">扫码登录（登录窗口）</button>
  <button class="btn btn-ghost btn-sm" data-action="qr-login" data-url="/api/research-session/login" data-sync-url="/api/research-session/status" data-account="找客户用的号">二维码（备用）</button>`
      : '<button class="btn btn-primary btn-sm" data-action="qr-login" data-url="/api/research-session/login" data-sync-url="/api/research-session/status" data-account="找客户用的号">扫码登录</button>'
  }</div>`
    : '';
  // Accounts removed from the fleet are not hidden away: the count says their history is still here.
  const removedCount = Number(
    ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM xhs_accounts WHERE dealer_id = ? AND removed_at IS NOT NULL', dealer.id)?.n ?? 0,
  );
  const removedNote = removedCount > 0
    ? `<p class="small muted">另有 ${esc(removedCount)} 个已经不用的号${hint('它们不再接客户、也不发内容，只保留以前发过的私信、对话和笔记，方便回头查。客户是门店的，移走账号时已经回到公共客户池，会重新分给别人。')}</p>`
    : '';
  const body = `${sectionHead('你们的小红书号', {
    help: [
      '每个号的登录各自独立，系统不会把内容发到别的号上。',
      '二维码只在弹窗里显示，不保存也不写进记录，请用这个号本人的手机扫。',
      '登录状态每次都去小红书实际查一遍；没查过就写「登录未检测」，不会替你猜。',
    ],
    note: sessions.length ? `${sessions.length} 个号` : '还没有账号',
    right: sessions.length ? `<button class="btn btn-ink btn-sm" data-action="call" data-url="/api/accounts/sync" data-body="${dataBody({ dealer_id: dealer.id })}" data-success="已检测全部账号">检测全部账号</button>` : '',
  })}
${sessions.length ? '' : `<div style="margin-bottom:20px">${addForm}</div>`}
${research}
${sessions.length ? `<div class="acct-grid" style="margin-top:20px">${cards}</div><div class="block">${addForm}</div>` : ''}
${removedNote}`;
  return renderPage(env, rc, { title: '账号', active: 'accounts', dealer, dealers, h1: '账号',
    help: [
      '门店自己的小红书号都放在这里：登录、看状态、定人设，以及让系统学它自己的写法。',
      '每个号的登录各自独立，系统不会把内容发到别的号上。二维码只在弹窗里显示，用这个号本人的手机扫。',
      '客户属于门店，不属于某个号：移走一个号，它手上的客户会回到公共客户池重新分配。',
    ],
    subtitle: `${dealer.name} · 共 ${sessions.length} 个号`,
    body,
    extraBanners: extra });
}
