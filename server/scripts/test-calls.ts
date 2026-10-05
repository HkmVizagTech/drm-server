// The call log, "they gave from another number", and the QR receipt's effect
// on the payment it is raised against.
//
// Every case here is a complaint a caller made, or would have:
//   - "I want to see the calls I made last week, with what happened after"
//   - "I can open my colleague's calls"
//   - "she tried to give on the website and it failed, then she gave from her
//      son's phone and nobody could tell me that"
//   - "a stranger paid my temple QR and I found out weeks later"
//   - "the QR screen showed me the payment, then said not found when I pressed
//      Send receipt"
//   - "I sent the receipt and the donor's address vanished off the payment"
//   - "they rang me, and there was nowhere to write that down"
//   - "the Nearly gave list is full of people who gave on the donations page
//      and were never mine to chase"
//
//   DATABASE_URL=postgresql://localhost/drm_test npx tsx scripts/test-calls.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import crmRoutes from '../src/routes/crm';
import crmListsRoutes from '../src/routes/crmLists';
import crmSessionsRoutes from '../src/routes/crmSessions';
import crmCallsRoutes from '../src/routes/crmCalls';
import crmQrRoutes from '../src/routes/crmQr';
import crmRemindersRoutes from '../src/routes/crmReminders';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use('/api/crm', crmRoutes);
app.use('/api/crm', crmRemindersRoutes);
app.use('/api/crm', crmListsRoutes);
app.use('/api/crm', crmSessionsRoutes);
app.use('/api/crm', crmCallsRoutes);
app.use('/api/crm', crmQrRoutes);

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

async function seed() {
  await pool.query(
    `TRUNCATE caller_credits, qr_payments, qr_shares, razorpay_qrs, calling_session_items, calling_sessions,
              abandoned_attempts, lead_activities, lead_reminders, leads, donations, people, users
     RESTART IDENTITY CASCADE`
  );
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role) VALUES
       ($1,'Admin','a@t','x','admin'), ($2,'Ana','ana@t','x','caller'), ($3,'Bhavin','bh@t','x','caller')`,
    [ADMIN, ANA, BHAVIN]
  );
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  await seed();

  console.log('\n1. the call log is yours, filtered, with totals');
  const asha = (await pool.query(`INSERT INTO leads (phone, name, assigned_to) VALUES ('9811111101','Asha Rao',$1) RETURNING id`, [ANA])).rows[0].id;
  const bala = (await pool.query(`INSERT INTO leads (phone, name) VALUES ('9811111102','Bala') RETURNING id`)).rows[0].id;
  await req('POST', `/api/crm/leads/${asha}/call`, ana, { disposition: 'no_answer' });
  await req('POST', `/api/crm/leads/${bala}/call`, ana, { disposition: 'interested', note: 'Call after Diwali' });
  await req('POST', `/api/crm/leads/${bala}/call`, bhavin, { disposition: 'busy' });
  const mine = await req('GET', '/api/crm/calls', ana);
  check('Ana sees her two calls', mine.body.calls?.length === 2, mine.body);
  check('totals: 2 calls, 1 got through, 2 people', mine.body.totals?.calls === 2 && mine.body.totals?.connected === 1 && mine.body.totals?.people === 2, mine.body.totals);
  const sneaky = await req('GET', `/api/crm/calls?user_id=${BHAVIN}`, ana);
  check("a caller cannot read a colleague's calls", sneaky.body.calls?.every((c: any) => c.user_id === ANA), sneaky.body.calls);
  const team = await req('GET', '/api/crm/calls?user_id=all', admin);
  check('an admin can see the whole team', team.body.totals?.calls === 3, team.body.totals);
  const search = await req('GET', '/api/crm/calls?search=Diwali', ana);
  check('search finds a call by its note', search.body.calls?.length === 1 && search.body.calls[0].lead_id === bala, search.body);
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const yday = new Date(Date.now() + 5.5 * 3600_000 - 86_400_000).toISOString().slice(0, 10);
  const none = await req('GET', `/api/crm/calls?from=${yday}&to=${yday}`, ana);
  const some = await req('GET', `/api/crm/calls?from=${today}&to=${today}`, ana);
  check('date filter is by Indian day', none.body.totals?.calls === 0 && some.body.totals?.calls === 2, [none.body.totals, some.body.totals]);
  check('a fresh call can be undone from the log', mine.body.calls?.[0]?.undoable === true);
  const file = await new Promise<number>((resolve) => {
    http.get(`${base}/api/crm/calls/export.csv`, { headers: { authorization: `Bearer ${generateToken({ userId: ANA, email: 'x', role: 'caller' } as never)}` } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); });
  });
  check('the log downloads', file === 200, file);

  console.log('\n2. they gave from another number');
  await pool.query(
    `INSERT INTO abandoned_attempts (source_site, external_id, phone, name, amount, purpose, attempted_at, status)
     VALUES ('hkmv','z1','9811111101','Asha Rao',2500,'Annadan',NOW() - INTERVAL '6 hours','failed')`
  );
  const son = (await pool.query(`INSERT INTO people (name, phone) VALUES ('Ravi Rao','9700000009') RETURNING id`)).rows[0].id;
  const stranger = (await pool.query(`INSERT INTO people (name, phone) VALUES ('Zed','9700000010') RETURNING id`)).rows[0].id;
  const gift = (await pool.query(
    `INSERT INTO donations (person_id, amount, payment_mode, receipt_number, created_at) VALUES ($1, 2500, 'upi', 'HKM-77', NOW() - INTERVAL '2 hours') RETURNING id`, [son]
  )).rows[0].id;
  await pool.query(`INSERT INTO donations (person_id, amount, payment_mode, created_at) VALUES ($1, 300, 'upi', NOW() - INTERVAL '1 hour')`, [stranger]);
  const cands = await req('GET', `/api/crm/leads/${asha}/donation-candidates`, ana);
  check('the same amount and surname comes first', cands.body.donations?.[0]?.id === gift && cands.body.donations[0].likely === true, cands.body.donations);
  const byReceipt = await req('GET', `/api/crm/leads/${asha}/donation-candidates?q=HKM-77`, ana);
  check('search by receipt number', byReceipt.body.donations?.length === 1, byReceipt.body.donations);

  const pendingBefore = await req('GET', '/api/crm/leads/abandoned?days=30', ana);
  check('setup: she is on Nearly gave', pendingBefore.body.rows?.some((r: any) => r.phone === '9811111101'));
  const link = await req('POST', `/api/crm/leads/${asha}/link-donation`, ana, { donation_id: gift });
  check('linking succeeds', link.status === 200 && link.body.credited === true, link.body);
  const l = (await pool.query(`SELECT status, converted_amount, converted_via, alt_phone FROM leads WHERE id = $1`, [asha])).rows[0];
  check('the lead is converted with that amount', l.status === 'converted' && Number(l.converted_amount) === 2500 && l.converted_via === 'linked', l);
  check('and remembers the number they paid from', l.alt_phone === '9700000009', l);
  const credit = await pool.query(`SELECT user_id, amount FROM caller_credits WHERE donation_id = $1 AND status = 'active'`, [gift]);
  check('Ana is credited', credit.rows[0]?.user_id === ANA && Number(credit.rows[0]?.amount) === 2500, credit.rows);
  const pendingAfter = await req('GET', '/api/crm/leads/abandoned?days=30', ana);
  check('she leaves Nearly gave', !pendingAfter.body.rows?.some((r: any) => r.phone === '9811111101'), pendingAfter.body.rows);
  const twice = await req('POST', `/api/crm/leads/${bala}/link-donation`, bhavin, { donation_id: gift });
  check('the same donation cannot be linked to a second lead', twice.status === 409, twice.body);

  const undo = await req('POST', `/api/crm/link-donation/${link.body.activity_id}/undo`, ana);
  check('undo succeeds', undo.status === 200, undo.body);
  const back = (await pool.query(`SELECT status, converted_at, alt_phone FROM leads WHERE id = $1`, [asha])).rows[0];
  check('the lead is back as it was', back.status === 'attempting' && !back.converted_at && !back.alt_phone, back);
  const gone = await pool.query(`SELECT 1 FROM caller_credits WHERE donation_id = $1 AND status = 'active'`, [gift]);
  check('and the credit is reversed', gone.rows.length === 0);

  console.log('\n3. a temple QR payment from somebody else');
  await pool.query(`INSERT INTO razorpay_qrs (qr_id, label) VALUES ('qr_1','Temple')`);
  const pay = (await pool.query(
    `INSERT INTO qr_payments (payment_id, qr_id, amount, status, payer_name, payer_vpa, received_at)
     VALUES ('pay_1','qr_1',1100,'captured','BALA KRISHNA','bk@upi',NOW() - INTERVAL '30 minutes') RETURNING id`
  )).rows[0].id;
  const qc = await req('GET', `/api/crm/leads/${bala}/donation-candidates`, bhavin);
  check('unmatched QR payments are offered', qc.body.qr_payments?.some((p: any) => p.id === pay), qc.body.qr_payments);
  const ql = await req('POST', `/api/crm/leads/${bala}/link-donation`, bhavin, { qr_payment_id: pay });
  check('linking a QR payment converts and credits', ql.status === 200 && ql.body.credited === true, ql.body);
  const qcred = await pool.query(`SELECT user_id FROM caller_credits WHERE qr_payment_id = $1 AND status = 'active'`, [pay]);
  check('Bhavin, who found it, is credited', qcred.rows[0]?.user_id === BHAVIN, qcred.rows);

  console.log('\n3b. a caller can send the receipt for a temple-QR payment they can see');
  const pay2 = (await pool.query(
    `INSERT INTO qr_payments (payment_id, qr_id, amount, status, payer_name, received_at)
     VALUES ('pay_open','qr_1',300,'captured','Somebody',NOW()) RETURNING id`
  )).rows[0].id;
  const seen = await req('GET', '/api/crm/qr/payments?scope=needs_receipt', ana);
  check('it is on her list', seen.body.payments?.some((x: any) => x.id === pay2), seen.body);
  const open = await req('GET', `/api/crm/qr/payments/${pay2}`, ana);
  check('and it opens (was "Payment not found.")', open.status === 200, open.body);
  await pool.query(`INSERT INTO razorpay_qrs (qr_id, label, owner_id) VALUES ('qr_b','Bhavin QR',$1)`, [BHAVIN]);
  const theirs = (await pool.query(
    `INSERT INTO qr_payments (payment_id, qr_id, amount, status, received_at) VALUES ('pay_b','qr_b',900,'captured',NOW()) RETURNING id`
  )).rows[0].id;
  const blocked = await req('GET', `/api/crm/qr/payments/${theirs}`, ana);
  check("but not a payment on a colleague's own QR", blocked.status === 404, blocked.status);

  console.log('\n4. they rang back');
  const back2 = await req('POST', `/api/crm/leads/${asha}/call`, ana, { disposition: 'donated', direction: 'inbound', donated_amount: 1000 });
  check('an incoming call is logged as one', back2.body.activity?.direction === 'inbound', back2.body.activity);
  const inb = await req('GET', '/api/crm/calls?direction=inbound', ana);
  check('and the log can show only those', inb.body.totals?.calls === 1, inb.body.totals);

  console.log('\n5. the standalone /donations page is not Nearly gave');
  await pool.query(`DELETE FROM abandoned_attempts`);
  await pool.query(
    `INSERT INTO abandoned_attempts (source_site, external_id, phone, name, amount, purpose, source_page, attempted_at, status) VALUES
       ('hkmv','d1','9822222201','Page one',500,'General','donations',NOW() - INTERVAL '2 hours','failed'),
       ('hkmv','d2','9822222202','Page two',500,'General','donations/janmashtami',NOW() - INTERVAL '2 hours','failed'),
       ('hkmv','d3','9822222203','Legacy',500,'/donations','/donations',NOW() - INTERVAL '2 hours','failed'),
       ('hkmv','d4','9822222204','Old type',500,'Donation',NULL,NOW() - INTERVAL '2 hours','failed'),
       ('hkmv','s1','9822222205','Seva page',500,'Gau seva','seva/gau-seva',NOW() - INTERVAL '2 hours','failed'),
       ('hkmv','s2','9822222206','Donations-like',500,'Annadan','annadan-donations',NOW() - INTERVAL '2 hours','failed'),
       ('annadan','a1','9822222207','Annadan',500,'Annadan','/',NOW() - INTERVAL '2 hours','created')`
  );
  const ng = await req('GET', '/api/crm/leads/abandoned?days=30', ana);
  const phones = (ng.body.rows ?? []).map((r: any) => r.name).sort();
  check('only the three that are not from /donations', JSON.stringify(phones) === JSON.stringify(['Annadan', 'Donations-like', 'Seva page']), phones);
  check('and the totals agree', ng.body.open === 3, ng.body.open);
  const src = await req('GET', '/api/crm/sessions/sources', ana);
  check('the start screen counts 3 new', src.body.sources?.find((x: any) => x.kind === 'nearly_gave')?.new_attempts === 3, src.body.sources);

  console.log('\n6. sending a QR receipt never wipes what is already on the payment');
  const keep = (await pool.query(
    `INSERT INTO qr_payments (payment_id, qr_id, amount, status, received_at, donor_address, sevak_phone, donor_pan)
     VALUES ('pay_keep','qr_1',700,'captured',NOW(),'12 Beach Road, Vizag','9811100000','ABCDE1234F') RETURNING id`
  )).rows[0].id;
  const sent = await req('POST', `/api/crm/qr/payments/${keep}/receipt`, admin, {
    donor_name: 'Keep Me', donor_phone: '9811100001', donor_email: '', donor_pan: '', donor_address: '',
    purpose: '', sevak_name: '', sevak_phone: '', site: 'hkmv', credit_me: false,
  });
  check('the receipt request is accepted', sent.status === 200 || sent.status === 201, sent.body);
  const kept = (await pool.query(`SELECT donor_name, donor_address, sevak_phone, donor_pan FROM qr_payments WHERE id = $1`, [keep])).rows[0];
  check('a new name is saved', kept.donor_name === 'Keep Me', kept);
  check('the address is not wiped by an empty field', kept.donor_address === '12 Beach Road, Vizag', kept);
  check('nor the sevak phone, nor the PAN', kept.sevak_phone === '9811100000' && kept.donor_pan === 'ABCDE1234F', kept);
  const edit = await req('POST', `/api/crm/qr/payments/${keep}/receipt`, admin, {
    donor_name: 'Keep Me', donor_phone: '9811100001', donor_address: '5 New Street', site: 'hkmv',
  });
  const edited = (await pool.query(`SELECT donor_address FROM qr_payments WHERE id = $1`, [keep])).rows[0];
  check('a real correction still goes through', edited.donor_address === '5 New Street', [edit.status, edited]);

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
