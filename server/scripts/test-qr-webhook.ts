// Exercises the Razorpay webhook with the payload shapes Razorpay actually
// sends - each event on its own, never a synthetic combination of the two.
//
// WHY THIS FILE EXISTS
// The first version of the webhook accepted only events named payment.*, and
// then read the QR id out of payload.qr_code.entity.id - a field that appears
// ONLY on qr_code.credited, which that filter threw away. It passed a test
// because the test body carried both an event named payment.captured and a
// qr_code payload, which is a combination Razorpay never sends. Every case
// below is therefore one real event shape on its own.
//
// HOW TO RUN IT
//   createdb drm_test
//   DATABASE_URL=postgresql://localhost/drm_test npm run test:qr
//
// It TRUNCATEs the tables it uses, so it refuses to run against a database
// whose name does not end in _test.

import express from 'express';
import crypto from 'crypto';
import http from 'http';
import pool from '../src/db/pool';
import { webhookRouter } from '../src/routes/crmQr';

// The guard. This script wipes leads, users and payments; pointing it at the
// live database by pasting the wrong connection string would be a very quiet
// disaster, so the name has to say out loud that it is disposable.
const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(
    `Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}".\n` +
      'This script empties tables. Point it at a database whose name ends in _test.'
  );
  process.exit(1);
}

const SECRET = 'whsec_test';
process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;

const app = express();
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = Buffer.from(buf);
    },
  })
);
app.use('/api/razorpay', webhookRouter);

let base = '';

function post(body: unknown): Promise<{ status: number; body: any }> {
  const raw = Buffer.from(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base}/api/razorpay/webhook`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': raw.length,
          'x-razorpay-signature': sig,
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(d || '{}') }));
      }
    );
    req.on('error', reject);
    req.end(raw);
  });
}

/* ---- the two payload shapes, as Razorpay documents them ---- */

const paymentEntity = (o: Partial<Record<string, unknown>> = {}) => ({
  id: 'pay_TEST0001',
  entity: 'payment',
  amount: 500000,
  currency: 'INR',
  status: 'captured',
  order_id: null,
  invoice_id: null,
  method: 'upi',
  description: 'QRv2 Payment',
  vpa: 'donor@okhdfcbank',
  email: 'void@razorpay.com',
  contact: '+919000000001',
  notes: [],
  created_at: Math.floor(Date.now() / 1000),
  ...o,
});

/** payment.captured: no qr_code anywhere in the payload. This is the point. */
const paymentCaptured = (o = {}) => ({
  entity: 'event',
  event: 'payment.captured',
  contains: ['payment'],
  payload: { payment: { entity: paymentEntity(o) } },
});

/** qr_code.credited: the only delivery that names the QR. */
const qrCredited = (o = {}, qr = 'qr_TESTQR0001') => ({
  entity: 'event',
  event: 'qr_code.credited',
  contains: ['qr_code', 'payment'],
  payload: {
    qr_code: {
      entity: {
        id: qr,
        entity: 'qr_code',
        status: 'active',
        payments_amount_received: 500000,
      },
    },
    payment: { entity: paymentEntity(o) },
  },
});

/* ------------------------------------------------------------------ */

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

async function reset() {
  await pool.query(
    `TRUNCATE qr_payments, qr_shares, razorpay_qrs, lead_reminders, lead_activities, leads, users
     RESTART IDENTITY CASCADE`
  );
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role)
     VALUES ('11111111-1111-1111-1111-111111111111','Caller One','c1@test','x','caller')`
  );
  await pool.query(
    `INSERT INTO razorpay_qrs (id, qr_id, label, owner_id, receipt_site, active)
     VALUES ('22222222-2222-2222-2222-222222222222','qr_TESTQR0001','Caller One QR',
             '11111111-1111-1111-1111-111111111111',NULL,TRUE)`
  );
  await pool.query(
    `INSERT INTO leads (id, name, phone, status)
     VALUES ('33333333-3333-3333-3333-333333333333','Test Donor','9000000001','new')`
  );
}

/** A share, written `minutesAgo` minutes ago, to the given number. */
async function share(phone: string, expected: number | null, minutesAgo = 5) {
  const r = await pool.query(
    `INSERT INTO qr_shares (qr_id, lead_id, shared_by, phone, expected_amount, channel, created_at)
     VALUES ('22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333',
             '11111111-1111-1111-1111-111111111111',$1,$2::numeric,'whatsapp', NOW() - ($3 || ' minutes')::interval)
     RETURNING id`,
    [phone, expected, String(minutesAgo)]
  );
  return r.rows[0].id as string;
}

const row = async (paymentId = 'pay_TEST0001') =>
  (await pool.query(`SELECT * FROM qr_payments WHERE payment_id = $1`, [paymentId])).rows[0];

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;

  console.log('\n1. qr_code.credited alone - the event that carries the QR id');
  await reset();
  await share('9000000001', 5000);
  let res = await post(qrCredited());
  let p = await row();
  check('stored', res.body.stored === true, res.body);
  check('qr id captured from payload.qr_code.entity.id', p.qr_id === 'qr_TESTQR0001', p.qr_id);
  check('matched to the share', !!p.share_id, { note: p.match_note, score: p.match_score });
  check('basis recorded as qr', p.match_basis === 'qr', p.match_basis);
  check('lead moved to the converted stage', (await pool.query(`SELECT status FROM leads WHERE id='33333333-3333-3333-3333-333333333333'`)).rows[0].status === 'converted');

  console.log('\n2. payment.captured alone - no QR id anywhere in the payload');
  await reset();
  await share('9000000001', 5000);
  res = await post(paymentCaptured());
  p = await row();
  check('stored, because the number matches a share', res.body.stored === true, res.body);
  check('qr id is null, because Razorpay did not send one', p.qr_id === null, p.qr_id);
  check('NOT auto-matched: it could be a website donation', !p.share_id, p.share_id);
  check('but the likely lead is named for a human', /Test Donor/.test(p.match_note ?? ''), p.match_note);
  check('basis recorded as phone', p.match_basis === 'phone', p.match_basis);
  check(
    'and the lead was not credited on a guess',
    (await pool.query(`SELECT status FROM leads WHERE id='33333333-3333-3333-3333-333333333333'`)).rows[0].status === 'new'
  );

  console.log("\n2b. a website donation on the same Razorpay account, from a stranger");
  await reset();
  await share('9000000001', 5000);
  res = await post(paymentCaptured({ id: 'pay_WEBSITE01', contact: '+919888888888' }));
  check('ignored, not stored', res.body.ignored === true, res.body);
  check('nothing added to the QR payments', (await pool.query(`SELECT COUNT(*)::int c FROM qr_payments`)).rows[0].c === 0);

  console.log('\n3. payment.captured first, qr_code.credited second (a UPI payment with no phone)');
  await reset();
  const s3 = await share('9999999999', 5000); // a number the payment cannot match
  res = await post(paymentCaptured({ contact: '' }));
  check('the first delivery is dropped: nothing ties it to DRM yet', res.body.ignored === true, res.body);
  res = await post(qrCredited({ contact: '' }));
  p = await row();
  check('the credited event stores it', res.body.stored === true, res.body);
  check('with the QR id', p.qr_id === 'qr_TESTQR0001', p.qr_id);
  check('and matches it', p.share_id === s3, { note: p.match_note, score: p.match_score });
  check('one row, not two', (await pool.query(`SELECT COUNT(*)::int c FROM qr_payments`)).rows[0].c === 1);

  console.log('\n3b. the same order, when the payment does carry a phone');
  await reset();
  const s3b = await share('9000000001', 5000);
  await post(paymentCaptured());
  p = await row();
  check('stored on the phone, held for a human', !!p && !p.share_id && p.match_basis === 'phone', p.match_note);
  await post(qrCredited());
  p = await row();
  check('qr id backfilled by the second delivery', p.qr_id === 'qr_TESTQR0001', p.qr_id);
  check('and now matched on the QR', p.share_id === s3b && p.match_basis === 'qr', { note: p.match_note });
  check('still one row', (await pool.query(`SELECT COUNT(*)::int c FROM qr_payments`)).rows[0].c === 1);
  check('the note is cleared once it is matched', p.match_note === null, p.match_note);

  console.log('\n4. qr_code.credited first, payment.captured second (the other order)');
  await reset();
  const s4 = await share('9999999999', 5000);
  await post(qrCredited({ contact: '' }));
  p = await row();
  check('matched on the first delivery', p.share_id === s4, p.match_note);
  await post(paymentCaptured({ contact: '' }));
  p = await row();
  check('the later payment.captured does not blank the qr id', p.qr_id === 'qr_TESTQR0001', p.qr_id);
  check('and does not re-match or double up', p.share_id === s4);
  check(
    'the share was credited once',
    (await pool.query(`SELECT COUNT(*)::int c FROM qr_shares WHERE matched_at IS NOT NULL`)).rows[0].c === 1
  );
  check(
    'the lead was credited once',
    Number((await pool.query(`SELECT converted_amount a FROM leads WHERE id='33333333-3333-3333-3333-333333333333'`)).rows[0].a) === 5000
  );

  console.log('\n5. a redelivery of the very same event (Razorpay does this)');
  await reset();
  await share('9999999999', 5000);
  await post(qrCredited({ contact: '' }));
  await post(qrCredited({ contact: '' }));
  await post(qrCredited({ contact: '' }));
  check('still one payment row', (await pool.query(`SELECT COUNT(*)::int c FROM qr_payments`)).rows[0].c === 1);
  check(
    'still one credit on the lead',
    Number((await pool.query(`SELECT converted_amount a FROM leads WHERE id='33333333-3333-3333-3333-333333333333'`)).rows[0].a) === 5000
  );

  console.log('\n6. a failed payment must not credit anybody');
  await reset();
  await share('9000000001', 5000);
  await post(qrCredited({ status: 'failed' }));
  p = await row();
  check('stored', !!p);
  check('not matched', !p.share_id);
  check('and says why', /failed/.test(p.match_note ?? ''), p.match_note);
  check(
    'lead untouched',
    (await pool.query(`SELECT status FROM leads WHERE id='33333333-3333-3333-3333-333333333333'`)).rows[0].status === 'new'
  );

  console.log('\n7. a QR nobody shared from DRM');
  await reset();
  await post(qrCredited({}, 'qr_TESTQR0001'));
  p = await row();
  check('stored, unmatched', !!p && !p.share_id);
  check('reason names the real problem', /not shared from DRM/i.test(p.match_note ?? ''), p.match_note);

  console.log('\n7b. the QR id somewhere other than where the docs put it');
  // Insurance, not a documented shape. If Razorpay ever nests the qr_code
  // entity differently, the id still has a shape nothing else shares and the
  // matcher still finds it, rather than storing null and failing silently.
  await reset();
  const s7b = await share('9999999999', 5000);
  await post({
    entity: 'event',
    event: 'qr_code.credited',
    contains: ['qr_code', 'payment'],
    payload: {
      qr_code: { id: 'qr_TESTQR0001', status: 'active' },
      payment: { entity: paymentEntity({ contact: '' }) },
    },
  });
  p = await row();
  check('found anyway', p?.qr_id === 'qr_TESTQR0001', p?.qr_id);
  check('and matched', p?.share_id === s7b, p?.match_note);

  console.log('\n8. an event DRM has no use for');
  await reset();
  res = await post({ entity: 'event', event: 'subscription.charged', payload: { payment: { entity: paymentEntity() } } });
  check('ignored, with 200 so Razorpay stops', res.status === 200 && res.body.ignored === true, res.body);
  check('nothing stored', (await pool.query(`SELECT COUNT(*)::int c FROM qr_payments`)).rows[0].c === 0);

  console.log('\n9. a bad signature');
  await reset();
  const bad = await new Promise<number>((resolve) => {
    const raw = Buffer.from(JSON.stringify(qrCredited()));
    const req = http.request(
      `${base}/api/razorpay/webhook`,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': raw.length, 'x-razorpay-signature': 'deadbeef' } },
      (r) => resolve(r.statusCode ?? 0)
    );
    req.end(raw);
  });
  check('refused', bad === 401, bad);

  console.log('\n10. THE REPORTED CASE: one QR, one share, a UPI payment with no phone and no amount');
  // This is exactly what the user did: made a list with their own number,
  // started calling, shared the QR, paid. The old scoring gave 25 against a
  // bar of 60, so it sat unattributed and had to be linked by hand.
  await reset();
  const s10 = await share('9000000001', null, 4);
  await post(qrCredited({ contact: '', amount: 100 }));
  p = await row();
  check('matched on its own', p.share_id === s10, { note: p.match_note, score: p.match_score });
  check('and scored on there being nothing else it could be', (p.match_score ?? 0) >= 60, p.match_score);

  const lead10 = (
    await pool.query(`SELECT * FROM leads WHERE id = '33333333-3333-3333-3333-333333333333'`)
  ).rows[0];
  check("the lead's stage is a real one", lead10.status === 'converted', lead10.status);
  check('the callback is cleared, so nobody rings to chase it', lead10.next_follow_up_at === null, lead10.next_follow_up_at);
  check('and the money is on the lead', Number(lead10.converted_amount) === 1, lead10.converted_amount);

  console.log('\n11. two shares on the same QR go to a human instead');
  await reset();
  await share('9000000001', null, 10);
  await share('9555555555', null, 5);
  await post(qrCredited({ contact: '' }));
  p = await row();
  check('not matched', !p.share_id, p.share_id);
  check('because it could be either', (p.match_score ?? 99) < 60, p.match_score);

  console.log('\n12. saying "I will pay by QR" on the call tips a doubtful one over');
  await reset();
  const a12 = await share('9000000001', null, 10);
  await share('9555555555', null, 5);
  await pool.query(`UPDATE qr_shares SET awaiting_payment_at = NOW() WHERE id = $1`, [a12]);
  await post(qrCredited({ contact: '' }));
  p = await row();
  // Deliberately NOT auto-matched: somebody else was sent the same QR in the
  // same window and could have paid without ever saying so. A promise makes
  // one candidate likelier, not certain.
  check('still left for a human', !p.share_id, p.share_id);
  check('but it scores higher than a silent share', (p.match_score ?? 0) > 25, p.match_score);
  check(
    'and the note names who said they would pay',
    /said on the call they would pay/.test(p.match_note ?? ''),
    p.match_note
  );

  console.log('\n13. an open promise is closed when the money lands');
  await reset();
  const s13 = await share('9000000001', null, 5);
  await pool.query(
    `INSERT INTO lead_reminders (lead_id, title, due_at)
     VALUES ('33333333-3333-3333-3333-333333333333','Said they would give', NOW() + INTERVAL '2 days')`
  );
  await post(qrCredited({ contact: '' }));
  p = await row();
  check('matched', p.share_id === s13, p.match_note);
  const rem13 = (await pool.query(`SELECT status FROM lead_reminders`)).rows[0];
  check(
    'the reminder is done, not still waiting to alert somebody',
    rem13.status === 'done',
    rem13.status
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
