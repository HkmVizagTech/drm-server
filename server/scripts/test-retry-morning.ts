// "If they did not pick up, or were busy, they should come back" - counted in
// CALENDAR DAYS from the day of the call, at 10 in the morning, not at whatever
// minute the call was made and not a number of hours later.
//
// THE RULE
//   A call that did not connect (no answer, busy, switched off), or that did
//   and needs another (interested, will donate, call back later), comes back
//   `retry_after_days` days after the DAY of the call, at 10:00 IST. The
//   temple's setting is 2: a call on the 16th - morning or evening - is back on
//   the morning of the 18th.
//   A date the caller picks always wins. A callback already booked FURTHER OUT
//   is kept (an unanswered call on Tuesday must not pull Friday's forward);
//   one booked earlier is replaced.
//
// An earlier version of this file asserted "tomorrow at 10:00" and, for a while,
// "at least twelve hours later". Both were hours-and-minutes rules; the temple
// asked for days, and a rule in hours is what put a lead due at 4pm back on
// today's list after an unanswered call at 2pm.
//
//   NODE_ENV=development DATABASE_URL=...drm_test npx tsx scripts/test-retry-morning.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import { runMigrations } from '../src/db/migrate';
import crmRoutes from '../src/routes/crm';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use('/api/crm', crmRoutes);
let base = '';
const ADMIN = '11111111-1111-1111-1111-111111111111';
const token = generateToken({ userId: ADMIN, email: 'a@t', role: 'admin' } as never);

function post(path: string, body: unknown) {
  return new Promise<any>((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(`${base}${path}`);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(d || '{}') }));
      }
    );
    r.on('error', reject);
    r.end(data);
  });
}

let failures = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}`, ok ? '' : JSON.stringify(d)?.slice(0, 500));
  if (!ok) failures++;
};

/** IST calendar date `n` days from today, "YYYY-MM-DD". */
const istDay = async (n: number) =>
  (await pool.query(`SELECT to_char((NOW() AT TIME ZONE 'Asia/Kolkata')::date + $1::int, 'YYYY-MM-DD') AS d`, [n])).rows[0].d as string;

/** The lead's follow-up as IST "YYYY-MM-DD HH24:MI", or null. */
async function when(id: string): Promise<string | null> {
  const r = await pool.query(
    `SELECT to_char(next_follow_up_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS at FROM leads WHERE id = $1`,
    [id]
  );
  return r.rows[0].at;
}

async function main() {
  // These dates assume the plain retry rule. The same-day evening retry (an unanswered
  // morning call comes back that evening) depends on the clock, so it is switched off
  // here and has its own test: test-evening-retry.ts.
  await pool.query(`INSERT INTO crm_settings (key, value) VALUES ('evening_retry_cutoff_hour', '0'::jsonb)
                    ON CONFLICT (key) DO UPDATE SET value = '0'::jsonb`);
  await pool.query(`TRUNCATE leads, users RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO users (id, name, email, password_hash, role) VALUES ($1,'Admin','a@t','x','admin')`, [ADMIN]);

  console.log('\n--- the setting: two days, unless an admin chose otherwise ---');
  // The gap was 2, was moved to 1 for a while, and is moved to 2 again - but only
  // where nobody has saved a value in Settings (updated_by is set by every save).
  await pool.query(`UPDATE crm_settings SET value = '1'::jsonb, updated_by = NULL WHERE key = 'retry_after_days'`);
  await runMigrations();
  let v = (await pool.query(`SELECT value FROM crm_settings WHERE key = 'retry_after_days'`)).rows[0].value;
  check("an untouched 1 becomes the temple's 2", Number(v) === 2, v);
  await pool.query(`UPDATE crm_settings SET value = '1'::jsonb, updated_by = $1 WHERE key = 'retry_after_days'`, [ADMIN]);
  await runMigrations();
  v = (await pool.query(`SELECT value FROM crm_settings WHERE key = 'retry_after_days'`)).rows[0].value;
  check('a 1 an admin chose in Settings is left alone', Number(v) === 1, v);
  await runMigrations();
  v = (await pool.query(`SELECT value FROM crm_settings WHERE key = 'retry_after_days'`)).rows[0].value;
  check('and running the migration again changes nothing', Number(v) === 1, v);
  await pool.query(`UPDATE crm_settings SET value = '2'::jsonb, updated_by = NULL WHERE key = 'retry_after_days'`);

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;

  const add = async (phone: string) =>
    (await pool.query(`INSERT INTO leads (phone, name) VALUES ($1, 'Test') RETURNING id`, [phone])).rows[0].id as string;

  const in2 = `${await istDay(2)} 10:00`;
  const in3 = await istDay(3);

  console.log('\n--- an unanswered call comes back two days on, at 10:00 ---');
  for (const [slug, phone] of [['no_answer', '9810000001'], ['busy', '9810000002'], ['switched_off', '9810000003']]) {
    const id = await add(phone);
    const r = await post(`/api/crm/leads/${id}/call`, { disposition: slug });
    check(`${slug}: back in two days at 10:00`, r.status === 201 && (await when(id)) === in2, { status: r.status, err: r.error, at: await when(id) });
  }

  console.log('\n--- a call that connected and needs another comes back the same way ---');
  for (const [slug, phone] of [['call_back', '9810000021'], ['interested', '9810000022'], ['will_donate', '9810000023'], ['will_pay_qr', '9810000024']]) {
    const id = await add(phone);
    // The bare outcome, as an older screen would send it (the current one asks
    // for a day or a note on "will donate").
    const r = await post(`/api/crm/leads/${id}/call`, { disposition: slug });
    check(`${slug}: back in two days at 10:00`, r.status === 201 && (await when(id)) === in2, { status: r.status, at: await when(id) });
  }

  console.log('\n--- counted in DAYS: the hour of the call makes no difference ---');
  const evening = await add('9810000031');
  const lateTonight = `${await istDay(0)}T23:30:00+05:30`;
  await post(`/api/crm/leads/${evening}/call`, { disposition: 'no_answer', occurred_at: lateTonight });
  check('a call at 11:30pm comes back two days on, not at some hour of the next day', (await when(evening)) === in2, await when(evening));

  const earlyMorning = await add('9810000032');
  const justAfterMidnight = `${await istDay(0)}T00:10:00+05:30`;
  await post(`/api/crm/leads/${earlyMorning}/call`, { disposition: 'busy', occurred_at: justAfterMidnight });
  check('and a call at 12:10am the same morning comes back the same day', (await when(earlyMorning)) === in2, await when(earlyMorning));

  const late = await add('9810000033');
  const fiveDaysAgo = `${await istDay(-5)}T15:00:00+05:30`;
  await post(`/api/crm/leads/${late}/call`, { disposition: 'no_answer', occurred_at: fiveDaysAgo });
  check('a call recorded days late is not booked into the past: tomorrow morning',
    (await when(late)) === `${await istDay(1)} 10:00`, await when(late));

  console.log('\n--- a lead that was ALREADY booked ---');
  // The reported case: due later today, rung, not answered. It used to stay
  // exactly where it was - pending today, in front of the caller who had just tried.
  const dueToday = await add('9810000041');
  await pool.query(`UPDATE leads SET next_follow_up_at = NOW() + INTERVAL '2 hours' WHERE id = $1`, [dueToday]);
  await post(`/api/crm/leads/${dueToday}/call`, { disposition: 'no_answer' });
  check('due later today, not answered: no longer pending today, back in two days', (await when(dueToday)) === in2, await when(dueToday));

  const dueTomorrow = await add('9810000042');
  await pool.query(`UPDATE leads SET next_follow_up_at = NOW() + INTERVAL '1 day' WHERE id = $1`, [dueTomorrow]);
  await post(`/api/crm/leads/${dueTomorrow}/call`, { disposition: 'busy' });
  check('due tomorrow, busy: moved to the retry day', (await when(dueTomorrow)) === in2, await when(dueTomorrow));

  const overdue = await add('9810000043');
  await pool.query(`UPDATE leads SET next_follow_up_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [overdue]);
  await post(`/api/crm/leads/${overdue}/call`, { disposition: 'no_answer' });
  check('an overdue retry not answered again comes back in two days', (await when(overdue)) === in2, await when(overdue));

  const friday = await add('9810000044');
  await pool.query(`UPDATE leads SET next_follow_up_at = NOW() + INTERVAL '5 days' WHERE id = $1`, [friday]);
  const fridayBefore = await when(friday);
  await post(`/api/crm/leads/${friday}/call`, { disposition: 'busy' });
  check('a callback booked further out is not pulled forward', (await when(friday)) === fridayBefore, { before: fridayBefore, after: await when(friday) });

  console.log('\n--- a date the caller picks always wins ---');
  const picked = await add('9810000005');
  const at = new Date(Date.now() + 3 * 86400000);
  at.setUTCHours(6, 30, 0, 0); // 12:00 IST
  await post(`/api/crm/leads/${picked}/call`, { disposition: 'busy', next_follow_up_at: at.toISOString() });
  check('a follow-up date the caller picked wins', (await when(picked)) === `${in3} 12:00`, await when(picked));

  const laterToday = await add('9810000051');
  const twoHours = new Date(Date.now() + 2 * 3600_000);
  await post(`/api/crm/leads/${laterToday}/call`, { disposition: 'call_back', next_follow_up_at: twoHours.toISOString() });
  const stored = (await pool.query(`SELECT next_follow_up_at FROM leads WHERE id = $1`, [laterToday])).rows[0].next_follow_up_at;
  check('even a time later today, when that is what the caller chose', Math.abs(+stored - +twoHours) < 60_000);

  console.log('\n--- the gap is a setting ---');
  await pool.query(`UPDATE crm_settings SET value = '3'::jsonb WHERE key = 'retry_after_days'`);
  const three = await add('9810000006');
  await post(`/api/crm/leads/${three}/call`, { disposition: 'no_answer' });
  check('with Settings at 3 days: 10:00 three days on', (await when(three)) === `${in3} 10:00`, await when(three));
  await pool.query(`UPDATE crm_settings SET value = '2'::jsonb WHERE key = 'retry_after_days'`);

  server.close();
  await pool.end();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
