/**
 * Bring back the leads that were sent a QR and then forgotten.
 *
 * WHY
 * Sending a QR used to leave the lead's follow-up date alone, so a lead whose call
 * outcome carried no date had nothing to bring it back: waiting on money nobody
 * would ask about. On production, 27 of 85 unpaid QR leads were in that state.
 * New sends now book the follow-up themselves (services/qrFollowUp.ts); this does
 * the same for the ones already sent.
 *
 * WHICH LEADS
 * Open, not do-not-call, not donated, sent a QR in the last 30 days that has not
 * been paid, and with NO follow-up date. Each is booked two days after the day the
 * QR was sent, at 10am - or tomorrow morning if that has already passed. A lead
 * that already has a date is left alone, whoever chose it.
 *
 * It uses the very same function the send button uses, so the report cannot say
 * one thing and the change do another. Report mode runs it inside a transaction
 * that is rolled back, so nothing is saved.
 *
 *   npx tsx scripts/fix-qr-follow-ups.ts            # report only - nothing is saved
 *   npx tsx scripts/fix-qr-follow-ups.ts --apply    # book them
 *
 * What it changes: leads.next_follow_up_at, and the flag that marks it as the
 * system's. Not the stage, the owner, the calls or the notes. It prints dates and
 * ids, never a name or a number.
 */
import pool from '../src/db/pool';
import { bookQrFollowUp } from '../src/services/qrFollowUp';

const IST = (col: string) => `to_char(${col} AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI')`;

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

    const todo = await c.query<{ id: string; sent_at: Date; status: string; last_outcome: string | null }>(
      `SELECT l.id, MAX(s.created_at) AS sent_at, l.status, l.last_outcome
         FROM leads l
         JOIN qr_shares s ON s.lead_id = l.id AND s.matched_at IS NULL AND s.created_at > NOW() - INTERVAL '30 days'
        WHERE l.next_follow_up_at IS NULL
          AND l.do_not_call = FALSE AND l.converted_at IS NULL
          AND COALESCE((SELECT is_open FROM crm_statuses WHERE slug = l.status), TRUE)
        GROUP BY l.id, l.status, l.last_outcome
        ORDER BY sent_at`
    );

    const booked: Record<string, unknown>[] = [];
    for (const r of todo.rows) {
      const at = await bookQrFollowUp(c, r.id, r.sent_at);
      if (at) {
        booked.push({
          id: r.id,
          stage: r.status,
          last_outcome: r.last_outcome ?? '-',
          qr_sent_ist: (await c.query(`SELECT ${IST('$1::timestamptz')} AS t`, [r.sent_at])).rows[0].t,
          back_on_ist: (await c.query(`SELECT ${IST('$1::timestamptz')} AS t`, [at])).rows[0].t,
        });
      }
    }
    console.log(`\n${booked.length} lead(s) were sent a QR, never given a follow-up, and would be booked:\n`);
    console.table(booked);

    if (!apply) {
      await c.query('ROLLBACK');
      console.log('\nReport only - nothing was saved. Run again with --apply to book them.');
      return;
    }
    await c.query('COMMIT');
    console.log(`\nBooked ${booked.length} lead(s).`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('FAILED:', (e as Error).message); process.exit(1); });
