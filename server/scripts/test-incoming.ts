// "When a donor rings my phone, the laptop should say who it is."
//
//   DATABASE_URL=postgresql://localhost/drm_test npx tsx scripts/test-incoming.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import phoneAppRoutes from '../src/routes/phoneApp';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use('/api/app', phoneAppRoutes);
let base = '';
const ANA = '22222222-2222-2222-2222-222222222222';
const BHAVIN = '33333333-3333-3333-3333-333333333333';
const KEY = 'k'.repeat(48);

function call(method: string, path: string, opts: { user?: string; key?: string; body?: unknown }): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? null : JSON.stringify(opts.body);
    const u = new URL(`${base}${path}`);
    const headers: Record<string, string | number> = {};
    if (opts.user) headers.authorization = `Bearer ${generateToken({ userId: opts.user, email: 'x@t', role: 'caller' } as never)}`;
    if (opts.key) headers['x-device-key'] = opts.key;
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(d || '{}') }));
    });
    r.on('error', reject);
    r.end(data ?? undefined);
  });
}
const ring = (phone: string, state: string, key = KEY) => call('POST', '/api/app/ringing', { key, body: { phone, state } });
const laptop = (user = ANA) => call('GET', '/api/app/incoming', { user });

let failures = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}`, ok ? '' : JSON.stringify(d)?.slice(0, 400));
  if (!ok) failures++;
};

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  await pool.query(`TRUNCATE incoming_rings, lead_reminders, app_devices, leads, users RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO users (id, name, email, password_hash, role) VALUES ($1,'Ana','a@t','x','caller'), ($2,'Bhavin','b@t','x','caller')`, [ANA, BHAVIN]);
  await pool.query(`INSERT INTO app_devices (install_id, user_id, key_hash, model) VALUES ('i1', $1, $2, 'Redmi 12')`, [ANA, crypto.createHash('sha256').update(KEY).digest('hex')]);
  const ramesh = (await pool.query(`INSERT INTO leads (phone, name, assigned_to) VALUES ('9876543210', 'Ramesh Kumar', $1) RETURNING id`, [ANA])).rows[0].id;
  await pool.query(
    `INSERT INTO lead_reminders (lead_id, title, due_at, status, expected_amount) VALUES ($1, 'Promise', NOW() + INTERVAL '1 hour', 'open', 2500)`,
    [ramesh]
  );
  const sita = (await pool.query(`INSERT INTO leads (phone, alt_phone, name, assigned_to, converted_amount) VALUES ('9000000001', '9111111111', 'Sita', $1, 1100) RETURNING id`, [ANA])).rows[0].id;

  console.log('\n1. Ramesh rings Ana\'s phone');
  const r1 = await ring('+91 98765 43210', 'ringing');
  check('the phone learns who it is, for its notification', r1.status === 200 && r1.name === 'Ramesh Kumar' && r1.lead_id === ramesh, r1);
  check('with the one thing worth knowing', r1.note === 'Promised ₹2,500 today', r1.note);
  await ring('9876543210', 'ringing'); // Android sends the ring twice
  let l = await laptop();
  check('the laptop shows it, once', l.rings.length === 1 && l.rings[0].state === 'ringing' && l.rings[0].name === 'Ramesh Kumar', l);
  check("Bhavin's laptop does not", (await laptop(BHAVIN)).rings.length === 0);

  console.log('\n2. Ana picks up, then hangs up');
  await ring('9876543210', 'answered');
  check('on the call', (await laptop()).rings[0].state === 'answered');
  await ring('9876543210', 'ended');
  l = await laptop();
  check('ended, and not a missed call', l.rings[0].state === 'ended' && l.rings[0].missed === false, l.rings[0]);

  console.log('\n3. Sita rings on her other number and gives up');
  const r2 = await ring('9111111111', 'ringing');
  check('found by the other number', r2.lead_id === sita && r2.note === 'Gave ₹1,100', r2);
  await ring('9111111111', 'ended');
  l = await laptop();
  const s = l.rings.find((x: any) => x.lead_id === sita);
  check('a missed call', s?.missed === true, s);
  check('newest first', l.rings[0].lead_id === sita);

  console.log('\n4. closing it on the laptop');
  await call('POST', `/api/app/incoming/${s.id}/dismiss`, { user: ANA });
  check('gone', !(await laptop()).rings.some((x: any) => x.id === s.id));
  await call('POST', `/api/app/incoming/${l.rings[1].id}/dismiss`, { user: BHAVIN });
  check("someone else cannot close Ana's", (await laptop()).rings.length === 1);

  console.log('\n5. old rings fall away');
  await pool.query(`UPDATE incoming_rings SET started_at = NOW() - INTERVAL '11 minutes'`);
  check('after ten minutes', (await laptop()).rings.length === 0);

  console.log('\n6. guards');
  check('a phone that is not linked is refused', (await ring('9876543210', 'ringing', 'x'.repeat(48))).status === 401);
  check('a short number is refused', (await ring('12345', 'ringing')).status === 400);
  const unknown = await ring('9222222222', 'ringing');
  check('a number with no lead rings with no name', unknown.status === 200 && unknown.known === false && unknown.name === null, unknown);

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
