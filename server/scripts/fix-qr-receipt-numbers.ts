/**
 * Give the QR payments that were receipted but kept no receipt number their number.
 *
 * WHY
 * Some QR payments are marked "issued" with no receipt number stored. The site had
 * already recorded the donation (a website gift the donor started at checkout), so
 * raising a receipt for it was refused as a duplicate, and no number came back with
 * the refusal. The number exists on the donation DRM holds for that payment.
 * services/qrReceiptNumber.ts now copies it over as soon as it is known; this does
 * the same for the ones already left blank.
 *
 * It only FILLS a payment that has no number, and only from a donation tied to it by
 * the site's donation id, or by the reference DRM sent together with the amount and the
 * site. A number already on a payment is never replaced.
 *
 * Report mode runs the same statement inside a transaction that is rolled back, so
 * what it shows is what apply would do and nothing is saved.
 *
 *   npx tsx scripts/fix-qr-receipt-numbers.ts            # report only - nothing is saved
 *   npx tsx scripts/fix-qr-receipt-numbers.ts --apply    # fill them in
 *
 * What it changes: qr_payments.receipt_number (and external_donation_id when empty).
 * Nothing else. It prints amounts, dates and receipt numbers, never a name or a phone.
 */
import pool from '../src/db/pool';
import { adoptReceiptNumber } from '../src/services/qrReceiptNumber';

function whereAmI(): string {
  try {
    const u = new URL(process.env.DATABASE_URL ?? '');
    return `${u.hostname}${u.port ? ':' + u.port : ''}/${u.pathname.replace(/^\//, '')}`;
  } catch {
    return '(DATABASE_URL is not set)';
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(`database: ${whereAmI()}   mode: ${apply ? 'APPLY - WILL CHANGE DATA' : 'report only (rolled back)'}`);

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL statement_timeout = '60s'`);

    const todo = await c.query<{ id: string }>(
      `SELECT id FROM qr_payments WHERE receipt_status = 'issued' AND receipt_number IS NULL ORDER BY received_at`
    );
    let filled = 0;
    for (const r of todo.rows) filled += await adoptReceiptNumber(c, { paymentId: r.id });

    const now = await c.query(
      `SELECT to_char(received_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI') AS paid_ist,
              amount::int AS amount, receipt_site AS site, receipt_number AS number_would_be
         FROM qr_payments WHERE id = ANY($1::uuid[]) ORDER BY received_at`,
      [todo.rows.map((r) => r.id)]
    );
    console.log(`\n${todo.rows.length} payment(s) are receipted with no number; ${filled} can be filled from their donation:\n`);
    console.table(now.rows);

    if (!apply) {
      await c.query('ROLLBACK');
      console.log('\nReport only - nothing was saved. Run again with --apply to fill them in.');
      return;
    }
    await c.query('COMMIT');
    console.log(`\nFilled ${filled} payment(s).`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('FAILED:', (e as Error).message); process.exit(1); });
