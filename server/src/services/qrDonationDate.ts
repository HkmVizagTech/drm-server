// The date a QR donation is DATED, which is the day the money arrived.
//
// THE BUG THIS EXISTS FOR
// A donor pays into the temple's QR. DRM records the payment with the time
// Razorpay says it arrived (qr_payments.received_at). Later a caller raises the
// 80G receipt, which makes the donation site create a donation - and that
// donation comes back into DRM carrying the time the site CREATED it, which is
// when the receipt was raised. Pay on Saturday, receipt on Monday, and the
// donation sits in DRM, in the Donations list, in the reports and on the
// donor's history, dated Monday.
//
// It is not every site. DRM sends the true payment date to both; annadan uses
// it and the main site (hkmv) does not - on production, 36 of 36 annadan QR
// receipts kept the payment date and 9 of 9 hkmv ones took the receipt date.
// DRM cannot change the other site, so DRM sets the right date when it records
// the donation.
//
// WHICH DATE IS RIGHT
// qr_payments.received_at: it comes from Razorpay and nothing rewrites it. The
// payment screens already show it, so this makes the donation agree with them.
//
// HOW A DONATION IS TIED TO ITS PAYMENT
//   1. qr_payments.external_donation_id = donations.external_ref. Exact. It is
//      stored once the site has accepted the receipt.
//   2. Failing that, the reference DRM sent the site. DRM sends the bank's UTR
//      when Razorpay had one, else the Razorpay payment id, and the site stores
//      it as the donation's payment_ref. Used when the donation reaches DRM
//      BEFORE DRM has stored the external id - the site's own post-donation
//      sync can arrive while the receipt request is still in flight - or when
//      the site answered "duplicate" and no id was ever stored. Required to
//      match the amount and the site too, so a reused reference cannot move an
//      unrelated gift.
//
// Only a donation dated LATER than its payment is moved, and only by more than
// a minute. A receipt cannot predate the money, so a donation dated before it is
// not this bug; and anything within a minute is the two systems' clocks, not
// the bug. Neither is a reason to rewrite a row that is already right.

import type { PoolClient } from 'pg';

type Q = Pick<PoolClient, 'query'>;

/** How far apart the two dates must be before the donation is moved. */
export const QR_DATE_TOLERANCE_SECONDS = 60;

const RRN = `p.raw #>> '{payload,payment,entity,acquirer_data,rrn}'`;
const UPI_TXN = `p.raw #>> '{payload,payment,entity,acquirer_data,upi_transaction_id}'`;

/**
 * The condition tying donation `d` to QR payment `p`. Exported so the repair
 * script reads exactly the rule the live code applies, not a copy of it.
 */
export const QR_DONATION_MATCH = `(
    (p.external_donation_id IS NOT NULL AND p.external_donation_id = d.external_ref)
    OR (
      p.external_donation_id IS NULL
      AND d.payment_ref IS NOT NULL
      AND d.amount = p.amount
      AND d.source_site IS NOT DISTINCT FROM p.receipt_site
      AND d.payment_ref IN (p.payment_id, ${RRN}, ${UPI_TXN})
    )
  )`;

/**
 * True when the donation is dated LATER than its payment by more than the
 * tolerance - and only then.
 *
 * One direction on purpose. A receipt is raised after the money arrives, so the
 * bug can only ever show as a donation dated too LATE. A donation dated before
 * its payment is something else - a website donation started at checkout and
 * paid minutes later, say - and moving it would rewrite a date that was never
 * wrong. The first version compared the absolute difference and, on production
 * data, picked up exactly one such gift; it is left alone.
 */
export const QR_DATE_NEEDS_MOVING = `EXTRACT(EPOCH FROM d.created_at - p.received_at) > ${QR_DATE_TOLERANCE_SECONDS}`;

/**
 * Give a QR donation the date the money arrived.
 *
 * Name the donation by DRM's id or by the site's id, whichever the caller has.
 * Returns the date now on the donation, or null when it is not a QR donation or
 * is already right - so a caller can use `result ?? whatever it had`.
 *
 * Idempotent: a second call changes nothing.
 */
export async function alignQrDonationDate(
  q: Q,
  which: { donationId?: string; externalRef?: string }
): Promise<Date | null> {
  if (!which.donationId && !which.externalRef) return null;
  const r = await q.query<{ created_at: Date }>(
    `UPDATE donations d SET created_at = p.received_at
       FROM qr_payments p
      WHERE (($1::uuid IS NOT NULL AND d.id = $1::uuid)
          OR ($2::text IS NOT NULL AND d.external_ref = $2::text))
        AND ${QR_DONATION_MATCH}
        AND ${QR_DATE_NEEDS_MOVING}
      RETURNING d.created_at`,
    [which.donationId ?? null, which.externalRef ?? null]
  );
  return r.rows[0]?.created_at ?? null;
}
