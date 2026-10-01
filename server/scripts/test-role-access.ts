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
import crmReportsRoutes from '../src/routes/crmReports';

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
app.use('/api/crm', crmReportsRoutes);

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
  check('both sites are accounted for', (r.body.sites ?? []).length === 2, r.body.sites);
  check(
    'and each says plainly that it is not connected',
    (r.body.sites ?? []).every((st: any) => /not connected/i.test(st.error ?? '')),
    r.body.sites
  );
  check(
    'with a last-checked time, so the page can say how fresh it is',
    (r.body.sites ?? []).every((st: any) => !!st.last_synced_at),
    r.body.sites
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

  console.log('\n7. money is counted on the day it arrived, not the day the lead was added');
  // The reported case: a caller works a sheet uploaded months ago and takes a
  // QR payment today. Raised used to be windowed on the lead's created_at, so
  // today read zero - on the caller's screen and the admin's.
  await pool.query(`TRUNCATE leads RESTART IDENTITY CASCADE`);
  await pool.query(
    `INSERT INTO leads (phone, name, assigned_to, created_at, status, converted_at, converted_amount, converted_via)
     VALUES ('9700000001','Old sheet donor',$1::uuid, NOW() - INTERVAL '120 days',
             'converted', NOW(), 2500, 'manual')`,
    [CALLER]
  );
  r = await req('GET', '/api/crm/dashboard?preset=today', caller);
  check('the money shows for today', Number(r.body.leads?.raised) === 2500, r.body.leads);
  check('and one donor paid', r.body.leads?.donors_paid === 1, r.body.leads);
  check(
    'while the cohort still reads honestly - nobody was ADDED today',
    r.body.leads?.received === 0,
    r.body.leads
  );
  r = await req('GET', '/api/crm/dashboard?preset=today', admin);
  check('the admin sees the same money', Number(r.body.leads?.raised) === 2500, r.body.leads);

  console.log('\n8. a QR payment on an unowned lead credits whoever shared it');
  await pool.query(`TRUNCATE leads, qr_shares, qr_payments, razorpay_qrs RESTART IDENTITY CASCADE`);
  const sharedQr = await pool.query(
    `INSERT INTO razorpay_qrs (qr_id, label, active) VALUES ('qr_TEMPLE01','Temple QR',TRUE) RETURNING id`
  );
  const orphan = await pool.query(
    `INSERT INTO leads (phone, name) VALUES ('9700000002','Nobody owns me') RETURNING id`
  );
  const sh = await pool.query(
    `INSERT INTO qr_shares (qr_id, lead_id, shared_by, phone, channel)
     VALUES ($1::uuid,$2::uuid,$3::uuid,'9700000002','whatsapp') RETURNING id`,
    [sharedQr.rows[0].id, orphan.rows[0].id, CALLER]
  );
  const op = await pool.query(
    `INSERT INTO qr_payments (payment_id, qr_id, amount, status, received_at)
     VALUES ('pay_ORPHAN01','qr_TEMPLE01', 700, 'captured', NOW()) RETURNING id`
  );

  // A caller must be able to SEE it before they can attribute it.
  r = await req('GET', '/api/crm/qr/payments?scope=unmatched', caller);
  check(
    'an unmatched payment on the temple QR is visible to a caller',
    (r.body.payments ?? []).some((p: any) => p.payment_id === 'pay_ORPHAN01'),
    (r.body.payments ?? []).length
  );

  r = await req('POST', `/api/crm/qr/payments/${op.rows[0].id}/attach`, caller, { share_id: sh.rows[0].id });
  check('and they can attribute it', r.status === 200, r.body);
  const credited = await pool.query(`SELECT assigned_to, converted_amount FROM leads WHERE id = $1`, [
    orphan.rows[0].id,
  ]);
  check('the lead is now theirs', credited.rows[0].assigned_to === CALLER, credited.rows[0]);
  check('with the money on it', Number(credited.rows[0].converted_amount) === 700, credited.rows[0]);
  r = await req('GET', '/api/crm/dashboard?preset=today', caller);
  check('so it reaches their overview', Number(r.body.leads?.raised) === 700, r.body.leads);

  console.log('\n9. the unfinished attempts are stored, filtered and dismissible');
  await pool.query(`TRUNCATE abandoned_attempts, abandoned_sync_state RESTART IDENTITY CASCADE`);
  await pool.query(
    `INSERT INTO abandoned_attempts (source_site, external_id, phone, name, amount, status, attempted_at)
     VALUES ('hkmv','e1','9811000001','Big',  50000,'failed',  NOW() - INTERVAL '2 days'),
            ('hkmv','e2','9811000002','Small',   500,'pending', NOW() - INTERVAL '3 days'),
            ('annadan','e3','9811000003','Mid',  5000,'created', NOW() - INTERVAL '40 days')`
  );
  await pool.query(
    `INSERT INTO abandoned_sync_state (source_site, last_synced_at) VALUES ('hkmv', NOW()), ('annadan', NOW())`
  );

  r = await req('GET', '/api/crm/leads/abandoned?days=30', caller);
  check('only the last 30 days', (r.body.rows ?? []).length === 2, (r.body.rows ?? []).map((x: any) => x.name));
  check('value at stake adds up', Number(r.body.value_at_stake) === 50500, r.body.value_at_stake);

  r = await req('GET', '/api/crm/leads/abandoned?days=365&min_amount=1000', caller);
  check('a minimum amount filters', (r.body.rows ?? []).length === 2, (r.body.rows ?? []).map((x: any) => x.name));
  r = await req('GET', '/api/crm/leads/abandoned?days=365&min_amount=1000&max_amount=10000', caller);
  check('a range filters', (r.body.rows ?? []).length === 1 && r.body.rows[0].name === 'Mid', r.body.rows);
  r = await req('GET', '/api/crm/leads/abandoned?days=365&status=failed', caller);
  check('by what happened', (r.body.rows ?? []).length === 1 && r.body.rows[0].name === 'Big', r.body.rows);
  r = await req('GET', '/api/crm/leads/abandoned?days=365&sort=amount', caller);
  check('biggest first', r.body.rows[0].name === 'Big', (r.body.rows ?? []).map((x: any) => x.name));
  r = await req('GET', '/api/crm/leads/abandoned?days=365&search=Mid', caller);
  check('and by name', (r.body.rows ?? []).length === 1, r.body.rows);

  // Somebody who has since given is never shown.
  const giver = await pool.query(
    `INSERT INTO people (name, phone) VALUES ('Big','9811000001') RETURNING id`
  );
  await pool.query(
    `INSERT INTO donations (person_id, amount, purpose, payment_mode, source_site, external_ref)
     VALUES ($1::uuid, 50000, 'general', 'upi', 'hkmv', 'ext_big')`,
    [giver.rows[0].id]
  );
  r = await req('GET', '/api/crm/leads/abandoned?days=365', caller);
  check('somebody who has since given drops off', !(r.body.rows ?? []).some((x: any) => x.name === 'Big'), r.body.rows);
  check('and is counted as settled', r.body.gave_anyway === 1, r.body);

  const toDismiss = (r.body.rows ?? [])[0];
  r = await req('POST', `/api/crm/leads/abandoned/${toDismiss.id}/dismiss`, caller);
  check('setting one aside works', r.status === 200, r.body);
  r = await req('GET', '/api/crm/leads/abandoned?days=365', caller);
  check(
    'and it stays aside',
    !(r.body.rows ?? []).some((x: any) => x.id === toDismiss.id),
    (r.body.rows ?? []).length
  );

  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall green\n');
  server.close();
  await pool.end();
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
