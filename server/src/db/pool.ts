import { Pool, types } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// ---------------------------------------------------------------- timezone
//
// EVERY DATE IN THIS SYSTEM IS AN INDIAN DATE.
//
// The temple's day runs midnight to midnight IST. Until this was set, the
// database's day ran midnight to midnight UTC, which is 05:30 IST to 05:30
// IST - so a donation at 2am, a call logged at 4am, and a reminder due at
// 5am all filed under the PREVIOUS day. "Today's collection" was wrong every
// single night, and nobody noticed because the browser rendered the same rows
// in IST while the server counted them in UTC. The two disagreed by 5h30m at
// every boundary.
//
// Setting the session timezone fixes it at the root: date_trunc('day', ...),
// CURRENT_DATE, ::date casts and bare-date comparisons all become IST without
// touching the ~50 queries that use them.
//
// WHY `options` RATHER THAN A `SET TIME ZONE` ON CHECKOUT
// pg's `connect` event is emitted synchronously and the client is handed to
// the waiting caller without waiting for anything the handler does - so a
// `SET TIME ZONE` issued there races the first real query. The startup
// parameter has no such window: Postgres applies it before the connection is
// usable at all.
const TIMEZONE = 'Asia/Kolkata';

// ------------------------------------------------------------ DATE columns
//
// THIS MUST STAY ALONGSIDE THE TIMEZONE SETTING ABOVE. Removing it silently
// moves every birthday back by a day.
//
// Four columns are a plain DATE, correctly: date_of_birth, anniversary_date,
// subscriptions.start_date, next_charge_date. A birthday has no time of day.
//
// But node-pg parses a DATE into a JS Date at *process-local* midnight, and
// Express then serializes it with toISOString(). While the process ran in UTC
// that round-tripped cleanly. The moment the process runs in IST,
// 1985-03-12 becomes 1985-03-11T18:30:00.000Z - and every date of birth,
// anniversary and next-charge-date in the app renders one day early.
//
// A DATE has no timezone, so the honest representation is the string Postgres
// sent. The client already does `.slice(0, 10)` on these to fill a date input,
// which becomes exactly right rather than accidentally right.
const DATE_OID = 1082;
types.setTypeParser(DATE_OID, (value: string) => value);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  options: `-c timezone=${TIMEZONE}`,
});

// A pooled client that's sitting idle can hit a background error (Railway's
// proxy dropping an idle connection, a brief network blip, etc.) - this is
// routine for hosted Postgres and NOT a reason to kill the whole server.
// `pg` automatically removes the broken client and opens a new one on the
// next query, so we just log it here instead of crashing the process.
pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client (pool will recover automatically):', err);
});

/**
 * Confirm at boot that the session really is on IST.
 *
 * The `options` startup parameter is standard Postgres, but it travels through
 * whatever sits between this process and the database, and a connection pooler
 * in transaction mode is entitled to ignore it. If that ever happens the
 * symptom is not an error - it is reports that are quietly five and a half
 * hours out, which is the hardest class of bug to notice and the easiest to
 * disbelieve. So it is checked rather than assumed, and said out loud.
 */
export async function verifyTimezone(): Promise<{ ok: boolean; actual: string }> {
  const { rows } = await pool.query<{ TimeZone: string }>('SHOW TimeZone');
  const actual = rows[0]?.TimeZone ?? '(unknown)';
  const ok = actual === TIMEZONE;
  if (!ok) {
    console.error('='.repeat(70));
    console.error(`[time] DATABASE SESSION IS ON "${actual}", NOT ${TIMEZONE}.`);
    console.error('[time] Every "today", "this month" and daily total will be wrong');
    console.error('[time] by the offset between that zone and IST. Reports will look');
    console.error('[time] plausible and be incorrect. Check whether a connection');
    console.error('[time] pooler is dropping the startup options parameter.');
    console.error('='.repeat(70));
  }
  return { ok, actual };
}

export const DB_TIMEZONE = TIMEZONE;
export default pool;
