// THIS MUST BE THE FIRST IMPORT IN ANY ENTRY POINT. Not the first statement -
// the first *import*. ES module and TypeScript imports are hoisted and run
// before any code in the importing file, so an assignment at the top of
// index.ts would execute after every route module had already been evaluated.
// Only a module imported ahead of them runs first.
//
// WHY A PROCESS TIMEZONE AT ALL, when db/pool.ts already pins the database
// session: because a surprising amount of date work never reaches Postgres.
// `new Date().setHours(0,0,0,0)` to find the start of today, the
// `toISOString().slice(0, 10)` stamped into an export filename, the
// missed/today/tomorrow buckets on the reminders board - all of these resolve
// against the *process* zone, which on Railway's default image is UTC.
//
// The result was a server that agreed with itself and disagreed with India by
// five and a half hours: a reminder due at 3am IST tomorrow was filed under
// today, and a CSV downloaded at 2am was stamped with yesterday's date.
//
// Node caches the resolved zone the first time it formats a date, so setting
// this late is worse than not setting it: half the process would be on one
// zone and half on another. Hence the position, and hence this comment.
process.env.TZ = process.env.TZ || 'Asia/Kolkata';

export const APP_TIMEZONE = 'Asia/Kolkata';

/**
 * The calendar date in India, as YYYY-MM-DD.
 *
 * `new Date().toISOString().slice(0, 10)` is the idiom this replaces, and it
 * is wrong here even with the process on IST: toISOString always renders UTC,
 * so between midnight and 05:30 IST it returns yesterday. Every report preset,
 * every export filename and every "today" bucket used it.
 *
 * en-CA is not an affectation - it is the locale whose short date format is
 * exactly YYYY-MM-DD, which is what Postgres wants and what sorts correctly.
 */
export function istDate(at: Date = new Date()): string {
  return at.toLocaleDateString('en-CA', { timeZone: APP_TIMEZONE });
}

/** Midnight in India, as an instant, for the given day offset from today. */
export function istMidnight(daysFromToday = 0): Date {
  const [y, m, d] = istDate().split('-').map(Number);
  // Built from the IST calendar date, then nudged by whole days. Constructing
  // it this way rather than with setHours(0,0,0,0) means it stays correct even
  // if the process zone is ever something other than IST.
  return new Date(`${isoDay(y, m, d + daysFromToday)}T00:00:00+05:30`);
}

function isoDay(y: number, m: number, d: number): string {
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.toISOString().slice(0, 10);
}

/** A bare YYYY-MM-DD, with no time attached. */
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse whatever the client sent into an instant, resolving bare dates in IST.
 *
 * THE TRAP THIS EXISTS TO CLOSE: `new Date('2026-10-15')` is specified to
 * parse a date-only string as UTC midnight - that is in the language standard,
 * and setting process.env.TZ does not change it. So a callback a caller picked
 * for "the 15th" was stored at 05:30 IST on the 15th, and anything that then
 * bucketed it by day could land it on the wrong side of a boundary.
 *
 * A date with a time in it is left alone; only the ambiguous bare form is
 * resolved, and it resolves to midnight in India, because that is what a
 * person in Visakhapatnam typing "15" into a date box means.
 */
export function parseDate(v: unknown): string | null {
  if (!v) return null;
  const raw = String(v).trim();
  const d = new Date(BARE_DATE.test(raw) ? `${raw}T00:00:00+05:30` : raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
