/**
 * A QR donation is dated the day the money arrived, not the day its receipt was raised.
 *
 * THE FAILURE THIS SUITE EXISTS TO CATCH
 * A donor pays into the temple's QR on Saturday. A caller raises the 80G receipt
 * on Monday. The main site creates the donation when the receipt is raised and
 * DRM recorded it dated Monday - so the Donations list, the reports and the
 * donor's history all said Monday, while the QR payments screen said Saturday.
 * (annadan honours the payment date DRM sends; the main site does not.)
 *
 * The cases below are the ways it can come back, and the ways the fix can do
 * damage: a donation arriving before DRM knows which payment it belongs to, a
 * receipt that was a duplicate so no id was ever stored, a gift that merely
 * shares a reference, and one dated BEFORE its payment, which is not this bug
 * and must not be touched.
 *
 *   NODE_ENV=development DATABASE_URL=...drm_test npx tsx scripts/test-qr-donation-date.ts
 */
import '../src/bootTimezone';
import pool from '../src/db/pool';
import { upsertDonorSnapshot } from '../src/services/hkmvSync';
import { alignQrDonationDate } from '../src/services/qrDonationDate';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${label}`);
  failures++;
  console.error(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`);
};

const PAID = '2026-01-10T10:00:00.000Z'; // Saturday
const RECEIPT = '2026-01-12T15:30:00.000Z'; // Monday
const iso = (d: unknown) => new Date(d as string).toISOString();

async function reset() {
  await pool.query(`TRUNCATE qr_payments, person_names, donations, people RESTART IDENTITY CASCADE`);
}
async function payment(o: { id: string; amount?: number; ext?: string | null; site?: string; raw?: object; paidAt?: string }) {
  await pool.query(
    `INSERT INTO qr_payments (payment_id, amount, received_at, receipt_status, external_donation_id, receipt_site, raw)
     VALUES ($1,$2,$3::timestamptz,'issued',$4,$5,$6::jsonb)`,
    [o.id, o.amount ?? 500, o.paidAt ?? PAID, o.ext ?? null, o.site ?? 'hkmv', JSON.stringify(o.raw ?? {})]
  );
}
let phoneSeq = 0;
async function donation(o: { ref: string; at?: string; amount?: number; payRef?: string | null; site?: string }) {
  const p = await pool.query(`INSERT INTO people (name, phone) VALUES ('Donor', $1) RETURNING id`, [
    '9' + String(++phoneSeq).padStart(9, '0'),
  ]);
  const d = await pool.query(
    `INSERT INTO donations (person_id, amount, payment_mode, created_at, external_ref, payment_ref, source_site)
     VALUES ($1,$2,'upi',$3::timestamptz,$4,$5,$6) RETURNING id`,
    [p.rows[0].id, o.amount ?? 500, o.at ?? RECEIPT, o.ref, o.payRef ?? null, o.site ?? 'hkmv']
  );
  return d.rows[0].id as string;
}
const dated = async (ref: string) =>
  iso((await pool.query(`SELECT created_at FROM donations WHERE external_ref = $1`, [ref])).rows[0].created_at);

async function main() {
  console.log('\n--- the receipt date becomes the payment date ---');
  await reset();
  await payment({ id: 'pay_1', ext: 'EXT-1' });
  const id1 = await donation({ ref: 'EXT-1' });
  check('before: the donation carries the receipt date', await dated('EXT-1'), RECEIPT);
  const moved = await alignQrDonationDate(pool, { donationId: id1 });
  check('it is re-dated to the day the money arrived', iso(moved), PAID);
  check('and that is what is stored', await dated('EXT-1'), PAID);
  check('running it again changes nothing', await alignQrDonationDate(pool, { donationId: id1 }), null);
  check('it can be named by the site\'s id too', (await alignQrDonationDate(pool, { externalRef: 'EXT-1' })), null);

  console.log('\n--- the receipt arrives after the donation (the race) ---');
  await reset();
  // The site's own sync lands first: DRM has the donation but no external id yet.
  await payment({ id: 'pay_2', ext: null, raw: { payload: { payment: { entity: { acquirer_data: { rrn: 'UTR-2' } } } } } });
  await donation({ ref: 'EXT-2', payRef: 'UTR-2' });
  check('matched by the UTR DRM sent the site, with the id not stored yet',
    iso(await alignQrDonationDate(pool, { externalRef: 'EXT-2' })), PAID);

  console.log('\n--- a duplicate receipt, so no id was ever stored ---');
  await reset();
  await payment({ id: 'pay_3', ext: null });
  await donation({ ref: 'EXT-3', payRef: 'pay_3' });
  check('matched by the Razorpay payment id when that was the reference',
    iso(await alignQrDonationDate(pool, { externalRef: 'EXT-3' })), PAID);

  console.log('\n--- gifts that must NOT move ---');
  await reset();
  await payment({ id: 'pay_4', ext: 'EXT-4' });
  await donation({ ref: 'EXT-OTHER' });
  check('an unrelated donation', await alignQrDonationDate(pool, { externalRef: 'EXT-OTHER' }), null);

  await reset();
  await payment({ id: 'pay_5', ext: null, amount: 500 });
  await donation({ ref: 'EXT-5', payRef: 'pay_5', amount: 700 });
  check('same reference but a different amount', await alignQrDonationDate(pool, { externalRef: 'EXT-5' }), null);

  await reset();
  await payment({ id: 'pay_6', ext: null, site: 'hkmv' });
  await donation({ ref: 'EXT-6', payRef: 'pay_6', site: 'annadan' });
  check('same reference but another site', await alignQrDonationDate(pool, { externalRef: 'EXT-6' }), null);

  await reset();
  await payment({ id: 'pay_7', ext: 'EXT-7' });
  await donation({ ref: 'EXT-7', at: '2026-01-10T09:55:00.000Z' });
  check('dated BEFORE its payment: not this bug, left alone', await alignQrDonationDate(pool, { externalRef: 'EXT-7' }), null);
  check('and not changed', await dated('EXT-7'), '2026-01-10T09:55:00.000Z');

  await reset();
  await payment({ id: 'pay_8', ext: 'EXT-8' });
  await donation({ ref: 'EXT-8', at: '2026-01-10T10:00:30.000Z' });
  check('thirty seconds apart is the clocks, not the bug', await alignQrDonationDate(pool, { externalRef: 'EXT-8' }), null);

  console.log('\n--- end to end through the site\'s own sync ---');
  await reset();
  // The receipt had already been issued, so DRM knows the id when the donation arrives.
  await payment({ id: 'pay_9', ext: 'EXT-9' });
  const snap = {
    donor: { name: 'Giridhar', mobile: '9876500099', donorSince: '2024-01-01T00:00:00.000Z' },
    donations: [{
      externalId: 'EXT-9', amount: 500, type: 'Annadan', status: 'completed',
      createdAt: RECEIPT, isRecurring: false, receiptNumber: 'R-9', receiptIssuedAt: RECEIPT,
      sourcePage: '/donations/annadan', paymentRef: 'UTR9', paymentMode: 'upi', offline: true,
    }],
  };
  await upsertDonorSnapshot(snap as never, 'hkmv');
  check('the site says Monday; DRM records Saturday', await dated('EXT-9'), PAID);

  await upsertDonorSnapshot(snap as never, 'hkmv');
  check('the site re-sends it on a retry: still Saturday, still one donation',
    [await dated('EXT-9'), (await pool.query(`SELECT COUNT(*)::int n FROM donations`)).rows[0].n], [PAID, 1]);

  console.log('\n--- a website donation is untouched ---');
  await reset();
  const web = { ...snap, donations: [{ ...snap.donations[0], externalId: 'WEB-1', offline: false }] };
  await upsertDonorSnapshot(web as never, 'hkmv');
  check('no QR payment behind it, so its date stands', await dated('WEB-1'), RECEIPT);

  console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
  await pool.end();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error('THREW:', e);
  await pool.end().catch(() => {});
  process.exit(1);
});
