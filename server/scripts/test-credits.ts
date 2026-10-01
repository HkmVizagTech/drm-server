// Who raised what, and whether the number survives contact with reality.
//
// THE FAILURE THIS SUITE EXISTS TO CATCH
// "How much has Ana raised" used to be a live join on leads.assigned_to. It
// was not a fact about the past, it was a statement about who owns a lead
// right now - so a bulk reassignment silently rewrote months of history for
// two people, and three screens each answered the question from a different
// table and gave three different numbers.
//
// Credit is now a written row. Every case below is a way that could go wrong:
// money credited twice, money credited to nobody, money that moves when a
// lead does, a caller taking a colleague's figures, and the one irreversible
// act in the product - an 80G receipt - firing when it should not.
//
//   DATABASE_URL=postgresql://localhost/drm_test npx tsx scripts/test-credits.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import { recordCredit, reverseCredit, totalsFor } from '../src/services/credits';
import crmRoutes from '../src/routes/crm';
import crmQrRoutes from '../src/routes/crmQr';
import crmReportsRoutes from '../src/routes/crmReports';
import crmCollectionsRoutes from '../src/routes/crmCollections';
import crmLinksRoutes from '../src/routes/crmLinks';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use('/api/crm', crmRoutes);
app.use('/api/crm', crmQrRoutes);
app.use('/api/crm', crmReportsRoutes);
app.use('/api/crm', crmCollectionsRoutes);
app.use('/api/crm', crmLinksRoutes);

let base = '';
const ADMIN = '11111111-1111-1111-1111-111111111111';
const ANA = '22222222-2222-2222-2222-222222222222';
const BHAVIN = '33333333-3333-3333-3333-333333333333';

function req(method: string, path: string, as: { userId: string; role: string } | null, body?: unknown) {
  const raw = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const headers: Record<string, string | number> = {};
  if (as) headers.authorization = `Bearer ${generateToken({ userId: as.userId, email: 'x@t', role: as.role } as never)}`;
  if (raw) { headers['content-type'] = 'application/json'; headers['content-length'] = raw.length; }
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const r = http.request(`${base}${path}`, { method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: d ? JSON.parse(d) : {} }); }
        catch { resolve({ status: res.statusCode ?? 0, body: d }); }
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
  else { failures++; console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)); }
}

const today = new Date().toISOString().slice(0, 10);

async function seed() {
  await pool.query(
    `TRUNCATE collections, caller_credits, qr_payments, qr_shares, razorpay_qrs,
              lead_activities, lead_reminders, leads, crm_links, donations, people, users
     RESTART IDENTITY CASCADE`
  );
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role) VALUES
       ($1,'Admin','a@t','x','admin'),
       ($2,'Ana','ana@t','x','caller'),
       ($3,'Bhavin','bh@t','x','caller')`,
    [ADMIN, ANA, BHAVIN]
  );
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  await seed();

  const ana = { userId: ANA, role: 'caller' };
  const bhavin = { userId: BHAVIN, role: 'caller' };
  const admin = { userId: ADMIN, role: 'admin' };

  console.log('\n1. a credit is written once and only once');
  const lead = await pool.query(
    `INSERT INTO leads (phone, name, assigned_to) VALUES ('9800000001','Ramesh',$1::uuid) RETURNING id`,
    [ANA]
  );
  const first = await recordCredit({
    userId: ANA, amount: 5000, kind: 'qr', occurredAt: new Date(), leadId: lead.rows[0].id, note: 'first',
  });
  const second = await recordCredit({
    userId: BHAVIN, amount: 5000, kind: 'qr', occurredAt: new Date(), leadId: lead.rows[0].id, note: 'second',
  });
  check('the first credit lands', !!first, first);
  // The database decides this, not the handler. Two people can press claim in
  // the same second and a check-then-insert loses that race by construction.
  check('a second credit on the same lead is refused', second === null, second);

  let t = await totalsFor(ANA, today, today);
  check("Ana's total is 5,000", t.raised === 5000, t);
  t = await totalsFor(BHAVIN, today, today);
  check('Bhavin has nothing', t.raised === 0, t);

  console.log('\n2. reassigning the lead does not move the money');
  await pool.query(`UPDATE leads SET assigned_to = $1::uuid WHERE id = $2::uuid`, [BHAVIN, lead.rows[0].id]);
  t = await totalsFor(ANA, today, today);
  check('Ana keeps what she raised', t.raised === 5000, t);
  t = await totalsFor(BHAVIN, today, today);
  check('Bhavin does not inherit it', t.raised === 0, t);

  console.log('\n3. a reversal frees the money for the right person');
  const ok = await reverseCredit(first!.id, ADMIN, 'Credited to the wrong caller');
  check('the credit reverses', ok);
  t = await totalsFor(ANA, today, today);
  check("Ana's total drops to zero", t.raised === 0, t);
  const redone = await recordCredit({
    userId: BHAVIN, amount: 5000, kind: 'qr', occurredAt: new Date(), leadId: lead.rows[0].id, note: 'corrected',
  });
  check('and it can now be credited to Bhavin', !!redone, redone);
  const audit = await pool.query(
    `SELECT status, reversed_reason FROM caller_credits WHERE id = $1`, [first!.id]
  );
  // Reversed, not deleted: the record of a claim that turned out to be wrong
  // is exactly what you want when two people disagree about a figure.
  check('the reversed row is still there, with its reason', audit.rows[0].status === 'reversed'
    && /wrong caller/.test(audit.rows[0].reversed_reason), audit.rows[0]);

  console.log('\n4. a caller claims a QR payment nobody could match');
  const qr = await pool.query(
    `INSERT INTO razorpay_qrs (qr_id, label, receipt_site, created_by)
     VALUES ('qr_CRED01','Gaushala','hkmv',$1::uuid) RETURNING id`, [ADMIN]
  );
  const pay = await pool.query(
    `INSERT INTO qr_payments (payment_id, qr_id, amount, status, received_at)
     VALUES ('pay_CRED01','qr_CRED01', 1100, 'captured', NOW()) RETURNING id`
  );
  let r = await req('POST', `/api/crm/qr/payments/${pay.rows[0].id}/claim`, ana, {});
  check('the claim is accepted', r.status === 200 && r.body.claimed, r.body);
  t = await totalsFor(ANA, today, today);
  check("it reaches Ana's total", t.raised === 1100, t);

  console.log('\n5. and nobody else can claim it afterwards');
  r = await req('POST', `/api/crm/qr/payments/${pay.rows[0].id}/claim`, bhavin, {});
  check('a second claim is refused', r.status === 409, r.status);
  check('and the message names who has it', /Ana/.test(String(r.body.error)), r.body.error);

  console.log('\n6. an admin can take a claim back off somebody');
  r = await req('DELETE', `/api/crm/qr/payments/${pay.rows[0].id}/claim`, admin, { reason: 'Was not hers' });
  check('the reversal is accepted', r.status === 200, r.body);
  t = await totalsFor(ANA, today, today);
  check("Ana's total goes back down", t.raised === 0, t);
  r = await req('DELETE', `/api/crm/qr/payments/${pay.rows[0].id}/claim`, ana, { reason: 'mine now' });
  check('a caller cannot reverse one', r.status === 403, r.status);

  console.log('\n7. money collected by hand is counted, and marked as unchecked');
  r = await req('POST', '/api/crm/collections', ana, {
    amount: 2500, donor_name: 'Sita Devi', donor_phone: '9876543210',
    method: 'upi', reference: 'UTR998877', sevak_name: 'For my father',
  });
  check('it is recorded', r.status === 201, r.body);
  const creditId = r.body.credit_id;
  t = await totalsFor(ANA, today, today);
  check('it counts towards the total', t.raised === 2500, t);
  // Every other credit records something a machine observed. This one records
  // something a person said, and a system that shows both identically is
  // lying by omission the first time a figure is questioned.
  check('but it is not verified', t.verified === 0 && t.awaiting_verification === 2500, t);

  console.log('\n8. the reference is required before a receipt can be raised');
  const noRef = await req('POST', '/api/crm/collections', ana, {
    amount: 300, donor_name: 'Anon', donor_phone: '9876500000', method: 'cash',
  });
  r = await req('POST', `/api/crm/collections/${noRef.body.credit_id}/receipt`, ana, { site: 'hkmv' });
  // Without it nobody can find the money on a statement, and nothing stops a
  // second press minting a second 80G number for the same donation.
  check('a receipt with no reference is refused', r.status === 400, { status: r.status, body: r.body });
  check('and the refusal says why', /reference|UTR/i.test(String(r.body.error)), r.body.error);

  console.log('\n9. only a second pair of eyes can tick money off');
  r = await req('POST', `/api/crm/collections/${creditId}/verify`, ana, {});
  check('the caller cannot verify their own', r.status === 403, r.status);
  r = await req('POST', `/api/crm/collections/${creditId}/verify`, admin, {});
  check('an admin can', r.status === 200, r.body);
  t = await totalsFor(ANA, today, today);
  check('and it moves from awaiting to confirmed',
    t.verified === 2500 && t.awaiting_verification === 300, t);

  console.log('\n10. a caller only ever sees their own');
  r = await req('GET', '/api/crm/collections', bhavin);
  check("Bhavin sees none of Ana's", (r.body.collections ?? []).length === 0, r.body.total);
  r = await req('GET', '/api/crm/collections', admin);
  check('an admin sees both', (r.body.collections ?? []).length === 2, r.body.total);

  console.log('\n11. a caller cannot record money as somebody else');
  const bhavinBefore = (await totalsFor(BHAVIN, today, today)).raised;
  const anaBefore = (await totalsFor(ANA, today, today)).raised;
  r = await req('POST', '/api/crm/collections', ana, {
    amount: 9999, donor_name: 'X', donor_phone: '9000000000', user_id: BHAVIN,
  });
  check('it is recorded', r.status === 201, r.body);
  // A leaderboard somebody can write entries into is not a leaderboard, so a
  // caller naming a colleague in the body must be ignored rather than obeyed.
  check('Bhavin did not gain the 9,999',
    (await totalsFor(BHAVIN, today, today)).raised === bhavinBefore, bhavinBefore);
  check('Ana did, because she is the one who recorded it',
    (await totalsFor(ANA, today, today)).raised === anaBefore + 9999, { anaBefore });

  console.log('\n12. a link assigned to a caller credits them, and keeps its token');
  const link = await pool.query(
    `INSERT INTO crm_links (label, url, site, created_by) VALUES ('Gaushala page','https://harekrishnavizag.org/donate','hkmv',$1::uuid) RETURNING id`,
    [ADMIN]
  );
  r = await req('PUT', `/api/crm/links/${link.rows[0].id}/credit`, ana, { user_id: ANA });
  check('a caller cannot assign credit', r.status === 403, r.status);
  r = await req('PUT', `/api/crm/links/${link.rows[0].id}/credit`, admin, { user_id: ANA });
  check('an admin can', r.status === 200, r.body);
  const token1 = (await pool.query(`SELECT credit_token FROM crm_links WHERE id = $1`, [link.rows[0].id]))
    .rows[0].credit_token;
  check('a token is minted', !!token1, token1);
  await req('PUT', `/api/crm/links/${link.rows[0].id}/credit`, admin, { user_id: BHAVIN });
  const token2 = (await pool.query(`SELECT credit_token FROM crm_links WHERE id = $1`, [link.rows[0].id]))
    .rows[0].credit_token;
  // Reissuing it would orphan every link already sitting in a donor's
  // WhatsApp history, which is where most of them live.
  check('reassigning keeps the same token', token1 === token2, { token1, token2 });

  console.log('\n13. the reports read the ledger, and a caller sees only their own');
  r = await req('GET', '/api/crm/dashboard?preset=today', ana);
  check('the dashboard answers', r.status === 200, r.body?.error);
  const anaTotal = (await totalsFor(ANA, today, today)).raised;
  const teamTotal = (await totalsFor(null, today, today)).raised;
  check("it shows Ana's own money and nobody else's",
    Number(r.body.money?.raised) === anaTotal && anaTotal < teamTotal, { shown: r.body.money?.raised, anaTotal, teamTotal });
  check('all of it recorded as collected by hand',
    Number(r.body.money?.by_kind?.offline) === anaTotal, r.body.money?.by_kind);
  check('and the confirmed part is named separately',
    Number(r.body.money?.verified) === 2500, r.body.money);
  r = await req('GET', '/api/crm/dashboard?preset=today', admin);
  check('an admin sees the whole team', Number(r.body.money?.raised) === teamTotal, r.body.money);
  check("including Bhavin's QR money, which Ana's view did not show",
    Number(r.body.money?.by_kind?.qr) === 5000, r.body.money?.by_kind);

  console.log('\n14. the credits list is scoped the same way');
  r = await req('GET', '/api/crm/reports/credits?preset=today', ana);
  check('a caller may read it', r.status === 200, r.body?.error);
  check('and sees only their own rows',
    (r.body.credits ?? []).every((c: any) => c.user_id === ANA), (r.body.credits ?? []).map((c: any) => c.caller_name));
  r = await req('GET', `/api/crm/reports/credits?preset=today&user_id=${BHAVIN}`, ana);
  // Editing the URL must not be a way round the scoping on the screen.
  check('and cannot ask for a colleague by URL',
    (r.body.credits ?? []).every((c: any) => c.user_id === ANA), r.body.credits?.length);

  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall green\n');
  server.close();
  await pool.end();
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
