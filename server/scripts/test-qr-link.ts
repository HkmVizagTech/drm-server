// Linking a QR payment to whoever paid it - not only to somebody DRM sent a QR.
//
// The complaints this answers:
//   - "a regular donor scanned the temple QR and I could not link it to him"
//   - "a walk-in paid; he is in nobody's list and there was nothing to pick"
//   - "I linked the wrong person and could not take it back"
//   - "People is all website donors; I can't find the volunteers"
//
//   DATABASE_URL=postgresql://localhost/drm_test npx tsx scripts/test-qr-link.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken, readOnlyFor } from '../src/middleware/auth';
import crmRoutes from '../src/routes/crm';
import crmCallsRoutes from '../src/routes/crmCalls';
import crmQrRoutes from '../src/routes/crmQr';
import peopleRoutes from '../src/routes/people';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use('/api/crm', crmRoutes);
app.use('/api/crm', crmCallsRoutes);
app.use('/api/crm', crmQrRoutes);
app.use('/api/people', readOnlyFor('caller'), peopleRoutes);

let base = '';
const ADMIN = '11111111-1111-1111-1111-111111111111';
const ANA = '22222222-2222-2222-2222-222222222222';
const BHAVIN = '33333333-3333-3333-3333-333333333333';
const admin = { userId: ADMIN, role: 'admin' };
const ana = { userId: ANA, role: 'caller' };
const bhavin = { userId: BHAVIN, role: 'caller' };

function req(method: string, path: string, as: { userId: string; role: string } | null, body?: unknown) {
  const raw = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const headers: Record<string, string | number> = {};
  if (as) headers.authorization = `Bearer ${generateToken({ userId: as.userId, email: 'x@t', role: as.role } as never)}`;
  if (raw) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = raw.length;
  }
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
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
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500));
  }
}

let n = 0;
async function payment(amount: number, extra: { qr?: string; phone?: string; name?: string } = {}) {
  n++;
  return (
    await pool.query(
      `INSERT INTO qr_payments (payment_id, qr_id, amount, status, payer_name, payer_phone, received_at)
       VALUES ($1, $2, $3, 'captured', $4, $5, NOW() - INTERVAL '10 minutes') RETURNING id`,
      [`pay_L${n}`, extra.qr ?? 'qr_temple', amount, extra.name ?? 'someone@upi', extra.phone ?? null]
    )
  ).rows[0].id as string;
}
const credit = async (payId: string) =>
  (await pool.query(`SELECT user_id FROM caller_credits WHERE qr_payment_id = $1 AND status = 'active'`, [payId])).rows;

async function seed() {
  await pool.query(
    `TRUNCATE caller_credits, qr_payments, qr_shares, razorpay_qrs, lead_activities, lead_reminders, leads,
              donations, people, users RESTART IDENTITY CASCADE`
  );
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role) VALUES
       ($1,'Admin','a@t','x','admin'), ($2,'Ana','ana@t','x','caller'), ($3,'Bhavin','bh@t','x','caller')`,
    [ADMIN, ANA, BHAVIN]
  );
  await pool.query(`INSERT INTO razorpay_qrs (qr_id, label) VALUES ('qr_temple','Temple QR')`);
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  await seed();

  console.log('\n1. a walk-in nobody sent a QR to');
  const p1 = await payment(1116);
  let r = await req('POST', `/api/crm/qr/payments/${p1}/link`, ana, { kind: 'new', name: 'Ravi Teja', phone: '+91 98480 11111' });
  check('linking to a new person works', r.status === 200 && r.body.kind === 'new', r.body);
  const person = (await pool.query(`SELECT id, name, roles FROM people WHERE phone = '9848011111'`)).rows[0];
  check('and adds them to DRM as a donor', person?.name === 'Ravi Teja' && person.roles.includes('donor'), person);
  check('the caller who linked it is credited', (await credit(p1))[0]?.user_id === ANA, await credit(p1));
  r = await req('GET', '/api/crm/qr/payments?scope=all', ana);
  const row = r.body.payments?.find((x: any) => x.id === p1);
  check('the list shows who it was', row?.person_name === 'Ravi Teja' && row.linked_by_name === 'Ana', row);
  r = await req('GET', '/api/crm/qr/payments?scope=unmatched', admin);
  check('and it is no longer "Not linked"', !r.body.payments?.some((x: any) => x.id === p1), r.body.payments?.length);
  r = await req('POST', `/api/crm/qr/payments/${p1}/link`, ana, { kind: 'new', name: 'Other', phone: '9848022222' });
  check('it cannot be linked twice', r.status === 409, r.body);

  console.log('\n2. a "new" number that DRM already has');
  const p2 = await payment(500);
  r = await req('POST', `/api/crm/qr/payments/${p2}/link`, admin, { kind: 'new', name: 'R. Teja', phone: '9848011111' });
  check('it links to the existing person, not a copy', r.status === 200 && r.body.existing === true && r.body.person_id === person.id, r.body);
  check('an admin reconciling is not credited', (await credit(p2)).length === 0, await credit(p2));

  console.log('\n3. "Who paid?" finds them');
  const own = (await pool.query(
    `INSERT INTO leads (phone, name, assigned_to, expected_amount) VALUES ('9811100001','Sita Devi',$1, 2001) RETURNING id`, [ANA]
  )).rows[0].id;
  await pool.query(`INSERT INTO leads (phone, name, assigned_to) VALUES ('9811100002','Sita Ram',$1)`, [BHAVIN]);
  const p3 = await payment(2001, { phone: '9811100001', name: 'SITA DEVI' });
  r = await req('GET', `/api/crm/qr/payments/${p3}/who`, ana);
  check('the lead on the paying number is suggested first', r.body.results?.[0]?.id === own && r.body.results[0].same_number, r.body.results);
  r = await req('GET', `/api/crm/qr/payments/${p3}/who?q=sita`, ana);
  const names = (r.body.results ?? []).map((x: any) => x.name);
  check("a search finds her own lead, not a colleague's", names.includes('Sita Devi') && !names.includes('Sita Ram'), names);
  r = await req('GET', `/api/crm/qr/payments/${p3}/who?q=98480`, ana);
  check('a donor is found by number', r.body.results?.some((x: any) => x.kind === 'person' && x.name === 'Ravi Teja'), r.body.results);

  console.log('\n4. linking to a lead, and taking it back');
  await pool.query(
    `INSERT INTO lead_reminders (lead_id, title, due_at) VALUES ($1, 'Pay on Ekadashi', NOW() + INTERVAL '1 day')`, [own]
  );
  r = await req('POST', `/api/crm/qr/payments/${p3}/link`, ana, { kind: 'lead', id: own });
  check('linking to her lead works', r.status === 200, r.body);
  let lead = (await pool.query(`SELECT status, converted_amount FROM leads WHERE id = $1`, [own])).rows[0];
  check('the lead is marked Donated', lead.status === 'converted' && Number(lead.converted_amount) === 2001, lead);
  check("the lead's caller is credited", (await credit(p3))[0]?.user_id === ANA, await credit(p3));
  r = await req('POST', `/api/crm/qr/payments/${p3}/unlink`, bhavin, {});
  check('somebody else cannot unlink it', r.status === 403 || r.status === 404, r.status);
  r = await req('POST', `/api/crm/qr/payments/${p3}/unlink`, ana, {});
  check('whoever linked it can', r.status === 200 && r.body.lead_left_donated === false, r.body);
  lead = (await pool.query(`SELECT status, converted_amount FROM leads WHERE id = $1`, [own])).rows[0];
  check('the lead is back as it was', lead.status === 'new' && lead.converted_amount === null, lead);
  const rem = (await pool.query(`SELECT status FROM lead_reminders WHERE lead_id = $1`, [own])).rows[0];
  check('her promise is open again', rem.status === 'open', rem);
  check('and the credit is reversed', (await credit(p3)).length === 0, await credit(p3));
  const after = (await pool.query(`SELECT lead_id, person_id, linked_by FROM qr_payments WHERE id = $1`, [p3])).rows[0];
  check('the payment is free to link again', !after.lead_id && !after.person_id && !after.linked_by, after);

  console.log("\n5. a colleague's lead");
  const theirs = (await pool.query(`SELECT id FROM leads WHERE phone = '9811100002'`)).rows[0].id;
  r = await req('POST', `/api/crm/qr/payments/${p3}/link`, ana, { kind: 'lead', id: theirs });
  check('a caller cannot link to it', r.status === 404, r.body);
  r = await req('POST', `/api/crm/qr/payments/${p3}/link`, admin, { kind: 'lead', id: theirs });
  check('an admin can, and the credit goes to its caller', r.status === 200 && (await credit(p3))[0]?.user_id === BHAVIN, [r.body, await credit(p3)]);

  console.log('\n6. a QR send still works, credited to whoever sent it');
  const qrUuid = (await pool.query(`SELECT id FROM razorpay_qrs WHERE qr_id = 'qr_temple'`)).rows[0].id;
  const share = (await pool.query(
    `INSERT INTO qr_shares (qr_id, phone, shared_by, channel) VALUES ($1, '9800000077', $2, 'whatsapp') RETURNING id`, [qrUuid, BHAVIN]
  )).rows[0].id;
  const p6 = await payment(750);
  r = await req('POST', `/api/crm/qr/payments/${p6}/link`, ana, { kind: 'share', id: share });
  check("a caller cannot pick a colleague's QR send", r.status === 404, r.body);
  r = await req('POST', `/api/crm/qr/payments/${p6}/link`, bhavin, { kind: 'share', id: share });
  check('the sender can', r.status === 200 && (await credit(p6))[0]?.user_id === BHAVIN, [r.body, await credit(p6)]);
  r = await req('POST', `/api/crm/qr/payments/${p6}/unlink`, admin, {});
  const freed = (await pool.query(`SELECT matched_at FROM qr_shares WHERE id = $1`, [share])).rows[0];
  check('unlinking frees the QR send to match again', r.status === 200 && freed.matched_at === null, [r.body, freed]);

  console.log('\n7. once the receipt is out, the link stays');
  await pool.query(`UPDATE qr_payments SET receipt_status = 'issued', receipt_number = 'R1' WHERE id = $1`, [p1]);
  r = await req('POST', `/api/crm/qr/payments/${p1}/unlink`, admin, {});
  check('unlink is refused', r.status === 409, r.body);

  console.log('\n8. sending a receipt links the payment to the donor on it');
  const p8 = await payment(301);
  r = await req('POST', `/api/crm/qr/payments/${p8}/receipt`, ana, { donor_name: 'Lakshmi', donor_phone: '9700000008', site: 'hkmv' });
  const linked8 = (await pool.query(
    `SELECT p.link_kind, pe.name FROM qr_payments p JOIN people pe ON pe.id = p.person_id WHERE p.id = $1`, [p8]
  )).rows[0];
  check('even though nobody pressed link', linked8?.name === 'Lakshmi', [r.status, linked8]);

  console.log('\n9. linking from the lead page shows on the QR screen too');
  const lead9 = (await pool.query(`INSERT INTO leads (phone, name, assigned_to) VALUES ('9811100009','Gopal',$1) RETURNING id`, [ANA])).rows[0].id;
  const p9 = await payment(999);
  r = await req('POST', `/api/crm/leads/${lead9}/link-donation`, ana, { qr_payment_id: p9 });
  check('the lead page links it', r.status === 200, r.body);
  r = await req('GET', '/api/crm/qr/payments?scope=all', ana);
  check('and the QR screen names the lead', r.body.payments?.find((x: any) => x.id === p9)?.lead_name === 'Gopal', r.body.payments?.find((x: any) => x.id === p9));
  const act = (await pool.query(`SELECT id FROM lead_activities WHERE lead_id = $1 AND kind = 'link_donation'`, [lead9])).rows[0].id;
  await req('POST', `/api/crm/link-donation/${act}/undo`, ana);
  const un9 = (await pool.query(`SELECT lead_id FROM qr_payments WHERE id = $1`, [p9])).rows[0];
  check('and undoing it there unlinks it here', un9.lead_id === null, un9);

  console.log('\n10. People: hide donations-page donors, or all donors');
  const [web, seva, vol] = (
    await pool.query(
      `INSERT INTO people (name, phone, roles) VALUES ('Web Donor','9600000001','{donor}'),
         ('Seva Donor','9600000002','{donor}'), ('Volunteer','9600000003','{volunteer}') RETURNING id`
    )
  ).rows.map((x) => x.id);
  await pool.query(
    `INSERT INTO donations (person_id, amount, type, purpose, payment_mode, source, source_site, source_page) VALUES
       ($1, 500, 'one-time', 'General', 'upi', 'website', 'hkmv', 'donations'),
       ($2, 900, 'one-time', 'Gau Seva', 'upi', 'website', 'hkmv', '/gau-seva')`,
    [web, seva]
  );
  const list = async (q: string) =>
    ((await req('GET', `/api/people?limit=100${q}`, ana)).body.people ?? []).map((x: any) => x.name);
  let ppl = await list('&hide=donations_page');
  check('Donations page donors are hidden', !ppl.includes('Web Donor') && ppl.includes('Seva Donor') && ppl.includes('Volunteer'), ppl);
  ppl = await list('&hide=donors');
  check('All donors are hidden', !ppl.includes('Web Donor') && !ppl.includes('Seva Donor') && ppl.includes('Volunteer'), ppl);
  const counted = (await req('GET', '/api/people?limit=1&hide=donors', ana)).body.total;
  check('and the count agrees', counted === ppl.length, [counted, ppl.length]);
  void vol;

  server.close();
  await pool.end();
  console.log(failures ? `\n${failures} FAILED` : '\nall green');
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
