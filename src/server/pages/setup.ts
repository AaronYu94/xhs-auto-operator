/**
 * 设置: the dealer's own store information and models, and where its own Xiaohongshu accounts stand.
 *
 * A salesperson fills this in, so every field is one they can answer from the showroom. Explanations live behind the
 * 「?」 next to the label, never as a paragraph under the heading, and nothing here mentions a command, a file path or
 * an environment variable — the person reading this page does not have a terminal.
 */
import type { AppContext } from '../../app/context.ts';
import { DM_CHANNELS, type Dealer } from '../../core/types.ts';
import { getBrandInfo } from '../../domain/automotive-lexicon.ts';
import { getSetupStatus, type SetupStatus, type SetupStep } from '../../operator/onboarding.ts';
import type { Reply, RequestContext } from '../http.ts';
import { hint } from '../hint.ts';
import { cny, esc, href, table, unfinishedBlock, unfinishedButton } from '../render.ts';
import { renderPage, resolveDealer, type PageEnv } from './shell.ts';

const POWERTRAIN_LABEL: Record<string, string> = { EV: '纯电', PHEV: '插电混动', HEV: '油电混动', ICE: '燃油' };
const DM_CHANNEL_LABEL: Record<(typeof DM_CHANNELS)[number], string> = { app: '小红书 App / 网页版', pro: '专业号客服工作台（pro.xiaohongshu.com）' };
const DM_CHANNEL_OPTIONS = DM_CHANNELS.map((c) => [c, DM_CHANNEL_LABEL[c]] as const);
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

function field(label: string, control: string, opts: { optional?: boolean; wide?: boolean; help?: string | readonly string[] } = {}): string {
  const help = opts.help ? hint(opts.help) : '';
  return `<label${opts.wide ? ' class="wide"' : ''}><span>${esc(label)}${help}${opts.optional ? '<span class="opt">选填</span>' : ''}</span>${control}</label>`;
}

/** A section heading with its explanation one click away, instead of a paragraph nobody reads. */
function settingHead(title: string, help?: string | readonly string[]): string {
  return `<div class="setting-head"><h2>${esc(title)}${help ? hint(help) : ''}</h2></div>`;
}

function dealerFields(d: Dealer | null): string {
  const val = (x: string | null | undefined) => esc(x ?? '');
  // New store: blank optional fields are not sent. Existing store: a blank optional field clears it.
  const opt = d ? '' : ' data-optional';
  return [
    field('门店名称', `<input type="text" name="name" required maxlength="60" value="${val(d?.name)}">`, {
      help: '写门店对外用的全称，客户在私信里看到的就是它。',
    }),
    field('经营品牌', `<input type="text" name="brands" required maxlength="200" value="${val(d?.brands.map(brandLabel).join('、'))}" placeholder="多个用逗号分隔">`, {
      help: '只有这里写了的品牌，才能往「在售车型」里加车；找客户时也只认这些品牌和它们的竞品。',
    }),
    field('城市', `<input type="text" name="city" required maxlength="30" value="${val(d?.city)}">`, {
      help: '用来判断一条线索是不是本地人：外地客户会自动降分，避免销售白跑。',
    }),
    field('省份', `<input type="text" name="province" maxlength="30" value="${val(d?.province)}"${opt}${d ? '' : ' placeholder="按城市自动识别"'}>`, { optional: true }),
    field('门店电话', `<input type="text" name="phone" maxlength="40" value="${val(d?.phone)}"${opt}>`, {
      optional: true,
      help: '客户问「打哪个电话」时，AI 只会报这里填的号码，填错就会一直报错的。',
    }),
    field('营业时间', `<input type="text" name="business_hours" maxlength="100" value="${val(d?.business_hours)}"${opt} placeholder="如 09:00-18:00">`, {
      optional: true,
      help: '约客户到店时按这个时间说，也用来判断哪些时段适合约看车。',
    }),
    field('门店地址', `<input type="text" name="address" maxlength="200" value="${val(d?.address)}"${opt}>`, {
      optional: true,
      wide: true,
      help: '客户问地址时 AI 照这里回，没填就只能说「稍后发给您」。',
    }),
  ].join('');
}

/** Where this store's salespeople actually paste a reviewed DM. Neither option lets Steer send by itself. */
function dmChannelForm(d: Dealer): string {
  const current = d.settings.dm_channel ?? 'app';
  const options = DM_CHANNEL_OPTIONS.map(
    ([value, label]) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`,
  ).join('');
  return `<form class="stack" data-api="/api/dealers/${esc(d.id)}" data-method="PATCH" data-success="已保存">
    <div class="fields">${field('销售在哪里发私信', `<select name="dm_channel">${options}</select>`, {
      help: [
        '私信永远是销售本人发的：系统只写草稿，发完回来点一下登记。选这里只是为了把草稿旁边的按钮和链接指到你们实际用的地方。',
        '选「小红书 App / 网页版」就是复制草稿到手机上发；选「专业号客服工作台」会多给一个直接打开工作台的链接。',
      ],
    })}</div>
    <div class="form-actions"><button class="btn btn-ink btn-sm" type="submit">保存</button></div>
  </form>`;
}

function createPage(env: PageEnv, rc: RequestContext, dealer: Dealer | null, dealers: Dealer[]): Reply {
  const { ctx } = env.runtime;
  const first = !dealer;
  const groups = ctx.db.table('dealer_groups').findMany({}, { orderBy: 'created_at ASC, name ASC' });
  const groupFields = [
    groups.length
      ? field('所属集团', `<select name="group_id" data-optional><option value="">新建</option>${groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}</select>`, {
          optional: true,
          help: '同一个集团下的门店共用一套车型资料，不用每家店重录一遍。',
        })
      : '',
    field('集团/公司名称', '<input type="text" name="group_name" maxlength="60" data-optional placeholder="默认同门店名称">', { optional: true }),
  ].join('');
  const cancel = first ? '' : `<a class="btn btn-ghost btn-sm" href="${esc(href('/setup', { dealer: dealer.id }))}">取消</a>`;
  const body = `<div class="setup">
<section class="setting">
  ${settingHead('门店信息', '这几项是整套系统的底子：找哪里的客户、能卖什么品牌、客户问电话地址时怎么回，都看这里。')}
  <form class="stack" data-api="/api/dealers" data-success="门店已创建" data-redirect="/setup?dealer={id}">
    <div class="fields">${dealerFields(null)}${groupFields}</div>
    <div class="form-actions">${cancel}<button class="btn btn-primary btn-sm" type="submit">创建门店</button></div>
  </form>
</section>
<p class="small muted">已经有整套门店资料的备份？可以直接<a class="link" href="/system#dealer-brain">整包导入</a>。</p>
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
    `<a class="btn btn-ghost btn-sm" href="${esc(href(`/vehicles/${x.id}`, { dealer: dealer.id }))}">车型卡片</a>`,
  ]);
  const vehicleForm = `<form class="stack" data-api="/api/dealers/${esc(dealer.id)}/vehicles" data-success="车型已添加">
    <div class="fields">
      ${field('品牌', `<select name="brand">${dealer.brands.map((b) => `<option value="${esc(b)}">${esc(brandLabel(b))}</option>`).join('')}</select>`)}
      ${field('车型', '<input type="text" name="model" required maxlength="40">')}
      ${field('配置/版本', '<input type="text" name="trim" required maxlength="60" placeholder="与厂商价格表一致">', {
        help: '和厂商价格表写成一样，客户报配置名时系统才认得出是哪一台。',
      })}
      ${field('年款', '<input type="number" name="model_year" required min="1990" max="2100">')}
      ${field('厂商指导价（元）', '<input type="number" name="msrp" required min="1">', {
        help: '填指导价。门店实际售价和优惠在「系统 → 门店资料」里维护，AI 只会报这两处写过的数字。',
      })}
      ${field('动力类型', `<select name="powertrain" data-optional><option value="">不填</option>${Object.entries(POWERTRAIN_LABEL).map(([k, label]) => `<option value="${k}">${esc(label)}</option>`).join('')}</select>`, { optional: true })}
      ${field('卖点', '<textarea name="highlights" maxlength="1000" data-optional placeholder="每行一条"></textarea>', {
        optional: true,
        wide: true,
        help: '写平时跟客户讲的那几句。AI 写笔记和私信时会从这里挑，不会自己编参数。',
      })}
      ${field('客户常用叫法', '<input type="text" name="aliases" maxlength="300" data-optional placeholder="多个用逗号分隔">', {
        optional: true,
        wide: true,
        help: '客户在小红书上怎么叫这台车就怎么填（小名、简称、错别字都行），填了才搜得到相关的人。',
      })}
    </div>
    <div class="form-actions"><button class="btn btn-ink btn-sm" type="submit">添加</button></div>
  </form>`;

  const body = `<div class="setup">
${setupSteps(status, dealer.id)}
<section class="setting" id="dealer-info">
  ${settingHead('门店信息', '这几项是整套系统的底子：找哪里的客户、能卖什么品牌、客户问电话地址时怎么回，都看这里。')}
  <form class="stack" data-api="/api/dealers/${esc(dealer.id)}" data-method="PATCH" data-success="已保存">
    <div class="fields">${dealerFields(dealer)}</div>
    <div class="form-actions"><button class="btn btn-ink btn-sm" type="submit">保存</button></div>
  </form>
</section>
<section class="setting" id="vehicles">
  ${settingHead('在售车型', [
    '写笔记、发私信、回客户时报的价格、参数、颜色和库存，只能从这里取，取不到就不说。',
    '所以这里要的是门店当前真正在卖的全部车型和配置——系统不会拿任何示例车型顶替。',
  ])}
  <div>
    ${vehicles.length === 0 ? '<div class="banner banner-amber">还没有车型，AI 现在没有任何真实数据可用。</div>' : ''}
    ${table(['车型', '指导价', ''], vehicleRows, { compact: true, empty: '还没有车型' })}
    <div class="row" style="margin-top:10px">
      <a class="btn btn-ink btn-sm" href="${esc(href('/vehicles', { dealer: dealer.id }))}">打开车型库</a>
      <a class="btn btn-ghost btn-sm" href="${esc(href('/vehicles', { dealer: dealer.id }))}#import">批量导入</a>
    </div>
    <details class="adder"${vehicles.length ? '' : ' open'}><summary class="btn btn-ghost btn-sm">添加车型</summary>${vehicleForm}</details>
  </div>
</section>
<section class="setting" id="policies">
  ${settingHead('私信方式', '私信由销售本人发出，这里只决定草稿旁边的按钮指向哪里。')}
  ${dmChannelForm(dealer)}
  ${unfinishedBlock('dealer_policy_edit')}
</section>
<section class="setting" id="accounts">
  ${settingHead('小红书账号', '每个账号都要本人扫码登录一次，系统才能用它搜内容、发笔记。掉登录了这里会显示。')}
  <div class="row"><span>${esc(status.accounts_active)} 个账号${status.login_api ? `，${esc(status.accounts_logged_in)} 个已登录` : ''}</span><span class="spacer"></span><a class="btn btn-ghost btn-sm" href="${esc(stepHref('/accounts#add-account', dealer.id))}">管理账号</a></div>
</section>
<section class="setting">
  ${settingHead('其他')}
  <div class="row">
    <a class="btn btn-ghost btn-sm" href="/setup?new=1">新增门店</a>
    <a class="btn btn-ghost btn-sm" href="${esc(href('/system', { dealer: dealer.id }))}#dealer-brain">整包导入门店资料</a>
    <span class="spacer"></span>
    <button class="btn btn-danger btn-sm" data-action="call" data-method="DELETE" data-url="/api/dealers/${esc(dealer.id)}" data-confirm="确认删除门店？" data-success="门店已删除" data-redirect="/setup" title="已经有线索或内容的门店不能删除">删除门店</button>
  </div>
</section>
</div>`;

  return renderPage(env, rc, {
    title: '设置',
    active: 'setup',
    dealer,
    dealers,
    h1: '设置',
    help: [
      '门店的基本信息：店名、品牌、城市、电话、地址、营业时间，还有在售车型。',
      'AI 对外说的每一句话都从这里和「车型」页取数据，这里填错了，外面就会说错。',
    ],
    subtitle: dealer.name,
    body,
  });
}
