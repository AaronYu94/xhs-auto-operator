import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { NotFoundError, ValidationError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import type { Logger } from '../../../src/core/logger.ts';
import type { Dealer } from '../../../src/core/types.ts';
import {
  DEFAULT_DAILY_SCHEDULE,
  Scheduler,
  evaluateSchedule,
  parseCron,
} from '../../../src/operator/scheduler.ts';
import { WorkflowEngine, type WorkflowDef } from '../../../src/operator/workflow-engine.ts';
import { TEST_NOW, createTestContext, type TestContext } from '../../helpers/context.ts';

function seedDealer(ctx: TestContext, opts: { name?: string; timezone?: string } = {}): Dealer {
  const now = ctx.clock.iso();
  const group =
    ctx.db.table('dealer_groups').findOne({}) ??
    ctx.db.table('dealer_groups').insert({ id: newId('grp'), name: '浙沪宝马经销商集团', created_at: now });
  return ctx.db.table('dealers').insert({
    id: newId('dlr'),
    group_id: group.id,
    name: opts.name ?? '杭州宝马中心',
    brands: ['BMW'],
    city: '杭州',
    province: '浙江',
    address: '杭州市测试路1号',
    business_hours: '09:00-18:00',
    phone: null,
    settings: {
      outreach_approval_policy: 'REVIEW_REQUIRED',
      publish_approval_policy: 'REVIEW_REQUIRED',
      daily_outreach_limit: 20,
      min_outreach_interval_minutes: 3,
      max_unanswered_touches: 2,
      follow_up_after_days: 2,
      daily_publish_limit: 2,
      max_ai_conversation_turns: 6,
      auto_send_min_score: 90,
      timezone: opts.timezone ?? 'Asia/Shanghai',
    },
    created_at: now,
    updated_at: now,
  });
}

/** Workflow with one step that records `<workflow>@<dealer_id>` each time it runs. */
function recording(name: string, calls: string[], behaviour: 'ok' | 'throw' = 'ok'): WorkflowDef {
  return {
    name,
    description: name,
    steps: [
      {
        key: 'work',
        agent: 'automotive-operator',
        skill: name,
        description: name,
        run: (sc) => {
          calls.push(`${name}@${String(sc.input.dealer_id)}`);
          if (behaviour === 'throw') throw new Error(`${name} exploded`);
          return { ok: true };
        },
      },
    ],
  };
}

function captureLogger() {
  const warns: { msg: string; data?: Record<string, unknown> }[] = [];
  const errors: { msg: string; data?: Record<string, unknown> }[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (msg, data) => warns.push({ msg, data }),
    error: (msg, data) => errors.push({ msg, data }),
  };
  return { logger, warns, errors };
}

const scheduleFor = (ctx: TestContext, dealerId: string, workflow: string) => {
  const row = ctx.db.table('schedules').findOne({ dealer_id: dealerId, workflow });
  assert.ok(row, `schedule ${workflow} missing`);
  return row;
};

describe('scheduler: configuration', () => {
  it('DEFAULT_DAILY_SCHEDULE is the documented daily operating rhythm', () => {
    assert.deepEqual(DEFAULT_DAILY_SCHEDULE, [
      { workflow: 'refresh_dealer_data', cron: '08:00' },
      { workflow: 'market_research', cron: '08:30' },
      { workflow: 'account_planning', cron: '09:00' },
      { workflow: 'lead_discovery', cron: '09:30' },
      { workflow: 'signal_processing', cron: 'every:60' },
      { workflow: 'reply_processing', cron: 'every:30' },
      { workflow: 'content_publishing', cron: 'every:60' },
      { workflow: 'performance_collection', cron: '18:00' },
      { workflow: 'evening_analysis', cron: '20:00' },
    ]);
  });

  it('parseCron accepts only HH:MM and every:N', () => {
    assert.deepEqual(parseCron('08:00'), { kind: 'daily', hour: 8, minute: 0 });
    assert.deepEqual(parseCron('23:59'), { kind: 'daily', hour: 23, minute: 59 });
    assert.deepEqual(parseCron('every:30'), { kind: 'every', minutes: 30 });
    for (const bad of ['8:00', '24:00', '08:60', 'every:0', 'every:-5', 'every:abc', 'every:', '', '0 8 * * *', ' 08:00']) {
      assert.equal(parseCron(bad), null, bad);
    }
  });

  it('ensureSchedules creates the default plan idempotently and preserves operator-disabled schedules', () => {
    const ctx = createTestContext();
    const dealer = seedDealer(ctx);
    const scheduler = new Scheduler(new WorkflowEngine());

    const first = scheduler.ensureSchedules(ctx, dealer.id);
    assert.deepEqual(first.map((s) => ({ workflow: s.workflow, cron: s.cron })), DEFAULT_DAILY_SCHEDULE);
    assert.ok(first.every((s) => s.enabled && s.last_run_at === null && s.last_run_id === null && s.dealer_id === dealer.id));

    const second = scheduler.ensureSchedules(ctx, dealer.id);
    assert.deepEqual(second.map((s) => s.id), first.map((s) => s.id));
    assert.equal(ctx.db.table('schedules').count(), 9);

    scheduler.setEnabled(ctx, first[0].id, false, 'operator:王经理');
    assert.equal(scheduler.ensureSchedules(ctx, dealer.id)[0].enabled, false, 'an operator decision is not silently undone');
    assert.equal(scheduler.ensureSchedules(ctx, dealer.id, undefined, { reenable: true })[0].enabled, true);

    const custom = scheduler.ensureSchedules(ctx, dealer.id, [
      { workflow: 'lead_discovery', cron: '14:00' },
      { workflow: 'lead_discovery', cron: '14:00' },
    ]);
    assert.equal(custom.length, 1);
    assert.equal(ctx.db.table('schedules').count(), 10);
    assert.equal(scheduler.listSchedules(ctx, { dealer_id: dealer.id }).length, 10);

    assert.throws(() => scheduler.ensureSchedules(ctx, dealer.id, [{ workflow: 'lead_discovery', cron: '8am' }]), ValidationError);
    assert.throws(() => scheduler.ensureSchedules(ctx, dealer.id, [{ workflow: ' ', cron: '08:00' }]), ValidationError);
    assert.throws(() => scheduler.ensureSchedules(ctx, 'dlr_missing'), NotFoundError);
    assert.equal(ctx.db.table('audit_events').count({ action: 'schedule.created' }), 10);
    assert.equal(ctx.db.table('audit_events').count({ action: 'schedule.enabled_changed' }), 2);
  });
});

describe('scheduler: due evaluation', () => {
  it('a daily HH:MM schedule becomes due exactly at that dealer-local time', () => {
    const ctx = createTestContext({ now: '2026-09-13T07:59:00+08:00' });
    const dealer = seedDealer(ctx);
    const scheduler = new Scheduler(new WorkflowEngine());
    const [schedule] = scheduler.ensureSchedules(ctx, dealer.id, [{ workflow: 'refresh_dealer_data', cron: '08:00' }]);

    assert.deepEqual(scheduler.due(ctx, ctx.clock.now()), []);
    ctx.clock.set('2026-09-13T08:00:00+08:00');
    assert.deepEqual(scheduler.due(ctx, ctx.clock.now()).map((s) => s.id), [schedule.id]);
  });

  it('tick runs a daily schedule once per local day and again the next day', async () => {
    const ctx = createTestContext({ now: '2026-09-13T08:00:00+08:00' });
    const dealer = seedDealer(ctx);
    const calls: string[] = [];
    const scheduler = new Scheduler(new WorkflowEngine([recording('refresh_dealer_data', calls)]));
    scheduler.ensureSchedules(ctx, dealer.id, [{ workflow: 'refresh_dealer_data', cron: '08:00' }]);

    const [run] = await scheduler.tick(ctx);
    assert.ok(run);
    assert.equal(run.status, 'SUCCEEDED');
    assert.equal(run.trigger, 'schedule');
    assert.equal(run.dealer_id, dealer.id);
    const schedule = scheduleFor(ctx, dealer.id, 'refresh_dealer_data');
    assert.equal(schedule.last_run_at, '2026-09-13T00:00:00.000Z');
    assert.equal(schedule.last_run_id, run.id);
    assert.deepEqual(run.input, {
      dealer_id: dealer.id,
      schedule_id: schedule.id,
      cron: '08:00',
      scheduled_at: '2026-09-13T00:00:00.000Z',
      timezone: 'Asia/Shanghai',
    });

    for (const at of ['2026-09-13T12:00:00+08:00', '2026-09-13T23:59:00+08:00', '2026-09-14T07:59:00+08:00']) {
      ctx.clock.set(at);
      assert.deepEqual(scheduler.due(ctx, ctx.clock.now()), [], at);
      assert.deepEqual(await scheduler.tick(ctx), [], at);
    }
    assert.equal(calls.length, 1);

    ctx.clock.set('2026-09-14T08:00:00+08:00');
    assert.equal(scheduler.due(ctx, ctx.clock.now()).length, 1);
    const [nextDay] = await scheduler.tick(ctx);
    assert.notEqual(nextDay.id, run.id);
    assert.deepEqual(calls, [`refresh_dealer_data@${dealer.id}`, `refresh_dealer_data@${dealer.id}`]);
    assert.equal(scheduleFor(ctx, dealer.id, 'refresh_dealer_data').last_run_id, nextDay.id);
  });

  it('a daily job missed for several days runs once, not once per missed day', async () => {
    const ctx = createTestContext({ now: '2026-09-10T08:05:00+08:00' });
    const dealer = seedDealer(ctx);
    const calls: string[] = [];
    const scheduler = new Scheduler(new WorkflowEngine([recording('market_research', calls)]));
    scheduler.ensureSchedules(ctx, dealer.id, [{ workflow: 'market_research', cron: '08:30' }]);
    ctx.clock.set('2026-09-10T08:30:00+08:00');
    assert.equal((await scheduler.tick(ctx)).length, 1);

    ctx.clock.set('2026-09-13T10:00:00+08:00'); // process was down for three days
    assert.equal(scheduler.due(ctx, ctx.clock.now()).length, 1);
    assert.equal((await scheduler.tick(ctx)).length, 1);
    assert.deepEqual(await scheduler.tick(ctx), []);
    assert.deepEqual(scheduler.due(ctx, ctx.clock.now()), []);
    assert.equal(calls.length, 2);
  });

  it('every:N schedules run on their minute cadence', async () => {
    const ctx = createTestContext();
    const dealer = seedDealer(ctx);
    const calls: string[] = [];
    const scheduler = new Scheduler(new WorkflowEngine([recording('signal_processing', calls)]));
    scheduler.ensureSchedules(ctx, dealer.id, [{ workflow: 'signal_processing', cron: 'every:60' }]);

    assert.equal(scheduler.due(ctx, ctx.clock.now()).length, 1, 'never-run interval schedules are due immediately');
    await scheduler.tick(ctx);
    assert.equal(calls.length, 1);
    assert.equal(scheduleFor(ctx, dealer.id, 'signal_processing').last_run_at, TEST_NOW);

    ctx.clock.advance({ minutes: 59 });
    assert.deepEqual(scheduler.due(ctx, ctx.clock.now()), []);
    ctx.clock.advance({ minutes: 1 });
    assert.equal(scheduler.due(ctx, ctx.clock.now()).length, 1);
    await scheduler.tick(ctx);
    ctx.clock.advance({ minutes: 30 });
    assert.deepEqual(await scheduler.tick(ctx), []);
    assert.equal(calls.length, 2);
  });

  it('orders due schedules by due time and runs them in that order', async () => {
    const ctx = createTestContext({ now: '2026-09-13T07:00:00+08:00' });
    const dealer = seedDealer(ctx);
    const calls: string[] = [];
    const scheduler = new Scheduler(new WorkflowEngine(DEFAULT_DAILY_SCHEDULE.map((e) => recording(e.workflow, calls))));
    scheduler.ensureSchedules(ctx, dealer.id);

    ctx.clock.set('2026-09-13T10:00:00+08:00');
    const expected = [
      'signal_processing',
      'reply_processing',
      'content_publishing',
      'refresh_dealer_data',
      'market_research',
      'account_planning',
      'lead_discovery',
    ];
    assert.deepEqual(scheduler.due(ctx, ctx.clock.now()).map((s) => s.workflow), expected);
    const runs = await scheduler.tick(ctx);
    assert.deepEqual(runs.map((r) => r.workflow), expected);
    assert.deepEqual(calls, expected.map((w) => `${w}@${dealer.id}`));
  });

  it('evaluates daily schedules in each dealer’s own timezone', async () => {
    const ctx = createTestContext({ now: '2026-09-13T08:00:00+09:00' }); // 08:00 Tokyo = 07:00 Shanghai
    const shanghai = seedDealer(ctx, { name: '上海宝马中心', timezone: 'Asia/Shanghai' });
    const tokyo = seedDealer(ctx, { name: '东京BMW', timezone: 'Asia/Tokyo' });
    const calls: string[] = [];
    const scheduler = new Scheduler(new WorkflowEngine([recording('refresh_dealer_data', calls)]));
    const plan = [{ workflow: 'refresh_dealer_data', cron: '08:00' }];
    scheduler.ensureSchedules(ctx, shanghai.id, plan);
    scheduler.ensureSchedules(ctx, tokyo.id, plan);

    assert.deepEqual(scheduler.due(ctx, ctx.clock.now()).map((s) => s.dealer_id), [tokyo.id]);
    const [tokyoRun] = await scheduler.tick(ctx);
    assert.equal(tokyoRun.dealer_id, tokyo.id);
    assert.equal(tokyoRun.input.timezone, 'Asia/Tokyo');
    assert.equal(tokyoRun.input.scheduled_at, '2026-09-12T23:00:00.000Z');

    ctx.clock.set('2026-09-13T08:00:00+08:00');
    assert.deepEqual(scheduler.due(ctx, ctx.clock.now()).map((s) => s.dealer_id), [shanghai.id]);
    await scheduler.tick(ctx);
    assert.deepEqual(calls, [`refresh_dealer_data@${tokyo.id}`, `refresh_dealer_data@${shanghai.id}`]);
  });

  it('follows wall-clock time across a DST change and reports the next run time', () => {
    const created = '2026-10-30T00:00:00.000Z';
    const tz = 'America/New_York'; // DST ends 2026-11-01 02:00 local
    const schedule = { cron: '08:00', last_run_at: null, created_at: created };

    const edt = evaluateSchedule(schedule, new Date('2026-10-31T12:00:00Z'), tz); // 08:00 EDT
    assert.equal(edt.due, true);
    assert.equal(edt.due_at?.toISOString(), '2026-10-31T12:00:00.000Z');

    const ran = { ...schedule, last_run_at: '2026-10-31T12:00:00.000Z' };
    const after = evaluateSchedule(ran, new Date('2026-10-31T15:00:00Z'), tz);
    assert.equal(after.due, false);
    assert.equal(after.next_run_at?.toISOString(), '2026-11-01T13:00:00.000Z', '08:00 EST is 13:00Z');
    assert.equal(evaluateSchedule(ran, new Date('2026-11-01T12:30:00Z'), tz).due, false);
    assert.equal(evaluateSchedule(ran, new Date('2026-11-01T13:00:00Z'), tz).due, true);

    const interval = evaluateSchedule({ cron: 'every:45', last_run_at: TEST_NOW, created_at: created }, new Date(TEST_NOW), tz);
    assert.equal(interval.due, false);
    assert.equal(interval.next_run_at?.toISOString(), '2026-09-12T02:45:00.000Z');
    assert.deepEqual(evaluateSchedule({ cron: 'nonsense', last_run_at: null, created_at: created }, new Date(TEST_NOW)), {
      valid: false,
      due: false,
      due_at: null,
      next_run_at: null,
    });
  });

  it('ignores disabled schedules and warns about invalid cron expressions or timezones', () => {
    const { logger, warns } = captureLogger();
    const ctx = createTestContext({ log: logger });
    const dealer = seedDealer(ctx);
    const badTz = seedDealer(ctx, { name: '时区错误店', timezone: 'Asia/Atlantis' });
    const scheduler = new Scheduler(new WorkflowEngine());
    const [disabled] = scheduler.ensureSchedules(ctx, dealer.id, [{ workflow: 'signal_processing', cron: 'every:30' }]);
    scheduler.setEnabled(ctx, disabled.id, false, 'operator:王经理');
    ctx.db.table('schedules').insert({
      id: newId('sch'),
      dealer_id: dealer.id,
      workflow: 'lead_discovery',
      cron: 'sometimes',
      enabled: true,
      last_run_at: null,
      last_run_id: null,
      created_at: ctx.clock.iso(),
    });
    const [fallback] = scheduler.ensureSchedules(ctx, badTz.id, [{ workflow: 'refresh_dealer_data', cron: '10:00' }]);

    const due = scheduler.due(ctx, ctx.clock.now()); // 10:00 Shanghai
    assert.deepEqual(due.map((s) => s.id), [fallback.id], 'invalid timezone falls back to Asia/Shanghai');
    assert.ok(warns.some((w) => w.msg === 'scheduler.invalid_cron' && w.data?.cron === 'sometimes'));
    assert.ok(warns.some((w) => w.msg === 'scheduler.invalid_timezone' && w.data?.timezone === 'Asia/Atlantis'));

    const before = warns.length;
    scheduler.due(ctx, ctx.clock.now());
    assert.equal(warns.length, before, 'repeated warnings are throttled');
  });
});

describe('scheduler: tick', () => {
  it('records last_run_at/last_run_id for failed runs and isolates a schedule that cannot start', async () => {
    const ctx = createTestContext({ now: '2026-09-13T07:00:00+08:00' });
    const dealer = seedDealer(ctx);
    const calls: string[] = [];
    const engine = new WorkflowEngine([
      recording('refresh_dealer_data', calls, 'throw'),
      {
        name: 'market_research',
        description: '',
        steps: () => {
          throw new Error('research sources not configured');
        },
      },
      recording('account_planning', calls),
    ]);
    const scheduler = new Scheduler(engine);
    scheduler.ensureSchedules(ctx, dealer.id, [
      { workflow: 'refresh_dealer_data', cron: '08:00' },
      { workflow: 'market_research', cron: '08:30' },
      { workflow: 'account_planning', cron: '09:00' },
    ]);
    ctx.clock.set('2026-09-13T09:00:00+08:00');
    const nowIso = ctx.clock.iso();

    const runs = await scheduler.tick(ctx);
    assert.deepEqual(runs.map((r) => [r.workflow, r.status]), [
      ['refresh_dealer_data', 'FAILED'],
      ['account_planning', 'SUCCEEDED'],
    ]);

    const refresh = scheduleFor(ctx, dealer.id, 'refresh_dealer_data');
    assert.equal(refresh.last_run_at, nowIso);
    assert.equal(refresh.last_run_id, runs[0].id);

    const research = scheduleFor(ctx, dealer.id, 'market_research');
    assert.equal(research.last_run_at, nowIso, 'the window is consumed so a broken definition does not hot-loop');
    assert.equal(research.last_run_id, null);
    const startFailed = ctx.audit.eventsFor('schedule', research.id).find((e) => e.action === 'schedule.start_failed');
    assert.match(String(startFailed?.details.error), /research sources not configured/);
    assert.equal(startFailed?.details.window_released, false);

    assert.equal(scheduleFor(ctx, dealer.id, 'account_planning').last_run_id, runs[1].id);
    assert.deepEqual(scheduler.due(ctx, ctx.clock.now()), []);
  });

  it('skips schedules whose workflow is not registered without consuming their window', async () => {
    const { logger, warns } = captureLogger();
    const ctx = createTestContext({ now: '2026-09-13T09:00:00+08:00', log: logger });
    const dealer = seedDealer(ctx);
    const calls: string[] = [];
    const engine = new WorkflowEngine([recording('refresh_dealer_data', calls)]);
    const scheduler = new Scheduler(engine);
    scheduler.ensureSchedules(ctx, dealer.id, [
      { workflow: 'refresh_dealer_data', cron: '08:00' },
      { workflow: 'market_research', cron: '08:30' },
    ]);

    const runs = await scheduler.tick(ctx);
    assert.deepEqual(runs.map((r) => r.workflow), ['refresh_dealer_data']);
    const research = scheduleFor(ctx, dealer.id, 'market_research');
    assert.equal(research.last_run_at, null);
    assert.equal(research.last_run_id, null);
    assert.ok(warns.some((w) => w.msg === 'scheduler.unregistered_workflow' && w.data?.workflow === 'market_research'));
    assert.deepEqual(scheduler.due(ctx, ctx.clock.now()).map((s) => s.workflow), ['market_research']);

    engine.register(recording('market_research', calls));
    const later = await scheduler.tick(ctx);
    assert.deepEqual(later.map((r) => r.workflow), ['market_research']);
  });

  it('does not start a schedule while a run of that workflow is RUNNING for the dealer', async () => {
    const ctx = createTestContext({ now: '2026-09-13T09:30:00+08:00' });
    const dealer = seedDealer(ctx);
    const other = seedDealer(ctx, { name: '上海宝马中心' });
    const calls: string[] = [];
    const scheduler = new Scheduler(new WorkflowEngine([recording('lead_discovery', calls)]));
    const plan = [{ workflow: 'lead_discovery', cron: '09:30' }];
    scheduler.ensureSchedules(ctx, dealer.id, plan);
    scheduler.ensureSchedules(ctx, other.id, plan);

    // e.g. an operator-triggered discovery run still in progress (possibly in another process)
    const running = ctx.db.table('workflow_runs').insert({
      id: newId('wf'),
      workflow: 'lead_discovery',
      dealer_id: dealer.id,
      goal_id: null,
      trigger: 'goal',
      status: 'RUNNING',
      input: {},
      output: {},
      error: null,
      resumed_from_run_id: null,
      started_at: ctx.clock.iso(),
      finished_at: null,
    });

    const runs = await scheduler.tick(ctx);
    assert.deepEqual(runs.map((r) => r.dealer_id), [other.id], 'other dealers are not blocked');
    assert.equal(scheduleFor(ctx, dealer.id, 'lead_discovery').last_run_at, null);
    assert.deepEqual(calls, [`lead_discovery@${other.id}`]);

    ctx.db.table('workflow_runs').update(running.id, { status: 'SUCCEEDED', finished_at: ctx.clock.iso() });
    const retried = await scheduler.tick(ctx);
    assert.deepEqual(retried.map((r) => r.dealer_id), [dealer.id]);
  });
});

describe('scheduler: start loop', () => {
  it('ticks on an interval without overlapping, survives tick errors, and stops', async () => {
    const { logger, errors } = captureLogger();
    const ctx = createTestContext({ log: logger });
    const scheduler = new Scheduler(new WorkflowEngine());
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    scheduler.tick = async () => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await sleep(25);
        if (calls === 1) throw new Error('database locked');
        return [];
      } finally {
        active--;
      }
    };

    const stop = scheduler.start(ctx, 5, { immediate: true });
    await sleep(120);
    stop();
    const callsAtStop = calls;
    await sleep(60);

    assert.equal(maxActive, 1, 'ticks never overlap');
    assert.ok(callsAtStop >= 2, `expected repeated ticks, got ${callsAtStop}`);
    assert.equal(calls, callsAtStop, 'no ticks after stop()');
    assert.ok(errors.some((e) => e.msg === 'scheduler.tick_failed' && /database locked/.test(String(e.data?.error))));
    assert.throws(() => scheduler.start(ctx, 0), ValidationError);
  });
});

describe('scheduler: hardening', () => {
  it('evaluateSchedule falls back to Asia/Shanghai for an invalid timezone instead of throwing', () => {
    const schedule = { cron: '08:00', last_run_at: null, created_at: TEST_NOW };
    const at = new Date('2026-09-13T00:00:00Z'); // 08:00 Shanghai
    const reference = evaluateSchedule(schedule, at, 'Asia/Shanghai');
    assert.equal(reference.due, true);
    assert.deepEqual(evaluateSchedule(schedule, at, 'Mars/Olympus_Mons'), reference);
    assert.deepEqual(evaluateSchedule(schedule, at, ''), reference);
    assert.equal(evaluateSchedule(schedule, new Date('2026-09-12T23:59:00Z'), 'Mars/Olympus_Mons').due, false);
  });

  it('a dealer without a timezone setting is scheduled in Asia/Shanghai', async () => {
    const ctx = createTestContext({ now: '2026-09-13T07:59:00+08:00' });
    const dealer = seedDealer(ctx, { timezone: '' });
    const calls: string[] = [];
    const scheduler = new Scheduler(new WorkflowEngine([recording('refresh_dealer_data', calls)]));
    scheduler.ensureSchedules(ctx, dealer.id, [{ workflow: 'refresh_dealer_data', cron: '08:00' }]);
    assert.deepEqual(await scheduler.tick(ctx), []);
    ctx.clock.set('2026-09-13T08:00:00+08:00');
    const [run] = await scheduler.tick(ctx);
    assert.equal(run.input.timezone, 'Asia/Shanghai');
    assert.equal(run.input.scheduled_at, '2026-09-13T00:00:00.000Z');
  });

  it('a failing log sink does not turn successful scheduled runs into start failures or stop other schedules', async () => {
    const boom = (): never => {
      throw new Error('log sink unavailable');
    };
    const ctx = createTestContext({ now: '2026-09-13T09:00:00+08:00', log: { debug: boom, info: boom, warn: boom, error: boom } });
    const dealer = seedDealer(ctx);
    const calls: string[] = [];
    const scheduler = new Scheduler(
      new WorkflowEngine([recording('refresh_dealer_data', calls), recording('account_planning', calls, 'throw')]),
    );
    scheduler.ensureSchedules(ctx, dealer.id, [
      { workflow: 'refresh_dealer_data', cron: '08:00' },
      { workflow: 'market_research', cron: '08:30' }, // not registered → warning path
      { workflow: 'account_planning', cron: '09:00' },
    ]);

    const runs = await scheduler.tick(ctx);
    assert.deepEqual(runs.map((r) => [r.workflow, r.status]), [
      ['refresh_dealer_data', 'SUCCEEDED'],
      ['account_planning', 'FAILED'],
    ]);
    assert.equal(ctx.db.table('audit_events').count({ action: 'schedule.start_failed' }), 0);
    assert.equal(scheduleFor(ctx, dealer.id, 'refresh_dealer_data').last_run_id, runs[0].id);
    assert.equal(scheduleFor(ctx, dealer.id, 'account_planning').last_run_id, runs[1].id);
    assert.equal(scheduleFor(ctx, dealer.id, 'market_research').last_run_at, null);
    assert.deepEqual(ctx.db.table('workflow_runs').count({ status: 'RUNNING' }), 0);

    const stop = scheduler.start(ctx, 60_000);
    stop();
  });

  it('releases the due window when a start fails for an infrastructure reason before any run exists', async () => {
    const ctx = createTestContext({ now: '2026-09-13T08:00:00+08:00' });
    const dealer = seedDealer(ctx);
    const calls: string[] = [];
    const engine = new WorkflowEngine([recording('refresh_dealer_data', calls)]);
    const scheduler = new Scheduler(engine);
    const [schedule] = scheduler.ensureSchedules(ctx, dealer.id, [{ workflow: 'refresh_dealer_data', cron: '08:00' }]);
    const realStart = engine.start.bind(engine);
    let failuresLeft = 1;
    engine.start = async (...args: Parameters<WorkflowEngine['start']>) => {
      if (failuresLeft-- > 0) throw new Error('database is locked');
      return realStart(...args);
    };

    assert.deepEqual(await scheduler.tick(ctx), []);
    const afterFailure = scheduleFor(ctx, dealer.id, 'refresh_dealer_data');
    assert.equal(afterFailure.last_run_at, null, 'the day’s job is not silently marked as done');
    assert.equal(afterFailure.last_run_id, null);
    const event = ctx.audit.eventsFor('schedule', schedule.id).find((e) => e.action === 'schedule.start_failed');
    assert.equal(event?.details.window_released, true);
    assert.match(String(event?.details.error), /database is locked/);
    assert.equal(calls.length, 0);
    assert.equal(scheduler.due(ctx, ctx.clock.now()).length, 1);

    ctx.clock.advance({ minutes: 1 });
    const [run] = await scheduler.tick(ctx);
    assert.equal(run.status, 'SUCCEEDED');
    assert.equal(calls.length, 1);
    assert.equal(scheduleFor(ctx, dealer.id, 'refresh_dealer_data').last_run_id, run.id);
  });

  it('two schedulers sharing a database never start the same due window twice (stale snapshots lose the claim)', async () => {
    const ctx = createTestContext({ now: '2026-09-13T10:00:00+08:00' });
    const dealer = seedDealer(ctx);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const engine = new WorkflowEngine([
      {
        name: 'refresh_dealer_data',
        description: '',
        steps: [
          {
            key: 'work',
            agent: 'automotive-operator',
            skill: 'dealer-brain',
            description: '',
            run: async (sc) => {
              calls.push(`refresh_dealer_data@${String(sc.input.dealer_id)}`);
              await gate;
              return { ok: true };
            },
          },
        ],
      },
      recording('market_research', calls),
    ]);
    const first = new Scheduler(engine);
    const second = new Scheduler(engine);
    first.ensureSchedules(ctx, dealer.id, [
      { workflow: 'refresh_dealer_data', cron: '08:00' },
      { workflow: 'market_research', cron: '08:30' },
    ]);

    // `first` snapshots both schedules as due, starts refresh and blocks inside it.
    const firstTick = first.tick(ctx);
    // `second` sees refresh already claimed and runs market_research to completion.
    const secondRuns = await second.tick(ctx);
    assert.deepEqual(secondRuns.map((r) => [r.workflow, r.status]), [['market_research', 'SUCCEEDED']]);
    // `first` now reaches market_research with a stale snapshot: its claim must fail.
    release();
    const firstRuns = await firstTick;
    assert.deepEqual(firstRuns.map((r) => [r.workflow, r.status]), [['refresh_dealer_data', 'SUCCEEDED']]);
    assert.deepEqual(calls, [`refresh_dealer_data@${dealer.id}`, `market_research@${dealer.id}`]);
    assert.equal(ctx.db.table('workflow_runs').count(), 2);
    assert.equal(scheduleFor(ctx, dealer.id, 'market_research').last_run_id, secondRuns[0].id);
  });
});
