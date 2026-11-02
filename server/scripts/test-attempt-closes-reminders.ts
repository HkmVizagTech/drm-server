// A call on a lead closes the reminders on it that are already due - answered or not - so the bell
// stops counting a promise the caller has acted on. A reminder due later stays open, and so does one
// made on the same call.
//
//   NODE_ENV=development DATABASE_URL=...drm_test npx tsx scripts/test-attempt-closes-reminders.ts

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
const token = generateToken({ userId: ADMIN, role: 'admin' } as never);
const post = (path: string, body: unknown) =>
  new Promise<any>((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(`${base}${path}`);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(d || '{}') })); }
    );
    r.on('error', reject);
    r.end(data);
  });
let failures = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}`, ok ? '' : JSON.stringify(d)?.slice(0, 300));
  if (!ok) failures++;
};

async function main() {
  await runMigrations();
  await pool.query(`TRUNCATE leads, users RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO users (id, name, email, password_hash, role) VALUES ($1,'Admin','a@t','x','admin')`, [ADMIN]);
  // The evening retry depends on the clock; irrelevant here, so switch it off.
  await pool.query(`INSERT INTO crm_settings (key, value) VALUES ('evening_retry_cutoff_hour','0'::jsonb) ON CONFLICT (key) DO UPDATE SET value='0'::jsonb`);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const lead = async (phone: string) => (await pool.query(`INSERT INTO leads (phone, name) VALUES ($1,'T') RETURNING id`, [phone])).rows[0].id as string;
  const rem = async (leadId: string, hoursFromNow: number) =>
    (await pool.query(`INSERT INTO lead_reminders (lead_id, title, due_at, created_by) VALUES ($1,'Said they would donate', NOW() + ($2 || ' hours')::interval, $3) RETURNING id`, [leadId, String(hoursFromNow), ADMIN])).rows[0].id as string;
  const status = async (id: string) => (await pool.query(`SELECT status FROM lead_reminders WHERE id = $1`, [id])).rows[0].status as string;

  console.log('\n--- an unanswered call closes the reminder that is already due ---');
  const l1 = await lead('9830000001');
  const overdue = await rem(l1, -30);
  const later = await rem(l1, 48);
  let r = await post(`/api/crm/leads/${l1}/call`, { disposition: 'no_answer' });
  check('the call is saved', r.status === 201, r);
  check('the overdue reminder is closed', (await status(overdue)) === 'done');
  check('one due later stays open', (await status(later)) === 'open');

  console.log('\n--- a connected call does the same ---');
  const l2 = await lead('9830000002');
  const o2 = await rem(l2, -24);
  r = await post(`/api/crm/leads/${l2}/call`, { disposition: 'interested' });
  check('closed', (await status(o2)) === 'done', r);

  console.log('\n--- the reminder made on the same call is not closed by it ---');
  const l3 = await lead('9830000003');
  const o3 = await rem(l3, -2);
  r = await post(`/api/crm/leads/${l3}/call`, { disposition: 'will_donate', reminder: { title: 'Will give on the festival', due_at: new Date(Date.now() + 5 * 86400000).toISOString() } });
  const open3 = (await pool.query(`SELECT COUNT(*)::int n FROM lead_reminders WHERE lead_id = $1 AND status = 'open'`, [l3])).rows[0].n;
  check('the old one closed, the new one is open', (await status(o3)) === 'done' && open3 === 1, { status: r.status, open3 });

  console.log('\n--- an inbound call (they rang) is not the caller\'s attempt ---');
  const l4 = await lead('9830000004');
  const o4 = await rem(l4, -2);
  r = await post(`/api/crm/leads/${l4}/call`, { disposition: 'no_answer', direction: 'inbound' });
  check('the reminder stays open', (await status(o4)) === 'open', r);

  server.close();
  await pool.end();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await pool.end().catch(() => undefined); process.exit(1); });
