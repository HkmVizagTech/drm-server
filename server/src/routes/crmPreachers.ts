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
import { authenticate, authorize } from '../middleware/auth';

const router = Router();
router.use(authenticate);

const str = (v: unknown, max = 255): string | null => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};

/**
 * The temple's own ID number for a preacher, as it is written on paper.
 *
 * Kept as text, never a number: the office's numbers carry prefixes and leading
 * zeros ("HKM-118", "0042") and turning those into integers would silently
 * rewrite somebody's ID. Trimmed and upper-cased only so "hkm-118" and
 * "HKM-118 " do not become two preachers.
 */
export function normalizeIdNumber(v: unknown): string | null {
  const s = String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  return s ? s.slice(0, 30) : null;
}

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

/**
 * Resolve a preacher from whatever the sheet actually carried.
 *
 * The office's sheets are not consistent: some have a short code (JTMD), some
 * have the DCC id number the temple's own system uses (a number like 1042),
 * and some have both in separate columns. Before this, only the code was
 * understood, so a sheet keyed on id numbers imported with every lead's
 * preacher blank - and the receipts raised for those donors later carried the
 * temple's generic default instead of the preacher who actually brought them.
 *
 * An id number is matched against existing preachers and never invents one: a
 * code is a label somebody chose and can be created on sight, but an id number
 * means something in another system and a made-up row would quietly attribute
 * donations to a preacher who does not exist. A code, as before, is created if
 * it is new.
 */
export async function preacherIdFrom(
  input: { code?: unknown; idNumber?: unknown },
  client?: { query: typeof pool.query }
): Promise<string | null> {
  const db = client ?? pool;
  const idNumber = String(input.idNumber ?? '').trim();

  if (idNumber) {
    const byId = await db.query(`SELECT id FROM preachers WHERE id_number = $1`, [idNumber]);
    if (byId.rows.length) return byId.rows[0].id;

    // An id with a code beside it is enough to create the preacher properly -
    // the code names them, the id links them to the temple's own system.
    const code = normalizeCode(input.code);
    if (code) {
      const made = await db.query(
        `INSERT INTO preachers (code, id_number) VALUES ($1, $2)
         ON CONFLICT (code) DO UPDATE SET id_number = COALESCE(preachers.id_number, EXCLUDED.id_number)
         RETURNING id`,
        [code, idNumber]
      );
      return made.rows[0]?.id ?? null;
    }
    // An id number nobody has registered and no code to name them by. Left
    // unresolved rather than guessed at; the import reports it.
    return null;
  }

  return preacherIdForCode(input.code, client);
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
  // Searched across all three identifiers, because the office knows a preacher
  // by whichever one is in front of them: the code on a sheet, the name a donor
  // said, or the ID number on a paper register.
  const q = String(req.query.q ?? '').trim();
  const search = q ? `%${q}%` : null;

  try {
    if (!withCounts) {
      const rows = await pool.query(
        `SELECT * FROM preachers
          WHERE $1::text IS NULL OR code ILIKE $1 OR name ILIKE $1 OR id_number ILIKE $1
          ORDER BY active DESC, code`,
        [search]
      );
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
                  COUNT(*) FILTER (WHERE le.converted_at IS NOT NULL)::int AS converted,
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
        WHERE $1::text IS NULL OR p.code ILIKE $1 OR p.name ILIKE $1 OR p.id_number ILIKE $1
        ORDER BY p.active DESC, l.leads DESC NULLS LAST, p.code`,
      [search]
    );
    res.json({ preachers: rows.rows });
  } catch (err) {
    console.error('crm.listPreachers error:', err);
    res.status(500).json({ error: 'Could not load the preachers' });
  }
});

router.post('/preachers', authorize('admin', 'accountant'), async (req, res) => {
  const code = normalizeCode(req.body?.code);
  if (!code) return res.status(400).json({ error: 'Enter a preacher code.' });
  const idNumber = normalizeIdNumber(req.body?.id_number);

  try {
    // Said plainly before the insert rather than letting the unique index throw
    // it back as a constraint name: an ID typed twice is nearly always the
    // office working from two copies of the same paper list, and the useful
    // answer names who already has it.
    if (idNumber) {
      const clash = await pool.query(
        `SELECT code, name FROM preachers WHERE id_number = $1 AND code <> $2`,
        [idNumber, code]
      );
      if (clash.rows.length) {
        const o = clash.rows[0];
        return res.status(409).json({
          error: `ID ${idNumber} is already used by ${o.name || o.code}.`,
        });
      }
    }

    const result = await pool.query(
      `INSERT INTO preachers (code, name, phone, notes, id_number)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (code) DO UPDATE SET
         name      = COALESCE(EXCLUDED.name, preachers.name),
         phone     = COALESCE(EXCLUDED.phone, preachers.phone),
         notes     = COALESCE(EXCLUDED.notes, preachers.notes),
         id_number = COALESCE(EXCLUDED.id_number, preachers.id_number),
         updated_at = NOW()
       RETURNING *`,
      [code, str(req.body?.name, 160), str(req.body?.phone, 15), str(req.body?.notes, 2000), idNumber]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('crm.createPreacher error:', err);
    res.status(500).json({ error: 'Could not save that preacher' });
  }
});

router.put('/preachers/:id', authorize('admin', 'accountant'), async (req, res) => {
  const b = req.body ?? {};
  try {
    // An empty string means "clear this", which COALESCE alone cannot express
    // - it would read the empty value as "leave it alone" and the office would
    // have no way to remove an ID typed in error.
    const idNumber = b.id_number === undefined ? undefined : normalizeIdNumber(b.id_number);
    if (idNumber) {
      const clash = await pool.query(
        `SELECT code, name FROM preachers WHERE id_number = $1 AND id <> $2`,
        [idNumber, req.params.id]
      );
      if (clash.rows.length) {
        const o = clash.rows[0];
        return res.status(409).json({ error: `ID ${idNumber} is already used by ${o.name || o.code}.` });
      }
    }

    const result = await pool.query(
      `UPDATE preachers SET
         code   = COALESCE($1, code),
         name   = COALESCE($2, name),
         phone  = COALESCE($3, phone),
         notes  = COALESCE($4, notes),
         active = COALESCE($5::boolean, active),
         id_number = CASE WHEN $7::boolean THEN $8 ELSE id_number END,
         updated_at = NOW()
       WHERE id = $6 RETURNING *`,
      [
        normalizeCode(b.code),
        str(b.name, 160),
        str(b.phone, 15),
        str(b.notes, 2000),
        typeof b.active === 'boolean' ? b.active : null,
        req.params.id,
        idNumber !== undefined,
        idNumber ?? null,
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
router.post('/preachers/:id/retire', authorize('admin', 'accountant'), async (req, res) => {
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
