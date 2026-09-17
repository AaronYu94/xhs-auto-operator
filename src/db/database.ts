import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Clock } from '../core/clock.ts';
import { SystemClock } from '../core/clock.ts';
import { NotFoundError } from '../core/errors.ts';
import type { EntityMap, TableName } from '../core/types.ts';
import { MIGRATIONS, TABLE_META } from './schema.ts';

export type SqlParam = SQLInputValue | boolean | undefined;
export type Where<T> = { [K in keyof T]?: T[K] | readonly T[K][] | null };

export interface FindOptions {
  /** e.g. 'score DESC, created_at ASC' — validated against real column names */
  orderBy?: string;
  limit?: number;
  offset?: number;
}

const toSql = (v: SqlParam): SQLInputValue => {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
};

/**
 * Typed table accessor. Rows are plain objects whose keys are the column names;
 * JSON columns are (de)serialized and boolean columns converted automatically.
 */
export class Table<T extends { id: string }> {
  readonly name: TableName;
  private readonly db: Db;
  private readonly jsonCols: Set<string>;
  private readonly boolCols: Set<string>;
  private columnsCache: Set<string> | null = null;

  constructor(db: Db, name: TableName) {
    this.db = db;
    this.name = name;
    this.jsonCols = new Set(TABLE_META[name].json);
    this.boolCols = new Set(TABLE_META[name].bool);
  }

  get columns(): Set<string> {
    if (!this.columnsCache) {
      const rows = this.db.raw.prepare(`PRAGMA table_info(${this.name})`).all() as { name: string }[];
      this.columnsCache = new Set(rows.map((r) => r.name));
    }
    return this.columnsCache;
  }

  private encode(col: string, value: unknown): SQLInputValue {
    if (!this.columns.has(col)) throw new Error(`${this.name}: unknown column "${col}"`);
    if (value === undefined || value === null) return null;
    if (this.jsonCols.has(col)) return JSON.stringify(value);
    if (this.boolCols.has(col)) return value ? 1 : 0;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') throw new Error(`${this.name}.${col}: object value for non-JSON column`);
    return value as SQLInputValue;
  }

  /** Decode a raw SQLite row (all columns of this table) into the entity shape. */
  decode(row: Record<string, unknown>): T {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(row)) {
      if (val !== null && this.jsonCols.has(k) && typeof val === 'string') out[k] = JSON.parse(val);
      else if (this.boolCols.has(k)) out[k] = val === 1 || val === true;
      else out[k] = val;
    }
    return out as T;
  }

  private buildWhere(where: Where<T> | undefined): { sql: string; params: SQLInputValue[] } {
    if (!where) return { sql: '', params: [] };
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    for (const [col, value] of Object.entries(where)) {
      if (value === undefined) continue;
      if (!this.columns.has(col)) throw new Error(`${this.name}: unknown column "${col}" in where`);
      if (value === null) clauses.push(`${col} IS NULL`);
      else if (Array.isArray(value)) {
        if (value.length === 0) clauses.push('0');
        else {
          clauses.push(`${col} IN (${value.map(() => '?').join(', ')})`);
          for (const x of value) params.push(this.encode(col, x));
        }
      } else {
        clauses.push(`${col} = ?`);
        params.push(this.encode(col, value));
      }
    }
    return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params };
  }

  private buildTail(opts: FindOptions | undefined): string {
    let sql = '';
    if (opts?.orderBy) {
      const parts = opts.orderBy.split(',').map((p) => p.trim());
      for (const part of parts) {
        const m = /^([a-z_][a-z0-9_]*)(\s+(asc|desc))?$/i.exec(part);
        if (!m || !this.columns.has(m[1])) throw new Error(`${this.name}: invalid orderBy "${part}"`);
      }
      sql += ` ORDER BY ${parts.join(', ')}`;
    }
    if (opts?.limit !== undefined) sql += ` LIMIT ${Math.max(0, Math.floor(opts.limit))}`;
    if (opts?.offset !== undefined) sql += ` OFFSET ${Math.max(0, Math.floor(opts.offset))}`;
    return sql;
  }

  insert(row: T): T {
    const cols = Object.keys(row).filter((k) => (row as Record<string, unknown>)[k] !== undefined);
    const sql = `INSERT INTO ${this.name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    this.db.raw.prepare(sql).run(...cols.map((c) => this.encode(c, (row as Record<string, unknown>)[c])));
    return this.require(row.id);
  }

  insertMany(rows: T[]): void {
    this.db.tx(() => {
      for (const r of rows) this.insert(r);
    });
  }

  /** Partial update. Auto-stamps `updated_at` when the table has that column and the patch omits it. */
  update(id: string, patch: Partial<T>): T {
    const entries = Object.entries(patch).filter(([k, val]) => k !== 'id' && val !== undefined);
    if (this.columns.has('updated_at') && !('updated_at' in patch)) entries.push(['updated_at', this.db.clock.iso()]);
    if (entries.length === 0) return this.require(id);
    const sql = `UPDATE ${this.name} SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`;
    const res = this.db.raw.prepare(sql).run(...entries.map(([k, val]) => this.encode(k, val)), id);
    if (Number(res.changes) === 0) throw new NotFoundError(this.name, id);
    return this.require(id);
  }

  /** Explicitly set nullable columns to NULL (update() ignores undefined). */
  setNull(id: string, cols: (keyof T & string)[]): T {
    if (cols.length === 0) return this.require(id);
    const sql = `UPDATE ${this.name} SET ${cols.map((c) => `${c} = NULL`).join(', ')} WHERE id = ?`;
    this.db.raw.prepare(sql).run(id);
    return this.require(id);
  }

  get(id: string): T | undefined {
    const row = this.db.raw.prepare(`SELECT * FROM ${this.name} WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.decode(row) : undefined;
  }

  require(id: string): T {
    const row = this.get(id);
    if (!row) throw new NotFoundError(this.name, id);
    return row;
  }

  findOne(where: Where<T>, opts?: FindOptions): T | undefined {
    return this.findMany(where, { ...opts, limit: 1 })[0];
  }

  findMany(where?: Where<T>, opts?: FindOptions): T[] {
    const w = this.buildWhere(where);
    const rows = this.db.raw.prepare(`SELECT * FROM ${this.name}${w.sql}${this.buildTail(opts)}`).all(...w.params);
    return rows.map((r) => this.decode(r as Record<string, unknown>));
  }

  count(where?: Where<T>): number {
    const w = this.buildWhere(where);
    const row = this.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${this.name}${w.sql}`).get(...w.params) as { n: number };
    return Number(row.n);
  }

  /** Custom predicate: `query('score >= ? AND stage IN (?, ?)', [60, 'QUALIFIED', 'ASSIGNED'], { orderBy: 'score DESC' })` */
  query(whereSql: string, params: SqlParam[] = [], opts?: FindOptions): T[] {
    const sql = `SELECT * FROM ${this.name}${whereSql ? ` WHERE ${whereSql}` : ''}${this.buildTail(opts)}`;
    const rows = this.db.raw.prepare(sql).all(...params.map(toSql));
    return rows.map((r) => this.decode(r as Record<string, unknown>));
  }

  queryOne(whereSql: string, params: SqlParam[] = [], opts?: FindOptions): T | undefined {
    return this.query(whereSql, params, { ...opts, limit: 1 })[0];
  }

  delete(id: string): boolean {
    const res = this.db.raw.prepare(`DELETE FROM ${this.name} WHERE id = ?`).run(id);
    return Number(res.changes) > 0;
  }
}

export interface DbOptions {
  clock?: Clock;
}

/**
 * SQLite persistence (node:sqlite, synchronous). Use `:memory:` for tests.
 * Transactions must wrap synchronous work only — never `await` inside `tx()`.
 */
export class Db {
  readonly raw: DatabaseSync;
  readonly path: string;
  readonly clock: Clock;
  private readonly tables = new Map<TableName, Table<{ id: string }>>();
  private txDepth = 0;

  constructor(path: string, opts: DbOptions = {}) {
    this.path = path;
    this.clock = opts.clock ?? new SystemClock();
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
    if (path !== ':memory:') {
      this.raw.exec('PRAGMA journal_mode = WAL;');
      this.raw.exec('PRAGMA synchronous = NORMAL;');
    }
  }

  static open(path: string, opts: DbOptions = {}): Db {
    const db = new Db(path, opts);
    db.migrate();
    return db;
  }

  migrate(): number[] {
    this.raw.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    const applied = new Set(
      (this.raw.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
    );
    const ran: number[] = [];
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      this.tx(() => {
        this.raw.exec(m.sql);
        this.raw
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(m.version, m.name, this.clock.iso());
      });
      ran.push(m.version);
    }
    return ran;
  }

  table<K extends TableName>(name: K): Table<EntityMap[K]> {
    let t = this.tables.get(name);
    if (!t) {
      t = new Table(this, name) as unknown as Table<{ id: string }>;
      this.tables.set(name, t);
    }
    return t as unknown as Table<EntityMap[K]>;
  }

  tx<R>(fn: () => R): R {
    const depth = this.txDepth;
    const sp = `sp_${depth}`;
    this.raw.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.txDepth++;
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error('Db.tx: async callbacks are not allowed inside a transaction');
      this.txDepth--;
      this.raw.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return result;
    } catch (err) {
      this.txDepth--;
      if (depth === 0) this.raw.exec('ROLLBACK');
      else this.raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    }
  }

  all<R = Record<string, unknown>>(sql: string, ...params: SqlParam[]): R[] {
    return this.raw.prepare(sql).all(...params.map(toSql)) as R[];
  }

  get<R = Record<string, unknown>>(sql: string, ...params: SqlParam[]): R | undefined {
    return this.raw.prepare(sql).get(...params.map(toSql)) as R | undefined;
  }

  run(sql: string, ...params: SqlParam[]): { changes: number } {
    const res = this.raw.prepare(sql).run(...params.map(toSql));
    return { changes: Number(res.changes) };
  }

  close(): void {
    if (this.raw.isOpen) this.raw.close();
  }
}
