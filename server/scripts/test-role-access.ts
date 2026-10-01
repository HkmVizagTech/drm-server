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
  // And it does NOT claim to have been checked. A site that was never asked
  // reporting "last checked 2 minutes ago" under a banner saying it was never
  // asked is the kind of contradiction that makes somebody stop trusting the
  // whole screen.
  await pool.query(`TRUNCATE abandoned_sync_state RESTART IDENTITY CASCADE`);
  r = await req('GET', '/api/crm/leads/abandoned?days=30&fresh=true', caller);
  check(
    'and does not claim a check time it never had',
    (r.body.sites ?? []).every((st: any) => st.last_synced_at === null),
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

  console.log('\n10. every rupee through a QR counts as raised by calling');
  await pool.query(`TRUNCATE leads, qr_shares, qr_payments, razorpay_qrs RESTART IDENTITY CASCADE`);
  const q1 = await pool.query(
    `INSERT INTO razorpay_qrs (qr_id, label, active) VALUES ('qr_COUNT01','Annadan QR',TRUE) RETURNING id`
  );
  await pool.query(
    `INSERT INTO razorpay_qrs (qr_id, label, owner_id, active)
     VALUES ('qr_COUNT02','Ana QR',$1::uuid,TRUE)`,
    [CALLER]
  );
  const lead10 = await pool.query(
    `INSERT INTO leads (phone, name) VALUES ('9600000001','Donor') RETURNING id`
  );
  const share10 = await pool.query(
    `INSERT INTO qr_shares (qr_id, lead_id, shared_by, phone, channel)
     VALUES ($1::uuid,$2::uuid,$3::uuid,'9600000001','whatsapp') RETURNING id`,
    [q1.rows[0].id, lead10.rows[0].id, CALLER]
  );
  // One attributed, one not — both are money the calling brought in.
  await pool.query(
    `INSERT INTO qr_payments (payment_id, qr_id, amount, status, received_at, share_id)
     VALUES ('pay_C1','qr_COUNT01', 1000, 'captured', NOW(), $1::uuid)`,
    [share10.rows[0].id]
  );
  await pool.query(
    `INSERT INTO qr_payments (payment_id, qr_id, amount, status, received_at)
     VALUES ('pay_C2','qr_COUNT01', 2500, 'captured', NOW())`
  );
  // A failed one must not be counted at all.
  await pool.query(
    `INSERT INTO qr_payments (payment_id, qr_id, amount, status, received_at)
     VALUES ('pay_C3','qr_COUNT01', 9999, 'failed', NOW())`
  );

  r = await req('GET', '/api/crm/qrs?all=true', admin);
  const counted = (r.body.qrs ?? []).find((x: any) => x.qr_id === 'qr_COUNT01');
  check('the QR shows everything that came through it', Number(counted?.raised) === 3500, counted);
  check('with the attributed part named separately', Number(counted?.attributed) === 1000, counted);
  check('and one payment still to match', counted?.unattributed === 1, counted);

  r = await req('GET', '/api/crm/dashboard?preset=today', admin);
  const qrRow = (r.body.by_qr ?? []).find((x: any) => x.qr_id === 'qr_COUNT01');
  check('the overview breaks it down by QR', Number(qrRow?.raised) === 3500, r.body.by_qr);
  check('and totals it', Number(r.body.qr?.through_qrs) === 3500, r.body.qr);
  check('a failed payment is in neither', !JSON.stringify(r.body.by_qr).includes('9999'), r.body.by_qr);

  console.log('\n11. a call made outside DRM is still recorded');
  await pool.query(`TRUNCATE leads, lead_activities RESTART IDENTITY CASCADE`);
  await pool.query(
    `INSERT INTO crm_dispositions (slug, label, counts_connected, suggests_status, wants_follow_up, sort_order)
     VALUES ('interested','Interested',TRUE,'interested',TRUE,10) ON CONFLICT (slug) DO NOTHING`
  );
  r = await req('POST', '/api/crm/calls/outside', caller, {
    phone: '+91 96000 00002',
    name: 'Rang the temple',
    disposition: 'interested',
    note: 'Asked about annadan',
  });
  check('201', r.status === 201, r.body);
  check('a lead was created', r.body.created === true, r.body);
  check('assigned to whoever made the call', r.body.lead?.assigned_to === CALLER, r.body.lead);
  check('with the call on its record', !!r.body.activity?.id, r.body);
  const acts11 = await pool.query(
    `SELECT kind, user_id FROM lead_activities WHERE lead_id = $1`,
    [r.body.lead.id]
  );
  check('logged as a call, by them', acts11.rows.some((a) => a.kind === 'call' && a.user_id === CALLER), acts11.rows);

  // And the same number again does not make a second lead.
  r = await req('POST', '/api/crm/calls/outside', caller, {
    phone: '9600000002',
    disposition: 'interested',
  });
  check('a second call does not duplicate them', r.body.created === false, r.body);
  check(
    'one lead for that number',
    (await pool.query(`SELECT COUNT(*)::int c FROM leads WHERE phone = '9600000002'`)).rows[0].c === 1
  );

  console.log('\n12. a QR can be sent to a number DRM has never heard of');
  r = await req('POST', '/api/crm/qr/share-to', caller, {
    phone: '9600000003',
    name: 'Slip of paper',
    qr_id: q1.rows[0].id,
    expected_amount: 1100,
  });
  check('201', r.status === 201, r.body);
  check('a WhatsApp link comes back', typeof r.body.wa_url === 'string', r.body);
  const madeLead = await pool.query(`SELECT * FROM leads WHERE phone = '9600000003'`);
  check('the person is now a lead', madeLead.rows.length === 1, madeLead.rows.length);
  const madeShare = await pool.query(`SELECT * FROM qr_shares WHERE phone = '9600000003'`);
  check('and the share is recorded, so a payment can find them', madeShare.rows.length === 1, madeShare.rows);
  check('credited to the caller who sent it', madeShare.rows[0]?.shared_by === CALLER, madeShare.rows[0]);

  console.log('\n13. a sheet keyed on preacher ID numbers');
  const { preacherIdFrom } = await import('../src/routes/crmPreachers');
  await pool.query(`TRUNCATE preachers RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO preachers (code, name, id_number) VALUES ('JTMD','Jagat Tarini','1042')`);

  check(
    'an id number finds the preacher it belongs to',
    (await preacherIdFrom({ idNumber: '1042' })) ===
      (await pool.query(`SELECT id FROM preachers WHERE code='JTMD'`)).rows[0].id
  );
  check('a code still works on its own', !!(await preacherIdFrom({ code: 'JTMD' })));

  // An id with a code beside it registers the preacher properly.
  const madeId = await preacherIdFrom({ code: 'NEWP', idNumber: '2051' });
  check('an id with a code creates one', !!madeId);
  check(
    'carrying the id number',
    (await pool.query(`SELECT id_number FROM preachers WHERE code='NEWP'`)).rows[0].id_number === '2051'
  );

  // An id alone that matches nothing must NOT invent a preacher: it means
  // something in the temple's own system and a made-up row would attribute
  // donations to somebody who does not exist.
  check('an unknown id alone invents nobody', (await preacherIdFrom({ idNumber: '9999' })) === null);
  check(
    'and no row was created for it',
    (await pool.query(`SELECT COUNT(*)::int c FROM preachers WHERE id_number='9999'`)).rows[0].c === 0
  );

  console.log('\n14. the totals cover the whole list, not just the page');
  // The reported bug: value at stake fell from about twelve lakhs to seven
  // when the page started reading a stored copy. The money had not moved - the
  // totals were being summed in JavaScript over the 500 rows the query
  // returned, so any list longer than that reported the value of its first
  // five hundred people and nothing else.
  await pool.query(`TRUNCATE abandoned_attempts, abandoned_sync_state RESTART IDENTITY CASCADE`);
  await pool.query(
    `INSERT INTO abandoned_sync_state (source_site, last_synced_at) VALUES ('hkmv', NOW()), ('annadan', NOW())`
  );
  await pool.query(
    `INSERT INTO abandoned_attempts (source_site, external_id, phone, name, amount, status, attempted_at)
     SELECT 'hkmv', 'bulk' || g, '9' || lpad(g::text, 9, '0'), 'Donor ' || g,
            1000, 'pending', NOW() - INTERVAL '2 days'
       FROM generate_series(1, 700) g`
  );

  r = await req('GET', '/api/crm/leads/abandoned?days=30', caller);
  check('the page is capped', (r.body.rows ?? []).length === 500, (r.body.rows ?? []).length);
  check('but the count is the whole list', r.body.open === 700, r.body.open);
  check(
    'and so is the value at stake',
    Number(r.body.value_at_stake) === 700000,
    r.body.value_at_stake
  );
  check('the page says it is not showing everything', r.body.complete === false, r.body.complete);

  // Filters must narrow the total too, not just the page.
  r = await req('GET', '/api/crm/leads/abandoned?days=30&max_amount=999', caller);
  check('a filter that matches nothing totals zero', Number(r.body.value_at_stake) === 0, r.body);

  console.log('\n15. a view asking for a year is not answered from ninety days');
  await pool.query(`TRUNCATE abandoned_attempts RESTART IDENTITY CASCADE`);
  await pool.query(
    `INSERT INTO abandoned_attempts (source_site, external_id, phone, name, amount, status, attempted_at)
     VALUES ('hkmv','old1','9888000001','Long ago', 4000,'pending', NOW() - INTERVAL '200 days'),
            ('hkmv','new1','9888000002','Recent',   1000,'pending', NOW() - INTERVAL '2 days')`
  );
  r = await req('GET', '/api/crm/leads/abandoned?days=30', caller);
  check('a 30-day view excludes the old one', Number(r.body.value_at_stake) === 1000, r.body.value_at_stake);
  r = await req('GET', '/api/crm/leads/abandoned?days=365', caller);
  check('a year view includes it', Number(r.body.value_at_stake) === 5000, r.body.value_at_stake);

  console.log('\n16. setting somebody aside sets aside the person, not one attempt');
  await pool.query(`TRUNCATE abandoned_attempts RESTART IDENTITY CASCADE`);
  await pool.query(
    `INSERT INTO abandoned_attempts (source_site, external_id, phone, name, amount, status, attempted_at)
     VALUES ('hkmv','t1','9877000001','Tried four', 10000,'pending', NOW() - INTERVAL '26 days'),
            ('hkmv','t2','9877000001','Tried four', 10000,'pending', NOW() - INTERVAL '19 days'),
            ('hkmv','t3','9877000001','Tried four', 10000,'pending', NOW() - INTERVAL '12 days'),
            ('hkmv','t4','9877000001','Tried four',   500,'pending', NOW() - INTERVAL '2 days')`
  );
  r = await req('GET', '/api/crm/leads/abandoned?days=30', caller);
  check('one row for the person', (r.body.rows ?? []).length === 1, r.body.rows);
  check('showing their most recent attempt', Number(r.body.rows[0].amount) === 500, r.body.rows[0]);
  check('and counting the attempts in view', r.body.rows[0].attempts_in_view === 4, r.body.rows[0]);

  r = await req('POST', `/api/crm/leads/abandoned/${r.body.rows[0].id}/dismiss`, caller);
  check('all four attempts go at once', r.body.attempts === 4, r.body);
  r = await req('GET', '/api/crm/leads/abandoned?days=30', caller);
  check('they are gone', (r.body.rows ?? []).length === 0, r.body.rows);
  check('and the value went DOWN, not up', Number(r.body.value_at_stake) === 0, r.body.value_at_stake);

  console.log('\n17. an amount filter does not change who represents a person');
  await pool.query(`TRUNCATE abandoned_attempts RESTART IDENTITY CASCADE`);
  await pool.query(
    `INSERT INTO abandoned_attempts (source_site, external_id, phone, name, amount, status, attempted_at)
     VALUES ('hkmv','b1','9877000002','Big then small', 25000,'pending', NOW() - INTERVAL '20 days'),
            ('hkmv','b2','9877000002','Big then small',   500,'pending', NOW() - INTERVAL '2 days')`
  );
  r = await req('GET', '/api/crm/leads/abandoned?days=30', caller);
  check('represented by the most recent attempt', Number(r.body.value_at_stake) === 500, r.body.value_at_stake);
  r = await req('GET', '/api/crm/leads/abandoned?days=30&min_amount=1000', caller);
  check(
    'and a minimum amount excludes them rather than promoting an older attempt',
    Number(r.body.value_at_stake) === 0 && (r.body.rows ?? []).length === 0,
    r.body
  );

  console.log('\n18. a sync that fails does not mark the site as freshly checked');
  await pool.query(`TRUNCATE abandoned_sync_state RESTART IDENTITY CASCADE`);
  await pool.query(
    `INSERT INTO abandoned_sync_state (source_site, last_synced_at, synced_days)
     VALUES ('hkmv', NOW() - INTERVAL '2 hours', 90)`
  );
  const before18 = (await pool.query(`SELECT last_synced_at FROM abandoned_sync_state WHERE source_site='hkmv'`))
    .rows[0].last_synced_at;
  // The sites are unreachable from a test, so this sync fails by construction.
  r = await req('POST', '/api/crm/leads/abandoned/refresh', caller, { days: 30 });
  const after18 = (await pool.query(`SELECT last_synced_at, last_error FROM abandoned_sync_state WHERE source_site='hkmv'`))
    .rows[0];
  check(
    'the last-checked time is untouched by a failure',
    new Date(after18.last_synced_at).getTime() === new Date(before18).getTime(),
    { before: before18, after: after18.last_synced_at }
  );
  check('and the reason is recorded', !!after18.last_error, after18);

  console.log('\n19. a row the site cannot identify is skipped, not collapsed');
  // An empty external id would collide with every other id-less row from that
  // site under the unique key, folding a whole site into one person.
  let rejected = false;
  try {
    await pool.query(
      `INSERT INTO abandoned_attempts (source_site, external_id, phone, attempted_at)
       VALUES ('hkmv','', '9877000003', NOW())`
    );
  } catch {
    rejected = true;
  }
  check('the database refuses an empty id', rejected);

  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall green\n');
  server.close();
  await pool.end();
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
