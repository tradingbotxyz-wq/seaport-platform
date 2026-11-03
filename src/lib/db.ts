// Thin data-access wrapper over Node's built-in SQLite (node:sqlite).
// The rest of the code only uses all/get/run/tx, so swapping to PostgreSQL / Aurora
// later means re-implementing this file (plus SQL dialect tweaks in schema.ts).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Row = Record<string, any>;
export type Param = string | number | bigint | null | Uint8Array;

export class Db {
  raw: DatabaseSync;
  depth = 0;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA foreign_keys = ON');
    if (path !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA busy_timeout = 5000');
  }

  all<T = Row>(sql: string, params: Param[] = []): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  get<T = Row>(sql: string, params: Param[] = []): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, params: Param[] = []): { changes: number; id: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Run fn atomically. Nested calls use savepoints, so services can compose. */
  tx<T>(fn: () => T): T {
    const outer = this.depth === 0;
    const sp = `sp_${this.depth}`;
    this.raw.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error('db.tx callback must be synchronous');
      this.depth--;
      this.raw.exec(outer ? 'COMMIT' : `RELEASE ${sp}`);
      return result;
    } catch (err) {
      this.depth--;
      this.raw.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    }
  }

  close(): void {
    this.raw.close();
  }
}
