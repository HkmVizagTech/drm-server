// "Click Call on the laptop, the call goes out from my phone."
//
//   DATABASE_URL=postgresql://localhost/drm_test npx tsx scripts/test-dialer.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import dialerRoutes from '../src/routes/phoneDialer';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use('/api/app', dialerRoutes);
let base = '';
const ANA = '22222222-2222-2222-2222-222222222222';
const BHAVIN = '33333333-3333-3333-3333-333333333333';
const tok = (id: string) => generateToken({ userId: id, email: 'x@t', role: 'caller' } as never);

function call(method: string, path: string, as: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const u = new URL(`${base}${path}`);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
        headers: { authorization: `Bearer ${tok(as)}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(d || '{}') }));
      }
    );
    r.on('error', reject);
    r.end(data ?? undefined);
  });
}

let failures = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}`, ok ? '' : JSON.stringify(d)?.slice(0, 400));
  if (!ok) failures++;
};

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  await pool.query(`TRUNCATE dial_requests, app_devices, leads, users RESTART IDENTITY CASCADE`);
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role) VALUES
       ($1,'Ana','ana@t','x','caller'), ($2,'Bhavin','b@t','x','caller')`,
    [ANA, BHAVIN]
  );
  const dev = async (user: string, install: string, model: string) =>
    (await pool.query(
      `INSERT INTO app_devices (install_id, user_id, key_hash, manufacturer, model) VALUES ($1,$2,'h','Xiaomi',$3) RETURNING id`,
      [install, user, model]
    )).rows[0].id as string;
  const anaPhone = await dev(ANA, 'i-ana', 'Redmi 12');
  const bhavinPhone = await dev(BHAVIN, 'i-bhavin', 'Galaxy M14');
  const lead = (await pool.query(`INSERT INTO leads (phone, name) VALUES ('9876543210', 'Ramesh Kumar') RETURNING id`)).rows[0].id;

  console.log('\n1. before the phone is on the Laptop dialer screen');
  let st = await call('GET', '/api/app/dialer', ANA);
  check('has a phone, not ready', st.has_phone === true && st.ready === false, st);
  let d = await call('POST', '/api/app/dial', ANA, { phone: '9876543210', lead_id: lead });
  check('a click says the phone is not ready (so the laptop rings the usual way)', d.status === 409 && d.not_ready === true, d);

  console.log('\n2. the phone opens the Laptop dialer screen');
  const first = await call('GET', `/api/app/dial-next?device_id=${anaPhone}&wait=0`, ANA);
  check('nothing to dial yet', first.status === 200 && first.request === null, first);
  st = await call('GET', '/api/app/dialer', ANA);
  check('the laptop now sees "Phone ready" with its name', st.ready === true && st.phone === 'Xiaomi Redmi 12', st);

  console.log('\n3. click Call on the laptop while the phone is waiting');
  const t0 = Date.now();
  const waiting = call('GET', `/api/app/dial-next?device_id=${anaPhone}&wait=10`, ANA);
  await new Promise((r) => setTimeout(r, 300));
  d = await call('POST', '/api/app/dial', ANA, { phone: '+91 98765 43210', lead_id: lead });
  check('the click is accepted for the phone', d.status === 201 && !!d.id && d.phone === 'Xiaomi Redmi 12', d);
  const got = await waiting;
  const took = Date.now() - t0;
  check('the phone gets it at once, not at the end of the wait', took < 2500, { took });
  check('with the number and the name to show', got.request?.phone === '9876543210' && got.request?.name === 'Ramesh Kumar' && got.request?.lead_id === lead, got);
  let s1 = await call('GET', `/api/app/dial/${d.id}`, ANA);
  check('the laptop shows "ringing on your phone"', s1.state === 'ringing', s1);
  await call('POST', `/api/app/dial/${d.id}/result`, ANA, { placed: true });
  s1 = await call('GET', `/api/app/dial/${d.id}`, ANA);
  check('then "calling"', s1.state === 'placed', s1);

  console.log('\n4. a number without a lead still shows a name when DRM knows it');
  const noLead = call('GET', `/api/app/dial-next?device_id=${anaPhone}&wait=5`, ANA);
  await new Promise((r) => setTimeout(r, 200));
  await call('POST', '/api/app/dial', ANA, { phone: '09876543210' });
  const g2 = await noLead;
  check('found by number', g2.request?.name === 'Ramesh Kumar', g2);

  console.log('\n5. only ever your own phone');
  const stolen = await call('GET', `/api/app/dial-next?device_id=${bhavinPhone}&wait=0`, ANA);
  check("Ana cannot listen on Bhavin's phone", stolen.status === 403, stolen);
  const bWait = call('GET', `/api/app/dial-next?device_id=${bhavinPhone}&wait=2`, BHAVIN);
  await new Promise((r) => setTimeout(r, 200));
  await call('POST', '/api/app/dial', ANA, { phone: '9000000001' });
  const bGot = await bWait;
  check("Bhavin's phone never gets Ana's click", bGot.request === null, bGot);
  const aGot = await call('GET', `/api/app/dial-next?device_id=${anaPhone}&wait=0`, ANA);
  check("Ana's phone does", aGot.request?.phone === '9000000001', aGot);

  console.log('\n6. two quick clicks: the newer one wins');
  const c1 = await call('POST', '/api/app/dial', ANA, { phone: '9000000002' });
  const c2 = await call('POST', '/api/app/dial', ANA, { phone: '9000000003' });
  const g3 = await call('GET', `/api/app/dial-next?device_id=${anaPhone}&wait=0`, ANA);
  check('the phone dials the second', g3.request?.phone === '9000000003', g3);
  const old = await call('GET', `/api/app/dial/${c1.id}`, ANA);
  check('the first says it was replaced', old.state === 'replaced', old);
  check('the second is ringing', (await call('GET', `/api/app/dial/${c2.id}`, ANA)).state === 'ringing');

  console.log('\n7. a click nobody picked up is given up, not dialled late');
  const late = await call('POST', '/api/app/dial', ANA, { phone: '9000000004' });
  await pool.query(`UPDATE dial_requests SET created_at = NOW() - INTERVAL '30 seconds' WHERE id = $1`, [late.id]);
  const g4 = await call('GET', `/api/app/dial-next?device_id=${anaPhone}&wait=0`, ANA);
  check('the phone does not ring 30 seconds later', g4.request === null, g4);
  check('the laptop says it was not picked up', (await call('GET', `/api/app/dial/${late.id}`, ANA)).state === 'expired');

  console.log('\n8. the phone could not place it');
  const f = await call('POST', '/api/app/dial', ANA, { phone: '9000000005' });
  await call('GET', `/api/app/dial-next?device_id=${anaPhone}&wait=0`, ANA);
  await call('POST', `/api/app/dial/${f.id}/result`, ANA, { placed: false, error: 'Calls are not allowed' });
  const fs = await call('GET', `/api/app/dial/${f.id}`, ANA);
  check('the laptop is told why', fs.state === 'failed' && fs.error === 'Calls are not allowed', fs);

  console.log('\n9. odd input');
  check('a short number is refused', (await call('POST', '/api/app/dial', ANA, { phone: '12345' })).status === 400);
  check("someone else's request cannot be read", (await call('GET', `/api/app/dial/${f.id}`, BHAVIN)).status === 404);

  console.log('\n10. a phone signed out by an admin');
  await pool.query(`UPDATE app_devices SET revoked_at = NOW() WHERE id = $1`, [anaPhone]);
  check('is no longer ready', (await call('GET', '/api/app/dialer', ANA)).ready === false);
  check('and cannot ask for calls', (await call('GET', `/api/app/dial-next?device_id=${anaPhone}&wait=0`, ANA)).status === 403);

  console.log('\n11. after half a minute of silence the phone is not ready');
  await pool.query(`UPDATE app_devices SET revoked_at = NULL, dialer_seen_at = NOW() - INTERVAL '40 seconds' WHERE id = $1`, [anaPhone]);
  check('not ready', (await call('GET', '/api/app/dialer', ANA)).ready === false);

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
