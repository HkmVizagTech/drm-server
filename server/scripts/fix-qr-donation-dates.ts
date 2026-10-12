/**
 * Re-date QR donations that were stamped with their RECEIPT date.
 *
 * Before services/qrDonationDate.ts, a donation raised for a QR payment on the
 * main site (hkmv) kept the moment the receipt was raised rather than the day
 * the money arrived. New ones are now dated correctly as they are recorded;
 * this repairs the ones already in the database.
 *
 * It CHANGES EXISTING ROWS, so it does nothing until it is told to:
 *
 *   npx tsx scripts/fix-qr-donation-dates.ts            # report only - READ ONLY
 *   npx tsx scripts/fix-qr-donation-dates.ts --apply    # make the change
 *
 * The report lists every donation that would move, with the date it has now and
 * the date it would get. It prints dates and ids, never names or numbers.
 *
 * What changes: donations.created_at, on donations tied to a QR payment whose
 * date differs from the payment's received_at by more than a minute. Nothing
 * else - not the amount, the receipt, the donor or the payment. Run in one
 * transaction, so it applies completely or not at all, and the report's own
 * output is the record of what the old values were.
 */
import pool from '../src/db/pool';
import { QR_DONATION_MATCH, QR_DATE_NEEDS_MOVING } from '../src/services/qrDonationDate';

const IST = (col: string) => `to_char(${col} AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI')`;

async function main() {
  const apply = process.argv.includes('--apply');
  const c = await pool.connect();
  try {
    await c.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
    await c.query(`SET LOCAL statement_timeout = '60s'`);

    const rows = await c.query(
      `SELECT d.id, d.source_site AS site,
              ${IST('d.created_at')} AS dated_now_ist,
              ${IST('p.received_at')} AS paid_ist,
              ROUND(EXTRACT(EPOCH FROM d.created_at - p.received_at) / 3600.0, 1) AS hours_late
         FROM donations d JOIN qr_payments p ON ${QR_DONATION_MATCH}
        WHERE ${QR_DATE_NEEDS_MOVING}
        ORDER BY p.received_at DESC`
    );
    console.log(`${rows.rows.length} donation(s) are dated by their receipt instead of their payment:\n`);
    console.table(rows.rows);

    if (!apply) {
      console.log('\nReport only - nothing was changed. Run again with --apply to re-date them.');
      await c.query('ROLLBACK');
      return;
    }

    const done = await c.query(
      `UPDATE donations d SET created_at = p.received_at
         FROM qr_payments p
        WHERE ${QR_DONATION_MATCH} AND ${QR_DATE_NEEDS_MOVING}`
    );
    await c.query('COMMIT');
    console.log(`\nRe-dated ${done.rowCount} donation(s).`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('FAILED:', (e as Error).message); process.exit(1); });
