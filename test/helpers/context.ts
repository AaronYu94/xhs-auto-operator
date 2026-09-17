import { createAppContext, type AppContext, type CreateContextOptions } from '../../src/app/context.ts';
import { ManualClock } from '../../src/core/clock.ts';
import { Db } from '../../src/db/database.ts';

/** Default "now" for all tests: Saturday 2026-09-12 10:00 Asia/Shanghai (02:00Z). */
export const TEST_NOW = '2026-09-12T02:00:00.000Z';

export interface TestContext extends AppContext {
  clock: ManualClock;
}

/** Fresh in-memory database, migrated, with a ManualClock and (by default) unavailable providers. */
export function createTestContext(opts: Omit<CreateContextOptions, 'clock' | 'db' | 'dbPath'> & { now?: string } = {}): TestContext {
  const clock = new ManualClock(opts.now ?? TEST_NOW);
  const db = Db.open(':memory:', { clock });
  return createAppContext({ ...opts, db, clock }) as TestContext;
}
