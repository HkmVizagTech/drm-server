// "If they did not pick up, or were busy, they should come back the next
// morning" - not two days later at whatever minute the call was made.
//
//   DATABASE_URL=postgresql://localhost/drm_test npx tsx scripts/test-retry-morning.ts

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

/** The lead's follow-up as IST "YYYY-MM-DD HH:MI", and tomorrow's date in IST. */
async function when(id: string) {
  const r = await pool.query(
    `SELECT to_char(next_follow_up_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS at,
            to_char((NOW() AT TIME ZONE 'Asia/Kolkata')::date + 1, 'YYYY-MM-DD') AS tomorrow,
            to_char((NOW() AT TIME ZONE 'Asia/Kolkata')::date + 3, 'YYYY-MM-DD') AS in3
       FROM leads WHERE id = $1`,
    [id]
  );
  return r.rows[0] as { at: string | null; tomorrow: string; in3: string };
}

async function main() {
  // The one-time move of the old default (2 days) to 1 - only where nobody chose it.
  await pool.query(`TRUNCATE leads, users RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO users (id, name, email, password_hash, role) VALUES ($1,'Admin','a@t','x','admin')`, [ADMIN]);
  await pool.query(`UPDATE crm_settings SET value = '2'::jsonb, updated_by = NULL WHERE key = 'retry_after_days'`);
  await runMigrations();
  let v = (await pool.query(`SELECT value FROM crm_settings WHERE key = 'retry_after_days'`)).rows[0].value;
  check('the untouched default of 2 days becomes 1 (next morning)', Number(v) === 1, v);
  await pool.query(`UPDATE crm_settings SET value = '2'::jsonb, updated_by = $1 WHERE key = 'retry_after_days'`, [ADMIN]);
  await runMigrations();
  v = (await pool.query(`SELECT value FROM crm_settings WHERE key = 'retry_after_days'`)).rows[0].value;
  check('2 days chosen by an admin in Settings is left alone', Number(v) === 2, v);
  await pool.query(`UPDATE crm_settings SET value = '1'::jsonb, updated_by = NULL WHERE key = 'retry_after_days'`);

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;

  const add = async (phone: string) =>
    (await pool.query(`INSERT INTO leads (phone, name) VALUES ($1, 'Test') RETURNING id`, [phone])).rows[0].id as string;

  for (const [slug, phone] of [['no_answer', '9810000001'], ['busy', '9810000002'], ['switched_off', '9810000003']]) {
    const id = await add(phone);
    const r = await post(`/api/crm/leads/${id}/call`, { disposition: slug });
    const w = await when(id);
    check(`${slug}: back tomorrow at 10:00`, r.status === 201 && w.at === `${w.tomorrow} 10:00`, { status: r.status, err: r.error, w });
  }

  // Not answered again the next morning: moves on to the morning after.
  const again = await add('9810000004');
  await pool.query(`UPDATE leads SET next_follow_up_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [again]);
  await post(`/api/crm/leads/${again}/call`, { disposition: 'no_answer' });
  let w = await when(again);
  check('an overdue retry not answered again comes back tomorrow at 10:00', w.at === `${w.tomorrow} 10:00`, w);

  // A date the caller picked always wins.
  const picked = await add('9810000005');
  const at = new Date(Date.now() + 3 * 86400000);
  at.setUTCHours(6, 30, 0, 0); // 12:00 IST
  await post(`/api/crm/leads/${picked}/call`, { disposition: 'busy', next_follow_up_at: at.toISOString() });
  w = await when(picked);
  check('a follow-up date the caller picked wins', w.at === `${w.in3} 12:00`, w);

  // Settings at 3 days: three mornings on.
  await pool.query(`UPDATE crm_settings SET value = '3'::jsonb WHERE key = 'retry_after_days'`);
  const three = await add('9810000006');
  await post(`/api/crm/leads/${three}/call`, { disposition: 'no_answer' });
  w = await when(three);
  check('with Settings at 3 days: 10:00 three days on', w.at === `${w.in3} 10:00`, w);
  await pool.query(`UPDATE crm_settings SET value = '1'::jsonb WHERE key = 'retry_after_days'`);

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
