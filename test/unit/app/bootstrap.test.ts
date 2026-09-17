import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createRuntime } from '../../../src/app/bootstrap.ts';
import { loadConfig } from '../../../src/app/config.ts';
import { ManualClock } from '../../../src/core/clock.ts';
import { newId } from '../../../src/core/ids.ts';
import { silentLogger } from '../../../src/core/logger.ts';
import { DEFAULT_DAILY_SCHEDULE } from '../../../src/operator/scheduler.ts';
import { INTERRUPTED_ERROR } from '../../../src/operator/workflow-engine.ts';
import { TEST_NOW } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xhs-runtime-'));
  dirs.push(dir);
  return join(dir, 'data', 'operator.db');
}

describe('createRuntime', () => {
  it('persists across restart and recovers workflow runs interrupted by the restart', async () => {
    const dbPath = tempDbPath();
    const config = loadConfig({ APP_ENV: 'test', DATABASE_PATH: dbPath, XHS_PROVIDER: 'none' });
    const clock = new ManualClock(TEST_NOW);

    const first = await createRuntime(config, { clock, logger: silentLogger });
    const dealerId = dealerIdByKey(loadDealerFixture(first.ctx), 'hz-bmw');
    assert.equal(first.ensureSchedules(), 2);
    assert.equal(first.ctx.db.table('schedules').count({ dealer_id: dealerId }), DEFAULT_DAILY_SCHEDULE.length);
    assert.ok(first.ctx.skills.list().length >= 20);
    assert.equal(first.ctx.xhs.mode, 'none');
    // a run left RUNNING by a crashed process
    const stuck = first.ctx.db.table('workflow_runs').insert({
      id: newId('wf'),
      workflow: 'lead_discovery',
      dealer_id: dealerId,
      goal_id: null,
      trigger: 'schedule',
      status: 'RUNNING',
      input: { dealer_id: dealerId },
      output: {},
      error: null,
      resumed_from_run_id: null,
      started_at: clock.iso(),
      finished_at: null,
    });
    const stop = first.startScheduler();
    assert.equal(typeof stop, 'function');
    stop();
    await first.close();
    await first.close(); // idempotent

    const second = await createRuntime(config, { clock, logger: silentLogger });
    try {
      assert.equal(second.ctx.db.table('dealers').count(), 2, 'dealer data survived the restart');
      assert.equal(second.ctx.db.table('xhs_accounts').count({ dealer_id: dealerId }), 6);
      assert.deepEqual(
        second.recovered.map((r) => r.id),
        [stuck.id],
      );
      const recovered = second.ctx.db.table('workflow_runs').require(stuck.id);
      assert.equal(recovered.status, 'FAILED');
      assert.equal(recovered.error, INTERRUPTED_ERROR);
      const migrations = second.ctx.db.all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version');
      assert.ok(migrations.map((m) => m.version).includes(3));
      // the resumed run executes with the real workflows (no provider → honest skip, not a crash)
      const resumed = await second.engine.resume(second.ctx, stuck.id);
      assert.notEqual(resumed.status, 'RUNNING');
    } finally {
      await second.close();
    }
  });

  it('simulation provider in development gets the internal → platform account mapping', async () => {
    const config = loadConfig({ APP_ENV: 'development', DATABASE_PATH: tempDbPath(), XHS_PROVIDER: 'simulation' });
    const runtime = await createRuntime(config, { clock: new ManualClock(TEST_NOW), logger: silentLogger });
    try {
      assert.equal(runtime.ctx.xhs.mode, 'simulation');
      const report = await runtime.ctx.xhs.capabilities(null);
      assert.equal(report.mode, 'simulation');
    } finally {
      await runtime.close();
    }
  });

  it('refuses to start without a valid configuration (no silent defaults in production)', () => {
    assert.throws(() => loadConfig({ APP_ENV: 'production', XHS_PROVIDER: 'simulation' }), /模拟数据不允许用于生产环境/);
  });
});
