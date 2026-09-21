/**
 * Personal console accounts. The point is the audit log: once a name is registered, only its own password signs in
 * as that name — the shared console password can no longer be used to act as that person.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { safeEqual } from '../../../src/server/auth.ts';
import { checkLogin, createUser, findUser, hashPassword, listUsers, setUserDisabled, setUserPassword, verifyPassword } from '../../../src/server/users.ts';
import { createTestContext } from '../../helpers/context.ts';

const SHARED = { enabled: true, password: 'store-shared-pass' };

describe('console users', () => {
  it('stores a salted hash, never the password, and verifies it in constant time', () => {
    const a = hashPassword('correct horse');
    const b = hashPassword('correct horse');
    assert.match(a, /^scrypt\$\d+\$8\$1\$[\w-]+\$[\w-]+$/);
    assert.notEqual(a, b, 'a fresh salt every time');
    assert.ok(!a.includes('correct horse'));
    assert.ok(verifyPassword('correct horse', a));
    assert.ok(!verifyPassword('correct hors', a));
    assert.ok(!verifyPassword('correct horse', 'not-a-hash'), 'a malformed hash never matches');
  });

  it('a registered name signs in only with its own password', () => {
    const ctx = createTestContext();
    createUser(ctx, '贺桢浩', 'own-password-1', 'operator:cli');

    const own = checkLogin(ctx, '贺桢浩', 'own-password-1', SHARED, safeEqual);
    assert.deepEqual(own, { ok: true, name: '贺桢浩', personal: true });
    assert.ok(findUser(ctx, '贺桢浩')?.last_login_at, 'the login is recorded');

    assert.deepEqual(checkLogin(ctx, '贺桢浩', SHARED.password, SHARED, safeEqual), { ok: false, reason: 'bad_password' }, 'the shared password cannot act as a registered person');
    assert.deepEqual(checkLogin(ctx, '贺桢浩', 'wrong', SHARED, safeEqual), { ok: false, reason: 'bad_password' });
  });

  it('names without an account keep using the shared password, so nothing breaks for existing stores', () => {
    const ctx = createTestContext();
    createUser(ctx, '贺桢浩', 'own-password-1', 'operator:cli');
    assert.deepEqual(checkLogin(ctx, '小王', SHARED.password, SHARED, safeEqual), { ok: true, name: '小王', personal: false });
    assert.deepEqual(checkLogin(ctx, '小王', 'own-password-1', SHARED, safeEqual), { ok: false, reason: 'bad_password' }, "someone else's personal password is not a key");
  });

  it('a disabled account cannot sign in, a new password replaces the old one, duplicates are refused', () => {
    const ctx = createTestContext();
    createUser(ctx, '贺桢浩', 'own-password-1', 'operator:cli');
    assert.throws(() => createUser(ctx, ' 贺桢浩 ', 'another-pass', 'operator:cli'), /已经有账号/);
    assert.throws(() => createUser(ctx, '短密码', '1234567', 'operator:cli'), /至少 8 位/);

    setUserPassword(ctx, '贺桢浩', 'own-password-2', 'operator:cli');
    assert.equal(checkLogin(ctx, '贺桢浩', 'own-password-1', SHARED, safeEqual).ok, false);
    assert.equal(checkLogin(ctx, '贺桢浩', 'own-password-2', SHARED, safeEqual).ok, true);

    setUserDisabled(ctx, '贺桢浩', true, 'operator:cli');
    assert.deepEqual(checkLogin(ctx, '贺桢浩', 'own-password-2', SHARED, safeEqual), { ok: false, reason: 'disabled' });
    setUserDisabled(ctx, '贺桢浩', false, 'operator:cli');
    assert.equal(checkLogin(ctx, '贺桢浩', 'own-password-2', SHARED, safeEqual).ok, true);

    assert.deepEqual(listUsers(ctx).map((u) => u.name), ['贺桢浩']);
    const actions = ctx.db.all<{ action: string }>("SELECT action FROM audit_events WHERE entity_type = 'console_user' ORDER BY rowid").map((r) => r.action);
    assert.deepEqual(actions, ['console.user_created', 'console.user_password_changed', 'console.user_disabled', 'console.user_enabled']);
    assert.ok(!JSON.stringify(ctx.db.all('SELECT details FROM audit_events')).includes('own-password'), 'no password in the audit log');
  });
});
