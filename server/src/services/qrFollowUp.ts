// A lead that was sent a QR comes back, so somebody checks whether it was paid.
//
// THE GAP THIS CLOSES
// Sending a QR only recorded the share: it left the lead's stage and follow-up
// date exactly as they were. The stage ("Callback booked") and the date come from
// the call outcome the caller logs - "Will pay by QR", "Will donate" - and when the
// QR went out without one, or the outcome was logged without a date, the lead had
// nothing to bring it back. On production, 27 of 85 unpaid QR leads had no
// follow-up at all: they were waiting on money nobody would ever ask about.
//
// THE RULE
// The QR goes out, the lead comes back `retry_after_days` days later, at 10am - the
// same day-based rule as every other follow-up the system books (a QR sent on the
// 17th, morning or evening, is back on the morning of the 19th), and listed on
// Follow-ups only from that day because the system booked it.
//
// WHAT IT NEVER DOES
//   - Move a date a PERSON chose. Only a lead with no follow-up, or one the system
//     booked earlier, is booked; a callback somebody asked for is theirs.
//   - Touch a lead that is closed, donated or marked do-not-call.
//   - Change the stage, the owner, the calls or the notes. Only the follow-up date.
//
// When the money arrives, the payment match clears the date (crmQr.ts: "the chase
// stops here"), so a lead that paid does not come back.

import type { PoolClient } from 'pg';

type Q = Pick<PoolClient, 'query'>;

/**
 * Book the follow-up for a lead that was sent a QR.
 *
 * `from` is the moment the QR was sent; leave it out for "just now". Returns the
 * date the lead is now booked for, or null when nothing was booked - a lead that
 * already has a date a person chose, or one that is closed.
 *
 * Idempotent: sending a second QR the same day books the same date again.
 */
export async function bookQrFollowUp(q: Q, leadId: string, from: Date | string | null = null): Promise<Date | null> {
  const booked = await q.query<{ next_follow_up_at: Date }>(
    `WITH gap AS (
       SELECT GREATEST(1, LEAST(90, COALESCE((SELECT (value #>> '{}')::int FROM crm_settings WHERE key = 'retry_after_days'), 2))) AS days
     ), target AS (
       -- Counted from the DAY the QR was sent, and never earlier than tomorrow
       -- morning, so a QR sent days ago is not booked into the past.
       SELECT GREATEST(
                date_trunc('day', COALESCE($2::timestamptz, NOW())) + (gap.days || ' days')::interval + INTERVAL '10 hours',
                date_trunc('day', NOW()) + INTERVAL '1 day' + INTERVAL '10 hours') AS at
         FROM gap
     )
     UPDATE leads l SET next_follow_up_at = t.at
       FROM target t
      WHERE l.id = $1
        AND l.do_not_call = FALSE
        AND l.converted_at IS NULL
        AND COALESCE((SELECT s.is_open FROM crm_statuses s WHERE s.slug = l.status), TRUE)
        AND (l.next_follow_up_at IS NULL OR (l.follow_up_auto AND l.next_follow_up_at < t.at))
      RETURNING l.next_follow_up_at`,
    [leadId, from]
  );
  if (!booked.rows.length) return null;

  // Changing the date clears the system flag (trg_leads_clear_follow_up_auto), which
  // is right for every other route and wrong here: this IS a date the system booked.
  await q.query(`UPDATE leads SET follow_up_auto = TRUE WHERE id = $1`, [leadId]);
  return booked.rows[0].next_follow_up_at;
}
