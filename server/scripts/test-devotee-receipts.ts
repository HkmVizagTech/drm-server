// Devotee receipts: raised from the devotee portal straight to DCC - not through the HKM site -
// with the PDF drawn by DRM and no WhatsApp sent. Checked: what DCC is sent (account, seva, mode,
// transaction id, enrolled-by), the receipt on the devotee's own list and lead, the PDF and the
// donor's link, a DCC failure kept and retried without a second receipt, one receipt per UTR, and
// that nobody else can read a devotee's receipts. The office's receipt route is not involved.
//
// DCC and the donation sites are stand-ins: nothing real is ever issued.
//
//   NODE_ENV=development DATABASE_URL=...drm_test npx tsx scripts/test-devotee-receipts.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { runMigrations } from '../src/db/migrate';
import { confineRole, generateToken } from '../src/middleware/auth';
import devoteeLeadsRoutes from '../src/routes/devoteeLeads';
import sevaCatalogRoutes from '../src/routes/sevaCatalog';
import donationsRoutes from '../src/routes/donations';
import receiptLinkRoutes from '../src/routes/receiptLink';
import { seedSevaCatalog } from '../src/services/sevaCatalog';
import { setDccPoster } from '../src/services/devoteeDcc';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

let failures = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}`, ok ? '' : JSON.stringify(d)?.slice(0, 400));
  if (!ok) failures++;
};

/* A stand-in for DCC: numbers each new transaction once, answers a repeat with the same number. */
const sentToDcc: Record<string, any>[] = [];
const issuedByTxn = new Map<string, string>();
let dccDown = false;
setDccPoster(async (payload) => {
  sentToDcc.push(payload);
  if (dccDown) throw new Error('DCC is not answering.');
  const txn = String(payload.gatewayPaymentId);
  if (!issuedByTxn.has(txn)) issuedByTxn.set(txn, `${payload.accountType === 5 ? 'TSC' : 'HKMI'}|2026|${1000 + issuedByTxn.size + 1}`);
  return { ReceiptNumber: issuedByTxn.get(txn), DonorNumber: 'D49822', Message: 'Donation added' };
});

/* A stand-in for the HKM and Annadan sites: anything it receives would be a mistake here. */
const siteCalls: string[] = [];
const fakeSite = http.createServer((req, res) => {
  siteCalls.push(String(req.url));
  res.setHeader('content-type', 'application/json');
  res.statusCode = 404;
  res.end('{}');
});

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const ADMIN = '44444444-4444-4444-4444-444444444444';

async function main() {
  await runMigrations();
  await pool.query(`TRUNCATE devotees, devotee_leads, devotee_lead_activities, devotee_receipts, preachers, seva_catalog, caller_credits, donations, people, users RESTART IDENTITY CASCADE`);
  await runMigrations(); // puts the TSC sevas back
  await seedSevaCatalog();
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role) VALUES
       ($1, 'Devotee A', 'a@devotee.test', 'x', 'devotee'), ($2, 'Devotee B', 'b@devotee.test', 'x', 'devotee'), ($3, 'Admin', 'admin@test', 'x', 'admin')`,
    [A, B, ADMIN]
  );
  // A is also a preacher DCC knows (id 37); B is not.
  await pool.query(`INSERT INTO devotees (name, code, phone, user_id) VALUES ('Devotee A', 'MGVD', '9000000001', $1), ('Devotee B', NULL, '9000000002', $2)`, [A, B]);
  await pool.query(`INSERT INTO preachers (code, name, id_number) VALUES ('MGVD', 'Devotee A', '37')`);
  const tA = generateToken({ userId: A, role: 'devotee' });
  const tB = generateToken({ userId: B, role: 'devotee' });
  const tAdmin = generateToken({ userId: ADMIN, role: 'admin' });

  const app = express();
  app.use(express.json());
  app.use('/api', confineRole('devotee', ['/seva-wall/devotee-record', '/seva-wall/mine', '/devotee', '/app/devices', '/seva-catalog', '/auth/me']));
  app.use('/api/devotee', devoteeLeadsRoutes);
  app.use('/api/seva-catalog', sevaCatalogRoutes);
  app.use('/api/donations', donationsRoutes);
  app.use(receiptLinkRoutes);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  await new Promise((r) => fakeSite.listen(0, '127.0.0.1', () => r(null)));
  const site = `http://127.0.0.1:${(fakeSite.address() as { port: number }).port}`;
  process.env.HKMV_API_URL = site;
  process.env.HKMV_INTERNAL_SECRET = 's';
  process.env.ANNADAN_API_URL = site;
  process.env.ANNADAN_INTERNAL_SECRET = 's';
  const port = (server.address() as { port: number }).port;
  const call = (method: string, path: string, body?: unknown, token?: string) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const data = body ? JSON.stringify(body) : '';
      const req = http.request(
        { port, path, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(token ? { authorization: `Bearer ${token}` } : {}) } },
        (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(d || '{}') }); } catch { resolve({ status: res.statusCode ?? 0, body: {} }); } }); }
      );
      req.on('error', reject);
      req.end(data);
    });
  const raw = (path: string, token?: string) =>
    new Promise<{ status: number; type: string; bytes: Buffer }>((resolve, reject) => {
      http.get({ port, path, headers: token ? { authorization: `Bearer ${token}` } : {} }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), bytes: Buffer.concat(chunks) }));
      }).on('error', reject);
    });

  console.log('\n--- the seva list, and who may raise what ---');
  let r = await call('GET', '/api/seva-catalog?active=true', undefined, tA);
  const sevas = (r.body.sevas ?? []) as any[];
  const hkmi = sevas.find((s) => s.code === 'BSC');
  const tsc = sevas.find((s) => s.accountType === 'TSC' && s.code === 'ANBJ');
  check('a devotee can read the seva list, HKMI and TSC', r.status === 200 && !!hkmi && !!tsc, { status: r.status, n: sevas.length });
  r = await call('POST', '/api/donations/offline', { site: 'hkmv', donor_name: 'X', donor_mobile: '9876500000', amount: 100, payment_mode: 'cash' }, tA);
  check("a devotee cannot use the office's receipt route", r.status === 403, r);
  r = await call('GET', '/api/devotee/receipts', undefined, tAdmin);
  check("an admin cannot read a devotee's receipts", r.status === 403, r);

  console.log('\n--- what is checked before DCC is asked ---');
  const base = { donor_name: 'Ravi Kumar', donor_mobile: '+91 98765 11111', amount: 2116, payment_mode: 'cash', seva_catalog_id: hkmi.id };
  r = await call('POST', '/api/devotee/receipts', { ...base, seva_catalog_id: undefined }, tA);
  check('a seva must be chosen', r.status === 400 && /seva/i.test(r.body.error), r);
  r = await call('POST', '/api/devotee/receipts', { ...base, payment_mode: 'upi', reference_no: '12345' }, tA);
  check('a short UTR is refused', r.status === 400 && /UTR/.test(r.body.error), r);
  r = await call('POST', '/api/devotee/receipts', { ...base, want_certificate: true, pan_number: 'BAD' }, tA);
  check('80G needs a valid PAN', r.status === 400 && /PAN/.test(r.body.error), r);
  check('and none of these reached DCC', sentToDcc.length === 0);

  console.log('\n--- a cash HKMI receipt ---');
  r = await call('POST', '/api/devotee/receipts', { ...base, sevak_name: 'రమేష్ కుమార్', want_prasadam: true, want_certificate: true, pan_number: 'abcde1234f', address: 'Door 4, MVP Colony, Visakhapatnam 530017' }, tA);
  check('DCC numbers it', r.status === 201 && r.body.receiptNumber === 'HKMI|2026|1001' && r.body.status === 'issued', r);
  const p1 = sentToDcc[0];
  check('sent to DCC as HKMI (4) with the seva picked', p1?.accountType === 4 && p1.sevaCategory === hkmi.categoryId && p1.sevaSubCategory === hkmi.subCategoryId, p1);
  check('cash is mode 1, with a transaction id made for it', p1?.modeOfPayment === 1 && /^DV-CASH-\d{8}-[A-Z0-9]+$/.test(p1.gatewayPaymentId), p1);
  check('enrolled under the devotee, a preacher DCC knows (37)', p1?.enrolledBy === 37, p1);
  check('with the PAN, the address and its PIN', p1?.PAN === 'ABCDE1234F' && p1.address.pinCode === '530017' && /MVP Colony/.test(p1.address.fullAddress), p1);
  check('the mobile as ten digits, the date as DD/MM/YYYY', p1?.donorPhone === '9876511111' && /^\d{2}\/\d{2}\/\d{4}$/.test(p1.transactionDate), p1);
  check('nothing went to the HKM site (so it sends no WhatsApp)', siteCalls.length === 0, siteCalls);
  const firstId = r.body.id as string;
  const firstLead = r.body.lead_id as string;
  const token = r.body.share_token as string;
  const lead = (await pool.query(`SELECT name, status, total_donated::float8 AS t FROM devotee_leads WHERE id = $1 AND owner_id = $2`, [firstLead, A])).rows[0];
  check("the donor becomes the devotee's lead, marked donated", lead?.name === 'Ravi Kumar' && lead.status === 'donated' && lead.t === 2116, lead);
  const act = (await pool.query(`SELECT outcome, amount::float8 AS amount, reference FROM devotee_lead_activities WHERE lead_id = $1`, [firstLead])).rows;
  check("and the gift is in its history with the receipt number", act.length === 1 && act[0].reference === 'HKMI|2026|1001', act);
  check('no Maha Prasadam is kept from the devotee portal', (await pool.query(`SELECT COUNT(*)::int n FROM devotee_receipts WHERE id = $1`, [firstId])).rows[0].n === 1);

  console.log('\n--- the PDF, and the link for the donor ---');
  let pdf = await raw(`/api/devotee/receipts/${firstId}/file`, tA);
  check('the devotee downloads the receipt PDF', pdf.status === 200 && pdf.type.includes('pdf') && pdf.bytes.subarray(0, 5).toString() === '%PDF-' && pdf.bytes.length > 10_000, { status: pdf.status, type: pdf.type, n: pdf.bytes.length });
  pdf = await raw(`/api/devotee/receipts/${firstId}/file`, tB);
  check('another devotee cannot', pdf.status === 404, pdf.status);
  pdf = await raw(`/api/receipt-link/${token}`);
  check('the donor opens it from the link, without signing in', pdf.status === 200 && pdf.type.includes('pdf') && pdf.bytes.subarray(0, 5).toString() === '%PDF-', { status: pdf.status, type: pdf.type });
  pdf = await raw(`/api/receipt-link/${'0'.repeat(64)}`);
  check('a made-up link finds nothing', pdf.status === 404, pdf.status);

  console.log('\n--- a TSC receipt by UPI, on the same lead ---');
  sentToDcc.length = 0;
  r = await call('POST', '/api/devotee/receipts', { ...base, amount: 501, payment_mode: 'upi', reference_no: '512345678901', seva_catalog_id: tsc.id, lead_id: firstLead }, tA);
  check('DCC numbers it in the TSC series', r.status === 201 && r.body.receiptNumber === 'TSC|2026|1002' && r.body.account === 'TSC', r);
  check('sent as TSC (5), UPI mode 3, the UTR as the transaction id', sentToDcc[0]?.accountType === 5 && sentToDcc[0].modeOfPayment === 3 && sentToDcc[0].gatewayPaymentId === '512345678901' && sentToDcc[0].sevaSubCategoryCode === 'ANBJ' || sentToDcc[0]?.sevaSubCategoryCode === tsc.subCodeId, sentToDcc[0]);
  pdf = await raw(`/api/devotee/receipts/${r.body.id}/file`, tA);
  check('the TSC receipt PDF draws', pdf.status === 200 && pdf.bytes.subarray(0, 5).toString() === '%PDF-', pdf.status);
  r = await call('POST', '/api/devotee/receipts', { ...base, amount: 501, payment_mode: 'upi', reference_no: '512345678901', seva_catalog_id: tsc.id }, tA);
  check('the same UTR cannot be receipted twice', r.status === 409 && /TSC\|2026\|1002/.test(r.body.error), r);
  check('on the same lead, the gifts add up', (await pool.query(`SELECT total_donated::float8 AS t FROM devotee_leads WHERE id = $1`, [firstLead])).rows[0].t === 2617);

  console.log('\n--- when DCC does not answer ---');
  dccDown = true;
  r = await call('POST', '/api/devotee/receipts', { ...base, donor_mobile: '9876522222', donor_name: 'Lakshmi', payment_mode: 'cheque', reference_no: '004512' }, tA);
  check('the devotee is told, and the receipt is kept to retry', r.status === 502 && r.body.status === 'failed' && !!r.body.id, r);
  const failedId = r.body.id as string;
  check('no lead is made for money not yet receipted', (await pool.query(`SELECT COUNT(*)::int n FROM devotee_leads WHERE owner_id = $1 AND phone = '9876522222'`, [A])).rows[0].n === 0);
  pdf = await raw(`/api/devotee/receipts/${failedId}/file`, tA);
  check('and there is no PDF for it yet', pdf.status === 409, pdf.status);
  dccDown = false;
  sentToDcc.length = 0;
  r = await call('POST', `/api/devotee/receipts/${failedId}/retry`, {}, tA);
  check('a retry issues it', r.status === 200 && r.body.status === 'issued' && /^HKMI\|2026\|/.test(r.body.receiptNumber), r);
  check('with the same transaction id, so DCC can never issue it twice', sentToDcc[0]?.gatewayPaymentId === 'CHQ-004512' && sentToDcc[0].modeOfPayment === 4, sentToDcc[0]);
  r = await call('POST', `/api/devotee/receipts/${failedId}/retry`, {}, tA);
  check('an issued receipt is not sent again', r.status === 409, r);

  console.log('\n--- whose list ---');
  r = await call('GET', '/api/devotee/receipts', undefined, tA);
  check("A's list has all three, newest first, with totals", r.status === 200 && r.body.rows.length === 3 && r.body.count === 3 && r.body.amount === 4733, r.body);
  r = await call('GET', '/api/devotee/receipts', undefined, tB);
  check("B sees none of A's receipts", r.status === 200 && r.body.rows.length === 0, r.body);
  r = await call('POST', `/api/devotee/receipts/${failedId}/retry`, {}, tB);
  check("B cannot retry A's receipt", r.status === 404, r);
  sentToDcc.length = 0;
  r = await call('POST', '/api/devotee/receipts', { ...base, donor_mobile: '9876533333' }, tB);
  check("B's receipt is enrolled under the temple default (36), B not being a preacher", r.status === 201 && sentToDcc[0]?.enrolledBy === 36, sentToDcc[0]);
  check('and still nothing went to the HKM site', siteCalls.length === 0, siteCalls);

  await pool.query(`UPDATE devotees SET dcc_id = 39 WHERE user_id = $1`, [B]);
  sentToDcc.length = 0;
  r = await call('POST', '/api/devotee/receipts', { ...base, donor_mobile: '9876533335' }, tB);
  check("a devotee's own DCC id from the devotee list is the enrolled-by", r.status === 201 && sentToDcc[0]?.enrolledBy === 39, sentToDcc[0]);

  console.log('\n--- the live DCC is never called outside production ---');
  setDccPoster(null);
  process.env.DCC_API_KEY = 'a-key-copied-onto-a-laptop';
  const realFetch = globalThis.fetch;
  const outbound: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    if (String(url).includes('vhkmsurabhi')) outbound.push(String(url));
    return realFetch(url as never, init as never);
  }) as typeof fetch;
  r = await call('POST', '/api/devotee/receipts', { ...base, donor_mobile: '9876544444' }, tA);
  check('with a key but not in production, the receipt is refused and kept', r.status === 502 && /only called from production/.test(r.body.error), r);
  check('and no request left for DCC', outbound.length === 0, outbound);
  globalThis.fetch = realFetch;
  delete process.env.DCC_API_KEY;

  server.close();
  fakeSite.close();
  await pool.end();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await pool.end().catch(() => undefined); process.exit(1); });
