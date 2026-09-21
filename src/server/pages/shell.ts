/** Shared page plumbing: dealer resolution, capability snapshots, honest banners and the page wrapper. */
import type { AppContext } from '../../app/context.ts';
import { DEFAULT_TZ } from '../../core/time.ts';
import { getSetupStatus } from '../../operator/onboarding.ts';
import type { CapabilityStatus, Dealer, XhsCapability } from '../../core/types.ts';
import { listDealers } from '../../skills/operations/dealer-brain/index.ts';
import { queryString, type Reply, type RequestContext } from '../http.ts';
import { WORKFLOW_LABEL, ago, esc, hint, href, layout, type AgentStatus, type Banner, type TabKey, type Theme } from '../render.ts';
import { humanProblem, scrubInternals } from '../humanize.ts';
import type { ServerOptions, ServerRuntime } from '../runtime.ts';

export interface PageEnv {
  runtime: ServerRuntime;
  options: ServerOptions;
}

export function resolveDealer(ctx: AppContext, rc: RequestContext): { dealer: Dealer | null; dealers: Dealer[] } {
  const dealers = listDealers(ctx);
  const wanted = queryString(rc.query, 'dealer') ?? queryString(rc.query, 'dealer_id');
  const requested = wanted ? dealers.find((d) => d.id === wanted) : undefined;
  if (requested) return { dealer: requested, dealers };
  // Default to the store that operates the largest active account fleet (ties keep listing order), not simply the
  // first row: a group's flagship store with 5+ accounts is what the operator runs day to day.
  const activeAccounts = new Map<string, number>();
  for (const row of ctx.db.all<{ dealer_id: string; n: number }>("SELECT dealer_id, COUNT(*) AS n FROM xhs_accounts WHERE status = 'active' GROUP BY dealer_id")) {
    activeAccounts.set(row.dealer_id, Number(row.n));
  }
  let dealer: Dealer | null = dealers[0] ?? null;
  for (const d of dealers) if ((activeAccounts.get(d.id) ?? 0) > (dealer ? (activeAccounts.get(dealer.id) ?? 0) : -1)) dealer = d;
  return { dealer, dealers };
}

export const dealerTz = (dealer: Dealer | null): string => dealer?.settings?.timezone || DEFAULT_TZ;

export interface CapabilitySnapshotView {
  status: CapabilityStatus;
  reason: string;
  checked_at: string;
  account_id: string | null;
}

/** Latest recorded probe of a capability for an account (falling back to the provider-level probe). */
export function latestCapability(ctx: AppContext, capability: XhsCapability, accountId: string | null): CapabilitySnapshotView | null {
  const provider = ctx.xhs.name;
  const byAccount = accountId
    ? ctx.db.get<CapabilitySnapshotView>(
        'SELECT status, reason, checked_at, account_id FROM capability_snapshots WHERE provider = ? AND capability = ? AND account_id = ? ORDER BY checked_at DESC LIMIT 1',
        provider,
        capability,
        accountId,
      )
    : undefined;
  if (byAccount) return byAccount;
  return (
    ctx.db.get<CapabilitySnapshotView>(
      'SELECT status, reason, checked_at, account_id FROM capability_snapshots WHERE provider = ? AND capability = ? AND account_id IS NULL ORDER BY checked_at DESC LIMIT 1',
      provider,
      capability,
    ) ?? null
  );
}

/** Latest probe of a capability across the dealer's accounts and the provider level (newest first). */
export function latestCapabilityForDealer(ctx: AppContext, capability: XhsCapability, dealerId: string | null): CapabilitySnapshotView | null {
  const params: string[] = [ctx.xhs.name, capability];
  let scope = 'account_id IS NULL';
  if (dealerId) {
    scope = '(account_id IS NULL OR account_id IN (SELECT id FROM xhs_accounts WHERE dealer_id = ?))';
    params.push(dealerId);
  }
  return (
    ctx.db.get<CapabilitySnapshotView>(
      `SELECT status, reason, checked_at, account_id FROM capability_snapshots WHERE provider = ? AND capability = ? AND ${scope} ORDER BY checked_at DESC LIMIT 1`,
      ...params,
    ) ?? null
  );
}

/** Things waiting for a human (cheap counts for the bell dot on every page). */
export function pendingCount(ctx: AppContext, dealerId: string | null): number {
  if (!dealerId) return 0;
  const n = (sql: string) => Number(ctx.db.get<{ n: number }>(sql, dealerId)?.n ?? 0);
  return (
    n("SELECT COUNT(*) AS n FROM outreach o JOIN leads l ON l.id = o.lead_id WHERE l.dealer_id = ? AND o.status IN ('READY_FOR_REVIEW','APPROVED')") +
    n('SELECT COUNT(*) AS n FROM conversations c JOIN leads l ON l.id = c.lead_id WHERE l.dealer_id = ? AND c.needs_human = 1 AND c.status <> \'closed\'') +
    n("SELECT COUNT(*) AS n FROM posts WHERE dealer_id = ? AND status IN ('IN_REVIEW','READY_TO_PUBLISH')") +
    n("SELECT COUNT(*) AS n FROM appointments WHERE dealer_id = ? AND status = 'proposed'")
  );
}

export function honestBanners(env: PageEnv, dealer: Dealer | null, active: TabKey | null = null): Banner[] {
  const { ctx, config } = env.runtime;
  const out: Banner[] = [];
  const dealerParam = dealer ? { dealer: dealer.id } : {};
  if (ctx.xhs.mode === 'simulation') {
    out.push({
      tone: 'violet',
      html: `<b>演示数据</b>：这里的线索、笔记和评论都是假的，<b>不是真实客户</b>。${hint('这是用来试功能和演示的一套样例内容。正式使用时系统不会出现这种数据。')}`,
    });
  } else if (ctx.xhs.mode === 'none' || ctx.xhs.mode === 'manual') {
    out.push({
      tone: 'red',
      html: `<b>还没连小红书</b>：系统暂时找不了客户。<a class="link" href="${esc(href('/accounts', dealerParam))}">去连账号 →</a>${hint('先在「账号」页添加你们自己的小红书号并扫码登录，系统才能在公开笔记和评论里找买车的人。')}`,
    });
  } else {
    const search = latestCapabilityForDealer(ctx, 'search_public_content', dealer?.id ?? null);
    if (!search) {
      // On 账号 itself the card already says 登录未检测 right next to the button that fixes it.
      if (active !== 'accounts') {
        out.push({ tone: 'amber', html: `还没查过小红书能不能用。<a class="link" href="${esc(href('/accounts', dealerParam))}">去账号页点「检测登录状态」→</a>` });
      }
    } else if (search.status === 'REQUIRES_AUTH') {
      out.push({
        tone: 'amber',
        html: `<b>账号掉登录了</b>：现在搜不了公开内容——不是没搜到，是要重新扫码。<a class="link" href="${esc(href('/accounts', dealerParam))}">去扫码登录 →</a>`,
      });
    } else if (search.status !== 'AVAILABLE') {
      out.push({ tone: 'red', html: `<b>暂时搜不了公开内容</b>：${esc(humanProblem(search.reason) ?? '')}` });
    }
  }
  // The password warning is real but not actionable by a salesperson, and it is not news on every page: it belongs
  // where someone can do something about it.
  if (!env.options.auth_enabled && (dealer === null || active === 'setup')) {
    out.push({ tone: 'amber', html: `<b>这个控制台还没设密码</b>：谁打开这个网址都能操作。${hint('请让搭系统的同事设置一个登录密码，再把网址发给同事使用。')}` });
  }
  // Startup warnings are written for whoever runs the deployment; the log has them in full.
  if (config.warnings.length > 0 && active === 'system') {
    out.push({ tone: 'amber', html: `系统有 ${esc(config.warnings.length)} 项配置需要技术同事检查。${hint(config.warnings.map((w) => scrubInternals(w)).filter(Boolean))}` });
  }
  return out;
}

export interface PageInput {
  title: string;
  active: TabKey | null;
  dealer: Dealer | null;
  dealers: Dealer[];
  h1: string;
  /** what this page is for, behind the 「?」 next to the title — never written out under it */
  help?: string | readonly string[];
  subtitle: string;
  body: string;
  exceptions?: number;
  extraBanners?: Banner[];
  /** the page renders its own hero instead of the title row (今日) */
  hideHead?: boolean;
}

export const THEME_COOKIE = 'st_theme';
export const RAIL_COOKIE = 'st_rail';

/** The operator collapsed the nav to icons. Read server-side so the shell never renders wide and then snaps shut. */
export function railFromRequest(rc: RequestContext): boolean {
  return new RegExp(`(?:^|;\\s*)${RAIL_COOKIE}=1(?:;|$)`).test(rc.req.headers.cookie ?? '');
}

/** The operator's explicit light / dark choice (cookie set by the theme toggle); null = follow the system. */
export function themeFromRequest(rc: RequestContext): Theme | null {
  const raw = rc.req.headers.cookie ?? '';
  const m = new RegExp(`(?:^|;\\s*)${THEME_COOKIE}=(light|dark)(?:;|$)`).exec(raw);
  return m ? (m[1] as Theme) : null;
}

/**
 * What Steer is doing, from real workflow runs only: the running run (newest first), else the last finished one,
 * else idle. Never a rotating sample text.
 */
export function agentStatus(ctx: AppContext, dealerId: string | null): AgentStatus {
  const nowMs = ctx.clock.now().getTime();
  const scope = dealerId ? '(dealer_id = ? OR dealer_id IS NULL)' : '1 = 1';
  const params = dealerId ? [dealerId] : [];
  const running = ctx.db.get<{ workflow: string; started_at: string }>(
    `SELECT workflow, started_at FROM workflow_runs WHERE status = 'RUNNING' AND ${scope} ORDER BY started_at DESC LIMIT 1`,
    ...params,
  );
  if (running) {
    return { running: true, html: `Steer 正在<b>${esc(WORKFLOW_LABEL[running.workflow] ?? running.workflow)}</b>`, since: running.started_at, sinceLabel: `${ago(running.started_at, nowMs)}开始` };
  }
  const last = ctx.db.get<{ workflow: string; status: string; finished_at: string | null; started_at: string }>(
    `SELECT workflow, status, finished_at, started_at FROM workflow_runs WHERE status <> 'RUNNING' AND ${scope} ORDER BY COALESCE(finished_at, started_at) DESC LIMIT 1`,
    ...params,
  );
  if (last) {
    const at = last.finished_at ?? last.started_at;
    const verb = last.status === 'SUCCEEDED' ? '完成了' : last.status === 'FAILED' ? '运行失败：' : '结束了';
    return { running: false, html: `Steer 待命，最近${verb}<b>${esc(WORKFLOW_LABEL[last.workflow] ?? last.workflow)}</b>`, since: at, sinceLabel: ago(at, nowMs) };
  }
  return { running: false, html: 'Steer 待命，<b>下达一个经营目标</b>开始工作', since: null, sinceLabel: null };
}

export function renderPage(env: PageEnv, rc: RequestContext, p: PageInput): Reply {
  return {
    html: layout({
      title: p.title,
      active: p.active,
      dealerId: p.dealer?.id ?? null,
      dealers: p.dealers.map((d) => ({ id: d.id, name: d.name })),
      operator: rc.operator,
      authEnabled: env.options.auth_enabled,
      provider: { name: env.runtime.ctx.xhs.name, mode: env.runtime.ctx.xhs.mode },
      exceptions: p.exceptions ?? pendingCount(env.runtime.ctx, p.dealer?.id ?? null),
      banners: [...honestBanners(env, p.dealer, p.active), ...setupBanners(env, p), ...(p.extraBanners ?? [])],
      theme: themeFromRequest(rc),
      railCollapsed: railFromRequest(rc),
      agent: agentStatus(env.runtime.ctx, p.dealer?.id ?? null),
      hideHead: p.hideHead,
      h1: `${p.h1}${p.help ? hint(p.help) : ''}`,
      subtitle: p.subtitle,
      body: p.body,
    }),
  };
}

/** Every page except 设置 / 总览 (which show the steps themselves) says plainly when the store cannot run yet. */
function setupBanners(env: PageEnv, p: PageInput): Banner[] {
  if (!p.dealer || p.active === 'setup' || p.active === 'overview') return [];
  const status = getSetupStatus(env.runtime.ctx, p.dealer.id);
  if (status.ready) return [];
  // 账号 is where an account blocker is fixed: repeating it above the very buttons that fix it is noise.
  if (p.active === 'accounts' && (status.blocker ?? '').includes('账号')) return [];
  return [
    {
      tone: 'amber',
      html: `<b>设置未完成</b>：${esc(status.blocker ?? '')} <a class="link" href="${esc(href('/setup', { dealer: p.dealer.id }))}">查看设置步骤 →</a>`,
    },
  ];
}

export function noDealerBody(): string {
  return `<div class="empty"><h2 class="panel-title">还没有门店</h2>
<p class="muted">系统不内置任何门店、品牌或账号。请先填写您自己的门店信息，再添加您自己的小红书账号并扫码登录，之后才能开始获客。</p>
<a class="btn btn-primary" href="/setup">开始设置</a>
</div>`;
}

export function dateLabel(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: tz, month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(iso));
}
