import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentStatus, themeFromRequest } from '../../../src/server/pages/shell.ts';
import type { RequestContext } from '../../../src/server/http.ts';
import { createTestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';

const rcWithCookie = (cookie?: string) => ({ req: { headers: cookie === undefined ? {} : { cookie } } }) as unknown as RequestContext;

describe('shell: theme and Steer status', () => {
  it('the theme follows the operator’s explicit choice only', () => {
    assert.equal(themeFromRequest(rcWithCookie()), null);
    assert.equal(themeFromRequest(rcWithCookie('xhs_console_session=a; st_theme=dark')), 'dark');
    assert.equal(themeFromRequest(rcWithCookie('st_theme=light')), 'light');
    assert.equal(themeFromRequest(rcWithCookie('st_theme=purple')), null);
  });

  it('the status bar reports real workflow runs: running, else the last finished one, else idle', () => {
    const ctx = createTestContext();
    const dealerId = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const idle = agentStatus(ctx, dealerId);
    assert.equal(idle.running, false);
    assert.match(idle.html, /待命/);
    assert.equal(idle.since, null);

    const iso = ctx.clock.iso();
    ctx.db.run("INSERT INTO workflow_runs (id, workflow, dealer_id, trigger, status, started_at, finished_at) VALUES ('wf_done', 'lead_discovery', ?, 'manual', 'SUCCEEDED', ?, ?)", dealerId, iso, iso);
    const last = agentStatus(ctx, dealerId);
    assert.equal(last.running, false);
    assert.match(last.html, /最近完成了<b>公开内容发现线索<\/b>/);
    assert.equal(last.since, iso);

    ctx.db.run("INSERT INTO workflow_runs (id, workflow, dealer_id, trigger, status, started_at) VALUES ('wf_run', 'content_publishing', ?, 'schedule', 'RUNNING', ?)", dealerId, iso);
    const running = agentStatus(ctx, dealerId);
    assert.equal(running.running, true);
    assert.match(running.html, /Steer 正在<b>撰写审核发布内容<\/b>/);
  });
});
