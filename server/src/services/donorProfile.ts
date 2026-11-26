// Who somebody is as a donor: the giving totals, year by year, what for, every gift, and their DRM
// lead. One place for it, so the profile that opens from a WhatsApp chat and the one that opens from
// the Sankalpam list are the same thing.

import pool from '../db/pool';

const PERSON_COLS = `id, name, phone, email, COALESCE(address_city, address_area) AS city, created_at`;

/** The donor with this DRM id, else the oldest one with this mobile number (last 10 digits); null if neither. */
export async function findDonorPerson(personId: string | null, phone: string | null) {
  if (personId) {
    const r = await pool.query(`SELECT ${PERSON_COLS} FROM people WHERE id = $1`, [personId]);
    if (r.rows[0]) return r.rows[0];
  }
  const digits = String(phone ?? '').replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return null;
  const r = await pool.query(
    `SELECT ${PERSON_COLS} FROM people
      WHERE RIGHT(regexp_replace(phone, '\\D', '', 'g'), 10) = $1
      ORDER BY created_at LIMIT 1`,
    [digits]
  );
  return r.rows[0] ?? null;
}

/** The whole profile. `person: null` means this number is not a donor in DRM yet. */
export async function buildDonorProfile(person: { id: string } | null) {
  if (!person) return { person: null };
  const [totals, years, purposes, donations, lead] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::numeric AS total,
              COALESCE(MAX(amount), 0)::numeric AS largest, MIN(created_at) AS first_at, MAX(created_at) AS last_at,
              COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('year', NOW())), 0)::numeric AS this_year
         FROM donations WHERE person_id = $1`,
      [person.id]
    ),
    pool.query(
      `SELECT EXTRACT(YEAR FROM created_at)::int AS year, COUNT(*)::int AS count, SUM(amount)::numeric AS total
         FROM donations WHERE person_id = $1 GROUP BY 1 ORDER BY 1 DESC LIMIT 10`,
      [person.id]
    ),
    pool.query(
      `SELECT COALESCE(NULLIF(TRIM(purpose), ''), 'Donation') AS purpose, COUNT(*)::int AS count, SUM(amount)::numeric AS total
         FROM donations WHERE person_id = $1 GROUP BY 1 ORDER BY 3 DESC LIMIT 5`,
      [person.id]
    ),
    pool.query(
      `SELECT id, amount, purpose, source_page, source_site, receipt_number, created_at,
              payment_mode, payment_ref, sevak_name, source
         FROM donations WHERE person_id = $1 ORDER BY created_at DESC LIMIT 500`,
      [person.id]
    ),
    pool.query(
      `SELECT l.id, st.label AS status_label, u.name AS caller_name, l.next_follow_up_at
         FROM leads l
         LEFT JOIN crm_statuses st ON st.slug = l.status
         LEFT JOIN users u ON u.id = l.assigned_to
        WHERE l.person_id = $1
        ORDER BY l.updated_at DESC LIMIT 1`,
      [person.id]
    ),
  ]);
  const t = totals.rows[0];
  return {
    person,
    stats: {
      count: t.count,
      total: Number(t.total),
      average: t.count ? Number(t.total) / t.count : 0,
      largest: Number(t.largest),
      this_year: Number(t.this_year),
      first_at: t.first_at,
      last_at: t.last_at,
    },
    by_year: years.rows.map((y) => ({ year: y.year, count: y.count, total: Number(y.total) })),
    by_purpose: purposes.rows.map((p) => ({ purpose: p.purpose, count: p.count, total: Number(p.total) })),
    donations: donations.rows,
    lead: lead.rows[0] ?? null,
  };
}
