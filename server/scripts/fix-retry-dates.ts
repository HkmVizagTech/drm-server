/**
 * Give the follow-ups the system booked BEFORE the two-day rule the date they
 * should have had.
 *
 * WHY
 * The rule is: a call nobody answers comes back two days after the DAY of the
 * call, at 10am. It only applies to calls made after it was deployed. Leads that
 * were called the day before kept the date the old rule gave them - or, worse,
 * the old rule left a follow-up that was due LATER THAT SAME DAY exactly where it
 * was - so on the 17th they show as Overdue, one day late, for a call made on the
 * 16th that should come back on the 18th.
 *
 * This moves each of those to (day of the last call) + retry_after_days, at 10:00.
 *
 * WHAT IT TOUCHES, AND WHAT IT DOES NOT
 *   - Only leads whose current date was BOOKED BY THE SYSTEM (follow_up_auto).
 *     A day a caller picked, or a promise, is never moved.
 *   - Only forward: a lead whose date is already at or past the new one is left.
 *   - Only calls recent enough that the new date is still today or later. A lead
 *     called last week and never rung again really is overdue, and re-dating it
 *     into a different past day would change nothing but the record.
 *   - Only next_follow_up_at. Not the status, the calls, the notes or the owner.
 *
 * It CHANGES EXISTING ROWS, so it does nothing until it is told to:
 *
 *   npx tsx scripts/fix-retry-dates.ts            # report only - READ ONLY
 *   npx tsx scripts/fix-retry-dates.ts --apply    # make the change
 *
 * The report lists every lead with the date it has and the date it would get; it
 * prints dates and ids, never a name or a number. Keep a copy of it before
 * applying - it is the record of the old dates.
 */
import pool from '../src/db/pool';

const IST = (col: string) => `to_char(${col} AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI')`;

/** Where this is pointed, without the password: host and database name only. */
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
  // Said first and plainly, because this script changes data when told to and the
  // only thing deciding WHICH database is an environment variable that a leftover
  // `export` in a terminal can silently override.
  console.log(`database: ${whereAmI()}   mode: ${apply ? 'APPLY - WILL CHANGE DATA' : 'report only'}`);
  const c = await pool.connect();
  try {
    await c.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
    await c.query(`SET LOCAL statement_timeout = '60s'`);

    const gapRow = await c.query(`SELECT value FROM crm_settings WHERE key = 'retry_after_days'`);
    const gap = Math.max(1, Math.min(90, Number(gapRow.rows[0]?.value ?? 2)));

    const TARGET = `
      SELECT l.id, l.next_follow_up_at AS current_due,
             date_trunc('day', l.last_contacted_at) + ($1::int || ' days')::interval + INTERVAL '10 hours' AS should_be
        FROM leads l
       WHERE l.follow_up_auto
         AND l.next_follow_up_at IS NOT NULL
         AND l.last_contacted_at IS NOT NULL`;
    const WANTED = `current_due < should_be AND should_be >= date_trunc('day', NOW())`;

    const rows = await c.query(
      `WITH target AS (${TARGET})
       SELECT id, ${IST('current_due')} AS due_now_ist, ${IST('should_be')} AS should_be_ist
         FROM target WHERE ${WANTED} ORDER BY should_be, id`,
      [gap]
    );
    console.log(`retry gap: ${gap} days`);
    console.log(`${rows.rows.length} lead(s) were booked before the rule and would move:\n`);
    console.table(rows.rows);

    if (!apply) {
      console.log('\nReport only - nothing was changed. Run again with --apply to move them.');
      await c.query('ROLLBACK');
      return;
    }

    const moved = await c.query(
      `WITH target AS (${TARGET})
       UPDATE leads l SET next_follow_up_at = t.should_be
         FROM target t WHERE l.id = t.id AND t.current_due < t.should_be AND t.should_be >= date_trunc('day', NOW())
       RETURNING l.id`,
      [gap]
    );
    // Changing the date clears the system flag (trg_leads_clear_follow_up_auto),
    // which is right for every other route and wrong here: these are still dates
    // the system booked. Set back on, for exactly the rows just moved.
    await c.query(`UPDATE leads SET follow_up_auto = TRUE WHERE id = ANY($1::uuid[])`, [moved.rows.map((r) => r.id)]);
    await c.query('COMMIT');
    console.log(`\nMoved ${moved.rowCount} lead(s).`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('FAILED:', (e as Error).message); process.exit(1); });
