// Sankalpam: the puja on a donor's special day, filmed and sent to them.
//
// See the note above sankalpam_donors in schema.sql for the three tables. The
// one idea worth repeating here: a sankalp day is a day and a month, and it
// comes round every year. Nothing is copied forward each January - the days
// due in any window are worked out from day + month when they are asked for,
// and what was done about them is recorded per (day, year).
//
// WHO
// Admins and callers. The caller is the one who sees the day's list and sends
// the videos; the admin sets up and uploads. Removing a donor outright is the
// admin's; anybody can switch one off.

import { Router } from 'express';
import type { PoolClient } from 'pg';
import pool from '../db/pool';
import { authenticate, authorize } from '../middleware/auth';
import { parseWorkbook, detectColumns, cellText, normalizePhone, isDialable, buildWorkbook } from '../utils/spreadsheet';
import { sendExport } from '../utils/export';
import { refreshSankalpFromPerson } from '../services/sankalpDays';

const router = Router();
router.use(authenticate, authorize('admin', 'caller'));

/* ---------------------------------------------------------------- helpers */

const str = (v: unknown, max = 255): string | null => {
  const s = cellText(v).replace(/\s+/g, ' ').trim();
  if (!s || /^(null|nil|n\/?a|-)$/i.test(s)) return null;
  return s.slice(0, max);
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "WIFE BIRTHDAY" -> "Wife Birthday". The office types in capitals; the screen should not shout. */
export function tidyOccasion(v: string): string {
  const s = v.replace(/\s+/g, ' ').trim();
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
}
const tidyName = (v: string | null) => (v ? tidyOccasion(v) : null);

const DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * A day and month (and the year, when one is on record) from whatever a sheet
 * holds: an Excel date, "16-01-1998", "16/1", "1998-01-16", "16-Jan", "16 January 1998".
 * Day first, as India writes it.
 */
export function parseDayMonth(v: unknown): { day: number; month: number; year: number | null } | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    // exceljs hands dates over as UTC midnight; reading them in local time
    // would move every day back by one west of Greenwich.
    return { day: v.getUTCDate(), month: v.getUTCMonth() + 1, year: v.getUTCFullYear() };
  }
  if (typeof v === 'number' && v > 59 && v < 80000) {
    // A raw Excel serial (a CSV export of a date column, say).
    const d = new Date(Math.round((v - 25569) * 86400000));
    return { day: d.getUTCDate(), month: d.getUTCMonth() + 1, year: d.getUTCFullYear() };
  }
  const s = cellText(v).trim().toLowerCase();
  if (!s || s === 'null') return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return ok(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[\s./-]+(\d{1,2})(?:[\s./-]+(\d{2,4}))?$/);
  if (m) return ok(+m[1], +m[2], m[3] ? year4(+m[3]) : null);
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s./-]*([a-z]{3})[a-z]*\.?(?:[\s,./-]+(\d{2,4}))?$/);
  if (m) return ok(+m[1], MONTHS.indexOf(m[2]) + 1, m[3] ? year4(+m[3]) : null);
  m = s.match(/^([a-z]{3})[a-z]*\.?[\s./-]*(\d{1,2})(?:st|nd|rd|th)?(?:[\s,./-]+(\d{2,4}))?$/);
  if (m) return ok(+m[2], MONTHS.indexOf(m[1]) + 1, m[3] ? year4(+m[3]) : null);
  return null;

  function year4(y: number) {
    return y < 100 ? (y > 30 ? 1900 + y : 2000 + y) : y;
  }
  function ok(day: number, month: number, year: number | null) {
    if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= DAYS_IN[month - 1])) return null;
    return { day, month, year: year && year > 1800 && year < 2200 ? year : null };
  }
}

/** Today on the temple's calendar. */
async function istToday(db: { query: PoolClient['query'] } = pool): Promise<string> {
  const r = await db.query(`SELECT to_char((NOW() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS d`);
  return r.rows[0].d;
}

async function personFor(db: { query: PoolClient['query'] }, phone: string | null): Promise<string | null> {
  if (!phone) return null;
  const r = await db.query(`SELECT id FROM people WHERE right(regexp_replace(phone, '\\D', '', 'g'), 10) = $1 LIMIT 1`, [phone]);
  return r.rows[0]?.id ?? null;
}

/**
 * Every sankalp day falling between two dates, with what has been done about it.
 *
 * Worked out from day + month for each year the window touches - which is what
 * makes a day repeat every year without anybody copying it forward, and what
 * makes 31 Dec -> 1 Jan a window like any other. A 29 February day lands on
 * the 28th in a year without one.
 */
const OCCURRENCES = `
  WITH yrs AS (
    SELECT generate_series(EXTRACT(YEAR FROM $1::date)::int, EXTRACT(YEAR FROM $2::date)::int) AS yr
  ),
  occ AS (
    SELECT d.id AS date_id, d.donor_id, d.occasion, d.month, d.day, d.orig_year, d.notes AS date_notes, y.yr AS year,
           (d.created_at AT TIME ZONE 'Asia/Kolkata')::date AS added_on,
           make_date(y.yr, d.month,
             LEAST(d.day, EXTRACT(DAY FROM (make_date(y.yr, d.month, 1) + INTERVAL '1 month' - INTERVAL '1 day'))::int)
           ) AS due_on
      FROM sankalpam_dates d CROSS JOIN yrs y
     WHERE d.active
  )
  SELECT occ.date_id, occ.donor_id, occ.occasion, occ.month, occ.day, occ.orig_year, occ.date_notes, occ.year,
         to_char(occ.due_on, 'YYYY-MM-DD') AS due_on, to_char(occ.added_on, 'YYYY-MM-DD') AS added_on,
         dn.donor_name, dn.sevak_name, dn.phone, dn.alt_phone, dn.preacher, dn.patron_number, dn.person_id, dn.source,
         pr.name AS preacher_name,
         COALESCE(s.status, 'todo') AS status, s.note, s.done_at, u.name AS done_by_name
    FROM occ
    JOIN sankalpam_donors dn ON dn.id = occ.donor_id AND dn.active
    LEFT JOIN preachers pr ON upper(pr.code) = upper(dn.preacher)
    LEFT JOIN sankalpam_sends s ON s.date_id = occ.date_id AND s.year = occ.year
    LEFT JOIN users u ON u.id = s.done_by
   WHERE occ.due_on BETWEEN $1::date AND $2::date`;

/* ---------------------------------------------------------------- the day */

/**
 * GET /sankalpam/board - what to send today, what is coming, what was missed.
 *
 * The screen a caller opens every morning. Missed reaches back a fortnight:
 * a video a few days late is still worth sending, one from last month is not
 * news to anybody and would only make the list impossible to clear.
 */
router.get('/board', async (req, res) => {
  try {
    const today = await istToday();
    const ahead = Math.min(31, Math.max(1, Number(req.query.days) || 7));
    const { rows } = await pool.query(
      `${OCCURRENCES}
         -- Done ones from before today drop out; still-to-do ones stay as
         -- missed - but only days that passed after they were added. A sheet
         -- uploaded today has not "missed" last week.
         AND (occ.due_on >= $3::date
              OR (COALESCE(s.status, 'todo') IN ('todo', 'ready') AND occ.due_on >= occ.added_on))
       ORDER BY occ.due_on, dn.donor_name`,
      // $1..$2 is the window; $3 is today, so done items from before today
      // drop out while anything still to do stays.
      [shift(today, -14), shift(today, ahead), today]
    );
    const tomorrow = shift(today, 1);
    const pending = (r: { status: string }) => r.status === 'todo' || r.status === 'ready';
    res.json({
      today,
      tomorrow,
      items: rows,
      counts: {
        missed: rows.filter((r) => r.due_on < today && pending(r)).length,
        today: rows.filter((r) => r.due_on === today && pending(r)).length,
        today_total: rows.filter((r) => r.due_on === today).length,
        tomorrow: rows.filter((r) => r.due_on === tomorrow).length,
        later: rows.filter((r) => r.due_on > tomorrow).length,
      },
    });
  } catch (err) {
    console.error('sankalpam.board error:', err);
    res.status(500).json({ error: 'Could not load sankalpam.' });
  }
});

/** GET /sankalpam/summary - the numbers for the sidebar badge and the reminder strip. */
/**
 * The day's numbers: videos to send today, missed, coming tomorrow, and the
 * calls due to ask donors for their days. Used by the badge, the reminder
 * strip and the morning notification.
 */
export async function sankalpCounts() {
  const date = await istToday();
  const today = date;
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE x.due_on < $3 AND x.due_on >= x.added_on AND x.status IN ('todo','ready'))::int AS missed,
       COUNT(*) FILTER (WHERE x.due_on = $3 AND x.status IN ('todo','ready'))::int AS today,
       COUNT(*) FILTER (WHERE x.due_on = $4)::int AS tomorrow
     FROM (${OCCURRENCES}) x`,
    [shift(today, -14), shift(today, 1), today, shift(today, 1)]
  );
  // Donors still without a day, with a number to ring: callbacks that are
  // due, and those nobody has rung yet.
  const calls = (
    await pool.query(
      `SELECT COUNT(*) FILTER (WHERE lc.next_call_at IS NOT NULL AND lc.next_call_at <= NOW())::int AS calls_due,
              COUNT(*) FILTER (WHERE lc.id IS NULL)::int AS never_rung
         FROM sankalpam_donors dn
         LEFT JOIN LATERAL (SELECT id, next_call_at FROM sankalpam_calls c WHERE c.donor_id = dn.id
                             ORDER BY c.called_at DESC LIMIT 1) lc ON TRUE
        WHERE dn.active AND dn.phone IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM sankalpam_dates d WHERE d.donor_id = dn.id AND d.active)`
    )
  ).rows[0];
  return {
    date,
    today: rows[0].today as number,
    missed: rows[0].missed as number,
    tomorrow: rows[0].tomorrow as number,
    calls_due: calls.calls_due as number,
    never_rung: calls.never_rung as number,
  };
}

/** GET /sankalpam/summary - the numbers for the sidebar badge and the reminder strip. */
router.get('/summary', async (_req, res) => {
  try {
    res.json(await sankalpCounts());
  } catch (err) {
    console.error('sankalpam.summary error:', err);
    res.status(500).json({ error: 'Could not load.' });
  }
});

/** GET /sankalpam/occurrences?from=&to= - any window, for the calendar. At most a year. */
router.get('/occurrences', async (req, res) => {
  const from = String(req.query.from ?? '');
  const to = String(req.query.to ?? '');
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) return res.status(400).json({ error: 'Pick the dates.' });
  if (new Date(to).getTime() - new Date(from).getTime() > 370 * 86400000) {
    return res.status(400).json({ error: 'Pick a shorter range.' });
  }
  try {
    const { rows } = await pool.query(`${OCCURRENCES} ORDER BY occ.due_on, dn.donor_name`, [from, to]);
    res.json({ today: await istToday(), items: rows });
  } catch (err) {
    console.error('sankalpam.occurrences error:', err);
    res.status(500).json({ error: 'Could not load.' });
  }
});

/**
 * PUT /sankalpam/dates/:id/:year { status: todo | ready | sent | skipped, note? }
 *
 * What was done about one day in one year. 'todo' takes it back.
 */
router.put('/dates/:id/:year', async (req, res) => {
  const result = await setStatus([{ date_id: String(req.params.id), year: Number(req.params.year) }], req.body, req.user?.userId ?? null);
  res.status(result.status).json(result.body);
});

/** POST /sankalpam/dates/status { items: [{ date_id, year }], status } - several at once. */
router.post('/dates/status', async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 500) : [];
  const result = await setStatus(items, req.body, req.user?.userId ?? null);
  res.status(result.status).json(result.body);
});

async function setStatus(items: { date_id: string; year: number }[], body: any, by: string | null) {
  const status = String(body?.status ?? '');
  if (!['todo', 'ready', 'sent', 'skipped'].includes(status)) return { status: 400, body: { error: 'Pick a status.' } };
  const clean = items.filter(
    (i) => /^[0-9a-f-]{36}$/i.test(String(i?.date_id)) && Number.isInteger(Number(i?.year)) && i.year > 2000 && i.year < 2200
  );
  if (!clean.length) return { status: 400, body: { error: 'Nothing selected.' } };
  const note = str(body?.note, 500);
  try {
    let n = 0;
    for (const i of clean) {
      if (status === 'todo') {
        const r = await pool.query(`DELETE FROM sankalpam_sends WHERE date_id = $1 AND year = $2`, [i.date_id, i.year]);
        n += r.rowCount ?? 0;
      } else {
        const r = await pool.query(
          `INSERT INTO sankalpam_sends (date_id, year, status, note, done_by)
           SELECT $1, $2, $3, $4, $5 WHERE EXISTS (SELECT 1 FROM sankalpam_dates WHERE id = $1)
           ON CONFLICT (date_id, year) DO UPDATE
             SET status = EXCLUDED.status, note = COALESCE(EXCLUDED.note, sankalpam_sends.note),
                 done_by = EXCLUDED.done_by, done_at = NOW()`,
          [i.date_id, i.year, status, note, by]
        );
        n += r.rowCount ?? 0;
      }
    }
    return { status: 200, body: { updated: n } };
  } catch (err) {
    console.error('sankalpam.status error:', err);
    return { status: 500, body: { error: 'Could not save. Try again.' } };
  }
}

/* ---------------------------------------------------------------- donors */

const DONOR_FIELDS = `
  dn.id, dn.patron_number, dn.donor_name, dn.sevak_name, dn.phone, dn.alt_phone, dn.preacher, dn.gotram, dn.address,
  dn.notes, dn.person_id, dn.active, dn.created_at, pr.name AS preacher_name, dn.source,
  -- What they have given, for a donor DRM knows - the reason a donor added
  -- "from donations" is on the list at all.
  (SELECT COALESCE(SUM(dd.amount), 0) FROM donations dd WHERE dd.person_id = dn.person_id) AS total_given,
  -- The calls made to ask for their details.
  (SELECT COUNT(*)::int FROM sankalpam_calls c WHERE c.donor_id = dn.id) AS call_count,
  lc.called_at AS last_call_at, lc.outcome AS last_call_outcome, lc.note AS last_call_note,
  lc.next_call_at, lcu.name AS last_caller_name,
  COALESCE((SELECT json_agg(json_build_object('id', d.id, 'occasion', d.occasion, 'month', d.month, 'day', d.day,
                                              'orig_year', d.orig_year, 'notes', d.notes, 'active', d.active,
                                              'origin', d.origin)
                            ORDER BY d.month, d.day)
              FROM sankalpam_dates d WHERE d.donor_id = dn.id), '[]'::json) AS dates`;

/** The latest call to a donor, joined beside DONOR_FIELDS. */
const DONOR_JOINS = `
  LEFT JOIN preachers pr ON upper(pr.code) = upper(dn.preacher)
  LEFT JOIN LATERAL (SELECT * FROM sankalpam_calls c WHERE c.donor_id = dn.id ORDER BY c.called_at DESC LIMIT 1) lc ON TRUE
  LEFT JOIN users lcu ON lcu.id = lc.called_by`;

const CHECKED = `EXISTS (SELECT 1 FROM sankalpam_calls cc WHERE cc.donor_id = dn.id AND cc.outcome IN ('got_details', 'verified') AND cc.called_at > NOW() - INTERVAL '1 year')`;

/** GET /sankalpam/donors?search=&preacher=&month=&need=days|gotram|check&limit= */
router.get('/donors', async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const where: string[] = [];
  const values: unknown[] = [];
  const search = str(q.search, 80);
  if (search) {
    values.push(`%${search}%`);
    const digits = search.replace(/\D/g, '');
    let phoneClause = '';
    if (digits.length >= 4) {
      values.push(`%${digits}%`);
      phoneClause = ` OR dn.phone LIKE $${values.length} OR dn.alt_phone LIKE $${values.length}`;
    }
    const s = values.length - (digits.length >= 4 ? 1 : 0);
    where.push(
      `(dn.donor_name ILIKE $${s} OR dn.sevak_name ILIKE $${s} OR dn.patron_number ILIKE $${s}
        OR EXISTS (SELECT 1 FROM sankalpam_dates d WHERE d.donor_id = dn.id AND d.occasion ILIKE $${s})${phoneClause})`
    );
  }
  const preacher = str(q.preacher, 40);
  if (preacher) {
    values.push(preacher);
    where.push(`upper(dn.preacher) = upper($${values.length})`);
  }
  const month = Number(q.month);
  if (month >= 1 && month <= 12) {
    values.push(month);
    where.push(`EXISTS (SELECT 1 FROM sankalpam_dates d WHERE d.donor_id = dn.id AND d.month = $${values.length} AND d.active)`);
  }
  if (q.show !== 'all') where.push('dn.active');
  // Where they came from: the office's sheet, DRM's own donors, or by hand.
  const source = String(q.source ?? '');
  if (['sheet', 'donors', 'manual'].includes(source)) {
    values.push(source);
    where.push(`dn.source = $${values.length}`);
  }
  // Who still needs a call to ask: no special day yet, or no gotram.
  if (q.need === 'days') {
    where.push(`NOT EXISTS (SELECT 1 FROM sankalpam_dates d WHERE d.donor_id = dn.id AND d.active)`);
  } else if (q.need === 'gotram') {
    where.push(`NULLIF(trim(COALESCE(dn.gotram, '')), '') IS NULL`);
  } else if (q.need === 'check') {
    // Everyone, to ring and check their details once a year. A donor leaves
    // this list for a year once a call confirms or updates their details.
    where.push(`dn.active AND NOT ${CHECKED}`);
  }
  // The calling order for that list: a callback that is due, then nobody
  // rung yet, then the longest since the last try. A callback booked for
  // later sinks to the bottom until its day.
  const order =
    q.need === 'days' || q.need === 'gotram' || q.need === 'check'
      ? `ORDER BY (lc.next_call_at IS NOT NULL AND lc.next_call_at <= NOW()) DESC,
                  (lc.called_at IS NULL) DESC,
                  (lc.next_call_at IS NOT NULL AND lc.next_call_at > NOW()) ASC,
                  lc.called_at ASC NULLS FIRST, dn.donor_name`
      : `ORDER BY dn.patron_number NULLS LAST, dn.donor_name`;
  const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  try {
    const [rows, total, preachers] = await Promise.all([
      pool.query(
        `SELECT ${DONOR_FIELDS} FROM sankalpam_donors dn ${DONOR_JOINS}
          ${w} ${order} LIMIT ${limit}`,
        values
      ),
      pool.query(
        `SELECT COUNT(*)::int AS donors,
                (SELECT COUNT(*)::int FROM sankalpam_dates d WHERE d.active AND d.donor_id IN (SELECT dn.id FROM sankalpam_donors dn ${w})) AS dates
           FROM sankalpam_donors dn ${w}`,
        values
      ),
      pool.query(
        `SELECT DISTINCT upper(preacher) AS code FROM sankalpam_donors WHERE preacher IS NOT NULL ORDER BY 1`
      ),
    ]);
    // How many sit in each list, for the counts on the switch and the tab.
    const counts = (
      await pool.query(
        `SELECT COUNT(*) FILTER (WHERE source = 'sheet')::int AS sheet,
                COUNT(*) FILTER (WHERE source = 'donors')::int AS donors,
                COUNT(*) FILTER (WHERE source = 'manual')::int AS manual,
                COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM sankalpam_dates d WHERE d.donor_id = dn.id AND d.active))::int AS need_days,
                COUNT(*) FILTER (WHERE NULLIF(trim(COALESCE(dn.gotram, '')), '') IS NULL)::int AS need_gotram,
                COUNT(*) FILTER (WHERE NOT ${CHECKED})::int AS need_check
           FROM sankalpam_donors dn WHERE dn.active`
      )
    ).rows[0];
    res.json({
      donors: rows.rows,
      total: total.rows[0].donors,
      dates: total.rows[0].dates,
      preachers: preachers.rows.map((r) => r.code),
      counts,
    });
  } catch (err) {
    console.error('sankalpam.donors error:', err);
    res.status(500).json({ error: 'Could not load.' });
  }
});

router.get('/donors/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${DONOR_FIELDS} FROM sankalpam_donors dn ${DONOR_JOINS}
        WHERE dn.id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json({ donor: r.rows[0] });
  } catch (err) {
    console.error('sankalpam.donor error:', err);
    res.status(500).json({ error: 'Could not load.' });
  }
});

interface DateInput {
  id?: string;
  occasion?: string;
  month?: number;
  day?: number;
  orig_year?: number | null;
  notes?: string | null;
  active?: boolean;
}

function cleanDates(list: unknown): { dates: DateInput[]; problem: string | null } {
  const arr = Array.isArray(list) ? (list as DateInput[]) : [];
  const dates: DateInput[] = [];
  for (const d of arr.slice(0, 60)) {
    const occasion = str(d?.occasion, 160);
    const month = Number(d?.month);
    const day = Number(d?.day);
    if (!occasion && !month && !day) continue;
    if (!occasion) return { dates, problem: 'Enter the occasion for every date.' };
    if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= DAYS_IN[month - 1])) {
      return { dates, problem: `Check the date for "${occasion}".` };
    }
    const y = Number(d?.orig_year);
    dates.push({
      id: typeof d?.id === 'string' && /^[0-9a-f-]{36}$/i.test(d.id) ? d.id : undefined,
      occasion,
      month,
      day,
      orig_year: y > 1800 && y < 2200 ? y : null,
      notes: str(d?.notes, 500),
      active: d?.active !== false,
    });
  }
  return { dates, problem: null };
}

function donorInput(b: any) {
  const phone = normalizePhone(b?.phone);
  const alt = normalizePhone(b?.alt_phone);
  return {
    patron_number: str(b?.patron_number, 40)?.toUpperCase() ?? null,
    donor_name: str(b?.donor_name, 160),
    sevak_name: str(b?.sevak_name, 160),
    phone: phone || null,
    alt_phone: alt || null,
    preacher: str(b?.preacher, 40)?.toUpperCase() ?? null,
    gotram: str(b?.gotram, 80),
    address: str(b?.address, 600),
    notes: str(b?.notes, 1000),
  };
}

/** POST /sankalpam/donors { ...donor, dates: [{ occasion, day, month, orig_year? }] } */
router.post('/donors', async (req, res) => {
  const d = donorInput(req.body);
  if (!d.donor_name) return res.status(400).json({ error: 'Enter the Donor Name.' });
  if (d.phone && !isDialable(d.phone)) return res.status(400).json({ error: 'Enter a 10-digit mobile number.' });
  const { dates, problem } = cleanDates(req.body?.dates);
  if (problem) return res.status(400).json({ error: problem });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (d.patron_number) {
      const dup = await client.query(`SELECT id FROM sankalpam_donors WHERE upper(patron_number) = $1`, [d.patron_number]);
      if (dup.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Patron ${d.patron_number} is already here. Add the date to them.`, id: dup.rows[0].id });
      }
    }
    const ins = await client.query(
      `INSERT INTO sankalpam_donors (patron_number, donor_name, sevak_name, phone, alt_phone, preacher, address, notes, person_id, created_by, gotram)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [d.patron_number, d.donor_name, d.sevak_name, d.phone, d.alt_phone, d.preacher, d.address, d.notes,
       await personFor(client, d.phone), req.user?.userId ?? null, d.gotram]
    );
    const id = ins.rows[0].id;
    await writeDates(client, id, dates, false);
    // A donor DRM already knows: add the days they gave on the sites.
    const pid = (await client.query(`SELECT person_id FROM sankalpam_donors WHERE id = $1`, [id])).rows[0]?.person_id;
    if (pid) await refreshSankalpFromPerson(client, pid, { quiet: true });
    await client.query('COMMIT');
    res.status(201).json({ id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('sankalpam.createDonor error:', err);
    res.status(500).json({ error: 'Could not save. Try again.' });
  } finally {
    client.release();
  }
});

/**
 * PUT /sankalpam/donors/:id - the donor and their full list of dates.
 * A date left out of the list is removed, with what was done about it.
 */
router.put('/donors/:id', async (req, res) => {
  const d = donorInput(req.body);
  if (!d.donor_name) return res.status(400).json({ error: 'Enter the Donor Name.' });
  if (d.phone && !isDialable(d.phone)) return res.status(400).json({ error: 'Enter a 10-digit mobile number.' });
  const { dates, problem } = cleanDates(req.body?.dates);
  if (problem) return res.status(400).json({ error: problem });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (d.patron_number) {
      const dup = await client.query(`SELECT id FROM sankalpam_donors WHERE upper(patron_number) = $1 AND id <> $2`, [
        d.patron_number,
        req.params.id,
      ]);
      if (dup.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Patron ${d.patron_number} is another donor.` });
      }
    }
    const up = await client.query(
      `UPDATE sankalpam_donors SET patron_number = $2, donor_name = $3, sevak_name = $4, phone = $5::varchar, alt_phone = $6,
              preacher = $7, address = $8, notes = $9,
              person_id = COALESCE($10, CASE WHEN phone IS DISTINCT FROM $5::varchar THEN NULL ELSE person_id END),
              active = COALESCE($11, active), gotram = $12, updated_at = NOW()
        WHERE id = $1`,
      [req.params.id, d.patron_number, d.donor_name, d.sevak_name, d.phone, d.alt_phone, d.preacher, d.address, d.notes,
       await personFor(client, d.phone), typeof req.body?.active === 'boolean' ? req.body.active : null, d.gotram]
    );
    if (!up.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found.' });
    }
    if (Array.isArray(req.body?.dates)) await writeDates(client, String(req.params.id), dates, true);
    await client.query('COMMIT');
    res.json({ id: req.params.id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    const dupDate = (err as { code?: string }).code === '23505';
    if (!dupDate) console.error('sankalpam.updateDonor error:', err);
    res.status(dupDate ? 409 : 500).json({ error: dupDate ? 'The same occasion is in twice on one day.' : 'Could not save. Try again.' });
  } finally {
    client.release();
  }
});

async function writeDates(client: PoolClient, donorId: string, dates: DateInput[], replace: boolean) {
  const kept: string[] = [];
  for (const dt of dates) {
    if (dt.id) {
      const r = await client.query(
        `UPDATE sankalpam_dates SET occasion = $3, month = $4, day = $5, orig_year = $6, notes = $7, active = $8
          WHERE id = $1 AND donor_id = $2 RETURNING id`,
        [dt.id, donorId, dt.occasion, dt.month, dt.day, dt.orig_year, dt.notes, dt.active]
      );
      if (r.rows.length) {
        kept.push(r.rows[0].id);
        continue;
      }
    }
    const r = await client.query(
      `INSERT INTO sankalpam_dates (donor_id, occasion, month, day, orig_year, notes, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (donor_id, month, day, upper(occasion)) DO UPDATE SET active = EXCLUDED.active
       RETURNING id`,
      [donorId, dt.occasion, dt.month, dt.day, dt.orig_year, dt.notes, dt.active]
    );
    kept.push(r.rows[0].id);
  }
  if (replace) {
    await client.query(`DELETE FROM sankalpam_dates WHERE donor_id = $1 AND NOT (id = ANY($2::uuid[]))`, [donorId, kept]);
  }
}

/** DELETE /sankalpam/donors/:id - gone for good, with their dates. Admin only; anyone can switch one off instead. */
router.delete('/donors/:id', authorize('admin'), async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM sankalpam_donors WHERE id = $1`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Not found.' });
    res.json({ deleted: true });
  } catch (err) {
    console.error('sankalpam.deleteDonor error:', err);
    res.status(500).json({ error: 'Could not delete. Try again.' });
  }
});

/* ---------------------------------------------------------------- the sheet */

// The office's own sheet ("Special Puja Dates") is the format: one row per
// day, the patron's details repeated on each. Headings are matched loosely so
// a re-typed or re-ordered sheet still reads - the month tabs of that same
// workbook (no patron number, a Gotram column) read too.
const PATTERNS = [
  { field: 'patron', any: ['patron', 'donor no', 'donor code', 'donor id'] },
  { field: 'sevak', any: ['sevak', 'on the name', 'in the name'] },
  { field: 'donor', any: ['donor name', 'donorname', 'name'], not: ['sevak', 'preacher', 'occasion'] },
  { field: 'alt', any: ['alternate', 'alt mobile', 'alt phone', 'other mobile', 'mobile 2', 'phone 2'] },
  { field: 'phone', any: ['mobile', 'phone', 'whatsapp', 'contact'], not: ['alternate', 'alt '] },
  { field: 'preacher', any: ['preacher', 'mentor'] },
  { field: 'date', any: ['ocassion date', 'occasion date', 'special ocassion date', 'special occasion date', 'date of', 'dob', 'date'], not: ['short', 'created', 'updated'] },
  { field: 'occasion', any: ['occasion', 'ocassion', 'event', 'purpose', 'special day'] },
  { field: 'gotram', any: ['gotra', 'gothra'] },
  { field: 'spouse', any: ['spouse', 'wife', 'husband'] },
  { field: 'address', any: ['address'] },
  { field: 'notes', any: ['note', 'remark'] },
];

export const SHEET_HEADERS = ['PatronNumber', 'SevakName', 'DonorName', 'MobileNumber', 'AlternateMobileNumber', 'Preacher', 'Gotram', 'SpecialOcassionDate', 'SpecialOccasion', 'Address'];

interface ParsedRow {
  row: number;
  sheet: string;
  sheetIndex: number;
  patron: string | null;
  donor: string | null;
  sevak: string | null;
  phone: string | null;
  alt: string | null;
  preacher: string | null;
  gotram: string | null;
  spouse: string | null;
  address: string | null;
  notes: string | null;
  date: { day: number; month: number; year: number | null } | null;
  occasion: string | null;
}

export function readSheetRows(sheets: Awaited<ReturnType<typeof parseWorkbook>>) {
  const rows: ParsedRow[] = [];
  const skipped: { row: number; sheet: string; why: string; text: string }[] = [];
  let usedSheets = 0;
  sheets.forEach((sh, sheetIndex) => {
    const map = detectColumns(sh.headers, PATTERNS);
    if (map.date === undefined || (map.donor === undefined && map.patron === undefined)) return;
    usedSheets++;
    sh.rows.forEach((r, i) => {
      const cell = (f: string) => (map[f] === undefined ? null : r[map[f]]);
      const phone = normalizePhone(cell('phone'));
      const alt = normalizePhone(cell('alt'));
      const patron = str(cell('patron'), 40)?.toUpperCase() ?? null;
      const p: ParsedRow = {
        row: sh.rowNumbers[i],
        sheet: sh.name,
        sheetIndex,
        // A patron number has a number in it; a stray "c" typed in the column does not.
        patron: patron && /\d/.test(patron) ? patron : null,
        donor: tidyName(str(cell('donor'), 160)),
        sevak: tidyName(str(cell('sevak'), 160)),
        phone: isDialable(phone) ? phone : null,
        alt: isDialable(alt) ? alt : null,
        preacher: str(cell('preacher'), 40)?.toUpperCase() ?? null,
        gotram: tidyName(str(cell('gotram'), 80)),
        spouse: tidyName(str(cell('spouse'), 160)),
        address: str(cell('address'), 600),
        notes: str(cell('notes'), 500),
        date: parseDayMonth(cell('date')),
        occasion: str(cell('occasion'), 160),
      };
      const who = p.donor ?? p.sevak ?? p.patron ?? '';
      if (!p.donor && !p.sevak && !p.patron) {
        skipped.push({ row: p.row, sheet: sh.name, why: 'no name', text: p.occasion ?? '' });
        return;
      }
      if (!p.date) {
        // The sheet's first row per patron carries their details and no day;
        // that is not a mistake, and the donor is still added (with no days
        // yet). A day written but unreadable is a mistake, and is listed.
        const blank = !str(cell('date')) && !p.occasion;
        if (!blank) skipped.push({ row: p.row, sheet: sh.name, why: 'no date', text: `${who}${p.occasion ? ` · ${p.occasion}` : ''}` });
      }
      rows.push(p);
    });
  });
  return { rows, skipped, usedSheets };
}

/**
 * Rows grouped into donors, and each donor's days.
 *
 * ONE DONOR: by patron number; a row with none joins the donor with the same
 * mobile number, else forms one by mobile + name.
 *
 * ONE DAY, ONCE: the office's workbook holds the same days twice - the Dump
 * tab, and again in the month tabs with the occasion written differently
 * ("BIRTHDAY" there, "I Ram Chandra Rao Birthday" here). Taking both would put
 * two pujas on one day for one donor. So a donor's day is taken from the first
 * tab that has it, and only a day no earlier tab had is taken from a later
 * one. Two occasions on one day in the SAME tab are both kept - that is a
 * birthday and an anniversary falling together.
 */
export function groupDonors(rows: ParsedRow[]) {
  const groups = new Map<string, ParsedRow[]>();
  const byPhone = new Map<string, string>();
  for (const r of rows.filter((x) => x.patron)) {
    const key = `P:${r.patron}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
    if (r.phone && !byPhone.has(r.phone)) byPhone.set(r.phone, key);
  }
  for (const r of rows.filter((x) => !x.patron)) {
    const key = (r.phone && byPhone.get(r.phone)) || `M:${r.phone ?? ''}:${(r.donor ?? r.sevak ?? '').toUpperCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
    if (r.phone && !byPhone.has(r.phone)) byPhone.set(r.phone, key);
  }
  return [...groups.values()].map((g) => {
    const first = <K extends keyof ParsedRow>(k: K) => (g.find((r) => r[k])?.[k] ?? null) as ParsedRow[K] | null;
    const firstSheetFor = new Map<string, number>();
    for (const r of g) {
      if (!r.date) continue;
      const k = `${r.date.month}-${r.date.day}`;
      const was = firstSheetFor.get(k);
      if (was === undefined || r.sheetIndex < was) firstSheetFor.set(k, r.sheetIndex);
    }
    const seen = new Set<string>();
    const days: { month: number; day: number; year: number | null; occasion: string; notes: string | null }[] = [];
    for (const r of g) {
      if (!r.date) continue;
      if (firstSheetFor.get(`${r.date.month}-${r.date.day}`) !== r.sheetIndex) continue;
      const occasion = tidyOccasion(r.occasion ?? 'Special Day');
      const k = `${r.date.month}-${r.date.day}-${occasion.toUpperCase()}`;
      if (seen.has(k)) continue;
      seen.add(k);
      days.push({ month: r.date.month, day: r.date.day, year: r.date.year, occasion, notes: r.notes });
    }
    const spouse = first('spouse');
    return {
      patron: first('patron'),
      donor_name: (first('donor') ?? first('sevak') ?? first('patron') ?? 'Donor') as string,
      sevak_name: first('sevak'),
      phone: first('phone'),
      alt_phone: first('alt'),
      preacher: first('preacher'),
      gotram: first('gotram'),
      address: first('address'),
      notes: spouse ? `Spouse: ${spouse}` : null,
      days,
    };
  });
}

/**
 * POST /sankalpam/import { filename, base64, apply?: boolean }
 *
 * Without apply: what the file would do, so it can be checked first. With
 * apply: does it. Never removes anything and never duplicates. A donor is
 * found by patron number, else by mobile number; a day the donor already has
 * on that date is left as it is, however its occasion was worded. Uploading
 * the same sheet twice adds nothing the second time; a fresher sheet adds only
 * what is new and fills blanks on who is already here.
 */
router.post('/import', async (req, res) => {
  const base64 = String(req.body?.base64 ?? '');
  const filename = String(req.body?.filename ?? 'sheet.xlsx');
  if (!base64) return res.status(400).json({ error: 'No file received.' });
  let sheets;
  try {
    sheets = await parseWorkbook(Buffer.from(base64, 'base64'), filename);
  } catch {
    return res.status(400).json({ error: 'Could not read this file. Upload .xlsx or .csv.' });
  }
  const { rows, skipped, usedSheets } = readSheetRows(sheets);
  if (!usedSheets) {
    return res.status(400).json({ error: 'No date column found. Use the sample sheet headings.' });
  }
  const donors = groupDonors(rows);

  const apply = req.body?.apply === true;
  const client = await pool.connect();
  const out = { donors_new: 0, donors_existing: 0, dates_new: 0, dates_existing: 0, donors_without_dates: 0 };
  try {
    await client.query('BEGIN');
    for (const d of donors) {
      let donorId: string | null = null;
      if (d.patron) {
        donorId = (await client.query(`SELECT id FROM sankalpam_donors WHERE upper(patron_number) = $1`, [d.patron])).rows[0]?.id ?? null;
      }
      if (!donorId && d.phone) {
        // The same mobile: that donor, preferring one with the same name, and
        // never one already holding a different patron number.
        donorId =
          (
            await client.query(
              `SELECT id FROM sankalpam_donors
                WHERE (phone = $1 OR alt_phone = $1)
                  AND ($3::text IS NULL OR patron_number IS NULL OR upper(patron_number) = $3)
                ORDER BY (upper(donor_name) = upper($2)) DESC, created_at LIMIT 1`,
              [d.phone, d.donor_name, d.patron]
            )
          ).rows[0]?.id ?? null;
      }
      if (!donorId && !d.phone && !d.patron) {
        // No number and no patron number: only the name is left to know them by.
        donorId =
          (
            await client.query(
              `SELECT id FROM sankalpam_donors
                WHERE upper(donor_name) = upper($1) AND phone IS NULL AND patron_number IS NULL LIMIT 1`,
              [d.donor_name]
            )
          ).rows[0]?.id ?? null;
      }
      if (donorId) {
        out.donors_existing++;
        if (apply) {
          await client.query(
            `UPDATE sankalpam_donors SET
               patron_number = COALESCE(patron_number, $2), sevak_name = COALESCE(sevak_name, $3),
               phone = COALESCE(phone, $4), alt_phone = COALESCE(alt_phone, $5), preacher = COALESCE(preacher, $6),
               gotram = COALESCE(gotram, $7), address = COALESCE(address, $8), notes = COALESCE(notes, $9),
               person_id = COALESCE(person_id, $10), updated_at = NOW()
             WHERE id = $1`,
            [donorId, d.patron, d.sevak_name, d.phone, d.alt_phone, d.preacher, d.gotram, d.address, d.notes,
             await personFor(client, d.phone)]
          );
        }
      } else {
        out.donors_new++;
        if (apply) {
          donorId = (
            await client.query(
              `INSERT INTO sankalpam_donors (patron_number, donor_name, sevak_name, phone, alt_phone, preacher, gotram, address, notes, person_id, created_by, source)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'sheet') RETURNING id`,
              [d.patron, d.donor_name, d.sevak_name, d.phone, d.alt_phone, d.preacher, d.gotram, d.address, d.notes,
               await personFor(client, d.phone), req.user?.userId ?? null]
            )
          ).rows[0].id;
        }
      }
      if (!d.days.length) out.donors_without_dates++;

      const had = donorId
        ? (await client.query(`SELECT month, day FROM sankalpam_dates WHERE donor_id = $1`, [donorId])).rows.map(
            (x) => `${x.month}-${x.day}`
          )
        : [];
      const already = new Set(had);
      for (const day of d.days) {
        if (already.has(`${day.month}-${day.day}`)) {
          out.dates_existing++;
          continue;
        }
        out.dates_new++;
        if (apply && donorId) {
          await client.query(
            `INSERT INTO sankalpam_dates (donor_id, occasion, month, day, orig_year, notes, origin)
             VALUES ($1,$2,$3,$4,$5,$6,'sheet') ON CONFLICT DO NOTHING`,
            [donorId, day.occasion, day.month, day.day, day.year, day.notes]
          );
        }
      }
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    res.json({
      applied: apply,
      ...out,
      sheets: usedSheets,
      skipped: skipped.length,
      skipped_rows: skipped.slice(0, 50),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('sankalpam.import error:', err);
    res.status(500).json({ error: 'Could not upload. Try again.' });
  } finally {
    client.release();
  }
});

/** GET /sankalpam/sample.xlsx - the headings, with two example rows. */
router.get('/sample.xlsx', async (_req, res) => {
  const buf = await buildWorkbook('Sankalpam', [
    SHEET_HEADERS,
    ['VSI/000001', 'Lakshmi Devi', 'Ramesh Kumar', '9848012345', '', 'SYMD', 'Bharadwaja', '16-01-1985', 'Wife Birthday', 'Door 12-3, MVP Colony, Visakhapatnam 530017'],
    ['VSI/000001', 'Ramesh Kumar', 'Ramesh Kumar', '9848012345', '', 'SYMD', 'Bharadwaja', '29-05-2010', 'Marriage Anniversary', 'Door 12-3, MVP Colony, Visakhapatnam 530017'],
  ]);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="sankalpam-sample.xlsx"');
  res.send(buf);
});

/** GET /sankalpam/export.xlsx (or .csv) - every day, in the same layout the upload reads. */
router.get(['/export.csv', '/export.xlsx'], async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT dn.patron_number, dn.sevak_name, dn.donor_name, dn.phone, dn.alt_phone, dn.preacher, dn.gotram, dn.address,
              d.occasion, d.month, d.day, d.orig_year, d.active AND dn.active AS active
         FROM sankalpam_dates d JOIN sankalpam_donors dn ON dn.id = d.donor_id
        ORDER BY d.month, d.day, dn.donor_name`
    );
    const pad = (n: number) => String(n).padStart(2, '0');
    await sendExport(res, req.path.endsWith('.xlsx') ? 'xlsx' : 'csv', {
      name: 'sankalpam',
      rows,
      columns: [
        { header: 'PatronNumber', value: (r) => r.patron_number },
        { header: 'SevakName', value: (r) => r.sevak_name },
        { header: 'DonorName', value: (r) => r.donor_name },
        { header: 'MobileNumber', value: (r) => r.phone, kind: 'phone' },
        { header: 'AlternateMobileNumber', value: (r) => r.alt_phone, kind: 'phone' },
        { header: 'Preacher', value: (r) => r.preacher },
        { header: 'Gotram', value: (r) => r.gotram },
        { header: 'SpecialOcassionDate', value: (r) => `${pad(r.day)}-${pad(r.month)}${r.orig_year ? `-${r.orig_year}` : ''}` },
        { header: 'SpecialOccasion', value: (r) => r.occasion },
        { header: 'Address', value: (r) => r.address },
        { header: 'Active', value: (r) => (r.active ? 'Yes' : 'No') },
      ],
    });
  } catch (err) {
    console.error('sankalpam.export error:', err);
    res.status(500).json({ error: 'Could not export.' });
  }
});

/* ---------------------------------------------------------------- calls */

// got_details: they gave something new; verified: everything we hold is right.
const OUTCOMES = ['no_answer', 'busy', 'call_back', 'got_details', 'verified', 'not_interested', 'wrong_number'];

/**
 * POST /sankalpam/donors/:id/calls { outcome, note?, next_call_at? }
 *
 * A call to ask a donor for their special days or gotram. Kept per call, so
 * the list can say how many times they were rung and what came of it. An
 * unanswered call books the next try two days on unless a day was chosen.
 */
router.post('/donors/:id/calls', async (req, res) => {
  const outcome = String(req.body?.outcome ?? '');
  if (!OUTCOMES.includes(outcome)) return res.status(400).json({ error: 'Pick what happened.' });
  const asked = req.body?.next_call_at ? new Date(String(req.body.next_call_at)) : null;
  const next =
    asked && !Number.isNaN(asked.getTime())
      ? asked.toISOString()
      : outcome === 'no_answer' || outcome === 'busy'
      ? new Date(Date.now() + 2 * 86400000).toISOString()
      : null;
  try {
    const r = await pool.query(
      `INSERT INTO sankalpam_calls (donor_id, outcome, note, next_call_at, called_by)
       SELECT $1, $2, $3, $4::timestamptz, $5 WHERE EXISTS (SELECT 1 FROM sankalpam_donors WHERE id = $1)
       RETURNING id, called_at, next_call_at`,
      [req.params.id, outcome, str(req.body?.note, 500), next, req.user?.userId ?? null]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found.' });
    // "Wrong number" and "not interested" stop the reminders for them; the
    // donor stays on record and can be switched back on.
    if (outcome === 'wrong_number' || outcome === 'not_interested') {
      await pool.query(`UPDATE sankalpam_donors SET active = FALSE, updated_at = NOW() WHERE id = $1`, [req.params.id]);
    }
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('sankalpam.logCall error:', err);
    res.status(500).json({ error: 'Could not save. Try again.' });
  }
});

/** GET /sankalpam/donors/:id/calls - every call to this donor, newest first. */
router.get('/donors/:id/calls', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.id, c.outcome, c.note, c.next_call_at, c.called_at, u.name AS called_by_name
         FROM sankalpam_calls c LEFT JOIN users u ON u.id = c.called_by
        WHERE c.donor_id = $1 ORDER BY c.called_at DESC LIMIT 50`,
      [req.params.id]
    );
    res.json({ calls: r.rows });
  } catch (err) {
    console.error('sankalpam.calls error:', err);
    res.status(500).json({ error: 'Could not load.' });
  }
});

/* ------------------------------------------------- one person, from People */

/** GET /sankalpam/by-person/:personId - is this person on the Sankalpam list? */
router.get('/by-person/:personId', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT dn.id, dn.active,
              (SELECT COUNT(*)::int FROM sankalpam_dates d WHERE d.donor_id = dn.id AND d.active) AS days
         FROM sankalpam_donors dn
         JOIN people p ON p.id = $1
        WHERE dn.person_id = p.id
           OR dn.phone = right(regexp_replace(p.phone, '\\D', '', 'g'), 10)
           OR dn.alt_phone = right(regexp_replace(p.phone, '\\D', '', 'g'), 10)
        ORDER BY (dn.person_id = p.id) DESC NULLS LAST LIMIT 1`,
      [req.params.personId]
    );
    res.json({ donor: r.rows[0] ?? null });
  } catch (err) {
    console.error('sankalpam.byPerson error:', err);
    res.status(500).json({ error: 'Could not load.' });
  }
});

/**
 * POST /sankalpam/from-person/:personId - put one person on the list, whatever
 * they have given. Comes with every day DRM knows for them; with none, they
 * land on "Need details" to be rung. Already there: nothing is added twice,
 * and the answer points at the existing entry.
 */
router.post('/from-person/:personId', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = (
      await client.query(
        `SELECT p.id, p.name, right(regexp_replace(p.phone, '\\D', '', 'g'), 10) AS phone,
                COALESCE(p.prasadam_address, p.address) AS address,
                EXISTS (SELECT 1 FROM donations d WHERE d.person_id = p.id) AS has_given
           FROM people p WHERE p.id = $1`,
        [req.params.personId]
      )
    ).rows[0];
    if (!p) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Person not found.' });
    }
    const there = (
      await client.query(
        `SELECT id FROM sankalpam_donors WHERE person_id = $1 OR phone = $2 OR alt_phone = $2 LIMIT 1`,
        [p.id, p.phone]
      )
    ).rows[0];
    if (there) {
      await client.query(`UPDATE sankalpam_donors SET person_id = COALESCE(person_id, $2), active = TRUE WHERE id = $1`, [there.id, p.id]);
      const days = await refreshSankalpFromPerson(client, p.id, { quiet: true });
      await client.query('COMMIT');
      return res.json({ id: there.id, existing: true, days });
    }
    const id = (
      await client.query(
        `INSERT INTO sankalpam_donors (donor_name, phone, address, person_id, source, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          tidyName(p.name) ?? 'Donor',
          /^[6-9]\d{9}$/.test(p.phone) ? p.phone : null,
          p.address,
          p.id,
          // A donor DRM knows is "from donations"; somebody who has never
          // given (a volunteer, say) was added by hand.
          p.has_given ? 'donors' : 'manual',
          req.user?.userId ?? null,
        ]
      )
    ).rows[0].id;
    const days = await refreshSankalpFromPerson(client, p.id, { quiet: true });
    await client.query('COMMIT');
    res.status(201).json({ id, existing: false, days });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('sankalpam.fromPerson error:', err);
    res.status(500).json({ error: 'Could not add. Try again.' });
  } finally {
    client.release();
  }
});

/* ------------------------------------------------- from DRM's own donors */

/**
 * Donors who have given at least `min` - in total, or in one donation - and
 * where they stand with Sankalpam.
 */
function candidateQuery(q: Record<string, unknown>) {
  const min = Math.max(1, Math.min(10_000_000, Number(q.min) || 5000));
  const single = q.basis === 'single';
  const site = ['hkmv', 'annadan'].includes(String(q.site)) ? String(q.site) : null;
  const sql = `
    WITH giving AS (
      SELECT d.person_id, SUM(d.amount) AS total, MAX(d.amount) AS biggest, COUNT(*)::int AS donations,
             MAX(d.created_at) AS last_at
        FROM donations d
       WHERE ($2::text IS NULL OR d.source_site = $2)
       GROUP BY d.person_id
    )
    SELECT p.id AS person_id, p.name, right(regexp_replace(p.phone, '\\D', '', 'g'), 10) AS phone,
           g.total, g.biggest, g.donations, g.last_at,
           sd.id AS sankalp_id,
           (p.date_of_birth IS NOT NULL OR p.anniversary_date IS NOT NULL
            OR EXISTS (SELECT 1 FROM donations x WHERE x.person_id = p.id AND x.seva_date IS NOT NULL AND x.occasion IS NOT NULL)) AS has_days
      FROM giving g
      JOIN people p ON p.id = g.person_id
      LEFT JOIN LATERAL (
        SELECT s.id FROM sankalpam_donors s
         WHERE s.person_id = p.id
            OR s.phone = right(regexp_replace(p.phone, '\\D', '', 'g'), 10)
            OR s.alt_phone = right(regexp_replace(p.phone, '\\D', '', 'g'), 10)
         LIMIT 1
      ) sd ON TRUE
     WHERE ${single ? 'g.biggest' : 'g.total'} >= $1
     ORDER BY g.total DESC`;
  return { sql, values: [min, site] };
}

/** GET /sankalpam/candidates?min=5000&basis=total|single&site= - what "Add donors" would add. */
router.get('/candidates', async (req, res) => {
  try {
    const { sql, values } = candidateQuery(req.query as Record<string, unknown>);
    const { rows } = await pool.query(sql, values);
    const toAdd = rows.filter((r) => !r.sankalp_id);
    res.json({
      qualifying: rows.length,
      already: rows.length - toAdd.length,
      to_add: toAdd.length,
      with_days: toAdd.filter((r) => r.has_days).length,
      sample: toAdd.slice(0, 40),
    });
  } catch (err) {
    console.error('sankalpam.candidates error:', err);
    res.status(500).json({ error: 'Could not load.' });
  }
});

/**
 * POST /sankalpam/add-donors { min, basis, site }
 *
 * Adds every qualifying donor not on the list yet, with whatever special days
 * DRM already knows for them (their birthday from the site's form, the day a
 * seva was booked for). The rest arrive with no days, on the "Need details"
 * list, to be rung. A donor already on the list (from the sheet, say) is
 * linked and gets any known day it is missing; nothing of theirs is changed.
 * Safe to run again: it only ever adds who is new.
 */
router.post('/add-donors', async (req, res) => {
  const client = await pool.connect();
  try {
    const { sql, values } = candidateQuery(req.body ?? {});
    await client.query('BEGIN');
    const { rows } = await client.query(sql, values);
    let added = 0;
    let linked = 0;
    let days = 0;
    for (const r of rows) {
      if (r.sankalp_id) {
        const n = await refreshSankalpFromPerson(client, r.person_id, { quiet: true });
        if (n) linked++;
        days += n;
        continue;
      }
      const p = (
        await client.query(`SELECT name, COALESCE(prasadam_address, address) AS address FROM people WHERE id = $1`, [r.person_id])
      ).rows[0];
      await client.query(
        `INSERT INTO sankalpam_donors (donor_name, phone, address, person_id, source, created_by)
         VALUES ($1, $2, $3, $4, 'donors', $5)`,
        [tidyName(p?.name ?? r.name) ?? 'Donor', /^[6-9]\d{9}$/.test(r.phone) ? r.phone : null, p?.address ?? null, r.person_id, req.user?.userId ?? null]
      );
      added++;
      days += await refreshSankalpFromPerson(client, r.person_id, { quiet: true });
    }
    await client.query('COMMIT');
    res.json({ added, linked, days });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('sankalpam.addDonors error:', err);
    res.status(500).json({ error: 'Could not add. Try again.' });
  } finally {
    client.release();
  }
});

/** A YYYY-MM-DD day moved by n days. */
function shift(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export default router;
