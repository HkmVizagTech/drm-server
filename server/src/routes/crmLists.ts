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
  members_only?: boolean;
}

/**
 * Whether lead `l` belongs to list `cl`, as SQL - THE one definition.
 *
 * There used to be three: one here with bound parameters, one inlined in the
 * leads screen's filter for "See them", and one inside the list cards' count.
 * They agreed only because nobody had changed one of them yet. Every reader
 * now goes through this, so adding a filter field (or hand-picked members)
 * changes the queue, the count and the leads screen together.
 *
 * Hand-picked members: an 'include' row adds a person whatever the filter
 * says; an 'exclude' row removes them from what the filter found. A
 * members_only list finds nobody by filter, so it is exactly its includes.
 */
export const LIST_MATCH = (cl: string, l: string) => `(
  (
    NOT ${cl}.members_only
    AND (${cl}.import_batch_id IS NULL OR ${l}.import_batch_id = ${cl}.import_batch_id)
    AND (${cl}.tag         IS NULL OR ${cl}.tag = ANY(${l}.tags))
    AND (${cl}.preacher_id IS NULL OR ${l}.preacher_id = ${cl}.preacher_id)
    AND (${cl}.status_slug IS NULL OR ${l}.status = ${cl}.status_slug)
    AND (${cl}.source      IS NULL OR ${l}.source = ${cl}.source)
    -- Loose on purpose: sheets carry "Vizag", "Visakhapatnam" and "VIZAG" in
    -- the same column.
    AND (${cl}.city        IS NULL OR ${l}.city ILIKE '%' || ${cl}.city || '%')
    AND (${cl}.min_external_total IS NULL OR ${l}.external_total_donated >= ${cl}.min_external_total)
    AND NOT EXISTS (SELECT 1 FROM calling_list_members xm
                     WHERE xm.list_id = ${cl}.id AND xm.lead_id = ${l}.id AND xm.kind = 'exclude')
  )
  OR EXISTS (SELECT 1 FROM calling_list_members im
              WHERE im.list_id = ${cl}.id AND im.lead_id = ${l}.id AND im.kind = 'include')
)`;

/**
 * A list's membership as an extra AND clause on a query over `leads l`.
 *
 * Returns nothing for a null list, which is how "Everything" is expressed.
 */
export function listPredicate(
  list: ListRow | null,
  startIdx: number
): { sql: string; values: unknown[]; next: number } {
  if (!list) return { sql: '', values: [], next: startIdx };
  return {
    sql: ` AND EXISTS (SELECT 1 FROM calling_lists cl WHERE cl.id = $${startIdx}::uuid AND ${LIST_MATCH('cl', 'l')})`,
    values: [list.id],
    next: startIdx + 1,
  };
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
 * "Due now" - never scheduled, or scheduled for any time up to the end of
 * today (Indian time - the database session runs on IST, so date_trunc('day')
 * is IST midnight).
 *
 * It used to be "before this moment tomorrow", a rolling 24 hours. So a
 * callback booked for "tomorrow 10am" at 11am today was already due - the
 * caller said "I'll ring you tomorrow" and the queue handed the person back
 * within the hour. Today means today.
 */
export const DUE_NOW = `
  (l.next_follow_up_at IS NULL OR l.next_follow_up_at < date_trunc('day', NOW()) + INTERVAL '1 day')`;

/**
 * An attempt made on the main site's standalone /donations page.
 *
 * That page is its own campaign with its own team and dashboard (see
 * donationAdmin.controller.js on hkmsite2.0-server, which scopes itself the
 * same way: sourcePage "donations" or "donations/<anything>", the legacy
 * "/donations", and the old type "Donation" - which reaches DRM as the
 * purpose when there is no seva name). Its unfinished payments are not this
 * calling team's to chase, so Nearly gave leaves them out everywhere: the
 * list, its totals, the runs, and the "tried to give" box on the call screen.
 * Matched on the stored rows rather than filtered on the site, so attempts
 * already synced disappear too, with nothing to redeploy.
 */
export const FROM_DONATIONS_PAGE = (a: string) => `(
  ${a}.source_site = 'hkmv'
  AND (COALESCE(${a}.source_page, '') ~* '^(https?://[^/]+)?/?donations(/|\\?|#|$)'
       OR COALESCE(${a}.purpose, '') = 'Donation'))`;

/** Not on another caller's call right now. $n is the caller's own id. */
export const NOT_CLAIMED_BY_OTHERS = (n: number) => `
  (l.claimed_by IS NULL OR l.claimed_by = $${n}::uuid OR l.claimed_until < NOW())`;

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
              c.total, c.to_call, c.to_call_all, c.never_called, c.called, c.converted,
              mem.added_by_hand, mem.left_out,
              sess.id AS session_id,
              sess.calls_logged AS session_calls,
              sess.last_active_at AS session_last_active
         FROM calling_lists cl
         LEFT JOIN users u      ON cl.created_by = u.id
         LEFT JOIN preachers pr ON cl.preacher_id = pr.id
         LEFT JOIN lead_import_batches b ON cl.import_batch_id = b.id
         LEFT JOIN calling_list_assignments a ON a.list_id = cl.id AND a.user_id = $1::uuid
         LEFT JOIN calling_sessions sess
                ON sess.source_key = 'list:' || cl.id::text AND sess.user_id = $1::uuid AND sess.ended_at IS NULL
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS total,
                  -- to_call is the number that matters, and it is exactly what
                  -- a session started on this list would hand THIS person:
                  -- open, dialable, not out of attempts, due by the end of
                  -- today, and theirs or nobody's. It used to leave out that
                  -- last part, so a caller saw "40 to call" on the card and
                  -- was handed 12 - the other 28 belonged to colleagues.
                  COUNT(*) FILTER (WHERE ${CALLABLE} AND ${DUE_NOW} AND l.call_attempts < $3
                                     AND (l.assigned_to = $1::uuid OR l.assigned_to IS NULL))::int AS to_call,
                  -- The same for the whole team, for the admin's view of a
                  -- list's progress.
                  COUNT(*) FILTER (WHERE ${CALLABLE} AND ${DUE_NOW} AND l.call_attempts < $3)::int AS to_call_all,
                  COUNT(*) FILTER (WHERE l.last_contacted_at IS NULL)::int AS never_called,
                  COUNT(*) FILTER (WHERE l.last_contacted_at IS NOT NULL)::int AS called,
                  COUNT(*) FILTER (WHERE l.converted_at IS NOT NULL)::int AS converted
             FROM leads l
             LEFT JOIN crm_statuses s ON l.status = s.slug
            WHERE ${LIST_MATCH('cl', 'l')}
         ) c ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE m.kind = 'include')::int AS added_by_hand,
                  COUNT(*) FILTER (WHERE m.kind = 'exclude')::int AS left_out
             FROM calling_list_members m WHERE m.list_id = cl.id
         ) mem ON TRUE
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
  if (!name) return res.status(400).json({ error: 'Enter a list name.' });

  const b = req.body ?? {};
  try {
    const r = await pool.query(
      `INSERT INTO calling_lists
         (name, description, import_batch_id, tag, preacher_id, status_slug, source, city,
          min_external_total, origin, created_by, members_only)
       VALUES ($1,$2,$3::uuid,$4,$5::uuid,$6,$7,$8,$9::numeric,$10,$11::uuid,$12::boolean)
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
        b.members_only === true,
      ]
    );
    // A list made from a selection on the leads screen arrives with its
    // people, so "make a list of these" is one action rather than two.
    const leadIds = uuids(b.lead_ids);
    if (leadIds.length) await addMembers(r.rows[0].id, leadIds, 'include', req.user?.userId ?? null);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('crm.createList error:', err);
    res.status(500).json({ error: 'Could not create that list' });
  }
});

/**
 * PUT /lists/:id - rename, retire, or change what the list selects.
 *
 * The filter fields used to be fixed at creation, so a list built on the
 * wrong city had to be retired and rebuilt - losing everybody's place in it.
 * A field sent as "" or null clears it; a field not sent is left alone.
 */
router.put('/lists/:id', authorize('admin', 'accountant'), async (req, res) => {
  const b = req.body ?? {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
  const sets: string[] = [];
  const values: unknown[] = [];
  const set = (col: string, v: unknown, cast = '') => {
    values.push(v);
    sets.push(`${col} = $${values.length}${cast}`);
  };
  if (has('name')) {
    const n = str(b.name, 160);
    if (!n) return res.status(400).json({ error: 'Enter a list name.' });
    set('name', n);
  }
  if (has('description')) set('description', str(b.description, 2000));
  if (typeof b.active === 'boolean') set('active', b.active, '::boolean');
  if (typeof b.members_only === 'boolean') set('members_only', b.members_only, '::boolean');
  if (has('tag')) set('tag', str(b.tag, 40));
  if (has('preacher_id')) set('preacher_id', str(b.preacher_id, 36), '::uuid');
  if (has('status_slug')) set('status_slug', str(b.status_slug, 40));
  if (has('source')) set('source', str(b.source, 40));
  if (has('city')) set('city', str(b.city, 80));
  if (has('import_batch_id')) set('import_batch_id', str(b.import_batch_id, 36), '::uuid');
  if (has('min_external_total'))
    set(
      'min_external_total',
      b.min_external_total === '' || b.min_external_total === null || !Number.isFinite(Number(b.min_external_total))
        ? null
        : Number(b.min_external_total),
      '::numeric'
    );
  try {
    if (!sets.length) {
      const r = await pool.query(`SELECT * FROM calling_lists WHERE id = $1`, [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'List not found.' });
      return res.json(r.rows[0]);
    }
    values.push(req.params.id);
    const r = await pool.query(
      `UPDATE calling_lists SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (!r.rows.length) return res.status(404).json({ error: 'List not found.' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('crm.updateList error:', err);
    res.status(500).json({ error: 'Could not save that list' });
  }
});

/**
 * GET /lists/preview - how many people a filter would find, before saving it.
 *
 * Run through LIST_MATCH against a throwaway row built from the query, so the
 * number on the form is computed by the same SQL the saved list will use.
 */
router.get('/lists/preview', async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const minExt = Number(q.min_external_total);
  try {
    const r = await pool.query(
      `WITH cl AS (
         SELECT '00000000-0000-0000-0000-000000000000'::uuid AS id,
                $1::uuid AS import_batch_id, $2::text AS tag, $3::uuid AS preacher_id,
                $4::text AS status_slug, $5::text AS source, $6::text AS city,
                $7::numeric AS min_external_total, FALSE AS members_only
       )
       SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE ${CALLABLE} AND ${DUE_NOW} AND l.call_attempts < $8)::int AS to_call
         FROM leads l
         LEFT JOIN crm_statuses s ON l.status = s.slug, cl
        WHERE ${LIST_MATCH('cl', 'l')}`,
      [
        str(q.import_batch_id, 36),
        str(q.tag, 40),
        str(q.preacher_id, 36),
        str(q.status_slug, 40),
        str(q.source, 40),
        str(q.city, 80),
        q.min_external_total !== undefined && q.min_external_total !== '' && Number.isFinite(minExt) ? minExt : null,
        await maxAttempts(),
      ]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('crm.previewList error:', err);
    res.status(500).json({ error: 'Could not count that' });
  }
});

/* ------------------------------------------------------------- members */

function uuids(v: unknown): string[] {
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return Array.isArray(v) ? [...new Set(v.map(String).filter((x) => re.test(x)))].slice(0, 5000) : [];
}

async function addMembers(listId: string, leadIds: string[], kind: 'include' | 'exclude', by: string | null) {
  const r = await pool.query(
    `INSERT INTO calling_list_members (list_id, lead_id, kind, added_by)
     SELECT $1::uuid, id, $3, $4::uuid FROM leads WHERE id = ANY($2::uuid[])
     ON CONFLICT (list_id, lead_id) DO UPDATE SET kind = EXCLUDED.kind, added_by = EXCLUDED.added_by, created_at = NOW()
     RETURNING lead_id`,
    [listId, leadIds, kind, by]
  );
  return r.rowCount ?? 0;
}

/**
 * POST /lists/:id/members - add people to a list by hand, or leave them out.
 *
 * { lead_ids, action: 'include' | 'exclude' | 'remove' }. 'remove' forgets
 * the hand-made decision, so the person is in or out by the filter again.
 */
router.post('/lists/:id/members', authorize('admin', 'accountant'), async (req, res) => {
  const ids = uuids(req.body?.lead_ids);
  const action = String(req.body?.action ?? 'include');
  if (!ids.length) return res.status(400).json({ error: 'Pick at least one person' });
  try {
    const list = await pool.query(`SELECT id FROM calling_lists WHERE id = $1`, [req.params.id]);
    if (!list.rows.length) return res.status(404).json({ error: 'List not found.' });
    let changed = 0;
    if (action === 'remove') {
      const r = await pool.query(`DELETE FROM calling_list_members WHERE list_id = $1 AND lead_id = ANY($2::uuid[])`, [
        req.params.id,
        ids,
      ]);
      changed = r.rowCount ?? 0;
    } else if (action === 'include' || action === 'exclude') {
      changed = await addMembers(String(req.params.id), ids, action, req.user?.userId ?? null);
    } else return res.status(400).json({ error: `Unknown action "${action}"` });
    res.json({ requested: ids.length, changed });
  } catch (err) {
    console.error('crm.listMembers error:', err);
    res.status(500).json({ error: 'Could not update the list. Try again.' });
  }
});

/** GET /lists/:id/members - the hand-made decisions, for the list editor. */
router.get('/lists/:id/members', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT m.lead_id, m.kind, m.created_at, l.name, l.phone, u.name AS added_by_name
         FROM calling_list_members m
         JOIN leads l ON l.id = m.lead_id
         LEFT JOIN users u ON u.id = m.added_by
        WHERE m.list_id = $1
        ORDER BY m.kind, lower(l.name) NULLS LAST
        LIMIT 2000`,
      [req.params.id]
    );
    res.json({ members: r.rows });
  } catch (err) {
    console.error('crm.getListMembers error:', err);
    res.status(500).json({ error: 'Could not load that list' });
  }
});

/**
 * POST /lists/:id/split - share a list out between callers.
 *
 * Deals the list's callable people round-robin, in the order the queue would
 * ring them, so every caller gets a fair share of the urgent ones rather than
 * one person getting all the overdue promises. Only people nobody owns are
 * dealt unless `include_assigned` is set: taking a colleague's leads off them
 * is a decision, not a side effect.
 *
 * Also hands the list itself to each of them, so it is first on their start
 * screen tomorrow.
 */
router.post('/lists/:id/split', authorize('admin', 'accountant'), async (req, res) => {
  const userIds = uuids(req.body?.user_ids);
  if (!userIds.length) return res.status(400).json({ error: 'Pick the callers.' });
  const includeAssigned = req.body?.include_assigned === true;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const people = await client.query(
      `SELECT id FROM users WHERE id = ANY($1::uuid[]) AND active IS DISTINCT FROM FALSE`,
      [userIds]
    );
    const valid = userIds.filter((u) => people.rows.some((r) => r.id === u));
    if (!valid.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'None of them are callers.' });
    }

    const leads = await client.query(
      `SELECT l.id FROM leads l
         LEFT JOIN crm_statuses s ON l.status = s.slug
         JOIN calling_lists cl ON cl.id = $1::uuid
        WHERE ${LIST_MATCH('cl', 'l')}
          AND ${CALLABLE}
          AND ($2::boolean OR l.assigned_to IS NULL)
        ORDER BY CASE WHEN l.next_follow_up_at < NOW() THEN 0
                      WHEN l.next_follow_up_at IS NOT NULL THEN 1
                      WHEN l.last_contacted_at IS NULL THEN 2 ELSE 3 END,
                 l.next_follow_up_at ASC NULLS LAST, l.created_at ASC`,
      [req.params.id, includeAssigned]
    );

    const buckets = new Map<string, string[]>(valid.map((u) => [u, []]));
    leads.rows.forEach((r, n) => buckets.get(valid[n % valid.length])!.push(r.id));

    for (const [uid, ids] of buckets) {
      if (ids.length) {
        await client.query(
          `UPDATE leads SET assigned_to = $1::uuid, assigned_at = NOW(), updated_at = NOW()
            WHERE id = ANY($2::uuid[])`,
          [uid, ids]
        );
        await client.query(
          `INSERT INTO lead_activities (lead_id, user_id, kind, to_value, note)
           SELECT id, $2::uuid, 'assignment', $1::text, 'Shared from a list'
             FROM unnest($3::uuid[]) AS id`,
          [uid, req.user?.userId ?? null, ids]
        );
      }
      await client.query(
        `INSERT INTO calling_list_assignments (list_id, user_id, assigned_by)
         VALUES ($1,$2,$3) ON CONFLICT (list_id, user_id) DO NOTHING`,
        [req.params.id, uid, req.user?.userId ?? null]
      );
    }
    await client.query('COMMIT');

    const names = await pool.query(`SELECT id, name FROM users WHERE id = ANY($1::uuid[])`, [valid]);
    res.json({
      dealt: leads.rows.length,
      shares: valid.map((u) => ({
        user_id: u,
        name: names.rows.find((r) => r.id === u)?.name ?? null,
        count: buckets.get(u)!.length,
      })),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('crm.splitList error:', err);
    res.status(500).json({ error: 'Could not share the list. Try again.' });
  } finally {
    client.release();
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
    res.status(500).json({ error: 'Could not save. Try again.' });
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
    res.status(500).json({ error: 'Could not load. Try again.' });
  }
});

export default router;
