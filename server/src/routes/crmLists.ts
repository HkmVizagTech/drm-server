// Calling lists, and a caller's run at one.
//
// WHAT "START CALLING" USED TO DO, AND WHY IT WAS NOT ENOUGH
// It opened one global queue: every lead assigned to you or unassigned, ordered
// by what was most overdue. The ordering was right and is kept here unchanged.
// What was missing is the unit of work. A temple does not call "the queue" - it
// calls the Janmashtami sheet on Tuesday and the lapsed monthly donors on
// Wednesday. And when a caller stops at forty, somebody has to be able to open
// the same list on Thursday and carry on.
//
// A LIST IS A QUESTION, NOT A COPY
// A list stores a filter - this uploaded sheet, this tag, this preacher's
// donors - and the queue answers it fresh every time. The alternative, a table
// of list members, goes stale the moment a lead converts, goes do-not-call, or
// is assigned elsewhere, and then the list says 300 while the queue hands over
// 240 and nobody can explain the difference.
//
// Because of that, progress is COUNTED rather than tracked. "How many of this
// list still need a call" is a COUNT over the same predicate the queue uses, so
// it cannot drift from what the caller is about to be given.

import { Router } from 'express';
import pool from '../db/pool';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();
router.use(authenticate);

const str = (v: unknown, max = 255): string | null => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};

export interface ListRow {
  id: string;
  name: string;
  import_batch_id: string | null;
  tag: string | null;
  preacher_id: string | null;
  status_slug: string | null;
  source: string | null;
  city: string | null;
  min_external_total: string | null;
}

/**
 * Turn a list's saved filter into SQL.
 *
 * Exported because the queue in crm.ts needs exactly this predicate - if the
 * two ever drifted apart, the count on the list card and the leads the caller
 * is handed would disagree, which is the one thing this design exists to stop.
 *
 * Returns nothing for a null list, which is how "Everything" is expressed: no
 * extra conditions, the old global queue.
 */
export function listPredicate(
  list: ListRow | null,
  startIdx: number
): { sql: string; values: unknown[]; next: number } {
  if (!list) return { sql: '', values: [], next: startIdx };

  const conds: string[] = [];
  const values: unknown[] = [];
  let i = startIdx;

  if (list.import_batch_id) {
    conds.push(`l.import_batch_id = $${i++}`);
    values.push(list.import_batch_id);
  }
  if (list.tag) {
    conds.push(`$${i++} = ANY(l.tags)`);
    values.push(list.tag);
  }
  if (list.preacher_id) {
    conds.push(`l.preacher_id = $${i++}`);
    values.push(list.preacher_id);
  }
  if (list.status_slug) {
    conds.push(`l.status = $${i++}`);
    values.push(list.status_slug);
  }
  if (list.source) {
    conds.push(`l.source = $${i++}`);
    values.push(list.source);
  }
  if (list.city) {
    // Loose on purpose: sheets carry "Vizag", "Visakhapatnam" and "VIZAG" in
    // the same column, and a list that matched only one of them would quietly
    // leave most of the city out.
    conds.push(`l.city ILIKE $${i++}`);
    values.push(`%${list.city}%`);
  }
  if (list.min_external_total !== null && list.min_external_total !== undefined) {
    conds.push(`l.external_total_donated >= $${i++}`);
    values.push(list.min_external_total);
  }

  return { sql: conds.length ? ` AND ${conds.join(' AND ')}` : '', values, next: i };
}

/**
 * The rule for "still needs a call", in one place.
 *
 * Identical to the queue's own filter in crm.ts. It is a string constant rather
 * than duplicated text so that changing what counts as callable changes the
 * count and the queue together.
 */
export const CALLABLE = `
  l.do_not_call = FALSE
  AND COALESCE(s.is_open, TRUE) = TRUE
  AND l.invalid_reason IS NULL`;

/**
 * "Due now" - never scheduled, or scheduled for today or earlier.
 *
 * The one-day window is the queue's own: a callback set for this evening should
 * appear in this morning's work, because a caller who sees it only after six
 * o'clock will not be at their desk.
 */
export const DUE_NOW = `
  (l.next_follow_up_at IS NULL OR l.next_follow_up_at < NOW() + INTERVAL '1 day')`;

/** How many times a number is tried before the queue gives up on it. */
export async function maxAttempts(): Promise<number> {
  const r = await pool.query(`SELECT value FROM crm_settings WHERE key = 'max_attempts'`);
  return Number(r.rows[0]?.value ?? 6);
}

export async function loadList(id: string): Promise<ListRow | null> {
  if (!id) return null;
  const r = await pool.query(`SELECT * FROM calling_lists WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

/* ------------------------------------------------------------------- lists */

/**
 * GET /lists - every list with how much of it is left.
 *
 * The counts are what make this a screen worth opening rather than an admin
 * page: a caller choosing where to spend the next two hours needs to see that
 * one list has 12 left and another has 900.
 *
 * `mine` marks the lists an admin has handed to this caller, so the screen can
 * put them first without a second request.
 */
router.get('/lists', async (req, res) => {
  const includeRetired = req.query.all === 'true';
  const userId = req.user?.userId ?? null;

  try {
    const rows = await pool.query(
      // `sess` rather than `s` for the open session: inside the LATERAL below,
      // `s` has to be crm_statuses, because that is what CALLABLE and DUE_NOW
      // refer to and those two constants have to read identically to the
      // queue's own WHERE clause to be worth having.
      `SELECT cl.*,
              u.name AS created_by_name,
              pr.code AS preacher_code, pr.name AS preacher_name,
              b.filename AS batch_filename, b.sheet_name AS batch_sheet,
              a.id IS NOT NULL AS assigned_to_me,
              a.note AS assignment_note,
              c.total, c.to_call, c.never_called, c.called, c.converted,
              sess.id AS session_id,
              sess.calls_logged AS session_calls,
              sess.last_active_at AS session_last_active
         FROM calling_lists cl
         LEFT JOIN users u      ON cl.created_by = u.id
         LEFT JOIN preachers pr ON cl.preacher_id = pr.id
         LEFT JOIN lead_import_batches b ON cl.import_batch_id = b.id
         LEFT JOIN calling_list_assignments a ON a.list_id = cl.id AND a.user_id = $1::uuid
         LEFT JOIN calling_sessions sess
                ON sess.list_id = cl.id AND sess.user_id = $1::uuid AND sess.ended_at IS NULL
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS total,
                  -- to_call is the number that matters, and it is deliberately
                  -- the exact thing the queue would hand over right now: open,
                  -- dialable, not out of attempts, and either never scheduled
                  -- or due. Anything looser would promise a caller work the
                  -- queue then refuses to give them.
                  COUNT(*) FILTER (WHERE ${CALLABLE} AND ${DUE_NOW} AND l.call_attempts < $3)::int AS to_call,
                  COUNT(*) FILTER (WHERE l.last_contacted_at IS NULL)::int AS never_called,
                  COUNT(*) FILTER (WHERE l.last_contacted_at IS NOT NULL)::int AS called,
                  COUNT(*) FILTER (WHERE l.converted_at IS NOT NULL)::int AS converted
             FROM leads l
             LEFT JOIN crm_statuses s ON l.status = s.slug
            WHERE (cl.import_batch_id IS NULL OR l.import_batch_id = cl.import_batch_id)
              AND (cl.tag         IS NULL OR cl.tag = ANY(l.tags))
              AND (cl.preacher_id IS NULL OR l.preacher_id = cl.preacher_id)
              AND (cl.status_slug IS NULL OR l.status = cl.status_slug)
              AND (cl.source      IS NULL OR l.source = cl.source)
              AND (cl.city        IS NULL OR l.city ILIKE '%' || cl.city || '%')
              AND (cl.min_external_total IS NULL OR l.external_total_donated >= cl.min_external_total)
         ) c ON TRUE
        WHERE ($2::boolean OR cl.active)
        ORDER BY assigned_to_me DESC, cl.active DESC, c.to_call DESC NULLS LAST, cl.name`,
      [userId, includeRetired, await maxAttempts()]
    );
    res.json({ lists: rows.rows });
  } catch (err) {
    console.error('crm.listLists error:', err);
    res.status(500).json({ error: 'Could not load the calling lists' });
  }
});

// Making, editing and staffing calling lists is how the office decides who
// gets rung and by whom. Left open, a caller could reassign a list away from a
// colleague mid-campaign or retire it outright.
router.post('/lists', authorize('admin', 'accountant'), async (req, res) => {
  const name = str(req.body?.name, 160);
  if (!name) return res.status(400).json({ error: 'A list needs a name' });

  const b = req.body ?? {};
  try {
    const r = await pool.query(
      `INSERT INTO calling_lists
         (name, description, import_batch_id, tag, preacher_id, status_slug, source, city,
          min_external_total, origin, created_by)
       VALUES ($1,$2,$3::uuid,$4,$5::uuid,$6,$7,$8,$9::numeric,$10,$11::uuid)
       RETURNING *`,
      [
        name,
        str(b.description, 2000),
        str(b.import_batch_id, 36),
        str(b.tag, 40),
        str(b.preacher_id, 36),
        str(b.status_slug, 40),
        str(b.source, 40),
        str(b.city, 80),
        b.min_external_total === '' || b.min_external_total === undefined || b.min_external_total === null
          ? null
          : Number(b.min_external_total),
        str(b.origin, 12) ?? 'manual',
        req.user?.userId ?? null,
      ]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('crm.createList error:', err);
    res.status(500).json({ error: 'Could not create that list' });
  }
});

router.put('/lists/:id', authorize('admin', 'accountant'), async (req, res) => {
  const b = req.body ?? {};
  try {
    const r = await pool.query(
      `UPDATE calling_lists SET
         name        = COALESCE($1, name),
         description = COALESCE($2, description),
         active      = COALESCE($3::boolean, active),
         updated_at  = NOW()
       WHERE id = $4 RETURNING *`,
      [
        str(b.name, 160),
        str(b.description, 2000),
        typeof b.active === 'boolean' ? b.active : null,
        req.params.id,
      ]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'No such list' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('crm.updateList error:', err);
    res.status(500).json({ error: 'Could not save that list' });
  }
});

/* ------------------------------------------------------------- assignments */

/**
 * PUT /lists/:id/assignees - who this list has been handed to.
 *
 * The whole set is replaced in one call rather than offering add and remove
 * separately: the screen is a set of checkboxes, and sending what the
 * checkboxes now say is both simpler and free of the race where two admins
 * each remove the other's person.
 */
router.put('/lists/:id/assignees', authorize('admin', 'accountant'), async (req, res) => {
  const ids: string[] = Array.isArray(req.body?.user_ids) ? req.body.user_ids.map(String) : [];
  const note = str(req.body?.note, 2000);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM calling_list_assignments WHERE list_id = $1 AND NOT (user_id = ANY($2::uuid[]))`, [
      req.params.id,
      ids,
    ]);
    for (const uid of ids) {
      await client.query(
        `INSERT INTO calling_list_assignments (list_id, user_id, assigned_by, note)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (list_id, user_id) DO UPDATE SET note = COALESCE(EXCLUDED.note, calling_list_assignments.note)`,
        [req.params.id, uid, req.user?.userId ?? null, note]
      );
    }
    await client.query('COMMIT');

    const rows = await client.query(
      `SELECT a.*, u.name AS user_name FROM calling_list_assignments a
         JOIN users u ON a.user_id = u.id WHERE a.list_id = $1 ORDER BY u.name`,
      [req.params.id]
    );
    res.json({ assignees: rows.rows });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('crm.assignList error:', err);
    res.status(500).json({ error: 'Could not save who this list is for' });
  } finally {
    client.release();
  }
});

router.get('/lists/:id/assignees', async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT a.*, u.name AS user_name, u.role AS user_role
         FROM calling_list_assignments a JOIN users u ON a.user_id = u.id
        WHERE a.list_id = $1 ORDER BY u.name`,
      [req.params.id]
    );
    res.json({ assignees: rows.rows });
  } catch (err) {
    console.error('crm.listAssignees error:', err);
    res.status(500).json({ error: 'Could not load who this list is for' });
  }
});

/* ---------------------------------------------------------------- sessions */

/**
 * POST /sessions - open or resume a run at a list.
 *
 * Idempotent by design. Pressing Start calling twice, or opening it in a second
 * tab, must not create a second session and split the day's tally in half - so
 * an open session for this caller and list is returned as it stands.
 *
 * list_id omitted means Everything, which is stored as NULL and made unique by
 * the partial index's COALESCE to the zero UUID.
 */
router.post('/sessions', async (req, res) => {
  const listId = str(req.body?.list_id, 36);
  try {
    if (listId) {
      const exists = await pool.query(`SELECT id FROM calling_lists WHERE id = $1 AND active`, [listId]);
      if (!exists.rows.length) return res.status(404).json({ error: 'That list is not available' });
    }

    const r = await pool.query(
      `INSERT INTO calling_sessions (user_id, list_id)
       VALUES ($1,$2::uuid)
       ON CONFLICT (user_id, COALESCE(list_id, '00000000-0000-0000-0000-000000000000'::uuid))
         WHERE ended_at IS NULL
       DO UPDATE SET last_active_at = NOW()
       RETURNING *`,
      [req.user?.userId ?? null, listId]
    );
    res.status(201).json({ session: r.rows[0], resumed: r.rows[0].calls_logged > 0 });
  } catch (err) {
    console.error('crm.openSession error:', err);
    res.status(500).json({ error: 'Could not start that calling session' });
  }
});

/**
 * GET /sessions/current - what this caller had open, if anything.
 *
 * This is what makes "stop today, continue tomorrow" real: the caller opens
 * DRM and the screen already knows which list they were on and how far they
 * got, without them having to remember.
 */
router.get('/sessions/current', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT s.*, cl.name AS list_name, cl.import_batch_id,
              s.paused_at IS NOT NULL AS paused
         FROM calling_sessions s
         LEFT JOIN calling_lists cl ON s.list_id = cl.id
        WHERE s.user_id = $1 AND s.ended_at IS NULL
        ORDER BY s.last_active_at DESC
        LIMIT 1`,
      [req.user?.userId ?? null]
    );
    res.json({ session: r.rows[0] ?? null });
  } catch (err) {
    console.error('crm.currentSession error:', err);
    res.status(500).json({ error: 'Could not load your calling session' });
  }
});

/**
 * POST /sessions/:id/pause - stepping away, not stopping.
 *
 * WHY THIS IS NOT "END"
 * Ending a run is what makes tomorrow's screen offer a fresh start instead of
 * the list somebody was halfway through, so a caller going to lunch must not
 * end anything. Pausing keeps the run open - it is still the one "where you
 * left off" finds - and only records that they stepped away and when.
 *
 * Resuming is just opening the session again, which POST /sessions already
 * does, so there is no separate resume route to forget to call.
 */
router.post('/sessions/:id/pause', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE calling_sessions SET
         paused_at = NOW(),
         pause_note = $3,
         last_active_at = NOW()
       WHERE id = $1 AND user_id = $2 AND ended_at IS NULL
       RETURNING *`,
      [req.params.id, req.user?.userId ?? null, str(req.body?.note, 200)]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'That run is already finished' });
    res.json({ session: r.rows[0] });
  } catch (err) {
    console.error('crm.pauseSession error:', err);
    res.status(500).json({ error: 'Could not pause that' });
  }
});

/** POST /sessions/:id/resume - back at the desk. */
router.post('/sessions/:id/resume', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE calling_sessions SET paused_at = NULL, pause_note = NULL, last_active_at = NOW()
        WHERE id = $1 AND user_id = $2 AND ended_at IS NULL
        RETURNING *`,
      [req.params.id, req.user?.userId ?? null]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'That run is already finished' });
    res.json({ session: r.rows[0] });
  } catch (err) {
    console.error('crm.resumeSession error:', err);
    res.status(500).json({ error: 'Could not resume that' });
  }
});

/** POST /sessions/:id/end - stopping for the day. */
router.post('/sessions/:id/end', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE calling_sessions SET ended_at = NOW()
        WHERE id = $1 AND user_id = $2 AND ended_at IS NULL
        RETURNING *`,
      [req.params.id, req.user?.userId ?? null]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'That session is already finished' });
    res.json({ session: r.rows[0] });
  } catch (err) {
    console.error('crm.endSession error:', err);
    res.status(500).json({ error: 'Could not finish that session' });
  }
});

/**
 * GET /sessions/history - the caller's recent shifts.
 *
 * Read from the activity log rather than from the session counters, because
 * the log is the thing reports are built on and a history screen that
 * disagreed with the reports would be worse than no history screen.
 */
router.get('/sessions/history', async (req, res) => {
  // Only an admin may ask about somebody else. The user ids are handed out
  // freely by /config to populate dropdowns, so without this any caller could
  // read a colleague's last thirty shifts by pasting their id into the query.
  const asked = str(req.query.user_id, 36);
  const userId =
    asked && req.user?.role === 'admin' ? asked : req.user?.userId ?? null;
  try {
    const rows = await pool.query(
      `SELECT s.id, s.started_at, s.last_active_at, s.ended_at,
              cl.name AS list_name,
              COUNT(a.id)::int AS calls,
              -- The stored column, not a recomputation from the disposition
              -- table. The schema says why: a caller can mark a call connected
              -- that ended in an outcome the temple later reclassifies, and
              -- the connected/unanswered split must not shift under old
              -- reports. Deriving it here made every past shift in this screen
              -- change the moment somebody edited a disposition in Settings,
              -- while the dashboard and the caller report kept the real
              -- numbers - two screens, two answers, same shift.
              COUNT(a.id) FILTER (WHERE a.connected)::int AS connected
         FROM calling_sessions s
         LEFT JOIN calling_lists cl ON s.list_id = cl.id
         LEFT JOIN lead_activities a ON a.session_id = s.id AND a.kind = 'call'
        WHERE s.user_id = $1
        GROUP BY s.id, cl.name
        ORDER BY s.last_active_at DESC
        LIMIT 30`,
      [userId]
    );
    res.json({ sessions: rows.rows });
  } catch (err) {
    console.error('crm.sessionHistory error:', err);
    res.status(500).json({ error: 'Could not load your calling history' });
  }
});

export default router;
