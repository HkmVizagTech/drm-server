// The special days DRM already knows for a donor, and keeping their Sankalpam
// entry up to date with them.
//
// WHERE THE DAYS COME FROM
//   people.date_of_birth     -> "Birthday"
//   people.anniversary_date  -> "Marriage Anniversary"
//   a donation's occasion + seva_date, when the occasion is a birthday,
//   anniversary or remembrance -> "<on the name of> <occasion>", e.g.
//   "Lakshmi Birthday". A donation booked for an ordinary date (Annadana on
//   the 12th) is not a yearly day and is left out.
//
// THE RULE THAT KEEPS IT SAFE
// A day is only ever ADDED, and only when the donor has nothing on that date
// yet - whatever the wording. Nothing a person typed or uploaded is changed or
// removed. So a donor who fills in their birthday on the site months after
// being added gets it here on the next sync, and a corrected day typed in
// Sankalpam is never overwritten.

import type { PoolClient } from 'pg';
import { notify } from './notifications';

type Db = Pick<PoolClient, 'query'>;

export interface KnownDay {
  occasion: string;
  month: number;
  day: number;
  year: number | null;
}

const YEARLY = /birth|b'?day|dob|anniversar|marriage|marrage|wedding|married|death|remembrance|punya|tithi|shraddh/i;

const tidy = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t === t.toUpperCase() ? t.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase()) : t;
};

const sameName = (a: string | null, b: string | null) => {
  const k = (s: string | null) => String(s ?? '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
  return !a || !b || k(a) === k(b);
};

/** "2026-10-15" -> { month, day, year } */
function parts(iso: string | Date | null): { month: number; day: number; year: number } | null {
  if (!iso) return null;
  const s = iso instanceof Date ? iso.toISOString().slice(0, 10) : String(iso).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? { year: +m[1], month: +m[2], day: +m[3] } : null;
}

/** The days DRM knows for one person, one per date. */
export async function daysFromPerson(db: Db, personId: string): Promise<KnownDay[]> {
  const p = (
    await db.query(
      `SELECT name, to_char(date_of_birth, 'YYYY-MM-DD') AS dob, to_char(anniversary_date, 'YYYY-MM-DD') AS ann
         FROM people WHERE id = $1`,
      [personId]
    )
  ).rows[0];
  if (!p) return [];
  const thisYear = new Date().getUTCFullYear();
  const out: KnownDay[] = [];
  const seen = new Set<string>();
  const add = (occasion: string, iso: string | null, keepYear: boolean) => {
    const x = parts(iso);
    if (!x) return;
    const k = `${x.month}-${x.day}`;
    if (seen.has(k)) return;
    seen.add(k);
    // The forms often take "this year's" date for a birthday; a year that is
    // this year or later says nothing about when it began.
    out.push({ occasion, month: x.month, day: x.day, year: keepYear && x.year < thisYear ? x.year : null });
  };
  add('Birthday', p.dob, true);
  add('Marriage Anniversary', p.ann, true);

  const { rows } = await db.query(
    `SELECT occasion, sevak_name, to_char(seva_date, 'YYYY-MM-DD') AS day
       FROM donations
      WHERE person_id = $1 AND seva_date IS NOT NULL AND occasion IS NOT NULL
      ORDER BY created_at DESC`,
    [personId]
  );
  for (const r of rows) {
    if (!YEARLY.test(r.occasion)) continue;
    const word = tidy(String(r.occasion));
    const label = !sameName(r.sevak_name, p.name) ? `${tidy(String(r.sevak_name))} ${word}` : word;
    add(label.slice(0, 160), r.day, false);
  }
  return out;
}

/**
 * Bring every Sankalpam donor for this person up to date with the days DRM
 * knows. Links a donor on the same mobile number that is not linked yet.
 * Returns how many days were added.
 */
export async function refreshSankalpFromPerson(
  db: Db,
  personId: string,
  /** quiet: no bell notification - for bulk adds, where the person adding them is looking. */
  opts: { quiet?: boolean } = {}
): Promise<number> {
  const person = (
    await db.query(
      `SELECT right(regexp_replace(phone, '\\D', '', 'g'), 10) AS phone,
              COALESCE(prasadam_address, address) AS address
         FROM people WHERE id = $1`,
      [personId]
    )
  ).rows[0];
  if (!person) return 0;

  await db.query(
    `UPDATE sankalpam_donors SET person_id = $1, updated_at = NOW()
      WHERE person_id IS NULL AND (phone = $2 OR alt_phone = $2)`,
    [personId, person.phone]
  );
  const donors = (await db.query(`SELECT id, donor_name FROM sankalpam_donors WHERE person_id = $1`, [personId])).rows;
  if (!donors.length) return 0;

  const days = await daysFromPerson(db, personId);
  let added = 0;
  for (const d of donors) {
    if (person.address) {
      await db.query(`UPDATE sankalpam_donors SET address = COALESCE(address, $2) WHERE id = $1`, [d.id, person.address]);
    }
    if (!days.length) continue;
    const had = new Set(
      (await db.query(`SELECT month, day FROM sankalpam_dates WHERE donor_id = $1`, [d.id])).rows.map((r) => `${r.month}-${r.day}`)
    );
    for (const k of days) {
      if (had.has(`${k.month}-${k.day}`)) continue;
      const r = await db.query(
        `INSERT INTO sankalpam_dates (donor_id, occasion, month, day, orig_year, origin)
         VALUES ($1, $2, $3, $4, $5, 'site') ON CONFLICT DO NOTHING`,
        [d.id, k.occasion, k.month, k.day, k.year]
      );
      added += r.rowCount ?? 0;
      had.add(`${k.month}-${k.day}`);
      // Said in the bell: a day nobody typed has just appeared on the list.
      if (r.rowCount && !opts.quiet) {
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        await notify(
          {
            kind: 'sankalpam',
            title: `New special day · ${d.donor_name}`,
            body: `${k.day} ${months[k.month - 1]} · ${k.occasion} - from their donation form`,
            link: `/sankalpam?tab=donors&edit=${d.id}`,
            refKey: `sk-day:${d.id}:${k.month}-${k.day}`,
          },
          db
        );
      }
    }
  }
  return added;
}
