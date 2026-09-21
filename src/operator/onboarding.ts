/**
 * Onboarding: every dealer enters ITS OWN data in the console — store, brands, models on sale and the Xiaohongshu
 * accounts it operates. Nothing is built in or assumed: a brand, city or model exists only once an operator typed it,
 * and an account only counts as ready after a live probe verified its own QR login.
 *
 * - createDealer / updateDealer / deleteDealer (delete only while the store has no leads or content)
 * - addVehicle / deleteVehicle (catalog rows read by goal parsing, query generation and fact answers)
 * - addAccount / removeAccount (always possible: the account's leads are released to the store's pool, and an account
 *   that already contacted customers is archived instead of deleted so its history keeps its author)
 * - getSetupStatus / requireReadyToRun: goals and manual workflow runs need ≥ 1 active account whose login was
 *   verified; providers without a login-session API (simulation, none) only need an active account.
 */
import type { AppContext } from '../app/context.ts';
import { NotFoundError, PolicyError, ValidationError } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { ACCOUNT_TYPES, DM_CHANNELS, type AccountType, type Dealer, type DmChannel, type Vehicle, type XhsAccount } from '../core/types.ts';
import type { Validator } from '../core/validate.ts';
import { findLocation, getBrandInfo, getModelInfo, resolveModelName } from '../domain/automotive-lexicon.ts';
import { releaseAccountLeads } from '../skills/acquisition/account-assignment/index.ts';
import { ensurePersona } from '../skills/operations/account-brain/index.ts';
import { setAccountEndpoint, validateEndpointUrl } from '../skills/operations/account-sessions/index.ts';
import { getDealer, mergeDealerSettings } from '../skills/operations/dealer-brain/index.ts';
import { matchKey } from '../skills/operations/dealer-brain/shared.ts';
import { isValidTimeZone } from './scheduler.ts';
import { normalizeEndpointUrl } from '../providers/xhs/mcp-provider.ts';

/** Workflows that may run before setup is complete (they only probe login state and refresh dealer data). */
export const SETUP_EXEMPT_WORKFLOWS: readonly string[] = ['refresh_dealer_data'];

const POWERTRAINS = ['EV', 'PHEV', 'HEV', 'ICE'] as const;
const PLATFORM_ACCOUNT_ID_RE = /^[A-Za-z0-9._-]{2,64}$/;
const CJK_RE = /[㐀-鿿]/;

// ─────────────────────────────────────────────────────────────────────────────
// Field validators (Chinese messages: they are shown to operators as-is)
// ─────────────────────────────────────────────────────────────────────────────

function textOf(value: unknown, label: string, path: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ValidationError(path, `${label}需要填写文字`);
  return value.trim();
}

const requiredText =
  (label: string, max: number): Validator<string> =>
  (value, path = '') => {
    const s = textOf(value, label, path);
    if (!s) throw new ValidationError(path, `请填写${label}`);
    if (s.length > max) throw new ValidationError(path, `${label}最多 ${max} 个字`);
    return s;
  };

/** Blank → undefined (field not provided). */
const optionalText =
  (label: string, max: number): Validator<string | undefined> =>
  (value, path = '') => {
    const s = textOf(value, label, path);
    if (!s) return undefined;
    if (s.length > max) throw new ValidationError(path, `${label}最多 ${max} 个字`);
    return s;
  };

/** A list typed as one text ("A，B、C" or one per line) or sent as an array; blanks and duplicates removed. */
export function splitList(value: unknown, path: string, opts: { label: string; min?: number; max?: number; itemMax?: number }): string[] {
  const itemMax = opts.itemMax ?? 60;
  let raw: unknown[];
  if (value === undefined || value === null) raw = [];
  else if (Array.isArray(value)) raw = value;
  else if (typeof value === 'string') raw = value.split(/[,，、;；\n]+/);
  else throw new ValidationError(path, `${opts.label}需要填写文字`);
  const out: string[] = [];
  raw.forEach((item, i) => {
    if (typeof item !== 'string') throw new ValidationError(`${path}[${i}]`, `${opts.label}需要填写文字`);
    const s = item.trim();
    if (!s) return;
    if (s.length > itemMax) throw new ValidationError(path, `${opts.label}「${s.slice(0, 20)}…」最多 ${itemMax} 个字`);
    if (!out.some((x) => matchKey(x) === matchKey(s))) out.push(s);
  });
  if (opts.min !== undefined && out.length < opts.min) throw new ValidationError(path, `请填写${opts.label}`);
  if (opts.max !== undefined && out.length > opts.max) throw new ValidationError(path, `${opts.label}最多 ${opts.max} 项`);
  return out;
}

function intField(value: unknown, path: string, label: string, min: number, max: number): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n)) throw new ValidationError(path, `请填写${label}（整数）`);
  if (n < min || n > max) throw new ValidationError(path, `${label}需要在 ${min} 到 ${max} 之间`);
  return n;
}

function bodyObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError('body', '需要 JSON 对象');
  return value as Record<string, unknown>;
}

/** Canonical brand for a typed name when the lexicon knows it ('比亚迪' / 'byd' → BYD), else the typed text. */
function canonicalBrand(name: string): { brand: string; brand_zh: string } {
  const info = getBrandInfo(name);
  return info ? { brand: info.brand, brand_zh: info.brand_zh } : { brand: name, brand_zh: name };
}

const sameBrand = (a: string, b: string): boolean => matchKey(canonicalBrand(a).brand) === matchKey(canonicalBrand(b).brand);

function brandsField(value: unknown, path: string): string[] {
  const out: string[] = [];
  for (const name of splitList(value, path, { label: '经营品牌', min: 1, max: 10, itemMax: 30 })) {
    const { brand } = canonicalBrand(name);
    if (!out.some((b) => sameBrand(b, brand))) out.push(brand);
  }
  return out;
}

function timezoneField(value: unknown, path: string): string | undefined {
  const tz = optionalText('时区', 60)(value, path);
  if (tz !== undefined && !isValidTimeZone(tz)) throw new ValidationError(path, `未知时区「${tz}」（例如 Asia/Shanghai）`);
  return tz;
}

/** 'app' | 'pro': where this store's salespeople hand-send DMs. Anything else is a typo, not a silent default. */
function dmChannelField(value: unknown, path: string): DmChannel {
  const raw = typeof value === 'string' ? value.trim() : '';
  const channel = (DM_CHANNELS as readonly string[]).includes(raw) ? (raw as DmChannel) : undefined;
  if (!channel) throw new ValidationError(path, `未知的私信渠道（可选：${DM_CHANNELS.join('、')}）`);
  return channel;
}

function provinceFor(city: string, typed: string | undefined, path: string): string {
  if (typed) return typed;
  const inferred = findLocation(city)?.province;
  if (!inferred) throw new ValidationError(path, `无法从城市「${city}」识别省份，请填写省份`);
  return inferred;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dealers
// ─────────────────────────────────────────────────────────────────────────────

/** Create a store (and a new group unless `group_id` names an existing one) from operator-entered data. */
export function createDealer(ctx: AppContext, raw: unknown, actor: string): Dealer {
  const body = bodyObject(raw);
  const name = requiredText('门店名称', 60)(body.name, 'name');
  const brands = brandsField(body.brands, 'brands');
  const city = requiredText('城市', 30)(body.city, 'city');
  const province = provinceFor(city, optionalText('省份', 30)(body.province, 'province'), 'province');
  const address = optionalText('门店地址', 200)(body.address, 'address') ?? '';
  const businessHours = optionalText('营业时间', 100)(body.business_hours, 'business_hours') ?? '';
  const phone = optionalText('门店电话', 40)(body.phone, 'phone') ?? null;
  const timezone = timezoneField(body.timezone, 'timezone');
  const groupId = optionalText('所属集团', 80)(body.group_id, 'group_id');
  const groupName = optionalText('集团/公司名称', 60)(body.group_name, 'group_name');
  if (groupId && !ctx.db.table('dealer_groups').get(groupId)) throw new ValidationError('group_id', '所选集团不存在');

  const now = ctx.clock.iso();
  const id = ctx.db.tx(() => {
    const group = groupId ?? ctx.db.table('dealer_groups').insert({ id: newId('grp'), name: groupName ?? name, created_at: now }).id;
    const dealer = ctx.db.table('dealers').insert({
      id: newId('dlr'),
      group_id: group,
      name,
      brands,
      city,
      province,
      address,
      business_hours: businessHours,
      phone,
      settings: mergeDealerSettings(timezone ? { timezone } : {}),
      created_at: now,
      updated_at: now,
    });
    ctx.audit.event({
      actor,
      action: 'dealer.created',
      entity_type: 'dealer',
      entity_id: dealer.id,
      details: { name, brands, city, province, group_id: group, new_group: !groupId },
    });
    return dealer.id;
  });
  return getDealer(ctx, id);
}

/** Update store fields the operator entered; blank address / hours / phone clear them, other fields keep their value. */
export function updateDealer(ctx: AppContext, dealerId: string, raw: unknown, actor: string): Dealer {
  const current = getDealer(ctx, dealerId);
  const body = bodyObject(raw);
  const patch: Partial<Dealer> = {};
  const clear: ('phone')[] = [];
  if (body.name !== undefined) patch.name = requiredText('门店名称', 60)(body.name, 'name');
  if (body.brands !== undefined) patch.brands = brandsField(body.brands, 'brands');
  if (body.city !== undefined) patch.city = requiredText('城市', 30)(body.city, 'city');
  if (body.province !== undefined || patch.city !== undefined) {
    const typed = optionalText('省份', 30)(body.province, 'province');
    patch.province = typed ?? (patch.city ? provinceFor(patch.city, undefined, 'province') : current.province);
  }
  if (body.address !== undefined) patch.address = optionalText('门店地址', 200)(body.address, 'address') ?? '';
  if (body.business_hours !== undefined) patch.business_hours = optionalText('营业时间', 100)(body.business_hours, 'business_hours') ?? '';
  if (body.phone !== undefined) {
    const phone = optionalText('门店电话', 40)(body.phone, 'phone');
    if (phone === undefined) clear.push('phone');
    else patch.phone = phone;
  }
  if (body.timezone !== undefined) {
    const timezone = timezoneField(body.timezone, 'timezone');
    if (timezone) patch.settings = { ...current.settings, timezone };
  }
  if (body.dm_channel !== undefined) {
    const channel = dmChannelField(body.dm_channel, 'dm_channel');
    patch.settings = { ...(patch.settings ?? current.settings), dm_channel: channel };
  }

  const before = current as unknown as Record<string, unknown>;
  const changed = Object.entries(patch).filter(([k, x]) => JSON.stringify(before[k]) !== JSON.stringify(x));
  const clearing = clear.filter((k) => current[k] !== null);
  if (changed.length === 0 && clearing.length === 0) return current;
  ctx.db.tx(() => {
    if (changed.length > 0) ctx.db.table('dealers').update(dealerId, { ...Object.fromEntries(changed), updated_at: ctx.clock.iso() } as Partial<Dealer>);
    if (clearing.length > 0) ctx.db.table('dealers').setNull(dealerId, clearing);
    ctx.audit.event({
      actor,
      action: 'dealer.updated',
      entity_type: 'dealer',
      entity_id: dealerId,
      details: {
        changes: Object.fromEntries([...changed.map(([k, x]) => [k, { before: before[k], after: x }]), ...clearing.map((k) => [k, { before: before[k], after: null }])]),
      },
    });
  });
  return getDealer(ctx, dealerId);
}

const count = (ctx: AppContext, sql: string, id: string): number => Number(ctx.db.get<{ n: number }>(sql, id)?.n ?? 0);

/**
 * Delete a store entered by mistake, with its accounts, inventory, offers, goals and schedules. Refused once the store
 * has leads or content (that history must stay). The group is removed with its last store.
 */
export function deleteDealer(ctx: AppContext, dealerId: string, actor: string): { dealer_id: string; group_deleted: boolean } {
  const dealer = getDealer(ctx, dealerId);
  const leads = count(ctx, 'SELECT COUNT(*) AS n FROM leads WHERE dealer_id = ?', dealerId);
  const posts = count(ctx, 'SELECT COUNT(*) AS n FROM posts WHERE dealer_id = ?', dealerId);
  if (leads + posts > 0) {
    throw new PolicyError('dealer_has_history', `该门店已有 ${leads} 条线索、${posts} 篇内容，不能删除（历史记录需要保留）`, { leads, posts });
  }
  return ctx.db.tx(() => {
    ctx.db.run('DELETE FROM capability_snapshots WHERE account_id IN (SELECT id FROM xhs_accounts WHERE dealer_id = ?)', dealerId);
    ctx.db.table('dealers').delete(dealerId);
    const groupDeleted = ctx.db.table('dealers').count({ group_id: dealer.group_id }) === 0;
    if (groupDeleted) ctx.db.table('dealer_groups').delete(dealer.group_id);
    ctx.audit.event({
      actor,
      action: 'dealer.deleted',
      entity_type: 'dealer',
      entity_id: dealerId,
      details: { name: dealer.name, group_id: dealer.group_id, group_deleted: groupDeleted },
    });
    return { dealer_id: dealerId, group_deleted: groupDeleted };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Vehicles
// ─────────────────────────────────────────────────────────────────────────────

/** Add a model / trim the store sells. The brand must be one of the store's brands. */
export function addVehicle(ctx: AppContext, dealerId: string, raw: unknown, actor: string): Vehicle {
  const dealer = getDealer(ctx, dealerId);
  const body = bodyObject(raw);
  const typedBrand = requiredText('品牌', 30)(body.brand, 'brand');
  const typedModel = requiredText('车型', 40)(body.model, 'model');
  const trim = requiredText('配置/版本名称', 60)(body.trim, 'trim');
  const modelYear = intField(body.model_year, 'model_year', '年款', 1990, 2100);
  const msrp = intField(body.msrp, 'msrp', '厂商指导价（元）', 1, 100_000_000);
  const powertrainRaw = optionalText('动力类型', 10)(body.powertrain, 'powertrain');
  if (powertrainRaw && !(POWERTRAINS as readonly string[]).includes(powertrainRaw)) {
    throw new ValidationError('powertrain', `动力类型需要是 ${POWERTRAINS.join(' / ')}`);
  }
  const highlights = splitList(body.highlights, 'highlights', { label: '卖点', max: 12, itemMax: 80 });
  const extraAliases = splitList(body.aliases, 'aliases', { label: '别名', max: 12, itemMax: 40 });

  const brand = canonicalBrand(typedBrand);
  if (!dealer.brands.some((b) => sameBrand(b, brand.brand))) {
    throw new ValidationError('brand', `品牌「${typedBrand}」不在门店经营品牌（${dealer.brands.join('、')}）中，请先在门店信息里添加该品牌`);
  }
  // Use the lexicon's canonical model only when it belongs to the same brand; otherwise keep exactly what was typed.
  const resolved = resolveModelName(typedModel);
  const info = resolved ? getModelInfo(resolved) : undefined;
  const known = info && matchKey(info.brand) === matchKey(brand.brand) ? info : undefined;
  const model = known?.model ?? typedModel;
  const modelZh = known ? (CJK_RE.test(typedModel) ? typedModel : known.model_zh) : typedModel;
  const aliases = [...extraAliases];
  for (const a of [typedModel]) if (matchKey(a) !== matchKey(model) && matchKey(a) !== matchKey(modelZh) && !aliases.some((x) => matchKey(x) === matchKey(a))) aliases.push(a);

  const vehicles = ctx.db.table('vehicles');
  if (vehicles.findOne({ group_id: dealer.group_id, brand: brand.brand, model, trim, model_year: modelYear })) {
    throw new ValidationError('trim', `${brand.brand_zh}${modelZh} ${modelYear}款 ${trim} 已存在`);
  }
  return ctx.db.tx(() => {
    const row = vehicles.insert({
      id: newId('veh'),
      group_id: dealer.group_id,
      brand: brand.brand,
      brand_zh: brand.brand_zh,
      model,
      model_zh: modelZh,
      trim,
      model_year: modelYear,
      msrp,
      specs: powertrainRaw ? { powertrain: powertrainRaw as (typeof POWERTRAINS)[number] } : {},
      highlights,
      aliases,
      source: `console:${actor}`,
      updated_at: ctx.clock.iso(),
    });
    ctx.audit.event({
      actor,
      action: 'vehicle.created',
      entity_type: 'vehicle',
      entity_id: row.id,
      details: { dealer_id: dealerId, brand: row.brand, model: row.model, trim, model_year: modelYear, msrp },
    });
    return row;
  });
}

/** Remove a catalog row nothing references (inventory / offers keep their vehicle). */
export function deleteVehicle(ctx: AppContext, vehicleId: string, actor: string): { vehicle_id: string } {
  const vehicle = ctx.db.table('vehicles').get(vehicleId);
  if (!vehicle) throw new NotFoundError('vehicle', vehicleId);
  const inventory = count(ctx, 'SELECT COUNT(*) AS n FROM inventory WHERE vehicle_id = ?', vehicleId);
  const offers = count(ctx, 'SELECT COUNT(*) AS n FROM offers WHERE vehicle_id = ?', vehicleId);
  if (inventory + offers > 0) {
    throw new PolicyError('vehicle_in_use', `该车型还有 ${inventory} 条库存、${offers} 条优惠在引用，不能删除`, { inventory, offers });
  }
  ctx.db.tx(() => {
    ctx.db.table('vehicles').delete(vehicleId);
    ctx.audit.event({
      actor,
      action: 'vehicle.deleted',
      entity_type: 'vehicle',
      entity_id: vehicleId,
      details: { brand: vehicle.brand, model: vehicle.model, trim: vehicle.trim, model_year: vehicle.model_year },
    });
  });
  return { vehicle_id: vehicleId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Xiaohongshu accounts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add one of the dealer's own Xiaohongshu accounts. It starts active but NOT logged in (auth_state unknown) — the
 * operator logs it in by scanning the QR code with that account's app. `platform_account_id` is the key used by
 * XHS_MCP_ACCOUNTS; generated when not given.
 */
export function addAccount(ctx: AppContext, dealerId: string, raw: unknown, actor: string): XhsAccount {
  const dealer = getDealer(ctx, dealerId);
  const body = bodyObject(raw);
  const nickname = requiredText('小红书昵称', 40)(body.nickname, 'nickname');
  const typeRaw = requiredText('账号类型', 30)(body.account_type, 'account_type');
  if (!(ACCOUNT_TYPES as readonly string[]).includes(typeRaw)) throw new ValidationError('account_type', `账号类型需要是 ${ACCOUNT_TYPES.join(' / ')}`);
  const accountType = typeRaw as AccountType;
  const salespersonName = optionalText('销售姓名', 20)(body.salesperson_name, 'salesperson_name') ?? null;
  if (accountType === 'salesperson' && !salespersonName) throw new ValidationError('salesperson_name', '销售号需要填写销售姓名');
  const city = optionalText('所在城市', 30)(body.city, 'city') ?? dealer.city;
  const typedPlatformId = optionalText('账号标识', 64)(body.platform_account_id, 'platform_account_id');
  if (typedPlatformId !== undefined && !PLATFORM_ACCOUNT_ID_RE.test(typedPlatformId)) {
    throw new ValidationError('platform_account_id', '账号标识只能包含字母、数字、点、下划线和短横线（2-64 位）');
  }
  const platformAccountId = typedPlatformId ?? newId('xhs');
  const accounts = ctx.db.table('xhs_accounts');
  if (accounts.findOne({ platform_account_id: platformAccountId })) throw new ValidationError('platform_account_id', `账号标识「${platformAccountId}」已被使用`);

  // Check the instance address before creating anything, so a rejected address never leaves a half-configured account.
  const endpointRaw = optionalText('实例地址', 300)(body.mcp_endpoint_url, 'mcp_endpoint_url');
  const endpoint = endpointRaw ? validateEndpointUrl(endpointRaw) : null;
  if (endpoint) {
    const clash = accounts.query('mcp_endpoint_url IS NOT NULL').find((a) => normalizeEndpointUrl(a.mcp_endpoint_url ?? '') === endpoint);
    if (clash) {
      throw new PolicyError('endpoint_in_use', `该实例地址已被账号「${clash.nickname}」使用；每个小红书账号需要独立的 xiaohongshu-mcp 实例（独立端口与 cookies）`, { account_id: clash.id });
    }
  }

  const now = ctx.clock.iso();
  const created = ctx.db.tx(() => {
    const row = accounts.insert({
      id: newId('acc'),
      group_id: dealer.group_id,
      dealer_id: dealer.id,
      platform_account_id: platformAccountId,
      nickname,
      account_type: accountType,
      status: 'active',
      auth_state: 'unknown',
      auth_detail: '新添加的账号，尚未扫码登录',
      city,
      salesperson_name: salespersonName,
      outreach_approval_policy: null,
      daily_outreach_limit: null,
      daily_publish_limit: null,
      created_at: now,
      updated_at: now,
    });
    ctx.audit.event({
      actor,
      action: 'account.created',
      entity_type: 'xhs_account',
      entity_id: row.id,
      details: { dealer_id: dealer.id, nickname, account_type: accountType, platform_account_id: platformAccountId },
    });
    return row;
  });
  ensurePersona(ctx, created);
  return endpoint ? setAccountEndpoint(ctx, created.id, endpoint, actor) : created;
}

/** Delete an account added by mistake. Refused once leads, messages or content reference it — pause it instead. */
export interface RemoveAccountResult {
  account_id: string;
  /** 'deleted' = the row is gone; 'archived' = kept out of the fleet so its customer history keeps its author */
  mode: 'deleted' | 'archived';
  /** leads released back to the store's pool (never deleted with the account) */
  leads_released: number;
  outreach_cancelled: number;
  detail: string;
}

/**
 * Take an account out of the fleet. Leads are the store's, never the account's: every lead this account owned is
 * released back to the pool with its score, stage, signals and history intact, and can be assigned to any other
 * account right away. An account that never contacted a customer and published nothing is deleted outright; one that
 * did is archived (`removed_at`) so its sent DMs, conversations, appointments and notes keep their author — it gets
 * no work, disappears from the console, and its Xiaohongshu identity is freed so the same account can be added again.
 */
export function removeAccount(ctx: AppContext, accountId: string, actor: string): RemoveAccountResult {
  const account = ctx.db.table('xhs_accounts').get(accountId);
  if (!account) throw new NotFoundError('xhs_account', accountId);
  if (account.removed_at) return { account_id: accountId, mode: 'archived', leads_released: 0, outreach_cancelled: 0, detail: '该账号此前已移除' };
  // What would lose a real record of contact with a customer if the row disappeared (leads are not in this list).
  const history = {
    outreach_sent: count(ctx, `SELECT COUNT(*) AS n FROM outreach WHERE account_id = ? AND status IN ('SENT', 'SENT_MANUALLY')`, accountId),
    conversations: count(ctx, 'SELECT COUNT(*) AS n FROM conversations WHERE account_id = ?', accountId),
    appointments: count(ctx, 'SELECT COUNT(*) AS n FROM appointments WHERE account_id = ?', accountId),
    posts: count(ctx, 'SELECT COUNT(*) AS n FROM posts WHERE account_id = ?', accountId),
    engagement_replies: count(ctx, 'SELECT COUNT(*) AS n FROM engagement_replies WHERE account_id = ?', accountId),
  };
  const archive = Object.values(history).some((n) => n > 0);
  return ctx.db.tx(() => {
    const released = releaseAccountLeads(ctx, accountId, `账号「${account.nickname}」已移除`, actor);
    if (archive) {
      const now = ctx.clock.iso();
      ctx.db.table('xhs_accounts').update(accountId, {
        status: 'disabled',
        removed_at: now,
        auth_state: 'unknown',
        auth_detail: '账号已从账号矩阵移除（历史记录保留）',
        updated_at: now,
      });
      // Free the Xiaohongshu identity and the instance binding so the same account can be added again later.
      ctx.db.table('xhs_accounts').setNull(accountId, ['platform_account_id', 'mcp_endpoint_url', 'platform_user_id', 'platform_profile', 'platform_profile_at', 'auth_checked_at']);
    } else {
      ctx.db.run('DELETE FROM capability_snapshots WHERE account_id = ?', accountId);
      ctx.db.table('xhs_accounts').delete(accountId);
    }
    ctx.audit.event({
      actor,
      action: archive ? 'account.archived' : 'account.deleted',
      entity_type: 'xhs_account',
      entity_id: accountId,
      details: {
        dealer_id: account.dealer_id,
        nickname: account.nickname,
        platform_account_id: account.platform_account_id,
        leads_released: released.leads.length,
        outreach_cancelled: released.outreach_cancelled.length,
        ...(archive ? { kept_history: history } : {}),
      },
    });
    const leadNote = released.leads.length > 0 ? `${released.leads.length} 条线索已回到门店线索池，可分配给其他账号` : '该账号没有负责中的线索';
    return {
      account_id: accountId,
      mode: archive ? ('archived' as const) : ('deleted' as const),
      leads_released: released.leads.length,
      outreach_cancelled: released.outreach_cancelled.length,
      detail: archive ? `账号已移除，历史私信与内容记录保留；${leadNote}` : `账号已删除；${leadNote}`,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Readiness
// ─────────────────────────────────────────────────────────────────────────────

export interface SetupStep {
  key: 'dealer' | 'vehicles' | 'accounts' | 'login';
  label: string;
  done: boolean;
  /** false = recommended but does not block running */
  required: boolean;
  detail: string;
  path: string;
}

export interface SetupStatus {
  dealer_id: string;
  /** the provider has a real login-session API (QR login applies) */
  login_api: boolean;
  vehicles: number;
  accounts_active: number;
  /** active accounts whose login a live probe verified */
  accounts_logged_in: number;
  steps: SetupStep[];
  ready: boolean;
  /** why goals / workflow runs are refused; null when ready */
  blocker: string | null;
}

export function getSetupStatus(ctx: AppContext, dealerId: string): SetupStatus {
  const dealer = getDealer(ctx, dealerId);
  const loginApi = Boolean(ctx.xhs.auth);
  // 车型库: only the live line-up counts — an archived trim is history, not something the store can sell today.
  const vehicles = count(ctx, 'SELECT COUNT(*) AS n FROM vehicles WHERE group_id = ? AND archived_at IS NULL', dealer.group_id);
  const accountsActive = count(ctx, "SELECT COUNT(*) AS n FROM xhs_accounts WHERE dealer_id = ? AND status = 'active'", dealerId);
  const accountsLoggedIn = count(
    ctx,
    "SELECT COUNT(*) AS n FROM xhs_accounts WHERE dealer_id = ? AND status = 'active' AND auth_state = 'authenticated' AND auth_checked_at IS NOT NULL",
    dealerId,
  );

  let blocker: string | null = null;
  if (accountsActive === 0) blocker = '还没有添加小红书账号：请先在「账号」页添加您自己的小红书账号并扫码登录，再下达目标或运行任务';
  else if (loginApi && accountsLoggedIn === 0) {
    blocker = '还没有已登录的小红书账号：请在「账号」页点「扫码登录」，用该账号本人的小红书 App 扫码，登录成功后再下达目标或运行任务';
  }

  const steps: SetupStep[] = [
    { key: 'dealer', label: '填写门店信息', done: true, required: true, detail: `${dealer.name} · ${dealer.brands.join('、')} · ${dealer.city}`, path: '/setup' },
    {
      key: 'vehicles',
      label: '建立在售车型库',
      done: vehicles > 0,
      required: false,
      detail:
        vehicles > 0
          ? `车型库有 ${vehicles} 个在售配置`
          : '把门店当前在售的全部车型和配置录进车型库：价格、参数、颜色库存、金融政策都从这里取，没有车型就只能按品牌搜索，也答不了价格和现车问题（系统不会用任何示例车型代替）',
      path: '/vehicles',
    },
    {
      key: 'accounts',
      label: '添加小红书账号',
      done: accountsActive > 0,
      required: true,
      detail: accountsActive > 0 ? `${accountsActive} 个活跃账号` : '还没有账号',
      path: '/accounts#add-account',
    },
    {
      key: 'login',
      label: '扫码登录小红书',
      done: loginApi ? accountsLoggedIn > 0 : accountsActive > 0,
      required: true,
      detail: loginApi
        ? accountsLoggedIn > 0
          ? `${accountsLoggedIn} 个账号已登录（真实检测）`
          : '尚无已登录账号'
        : `当前数据源 ${ctx.xhs.name}（${ctx.xhs.mode}）没有登录会话，不需要扫码`,
      path: '/accounts',
    },
  ];
  return { dealer_id: dealerId, login_api: loginApi, vehicles, accounts_active: accountsActive, accounts_logged_in: accountsLoggedIn, steps, ready: blocker === null, blocker };
}

/** Throws PolicyError `setup_incomplete` unless the dealer has an active (and, where applicable, logged-in) account. */
export function requireReadyToRun(ctx: AppContext, dealerId: string): SetupStatus {
  const status = getSetupStatus(ctx, dealerId);
  if (!status.ready) throw new PolicyError('setup_incomplete', status.blocker ?? '门店设置未完成', { dealer_id: dealerId });
  return status;
}
