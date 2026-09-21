/**
 * 在售车型 page: the line-up as photo cards, and one card page where facts and AI-written prose stay visibly apart.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RequestContext } from '../../../src/server/http.ts';
import type { PageEnv } from '../../../src/server/pages/shell.ts';
import { vehicleDetailPage, vehiclesPage } from '../../../src/server/pages/vehicles.ts';
import { archiveVehicle, updateVehicle } from '../../../src/skills/operations/vehicle-brain/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture, vehicleIdByKey } from '../../helpers/fixtures.ts';

const env = (ctx: TestContext) => ({ runtime: { ctx, config: { warnings: [] } }, options: { auth_enabled: true } }) as unknown as PageEnv;
const rc = (query: Record<string, string>, params: Record<string, string> = {}) =>
  ({ query: new URLSearchParams(query), params, req: { headers: {} }, operator: 'op' }) as unknown as RequestContext;

function setup(): { ctx: TestContext; hz: string; i3: string } {
  const ctx = createTestContext();
  const summary = loadDealerFixture(ctx);
  return { ctx, hz: dealerIdByKey(summary, 'hz-bmw'), i3: vehicleIdByKey(summary, 'i3-edrive35l') };
}

describe('在售车型 page', () => {
  it('lists the line-up with real prices, stock and what still needs AI material', () => {
    const { ctx, hz } = setup();
    const html = String(vehiclesPage(env(ctx), rc({ dealer: hz })).html);
    assert.match(html, /宝马i3/);
    assert.match(html, /35\.39万/);
    assert.match(html, /现车 3 台/);
    assert.match(html, /还没写介绍/);
    assert.match(html, /批量导入/);
    assert.doesNotMatch(html, /检索/, '页面上不出现「检索」这类技术词');
    assert.doesNotMatch(html.split('veh-grid')[1] ?? '', /已归档/, '没有归档车型时卡片上不显示归档标记');
  });

  it('an archived trim moves to its own tab instead of disappearing', () => {
    const { ctx, hz, i3 } = setup();
    archiveVehicle(ctx, i3, 'operator:li');
    const live = String(vehiclesPage(env(ctx), rc({ dealer: hz })).html);
    assert.doesNotMatch(live.split('veh-grid')[1] ?? '', /eDrive35L/);
    const archived = String(vehiclesPage(env(ctx), rc({ dealer: hz, archived: '1' })).html);
    assert.match(archived, /eDrive35L/);
    assert.match(archived, /已归档/);
    assert.doesNotMatch(archived.split('veh-grid')[1] ?? '', /530Li/, '归档页只显示归档车型，不再混进在售车型');
  });

  it('the card page separates 事实 from 介绍文案 and offers the AI button', () => {
    const { ctx, hz, i3 } = setup();
    updateVehicle(
      ctx,
      i3,
      {
        current_price: 333_900,
        description: '城市通勤的纯电轿车',
        target_customers: ['第一次买电车的家庭'],
        faqs: [{ question: '充电方便吗？', answer: '支持快充。' }],
        competitors: [{ name: '特斯拉 Model 3', note: '内饰更传统' }],
        content_angles: ['通勤党的一周'],
      },
      'operator:li',
    );
    const html = String(vehicleDetailPage(env(ctx), rc({ dealer: hz }, { id: i3 })).html);
    assert.match(html, /事实/);
    assert.match(html, /介绍文案/);
    assert.match(html, /33\.39万/);
    assert.match(html, /35\.39万/, '指导价仍然显示');
    assert.match(html, /续航/);
    assert.match(html, /白 \/ 红/);
    assert.match(html, /i3 36期0息/);
    assert.match(html, /第一次买电车的家庭/);
    assert.match(html, /充电方便吗？/);
    assert.match(html, /特斯拉 Model 3/);
    assert.match(html, /让 AI 写一份介绍/);
    assert.match(html, /\/api\/vehicles\/[^"]+\/archive/);
  });

  it('a trim with no stock says so on its card', () => {
    const ctx = createTestContext();
    const summary = loadDealerFixture(ctx);
    const hz = dealerIdByKey(summary, 'hz-bmw');
    const html = String(vehicleDetailPage(env(ctx), rc({ dealer: hz }, { id: vehicleIdByKey(summary, '5series-530li') })).html);
    assert.match(html, /暂无车源/);
    assert.match(html, /现在没有现车/);
  });
});
