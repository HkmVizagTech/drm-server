// Preachers.
//
// Every donor sheet the temple keeps has an "Enrolled By" column - JTMD, VKTD,
// YDRD and so on - and it was the most important thing on the row that DRM had
// nowhere to put. It names the preacher who brought that donor in, and it
// changes how a call goes: a caller who can say "Jagat Tarini Mataji gave us
// your name" is not making a cold call any more.
//
// Codes rather than names, because codes are what the sheets carry and what the
// office says out loud. A real name can be filled in here whenever somebody has
// the list, and every screen picks it up; until then the code shows, which
// still beats nothing.
//
// A preacher is NOT a DRM user. A user signs in; a preacher is somebody the
// DONOR knows. Occasionally the same person, usually not, and merging the two
// would mean creating a login for every preacher just to store a name.

import { Router } from 'express';
import pool from '../db/pool';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

const str = (v: unknown, max = 255): string | null => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};

/** Codes are compared upper-cased and stripped, so "ydrd " and "YDRD" are one. */
export function normalizeCode(v: unknown): string | null {
  const s = String(v ?? '').trim().toUpperCase().replace(/\s+/g, '');
  return s ? s.slice(0, 20) : null;
}

/**
 * Find a preacher by code, creating one if the code is new.
 *
 * Used by the sheet import, which meets codes DRM has never seen. Creating
 * rather than rejecting is deliberate: a sheet with a new preacher's code on it
 * is a sheet the temple wants imported, and stopping the whole upload to make
 * someone add a row first would just mean the column gets dropped instead.
 * The name is left blank for a human to fill in.
 */
export async function preacherIdForCode(
  code: unknown,
  client?: { query: typeof pool.query }
): Promise<string | null> {
  const c = normalizeCode(code);
  if (!c) return null;
  const db = client ?? pool;
  const result = await db.query(
    `INSERT INTO preachers (code) VALUES ($1)
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code
     RETURNING id`,
    [c]
  );
  return result.rows[0]?.id ?? null;
}

/* ------------------------------------------------------------------ routes */

/**
 * GET /preachers - the list, with how much each one's donors are worth.
 *
 * The counts are the point. A preacher list without them is an admin screen
 * nobody opens; with them it answers "whose donors should we be calling", which
 * is the question the office actually has.
 */
router.get('/preachers', async (req, res) => {
  const withCounts = req.query.counts !== 'false';

  try {
    if (!withCounts) {
      const rows = await pool.query(`SELECT * FROM preachers ORDER BY active DESC, code`);
      return res.json({ preachers: rows.rows });
    }

    const rows = await pool.query(
      `SELECT p.*,
              COALESCE(l.leads, 0)        AS leads,
              COALESCE(l.open_leads, 0)   AS open_leads,
              COALESCE(l.converted, 0)    AS converted,
              COALESCE(l.raised, 0)       AS raised,
              COALESCE(l.external_total, 0) AS external_total,
              COALESCE(d.donors, 0)       AS donors
         FROM preachers p
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS leads,
                  COUNT(*) FILTER (WHERE COALESCE(s.is_open, TRUE) AND NOT le.do_not_call)::int AS open_leads,
                  COUNT(*) FILTER (WHERE le.converted_donation_id IS NOT NULL)::int AS converted,
                  COALESCE(SUM(le.converted_amount), 0)::numeric AS raised,
                  -- Lifetime giving from the office's own sheets, kept apart
                  -- from anything DRM raised. See the schema note.
                  COALESCE(SUM(le.external_total_donated), 0)::numeric AS external_total
             FROM leads le
             LEFT JOIN crm_statuses s ON le.status = s.slug
            WHERE le.preacher_id = p.id
         ) l ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS donors FROM people pe WHERE pe.preacher_id = p.id
         ) d ON TRUE
        ORDER BY p.active DESC, l.leads DESC NULLS LAST, p.code`
    );
    res.json({ preachers: rows.rows });
  } catch (err) {
    console.error('crm.listPreachers error:', err);
    res.status(500).json({ error: 'Could not load the preachers' });
  }
});

router.post('/preachers', async (req, res) => {
  const code = normalizeCode(req.body?.code);
  if (!code) return res.status(400).json({ error: 'A preacher needs a code' });
  try {
    const result = await pool.query(
      `INSERT INTO preachers (code, name, phone, notes)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (code) DO UPDATE SET
         name  = COALESCE(EXCLUDED.name, preachers.name),
         phone = COALESCE(EXCLUDED.phone, preachers.phone),
         notes = COALESCE(EXCLUDED.notes, preachers.notes),
         updated_at = NOW()
       RETURNING *`,
      [code, str(req.body?.name, 160), str(req.body?.phone, 15), str(req.body?.notes, 2000)]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('crm.createPreacher error:', err);
    res.status(500).json({ error: 'Could not save that preacher' });
  }
});

router.put('/preachers/:id', async (req, res) => {
  const b = req.body ?? {};
  try {
    const result = await pool.query(
      `UPDATE preachers SET
         code   = COALESCE($1, code),
         name   = COALESCE($2, name),
         phone  = COALESCE($3, phone),
         notes  = COALESCE($4, notes),
         active = COALESCE($5::boolean, active),
         updated_at = NOW()
       WHERE id = $6 RETURNING *`,
      [
        normalizeCode(b.code),
        str(b.name, 160),
        str(b.phone, 15),
        str(b.notes, 2000),
        typeof b.active === 'boolean' ? b.active : null,
        req.params.id,
      ]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Preacher not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('crm.updatePreacher error:', err);
    res.status(500).json({ error: 'Could not save that preacher' });
  }
});

/**
 * DELETE is not offered, and that is on purpose.
 *
 * Leads and donors point at a preacher. Deleting one would leave every donor
 * they brought in with an empty column and no way to tell whether that means
 * "nobody" or "the row was tidied away". Retiring keeps the history readable
 * and takes the code out of the dropdowns, which is what "delete" was for.
 */
router.post('/preachers/:id/retire', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE preachers SET active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Preacher not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('crm.retirePreacher error:', err);
    res.status(500).json({ error: 'Could not retire that preacher' });
  }
});

export default router;
