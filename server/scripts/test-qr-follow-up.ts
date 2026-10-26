// A lead that was sent a QR comes back, so somebody checks it was paid.
//
// THE GAP
// Sending a QR only recorded the share. The stage ("Callback booked") and the date
// come from the call outcome the caller logs, so a QR sent with no outcome - or an
// outcome with no date - left the lead with nothing to bring it back. On production
// 27 of 85 unpaid QR leads had no follow-up at all.
//
// THE RULE
// The QR goes out and the lead is back two days after that DAY, at 10am, listed on
// Follow-ups only from then (the system booked it). It never moves a date a person
// chose and never touches a closed, donated or do-not-call lead.
//
//   NODE_ENV=development DATABASE_URL=...drm_test npx tsx scripts/test-qr-follow-up.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import { runMigrations } from '../src/db/migrate';
import { bookQrFollowUp } from '../src/services/qrFollowUp';
import crmRoutes from '../src/routes/crm';
import crmQrRoutes from '../src/routes/crmQr';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use('/api/crm', crmRoutes);
app.use('/api/crm', crmQrRoutes);
let base = '';
const ADMIN = '11111111-1111-1111-1111-111111111111';
const token = generateToken({ userId: ADMIN, email: 'a@t', role: 'admin' } as never);

function call(method: string, path: string, body?: unknown) {
  return new Promise<any>((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const u = new URL(`${base}${path}`);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ ...JSON.parse(d || '{}'), http: res.statusCode }));
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

let seq = 0;
async function lead(extra: Record<string, unknown> = {}) {
  const phone = `98300${String(++seq).padStart(5, '0')}`;
  const cols = { phone, name: 'Test', ...extra };
  const keys = Object.keys(cols);
  const r = await pool.query(
    `INSERT INTO leads (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
    Object.values(cols)
  );
  return r.rows[0].id as string;
}
const istDay = async (n: number) =>
  (await pool.query(`SELECT to_char((NOW() AT TIME ZONE 'Asia/Kolkata')::date + $1::int, 'YYYY-MM-DD') AS d`, [n])).rows[0].d as string;
const dueIst = async (id: string) =>
  (await pool.query(`SELECT to_char(next_follow_up_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI') AS at FROM leads WHERE id = $1`, [id])).rows[0].at as string | null;
const flag = async (id: string) => (await pool.query(`SELECT follow_up_auto FROM leads WHERE id = $1`, [id])).rows[0].follow_up_auto as boolean;
const sendQr = (leadId: string, qrId: string) => call('POST', `/api/crm/leads/${leadId}/share-qr`, { qr_id: qrId });
const onFollowUps = async (id: string) => {
  for (const due of ['overdue', 'today_only', 'upcoming']) {
    const r = await call('GET', `/api/crm/leads?due=${due}&followups=true&limit=500`);
    if ((r.leads ?? []).some((l: any) => l.id === id)) return true;
  }
  return false;
};

async function main() {
  // These dates assume the plain retry rule. The same-day evening retry (an unanswered
  // morning call comes back that evening) depends on the clock, so it is switched off
  // here and has its own test: test-evening-retry.ts.
  await pool.query(`INSERT INTO crm_settings (key, value) VALUES ('evening_retry_cutoff_hour', '0'::jsonb)
                    ON CONFLICT (key) DO UPDATE SET value = '0'::jsonb`);
  await pool.query(`TRUNCATE leads, razorpay_qrs, users RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO users (id, name, email, password_hash, role) VALUES ($1,'Admin','a@t','x','admin')`, [ADMIN]);
  await pool.query(`UPDATE crm_settings SET value = '2'::jsonb, updated_by = NULL WHERE key = 'retry_after_days'`);
  check('the migration applies', (await runMigrations()).ok, true);
  const qr = (await pool.query(`INSERT INTO razorpay_qrs (qr_id, label, active) VALUES ('qr_t1','Temple',TRUE) RETURNING id`)).rows[0].id as string;

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  const in2 = `${await istDay(2)} 10:00`;

  console.log('\n--- a lead with no follow-up is booked when the QR goes out ---');
  const a = await lead();
  const sent = await sendQr(a, qr);
  check('the QR is sent as before', sent.http === 201 && !!sent.wa_url, { http: sent.http });
  check('the lead is booked two days on, at 10:00', (await dueIst(a)) === in2, await dueIst(a));
  check('as a date the system chose', (await flag(a)) === true);
  check('so it is NOT on Follow-ups before then', !(await onFollowUps(a)));
  await pool.query(`UPDATE leads SET next_follow_up_at = date_trunc('day', NOW()) + INTERVAL '10 hours' WHERE id = $1`, [a]);
  await pool.query(`UPDATE leads SET follow_up_auto = TRUE WHERE id = $1`, [a]);
  check('and is there on the day it comes round', await onFollowUps(a));

  console.log('\n--- a date a person chose is never moved ---');
  const chosen = await lead();
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
  await pool.query(`UPDATE leads SET next_follow_up_at = $2 WHERE id = $1`, [chosen, tomorrow]);
  const before = await dueIst(chosen);
  await sendQr(chosen, qr);
  check('a callback somebody asked for stays exactly where it was', (await dueIst(chosen)) === before, { before, after: await dueIst(chosen) });
  check('and is still theirs, not the system\'s', (await flag(chosen)) === false);

  console.log('\n--- a date the system booked earlier is pushed out ---');
  const retry = await lead();
  await pool.query(`UPDATE leads SET next_follow_up_at = NOW() + INTERVAL '1 day' WHERE id = $1`, [retry]);
  await pool.query(`UPDATE leads SET follow_up_auto = TRUE WHERE id = $1`, [retry]);
  await sendQr(retry, qr);
  check('a retry due tomorrow becomes two days after the QR', (await dueIst(retry)) === in2, await dueIst(retry));

  console.log('\n--- leads that must be left alone ---');
  const dnc = await lead({ do_not_call: true });
  await sendQr(dnc, qr);
  check('do not call: no follow-up booked', (await dueIst(dnc)) === null);
  const closed = await lead({ status: 'not_interested' });
  await sendQr(closed, qr);
  check('a closed stage: no follow-up booked', (await dueIst(closed)) === null);
  const donated = await lead({ converted_at: new Date().toISOString(), status: 'converted' });
  await sendQr(donated, qr);
  check('already donated: no follow-up booked', (await dueIst(donated)) === null);
  const stage = async (id: string) => (await pool.query(`SELECT status FROM leads WHERE id = $1`, [id])).rows[0].status;
  check('and sending a QR never changes a stage', (await stage(a)) === 'new' && (await stage(closed)) === 'not_interested');

  console.log('\n--- sending twice ---');
  const twice = await lead();
  await sendQr(twice, qr);
  const first = await dueIst(twice);
  await sendQr(twice, qr);
  check('a second QR the same day books the same date', (await dueIst(twice)) === first && first === in2, { first, second: await dueIst(twice) });

  console.log('\n--- sending to a number, which creates the lead ---');
  const viaNumber = await call('POST', '/api/crm/qr/share-to', { phone: '98300 99999', qr_id: qr, name: 'Walk In' });
  const created = (await pool.query(`SELECT id FROM leads WHERE phone = '9830099999'`)).rows[0]?.id;
  check('the lead is created and the QR sent', viaNumber.http === 201 && !!created, { http: viaNumber.http });
  check('and it comes back in two days too', !!created && (await dueIst(created)) === in2, created && (await dueIst(created)));

  console.log('\n--- a QR sent days ago is not booked into the past ---');
  const old = await lead();
  const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString();
  await bookQrFollowUp(pool, old, fiveDaysAgo);
  check('it is booked for tomorrow morning', (await dueIst(old)) === `${await istDay(1)} 10:00`, await dueIst(old));

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
