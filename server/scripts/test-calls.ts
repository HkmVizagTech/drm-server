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
//   - "I unticked 80G and it came back anyway"
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
  // Paid, so she leaves Nearly gave (called or not).
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
  await req('POST', `/api/crm/qr/payments/${keep}/receipt`, admin, {
    donor_name: 'Keep Me', donor_phone: '9811100001', site: 'hkmv', want_prasadam: true, want_certificate: false,
  });
  const flags = (await pool.query(`SELECT want_prasadam, want_certificate, donor_pan FROM qr_payments WHERE id = $1`, [keep])).rows[0];
  check('prasadam and "no 80G this time" are saved on the payment', flags.want_prasadam === true && flags.want_certificate === false, flags);

  console.log('\n7. leads an admin parked with themselves can be called by the caller');
  await pool.query(`DELETE FROM abandoned_attempts`);
  await pool.query(
    `INSERT INTO abandoned_attempts (source_site, external_id, phone, name, amount, purpose, source_page, attempted_at, status) VALUES
       ('hkmv','p1','9833333301','Parked One',700,'Gau seva','seva/gau-seva',NOW() - INTERVAL '3 hours','failed'),
       ('hkmv','p2','9833333302','Bhavin Has',800,'Gau seva','seva/gau-seva',NOW() - INTERVAL '3 hours','failed'),
       ('hkmv','p3','9833333303','Parked Two',900,'Gau seva','seva/gau-seva',NOW() - INTERVAL '3 hours','failed')`
  );
  let list = await req('GET', '/api/crm/leads/abandoned?days=30', admin);
  const idOf = (name: string) => list.body.rows?.find((r: any) => r.name === name)?.id;
  await req('POST', '/api/crm/leads/abandoned/adopt-bulk', admin, {
    ids: [idOf('Parked One'), idOf('Parked Two')], filters: { days: '30' }, assign: 'me',
  });
  await req('POST', '/api/crm/leads/abandoned/adopt-bulk', admin, {
    ids: [idOf('Bhavin Has')], filters: { days: '30' }, assign: BHAVIN,
  });
  list = await req('GET', '/api/crm/leads/abandoned?days=30', ana);
  const parked = list.body.rows?.find((r: any) => r.name === 'Parked One');
  check('the list says the admin does not make calls', parked?.lead_owner_calls === false, parked);
  const taken = await req('POST', '/api/crm/leads/abandoned/adopt-bulk', ana, {
    ids: [parked.id, list.body.rows.find((r: any) => r.name === 'Bhavin Has').id], filters: { days: '30' }, assign: 'me',
  });
  const owner = async (phone: string) => (await pool.query(`SELECT assigned_to FROM leads WHERE phone = $1`, [phone])).rows[0]?.assigned_to;
  check('calling it hands it to her', taken.body.lead_ids?.length === 1 && (await owner('9833333301')) === ANA, taken.body);
  check("but a fellow caller's lead stays his", taken.body.already_others === 1 && (await owner('9833333302')) === BHAVIN, taken.body);
  const srcs = await req('GET', '/api/crm/sessions/sources', ana);
  const ngCount = srcs.body.sources?.find((x: any) => x.kind === 'nearly_gave')?.count;
  const run = await req('POST', '/api/crm/sessions', ana, { source: { kind: 'nearly_gave' } });
  check('Call all includes the parked one, and takes it', (await owner('9833333303')) === ANA && (run.status === 200 || run.status === 201), [ngCount, run.status, run.body?.error]);
  await req('POST', `/api/crm/sessions/${run.body.session?.id}/end`, ana, {});

  console.log('\n8. a caller can add a lead, and the overview links open what they counted');
  let r8 = await req('POST', '/api/crm/leads', ana, { phone: '98444 00001', name: 'Walk In', source: 'walk_in', status: 'converted', assigned_to: BHAVIN });
  const w = (await pool.query(`SELECT assigned_to, status, source FROM leads WHERE phone = '9844400001'`)).rows[0];
  check('a caller adds a lead for herself, as new', r8.status === 201 && w.assigned_to === ANA && w.status === 'new' && w.source === 'walk_in', [r8.status, w]);
  await pool.query(`INSERT INTO leads (phone, name, assigned_to) VALUES ('9844400002','Parked Lead',$1)`, [ADMIN]);
  r8 = await req('POST', '/api/crm/leads', ana, { phone: '9844400002' });
  check('adding a number parked with an admin makes it hers', r8.body.lead?.assigned_to === ANA && !r8.body.owner_name, r8.body);
  await pool.query(`INSERT INTO leads (phone, name, assigned_to) VALUES ('9844400003','Bhavins',$1)`, [BHAVIN]);
  r8 = await req('POST', '/api/crm/leads', ana, { phone: '9844400003' });
  check("a fellow caller's lead stays his, and she is told", r8.body.owner_name === 'Bhavin', r8.body);
  const today8 = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  r8 = await req('GET', `/api/crm/leads?assigned_to=${ANA}&added_from=${today8}&added_to=${today8}&limit=100`, ana);
  const names8 = (r8.body.leads ?? []).map((x: any) => x.name);
  check('"added today" finds them', names8.includes('Walk In') && names8.includes('Parked Lead'), names8);
  r8 = await req('GET', `/api/crm/leads?added_from=2000-01-01&added_to=2000-01-02&limit=100`, ana);
  check('and a past window finds none', (r8.body.leads ?? []).length === 0, r8.body.total);
  await pool.query(`UPDATE leads SET do_not_call = TRUE WHERE phone = '9844400001'`);
  r8 = await req('GET', `/api/crm/leads?open=true&assigned_to=${ANA}&limit=100`, ana);
  check('"still being called" leaves out do-not-call', !(r8.body.leads ?? []).some((x: any) => x.name === 'Walk In'), r8.body.leads?.map((x: any) => x.name));
  r8 = await req('GET', '/api/crm/leads?limit=200', ana);
  check('and leads parked with an admin show on her Leads screen', (r8.body.leads ?? []).some((x: any) => x.phone === '9833333301' || x.phone === '9844400002'), r8.body.total);

  console.log('\n9. a person already rung is easy to spot');
  const sl = (await pool.query(`INSERT INTO leads (phone, name, assigned_to) VALUES ('9855500001','Spot Me',$1) RETURNING id`, [ANA])).rows[0].id;
  await pool.query(`INSERT INTO leads (phone, name, assigned_to) VALUES ('9855500002','Spot Never',$1)`, [ANA]);
  await req('POST', `/api/crm/leads/${sl}/call`, ana, { disposition: 'no_answer' });
  let s9 = await req('GET', '/api/crm/search?q=Spot', ana);
  const hit = s9.body.leads?.find((x: any) => x.name === 'Spot Me');
  check('search says who rang them and when', hit?.last_caller_id === ANA && !!hit.last_contacted_at && !!hit.last_outcome_label, hit);
  check('and someone never rung has no last call', !s9.body.leads?.find((x: any) => x.name === 'Spot Never')?.last_contacted_at, s9.body.leads);
  s9 = await req('GET', `/api/crm/leads?search=Spot&called_by=${ANA}&limit=50`, ana);
  check('Leads: "called by me"', JSON.stringify((s9.body.leads ?? []).map((x: any) => x.name)) === '["Spot Me"]', s9.body.leads?.map((x: any) => x.name));
  s9 = await req('GET', `/api/crm/leads?search=Spot&called=never&limit=50`, ana);
  check('Leads: "not called yet"', JSON.stringify((s9.body.leads ?? []).map((x: any) => x.name)) === '["Spot Never"]', s9.body.leads?.map((x: any) => x.name));
  check('lead rows carry the last caller', (await req('GET', `/api/crm/leads?search=Spot%20Me`, ana)).body.leads?.[0]?.last_caller_name === 'Ana');

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
