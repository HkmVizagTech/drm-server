// The receipt number a QR payment was given, kept on the payment.
//
// WHY THIS EXISTS
// The number comes back from the site when the receipt is raised and is saved on
// the QR payment (qr_payments.receipt_number). Three things used to leave it empty:
//
//   - The site answers "this already exists". A website donation the donor had
//     started at checkout is already a donation there, so raising a receipt for the
//     same money is refused as a duplicate - and DRM marked it issued but kept no
//     number, because none came back.
//   - The site accepts the receipt but has not allocated the number yet ("Receipt
//     No. will show soon"). DRM got null, and the number arrived later on the
//     donation record, which nothing copied back to the payment.
//   - The Money raised page read the number from the DONATION record only, so a
//     payment whose number sat on the QR payment showed a blank. (Fixed in
//     crmReports.ts: it reads both.)
//
// This copies the number from the donation DRM holds for that payment, once it is
// known, to the payment. It only ever FILLS a payment that has no number and never
// replaces one, so a number that is already there is not touched.
//
// HOW A DONATION IS TIED TO ITS PAYMENT is the same rule the donation dates use
// (qrDonationDate.ts): by the site's donation id when stored, else by the
// reference DRM sent - the UTR or the Razorpay id - together with the amount and
// the site, so a reused reference cannot hand one payment another's number.

import type { PoolClient } from 'pg';
import { QR_DONATION_MATCH } from './qrDonationDate';

type Q = Pick<PoolClient, 'query'>;

/**
 * Give a QR payment the receipt number of its donation, when it has none.
 *
 * Name the payment (by DRM's id) or the donation (by DRM's id), whichever the caller
 * has. Returns how many payments were filled. Idempotent.
 */
export async function adoptReceiptNumber(
  q: Q,
  which: { paymentId?: string; donationId?: string }
): Promise<number> {
  if (!which.paymentId && !which.donationId) return 0;
  const r = await q.query(
    `UPDATE qr_payments p
        SET receipt_number       = d.receipt_number,
            external_donation_id = COALESCE(p.external_donation_id, d.external_ref)
       FROM donations d
      WHERE p.receipt_status = 'issued'
        AND p.receipt_number IS NULL
        AND d.receipt_number IS NOT NULL
        AND (($1::uuid IS NOT NULL AND p.id = $1::uuid) OR ($2::uuid IS NOT NULL AND d.id = $2::uuid))
        AND ${QR_DONATION_MATCH}`,
    [which.paymentId ?? null, which.donationId ?? null]
  );
  return r.rowCount ?? 0;
}
