/**
 * Personal console accounts: a name and its own password (stored only as a salted scrypt hash).
 *
 * The shared CONSOLE_PASSWORD keeps working for names nobody registered, so existing stores lose nothing. Once a name
 * is registered it can only be signed in with its own password: whoever knows the shared password can no longer act
 * as that person in the audit log. Accounts are created, re-passworded and disabled from the CLI on the server
 * (`node src/cli.ts user …`), never from a web form.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { AppContext } from '../app/context.ts';
import type { ConsoleUser } from '../core/types.ts';
import { ValidationError } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { normalizeOperatorName } from './auth.ts';

export const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;
// OWASP's scrypt baseline; ~50 ms per check, which also makes guessing slow on top of the login rate limiter
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 } as const;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/** Constant-time check against a stored hash; a malformed hash never matches. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![N, r, p].every((x) => Number.isInteger(x) && x > 0) || N > 1 << 20) return false;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (salt.length < 8 || expected.length < 16) return false;
  const got = scryptSync(String(password ?? ''), salt, expected.length, { N, r, p, maxmem: SCRYPT.maxmem });
  return timingSafeEqual(got, expected);
}

const DUMMY_HASH = hashPassword(randomBytes(12).toString('hex'));

function checkPassword(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) throw new ValidationError('password', `密码至少 ${MIN_PASSWORD_LENGTH} 位`);
  if (password.length > MAX_PASSWORD_LENGTH) throw new ValidationError('password', `密码不能超过 ${MAX_PASSWORD_LENGTH} 位`);
}

function checkName(raw: string): string {
  const name = normalizeOperatorName(raw);
  if (!name) throw new ValidationError('name', '请填写姓名');
  return name;
}

export function findUser(ctx: AppContext, rawName: string): ConsoleUser | null {
  const name = normalizeOperatorName(rawName);
  return name ? (ctx.db.table('console_users').findOne({ name }) ?? null) : null;
}

export function listUsers(ctx: AppContext): ConsoleUser[] {
  return ctx.db.table('console_users').findMany({}, { orderBy: 'created_at ASC' });
}

export function createUser(ctx: AppContext, rawName: string, password: string, actor: string): ConsoleUser {
  const name = checkName(rawName);
  checkPassword(password);
  if (findUser(ctx, name)) throw new ValidationError('name', `「${name}」已经有账号了；要改密码用 user passwd`);
  const now = ctx.clock.iso();
  const user = ctx.db.table('console_users').insert({
    id: newId('usr'),
    name,
    password_hash: hashPassword(password),
    disabled_at: null,
    last_login_at: null,
    created_at: now,
    updated_at: now,
  });
  ctx.audit.event({ actor, action: 'console.user_created', entity_type: 'console_user', entity_id: user.id, details: { name } });
  return user;
}

export function setUserPassword(ctx: AppContext, rawName: string, password: string, actor: string): ConsoleUser {
  const user = findUser(ctx, rawName);
  if (!user) throw new ValidationError('name', `没有「${rawName}」这个账号`);
  checkPassword(password);
  const updated = ctx.db.table('console_users').update(user.id, { password_hash: hashPassword(password), updated_at: ctx.clock.iso() });
  ctx.audit.event({ actor, action: 'console.user_password_changed', entity_type: 'console_user', entity_id: user.id, details: { name: user.name } });
  return updated;
}

export function setUserDisabled(ctx: AppContext, rawName: string, disabled: boolean, actor: string): ConsoleUser {
  const user = findUser(ctx, rawName);
  if (!user) throw new ValidationError('name', `没有「${rawName}」这个账号`);
  const now = ctx.clock.iso();
  const updated = disabled
    ? ctx.db.table('console_users').update(user.id, { disabled_at: now, updated_at: now })
    : ctx.db.table('console_users').setNull(user.id, ['disabled_at']);
  ctx.audit.event({ actor, action: disabled ? 'console.user_disabled' : 'console.user_enabled', entity_type: 'console_user', entity_id: user.id, details: { name: user.name } });
  return updated;
}

export type LoginCheck =
  | { ok: true; name: string; personal: boolean }
  | { ok: false; reason: 'disabled' | 'bad_password' };

/**
 * Who may sign in as `name`. A registered name answers only to its own password (and never when disabled); any other
 * name falls back to the shared console password. With auth off (development) nothing is checked.
 */
export function checkLogin(ctx: AppContext, name: string, password: string, shared: { enabled: boolean; password: string | null }, equal: (a: string, b: string) => boolean): LoginCheck {
  const user = findUser(ctx, name);
  if (!shared.enabled) return { ok: true, name, personal: Boolean(user) };
  if (user) {
    if (user.disabled_at) return { ok: false, reason: 'disabled' };
    if (!verifyPassword(password, user.password_hash)) return { ok: false, reason: 'bad_password' };
    ctx.db.table('console_users').update(user.id, { last_login_at: ctx.clock.iso() });
    return { ok: true, name: user.name, personal: true };
  }
  // Spend the same scrypt time as a registered name, so response timing does not reveal which names have accounts.
  verifyPassword(password, DUMMY_HASH);
  return equal(password, shared.password ?? '') ? { ok: true, name, personal: false } : { ok: false, reason: 'bad_password' };
}
