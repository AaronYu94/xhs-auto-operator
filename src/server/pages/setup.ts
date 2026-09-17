/** 设置: the dealer's own store information and models, and where its own Xiaohongshu accounts stand. */
import type { AppContext } from '../../app/context.ts';
import type { Dealer } from '../../core/types.ts';
import { getBrandInfo } from '../../domain/automotive-lexicon.ts';
import { getSetupStatus, type SetupStatus, type SetupStep } from '../../operator/onboarding.ts';
import type { Reply, RequestContext } from '../http.ts';
import { cny, esc, href, table } from '../render.ts';
import { renderPage, resolveDealer, type PageEnv } from './shell.ts';

const POWERTRAIN_LABEL: Record<string, string> = { EV: '纯电', PHEV: '插电混动', HEV: '油电混动', ICE: '燃油' };
const STEP_LABEL: Record<SetupStep['key'], string> = { dealer: '门店信息', vehicles: '在售车型', accounts: '小红书账号', login: '扫码登录' };
const NEXT_ACTION: Partial<Record<SetupStep['key'], { hint: string; action: string }>> = {
  accounts: { hint: '还没有小红书账号', action: '添加账号' },
  login: { hint: '账号还没有扫码登录', action: '去扫码登录' },
};

/** '/accounts#add-account' + dealer → '/accounts?dealer=…#add-account' */
function stepHref(path: string, dealerId: string): string {
  const [p, hash] = path.split('#');
  return `${href(p, { dealer: dealerId })}${hash ? `#${hash}` : ''}`;
}

const brandLabel = (brand: string): string => {
  const zh = getBrandInfo(brand)?.brand_zh;
  return zh && zh !== brand ? `${zh}（${brand}）` : brand;
};

/** One line: what is done, and the single next thing to do. */
export function setupSteps(status: SetupStatus, dealerId: string): string {
  const next = status.steps.find((s) => s.required && !s.done);
  const items = status.steps
    .map((s) => `<li class="${s.done ? 'done' : s === next ? 'todo' : ''}">${esc(STEP_LABEL[s.key])}</li>`)
    .join('');
  const nextAction = next ? NEXT_ACTION[next.key] : undefined;
  const action = nextAction
    ? `<span class="small">${esc(nextAction.hint)}</span><a class="btn btn-primary btn-sm" href="${esc(stepHref(next!.path, dealerId))}">${esc(nextAction.action)}</a>`
    : `<span class="small">可以开始运行</span><a class="btn btn-ink btn-sm" href="${esc(href('/', { dealer: dealerId }))}">去下达目标</a>`;
  return `<div class="setup-next"><ol class="setup-progress">${items}</ol><span class="spacer"></span>${action}</div>`;
}

function field(label: string, control: string, opts: { optional?: boolean; wide?: boolean } = {}): string {
  return `<label${opts.wide ? ' class="wide"' : ''}><span>${esc(label)}${opts.optional ? '<span class="opt">选填</span>' : ''}</span>${control}</label>`;
}

function dealerFields(d: Dealer | null): string {
  const val = (x: string | null | undefined) => esc(x ?? '');
  // New store: blank optional fields are not sent. Existing store: a blank optional field clears it.
  const opt = d ? '' : ' data-optional';
  return [
    field('门店名称', `<input type="text" name="name" required maxlength="60" value="${val(d?.name)}">`),
    field('经营品牌', `<input type="text" name="brands" required maxlength="200" value="${val(d?.brands.map(brandLabel).join('、'))}" placeholder="多个用逗号分隔">`),
    field('城市', `<input type="text" name="city" required maxlength="30" value="${val(d?.city)}">`),
    field('省份', `<input type="text" name="province" maxlength="30" value="${val(d?.province)}"${opt}${d ? '' : ' placeholder="按城市自动识别"'}>`, { optional: true }),
    field('门店电话', `<input type="text" name="phone" maxlength="40" value="${val(d?.phone)}"${opt}>`, { optional: true }),
    field('营业时间', `<input type="text" name="business_hours" maxlength="100" value="${val(d?.business_hours)}"${opt} placeholder="如 09:00-18:00">`, { optional: true }),
    field('门店地址', `<input type="text" name="address" maxlength="200" value="${val(d?.address)}"${opt}>`, { optional: true, wide: true }),
  ].join('');
}

function createPage(env: PageEnv, rc: RequestContext, dealer: Dealer | null, dealers: Dealer[]): Reply {
  const { ctx } = env.runtime;
  const first = !dealer;
  const groups = ctx.db.table('dealer_groups').findMany({}, { orderBy: 'created_at ASC, name ASC' });
  const groupFields = [
    groups.length
      ? field('所属集团', `<select name="group_id" data-optional><option value="">新建</option>${groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}</select>`, { optional: true })
      : '',
    field('集团/公司名称', '<input type="text" name="group_name" maxlength="60" data-optional placeholder="默认同门店名称">', { optional: true }),
  ].join('');
  const cancel = first ? '' : `<a class="btn btn-ghost btn-sm" href="${esc(href('/setup', { dealer: dealer.id }))}">取消</a>`;
  const body = `<div class="setup">
<section class="setting">
  <div class="setting-head"><h2>门店信息</h2></div>
  <form class="stack" data-api="/api/dealers" data-success="门店已创建" data-redirect="/setup?dealer={id}">
    <div class="fields">${dealerFields(null)}${groupFields}</div>
    <div class="form-actions">${cancel}<button class="btn btn-primary btn-sm" type="submit">创建门店</button></div>
  </form>
</section>
<p class="small muted">从其他系统迁移？可以在 <a class="link" href="/system#dealer-brain">系统页用 JSON 批量导入</a>。</p>
</div>`;
  return renderPage(env, rc, {
    title: '设置',
    active: 'setup',
    dealer,
    dealers,
    h1: first ? '填写门店信息' : '新增门店',
    subtitle: first ? '先建门店，再添加车型和小红书账号' : '同一集团下可以有多家门店',
    body,
  });
}

export function setupPage(env: PageEnv, rc: RequestContext): Reply {
  const { ctx } = env.runtime;
  const { dealer, dealers } = resolveDealer(ctx, rc);
  if (!dealer || rc.query.get('new') === '1') return createPage(env, rc, dealer, dealers);

  const status = getSetupStatus(ctx, dealer.id);
  const vehicles = ctx.db.table('vehicles').findMany({ group_id: dealer.group_id }, { orderBy: 'brand ASC, model ASC, model_year DESC, trim ASC' });
  const vehicleRows = vehicles.map((x) => [
    `<div class="primary" style="font-size:15px">${esc(x.brand_zh === x.model_zh ? x.model_zh : `${x.brand_zh} ${x.model_zh}`)}</div><div class="secondary">${esc(x.trim)}，${esc(x.model_year)}款${x.specs.powertrain ? `，${esc(POWERTRAIN_LABEL[x.specs.powertrain] ?? x.specs.powertrain)}` : ''}</div>`,
    `<span class="num">${esc(cny(x.msrp))}</span>`,
    `<button class="btn btn-ghost btn-sm" data-action="call" data-method="DELETE" data-url="/api/vehicles/${esc(x.id)}" data-confirm="确认删除？" data-success="车型已删除">删除</button>`,
  ]);
  const vehicleForm = `<form class="stack" data-api="/api/dealers/${esc(dealer.id)}/vehicles" data-success="车型已添加">
    <div class="fields">
      ${field('品牌', `<select name="brand">${dealer.brands.map((b) => `<option value="${esc(b)}">${esc(brandLabel(b))}</option>`).join('')}</select>`)}
      ${field('车型', '<input type="text" name="model" required maxlength="40">')}
      ${field('配置/版本', '<input type="text" name="trim" required maxlength="60" placeholder="与厂商价格表一致">')}
      ${field('年款', '<input type="number" name="model_year" required min="1990" max="2100">')}
      ${field('厂商指导价（元）', '<input type="number" name="msrp" required min="1">')}
      ${field('动力类型', `<select name="powertrain" data-optional><option value="">不填</option>${Object.entries(POWERTRAIN_LABEL).map(([k, label]) => `<option value="${k}">${esc(label)}</option>`).join('')}</select>`, { optional: true })}
      ${field('卖点', '<textarea name="highlights" maxlength="1000" data-optional placeholder="每行一条"></textarea>', { optional: true, wide: true })}
      ${field('客户常用叫法', '<input type="text" name="aliases" maxlength="300" data-optional placeholder="多个用逗号分隔">', { optional: true, wide: true })}
    </div>
    <div class="form-actions"><button class="btn btn-ink btn-sm" type="submit">添加</button></div>
  </form>`;

  const body = `<div class="setup">
${setupSteps(status, dealer.id)}
<section class="setting" id="dealer-info">
  <div class="setting-head"><h2>门店信息</h2></div>
  <form class="stack" data-api="/api/dealers/${esc(dealer.id)}" data-method="PATCH" data-success="已保存">
    <div class="fields">${dealerFields(dealer)}</div>
    <div class="form-actions"><button class="btn btn-ink btn-sm" type="submit">保存</button></div>
  </form>
</section>
<section class="setting" id="vehicles">
  <div class="setting-head"><h2>在售车型</h2><p>搜索词、意向匹配和价格回答只用这里的数据。</p></div>
  <div>
    ${table(['车型', '指导价', ''], vehicleRows, { compact: true, empty: '还没有车型' })}
    <details class="adder"${vehicles.length ? '' : ' open'}><summary class="btn btn-ghost btn-sm">添加车型</summary>${vehicleForm}</details>
  </div>
</section>
<section class="setting" id="accounts">
  <div class="setting-head"><h2>小红书账号</h2></div>
  <div class="row"><span>${esc(status.accounts_active)} 个账号${status.login_api ? `，${esc(status.accounts_logged_in)} 个已登录` : ''}</span><span class="spacer"></span><a class="btn btn-ghost btn-sm" href="${esc(stepHref('/accounts#add-account', dealer.id))}">管理账号</a></div>
</section>
<section class="setting">
  <div class="setting-head"><h2>其他</h2></div>
  <div class="row">
    <a class="btn btn-ghost btn-sm" href="/setup?new=1">新增门店</a>
    <a class="btn btn-ghost btn-sm" href="${esc(href('/system', { dealer: dealer.id }))}#dealer-brain">JSON 批量导入</a>
    <span class="spacer"></span>
    <button class="btn btn-danger btn-sm" data-action="call" data-method="DELETE" data-url="/api/dealers/${esc(dealer.id)}" data-confirm="确认删除门店？" data-success="门店已删除" data-redirect="/setup" title="已有线索或内容的门店不能删除">删除门店</button>
  </div>
</section>
</div>`;

  return renderPage(env, rc, { title: '设置', active: 'setup', dealer, dealers, h1: '设置', subtitle: dealer.name, body });
}
