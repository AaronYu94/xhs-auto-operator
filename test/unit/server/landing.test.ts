/**
 * The public site: detailed enough to decide on, honest about what it cannot do, and free of the machinery the
 * console hides. The demo form is real: a request is stored, a bad one is refused with a reason.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDemoRequest, listDemoRequests, markDemoRequestHandled } from '../../../src/server/demo-requests.ts';
import { landingPage } from '../../../src/server/pages/landing.ts';
import { siteImage } from '../../../src/server/site-images.ts';
import { createTestContext } from '../../helpers/context.ts';

const visible = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, ' ');
const DASHES = new RegExp('[\\u2013\\u2014]');
const NUL = String.fromCharCode(0);

describe('public site', () => {
  it('explains every part of the product and has one way in for customers', () => {
    const html = landingPage();
    for (const part of ['找客户', '私信与跟进', '内容运营', '车型库', '多账号与消息', '复盘', '它不会做的事', '常见问题', '预约演示']) {
      assert.ok(html.includes(part), `missing ${part}`);
    }
    assert.ok((html.match(/href="\/login"/g) ?? []).length >= 2, '客户登录 in the nav and next to the form');
    assert.ok(!/客户入口|已购用户|用户登录/.test(html), 'one label for the customer entrance: 客户登录');
  });

  it('keeps its promises honest: real screens, a dated case, nothing claims what the product cannot do', () => {
    const html = landingPage();
    assert.ok(!/示例|sample/i.test(html), 'no drawn mock-ups standing in for the product');
    assert.match(html, /数据时间：2026 年 9 月 19 日至 21 日/, 'the case figures say when they were read');
    assert.match(html, /已打码/, 'the screenshots say that customers are masked');
    const images = [...html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]!);
    assert.equal(images.length, 3);
    for (const src of images) {
      const name = src.replace(/^\/assets\/site\//, '').replace(/\?v=.*$/, '');
      assert.ok(siteImage(name)?.length, `${name} is served`);
    }
    assert.equal(siteImage('../site-css.ts'), null, 'only listed images are served');
    assert.match(html, /没有给门店开放读取私信的官方接口/, 'the DM-inbox limit is stated, not hidden');
    assert.match(html, /没有人能保证一定不被限流/);
    assert.ok(!DASHES.test(visible(html)), 'no em or en dashes');
    assert.ok(!/xiaohongshu-mcp|XHS_|REQUIRES_AUTH|UNAVAILABLE|<script/i.test(html), 'no internals and no script');
    assert.ok(!/(?:src|href)="https?:/.test(html), 'no external resources');
  });

  it('echoes the visitor input after an error and confirms a stored request', () => {
    const again = landingPage({ error: '请填写能打通的手机号或座机', values: { name: '<王>', company: '城北汽车' } });
    assert.match(again, /role="alert">请填写能打通的手机号或座机/);
    assert.match(again, /value="&lt;王&gt;"/, 'input is escaped when echoed');
    assert.match(landingPage({ sent: true }), /收到了/);
  });

  it('stores a request, rejects what a salesperson could not call back, and tracks who followed up', () => {
    const ctx = createTestContext();
    assert.throws(() => createDemoRequest(ctx, { name: '王经理', phone: '12345', company: '城北汽车' }), /手机号/);
    assert.throws(() => createDemoRequest(ctx, { name: '', phone: '13800001234', company: '城北汽车' }), /称呼/);
    assert.throws(() => createDemoRequest(ctx, { name: '王经理', phone: '13800001234', company: '' }), /门店/);
    const row = createDemoRequest(ctx, { name: ` 王${NUL}经理 `, phone: '+86 138-0000-1234', company: '城北汽车', message: '<b>想看</b>内容运营' });
    assert.equal(row.name, '王 经理');
    assert.equal(row.phone, '+8613800001234');
    assert.ok(!row.message?.includes('<'), 'markup is stripped before storage');
    assert.deepEqual(listDemoRequests(ctx).map((r) => r.id), [row.id]);
    const done = markDemoRequestHandled(ctx, row.id, 'operator:贺桢浩');
    assert.equal(done.handled_by, '贺桢浩');
    const audit = JSON.stringify(ctx.db.all('SELECT details FROM audit_events'));
    assert.ok(!audit.includes('13800001234'), 'contact details stay out of the audit log');
  });
});
