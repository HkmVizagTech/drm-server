// A caller's run: who to ring, in what order, and where they are in it.
//
// See the long note above calling_session_items in schema.sql for why a
// session is now a snapshot with a position rather than a tally. In short:
//
//   - The caller chooses WHO (a list, Nearly gave, today's follow-ups,
//     promises due, a hand-picked selection) on the start screen.
//   - Pressing Start takes an ordered snapshot of who that finds.
//   - Next / Previous / Skip / Jump / "back to the skipped ones" move along
//     it, and the position is stored here, so a refresh, a lunch break or a
//     different phone carries on from the same person.
//   - Whoever is on screen is CLAIMED, so a colleague's session on the same
//     list steps past them. Claims expire on their own.
//   - Every step re-checks the person before handing them over. A snapshot
//     is a plan made at 10am; by 3pm somebody may have rung them, they may
//     have given, or asked not to be called. Those are marked "taken" with the
//     reason and skipped, never put in front of the caller.
//
// THE COUNT ON THE START SCREEN IS THE SNAPSHOT
// Both are produced by sourceQuery() below. "Nearly gave · 38" on the card and
// 38 people in the run is not a coincidence that holds until somebody edits
// one of two queries - there is only one query.

import { Router } from 'express';
import pool from '../db/pool';
import { authenticate } from '../middleware/auth';
import { CALLABLE, DUE_NOW, FROM_DONATIONS_PAGE, LIST_MATCH, maxAttempts } from './crmLists';
import {
  LEAD_COLUMNS, LEAD_JOINS, buildLeadFilters, leadScopeFor,
  abandonedRowsFor, adoptAbandonedRows,
} from './crm';

const router = Router();
router.use(authenticate);

const str = (v: unknown, max = 255): string | null => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long a lead stays claimed without the screen saying it is still open. */
const CLAIM_MINUTES = 15;
/** How many people a snapshot takes at a time. More are added when it runs out. */
const SNAPSHOT_SIZE = 400;

export type SourceKind =
  | 'everything' | 'mine' | 'list' | 'follow_ups' | 'reminders' | 'nearly_gave' | 'selection';

export interface Source {
  kind: SourceKind;
  list_id?: string | null;
  lead_ids?: string[];
  filters?: Record<string, unknown>;
  label?: string | null;
}

const KINDS: SourceKind[] = ['everything', 'mine', 'list', 'follow_ups', 'reminders', 'nearly_gave', 'selection'];

const LABELS: Record<SourceKind, string> = {
  everything: 'Everyone due',
  mine: 'My leads',
  list: 'A calling list',
  follow_ups: 'Follow-ups due',
  reminders: 'Promises due',
  nearly_gave: 'Nearly gave',
  selection: 'Picked by hand',
};

function sourceKey(src: Source): string {
  return src.kind === 'list' ? `list:${src.list_id}` : src.kind;
}

/** Lighter than LEAD_JOINS - no per-row donation sum - for counting and ordering. */
const LITE_JOINS = `
  FROM leads l
  LEFT JOIN crm_statuses s ON l.status = s.slug
  LEFT JOIN preachers pr ON l.preacher_id = pr.id`;

/**
 * Who goes first. The queue's order, with one change: among people nobody
 * has rung yet, those who nearly gave on the website come before a cold sheet,
 * because they were reaching for their wallet days ago.
 */
export const QUEUE_ORDER = `
  CASE WHEN l.next_follow_up_at < NOW() THEN 0
       WHEN l.next_follow_up_at IS NOT NULL THEN 1
       WHEN l.last_contacted_at IS NULL AND 'abandoned' = ANY(l.tags) THEN 2
       WHEN l.last_contacted_at IS NULL THEN 3
       ELSE 4 END,
  l.next_follow_up_at ASC NULLS LAST,
  l.created_at ASC`;

/**
 * The WHERE and ORDER for a source. Used by the count on the start screen,
 * the snapshot, and topping the snapshot up - which is what keeps the three
 * from disagreeing.
 */
async function sourceQuery(
  src: Source,
  user: { userId?: string; role?: string } | undefined
): Promise<{ where: string; values: unknown[]; order: string }> {
  const me = user?.userId ?? null;
  const values: unknown[] = [];
  const p = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  const conds: string[] = [CALLABLE];
  let order = QUEUE_ORDER;

  if (src.kind === 'selection') {
    // Chosen by hand, so no due-date or attempt limit - the person picked
    // them on purpose. Still nobody uncallable, and still nobody outside what
    // this caller may see.
    const scope = await leadScopeFor(user);
    if (scope) conds.push(`(l.assigned_to = ${p(scope)}::uuid OR l.assigned_to IS NULL OR l.assigned_to IN (SELECT id FROM users WHERE role <> 'caller'))`);
    if (src.lead_ids?.length) {
      const ids = p(src.lead_ids);
      conds.push(`l.id = ANY(${ids}::uuid[])`);
      order = `array_position(${ids}::uuid[], l.id)`;
    } else if (src.filters) {
      const f = buildLeadFilters(src.filters, values.length + 1);
      values.push(...f.values);
      if (f.where) conds.push(f.where.replace(/^WHERE /, ''));
    } else {
      conds.push('FALSE');
    }
    return { where: `WHERE ${conds.join(' AND ')}`, values, order };
  }

  if (src.kind === 'reminders') {
    // A promise due today or overdue, owned by this caller or by nobody. Not
    // bound by attempts: a donor who promised is worth the seventh call.
    const meP = p(me);
    conds.push(`EXISTS (
      SELECT 1 FROM lead_reminders r
       WHERE r.lead_id = l.id AND r.status = 'open'
         AND r.due_at < date_trunc('day', NOW()) + INTERVAL '1 day'
         AND (COALESCE(r.assigned_to, l.assigned_to) = ${meP}::uuid
              OR COALESCE(r.assigned_to, l.assigned_to) IS NULL))`);
    order = `(SELECT MIN(r.due_at) FROM lead_reminders r WHERE r.lead_id = l.id AND r.status = 'open'), l.created_at`;
    return { where: `WHERE ${conds.join(' AND ')}`, values, order };
  }

  conds.push(`l.call_attempts < ${p(await maxAttempts())}`);
  conds.push(DUE_NOW);
  if (src.kind === 'mine') conds.push(`l.assigned_to = ${p(me)}::uuid`);
  else if (src.kind === 'nearly_gave' && user?.role === 'caller') {
    // Counted with the leads parked with staff who do not call, because
    // starting this run hands those to the caller (see POST /sessions) - the
    // start screen must not say 0 for a list that is about to have 17.
    conds.push(`(l.assigned_to = ${p(me)}::uuid OR l.assigned_to IS NULL
                 OR l.assigned_to IN (SELECT id FROM users WHERE role <> 'caller'))`);
  } else conds.push(`(l.assigned_to = ${p(me)}::uuid OR l.assigned_to IS NULL OR l.assigned_to IN (SELECT id FROM users WHERE role <> 'caller'))`);

  if (src.kind === 'list') {
    conds.push(`EXISTS (SELECT 1 FROM calling_lists cl WHERE cl.id = ${p(src.list_id)}::uuid AND ${LIST_MATCH('cl', 'l')})`);
  } else if (src.kind === 'follow_ups') {
    conds.push(`l.next_follow_up_at IS NOT NULL`);
  } else if (src.kind === 'nearly_gave') {
    conds.push(`'abandoned' = ANY(l.tags)`);
    // Not somebody who only ever tried on the standalone /donations page -
    // a lead adopted from there before that page was left out of the list.
    conds.push(`NOT (
      EXISTS (SELECT 1 FROM abandoned_attempts a WHERE a.phone = l.phone AND ${FROM_DONATIONS_PAGE('a')})
      AND NOT EXISTS (SELECT 1 FROM abandoned_attempts a WHERE a.phone = l.phone AND NOT ${FROM_DONATIONS_PAGE('a')}))`);
  }
  return { where: `WHERE ${conds.join(' AND ')}`, values, order };
}

async function countSource(src: Source, user: { userId?: string; role?: string } | undefined): Promise<number> {
  const q = await sourceQuery(src, user);
  const r = await pool.query(`SELECT COUNT(*)::int AS n ${LITE_JOINS} ${q.where}`, q.values);
  return r.rows[0].n;
}

/** Parse a source out of a request body, refusing anything malformed. */
function parseSource(b: Record<string, unknown>): Source | string {
  const raw = (b.source ?? null) as Record<string, unknown> | null;
  // The old screen sent just { list_id }.
  if (!raw) {
    const listId = str(b.list_id, 36);
    return listId ? { kind: 'list', list_id: listId } : { kind: 'everything' };
  }
  const kind = String(raw.kind ?? '') as SourceKind;
  if (!KINDS.includes(kind)) return 'Choose who to call';
  const src: Source = { kind, label: str(raw.label, 200) };
  if (kind === 'list') {
    src.list_id = str(raw.list_id, 36);
    if (!src.list_id || !UUID_RE.test(src.list_id)) return 'Choose a list';
  }
  if (kind === 'selection') {
    if (Array.isArray(raw.lead_ids)) {
      src.lead_ids = [...new Set(raw.lead_ids.map(String).filter((x) => UUID_RE.test(x)))].slice(0, 5000);
    } else if (raw.filters && typeof raw.filters === 'object') {
      src.filters = raw.filters as Record<string, unknown>;
    }
    if (!src.lead_ids?.length && !src.filters) return 'Pick who to call';
  }
  return src;
}

/* ---------------------------------------------------------------- claims */

/** Take the lead for this caller. False if a colleague holds it. */
async function claim(leadId: string, me: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE leads SET claimed_by = $2::uuid, claimed_until = NOW() + make_interval(mins => $3::int)
      WHERE id = $1 AND (claimed_by IS NULL OR claimed_by = $2::uuid OR claimed_until < NOW())
      RETURNING id`,
    [leadId, me, CLAIM_MINUTES]
  );
  return (r.rowCount ?? 0) > 0;
}

/** Let go of everybody this caller holds, except `keep`. */
async function releaseClaims(me: string, keep: string | null = null) {
  await pool.query(
    `UPDATE leads SET claimed_by = NULL, claimed_until = NULL
      WHERE claimed_by = $1::uuid AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [me, keep]
  );
}

/* ------------------------------------------------------------- snapshots */

/**
 * Add the next batch of people the source finds to the end of the session.
 * Anyone already in it (called, skipped or taken) is left out, so topping up
 * never hands back somebody this run has already dealt with.
 */
async function extendSnapshot(
  session: { id: string; source: Source },
  user: { userId?: string; role?: string } | undefined,
  limit = SNAPSHOT_SIZE
): Promise<number> {
  const q = await sourceQuery(session.source, user);
  const sid = `$${q.values.length + 1}`;
  const lim = `$${q.values.length + 2}`;
  const r = await pool.query(
    `INSERT INTO calling_session_items (session_id, position, lead_id)
     SELECT ${sid}::uuid,
            COALESCE((SELECT MAX(position) FROM calling_session_items WHERE session_id = ${sid}::uuid), 0)
              + (ROW_NUMBER() OVER (ORDER BY ${q.order}, l.id))::int,
            l.id
       ${LITE_JOINS}
       ${q.where}
        AND NOT EXISTS (SELECT 1 FROM calling_session_items i WHERE i.session_id = ${sid}::uuid AND i.lead_id = l.id)
      ORDER BY ${q.order}, l.id
      LIMIT ${lim}
     ON CONFLICT DO NOTHING`,
    [...q.values, session.id, limit]
  );
  return r.rowCount ?? 0;
}

interface SessionRow {
  id: string;
  user_id: string;
  source: Source;
  source_key: string;
  source_label: string | null;
  list_id: string | null;
  position: number;
  started_at: string;
  ended_at: string | null;
  paused_at: string | null;
}

async function loadSession(id: string, me: string | null): Promise<SessionRow | null> {
  if (!UUID_RE.test(id)) return null;
  const r = await pool.query(`SELECT * FROM calling_sessions WHERE id = $1 AND user_id = $2::uuid`, [id, me]);
  const s = r.rows[0];
  if (!s) return null;
  s.source = s.source ?? (s.list_id ? { kind: 'list', list_id: s.list_id } : { kind: 'everything' });
  return s;
}

/* --------------------------------------------------------------- moving */

/**
 * Why a pending person cannot be handed over now, or null if they can.
 * One query for a batch, so stepping past twenty taken people is one trip.
 */
async function checkBatch(
  sessionId: string,
  me: string,
  positions: number[]
): Promise<Map<number, string | null>> {
  const r = await pool.query(
    `SELECT i.position,
            CASE
              WHEN l.do_not_call THEN 'Asked not to be called'
              WHEN l.invalid_reason IS NOT NULL THEN 'Number is not valid'
              WHEN COALESCE(st.is_open, TRUE) = FALSE THEN 'Now ' || COALESCE(st.label, l.status)
              WHEN oc.at IS NOT NULL THEN 'Called by ' || COALESCE(oc.by_name, 'another caller')
              WHEN l.claimed_by IS NOT NULL AND l.claimed_by <> $2::uuid AND l.claimed_until > NOW()
                THEN COALESCE(cu.name, 'Someone') || ' is calling them'
              ELSE NULL END AS blocked
       FROM calling_session_items i
       JOIN leads l ON l.id = i.lead_id
       LEFT JOIN crm_statuses st ON st.slug = l.status
       LEFT JOIN users cu ON cu.id = l.claimed_by
       LEFT JOIN LATERAL (
         SELECT a.created_at AS at, u.name AS by_name
           FROM lead_activities a LEFT JOIN users u ON u.id = a.user_id
          WHERE a.lead_id = l.id AND a.kind = 'call'
            AND a.user_id IS DISTINCT FROM $2::uuid
            AND a.created_at > i.created_at
          ORDER BY a.created_at DESC LIMIT 1
       ) oc ON TRUE
      WHERE i.session_id = $1 AND i.position = ANY($3::int[])`,
    [sessionId, me, positions]
  );
  return new Map(r.rows.map((x) => [x.position as number, x.blocked as string | null]));
}

async function setPosition(sessionId: string, position: number) {
  await pool.query(
    `UPDATE calling_sessions SET position = $2, last_active_at = NOW(), paused_at = NULL, pause_note = NULL
      WHERE id = $1`,
    [sessionId, position]
  );
  await pool.query(
    `UPDATE calling_session_items SET visited_at = COALESCE(visited_at, NOW())
      WHERE session_id = $1 AND position = $2`,
    [sessionId, position]
  );
}

/** Forward to the next person who can be rung now. */
async function moveNext(
  session: SessionRow,
  user: { userId?: string; role?: string },
  opts: { skipCurrent: boolean }
): Promise<{ landed: boolean; passed: { name: string | null; reason: string }[] }> {
  const me = user.userId!;
  const passed: { name: string | null; reason: string }[] = [];

  if (opts.skipCurrent && session.position > 0) {
    await pool.query(
      `UPDATE calling_session_items SET state = 'skipped'
        WHERE session_id = $1 AND position = $2 AND state = 'pending'`,
      [session.id, session.position]
    );
  }

  let cur = session.position;
  let extended = false;
  for (let guard = 0; guard < 60; guard++) {
    const batch = await pool.query(
      `SELECT i.position, i.lead_id, l.name FROM calling_session_items i JOIN leads l ON l.id = i.lead_id
        WHERE i.session_id = $1 AND i.position > $2 AND i.state = 'pending'
        ORDER BY i.position LIMIT 25`,
      [session.id, cur]
    );
    if (!batch.rows.length) {
      // Topped up once per move, and never for a hand-picked selection: the
      // person chose exactly who to ring.
      if (!extended && session.source.kind !== 'selection') {
        extended = true;
        if ((await extendSnapshot(session, user)) > 0) continue;
      }
      break;
    }
    const blocked = await checkBatch(session.id, me, batch.rows.map((r) => r.position));
    for (const row of batch.rows) {
      cur = row.position;
      let reason = blocked.get(row.position) ?? null;
      if (!reason && !(await claim(row.lead_id, me))) reason = 'Someone else is calling them';
      if (reason) {
        await pool.query(
          `UPDATE calling_session_items SET state = 'taken', note = $3 WHERE session_id = $1 AND position = $2`,
          [session.id, row.position, reason.slice(0, 200)]
        );
        if (passed.length < 20) passed.push({ name: row.name, reason });
        continue;
      }
      await releaseClaims(me, row.lead_id);
      await setPosition(session.id, row.position);
      return { landed: true, passed };
    }
  }

  // The end. One past the last item, so Previous still works from here.
  const max = await pool.query(
    `SELECT COALESCE(MAX(position), 0)::int AS m FROM calling_session_items WHERE session_id = $1`,
    [session.id]
  );
  await releaseClaims(me);
  await setPosition(session.id, max.rows[0].m + 1);
  return { landed: false, passed };
}

/** Back to the person before - called, skipped or still pending. */
async function movePrev(session: SessionRow, me: string): Promise<boolean> {
  const before = await pool.query(
    `SELECT position, lead_id FROM calling_session_items
      WHERE session_id = $1 AND position < $2 AND state <> 'taken'
      ORDER BY position DESC LIMIT 25`,
    [session.id, session.position]
  );
  for (const row of before.rows) {
    if (await claim(row.lead_id, me)) {
      await releaseClaims(me, row.lead_id);
      await setPosition(session.id, row.position);
      return true;
    }
  }
  return false;
}

/* --------------------------------------------------------------- reading */

async function sessionState(session: SessionRow, me: string) {
  const [counts, current] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE state = 'pending')::int AS pending,
              COUNT(*) FILTER (WHERE state = 'done')::int AS done,
              COUNT(*) FILTER (WHERE state = 'skipped')::int AS skipped,
              COUNT(*) FILTER (WHERE state = 'taken')::int AS taken,
              COUNT(*) FILTER (WHERE position <= $2)::int AS reached,
              COUNT(*) FILTER (WHERE state = 'pending' AND position > $2)::int AS ahead,
              BOOL_OR(position < $2 AND state <> 'taken') AS has_prev
         FROM calling_session_items WHERE session_id = $1`,
      [session.id, session.position]
    ),
    pool.query(`SELECT * FROM calling_session_items WHERE session_id = $1 AND position = $2`, [
      session.id,
      session.position,
    ]),
  ]);

  const item = current.rows[0] ?? null;
  let lead = null;
  if (item) {
    // Heartbeat: being looked at keeps the claim alive - but not on a paused
    // or finished run, whose person was let go on purpose.
    if (!session.paused_at && !session.ended_at) await claim(item.lead_id, me);
    const [l, reminders, attempt, activities] = await Promise.all([
      pool.query(`SELECT ${LEAD_COLUMNS} ${LEAD_JOINS} WHERE l.id = $1`, [item.lead_id]),
      pool.query(
        `SELECT id, title, occasion, due_at, expected_amount, status FROM lead_reminders
          WHERE lead_id = $1 AND status = 'open' ORDER BY due_at LIMIT 5`,
        [item.lead_id]
      ),
      // What they tried to give on the website, for "you were giving ₹2,000
      // towards Annadan on Tuesday - did something go wrong?"
      pool.query(
        `SELECT a.amount, a.purpose, a.source_site, a.source_page, a.attempted_at, a.status
           FROM abandoned_attempts a JOIN leads l ON l.phone = a.phone
          WHERE l.id = $1 AND NOT ${FROM_DONATIONS_PAGE('a')} ORDER BY a.attempted_at DESC LIMIT 1`,
        [item.lead_id]
      ),
      pool.query(
        `SELECT a.id, a.kind, a.disposition, a.connected, a.note, a.occurred_at, a.created_at, a.direction,
                a.from_value, a.to_value, u.name AS user_name, d.label AS disposition_label
           FROM lead_activities a
           LEFT JOIN users u ON u.id = a.user_id
           LEFT JOIN crm_dispositions d ON d.slug = a.disposition
          WHERE a.lead_id = $1
          ORDER BY a.created_at DESC LIMIT 8`,
        [item.lead_id]
      ),
    ]);
    lead = l.rows[0]
      ? {
          ...l.rows[0],
          open_reminders: reminders.rows,
          nearly_gave: attempt.rows[0] ?? null,
          recent_activities: activities.rows,
        }
      : null;
  }

  const c = counts.rows[0];
  const listName = session.list_id
    ? (await pool.query(`SELECT name FROM calling_lists WHERE id = $1`, [session.list_id])).rows[0]?.name ?? null
    : null;
  return {
    session: {
      id: session.id,
      kind: session.source.kind,
      label: session.source_label ?? listName ?? LABELS[session.source.kind],
      list_id: session.list_id,
      position: session.position,
      started_at: session.started_at,
      paused_at: session.paused_at,
      ended_at: session.ended_at,
    },
    item: item
      ? { position: item.position, state: item.state, outcome: item.outcome, note: item.note, visited_at: item.visited_at }
      : null,
    lead,
    counts: {
      total: c.total,
      pending: c.pending,
      done: c.done,
      skipped: c.skipped,
      taken: c.taken,
      /** 1-based place of the person on screen among everyone in the run. */
      index: item ? c.reached : c.total,
      ahead: c.ahead,
    },
    has_prev: c.has_prev === true,
    finished: !item,
    can_extend: session.source.kind !== 'selection',
  };
}

/* ---------------------------------------------------------------- routes */

/**
 * GET /sessions/sources - who could I call, and how many of each.
 *
 * What the start screen asks first. Every number here is a count over exactly
 * the query that starting that run would snapshot.
 */
router.get('/sessions/sources', async (req, res) => {
  const user = req.user;
  const me = user?.userId ?? null;
  try {
    const fixed: SourceKind[] = ['everything', 'mine', 'follow_ups', 'reminders', 'nearly_gave'];
    const [counts, lists, open, newAttempts] = await Promise.all([
      Promise.all(fixed.map((k) => countSource({ kind: k }, user))),
      pool.query(
        `SELECT cl.id, cl.name, cl.description, a.id IS NOT NULL AS assigned_to_me
           FROM calling_lists cl
           LEFT JOIN calling_list_assignments a ON a.list_id = cl.id AND a.user_id = $1::uuid
          WHERE cl.active
          ORDER BY assigned_to_me DESC, cl.name`,
        [me]
      ),
      pool.query(
        `SELECT s.id, s.source_key, s.source_label, s.source, s.list_id, s.last_active_at, s.paused_at,
                s.position, cl.name AS list_name,
                COUNT(i.position)::int AS total,
                COUNT(i.position) FILTER (WHERE i.state = 'done')::int AS done,
                COUNT(i.position) FILTER (WHERE i.state = 'skipped')::int AS skipped,
                COUNT(i.position) FILTER (WHERE i.state = 'pending')::int AS pending
           FROM calling_sessions s
           LEFT JOIN calling_lists cl ON cl.id = s.list_id
           LEFT JOIN calling_session_items i ON i.session_id = s.id
          WHERE s.user_id = $1::uuid AND s.ended_at IS NULL
          GROUP BY s.id, cl.name
          ORDER BY s.last_active_at DESC`,
        [me]
      ),
      // People who nearly gave in the last 30 days and are not leads yet.
      // Starting a Nearly gave run adds them first, so they are counted in.
      abandonedRowsFor({ days: 30 }, null)
        .then((rows) => rows.filter((r) => !r.lead_id && !r.gave_anyway).length)
        .catch(() => 0),
    ]);
    const listCounts = await Promise.all(
      lists.rows.map((l) => countSource({ kind: 'list', list_id: l.id }, user))
    );

    res.json({
      sources: fixed.map((k, n) => ({
        kind: k,
        key: k,
        label: LABELS[k],
        count: counts[n],
        ...(k === 'nearly_gave' ? { new_attempts: newAttempts } : {}),
      })),
      lists: lists.rows.map((l, n) => ({
        kind: 'list',
        key: `list:${l.id}`,
        list_id: l.id,
        label: l.name,
        description: l.description,
        assigned_to_me: l.assigned_to_me,
        count: listCounts[n],
      })),
      open: open.rows
        .filter((s) => s.total > 0)
        .map((s) => ({
          id: s.id,
          key: s.source_key,
          kind: (s.source?.kind ?? 'everything') as SourceKind,
          label: s.source_label ?? s.list_name ?? LABELS[(s.source?.kind ?? 'everything') as SourceKind],
          list_id: s.list_id,
          last_active_at: s.last_active_at,
          paused: !!s.paused_at,
          total: s.total,
          done: s.done,
          skipped: s.skipped,
          pending: s.pending,
        })),
    });
  } catch (err) {
    console.error('crm.sessionSources error:', err);
    res.status(500).json({ error: 'Could not load who to call.' });
  }
});

/** POST /sessions/count - how many a source would find (for a selection preview). */
router.post('/sessions/count', async (req, res) => {
  const src = parseSource(req.body ?? {});
  if (typeof src === 'string') return res.status(400).json({ error: src });
  try {
    res.json({ count: await countSource(src, req.user) });
  } catch (err) {
    console.error('crm.sessionCount error:', err);
    res.status(500).json({ error: 'Could not count that' });
  }
});

/**
 * POST /sessions - start (or carry on with) a run.
 *
 * { source: { kind, list_id?, lead_ids?, filters?, label? }, restart?, adopt_new? }
 *
 * An open run on the same source is carried on with, not replaced - pressing
 * Start twice, or on a second phone, must not throw away the morning's place.
 * `restart: true` finishes it and takes a fresh snapshot. A hand-picked
 * selection always starts fresh: the picking IS the choice.
 *
 * Nearly gave first turns the last 30 days' unfinished donations that are not
 * leads yet into (unassigned) leads, so "ring the people who nearly gave"
 * includes the ones who tried this morning.
 */
router.post('/sessions', async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const user = req.user!;
  const me = user.userId ?? null;
  if (!me) return res.status(401).json({ error: 'Sign in again' });

  const src = parseSource(b);
  if (typeof src === 'string') return res.status(400).json({ error: src });
  const key = sourceKey(src);

  try {
    let listName: string | null = null;
    if (src.kind === 'list') {
      const l = await pool.query(`SELECT name FROM calling_lists WHERE id = $1 AND active`, [src.list_id]);
      if (!l.rows.length) return res.status(404).json({ error: 'List not found.' });
      listName = l.rows[0].name;
    }

    const open = await pool.query(
      `SELECT id FROM calling_sessions WHERE user_id = $1 AND source_key = $2 AND ended_at IS NULL`,
      [me, key]
    );
    if (open.rows.length && b.restart !== true && src.kind !== 'selection') {
      const session = (await loadSession(open.rows[0].id, me))!;
      const items = await pool.query(`SELECT COUNT(*)::int AS n FROM calling_session_items WHERE session_id = $1`, [
        session.id,
      ]);
      // A run from before snapshots existed has no items yet - give it some.
      if (items.rows[0].n === 0) await extendSnapshot(session, user);
      if (session.position === 0) await moveNext(session, user, { skipCurrent: false });
      else await pool.query(`UPDATE calling_sessions SET paused_at = NULL, pause_note = NULL, last_active_at = NOW() WHERE id = $1`, [session.id]);
      const fresh = (await loadSession(session.id, me))!;
      return res.json({ ...(await sessionState(fresh, me)), resumed: true });
    }

    let adopted = null;
    if (src.kind === 'nearly_gave' && b.adopt_new !== false) {
      const rows = (await abandonedRowsFor({ days: 30 }, null)).filter((r) => !r.lead_id && !r.gave_anyway);
      if (rows.length) adopted = await adoptAbandonedRows(rows, { assignTo: null, userId: me });
      // Leads from this list parked with somebody who does not make calls -
      // an admin who added them all for themselves - come to the caller
      // starting the run. Without this, "Call all" skipped them for ever.
      if (req.user?.role === 'caller' && me) {
        await pool.query(
          `UPDATE leads SET assigned_to = $1::uuid, assigned_at = NOW(), updated_at = NOW()
            WHERE 'abandoned' = ANY(tags) AND NOT do_not_call
              AND status <> 'converted'
              AND assigned_to IN (SELECT id FROM users WHERE role <> 'caller')`,
          [me]
        );
      }
    }

    // Will this find anybody? Asked before creating anything, so an empty
    // source does not leave an empty open run behind on the start screen.
    const count = await countSource(src, user);
    if (count === 0) return res.json({ session: null, empty: true, count: 0, adopted });

    const label =
      src.kind === 'selection'
        ? src.label ?? `${count} picked ${count === 1 ? 'person' : 'people'}`
        : src.label ?? listName ?? LABELS[src.kind];

    // Finish whatever this replaces. A selection replaces the last selection.
    if (open.rows.length) {
      await releaseClaims(me);
      await pool.query(`UPDATE calling_sessions SET ended_at = NOW() WHERE id = $1`, [open.rows[0].id]);
    }
    const created = await pool.query(
      `INSERT INTO calling_sessions (user_id, list_id, source, source_key, source_label)
       VALUES ($1, $2::uuid, $3::jsonb, $4, $5) RETURNING id`,
      [me, src.kind === 'list' ? src.list_id : null, JSON.stringify(src), key, label]
    );
    const session = (await loadSession(created.rows[0].id, me))!;
    await extendSnapshot(session, user, src.kind === 'selection' ? 5000 : SNAPSHOT_SIZE);
    const moved = await moveNext(session, user, { skipCurrent: false });
    const fresh = (await loadSession(session.id, me))!;
    res.status(201).json({ ...(await sessionState(fresh, me)), resumed: false, adopted, passed: moved.passed, count });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'Already open in another tab.' });
    }
    console.error('crm.openSession error:', err);
    res.status(500).json({ error: 'Could not start calling. Try again.' });
  }
});

/** GET /sessions/current - the run this caller touched last, if any is open. */
router.get('/sessions/current', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT s.*, cl.name AS list_name, cl.import_batch_id, s.paused_at IS NOT NULL AS paused
         FROM calling_sessions s
         LEFT JOIN calling_lists cl ON s.list_id = cl.id
        WHERE s.user_id = $1 AND s.ended_at IS NULL
        ORDER BY s.last_active_at DESC
        LIMIT 1`,
      [req.user?.userId ?? null]
    );
    const s = r.rows[0] ?? null;
    if (s) s.label = s.source_label ?? s.list_name ?? LABELS[(s.source?.kind ?? 'everything') as SourceKind];
    res.json({ session: s });
  } catch (err) {
    console.error('crm.currentSession error:', err);
    res.status(500).json({ error: 'Could not load your list.' });
  }
});

/**
 * GET /sessions/history - the caller's recent runs.
 *
 * Read from the activity log rather than the session counters, because the
 * log is what reports are built on.
 */
router.get('/sessions/history', async (req, res) => {
  // Only an admin may ask about somebody else.
  const asked = str(req.query.user_id, 36);
  const userId = asked && req.user?.role === 'admin' ? asked : req.user?.userId ?? null;
  try {
    const rows = await pool.query(
      `SELECT s.id, s.started_at, s.last_active_at, s.ended_at,
              COALESCE(s.source_label, cl.name) AS list_name,
              COUNT(a.id)::int AS calls,
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

/** GET /sessions/:id - where the caller is, and who is on screen. */
router.get('/sessions/:id', async (req, res) => {
  const me = req.user?.userId ?? null;
  try {
    const session = await loadSession(req.params.id, me);
    if (!session) return res.status(404).json({ error: 'List not found.' });
    res.json(await sessionState(session, me!));
  } catch (err) {
    console.error('crm.sessionState error:', err);
    res.status(500).json({ error: 'Could not load your place.' });
  }
});

/**
 * POST /sessions/:id/move - { action: 'next' | 'skip' | 'prev' | 'jump' | 'revisit', position? }
 *
 * next     - on to the next person; the one on screen, if not called, is
 *            counted as skipped (they can be revisited)
 * skip     - the same, said explicitly
 * prev     - back one, whatever happened to them
 * jump     - straight to a position from the Up next list
 * revisit  - everybody skipped (and anybody "taken" who is free again) goes
 *            back to the queue, starting from the first of them
 */
router.post('/sessions/:id/move', async (req, res) => {
  const me = req.user?.userId ?? null;
  const action = String(req.body?.action ?? 'next');
  try {
    const session = await loadSession(req.params.id, me);
    if (!session || session.ended_at) return res.status(404).json({ error: 'This list is finished.' });

    let message: string | null = null;
    let passed: { name: string | null; reason: string }[] = [];

    if (action === 'next' || action === 'skip') {
      const r = await moveNext(session, req.user!, { skipCurrent: true });
      passed = r.passed;
    } else if (action === 'prev') {
      if (!(await movePrev(session, me!))) message = 'That was the first person in this run';
    } else if (action === 'jump') {
      const pos = Math.round(Number(req.body?.position));
      const target = await pool.query(
        `SELECT position, lead_id, state FROM calling_session_items WHERE session_id = $1 AND position = $2`,
        [session.id, pos]
      );
      if (!target.rows.length) return res.status(404).json({ error: 'Nobody at that spot.' });
      const t = target.rows[0];
      if (t.state === 'pending' || t.state === 'taken') {
        const blocked = (await checkBatch(session.id, me!, [pos])).get(pos);
        if (blocked) return res.status(409).json({ error: blocked });
        if (t.state === 'taken') {
          await pool.query(
            `UPDATE calling_session_items SET state = 'pending', note = NULL WHERE session_id = $1 AND position = $2`,
            [session.id, pos]
          );
        }
      }
      if (!(await claim(t.lead_id, me!))) return res.status(409).json({ error: 'Someone else is calling them' });
      // Leaving somebody uncalled to jump elsewhere counts as skipping them.
      await pool.query(
        `UPDATE calling_session_items SET state = 'skipped'
          WHERE session_id = $1 AND position = $2 AND state = 'pending' AND position <> $3`,
        [session.id, session.position, pos]
      );
      await releaseClaims(me!, t.lead_id);
      await setPosition(session.id, pos);
    } else if (action === 'revisit') {
      const r = await pool.query(
        `UPDATE calling_session_items SET state = 'pending', note = NULL
          WHERE session_id = $1 AND state IN ('skipped','taken') RETURNING position`,
        [session.id]
      );
      if (!r.rows.length) message = 'Nobody was skipped';
      else {
        const first = Math.min(...r.rows.map((x) => x.position));
        session.position = first - 1;
        const m = await moveNext(session, req.user!, { skipCurrent: false });
        passed = m.passed;
      }
    } else {
      return res.status(400).json({ error: `Unknown move "${action}"` });
    }

    const fresh = (await loadSession(session.id, me))!;
    res.json({ ...(await sessionState(fresh, me!)), message, passed });
  } catch (err) {
    console.error('crm.sessionMove error:', err);
    res.status(500).json({ error: 'Could not go to next. Try again.' });
  }
});

/** GET /sessions/:id/items - everybody in the run, for the Up next panel. */
router.get('/sessions/:id/items', async (req, res) => {
  const me = req.user?.userId ?? null;
  try {
    const session = await loadSession(req.params.id, me);
    if (!session) return res.status(404).json({ error: 'List not found.' });
    const r = await pool.query(
      `SELECT i.position, i.state, i.outcome, i.note, i.lead_id,
              l.name, l.phone, l.city, l.expected_amount, l.last_outcome, l.last_contacted_at,
              l.next_follow_up_at, l.call_attempts,
              'abandoned' = ANY(l.tags) AS nearly_gave,
              d.label AS outcome_label
         FROM calling_session_items i
         JOIN leads l ON l.id = i.lead_id
         LEFT JOIN crm_dispositions d ON d.slug = i.outcome
        WHERE i.session_id = $1
        ORDER BY i.position
        LIMIT 5000`,
      [session.id]
    );
    res.json({ items: r.rows, position: session.position });
  } catch (err) {
    console.error('crm.sessionItems error:', err);
    res.status(500).json({ error: 'Could not load your list.' });
  }
});

/** POST /sessions/:id/heartbeat - the screen is still open; keep the claim. */
router.post('/sessions/:id/heartbeat', async (req, res) => {
  const me = req.user?.userId ?? null;
  try {
    const r = await pool.query(
      `UPDATE leads l SET claimed_until = NOW() + make_interval(mins => $3::int)
         FROM calling_sessions s
         JOIN calling_session_items i ON i.session_id = s.id AND i.position = s.position
        WHERE s.id = $1 AND s.user_id = $2::uuid AND s.ended_at IS NULL
          AND l.id = i.lead_id AND l.claimed_by = $2::uuid
        RETURNING l.id`,
      [req.params.id, me, CLAIM_MINUTES]
    );
    await pool.query(`UPDATE calling_sessions SET last_active_at = NOW() WHERE id = $1 AND user_id = $2`, [
      req.params.id,
      me,
    ]);
    res.json({ held: (r.rowCount ?? 0) > 0 });
  } catch (err) {
    console.error('crm.sessionHeartbeat error:', err);
    res.status(500).json({ error: 'Could not save your place.' });
  }
});

/**
 * POST /sessions/:id/pause - stepping away, not stopping. The run stays open
 * (it is what "carry on" finds), and the person on screen is let go so a
 * colleague can ring them meanwhile.
 */
router.post('/sessions/:id/pause', async (req, res) => {
  const me = req.user?.userId ?? null;
  try {
    const r = await pool.query(
      `UPDATE calling_sessions SET paused_at = NOW(), pause_note = $3, last_active_at = NOW()
        WHERE id = $1 AND user_id = $2 AND ended_at IS NULL RETURNING *`,
      [req.params.id, me, str(req.body?.note, 200)]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'This list is already finished.' });
    if (me) await releaseClaims(me);
    res.json({ session: r.rows[0] });
  } catch (err) {
    console.error('crm.pauseSession error:', err);
    res.status(500).json({ error: 'Could not pause that' });
  }
});

/** POST /sessions/:id/resume - back at the desk. Re-takes the person on screen. */
router.post('/sessions/:id/resume', async (req, res) => {
  const me = req.user?.userId ?? null;
  try {
    const r = await pool.query(
      `UPDATE calling_sessions SET paused_at = NULL, pause_note = NULL, last_active_at = NOW()
        WHERE id = $1 AND user_id = $2 AND ended_at IS NULL RETURNING id`,
      [req.params.id, me]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'This list is already finished.' });
    const session = (await loadSession(req.params.id, me))!;
    // If somebody rang the person on screen while we were away, move on.
    const cur = await pool.query(
      `SELECT position, state FROM calling_session_items WHERE session_id = $1 AND position = $2`,
      [session.id, session.position]
    );
    if (cur.rows[0]?.state === 'pending') {
      const blocked = (await checkBatch(session.id, me!, [session.position])).get(session.position);
      if (blocked) {
        await pool.query(
          `UPDATE calling_session_items SET state = 'taken', note = $3 WHERE session_id = $1 AND position = $2`,
          [session.id, session.position, blocked]
        );
        await moveNext(session, req.user!, { skipCurrent: false });
      }
    }
    const fresh = (await loadSession(session.id, me))!;
    res.json(await sessionState(fresh, me!));
  } catch (err) {
    console.error('crm.resumeSession error:', err);
    res.status(500).json({ error: 'Could not resume that' });
  }
});

/** What a run achieved. Shared by the end route and the summary route. */
async function sessionSummary(sessionId: string, me: string) {
  const r = await pool.query(
    `WITH s AS (SELECT * FROM calling_sessions WHERE id = $1 AND user_id = $2::uuid),
     calls AS (
       SELECT a.* FROM lead_activities a, s WHERE a.session_id = s.id AND a.kind = 'call'
     ),
     leads_in AS (SELECT lead_id FROM calling_session_items WHERE session_id = $1)
     SELECT
       (SELECT COUNT(*)::int FROM calls) AS calls,
       (SELECT COUNT(*)::int FROM calls WHERE connected) AS connected,
       (SELECT COUNT(*)::int FROM lead_reminders r, s
         WHERE r.created_by = $2::uuid AND r.created_at >= s.started_at
           AND r.lead_id IN (SELECT lead_id FROM leads_in)) AS promised,
       (SELECT COALESCE(SUM(r.expected_amount), 0)::numeric FROM lead_reminders r, s
         WHERE r.created_by = $2::uuid AND r.created_at >= s.started_at
           AND r.lead_id IN (SELECT lead_id FROM leads_in)) AS promised_amount,
       (SELECT COUNT(*)::int FROM leads l, s
         WHERE l.id IN (SELECT lead_id FROM leads_in) AND l.converted_at >= s.started_at) AS donated,
       (SELECT COALESCE(SUM(l.converted_amount), 0)::numeric FROM leads l, s
         WHERE l.id IN (SELECT lead_id FROM leads_in) AND l.converted_at >= s.started_at) AS donated_amount,
       -- Money credited to this caller since the run started, by any channel:
       -- the QR they sent at 11 that was paid at 2 belongs to this run's day.
       (SELECT COALESCE(SUM(c.amount), 0)::numeric FROM caller_credits c, s
         WHERE c.user_id = $2::uuid AND c.status = 'active'
           AND c.occurred_at >= s.started_at
           AND c.occurred_at <= COALESCE(s.ended_at, NOW())) AS credited,
       (SELECT COUNT(*)::int FROM calling_session_items WHERE session_id = $1 AND state = 'skipped') AS skipped,
       (SELECT COUNT(*)::int FROM calling_session_items WHERE session_id = $1 AND state = 'pending') AS left_to_call,
       (SELECT COUNT(*)::int FROM calling_session_items WHERE session_id = $1 AND state = 'taken') AS taken,
       (SELECT COALESCE(jsonb_agg(x ORDER BY x.n DESC), '[]'::jsonb) FROM (
          SELECT c.disposition, COALESCE(d.label, c.disposition) AS label, COUNT(*)::int AS n
            FROM calls c LEFT JOIN crm_dispositions d ON d.slug = c.disposition
           GROUP BY c.disposition, d.label) x) AS outcomes,
       (SELECT started_at FROM s) AS started_at,
       (SELECT ended_at FROM s) AS ended_at`,
    [sessionId, me]
  );
  const x = r.rows[0];
  return {
    ...x,
    promised_amount: Number(x.promised_amount),
    donated_amount: Number(x.donated_amount),
    credited: Number(x.credited),
  };
}

router.get('/sessions/:id/summary', async (req, res) => {
  const me = req.user?.userId ?? null;
  try {
    const session = await loadSession(req.params.id, me);
    if (!session) return res.status(404).json({ error: 'List not found.' });
    res.json({ summary: await sessionSummary(session.id, me!) });
  } catch (err) {
    console.error('crm.sessionSummary error:', err);
    res.status(500).json({ error: 'Could not load totals.' });
  }
});

/** POST /sessions/:id/end - finished for now. Answers with how it went. */
router.post('/sessions/:id/end', async (req, res) => {
  const me = req.user?.userId ?? null;
  try {
    const r = await pool.query(
      `UPDATE calling_sessions SET ended_at = NOW(), paused_at = NULL
        WHERE id = $1 AND user_id = $2 AND ended_at IS NULL RETURNING *`,
      [req.params.id, me]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'This list is already finished.' });
    if (me) await releaseClaims(me);
    res.json({ session: r.rows[0], summary: await sessionSummary(req.params.id, me!) });
  } catch (err) {
    console.error('crm.endSession error:', err);
    res.status(500).json({ error: 'Could not finish. Try again.' });
  }
});

/* ---------------------------------------------------------------- search */

/**
 * GET /search?q= - the box in the top bar.
 *
 * A number or a name, from anywhere. Leads within what this person may see;
 * donors (people) for everyone, since the People screen is open to all.
 * Phone matching is on digits, so "98765 43210", "+91 9876543210" and
 * "9876543210" all find the same person.
 */
router.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim().slice(0, 80);
  if (q.length < 2) return res.json({ leads: [], people: [] });
  const digits = q.replace(/\D/g, '');
  const byPhone = digits.length >= 4;
  try {
    const scope = await leadScopeFor(req.user);
    const like = `%${q}%`;
    const phoneLike = `%${digits.slice(-10)}%`;
    const [leads, people] = await Promise.all([
      pool.query(
        `SELECT l.id, l.name, l.phone, l.alt_phone, l.city, l.status, l.do_not_call,
                l.next_follow_up_at, l.last_outcome, u.name AS assigned_to_name, s.label AS status_label
           FROM leads l
           LEFT JOIN users u ON u.id = l.assigned_to
           LEFT JOIN crm_statuses s ON s.slug = l.status
          WHERE (CASE WHEN $5::boolean THEN (l.phone LIKE $2::text OR l.alt_phone LIKE $2::text)
                      ELSE (l.name ILIKE $1::text OR l.email ILIKE $1::text) END)
            AND ($3::uuid IS NULL OR l.assigned_to = $3::uuid OR l.assigned_to IS NULL OR l.assigned_to IN (SELECT id FROM users WHERE role <> 'caller'))
          ORDER BY (lower(l.name) = lower($4::text)) DESC, l.updated_at DESC
          LIMIT 8`,
        [like, phoneLike, scope, q, byPhone]
      ),
      pool.query(
        `SELECT p.id, p.name, p.phone, p.email,
                (SELECT COALESCE(SUM(d.amount), 0) FROM donations d WHERE d.person_id = p.id)::numeric AS total_donated
           FROM people p
          WHERE (CASE WHEN $4::boolean THEN regexp_replace(p.phone, '\\D', '', 'g') LIKE $2::text
                      ELSE (p.name ILIKE $1::text OR p.email ILIKE $1::text) END)
          ORDER BY (lower(p.name) = lower($3::text)) DESC, p.updated_at DESC
          LIMIT 8`,
        [like, phoneLike, q, byPhone]
      ),
    ]);
    // A whole number that is a colleague's lead: not shown (the caller may
    // not open it), but said - otherwise "nobody matches" sends them off to
    // add somebody who is already somebody else's donor.
    let ownedBy: string | null = null;
    if (scope && digits.length >= 10 && !leads.rows.length) {
      const o = await pool.query(
        `SELECT u.name FROM leads l JOIN users u ON u.id = l.assigned_to
          WHERE (l.phone = $1 OR l.alt_phone = $1) AND l.assigned_to <> $2::uuid LIMIT 1`,
        [digits.slice(-10), scope]
      );
      ownedBy = o.rows[0]?.name ?? null;
    }
    res.json({ leads: leads.rows, people: people.rows, owned_by: ownedBy });
  } catch (err) {
    console.error('crm.search error:', err);
    res.status(500).json({ error: 'Could not search' });
  }
});

export default router;
