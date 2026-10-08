import cron from 'node-cron';
import pool from '../db/pool';
import { APP_TIMEZONE } from '../bootTimezone';
import { pollNearlyGave } from '../services/nearlyGaveWatch';
import { notify } from '../services/notifications';
import type { AbandonedDonation, SiteKey } from '../services/hkmvClient';

// WHAT WAS WRONG WITH THIS JOB, because it ran wrong for a long time and the
// output looked entirely normal.
//
// The comment said "runs at 8 AM IST". The expression said '0 2 * * *'. The
// `timezone: 'Asia/Kolkata'` option was added later without touching the hour,
// so it actually fired at 2 AM IST - which is 20:30 UTC *the previous day*.
//
// Then the query compared the birthday against EXTRACT(... FROM NOW()), and
// NOW() rendered in the session timezone, which was UTC. So at 2 AM IST on
// 1 October the job looked for people born on 30 September.
//
// Every birthday and anniversary greeting in this system went out a day early,
// every day, to everybody. Two independent mistakes that happened to compound.
//
// Both are fixed here: a sensible hour, and a date comparison that names the
// zone instead of inheriting one. CURRENT_DATE would now be correct too (the
// session runs on IST - see db/pool.ts), but this is the one job where being
// off by a day is visible to a donor, so it says what it means.
const GREETING_HOUR = '0 8 * * *'; // 08:00 IST, a civil hour to be messaged at

export function scheduleBirthdayAnniversaryCheck() {
  cron.schedule(GREETING_HOUR, async () => {
    console.log('[CRON] Checking birthdays and anniversaries...');
    const client = await pool.connect();

    try {
      const today = `(NOW() AT TIME ZONE '${APP_TIMEZONE}')::date`;

      // Check birthdays
      const birthdays = await client.query(`
        SELECT id, name, phone FROM people
        WHERE date_of_birth IS NOT NULL
          AND EXTRACT(MONTH FROM date_of_birth) = EXTRACT(MONTH FROM ${today})
          AND EXTRACT(DAY FROM date_of_birth) = EXTRACT(DAY FROM ${today})
      `);

      for (const person of birthdays.rows) {
        await client.query(
          `INSERT INTO triggers (person_id, trigger_type, payload)
           VALUES ($1, 'birthday', $2)
           ON CONFLICT DO NOTHING`,
          [person.id, JSON.stringify({ name: person.name, phone: person.phone })]
        );
      }

      // Check anniversaries
      const anniversaries = await client.query(`
        SELECT id, name, phone FROM people
        WHERE anniversary_date IS NOT NULL
          AND EXTRACT(MONTH FROM anniversary_date) = EXTRACT(MONTH FROM ${today})
          AND EXTRACT(DAY FROM anniversary_date) = EXTRACT(DAY FROM ${today})
      `);

      for (const person of anniversaries.rows) {
        await client.query(
          `INSERT INTO triggers (person_id, trigger_type, payload)
           VALUES ($1, 'anniversary', $2)
           ON CONFLICT DO NOTHING`,
          [person.id, JSON.stringify({ name: person.name, phone: person.phone })]
        );
      }

      console.log(`[CRON] Created ${birthdays.rows.length} birthday + ${anniversaries.rows.length} anniversary triggers`);
    } catch (err) {
      console.error('[CRON] Error:', err);
    } finally {
      client.release();
    }
  }, { timezone: APP_TIMEZONE });
}

/* ------------------------------------------------------- notifications */


/**
 * Nearly gave: ask the sites every minute and announce what has just failed,
 * or been left pending for 5 minutes. Sankalpam: the morning's list at 6:45 IST.
 */
export function scheduleNotifications(store: (site: SiteKey, d: AbandonedDonation) => Promise<boolean>) {
  const opts = { timezone: APP_TIMEZONE };
  cron.schedule('* * * * *', () => {
    void pollNearlyGave(store).catch((e) => console.error('[CRON] nearly gave poll:', (e as Error).message));
  }, opts);
  cron.schedule('45 6 * * *', () => {
    void sankalpMorning().catch((e) => console.error('[CRON] sankalpam morning:', (e as Error).message));
  }, opts);
  // Started after 6:45 (a deploy at noon): today's morning note still goes out.
  const hhmm = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: APP_TIMEZONE });
  if (hhmm >= '06:45') void sankalpMorning().catch(() => undefined);
}

/**
 * One notification a morning: today's videos, tomorrow's, any missed, and the
 * calls due to ask donors for their days. Raised once per day (ref_key), and
 * not at all on a day with nothing to do.
 */
export async function sankalpMorning(): Promise<boolean> {
  const { sankalpCounts } = await import('../routes/sankalpam');
  const c = await sankalpCounts();
  const parts = [
    c.today ? `${c.today} video${c.today === 1 ? '' : 's'} to send today` : null,
    c.missed ? `${c.missed} missed` : null,
    c.tomorrow ? `${c.tomorrow} tomorrow` : null,
  ].filter(Boolean);
  let raised = false;
  if (parts.length) {
    raised = await notify({
      kind: 'sankalpam',
      title: c.today ? `Sankalpam today: ${c.today} to send` : 'Sankalpam',
      body: parts.join(' · '),
      link: '/sankalpam',
      refKey: `sk:${c.date}`,
    });
  }
  if (c.calls_due || c.never_rung) {
    const calls = [
      c.calls_due ? `${c.calls_due} callback${c.calls_due === 1 ? '' : 's'} due` : null,
      c.never_rung ? `${c.never_rung} not rung yet` : null,
    ].filter(Boolean);
    raised =
      (await notify({
        kind: 'sankalpam',
        title: 'Sankalpam: donors to ring for their special days',
        body: calls.join(' · '),
        link: '/sankalpam?tab=need',
        refKey: `skc:${c.date}`,
      })) || raised;
  }
  return raised;
}
