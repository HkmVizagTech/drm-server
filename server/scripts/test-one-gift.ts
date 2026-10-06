// One gift, counted once.
//
// The question this answers: "on the call we click Donated now and enter the
// money, then I link the QR / PhonePe payment to the same person - what
// happens? No additional or duplicate money should be shown."
//
//   DATABASE_URL=postgresql://localhost/drm_test npx tsx scripts/test-one-gift.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import crmRoutes from '../src/routes/crm';
import crmCallsRoutes from '../src/routes/crmCalls';
import crmQrRoutes from '../src/routes/crmQr';
import crmCollectionsRoutes from '../src/routes/crmCollections';

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
app.use('/api/crm', crmCollectionsRoutes);

let base = '';
const ADMIN = '11111111-1111-1111-1111-111111111111';
const ANA = '22222222-2222-2222-2222-222222222222';
const admin = { userId: ADMIN, role: 'admin' };
const ana = { userId: ANA, role: 'caller' };

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
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600));
  }
}

let n = 0;
async function payment(amount: number, phone?: string) {
  n++;
  return (
    await pool.query(
      `INSERT INTO qr_payments (payment_id, qr_id, amount, status, payer_name, payer_phone, received_at)
       VALUES ($1, 'qr_temple', $2, 'captured', 'donor@upi', $3, NOW() - INTERVAL '5 minutes') RETURNING id`,
      [`pay_G${n}`, amount, phone ?? null]
    )
  ).rows[0].id as string;
}
let ph = 0;
async function lead(name: string) {
  ph++;
  const phone = `98222${String(ph).padStart(5, '0')}`;
  const id = (
    await pool.query(`INSERT INTO leads (phone, name, assigned_to) VALUES ($1, $2, $3) RETURNING id`, [phone, name, ANA])
  ).rows[0].id as string;
  return { id, phone };
}
const amountOf = async (id: string) =>
  Number((await pool.query(`SELECT converted_amount FROM leads WHERE id = $1`, [id])).rows[0].converted_amount);
/** What Ana's total is made of: every active credit, as numbers. */
const anaCredits = async () =>
  (await pool.query(`SELECT amount, kind FROM caller_credits WHERE user_id = $1 AND status = 'active' ORDER BY created_at`, [ANA])).rows.map(
    (r) => `${r.kind}:${Number(r.amount)}`
  );
const anaTotal = async () =>
  Number((await pool.query(`SELECT COALESCE(SUM(amount),0) AS s FROM caller_credits WHERE user_id = $1 AND status = 'active'`, [ANA])).rows[0].s);
const wipeCredits = () => pool.query(`UPDATE caller_credits SET status = 'reversed' WHERE status = 'active'`);

async function seed() {
  await pool.query(
    `TRUNCATE caller_credits, collections, qr_payments, qr_shares, razorpay_qrs, lead_activities, lead_reminders, leads,
              donations, people, users RESTART IDENTITY CASCADE`
  );
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role) VALUES ($1,'Admin','a@t','x','admin'), ($2,'Ana','ana@t','x','caller')`,
    [ADMIN, ANA]
  );
  await pool.query(`INSERT INTO razorpay_qrs (qr_id, label) VALUES ('qr_temple','Temple QR')`);
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  await seed();

  console.log('\n1. "Donated now ₹1,000" on the call, then the ₹1,000 QR linked to the lead');
  const a = await lead('Asha');
  let r = await req('POST', `/api/crm/leads/${a.id}/call`, ana, { disposition: 'donated', donated_amount: 1000 });
  check('the call is saved', r.status === 200 || r.status === 201, r.body);
  check('the lead reads ₹1,000', (await amountOf(a.id)) === 1000);
  const p1 = await payment(1000);
  r = await req('POST', `/api/crm/qr/payments/${p1}/link`, ana, { kind: 'lead', id: a.id });
  check('linking works and says it was the same gift', r.status === 200 && r.body.replaced_said === 1000, r.body);
  check('the lead still reads ₹1,000, not ₹2,000', (await amountOf(a.id)) === 1000, await amountOf(a.id));
  check("Ana's total counts it once", (await anaTotal()) === 1000, await anaCredits());

  console.log('\n2. the donor paid a little more than was said');
  await wipeCredits();
  const b = await lead('Bala');
  await req('POST', `/api/crm/leads/${b.id}/call`, ana, { disposition: 'donated', donated_amount: 1000 });
  const p2 = await payment(1116);
  r = await req('POST', `/api/crm/qr/payments/${p2}/link`, ana, { kind: 'lead', id: b.id });
  check('the lead takes the real amount', (await amountOf(b.id)) === 1116, await amountOf(b.id));
  check('counted once, at the real amount', (await anaTotal()) === 1116, await anaCredits());

  console.log('\n3. "Donated" on the lead page (which credits Ana), then the QR linked by number');
  await wipeCredits();
  const c = await lead('Chitra');
  r = await req('POST', `/api/crm/leads/${c.id}/donated`, ana, { amount: 2000 });
  check('the word is recorded and counted', r.status === 200 && (await anaTotal()) === 2000, await anaCredits());
  const p3 = await payment(2000, c.phone);
  r = await req('POST', `/api/crm/qr/payments/${p3}/link`, ana, { kind: 'new', name: 'Chitra', phone: c.phone });
  check('a number that is a lead is linked as the lead', r.status === 200 && r.body.kind === 'lead', r.body);
  check('the lead reads ₹2,000', (await amountOf(c.id)) === 2000, await amountOf(c.id));
  check('one credit, the QR one, ₹2,000', JSON.stringify(await anaCredits()) === JSON.stringify(['qr:2000']), await anaCredits());
  const lp = (await pool.query(`SELECT lead_id FROM qr_payments WHERE id = $1`, [p3])).rows[0];
  check('the payment shows the lead', lp.lead_id === c.id, lp);

  console.log('\n4. unlinking puts the word back');
  r = await req('POST', `/api/crm/qr/payments/${p3}/unlink`, ana, {});
  check('unlinked', r.status === 200, r.body);
  check('the lead reads ₹2,000 again', (await amountOf(c.id)) === 2000);
  check('and the lead-page credit counts again', JSON.stringify(await anaCredits()) === JSON.stringify(['lead:2000']), await anaCredits());

  console.log('\n5. "Donated now", then the PhonePe entry for the same donor');
  await wipeCredits();
  const d = await lead('Devi');
  await req('POST', `/api/crm/leads/${d.id}/call`, ana, { disposition: 'donated', donated_amount: 5000 });
  r = await req('POST', '/api/crm/collections', ana, { amount: 5000, donor_name: 'Devi', donor_phone: d.phone, reference: '431800000001' });
  check('saved, and landed on the lead', r.status === 201 && r.body.lead?.id === d.id && r.body.lead.replaced_said === 5000, r.body);
  check('the lead reads ₹5,000', (await amountOf(d.id)) === 5000, await amountOf(d.id));
  check('counted once', JSON.stringify(await anaCredits()) === JSON.stringify(['offline:5000']), await anaCredits());
  const credId = r.body.credit_id;

  console.log('\n6. lead-page "Donated" then PhonePe: the entry replaces the word');
  await wipeCredits();
  const e = await lead('Eswar');
  await req('POST', `/api/crm/leads/${e.id}/donated`, ana, { amount: 3000 });
  r = await req('POST', '/api/crm/collections', ana, { amount: 3000, donor_name: 'Eswar', donor_phone: e.phone, reference: '431800000002' });
  check('saved (not refused as "already added")', r.status === 201, r.body);
  check('one credit, the PhonePe one', JSON.stringify(await anaCredits()) === JSON.stringify(['offline:3000']), await anaCredits());
  r = await req('DELETE', `/api/crm/collections/${r.body.credit_id}`, admin, { reason: 'not in statement' });
  check('removing the entry brings the word back', r.status === 200 && JSON.stringify(await anaCredits()) === JSON.stringify(['lead:3000']), await anaCredits());
  check('and the lead is as it was', (await amountOf(e.id)) === 3000);
  void credId;

  console.log('\n7. the money first, then "Donated" pressed on the lead page');
  await wipeCredits();
  const f = await lead('Ganga');
  const p7 = await payment(1500);
  await req('POST', `/api/crm/qr/payments/${p7}/link`, ana, { kind: 'lead', id: f.id });
  r = await req('POST', `/api/crm/leads/${f.id}/donated`, ana, { amount: 1500 });
  check('refused: already counted from their payment', r.status === 409, r.body);
  check('still one ₹1,500', (await anaTotal()) === 1500 && (await amountOf(f.id)) === 1500, await anaCredits());
  r = await req('POST', `/api/crm/leads/${f.id}/call`, ana, { disposition: 'donated', donated_amount: 1500 });
  check('"Donated now" on a later call changes nothing', (await amountOf(f.id)) === 1500 && (await anaTotal()) === 1500, await anaCredits());

  console.log('\n8. a real second gift still counts');
  const p8 = await payment(500);
  r = await req('POST', `/api/crm/qr/payments/${p8}/link`, ana, { kind: 'lead', id: f.id });
  check('linked', r.status === 200 && !r.body.replaced_said, r.body);
  check('the lead reads both gifts', (await amountOf(f.id)) === 2000, await amountOf(f.id));
  check('and Ana is credited both', (await anaTotal()) === 2000, await anaCredits());

  console.log('\n9. "Add to my total" on a payment whose lead was counted on the caller\'s word');
  await wipeCredits();
  const g = await lead('Hari');
  await req('POST', `/api/crm/leads/${g.id}/donated`, ana, { amount: 800 });
  const p9 = await payment(800);
  // As an older link left it: on the lead, with no credit of its own.
  await pool.query(`UPDATE qr_payments SET lead_id = $2 WHERE id = $1`, [p9, g.id]);
  r = await req('POST', `/api/crm/qr/payments/${p9}/claim`, ana, {});
  check('claimed', r.status === 200, r.body);
  check('the payment replaces the word, not adds to it', JSON.stringify(await anaCredits()) === JSON.stringify(['qr:800']), await anaCredits());

  console.log('\n10. a QR sent on the call, "Donated now", then the send is matched');
  await wipeCredits();
  const h = await lead('Indira');
  const qrUuid = (await pool.query(`SELECT id FROM razorpay_qrs WHERE qr_id = 'qr_temple'`)).rows[0].id;
  const share = (
    await pool.query(
      `INSERT INTO qr_shares (qr_id, phone, shared_by, channel, lead_id) VALUES ($1, $2, $3, 'whatsapp', $4) RETURNING id`,
      [qrUuid, h.phone, ANA, h.id]
    )
  ).rows[0].id;
  await req('POST', `/api/crm/leads/${h.id}/call`, ana, { disposition: 'donated', donated_amount: 2500 });
  const p10 = await payment(2500);
  r = await req('POST', `/api/crm/qr/payments/${p10}/link`, ana, { kind: 'share', id: share });
  check('matched', r.status === 200, r.body);
  check('the lead reads ₹2,500, not ₹5,000', (await amountOf(h.id)) === 2500, await amountOf(h.id));
  check('counted once', (await anaTotal()) === 2500, await anaCredits());

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
