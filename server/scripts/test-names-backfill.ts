/**
 * The backfill in schema.sql, run over rows that actually exist.
 *
 * WHY THIS IS SEPARATE FROM test-donor-names.ts
 * That suite seeds its data AFTER the migration, so the backfill it runs
 * against is an empty people table - a no-op that proves only that the SQL
 * parses. On production the same statements sweep every donor the temple has.
 * The cases that can only go wrong with rows in the table are here: a name and
 * its name_alt normalising to the same key, two people who share a name, and
 * the "exactly one primary" index meeting real data.
 *
 *   NODE_ENV=development DATABASE_URL=...drm_test npx tsx scripts/test-names-backfill.ts
 */
import '../src/bootTimezone';
import pool from '../src/db/pool';
import { runMigrations } from '../src/db/migrate';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${label}`);
  failures++;
  console.error(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`);
};

async function main() {
  // Donors as they exist TODAY - before person_names has ever been populated.
  await pool.query(`TRUNCATE person_names, donations, people RESTART IDENTITY CASCADE`);
  await pool.query(
    `INSERT INTO people (name, phone, name_alt, name_alt_source) VALUES
       ('Giridhar',       '9000000001', 'Lakshmi',   'hkmv'),
       ('Ravi Das',       '9000000002', NULL,        NULL),
       ('  RAVI   Das ',  '9000000003', 'Ravi Das',  'annadan'),
       ('Donor 9000000004','9000000004', NULL,       NULL),
       ('Venkata Rao',    '9000000005', 'Venkata Rao','hkmv')`
  );
  await pool.query(`DELETE FROM person_names`); // as if the column had just been added

  console.log('\n--- the backfill, over real rows ---');
  const r = await runMigrations();
  check('the migration succeeds with people already in the table', r.ok, true);

  const total = await pool.query(`SELECT COUNT(*)::int n FROM person_names`);
  /* Five primaries, plus Lakshmi, is six - NOT seven.

     The two name_alts that look like extra names are not extra names:
       '  RAVI   Das ' and its alt 'Ravi Das' both key to 'ravi das'
       'Venkata Rao'   and its alt 'Venkata Rao' are the same string
     Each collapses on UNIQUE (person_id, name_key), which is the whole point
     of storing the flattened key. An earlier version of this test expected
     seven and was simply counting wrong - worth saying, because a test that
     disagrees with correct code is the one people "fix" in the wrong place. */
  check('every donor got a name row, and no duplicates', total.rows[0].n, 6);

  const primaries = await pool.query(
    `SELECT COUNT(*)::int n FROM people p
      WHERE (SELECT COUNT(*) FROM person_names pn WHERE pn.person_id = p.id AND pn.is_primary) <> 1`
  );
  check('exactly one primary per donor, no more and no less', primaries.rows[0].n, 0);

  const same = await pool.query(
    `SELECT COUNT(*)::int n FROM person_names
      WHERE person_id = (SELECT id FROM people WHERE phone = '9000000005')`
  );
  check('a name identical to its name_alt is stored once', same.rows[0].n, 1);

  const spaced = await pool.query(
    `SELECT name_key FROM person_names
      WHERE person_id = (SELECT id FROM people WHERE phone = '9000000003') ORDER BY name_key`
  );
  check('odd spacing and case normalise to one key',
    spaced.rows.map((x) => x.name_key), ['ravi das']);

  console.log('\n--- running it a second time changes nothing ---');
  const before = await pool.query(`SELECT COUNT(*)::int n FROM person_names`);
  await runMigrations();
  const after = await pool.query(`SELECT COUNT(*)::int n FROM person_names`);
  check('the backfill is idempotent', after.rows[0].n, before.rows[0].n);

  console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
  await pool.end();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
