// Follow-up reminders for devotees, pushed to their phones when the time they picked arrives.
//
// Runs every minute (utils/cron.ts). Each due follow-up is CLAIMED before anything is sent - its
// reminder_sent_at is set in the same statement that picks it - so a second server, or a run that
// overlaps a slow one, cannot send the same reminder twice. A follow-up more than a day overdue is
// not announced: the devotee has already seen it on the Follow-ups screen, and a burst of stale
// reminders after downtime is noise.
//
// The page shows due follow-ups itself while it is open, and the Android app schedules its own
// notifications on the phone; this is what reaches a devotee whose browser is closed.

import pool from '../db/pool';
import { pushEnabled, sendPushToUser } from './webPush';

/** More than this many due for one devotee in one minute: one summary instead of a stack. */
const SUMMARY_OVER = 3;

let running = false;

export async function devoteeReminderTick(): Promise<{ claimed: number; pushed: number }> {
  if (running || !pushEnabled()) return { claimed: 0, pushed: 0 };
  running = true;
  try {
    const due = (
      await pool.query(
        `UPDATE devotee_leads l SET reminder_sent_at = NOW()
          WHERE l.id IN (
            SELECT id FROM devotee_leads
             WHERE next_follow_up_at IS NOT NULL
               AND reminder_sent_at IS NULL
               AND next_follow_up_at <= NOW()
               AND next_follow_up_at > NOW() - INTERVAL '1 day'
             ORDER BY next_follow_up_at
             LIMIT 500
             FOR UPDATE SKIP LOCKED)
        RETURNING l.id, l.owner_id, l.name, l.phone, l.status`
      )
    ).rows as { id: string; owner_id: string; name: string; phone: string; status: string }[];

    const byOwner = new Map<string, typeof due>();
    for (const r of due) byOwner.set(r.owner_id, [...(byOwner.get(r.owner_id) ?? []), r]);

    let pushed = 0;
    for (const [owner, rows] of byOwner) {
      if (rows.length > SUMMARY_OVER) {
        const r = await sendPushToUser(owner, {
          title: `${rows.length} follow-ups due now`,
          body: rows.slice(0, 3).map((x) => x.name).join(', ') + ' and others',
          url: '/devotee/follow-ups',
          tag: 'devotee-follow-ups',
        });
        pushed += r.sent;
        continue;
      }
      for (const lead of rows) {
        const r = await sendPushToUser(owner, {
          title: `Follow up: ${lead.name}`,
          body: `It is time to contact ${lead.name} (${lead.phone}).`,
          url: `/devotee/leads/${lead.id}`,
          tag: `devotee-lead-${lead.id}`,
        });
        pushed += r.sent;
      }
    }
    return { claimed: due.length, pushed };
  } finally {
    running = false;
  }
}
