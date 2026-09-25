import cron from 'node-cron';
import pool from '../db/pool';

// Daily check for birthdays and anniversaries (runs at 8 AM IST)
export function scheduleBirthdayAnniversaryCheck() {
  cron.schedule('0 2 * * *', async () => {
    console.log('[CRON] Checking birthdays and anniversaries...');
    const client = await pool.connect();

    try {
      // Check birthdays
      const birthdays = await client.query(`
        SELECT id, name, phone FROM people
        WHERE date_of_birth IS NOT NULL
          AND EXTRACT(MONTH FROM date_of_birth) = EXTRACT(MONTH FROM NOW())
          AND EXTRACT(DAY FROM date_of_birth) = EXTRACT(DAY FROM NOW())
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
          AND EXTRACT(MONTH FROM anniversary_date) = EXTRACT(MONTH FROM NOW())
          AND EXTRACT(DAY FROM anniversary_date) = EXTRACT(DAY FROM NOW())
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
  }, { timezone: 'Asia/Kolkata' });
}
