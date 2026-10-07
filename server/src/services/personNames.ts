// Every name one phone number has given money under.
//
// WHY THIS IS A SERVICE AND NOT TWO LINES OF SQL AT EACH CALL SITE
// Names enter DRM from six places - the two sites' webhooks, the offline
// receipt, the lead importer, the QR flow and a staff member typing one in -
// and before this they each made their own decision about what a second name
// on a known phone meant. Two of them overwrote the first name, one of them
// flagged it as a conflict for staff to resolve, and the rest ignored it. The
// donor experienced that as DRM forgetting what to call her.
//
// THE RULE, IN ONE PLACE
//   - The first real name seen for a phone is the donor's own. It is primary
//     and it does not move, however many names arrive later.
//   - Every later name is kept beside it, not instead of it.
//   - A placeholder ("Donor 9876543210", invented when a site sends no name)
//     is not a name. It never takes a primary slot from a real name, and a
//     real name always displaces it.
//   - The same name typed differently is the same name.
//
// See the block comment above person_names in db/schema.sql for the situation
// this exists for.

import type { PoolClient } from 'pg';
import pool from '../db/pool';

/** A query runner: the pool, or a client inside someone else's transaction. */
type Q = Pick<PoolClient, 'query'>;

/**
 * The form two spellings of one name have in common.
 *
 * Case and run-together whitespace only. Deliberately NOT clever: stripping
 * initials or honorifics would fold "Ravi Das" and "R Das" together, and in a
 * family sharing one number those are routinely two different people - which
 * is the exact distinction this table exists to preserve.
 */
export function nameKey(name: string): string {
  return String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** What DRM invents when a site sends a donation with no name attached. */
export function isPlaceholderName(name: string): boolean {
  return /^donor\s*\d{6,}$/i.test(String(name ?? '').trim());
}

/**
 * Pick the better-looking spelling of one name.
 *
 * ALL CAPS or all lower case is nearly always a machine's rendering of a name
 * somebody typed properly elsewhere.
 */
function preferredSpelling(a: string, b: string): string {
  const typed = (n: string) => n !== n.toUpperCase() && n !== n.toLowerCase();
  if (typed(a) && !typed(b)) return a;
  if (typed(b) && !typed(a)) return b;
  return a;
}

export interface RegisterResult {
  /** The name as stored, after spelling preference. */
  name: string;
  /** True when this phone had never been seen under this name before. */
  added: boolean;
  /** True when this name is the donor's own rather than a family member's. */
  primary: boolean;
}

/**
 * Record that a donation arrived under `name` for this person.
 *
 * Safe to call on every donation, including repeats - a name already on the
 * roster just has its last_seen_at moved. Returns what happened so a caller
 * can log it; nothing here throws for an ordinary duplicate.
 */
export async function registerName(
  q: Q,
  personId: string,
  rawName: string | null | undefined,
  source: string
): Promise<RegisterResult | null> {
  const name = String(rawName ?? '').trim();
  if (!name) return null;

  const key = nameKey(name);

  // A placeholder earns a row only when there is nothing else at all, so the
  // donor record is never empty. A real name arriving later takes over as
  // primary below.
  const placeholder = isPlaceholderName(name);

  const existing = await q.query<{ id: string; name: string; is_primary: boolean }>(
    `SELECT id, name, is_primary FROM person_names WHERE person_id = $1 AND name_key = $2`,
    [personId, key]
  );

  if (existing.rows.length) {
    const row = existing.rows[0];
    const better = preferredSpelling(row.name, name);
    await q.query(
      `UPDATE person_names SET name = $1, last_seen_at = NOW() WHERE id = $2`,
      [better, row.id]
    );
    return { name: better, added: false, primary: row.is_primary };
  }

  // Is there a primary yet, and is it a real name?
  const current = await q.query<{ id: string; name: string }>(
    `SELECT id, name FROM person_names WHERE person_id = $1 AND is_primary`,
    [personId]
  );
  const currentPrimary = current.rows[0] ?? null;
  const primaryIsPlaceholder = currentPrimary ? isPlaceholderName(currentPrimary.name) : false;

  // This name becomes primary when nothing holds that slot, or when the thing
  // holding it is a placeholder and this is a real name.
  const takePrimary = !currentPrimary || (primaryIsPlaceholder && !placeholder);

  if (takePrimary && currentPrimary) {
    // Demote first: uq_person_names_primary allows only one, and the insert
    // below would otherwise fail on it.
    await q.query(`UPDATE person_names SET is_primary = FALSE WHERE id = $1`, [currentPrimary.id]);
  }

  await q.query(
    `INSERT INTO person_names (person_id, name, name_key, is_primary, source)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (person_id, name_key) DO UPDATE SET last_seen_at = NOW()`,
    [personId, name, key, takePrimary, source.slice(0, 20)]
  );

  return { name, added: true, primary: takePrimary };
}

export interface PersonName {
  name: string;
  is_primary: boolean;
  source: string | null;
  first_seen_at: string;
  last_seen_at: string;
  donation_count: number;
  donation_total: number;
}

/**
 * The roster for one donor, with what was given under each name.
 *
 * The donor's own name sorts first and the rest by what they have given, so
 * the list reads as "this is the donor, and this is the family giving through
 * them" rather than as an undifferentiated pile.
 *
 * Donations are attributed by the name written on them, falling back to the
 * primary for rows taken before donor_name existed - see the schema note.
 */
export async function namesFor(personId: string): Promise<PersonName[]> {
  const { rows } = await pool.query<PersonName>(
    `SELECT pn.name,
            pn.is_primary,
            pn.source,
            pn.first_seen_at,
            pn.last_seen_at,
            COALESCE(d.n, 0)::int       AS donation_count,
            COALESCE(d.total, 0)::float AS donation_total
       FROM person_names pn
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS n, SUM(amount) AS total
           FROM donations dn
          WHERE dn.person_id = pn.person_id
            AND (
              -- Who the gift was from.
              lower(regexp_replace(btrim(dn.given_name), '\\s+', ' ', 'g')) = pn.name_key
              /* Who it was offered FOR - the "on the name of" on the receipt.

                 This is the half that answers the question actually being
                 asked. A daughter giving in her mother's name is donor_name =
                 the daughter and sevak_name = the mother, so counting only
                 donor_name would show the mother with nothing against her
                 name, which is precisely the gift the family remembers. */
              OR lower(regexp_replace(btrim(dn.sevak_name), '\\s+', ' ', 'g')) = pn.name_key
              -- Taken before either was recorded: no evidence of another name,
              -- so it belongs to the donor rather than to a guess at a relative.
              OR (dn.given_name IS NULL AND dn.sevak_name IS NULL AND pn.is_primary)
            )
       ) d ON TRUE
      WHERE pn.person_id = $1
      ORDER BY pn.is_primary DESC, COALESCE(d.total, 0) DESC, pn.first_seen_at`,
    [personId]
  );
  return rows;
}
