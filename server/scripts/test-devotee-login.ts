// Devotee sign-in: only numbers on the list get a code; the code works once; a devotee can reach Add
// record and nothing else.
//
// Never sends a WhatsApp: the sender is replaced by one that just remembers the code.
//
//   NODE_ENV=development DATABASE_URL=...drm_test npx tsx scripts/test-devotee-login.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { runMigrations } from '../src/db/migrate';
import { confineRole } from '../src/middleware/auth';
import { setOtpSender } from '../src/services/whatsappOtp';
import devoteeAuthRoutes from '../src/routes/devoteeAuth';
import sevaWallRoutes from '../src/routes/sevaWall';
import peopleRoutes from '../src/routes/people';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

let failures = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}`, ok ? '' : JSON.stringify(d)?.slice(0, 300));
  if (!ok) failures++;
};

async function main() {
  await runMigrations();
  await pool.query(`TRUNCATE devotees, devotee_otps, seva_wall_items, users RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO devotees (name, code, phone) VALUES ('Test Dasa', 'TSTD', '9000000001'), ('Gone Dasa', 'GONE', '9000000002')`);
  await pool.query(`UPDATE devotees SET active = FALSE WHERE phone = '9000000002'`);

  const sent: { phone: string; code: string }[] = [];
  let failNext = false;
  setOtpSender(async (phone, code) => {
    if (failNext) throw new Error('boom');
    sent.push({ phone, code });
  });

  const app = express();
  app.use(express.json());
  app.use('/api', confineRole('devotee', ['/seva-wall/devotee-record', '/auth/me']));
  app.use('/api/devotee-auth', devoteeAuthRoutes);
  app.use('/api/seva-wall', sevaWallRoutes);
  app.use('/api/people', peopleRoutes);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const call = (method: string, path: string, body?: unknown, token?: string) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const data = body ? JSON.stringify(body) : '';
      const req = http.request(
        { port, path, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(token ? { authorization: `Bearer ${token}` } : {}) } },
        (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(d || '{}') })); }
      );
      req.on('error', reject);
      req.end(data);
    });

  console.log('\n--- who gets a code ---');
  let r = await call('POST', '/api/devotee-auth/otp', { phone: '9111111111' });
  check('a number not on the list is refused with a clear message', r.status === 404 && r.body.not_listed === true && /not on the devotee list/i.test(r.body.error), r);
  check('and nothing was sent', sent.length === 0);
  r = await call('POST', '/api/devotee-auth/otp', { phone: '9000000002' });
  check('a switched-off devotee is refused too', r.status === 404, r);
  r = await call('POST', '/api/devotee-auth/otp', { phone: '123' });
  check('a bad number is refused', r.status === 400, r);
  r = await call('POST', '/api/devotee-auth/otp', { phone: '90000 00001' });
  check('a listed number gets a code (spaces ignored)', r.status === 200 && sent.length === 1 && sent[0].phone === '9000000001', r);
  r = await call('POST', '/api/devotee-auth/otp', { phone: '9000000001' });
  check('asking again at once is held back', r.status === 429, r);

  console.log('\n--- signing in with the code ---');
  const code = sent[0].code;
  r = await call('POST', '/api/devotee-auth/verify', { phone: '9000000001', otp: code === '111111' ? '222222' : '111111' });
  check('a wrong code is refused', r.status === 400, r);
  r = await call('POST', '/api/devotee-auth/verify', { phone: '9000000001', otp: code });
  check('the right code signs in as a devotee', r.status === 200 && r.body.user?.role === 'devotee' && !!r.body.token, r);
  const token = r.body.token as string;
  r = await call('POST', '/api/devotee-auth/verify', { phone: '9000000001', otp: code });
  check('the same code cannot be used twice', r.status === 400, r);
  const again = await pool.query(`SELECT COUNT(*)::int n FROM users WHERE role = 'devotee'`);
  check('one account was made and linked', again.rows[0].n === 1 && (await pool.query(`SELECT user_id FROM devotees WHERE phone='9000000001'`)).rows[0].user_id !== null);

  console.log('\n--- five wrong codes cancel the code ---');
  await pool.query(`DELETE FROM devotee_otps`);
  sent.length = 0;
  await call('POST', '/api/devotee-auth/otp', { phone: '9000000001' });
  let last: any;
  for (let i = 0; i < 5; i++) last = await call('POST', '/api/devotee-auth/verify', { phone: '9000000001', otp: '000000' });
  r = await call('POST', '/api/devotee-auth/verify', { phone: '9000000001', otp: sent[0].code });
  check('even the right code no longer works', r.status === 400, { last, r });

  console.log('\n--- when WhatsApp fails ---');
  await pool.query(`DELETE FROM devotee_otps`);
  failNext = true;
  r = await call('POST', '/api/devotee-auth/otp', { phone: '9000000001' });
  failNext = false;
  check('the devotee is told, and may try again at once', r.status === 502, r);
  r = await call('POST', '/api/devotee-auth/otp', { phone: '9000000001' });
  check('no waiting after a failed send', r.status === 200, r);

  console.log('\n--- what a devotee can reach ---');
  r = await call('GET', '/api/people', undefined, token);
  check('not the donor records', r.status === 403, r);
  r = await call('GET', '/api/seva-wall', undefined, token);
  check('not the seva wall list', r.status === 403, r);
  r = await call('POST', '/api/seva-wall/devotee-record', { donor_name: 'Donor', phone: '9222222222', amount: 2000, kind: 'brick', receipt_number: '' }, token);
  check('a record needs the honoree name', r.status === 400 && /honoree/i.test(r.body.error), r);
  r = await call('POST', '/api/seva-wall/devotee-record', { donor_name: 'Donor', honoree_name: 'Sri Honoree', phone: '9222222222', amount: 2000, kind: 'brick', receipt_number: '' }, token);
  check('and the receipt number', r.status === 400 && /receipt/i.test(r.body.error), r);
  r = await call('POST', '/api/seva-wall/devotee-record', { donor_name: 'Donor', honoree_name: 'Sri Honoree', phone: '9222222222', amount: 2000, kind: 'brick', receipt_number: 'R-1001' }, token);
  check('a complete record is added', r.status === 201 && !!r.body.ref, r);
  const row = (await pool.query(`SELECT honoree_name, receipt_number, created_by FROM seva_wall_items WHERE receipt_number = 'R-1001'`)).rows[0];
  check('with the honoree, the receipt and who added it', row?.honoree_name === 'Sri Honoree' && !!row.created_by, row);
  r = await call('POST', '/api/seva-wall/devotee-record', { donor_name: 'Donor', honoree_name: 'Sri Honoree', phone: '9222222222', amount: 2000, kind: 'brick', receipt_number: 'R-1001' }, token);
  check('the same receipt again is refused', r.status === 409, r);
  r = await call('POST', '/api/seva-wall/devotee-record', { donor_name: 'Donor', honoree_name: 'X', phone: '9222222222', amount: 2000, kind: 'brick', receipt_number: 'R-1002' });
  check('no sign-in, no record', r.status === 401, r);

  setOtpSender(null);
  server.close();
  await pool.end();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await pool.end().catch(() => undefined); process.exit(1); });
