/** Shared page plumbing: dealer resolution, capability snapshots, honest banners and the page wrapper. */
import type { AppContext } from '../../app/context.ts';
import { DEFAULT_TZ } from '../../core/time.ts';
import { getSetupStatus } from '../../operator/onboarding.ts';
import type { CapabilityStatus, Dealer, XhsCapability } from '../../core/types.ts';
import { listDealers } from '../../skills/operations/dealer-brain/index.ts';
import { queryString, type Reply, type RequestContext } from '../http.ts';
import { esc, href, layout, type Banner, type TabKey } from '../render.ts';
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

export function honestBanners(env: PageEnv, dealer: Dealer | null): Banner[] {
  const { ctx, config } = env.runtime;
  const out: Banner[] = [];
  const dealerParam = dealer ? { dealer: dealer.id } : {};
  if (ctx.xhs.mode === 'simulation') {
    out.push({
      tone: 'violet',
      html: '<b>模拟数据模式</b>：线索、笔记和评论来自合成语料，<b>不是真实客户</b>，仅用于测试和演示。生产环境会拒绝启用模拟数据。',
    });
  } else if (ctx.xhs.mode === 'none' || ctx.xhs.mode === 'manual') {
    out.push({
      tone: 'red',
      html: `<b>未连接小红书</b>：没有配置数据源（${esc(ctx.xhs.name)}），系统不会搜索公开内容。请按部署文档配置 <span class="mono">XHS_PROVIDER=mcp</span> 与每个账号的 xiaohongshu-mcp 实例，或在「系统」页导入真实公开内容。`,
    });
  } else {
    const search = latestCapabilityForDealer(ctx, 'search_public_content', dealer?.id ?? null);
    if (!search) {
      out.push({ tone: 'amber', html: `尚未检测小红书连接状态。<a class="link" href="${esc(href('/accounts', dealerParam))}">前往账号页检测并扫码登录 →</a>` });
    } else if (search.status === 'REQUIRES_AUTH') {
      out.push({
        tone: 'amber',
        html: `<b>需要扫码登录</b>：搜索公开内容当前不可用（${esc(search.reason)}）。这不是“没有结果”，而是小红书会话未登录。<a class="link" href="${esc(href('/accounts', dealerParam))}">前往账号页扫码登录 →</a>`,
      });
    } else if (search.status !== 'AVAILABLE') {
      out.push({ tone: 'red', html: `<b>小红书搜索不可用</b>：${esc(search.reason)}` });
    }
  }
  if (!env.options.auth_enabled) {
    out.push({ tone: 'amber', html: '<b>未设置控制台密码</b>（CONSOLE_PASSWORD）：能访问此地址的任何人都可以操作系统，仅限本机开发使用。' });
  }
  for (const w of config.warnings) out.push({ tone: 'amber', html: esc(w) });
  return out;
}

export interface PageInput {
  title: string;
  active: TabKey | null;
  dealer: Dealer | null;
  dealers: Dealer[];
  h1: string;
  subtitle: string;
  body: string;
  exceptions?: number;
  extraBanners?: Banner[];
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
      banners: [...honestBanners(env, p.dealer), ...setupBanners(env, p), ...(p.extraBanners ?? [])],
      h1: p.h1,
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
  return [
    {
      tone: 'amber',
      html: `<b>设置未完成</b>：${esc(status.blocker ?? '')} <a class="link" href="${esc(href('/setup', { dealer: p.dealer.id }))}">查看设置步骤 →</a>`,
    },
  ];
}

export function noDealerBody(): string {
  return `<div class="panel"><h2 class="panel-title">还没有门店</h2>
<p class="muted">系统不内置任何门店、品牌或账号。请先填写您自己的门店信息，再添加您自己的小红书账号并扫码登录，之后才能开始获客。</p>
<a class="btn btn-primary" href="/setup">开始设置</a>
<p class="small muted" style="margin-top:16px">批量迁移时也可以在「系统」页导入 Dealer Brain JSON，或使用命令行 <span class="mono">node src/cli.ts dealer import ./my-dealer.json</span>。</p></div>`;
}

export function dateLabel(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: tz, month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(iso));
}
