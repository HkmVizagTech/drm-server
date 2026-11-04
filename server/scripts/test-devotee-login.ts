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
import { setBrickSender, type BrickMessage } from '../src/services/whatsappBrick';
import { generateToken } from '../src/middleware/auth';
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

  const U_CALLER = '22222222-2222-2222-2222-222222222222';
  const sent: { phone: string; code: string }[] = [];
  let failNext = false;
  setOtpSender(async (phone, code) => {
    if (failNext) throw new Error('boom');
    sent.push({ phone, code });
  });

  const app = express();
  app.use(express.json());
  app.use('/api', confineRole('devotee', ['/seva-wall/devotee-record', '/seva-wall/mine', '/auth/me']));
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

  console.log('\n--- a devotee sees only their own records, and their pictures ---');
  // A second devotee, with a record of their own.
  await pool.query(`INSERT INTO devotees (name, code, phone) VALUES ('Other Dasa', 'OTHD', '9000000003')`);
  await call('POST', '/api/devotee-auth/otp', { phone: '9000000003' });
  const otherCode = sent[sent.length - 1].code;
  const other = (await call('POST', '/api/devotee-auth/verify', { phone: '9000000003', otp: otherCode })).body.token as string;
  await call('POST', '/api/seva-wall/devotee-record', { donor_name: 'Other Donor', honoree_name: 'Other Honoree', phone: '9333333333', amount: 3000, kind: 'square', receipt_number: 'R-2001' }, other);
  r = await call('GET', '/api/seva-wall/mine', undefined, token);
  check('the first devotee sees only their own record', r.status === 200 && r.body.rows.length === 1 && r.body.rows[0].receipt_number === 'R-1001', r);
  check('with no picture yet', r.body.rows[0].has_image === false && r.body.rows[0].share_url === null, r.body.rows[0]);
  r = await call('GET', '/api/seva-wall/mine', undefined, other);
  check('the second sees only theirs', r.body.rows.length === 1 && r.body.rows[0].receipt_number === 'R-2001', r);

  // The printer adds the picture to the first devotee's brick: it goes to the caller for review.
  const item = (await pool.query(`SELECT id FROM seva_wall_items WHERE receipt_number = 'R-1001'`)).rows[0].id as string;
  await pool.query(`UPDATE seva_wall_items SET status = 'in_review', share_token = 'tok-test-1' WHERE id = $1`, [item]);
  await pool.query(`INSERT INTO seva_wall_pictures (item_id, mime, data, size_bytes, state) VALUES ($1, 'image/png', $2, 4, 'current')`, [item, Buffer.from([137, 80, 78, 71])]);
  const imgStatus = (who: string) =>
    new Promise<number>((resolve, reject) => {
      http.get({ port, path: `/api/seva-wall/mine/${item}/image`, headers: { authorization: `Bearer ${who}` } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); }).on('error', reject);
    });
  r = await call('GET', '/api/seva-wall/mine', undefined, token);
  check('printed but not yet approved: no picture for the devotee', r.body.rows[0].has_image === false && r.body.rows[0].status === 'in_review', r.body.rows[0]);
  check('and the picture itself is closed to them', (await imgStatus(token)) === 404);

  console.log('\n--- the caller approves it ---');
  const caller = generateToken({ userId: '22222222-2222-2222-2222-222222222222', role: 'caller' } as never);
  await pool.query(`INSERT INTO users (id, name, email, password_hash, role) VALUES ('22222222-2222-2222-2222-222222222222', 'Caller', 'c@t', 'x', 'caller') ON CONFLICT DO NOTHING`);
  const told: BrickMessage[] = [];
  setBrickSender(async (m) => { told.push(m); return { ok: true }; });
  r = await call('POST', `/api/seva-wall/${item}/approve`, {}, token);
  check('a devotee cannot approve', r.status === 403, r);
  r = await call('POST', `/api/seva-wall/${item}/approve`, {}, caller);
  check('the caller approves', r.status === 200 && r.body.status === 'sent' && r.body.whatsapp === 'sent', r);
  check('the devotee was sent the picture with the donor\'s name and number',
    told.length === 1 && told[0].devoteePhone === '9000000001' && told[0].donorName === 'Donor' && told[0].donorPhone === '9222222222' && told[0].honoree === 'Sri Honoree' && told[0].image.bytes.length === 4, told);
  check('and it is noted', (await pool.query(`SELECT devotee_notified_at FROM seva_wall_items WHERE id = $1`, [item])).rows[0].devotee_notified_at !== null);
  r = await call('POST', `/api/seva-wall/${item}/approve`, {}, caller);
  check('approving twice is refused', r.status === 409, r);

  r = await call('GET', '/api/seva-wall/mine', undefined, token);
  check('now the devotee sees the picture and the link to send', r.body.rows[0].has_image === true && /\/b\/tok-test-1$/.test((r.body.rows[0].share_url ?? '').trim()), { share: r.body.rows[0].share_url });
  check('the devotee can open their own picture', (await imgStatus(token)) === 200);
  check("but not another devotee's", (await imgStatus(other)) === 404);

  console.log('\n--- order, and when WhatsApp cannot be sent ---');
  await call('POST', '/api/seva-wall/devotee-record', { donor_name: 'D2', honoree_name: 'Second Honoree', phone: '9444444444', amount: 2500, kind: 'brick', receipt_number: 'R-1003' }, token);
  r = await call('GET', '/api/seva-wall/mine', undefined, token);
  check('bricks not printed yet come first', r.body.rows[0].receipt_number === 'R-1003' && r.body.rows[1].receipt_number === 'R-1001', r.body.rows.map((x: any) => x.receipt_number));
  const item2 = (await pool.query(`SELECT id FROM seva_wall_items WHERE receipt_number = 'R-1003'`)).rows[0].id as string;
  await pool.query(`UPDATE seva_wall_items SET status = 'in_review' WHERE id = $1`, [item2]);
  await pool.query(`INSERT INTO seva_wall_pictures (item_id, mime, data, size_bytes, state) VALUES ($1, 'image/png', $2, 4, 'current')`, [item2, Buffer.from([137, 80, 78, 71])]);
  setBrickSender(async () => ({ ok: false, reason: 'not_configured' }));
  r = await call('POST', `/api/seva-wall/${item2}/approve`, {}, caller);
  check('with no WhatsApp template set, the brick is still approved and the answer says so', r.status === 200 && r.body.status === 'sent' && r.body.whatsapp === 'not_configured', r);
  check('and nothing is marked as sent to the devotee', (await pool.query(`SELECT devotee_notified_at FROM seva_wall_items WHERE id = $1`, [item2])).rows[0].devotee_notified_at === null);

  // A brick that was not added by a devotee is not approved this way.
  const own = (await pool.query(`INSERT INTO seva_wall_items (donor_name, phone, amount, receipt_number, kind, status, created_by) VALUES ('Z','9555555555',2000,'R-3001','brick','in_review',$1) RETURNING id`, [U_CALLER])).rows[0].id as string;
  r = await call('POST', `/api/seva-wall/${own}/approve`, {}, caller);
  check('a brick not added by a devotee is refused', r.status === 409, r);

  console.log('\n--- the callers\' filter: bricks added by devotees ---');
  const devUserId = (await pool.query(`SELECT user_id FROM devotees WHERE phone = '9000000001'`)).rows[0].user_id as string;
  const otherUserId = (await pool.query(`SELECT user_id FROM devotees WHERE phone = '9000000003'`)).rows[0].user_id as string;
  r = await call('GET', '/api/seva-wall?view=contact', undefined, caller);
  check('the caller\'s table lists the devotees who have added bricks', Array.isArray(r.body.devotees) && r.body.devotees.some((d: any) => d.name === 'Test Dasa'), r.body.devotees);
  const all = r.body.rows.length;
  r = await call('GET', '/api/seva-wall?view=contact&devotee=any', undefined, caller);
  check('"added by devotees" shows only those bricks, each with the devotee\'s name', r.body.rows.length > 0 && r.body.rows.length < all && r.body.rows.every((x: any) => !!x.devotee_name), { n: r.body.rows.length, all });
  r = await call('GET', `/api/seva-wall?view=contact&devotee=${devUserId}`, undefined, caller);
  check('one devotee\'s bricks', r.body.rows.length > 0 && r.body.rows.every((x: any) => x.devotee_name === 'Test Dasa'), r.body.rows.map((x: any) => x.devotee_name));
  r = await call('GET', `/api/seva-wall?view=contact&devotee=${otherUserId}`, undefined, caller);
  check('another devotee, who has none in review or sent, shows none of the first one\'s', r.body.rows.every((x: any) => x.devotee_name !== 'Test Dasa'), r.body.rows.map((x: any) => x.devotee_name));

  // A brick still waiting for approval comes before the ones already approved (message sent).
  await call('POST', '/api/seva-wall/devotee-record', { donor_name: 'D4', honoree_name: 'Fourth Honoree', phone: '9666666666', amount: 2100, kind: 'brick', receipt_number: 'R-1004' }, token);
  const item4 = (await pool.query(`SELECT id FROM seva_wall_items WHERE receipt_number = 'R-1004'`)).rows[0].id as string;
  await pool.query(`UPDATE seva_wall_items SET status = 'in_review' WHERE id = $1`, [item4]);
  await pool.query(`INSERT INTO seva_wall_pictures (item_id, mime, data, size_bytes, state) VALUES ($1, 'image/png', $2, 4, 'current')`, [item4, Buffer.from([137, 80, 78, 71])]);
  r = await call('GET', '/api/seva-wall?view=contact&devotee=any', undefined, caller);
  const order = r.body.rows.map((x: any) => `${x.receipt_number}:${x.status}`);
  check('not approved first, approved last', r.body.rows[0].receipt_number === 'R-1004' && r.body.rows[r.body.rows.length - 1].status === 'sent' && r.body.rows.findIndex((x: any) => x.status === 'sent') > r.body.rows.findIndex((x: any) => x.status === 'in_review'), order);

  setBrickSender(null);
  setOtpSender(null);
  server.close();
  await pool.end();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await pool.end().catch(() => undefined); process.exit(1); });
