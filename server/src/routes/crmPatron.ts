// Patron requests - people who asked, on the temple site, to become a patron.
//
// WHY THIS IS A LEAD, NOT ITS OWN KIND OF THING
// A patron request is somebody to ring, and everything DRM already does for
// somebody to ring hangs off `leads`: the call screen, the phone app's
// recordings, outcomes and statuses, reminders and follow-ups, and the
// team-activity counts. So each request becomes a lead (source 'patron', tag
// 'patron') the moment it arrives, and a caller's "Call" opens that lead on the
// same call screen as any other. Nothing here re-implements calling.
//
// What this module owns is only what the Nearly gave and QR modules own for
// themselves: the record of what the visitor typed (`patron_requests`), the
// pull from the site, and the screen that lists them with who has rung whom.
//
// WHO SEES WHAT
// The same rule as the leads screen. A caller sees the patrons that are theirs,
// unassigned, or held by somebody who does not make calls (an admin), unless
// the "callers see all leads" setting is on. Admins and coordinators see all.
// A caller never takes a colleague's patron.

import { Router } from 'express';
import pool from '../db/pool';
import { authenticate } from '../middleware/auth';
import { fetchPatronRequestPage, isSiteConfigured, type PatronRequest, type SiteKey } from '../services/hkmvClient';
import { upsertLead } from './crm';

const router = Router();
router.use(authenticate);

const SITE: SiteKey = 'hkmv';
const MAX_PAGES = 40;

const normalizePhone = (raw: unknown): string => {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
};
const isDialable = (p: string) => /^[6-9]\d{9}$/.test(p);
const cut = (v: unknown, n: number): string | null => {
  const t = String(v ?? '').trim();
  return t ? t.slice(0, n) : null;
};

/* ------------------------------------------------------------------ ingest */

/**
 * Store one request and make sure it is a lead. False when it cannot be used
 * (no dialable number, no id to key on, no date). Shared by the full sync
 * behind the screen and the one-minute poll that rings the bell.
 */
export async function storePatronRequest(p: PatronRequest): Promise<boolean> {
  const phone = normalizePhone(p.mobile);
  const externalId = String(p.externalId ?? '').trim();
  if (!isDialable(phone) || !externalId || !p.requestedAt) return false;

  const name = cut(p.name, 255);
  const place = [cut(p.city, 120), cut(p.state, 120)].filter(Boolean).join(', ');

  // The lead first, unassigned: a number that is already a lead keeps its owner,
  // its status and its history, and just gains the 'patron' tag.
  const { lead, created } = await upsertLead(
    {
      phone,
      name,
      email: cut(p.email, 255),
      city: cut(p.city, 120),
      source: 'patron',
      source_detail: 'Asked to become a patron on the website',
      source_site: SITE,
      tags: ['patron'],
    },
    null
  );

  const ins = await pool.query(
    `INSERT INTO patron_requests
       (source_site, external_id, phone, name, email, city, state, message, requested_at, lead_id, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::uuid, NOW())
     ON CONFLICT (source_site, external_id) DO UPDATE SET
       -- The site is authoritative on what was typed; what DRM decided about the
       -- row (set aside) is not touched.
       phone        = EXCLUDED.phone,
       name         = COALESCE(EXCLUDED.name, patron_requests.name),
       email        = COALESCE(EXCLUDED.email, patron_requests.email),
       city         = COALESCE(EXCLUDED.city, patron_requests.city),
       state        = COALESCE(EXCLUDED.state, patron_requests.state),
       message      = COALESCE(EXCLUDED.message, patron_requests.message),
       lead_id      = COALESCE(patron_requests.lead_id, EXCLUDED.lead_id),
       last_seen_at = NOW()
     RETURNING (xmax = 0) AS was_inserted`,
    [SITE, externalId.slice(0, 80), phone, name, cut(p.email, 255), cut(p.city, 120), cut(p.state, 120),
     cut(p.message, 2000), p.requestedAt, lead.id]
  );

  // A line in the lead's history, once, so whoever opens the call screen sees
  // why this person is on the list and what they wrote.
  if (ins.rows[0]?.was_inserted) {
    await pool.query(
      `INSERT INTO lead_activities (lead_id, user_id, kind, note, occurred_at)
       VALUES ($1, NULL, $2, $3, $4::timestamptz)`,
      [
        lead.id,
        created ? 'import' : 'note',
        `Asked to become a patron${place ? ` (${place})` : ''}${p.message ? `: "${String(p.message).slice(0, 300)}"` : ''}`,
        p.requestedAt,
      ]
    );
  }
  return true;
}

export interface PatronSyncResult { site: string; seen: number; error: string | null }

/** Crawl the site's requests (oldest first), storing every usable one. */
export async function syncPatrons(opts: { days?: number } = {}): Promise<PatronSyncResult> {
  const days = Math.min(730, Math.max(1, opts.days ?? 365));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  if (!isSiteConfigured(SITE)) return { site: SITE, seen: 0, error: 'Not connected.' };
  let seen = 0;
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await fetchPatronRequestPage(SITE, { page, limit: 200, since });
      for (const p of r.requests) if (await storePatronRequest(p)) seen++;
      if (!r.hasMore) break;
    }
    await pool.query(
      `INSERT INTO patron_sync_state (source_site, last_synced_at, last_error, rows_seen)
       VALUES ($1, NOW(), NULL, $2)
       ON CONFLICT (source_site) DO UPDATE SET last_synced_at = NOW(), last_error = NULL, rows_seen = $2`,
      [SITE, seen]
    );
    return { site: SITE, seen, error: null };
  } catch (e) {
    const error = (e as Error).message;
    await pool.query(
      `INSERT INTO patron_sync_state (source_site, last_error) VALUES ($1, $2)
       ON CONFLICT (source_site) DO UPDATE SET last_error = $2`,
      [SITE, error]
    );
    return { site: SITE, seen, error };
  }
}

/* ------------------------------------------------------------------- scope */

/** Callers are narrowed to their own, unassigned and non-callers' patrons. */
async function scopeFor(user?: { role?: string; userId?: string }): Promise<string | null> {
  if (user?.role !== 'caller') return null;
  const r = await pool.query(`SELECT value FROM crm_settings WHERE key = 'callers_see_all_leads'`);
  if (r.rows[0]?.value === true) return null;
  return user?.userId ?? null;
}

/**
 * Where a request is in its day, in the order a caller should work them - the
 * same board as Sankalpam's, so the ones that need a call today stand out:
 *
 *   new      nobody has rung since they asked
 *   overdue  a call back was due on an earlier day
 *   today    a call back is due today (including the evening retry once its
 *            hour has come)
 *   evening  rung this morning and unanswered: held for the evening retry
 *   later    a call back is booked for another day
 *   waiting  rung, nothing booked
 *   done     became a patron, closed, or asked not to be called
 */
const BUCKET = `CASE
  WHEN l.converted_at IS NOT NULL OR l.do_not_call OR COALESCE(s.is_open, TRUE) = FALSE THEN 'done'
  WHEN l.retry_hold_until IS NOT NULL AND l.retry_hold_until > NOW() THEN 'evening'
  WHEN l.last_contacted_at IS NULL OR l.last_contacted_at < p.requested_at THEN 'new'
  WHEN l.next_follow_up_at IS NOT NULL AND l.next_follow_up_at < date_trunc('day', NOW()) THEN 'overdue'
  WHEN l.next_follow_up_at IS NOT NULL AND l.next_follow_up_at < date_trunc('day', NOW()) + INTERVAL '1 day' THEN 'today'
  WHEN l.next_follow_up_at IS NOT NULL THEN 'later'
  ELSE 'waiting' END`;

const STATUS_FIELDS = `
  ${BUCKET} AS bucket,
  l.retry_hold_until AS lead_retry_hold_until,
  l.status AS lead_status, s.label AS lead_status_label, s.is_open AS lead_status_open,
  l.assigned_to AS lead_assigned_to, au.name AS assigned_to_name,
  (au.role = 'caller') AS lead_owner_calls,
  l.do_not_call AS lead_do_not_call,
  l.last_outcome AS lead_last_outcome, d.label AS lead_last_outcome_label,
  l.last_contacted_at AS lead_last_contacted_at, l.call_attempts AS lead_call_attempts,
  l.next_follow_up_at AS lead_next_follow_up_at, l.converted_at AS lead_converted_at,
  l.converted_amount AS lead_converted_amount`;

const FROM = `
  FROM patron_requests p
  LEFT JOIN leads l ON l.id = p.lead_id
  LEFT JOIN crm_statuses s ON s.slug = l.status
  LEFT JOIN crm_dispositions d ON d.slug = l.last_outcome
  LEFT JOIN users au ON au.id = l.assigned_to`;

const SCOPE_CLAUSE = (param: string) =>
  `(l.assigned_to = ${param}::uuid OR l.assigned_to IS NULL OR l.assigned_to IN (SELECT id FROM users WHERE role <> 'caller'))`;

/* ------------------------------------------------------------------- list */

// GET /patrons?view=open|set_aside&mine=true&search=
// Everything the board needs in one answer: each row carries its `bucket`, and
// `counts` is the number in each bucket for the same visibility.
router.get('/patrons', async (req, res) => {
  try {
    const q = req.query as Record<string, string>;
    const view = q.view === 'set_aside' ? 'set_aside' : 'open';
    const limit = Math.min(500, Math.max(10, parseInt(q.limit, 10) || 300));
    const me = req.user?.userId ?? null;
    const scope = await scopeFor(req.user);

    const where: string[] = [view === 'set_aside' ? 'p.dismissed_at IS NOT NULL' : 'p.dismissed_at IS NULL'];
    const values: unknown[] = [];
    const add = (v: unknown) => { values.push(v); return `$${values.length}`; };

    if (scope) where.push(SCOPE_CLAUSE(add(scope)));
    if (q.mine === 'true' && me) where.push(`l.assigned_to = ${add(me)}::uuid`);
    if (q.search?.trim()) {
      const a = add(`%${q.search.trim().toLowerCase()}%`);
      const digits = q.search.replace(/\D/g, '');
      where.push(`(lower(coalesce(p.name,'')) LIKE ${a} OR lower(coalesce(p.city,'')) LIKE ${a}${
        digits.length >= 3 ? ` OR p.phone LIKE ${add(`%${digits}%`)}` : ''})`);
    }
    const W = `WHERE ${where.join(' AND ')}`;

    const [rows, counts, sync] = await Promise.all([
      pool.query(
        `SELECT p.id, p.external_id, p.phone, p.name, p.email, p.city, p.state, p.message,
                p.requested_at, p.lead_id, p.dismissed_at, ${STATUS_FIELDS}
           ${FROM} ${W}
          ORDER BY CASE ${BUCKET} WHEN 'overdue' THEN 1 WHEN 'new' THEN 2 WHEN 'today' THEN 3 WHEN 'evening' THEN 4 WHEN 'later' THEN 5 WHEN 'waiting' THEN 6 ELSE 7 END, p.requested_at DESC
          LIMIT ${limit}`,
        values
      ),
      pool.query(
        `SELECT bucket, COUNT(*)::int AS n FROM (SELECT ${BUCKET} AS bucket ${FROM} ${W}) t GROUP BY bucket`,
        values
      ),
      pool.query(`SELECT last_synced_at, last_error FROM patron_sync_state WHERE source_site = $1`, [SITE]),
    ]);

    const c: Record<string, number> = { new: 0, overdue: 0, today: 0, evening: 0, later: 0, waiting: 0, done: 0 };
    for (const r of counts.rows) c[r.bucket] = r.n;
    res.json({
      rows: rows.rows,
      counts: { ...c, all: Object.values(c).reduce((a, b) => a + b, 0) },
      sync: sync.rows[0] ?? { last_synced_at: null, last_error: null },
    });
  } catch (err) {
    console.error('Patrons list error:', err);
    res.status(500).json({ error: 'Could not load patron requests.' });
  }
});

// GET /patrons/summary - the sidebar badge: what needs a call now.
router.get('/patrons/summary', async (req, res) => {
  try {
    const scope = await scopeFor(req.user);
    const r = await pool.query(
      `SELECT bucket, COUNT(*)::int AS n FROM (
         SELECT ${BUCKET} AS bucket ${FROM}
          WHERE p.dismissed_at IS NULL${scope ? ` AND ${SCOPE_CLAUSE('$1')}` : ''}
       ) t GROUP BY bucket`,
      scope ? [scope] : []
    );
    const c: Record<string, number> = {};
    for (const x of r.rows) c[x.bucket] = x.n;
    const n = (k: string) => c[k] ?? 0;
    res.json({ now: n('new') + n('overdue') + n('today'), new: n('new'), overdue: n('overdue'), today: n('today'), evening: n('evening') });
  } catch (err) {
    console.error('Patrons summary error:', err);
    res.status(500).json({ error: 'Could not load the summary.' });
  }
});

// POST /patrons/refresh - pull from the site now (anyone who can see the list).
router.post('/patrons/refresh', async (_req, res) => {
  const r = await syncPatrons({ days: 365 });
  if (r.error) return res.status(502).json(r);
  res.json(r);
});

// POST /patrons/:id/claim - take it to call. Returns the lead to open on the
// call screen. Never takes a colleague's patron, never re-opens do-not-call.
router.post('/patrons/:id/claim', async (req, res) => {
  try {
    const me = req.user?.userId ?? null;
    const r = await pool.query(
      `SELECT p.id, p.lead_id, l.assigned_to, l.do_not_call, au.name AS owner_name, (au.role = 'caller') AS owner_calls
         FROM patron_requests p
         LEFT JOIN leads l ON l.id = p.lead_id
         LEFT JOIN users au ON au.id = l.assigned_to
        WHERE p.id = $1`,
      [req.params.id]
    );
    const row = r.rows[0];
    if (!row || !row.lead_id) return res.status(404).json({ error: 'Patron request not found.' });
    if (row.do_not_call) return res.status(409).json({ error: 'This person asked not to be called.' });

    const mine = row.assigned_to === me;
    const free = !row.assigned_to;
    const parked = row.assigned_to && row.owner_calls === false; // an admin holding it
    const isAdmin = req.user?.role === 'admin';
    if (!mine && !free && !parked && !isAdmin) {
      return res.status(409).json({ error: `${row.owner_name ?? 'Another caller'} is already working this patron.` });
    }
    if (!mine && me) {
      await pool.query(
        `UPDATE leads SET assigned_to = $2::uuid, assigned_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [row.lead_id, me]
      );
    }
    res.json({ lead_id: row.lead_id });
  } catch (err) {
    console.error('Patron claim error:', err);
    res.status(500).json({ error: 'Could not take this patron request.' });
  }
});

router.post('/patrons/:id/dismiss', async (req, res) => {
  const r = await pool.query(
    `UPDATE patron_requests SET dismissed_at = NOW(), dismissed_by = $2::uuid WHERE id = $1 RETURNING id`,
    [req.params.id, req.user?.userId ?? null]
  );
  if (!r.rowCount) return res.status(404).json({ error: 'Not found.' });
  res.json({ ok: true });
});

router.post('/patrons/:id/restore', async (req, res) => {
  const r = await pool.query(
    `UPDATE patron_requests SET dismissed_at = NULL, dismissed_by = NULL WHERE id = $1 RETURNING id`,
    [req.params.id]
  );
  if (!r.rowCount) return res.status(404).json({ error: 'Not found.' });
  res.json({ ok: true });
});

export default router;
