// Bringing the database up to what the code expects, at boot.
//
// WHY THIS EXISTS
// A deploy went out carrying code that needed new columns, nobody ran
// schema.sql against the live database, and every sign-in began failing with
// `column "last_login_at" does not exist`. The people who could have run the
// migration were locked out by the missing migration.
//
// The instruction "run schema.sql after deploying" was the whole safety
// mechanism, and an instruction is not a mechanism. So the process does it
// itself, before it serves a single request.
//
// WHY THIS IS SAFE HERE, WHEN AUTO-MIGRATING OFTEN IS NOT
// schema.sql is additive and idempotent by construction - every statement is
// CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT
// EXISTS, or an INSERT guarded by WHERE NOT EXISTS. It drops nothing and
// rewrites nothing. Running it against a current database is a long sequence
// of no-ops, which is exactly what it does on every boot today.
//
// It is NOT a substitute for real migrations if DRM ever needs a destructive
// change - renaming a column, backfilling then dropping one. That day this
// file should be replaced with a numbered migration runner. Until then, an
// idempotent schema applied on every boot is stronger than a README nobody
// reads at four in the afternoon.

import fs from 'fs';
import path from 'path';
import pool from './pool';

/** An arbitrary constant, shared by every instance of this app and nothing else. */
const LOCK_ID = 8_472_119_003;

export interface MigrationResult {
  ran: boolean;
  ok: boolean;
  ms: number;
  error?: string;
  /** How many statements the file holds, for the log line. */
  statements?: number;
}

/**
 * Where schema.sql ends up, compiled and uncompiled.
 *
 * tsc emits .js into dist/ and leaves .sql behind, so the built server has to
 * look back at the source tree. Both are checked rather than assumed, because
 * getting this wrong means a server that boots fine locally and cannot find
 * its schema in production.
 */
function findSchema(): string | null {
  const candidates = [
    path.join(__dirname, 'schema.sql'),
    path.join(__dirname, '..', '..', 'src', 'db', 'schema.sql'),
    path.join(process.cwd(), 'server', 'src', 'db', 'schema.sql'),
    path.join(process.cwd(), 'src', 'db', 'schema.sql'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/**
 * Apply schema.sql, once, with every other instance waiting.
 *
 * The advisory lock matters the moment there is more than one replica: two
 * processes running CREATE INDEX IF NOT EXISTS against the same table at the
 * same moment can deadlock, and a boot-time deadlock is a site that never
 * comes up. The lock is released when the connection is returned to the pool.
 */
export async function runMigrations(): Promise<MigrationResult> {
  const started = Date.now();

  if (process.env.DRM_SKIP_MIGRATIONS === 'true') {
    console.log('[schema] skipped (DRM_SKIP_MIGRATIONS=true)');
    return { ran: false, ok: true, ms: 0 };
  }

  const file = findSchema();
  if (!file) {
    console.error('[schema] schema.sql not found — the database will not be brought up to date.');
    return { ran: false, ok: false, ms: 0, error: 'schema.sql not found' };
  }

  const sql = fs.readFileSync(file, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    // THIS IS ALL-OR-NOTHING. The comment that used to sit here claimed the
    // opposite - that statements land one by one and everything before a
    // failure survives. That is wrong, and believing it is how you misread a
    // failed deploy.
    //
    // Passing a multi-statement string to client.query() sends it as a single
    // simple query, and libpq wraps a simple query containing more than one
    // statement in an implicit transaction. One failing statement anywhere in
    // schema.sql rolls back the ENTIRE file, including every statement that
    // appeared to succeed before it.
    //
    // So: a migration failure does not mean "the file got partway". It means
    // the database is exactly as it was before this boot, and every change in
    // the file is missing - not just the ones after the failure. Read /health,
    // fix the offending statement, redeploy.
    //
    // This is also why schema.sql must clean up before it constrains: anything
    // that could make an ALTER ... ADD CONSTRAINT fail has to be deleted or
    // repaired by an earlier statement in the same file, because there is no
    // "run the rest anyway" here. See the abandoned_external_id_present block.
    await client.query(sql);
    const ms = Date.now() - started;
    console.log(`[schema] up to date (${ms}ms)`);
    return { ran: true, ok: true, ms };
  } catch (e) {
    const ms = Date.now() - started;
    const error = (e as Error).message;
    // Loud, and in the shape somebody skimming Railway's deploy log will
    // notice. This is the message that has to be impossible to miss.
    console.error('='.repeat(70));
    console.error('[schema] MIGRATION FAILED — the database is NOT up to date.');
    console.error(`[schema] ${error}`);
    console.error('[schema] The app is still starting, but anything needing the new');
    console.error('[schema] columns will fail. Check /health for this message.');
    console.error('='.repeat(70));
    return { ran: true, ok: false, ms, error };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

/**
 * The last migration outcome, for /health.
 *
 * Kept in memory rather than in the database, because the case it describes is
 * the one where the database is not to be trusted.
 */
let lastResult: MigrationResult | null = null;
export const setMigrationResult = (r: MigrationResult) => {
  lastResult = r;
};
export const getMigrationResult = (): MigrationResult | null => lastResult;

/**
 * `npm run db:migrate`.
 *
 * This used to import the module and exit, printing nothing and applying
 * nothing - the worst possible failure for a command whose entire job is to
 * make a change, because it looks exactly like success. Anyone who ran it
 * before a deploy walked away believing the database was current.
 *
 * Exits non-zero on failure so a script or CI step can tell.
 */
if (require.main === module) {
  runMigrations()
    .then(async (r) => {
      await pool.end().catch(() => undefined);
      if (!r.ok) process.exit(1);
    })
    .catch(async (e) => {
      console.error('[schema] could not run:', (e as Error).message);
      await pool.end().catch(() => undefined);
      process.exit(1);
    });
}
