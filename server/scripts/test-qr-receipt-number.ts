// A QR payment's receipt number is kept, and shown on Money raised.
//
// THE GAP
// Money raised showed a blank "Receipt No." for 74 of 76 QR credits although the QR
// payment had its number stored: the page read the number from the DONATION only.
// And two payments kept no number at all - the site said "this already exists" for a
// website gift the donor had started at checkout, and no number came back with the
// refusal. A number that arrives LATER, once the site allocates it, was never copied
// back to the payment either.
//
//   NODE_ENV=development DATABASE_URL=...drm_test npx tsx scripts/test-qr-receipt-number.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import { runMigrations } from '../src/db/migrate';
import { recordCredit } from '../src/services/credits';
import { adoptReceiptNumber } from '../src/services/qrReceiptNumber';
import { upsertDonorSnapshot } from '../src/services/hkmvSync';
import crmQrRoutes from '../src/routes/crmQr';
import crmReportsRoutes from '../src/routes/crmReports';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use('/api/crm', crmReportsRoutes);
app.use('/api/crm', crmQrRoutes);
let base = '';
const ADMIN = '11111111-1111-1111-1111-111111111111';
const token = generateToken({ userId: ADMIN, email: 'a@t', role: 'admin' } as never);

function call(method: string, path: string, body?: unknown) {
  return new Promise<any>((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const u = new URL(`${base}${path}`);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ ...JSON.parse(d || '{}'), http: res.statusCode }));
      }
    );
    r.on('error', reject);
    r.end(data);
  });
}

let failures = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}`, ok ? '' : JSON.stringify(d)?.slice(0, 400));
  if (!ok) failures++;
};

let seq = 0;
async function payment(o: {
  status?: string | null; number?: string | null; ext?: string | null; site?: string; amount?: number; ref?: string;
}) {
  seq++;
  const r = await pool.query(
    `INSERT INTO qr_payments (payment_id, amount, status, received_at, receipt_status, receipt_site, external_donation_id, receipt_number)
     VALUES ($1,$2,'captured',NOW(),$3,$4,$5,$6) RETURNING id`,
    [o.ref ?? `pay_N${seq}`, o.amount ?? 500, o.status === undefined ? 'issued' : o.status, o.site ?? 'hkmv', o.ext ?? null, o.number ?? null]
  );
  return r.rows[0].id as string;
}
async function donation(o: { ref: string; number?: string | null; payRef?: string | null; amount?: number; site?: string }) {
  const p = await pool.query(`INSERT INTO people (name, phone) VALUES ('Donor', $1) RETURNING id`, [`98400${String(++seq).padStart(5, '0')}`]);
  const d = await pool.query(
    `INSERT INTO donations (person_id, amount, payment_mode, external_ref, payment_ref, source_site, receipt_number)
     VALUES ($1,$2,'upi',$3,$4,$5,$6) RETURNING id`,
    [p.rows[0].id, o.amount ?? 500, o.ref, o.payRef ?? null, o.site ?? 'hkmv', o.number === undefined ? 'HKMI|N|1' : o.number]
  );
  return d.rows[0].id as string;
}
const numberOf = async (id: string) =>
  (await pool.query(`SELECT receipt_number, external_donation_id FROM qr_payments WHERE id = $1`, [id])).rows[0] as { receipt_number: string | null; external_donation_id: string | null };

async function main() {
  await pool.query(`TRUNCATE caller_credits, qr_payments, donations, person_names, people, users RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO users (id, name, email, password_hash, role) VALUES ($1,'Admin','a@t','x','admin')`, [ADMIN]);
  check('the migration applies', (await runMigrations()).ok, true);

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;

  console.log('\n--- Money raised shows the number stored on the QR payment ---');
  const shown = await payment({ number: 'HKMI|2026|D/VSP|777', ext: 'EXT-777' });
  const none = await payment({ status: 'issued', number: null, ext: null });
  await recordCredit({ userId: ADMIN, amount: 500, kind: 'qr', occurredAt: new Date().toISOString(), qrPaymentId: shown, createdBy: ADMIN });
  await recordCredit({ userId: ADMIN, amount: 500, kind: 'qr', occurredAt: new Date().toISOString(), qrPaymentId: none, createdBy: ADMIN });
  const list = await call('GET', '/api/crm/reports/credits?period=all&limit=50');
  const rows: any[] = list.credits ?? [];
  check('the page lists both credits', rows.length === 2, { n: rows.length, http: list.http });
  check('the one whose payment has a number shows it', rows.some((r) => r.receipt_number === 'HKMI|2026|D/VSP|777'), rows.map((r) => r.receipt_number));
  check('the one with no number anywhere is blank, not wrong', rows.some((r) => r.receipt_number === null));

  console.log('\n--- a number is copied to the payment once it is known ---');
  const byId = await payment({ ext: 'EXT-A' });
  await donation({ ref: 'EXT-A', number: 'HKMI|A|1' });
  check('tied by the site\'s donation id: filled', (await adoptReceiptNumber(pool, { paymentId: byId })) === 1 && (await numberOf(byId)).receipt_number === 'HKMI|A|1');

  const byRef = await payment({ ref: 'pay_REF1', amount: 1100 });
  await donation({ ref: 'EXT-B', number: 'HKMI|B|2', payRef: 'pay_REF1', amount: 1100 });
  const filled = await adoptReceiptNumber(pool, { paymentId: byRef });
  const nb = await numberOf(byRef);
  check('no id stored (the "already exists" case): tied by reference, amount and site', filled === 1 && nb.receipt_number === 'HKMI|B|2', nb);
  check('...and the site\'s donation id is kept too, so Send again can find it', nb.external_donation_id === 'EXT-B', nb);

  console.log('\n--- what must NOT be filled ---');
  const has = await payment({ number: 'KEEP-ME', ext: 'EXT-C' });
  await donation({ ref: 'EXT-C', number: 'OTHER' });
  await adoptReceiptNumber(pool, { paymentId: has });
  check('a number already on the payment is never replaced', (await numberOf(has)).receipt_number === 'KEEP-ME');

  const diffAmt = await payment({ ref: 'pay_REF2', amount: 500 });
  await donation({ ref: 'EXT-D', number: 'HKMI|D|4', payRef: 'pay_REF2', amount: 700 });
  await adoptReceiptNumber(pool, { paymentId: diffAmt });
  check('same reference but a different amount: not filled', (await numberOf(diffAmt)).receipt_number === null);

  const otherSite = await payment({ ref: 'pay_REF3', site: 'hkmv' });
  await donation({ ref: 'EXT-E', number: 'ANN|E|5', payRef: 'pay_REF3', site: 'annadan' });
  await adoptReceiptNumber(pool, { paymentId: otherSite });
  check('same reference but another site: not filled', (await numberOf(otherSite)).receipt_number === null);

  const notIssued = await payment({ status: null, ext: 'EXT-F' });
  await donation({ ref: 'EXT-F', number: 'HKMI|F|6' });
  await adoptReceiptNumber(pool, { paymentId: notIssued });
  check('a payment that has no receipt yet: not filled', (await numberOf(notIssued)).receipt_number === null);

  const noNumberYet = await payment({ ext: 'EXT-G' });
  await donation({ ref: 'EXT-G', number: null });
  await adoptReceiptNumber(pool, { paymentId: noNumberYet });
  check('a donation the site has not numbered yet: nothing to copy', (await numberOf(noNumberYet)).receipt_number === null);

  console.log('\n--- the number arrives later, through the site\'s own sync ---');
  const later = await payment({ ext: 'EXT-LATE', number: null });
  await upsertDonorSnapshot({
    donor: { name: 'Giridhar', mobile: '9876500077', donorSince: '2024-01-01T00:00:00.000Z' },
    donations: [{
      externalId: 'EXT-LATE', amount: 500, type: 'Annadan', status: 'completed', createdAt: new Date().toISOString(),
      isRecurring: false, receiptNumber: 'HKMI|2026|D/VSP|LATE', receiptIssuedAt: new Date().toISOString(),
      paymentRef: 'UTRLATE', paymentMode: 'upi', offline: true,
    }],
  } as never, 'hkmv');
  check('the payment picks it up the moment the donation arrives', (await numberOf(later)).receipt_number === 'HKMI|2026|D/VSP|LATE', await numberOf(later));

  console.log('\n--- where the receipt went, and sending it again ---');
  const sendTo = await payment({ status: null });
  const sent = await call('POST', `/api/crm/qr/payments/${sendTo}/receipt`, {
    donor_name: 'Keep Me', donor_phone: '98111 00001', site: 'hkmv',
  });
  check('the answer says which number it went to', sent.sent_to === '9811100001', { sent_to: sent.sent_to, http: sent.http });

  const issued = await payment({ ext: 'EXT-RESEND', number: 'HKMI|R|9', site: 'hkmv' });
  const again = await call('POST', `/api/crm/qr/payments/${issued}/resend-receipt`, {});
  // A test database never reaches a live site (hkmvClient blockedFromTests), so the
  // honest outcome here is "not connected" - an error, not a send.
  check('send again asks the site, and in a test that is refused cleanly, not sent', again.http === 502 && /not connected/i.test(String(again.error)), { http: again.http, error: again.error });
  const noReceipt = await payment({ status: null });
  const refused = await call('POST', `/api/crm/qr/payments/${noReceipt}/resend-receipt`, {});
  check('send again with no receipt yet: refused with a reason', refused.http === 400, refused);
  const missing = await call('POST', `/api/crm/qr/payments/00000000-0000-0000-0000-000000000000/resend-receipt`, {});
  check('a payment that does not exist: 404', missing.http === 404, missing.http);

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
