/**
 * Hide the two made-up donors that automated tests raised real receipts for.
 *
 * WHAT HAPPENED
 * Two test runs reached the live main site and raised real receipts for fake
 * donors: "Lakshmi" (Rs 301, receipt 13619) and "Keep Me" (Rs 700, receipt 13989).
 * The site synced them back into DRM. They are not real donors and must not show
 * on the Donations page, the People page, or in any total.
 *
 * NOTHING IS DELETED. This only sets people.hidden_at. The donor, both donations
 * and their receipt numbers stay exactly where they are - those numbers are in
 * the 80G series and an auditor can ask about them - and every screen that lists
 * donors or adds up money reads through live_people / live_donations, which leave
 * a hidden donor out. The site's sync never writes hidden_at, so it cannot undo
 * this. (See HIDING A DONOR WITHOUT DELETING THEM in db/schema.sql.)
 *
 * WHICH ROWS
 * Matched on the made-up phone number AND the test payment reference together, so
 * a real donor can never be caught by either alone:
 *     9811100001 + pay_keep      9700000008 + pay_L5
 *
 *   npx tsx scripts/hide-test-donors.ts             # report only - READ ONLY
 *   npx tsx scripts/hide-test-donors.ts --apply     # hide them
 *   npx tsx scripts/hide-test-donors.ts --unhide    # put them back on the screens
 */
import pool from '../src/db/pool';

const TEST_DONORS = [
  { phone: '9811100001', ref: 'pay_keep' },
  { phone: '9700000008', ref: 'pay_L5' },
];
const REASON = 'Test receipt raised by an automated test run (Oct 2026); not a real donor';

function whereAmI(): string {
  try {
    const u = new URL(process.env.DATABASE_URL ?? '');
    return `${u.hostname}${u.port ? ':' + u.port : ''}/${u.pathname.replace(/^\//, '')}`;
  } catch {
    return '(DATABASE_URL is not set)';
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const unhide = process.argv.includes('--unhide');
  const writes = apply || unhide;
  console.log(`database: ${whereAmI()}   mode: ${unhide ? 'UNHIDE - WILL CHANGE DATA' : apply ? 'APPLY - WILL CHANGE DATA' : 'report only'}`);

  const c = await pool.connect();
  try {
    await c.query(writes ? 'BEGIN' : 'BEGIN READ ONLY');

    // Both conditions together, one pair at a time.
    const pairs = TEST_DONORS.map((_, i) => `(p.phone = $${i * 2 + 1} AND d.payment_ref = $${i * 2 + 2})`).join(' OR ');
    const params = TEST_DONORS.flatMap((t) => [t.phone, t.ref]);
    const found = await c.query(
      `SELECT p.id, p.name, p.phone, d.amount::int AS amount, d.receipt_number, d.source_site AS site,
              to_char(d.created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI') AS dated_ist,
              (p.hidden_at IS NOT NULL) AS hidden_now
         FROM people p JOIN donations d ON d.person_id = p.id
        WHERE ${pairs}
        ORDER BY d.created_at`,
      params
    );
    console.log(`\n${found.rows.length} test donor(s) found:\n`);
    console.table(found.rows.map(({ id: _id, ...rest }) => rest));

    // The two donors are the only thing this may ever touch. Anything else means
    // the match was wrong, and a script that edits records stops rather than guesses.
    if (found.rows.length > TEST_DONORS.length) {
      throw new Error(`Matched ${found.rows.length} rows, expected at most ${TEST_DONORS.length}. Nothing was changed.`);
    }

    if (!writes) {
      console.log('\nReport only - nothing was changed. Run again with --apply to hide them.');
      await c.query('ROLLBACK');
      return;
    }

    const ids = found.rows.map((r) => r.id);
    const done = unhide
      ? await c.query(`UPDATE people SET hidden_at = NULL, hidden_reason = NULL WHERE id = ANY($1::uuid[]) AND hidden_at IS NOT NULL`, [ids])
      : await c.query(`UPDATE people SET hidden_at = NOW(), hidden_reason = $2 WHERE id = ANY($1::uuid[]) AND hidden_at IS NULL`, [ids, REASON]);
    await c.query('COMMIT');
    console.log(`\n${unhide ? 'Un-hid' : 'Hid'} ${done.rowCount} donor(s). Nothing was deleted.`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('FAILED:', (e as Error).message); process.exit(1); });
