/**
 * 还没做完的功能：说一次，说清楚，然后别挡路。
 *
 * The registry stays — a feature that does not exist must never look like it works. What changed is where it is
 * said: a disabled button on every screen taught salespeople that the product is broken, so the disclosure now lives
 * in one place (系统 → 还没做完的功能) and the page helpers render nothing.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { RequestContext } from '../../../src/server/http.ts';
import type { PageEnv } from '../../../src/server/pages/shell.ts';
import { systemPage } from '../../../src/server/pages/system.ts';
import { unfinishedBlock, unfinishedButton, unfinishedTag } from '../../../src/server/render.ts';
import { UNFINISHED } from '../../../src/server/unfinished.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';

const PAGES_DIR = new URL('../../../src/server/pages/', import.meta.url);
const pageSources = readdirSync(PAGES_DIR)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => readFileSync(new URL(f, PAGES_DIR), 'utf8'))
  .join('\n');

const env = (ctx: TestContext) =>
  ({
    runtime: {
      ctx,
      config: { warnings: [] },
      engine: { list: () => [], listRuns: () => [], has: () => false },
      scheduler: { listSchedules: () => [] },
    },
    options: { auth_enabled: true },
  }) as unknown as PageEnv;

describe('还没做完的功能', () => {
  it('every registry key is still referenced by the page that would own it', () => {
    for (const key of Object.keys(UNFINISHED)) {
      assert.match(pageSources, new RegExp(`unfinished(?:Tag|Button|Block)\\('${key}'`), `${key} 在页面里没有对应位置`);
    }
    for (const m of pageSources.matchAll(/unfinished(?:Tag|Button|Block)\('([a-z_]+)'/g)) {
      assert.ok(m[1]! in UNFINISHED, `placeholder ${m[1]} is not in the registry`);
    }
  });

  it('renders nothing on a page: no dead buttons, no dashed blocks, no 未完成 tags', () => {
    assert.equal(unfinishedButton('goal_pause', '暂停 / 恢复'), '');
    assert.equal(unfinishedTag('goal_pause'), '');
    assert.equal(unfinishedBlock('lost_reason_analysis'), '');
  });

  it('is disclosed in one place: the 系统 page lists every one of them', () => {
    const ctx = createTestContext();
    const dealerId = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const rc = { query: new URLSearchParams({ dealer: dealerId }), params: {}, req: { headers: {} }, operator: 'op' } as unknown as RequestContext;
    const html = String(systemPage(env(ctx), rc).html);
    for (const feature of Object.values(UNFINISHED)) {
      assert.ok(html.includes(feature.title), `系统页没有列出「${feature.title}」`);
    }
  });
});
