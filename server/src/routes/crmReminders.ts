// Reminders - the commitments donors make, and the alerts that keep them.
//
// WHY THIS IS SEPARATE FROM FOLLOW-UPS
// A follow-up is the caller's own working note: "ring them back around the
// 20th". A reminder is something the DONOR said: "I will give on Govardhan Puja
// evening, after the arati." Those need different handling. A follow-up can
// slip a day and nothing is lost. A reminder that slips an hour means catching
// someone at dinner instead of in the mood they promised in.
//
// Keeping them in one list is exactly how a CRM's reminder feature dies: the
// handful of real commitments drown among hundreds of routine callbacks,
// people stop reading the list, and the commitments get missed anyway.
//
// HOW THE ALERTING WORKS, AND WHY IT IS SERVER-SIDE
// Each reminder carries lead_times - minutes before it falls due at which it
// should surface. The default is a day, an hour and a quarter of an hour
// before. fired_offsets records which of those have already been raised.
//
// That state lives in the database, not the browser, for three reasons:
//   - the caller who needs the alert may not be the one with a tab open
//   - a refresh must not replay yesterday's alerts
//   - two open tabs must not alert twice
// GET /alerts is therefore a read that also writes: it returns what is newly
// due for this user and marks those offsets fired in the same statement, so
// two simultaneous polls cannot both claim the same alert.

import { Router } from 'express';
import pool from '../db/pool';
import { authenticate } from '../middleware/auth';
import { istMidnight, parseDate } from '../bootTimezone';
import {
  describeFilters,
  sendExport,
  EXPORT_ROW_CAP,
  type ExportFormat,
} from '../utils/export';

const router = Router();
router.use(authenticate);

const str = (v: unknown, max = 255): string | null => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};

// Bare dates resolve to midnight in India rather than UTC - see parseDate.
const asDate = parseDate;

// Minutes-before values, cleaned up. Sorted descending and de-duplicated so the
// day-before alert always precedes the hour-before one, and a caller who types
// the same value twice doesn't get two alerts.
function leadTimes(v: unknown): number[] {
  const raw = Array.isArray(v) ? v : [1440, 60, 15];
  const cleaned = raw
    .map((n) => Math.round(Number(n)))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 43200); // up to 30 days
  return [...new Set(cleaned)].sort((a, b) => b - a);
}

const SELECT = `
  r.id, r.lead_id, r.title, r.note, r.occasion, r.due_at, r.expected_amount,
  r.lead_times, r.fired_offsets, r.assigned_to, r.status, r.completed_at,
  r.snooze_count, r.created_at,
  l.name  AS lead_name,
  l.phone AS lead_phone,
  l.status AS lead_status,
  u.name  AS assigned_to_name,
  -- Everything the caller needs before dialling, so opening a reminder does not
  -- mean a second request for the donor's history.
  p.total_donated, p.donation_count`;

const JOINS = `
  FROM lead_reminders r
  JOIN leads l ON r.lead_id = l.id
  LEFT JOIN users u ON COALESCE(r.assigned_to, l.assigned_to) = u.id
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(d.amount),0)::numeric AS total_donated, COUNT(*)::int AS donation_count
      FROM donations d WHERE d.person_id = l.person_id
  ) p ON l.person_id IS NOT NULL`;

/* ------------------------------------------------------------------ listing */

/**
 * GET /reminders - the board.
 *
 * Grouped by how soon, because that is the only ordering a caller cares about:
 * what is late, what is today, what is coming. "missed" is derived here rather
 * than stored - an open reminder whose time has passed IS missed, and computing
 * it means there is no background job whose failure would leave the board
 * quietly lying about what is outstanding.
 */
// The WHERE for the board, built once and shared with the export below. A file
// that quietly included a donor who has asked not to be called, because the
// export grew its own copy of these conditions and missed one, is exactly the
// kind of drift that makes a do-not-call flag worthless.
function buildReminderFilters(
  q: Record<string, unknown>,
  userId?: string
): { where: string; values: unknown[] } {
  const scope = String(q.scope ?? 'open');
  const mine = q.mine === 'true';

  const conditions: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  // Same rule as the alert poll below: a donor who has asked not to be called
  // is not somebody to be reminded to ring.
  conditions.push(`l.do_not_call = FALSE`);

  if (scope === 'open') conditions.push(`r.status = 'open'`);
  else if (scope !== 'all') {
    conditions.push(`r.status = $${i++}`);
    values.push(scope);
  }
  if (mine) {
    // "Mine" has to include reminders nobody owns, or an unassigned one belongs
    // to no-one and is therefore seen by no-one - which is how a promise gets
    // missed while sitting in plain sight on a board everybody filtered past.
    // Same rule the calling queue uses: mine, or going spare.
    conditions.push(`(COALESCE(r.assigned_to, l.assigned_to) = $${i} OR COALESCE(r.assigned_to, l.assigned_to) IS NULL)`);
    values.push(userId ?? null);
    i++;
  }
  if (q.lead_id) {
    conditions.push(`r.lead_id = $${i++}`);
    values.push(q.lead_id);
  }

  return { where: `WHERE ${conditions.join(' AND ')}`, values };
}

router.get('/reminders', async (req, res) => {
  const f = buildReminderFilters(req.query as Record<string, unknown>, req.user?.userId);

  try {
    const rows = await pool.query(
      `SELECT ${SELECT} ${JOINS}
       ${f.where}
       ORDER BY r.due_at ASC LIMIT 500`,
      f.values
    );

    const now = Date.now();
    // "Tomorrow" starts at midnight in India, not wherever the server happens
    // to think midnight is. setHours(24,0,0,0) was the old form, and with the
    // process on UTC it put the today/tomorrow line at 05:30 IST - so a
    // reminder due at 3am tomorrow was listed under today, and anything a
    // caller set for early morning appeared in the wrong section of the board.
    const startOfTomorrow = istMidnight(1);
    const endOfTomorrow = new Date(startOfTomorrow.getTime() + 86_400_000);
    const endOfWeek = new Date(startOfTomorrow.getTime() + 7 * 86_400_000);

    const buckets: Record<string, Record<string, unknown>[]> = {
      missed: [],
      now: [],
      today: [],
      tomorrow: [],
      this_week: [],
      later: [],
      done: [],
    };

    for (const r of rows.rows) {
      if (r.status !== 'open') {
        buckets.done.push(r);
        continue;
      }
      const due = new Date(r.due_at).getTime();
      // "now" is a 30-minute window on either side: a reminder for 6:00 is
      // something you act on at 5:50, and one from 6:20 has not yet become a
      // failure worth flagging in red.
      if (due < now - 30 * 60_000) buckets.missed.push(r);
      else if (due <= now + 30 * 60_000) buckets.now.push(r);
      else if (due < startOfTomorrow.getTime()) buckets.today.push(r);
      else if (due < endOfTomorrow.getTime()) buckets.tomorrow.push(r);
      else if (due < endOfWeek.getTime()) buckets.this_week.push(r);
      else buckets.later.push(r);
    }

    res.json({
      buckets,
      counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
    });
  } catch (err) {
    console.error('crm.listReminders error:', err);
    res.status(500).json({ error: 'Could not load reminders' });
  }
});

/**
 * The reminder board, as a file.
 *
 * Caller-reachable, like the board, and built from the same
 * buildReminderFilters - so "mine" means the same set in the file as on the
 * screen, do-not-call donors are absent from both, and neither can start
 * including somebody the other leaves out.
 *
 * The board stops at 500 because it is read in buckets on a phone. A file is
 * read by sorting, so it runs to the shared row cap instead and says on its
 * first line when even that was not enough.
 */
async function exportRemindersFile(
  req: import('express').Request,
  res: import('express').Response,
  format: ExportFormat
) {
  try {
    const f = buildReminderFilters(req.query as Record<string, unknown>, req.user?.userId);
    const rows = await pool.query(
      // created_by is joined here and not in the shared SELECT because only the
      // file needs it - the board shows who a reminder is FOR, which is already
      // in assigned_to_name.
      `SELECT ${SELECT}, cu.name AS created_by_name
       ${JOINS}
       LEFT JOIN users cu ON r.created_by = cu.id
       ${f.where}
       ORDER BY r.due_at ASC LIMIT ${EXPORT_ROW_CAP + 1}`,
      f.values
    );
    const truncated = rows.rows.length > EXPORT_ROW_CAP;

    await sendExport(res, format, {
      name: 'reminders',
      truncated,
      rows: truncated ? rows.rows.slice(0, EXPORT_ROW_CAP) : rows.rows,
      filterSummary: describeFilters(req.query as Record<string, unknown>, {
        scope: 'Showing',
        mine: 'Mine only',
        lead_id: 'Lead',
      }),
      columns: [
        { header: 'Due at', value: (r) => r.due_at, kind: 'datetime' },
        { header: 'Status', value: (r) => r.status },
        { header: 'Lead name', value: (r) => r.lead_name },
        { header: 'Lead phone', value: (r) => r.lead_phone, kind: 'phone' },
        { header: 'Note', value: (r) => r.note },
        { header: 'Created by', value: (r) => r.created_by_name },
        { header: 'Created at', value: (r) => r.created_at, kind: 'datetime' },
        { header: 'Completed at', value: (r) => r.completed_at, kind: 'datetime' },
      ],
    });
  } catch (err) {
    console.error('crm.exportReminders error:', err);
    res.status(500).json({ error: 'Could not build that export' });
  }
}

// Above the '/reminders/:id' handlers further down. Express matches in order,
// so registered after them "export.csv" would be read as a reminder id - the
// same trap that once made /leads/sample.csv answer "Lead not found".
router.get('/reminders/export.csv', (req, res) => exportRemindersFile(req, res, 'csv'));
router.get('/reminders/export.xlsx', (req, res) => exportRemindersFile(req, res, 'xlsx'));

/* ------------------------------------------------------------------- alerts */

/**
 * GET /reminders/alerts - what should be alerting this caller right now.
 *
 * Called on a timer by every open screen. Returns only alerts NOT yet raised,
 * and marks them raised in the same statement, so:
 *   - two tabs cannot both alert for the same thing
 *   - a refresh does not replay alerts already seen
 *   - an alert missed while logged out is still waiting on the next sign-in
 *
 * The UPDATE ... RETURNING is what makes that atomic. Reading the due rows and
 * then marking them in a second query would leave a window in which a parallel
 * poll reads the same rows, and the caller gets the same alert twice.
 */
router.get('/reminders/alerts', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE lead_reminders r SET
         -- Record every offset that has now elapsed, not only the newest: a
         -- caller who was away all morning should get one alert on return, not
         -- a queue of three for the same reminder.
         fired_offsets = ARRAY(
           SELECT DISTINCT unnest(r.fired_offsets || ARRAY(
             SELECT t FROM unnest(r.lead_times) AS t
              WHERE r.due_at - make_interval(mins => t) <= NOW()
           ))
         ),
         updated_at = NOW()
       FROM leads l
      WHERE r.lead_id = l.id
        AND r.status = 'open'
        -- Never somebody who has asked not to be called. Every other path in
        -- DRM honours this - the queue, the leads list, the follow-up report -
        -- and this one did not, so a reminder created before a donor opted out
        -- still fired, in a popup with a one-tap dial button next to it.
        AND l.do_not_call = FALSE
        -- Alert the person it belongs to, and everyone when it belongs to
        -- nobody. An unassigned reminder that alerts no-one is worse than no
        -- reminder at all, because it looks handled.
        AND (COALESCE(r.assigned_to, l.assigned_to) = $1::uuid
             OR COALESCE(r.assigned_to, l.assigned_to) IS NULL)
        -- Only rows that actually have a newly-elapsed offset, so the common
        -- case (nothing due) writes nothing at all.
        AND EXISTS (
          SELECT 1 FROM unnest(r.lead_times) AS t
           WHERE r.due_at - make_interval(mins => t) <= NOW()
             AND NOT (t = ANY(r.fired_offsets))
        )
        -- Stop alerting about something a day stale; it belongs on the missed
        -- list, not in a popup.
        AND r.due_at > NOW() - INTERVAL '1 day'
      RETURNING r.id, r.lead_id, r.title, r.note, r.occasion, r.due_at,
                r.expected_amount, l.name AS lead_name, l.phone AS lead_phone`,
      [req.user?.userId ?? null]
    );

    res.json({ alerts: result.rows });
  } catch (err) {
    console.error('crm.reminderAlerts error:', err);
    // A failing alert poll must never surface as an error banner over the
    // caller's work - it retries in a minute anyway.
    res.json({ alerts: [] });
  }
});

/* ------------------------------------------------------------------ writing */

router.post('/leads/:id/reminders', async (req, res) => {
  const b = req.body ?? {};
  const due = asDate(b.due_at);
  if (!due) return res.status(400).json({ error: 'When should this remind you?' });
  const title = str(b.title, 200);
  if (!title) return res.status(400).json({ error: 'Say what the reminder is for' });

  try {
    const result = await pool.query(
      `INSERT INTO lead_reminders
         (lead_id, title, note, occasion, due_at, expected_amount, lead_times, assigned_to, created_by)
       VALUES ($1,$2,$3,$4,$5::timestamptz,$6::numeric,$7::int[],
               COALESCE($8::uuid, (SELECT assigned_to FROM leads WHERE id = $1)), $9::uuid)
       RETURNING *`,
      [
        req.params.id,
        title,
        str(b.note, 2000),
        str(b.occasion, 120),
        due,
        b.expected_amount ?? null,
        leadTimes(b.lead_times),
        str(b.assigned_to, 36),
        req.user?.userId ?? null,
      ]
    );

    // Shows up in the lead's own history, so the story of the call and the
    // promise that came out of it read as one thing.
    await pool.query(
      `INSERT INTO lead_activities (lead_id, user_id, kind, to_value, note)
       VALUES ($1,$2,'reminder',$3,$4)`,
      [req.params.id, req.user?.userId ?? null, due, title]
    );
    // A promise holds the lead until it is due, the same as one made on a
    // call - otherwise the queue reads an empty callback date as "ring now".
    await pool.query(
      `UPDATE leads SET next_follow_up_at = GREATEST(COALESCE(next_follow_up_at, $2::timestamptz), $2::timestamptz)
        WHERE id = $1`,
      [req.params.id, due]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('crm.createReminder error:', err);
    res.status(500).json({ error: 'Could not save that reminder' });
  }
});

/**
 * PUT /reminders/:id - act on one.
 *
 * Snoozing clears fired_offsets, which is the subtle part: without that, a
 * reminder pushed from this evening to tomorrow evening would never alert
 * again, because every one of its offsets is already marked fired.
 */
/**
 * Yours, or an admin's.
 *
 * A reminder is a promise a donor made to a particular caller. Without this,
 * any caller could edit or delete a colleague's "he said ten thousand at
 * Govardhan Puja" - and nobody would ring. Unassigned ones are fair game for
 * anybody, on the same principle the alert poll uses: a promise nobody owns
 * that nobody may touch is a promise that gets missed.
 */
async function mayTouchReminder(
  id: string,
  user?: { role?: string; userId?: string }
): Promise<boolean> {
  if (user?.role === 'admin') return true;
  const r = await pool.query(
    `SELECT 1 FROM lead_reminders r
       JOIN leads l ON r.lead_id = l.id
      WHERE r.id = $1
        AND (COALESCE(r.assigned_to, l.assigned_to) = $2::uuid
             OR COALESCE(r.assigned_to, l.assigned_to) IS NULL)`,
    [id, user?.userId ?? null]
  );
  return r.rows.length > 0;
}

router.put('/reminders/:id', async (req, res) => {
  const b = req.body ?? {};
  const action = String(b.action ?? 'update');

  if (!(await mayTouchReminder(req.params.id, req.user))) {
    return res.status(404).json({ error: 'No such reminder' });
  }

  try {
    let result;

    if (action === 'done' || action === 'dismiss') {
      result = await pool.query(
        `UPDATE lead_reminders SET status = $1, completed_at = NOW(), updated_at = NOW()
          WHERE id = $2 RETURNING *`,
        [action === 'done' ? 'done' : 'dismissed', req.params.id]
      );
    } else if (action === 'snooze') {
      const minutes = Math.max(5, Math.min(43200, Number(b.minutes) || 60));
      result = await pool.query(
        `UPDATE lead_reminders SET
           due_at = NOW() + make_interval(mins => $1),
           -- Cleared so the new time alerts properly. Without this the
           -- reminder would move but stay silent, which is worse than not
           -- offering snooze at all.
           fired_offsets = '{}',
           snooze_count = snooze_count + 1,
           status = 'open',
           updated_at = NOW()
         WHERE id = $2 RETURNING *`,
        [minutes, req.params.id]
      );
    } else if (action === 'reopen') {
      result = await pool.query(
        `UPDATE lead_reminders SET status = 'open', completed_at = NULL, fired_offsets = '{}', updated_at = NOW()
          WHERE id = $1 RETURNING *`,
        [req.params.id]
      );
    } else {
      const due = asDate(b.due_at);
      result = await pool.query(
        `UPDATE lead_reminders SET
           title           = COALESCE($1, title),
           note            = COALESCE($2, note),
           occasion        = COALESCE($3, occasion),
           due_at          = COALESCE($4::timestamptz, due_at),
           expected_amount = COALESCE($5::numeric, expected_amount),
           lead_times      = COALESCE($6::int[], lead_times),
           assigned_to     = COALESCE($7::uuid, assigned_to),
           -- Moving the time or the lead times means the old fired marks no
           -- longer describe anything, so they go.
           fired_offsets   = CASE WHEN $4::timestamptz IS NOT NULL OR $6::int[] IS NOT NULL
                                  THEN '{}' ELSE fired_offsets END,
           updated_at      = NOW()
         WHERE id = $8 RETURNING *`,
        [
          str(b.title, 200),
          str(b.note, 2000),
          str(b.occasion, 120),
          due,
          b.expected_amount ?? null,
          b.lead_times ? leadTimes(b.lead_times) : null,
          str(b.assigned_to, 36),
          req.params.id,
        ]
      );
    }

    if (!result.rows.length) return res.status(404).json({ error: 'Reminder not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('crm.updateReminder error:', err);
    res.status(500).json({ error: 'Could not update that reminder' });
  }
});

router.delete('/reminders/:id', async (req, res) => {
  if (!(await mayTouchReminder(req.params.id, req.user))) {
    return res.status(404).json({ error: 'No such reminder' });
  }

  try {
    const result = await pool.query(`DELETE FROM lead_reminders WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Reminder not found' });
    res.json({ deleted: true });
  } catch (err) {
    console.error('crm.deleteReminder error:', err);
    res.status(500).json({ error: 'Could not delete that reminder' });
  }
});

export default router;
