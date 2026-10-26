// The same-day evening retry: an unanswered call made in the morning comes back to the
// same caller that evening, held out of the queue until then; if that evening call is
// unanswered too, the lead goes on to the usual retry day (retry_after_days, 10:00).
//
// The clock decides morning from evening, so the hours are set per case through
// crm_settings (evening_retry_hour / evening_retry_cutoff_hour) instead of waiting for
// the right time of day: 24 means "midnight, always still ahead", 0 means "already past".
//
//   NODE_ENV=development DATABASE_URL=...drm_test npx tsx scripts/test-evening-retry.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import { runMigrations } from '../src/db/migrate';
import crmRoutes from '../src/routes/crm';
import { DUE_NOW } from '../src/routes/crmLists';

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

async function setHours(evening: number, cutoff: number) {
  for (const [k, v] of [['evening_retry_hour', evening], ['evening_retry_cutoff_hour', cutoff]] as const) {
    await pool.query(
      `INSERT INTO crm_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = $2::jsonb`,
      [k, JSON.stringify(v)]
    );
  }
}

async function setScope(scope: 'all' | 'nearly_gave') {
  await pool.query(
    `INSERT INTO crm_settings (key, value) VALUES ('evening_retry_scope', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = $1::jsonb`,
    [JSON.stringify(scope)]
  );
}

/** Would the calling queue hand this lead out right now? */
async function dueNow(id: string): Promise<boolean> {
  const r = await pool.query(`SELECT 1 FROM leads l WHERE l.id = $1 AND ${DUE_NOW}`, [id]);
  return r.rows.length > 0;
}

const hold = async (id: string) =>
  (await pool.query(`SELECT retry_hold_until IS NOT NULL AS held, follow_up_auto FROM leads WHERE id = $1`, [id])).rows[0];

async function main() {
  await pool.query(`TRUNCATE leads, users RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO users (id, name, email, password_hash, role) VALUES ($1,'Admin','a@t','x','admin')`, [ADMIN]);
  await runMigrations();
  await pool.query(`UPDATE crm_settings SET value = '2'::jsonb WHERE key = 'retry_after_days'`);

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  const add = async (phone: string) =>
    (await pool.query(`INSERT INTO leads (phone, name) VALUES ($1, 'Test') RETURNING id`, [phone])).rows[0].id as string;
  const in2 = `${await istDay(2)} 10:00`;

  console.log('\n--- an unanswered morning call comes back this evening ---');
  await setHours(24, 24);
  await setScope('all');
  const a = await add('9820000001');
  const r = await post(`/api/crm/leads/${a}/call`, { disposition: 'no_answer' });
  check('the call is saved', r.status === 201, r);
  check('booked for this evening, not two days on', (await when(a)) === `${await istDay(1)} 00:00`, await when(a));
  check('held out of the queue until then', (await dueNow(a)) === false);
  check('marked as a date the system chose', (await hold(a)).held === true && (await hold(a)).follow_up_auto === true, await hold(a));

  console.log('\n--- and is handed out once the evening arrives ---');
  await pool.query(`UPDATE leads SET next_follow_up_at = NOW() - INTERVAL '1 minute', retry_hold_until = NOW() - INTERVAL '1 minute' WHERE id = $1`, [a]);
  check('due in the queue after the hold passes', (await dueNow(a)) === true);

  console.log('\n--- unanswered again in the evening: the usual two days ---');
  await post(`/api/crm/leads/${a}/call`, { disposition: 'no_answer' });
  check('back in two days at 10:00', (await when(a)) === in2, await when(a));
  check('no hold left behind', (await hold(a)).held === false, await hold(a));

  console.log('\n--- a call after the cutoff gets the usual rule straight away ---');
  await setHours(24, 0);
  const b = await add('9820000002');
  await post(`/api/crm/leads/${b}/call`, { disposition: 'busy' });
  check('no evening retry: two days on', (await when(b)) === in2, await when(b));
  check('not held', (await hold(b)).held === false);

  console.log('\n--- when the evening hour has already passed ---');
  await setHours(0, 24);
  const c = await add('9820000003');
  await post(`/api/crm/leads/${c}/call`, { disposition: 'no_answer' });
  check('two days on', (await when(c)) === in2, await when(c));

  console.log('\n--- a connected call, or a day the caller picks, is untouched ---');
  await setHours(24, 24);
  const d = await add('9820000004');
  await post(`/api/crm/leads/${d}/call`, { disposition: 'interested' });
  check('a connected call that needs another: the usual two days', (await when(d)) === in2, await when(d));
  const e = await add('9820000005');
  const picked = new Date(Date.now() + 3 * 86400000);
  await post(`/api/crm/leads/${e}/call`, { disposition: 'no_answer', next_follow_up_at: picked.toISOString() });
  check('a date the caller picked wins and is not held', (await hold(e)).held === false);

  console.log('\n--- a promise booked further out is not pulled forward ---');
  const f = await add('9820000006');
  await pool.query(`UPDATE leads SET next_follow_up_at = NOW() + INTERVAL '5 days' WHERE id = $1`, [f]);
  const before = await when(f);
  await post(`/api/crm/leads/${f}/call`, { disposition: 'no_answer' });
  check('kept where it was', (await when(f)) === before, { before, after: await when(f) });

  console.log('\n--- by default only Nearly gave leads get it ---');
  await setScope('nearly_gave');
  const g = await add('9820000007');
  await post(`/api/crm/leads/${g}/call`, { disposition: 'no_answer' });
  check('an ordinary lead: two days on, not held', (await when(g)) === in2 && (await hold(g)).held === false, await when(g));
  const h = await add('9820000008');
  await pool.query(`UPDATE leads SET tags = ARRAY['abandoned'] WHERE id = $1`, [h]);
  await post(`/api/crm/leads/${h}/call`, { disposition: 'no_answer' });
  check('a Nearly gave lead: this evening, held', (await when(h)) === `${await istDay(1)} 00:00` && (await hold(h)).held === true, await when(h));

  await setHours(16, 13);
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
