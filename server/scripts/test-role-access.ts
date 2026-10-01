// What each role can actually reach, asked of the real routers with the real
// guards, mounted the way index.ts mounts them.
//
// WHY THIS EXISTS
// Two classes of bug keep producing the same symptom - a screen that is simply
// empty. A guard that refuses too much, and a client that swallows the refusal
// (`.catch(console.error)` leaves the table rendering its empty state). Neither
// shows an error anywhere a user can see, so the only way to know what a caller
// can really see is to ask the server as one.
//
//   DATABASE_URL=postgresql://localhost/drm_test npm run test:access

import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken, readOnlyFor, denyRole } from '../src/middleware/auth';
import peopleRoutes from '../src/routes/people';
import donationsRoutes from '../src/routes/donations';
import crmRoutes from '../src/routes/crm';
import crmQrRoutes from '../src/routes/crmQr';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

const app = express();
app.use(express.json());
// Mirrors index.ts exactly. If that file's mounting changes, this test is the
// thing that notices.
app.use('/api/people', readOnlyFor('caller'), peopleRoutes);
app.use('/api/donations', readOnlyFor('caller'), donationsRoutes);
app.use('/api/crm', crmRoutes);
app.use('/api/crm', crmQrRoutes);

let base = '';
const ADMIN = '11111111-1111-1111-1111-111111111111';
const CALLER = '22222222-2222-2222-2222-222222222222';

function req(
  method: string,
  path: string,
  as: { userId: string; role: string } | null,
  body?: unknown
): Promise<{ status: number; body: any }> {
  const raw = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const headers: Record<string, string | number> = {};
  if (as) headers.authorization = `Bearer ${generateToken({ userId: as.userId, email: 'x@t', role: as.role } as never)}`;
  if (raw) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = raw.length;
  }
  return new Promise((resolve, reject) => {
    const r = http.request(`${base}${path}`, { method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: d ? JSON.parse(d) : {} });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: d });
        }
      });
    });
    r.on('error', reject);
    if (raw) r.write(raw);
    r.end();
  });
}

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300));
  }
}

async function seed() {
  await pool.query(
    `TRUNCATE qr_payments, qr_shares, razorpay_qrs, lead_activities, lead_reminders,
              leads, donations, people, users RESTART IDENTITY CASCADE`
  );
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role) VALUES
       ($1,'Admin','a@t','x','admin'), ($2,'Ana','ana@t','x','caller')`,
    [ADMIN, CALLER]
  );
  const p = await pool.query(
    `INSERT INTO people (name, phone, email) VALUES ('Ramesh','9848012345','r@t') RETURNING id`
  );
  await pool.query(
    `INSERT INTO donations (person_id, amount, purpose, payment_mode, source_site, external_ref)
     VALUES ($1::uuid, 5000, 'general', 'upi', 'hkmv', 'ext_1')`,
    [p.rows[0].id]
  );
  return p.rows[0].id as string;
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  const personId = await seed();

  const caller = { userId: CALLER, role: 'caller' };
  const admin = { userId: ADMIN, role: 'admin' };

  console.log('\n1. a caller can READ the donor records');
  let r = await req('GET', '/api/people?page=1&limit=25&sort=recent', caller);
  check('people list is 200', r.status === 200, r.body);
  check('and it is not empty', (r.body.people ?? []).length === 1, r.body);

  r = await req('GET', `/api/people/${personId}`, caller);
  check('one person opens', r.status === 200, r.body);

  r = await req('GET', '/api/donations?limit=50', caller);
  check('donations list is 200', r.status === 200, r.body);
  check('and it is not empty', (r.body.donations ?? []).length === 1, r.body);

  console.log('\n2. but cannot change them');
  r = await req('POST', '/api/people', caller, { name: 'X', phone: '9000000000' });
  check('creating a person is refused', r.status === 403, r.status);

  console.log('\n3. the same screens for an admin, as a control');
  r = await req('GET', '/api/people?page=1&limit=25', admin);
  check('people list is 200', r.status === 200 && (r.body.people ?? []).length === 1, r.body);
  r = await req('GET', '/api/donations?limit=50', admin);
  check('donations list is 200', r.status === 200 && (r.body.donations ?? []).length === 1, r.body);

  console.log('\n4. unfinished donations resolve as their own route, not as a lead id');
  // The exact bug: /leads/:id was registered first, so "abandoned" was read as
  // a lead id, Postgres refused the uuid cast and the page answered 500.
  r = await req('GET', '/api/crm/leads/abandoned?days=30', caller);
  check('not a 500', r.status !== 500, { status: r.status, body: r.body });
  check('it answers with the list shape', Array.isArray(r.body.rows), r.body);
  check(
    'and not with the lead handler\'s error',
    !String(JSON.stringify(r.body)).includes('Could not load that lead'),
    r.body
  );

  console.log('\n4b. an unconfigured site is named, not silently counted as zero');
  r = await req('GET', '/api/crm/leads/abandoned?days=30&fresh=true', caller);
  check(
    'both sites are accounted for',
    (r.body.site_errors ?? []).length === 2,
    r.body.site_errors
  );
  check(
    'and the reason says they are not connected',
    (r.body.site_errors ?? []).every((e: any) => /not connected/i.test(e.error)),
    r.body.site_errors
  );

  console.log('\n5. a caller can raise and resend a receipt');
  const qr = await pool.query(
    `INSERT INTO razorpay_qrs (qr_id, label, owner_id, receipt_site, active)
     VALUES ('qr_ACCESS01','Ana QR',$1::uuid,'hkmv',TRUE) RETURNING id`,
    [CALLER]
  );
  const lead = await pool.query(
    `INSERT INTO leads (phone, name, assigned_to) VALUES ('9848012345','Ramesh',$1::uuid) RETURNING id`,
    [CALLER]
  );
  const share = await pool.query(
    `INSERT INTO qr_shares (qr_id, lead_id, shared_by, phone, channel)
     VALUES ($1::uuid,$2::uuid,$3::uuid,'9848012345','whatsapp') RETURNING id`,
    [qr.rows[0].id, lead.rows[0].id, CALLER]
  );
  const pay = await pool.query(
    `INSERT INTO qr_payments (payment_id, qr_id, amount, status, received_at)
     VALUES ('pay_ACCESS01','qr_ACCESS01', 500, 'captured', NOW()) RETURNING id`
  );

  r = await req('POST', `/api/crm/qr/payments/${pay.rows[0].id}/attach`, caller, {
    share_id: share.rows[0].id,
  });
  check('attributing their own share is allowed', r.status === 200, r.body);

  r = await req('POST', `/api/crm/qr/payments/${pay.rows[0].id}/issue-receipt`, caller);
  // The site is unreachable from a test, so a failure to issue is expected —
  // what matters is that the caller was not REFUSED.
  check('raising the receipt is not refused', r.status !== 403, { status: r.status, body: r.body });

  console.log("\n6. but not somebody else's share");
  const other = await pool.query(
    `INSERT INTO qr_shares (qr_id, lead_id, shared_by, phone, channel)
     VALUES ($1::uuid,$2::uuid,$3::uuid,'9111111111','whatsapp') RETURNING id`,
    [qr.rows[0].id, lead.rows[0].id, ADMIN]
  );
  const pay2 = await pool.query(
    `INSERT INTO qr_payments (payment_id, qr_id, amount, status, received_at)
     VALUES ('pay_ACCESS02','qr_ACCESS01', 900, 'captured', NOW()) RETURNING id`
  );
  r = await req('POST', `/api/crm/qr/payments/${pay2.rows[0].id}/attach`, caller, {
    share_id: other.rows[0].id,
  });
  check('attributing a colleague\'s share is refused', r.status === 404, r.status);

  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall green\n');
  server.close();
  await pool.end();
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
