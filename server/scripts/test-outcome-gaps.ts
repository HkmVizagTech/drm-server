// When a lead comes back, per outcome:
//   Temporarily unavailable - tried morning AND evening, then back on Follow-ups in 30 days
//   Out of coverage         - tried morning AND evening, then back on Follow-ups in 2 days
//   Call back later         - back tomorrow (a day the caller picks still wins)
//
// The evening hour is set to the end of the day so the "morning call, evening try" path does not depend
// on the clock the test runs at.
//
//   NODE_ENV=development DATABASE_URL=...drm_test npx tsx scripts/test-outcome-gaps.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import { runMigrations } from '../src/db/migrate';
import crmRoutes from '../src/routes/crm';
import { FOLLOW_UP_LISTED } from '../src/routes/crmLists';

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
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}`, ok ? '' : JSON.stringify(d)?.slice(0, 400));
  if (!ok) failures++;
};
const istDay = async (n: number) =>
  (await pool.query(`SELECT to_char((NOW() AT TIME ZONE 'Asia/Kolkata')::date + $1::int, 'YYYY-MM-DD') AS d`, [n])).rows[0].d as string;
const when = async (id: string) =>
  (await pool.query(`SELECT to_char(next_follow_up_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS at FROM leads WHERE id = $1`, [id])).rows[0].at as string | null;
const held = async (id: string) =>
  (await pool.query(`SELECT retry_hold_until IS NOT NULL AND retry_hold_until > NOW() AS h FROM leads WHERE id = $1`, [id])).rows[0].h as boolean;
const listed = async (id: string) =>
  (await pool.query(`SELECT 1 FROM leads l WHERE l.id = $1 AND ${FOLLOW_UP_LISTED}`, [id])).rowCount === 1;
const setting = (k: string, v: unknown) =>
  pool.query(`INSERT INTO crm_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = $2::jsonb`, [k, JSON.stringify(v)]);
let n = 0;
const lead = async () => (await pool.query(`INSERT INTO leads (phone, name) VALUES ($1, 'Test') RETURNING id`, [`98300000${String(++n).padStart(2, '0')}`])).rows[0].id as string;
const ring = (id: string, disposition: string, extra: Record<string, unknown> = {}) => post(`/api/crm/leads/${id}/call`, { disposition, ...extra });

async function main() {
  await runMigrations();
  await pool.query(`TRUNCATE leads, users RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO users (id, name, email, password_hash, role) VALUES ($1,'Admin','a@t','x','admin')`, [ADMIN]);
  await setting('retry_after_days', 2);
  await setting('evening_retry_scope', 'nearly_gave'); // NOT "all": these outcomes get the evening try anyway
  await setting('evening_retry_hour', 24);
  await setting('evening_retry_cutoff_hour', 24);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const in1 = `${await istDay(1)} 10:00`, in2 = `${await istDay(2)} 10:00`, in30 = `${await istDay(30)} 10:00`;

  for (const [slug, back, label] of [['temporarily_unavailable', in30, '30 days'], ['out_of_coverage', in2, '2 days']] as const) {
    console.log(`\n--- ${slug}: morning, evening, then ${label} ---`);
    const id = await lead();
    let r = await ring(id, slug);
    check('morning call: accepted', r.status === 201, r);
    check('it comes back this evening, for an ordinary lead too (not only Nearly gave)', await held(id), await when(id));
    // It is now the evening hour (the test's evening is set to midnight, so move the clock on by hand).
    await pool.query(`UPDATE leads SET retry_hold_until = NOW() - INTERVAL '1 minute', next_follow_up_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [id]);
    check('in the evening it is on Follow-ups', await listed(id));
    r = await ring(id, slug);
    check(`evening call unanswered too: back in ${label}, at 10:00`, r.status === 201 && (await when(id)) === back && !(await held(id)), await when(id));
    check('the morning and evening count as ONE attempt', r.lead.call_attempts === 1, r.lead.call_attempts);
    await pool.query(`UPDATE leads SET next_follow_up_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [id]);
    check('on that day it is on Follow-ups', await listed(id));
  }

  console.log('\n--- only one call that day (no evening try left): the usual 2 days, not 30 ---');
  await setting('evening_retry_hour', 0); // the evening has passed
  const single = await lead();
  await ring(single, 'temporarily_unavailable');
  check('one Temporarily unavailable call: back in 2 days, so it still gets its morning and evening', (await when(single)) === in2, await when(single));
  await setting('evening_retry_hour', 24);

  console.log('\n--- Call back later ---');
  const cb = await lead();
  let r = await ring(cb, 'call_back');
  check('no day picked: back tomorrow at 10:00', r.status === 201 && (await when(cb)) === in1, await when(cb));
  check('and on Follow-ups that day', await (async () => { await pool.query(`UPDATE leads SET next_follow_up_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [cb]); return listed(cb); })());
  const picked = `${await istDay(5)}T11:30:00+05:30`;
  const cb2 = await lead();
  r = await ring(cb2, 'call_back', { next_follow_up_at: picked });
  check('a day the caller picks wins', (await when(cb2)) === `${await istDay(5)} 11:30`, await when(cb2));

  console.log('\n--- the others are unchanged ---');
  const na = await lead();
  await ring(na, 'no_answer');
  check('No answer: the usual 2 days', (await when(na)) === in2, await when(na));
  check('an ordinary No answer still gets no evening try (scope is Nearly gave)', !(await held(na)));

  server.close();
  await pool.end();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await pool.end().catch(() => undefined); process.exit(1); });
