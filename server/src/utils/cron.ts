import cron from 'node-cron';
import pool from '../db/pool';
import { APP_TIMEZONE } from '../bootTimezone';

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
