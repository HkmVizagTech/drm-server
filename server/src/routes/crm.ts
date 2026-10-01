// Calling - the temple's phone outreach to donors.
//
// WHAT THIS IS FOR
// Someone sits down with a list and rings people: last year's Janmashtami
// donors, a monthly giver whose card stopped, the forty names from the Gita
// distribution stall, the person who filled in the donation form and closed the
// tab at the payment step. This module is the list, the record of what was
// said, and the answer to "who am I supposed to call today".
//
// THE ONE THING THAT SHAPES EVERYTHING HERE
// Calls are placed from the callers' own phones. DRM is told what happened
// afterwards; it does not observe the call. So:
//
//   - duration and connected/unanswered are REPORTED, not measured
//   - there are no recordings, because nothing is recording
//   - a call that is never logged never happened as far as DRM knows
//
// Every call row therefore carries `source = 'manual'`, and the reports say so
// rather than presenting a self-reported average as though a switch had timed
// it. If a cloud provider (Exotel, MyOperator, Knowlarity, Twilio) is added
// later, it writes the same columns with measured values and its own source
// name - no migration, no report rewritten, and the distinction stays visible.
//
// WHY THE CALLING SCREEN IS BUILT THE WAY IT IS
// A caller makes sixty of these an hour. Every field they must fill is sixty
// fields an hour, so the design rule throughout is: one tap logs a call. The
// disposition carries the status change and the callback date with it (see
// crm_dispositions.suggests_status / wants_follow_up), and everything else is
// optional. A CRM that demands more than that gets filled in as "no answer"
// for everybody, and then the reports are worse than having none.

import { Router } from 'express';
import pool from '../db/pool';
import { authenticate, authorize } from '../middleware/auth';
import { fetchAbandonedPage, isSiteConfigured, type SiteKey } from '../services/hkmvClient';
import { buildWorkbook } from '../utils/spreadsheet';
// The queue's filter lives with the lists it belongs to, so a change to what
// counts as callable changes the queue and every list's count together.
import { CALLABLE, DUE_NOW, listPredicate, loadList, maxAttempts } from './crmLists';

const router = Router();
router.use(authenticate);

/* ------------------------------------------------------------------ shared */

// Identity across DRM is the last 10 digits - the same rule the donor sync and
// the prasadam import use, so a lead, a donor and an uploaded row for one
// person always meet instead of becoming three records.
function normalizePhone(raw: unknown): string {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits.length > 10 ? digits.slice(-10) : digits;
}

// A number worth dialling. Indian mobiles are ten digits starting 6-9; anything
// else is a landline, a typo or a truncated cell in a spreadsheet, and marking
// it invalid on import is kinder than handing it to a caller.
const isDialable = (p: string) => /^[6-9]\d{9}$/.test(p);

const str = (v: unknown, max = 255): string | null => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const asDate = (v: unknown): string | null => {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * Links leads to the donations that answered them.
 *
 * A caller rings someone, they say yes, and two days later they give on the
 * website. Nobody goes back into DRM to tick a box, so without this the
 * conversion report reads zero and the calling looks worthless.
 *
 * The match is deliberately conservative: the lead must already be linked to a
 * person (so we are not guessing at identity), and the donation must have
 * arrived AFTER the lead was created. A donor's history from before the call
 * is not something the call achieved, and counting it would flatter every
 * report in the system.
 *
 * No "completed" filter, because DRM's donations table has no status column and
 * needs none: both sites only ever hand over donations that were actually paid, so
 * a row existing here IS a completed donation. Worth knowing if a failed or
 * pending state is ever imported - this query would start counting it.
 *
 * Cheap enough to run on a dashboard load at this temple's scale, and rate
 * limited below so a page with several panels doesn't run it several times.
 */
let lastReconcileAt = 0;
async function reconcileConversions(force = false): Promise<number> {
  if (!force && Date.now() - lastReconcileAt < 60_000) return 0;
  lastReconcileAt = Date.now();

  // STEP ONE, AND THE REASON THIS USED TO DO NOTHING FOR NEW DONORS
  //
  // The match below needs the lead to be linked to a person. That link is made
  // when the lead is created - but only if the person already existed then. A
  // lead typed in from a slip of paper, or imported from a sheet, is usually
  // somebody DRM has never seen, so person_id is NULL.
  //
  // Then they give. The site receipts it, the sync brings the donation across
  // and creates the person - and the lead is still sitting there with a NULL,
  // matching nothing, for ever. The caller rang them, they gave, and every
  // report said the call achieved nothing.
  //
  // So the link is repaired first, on the one identity DRM trusts everywhere
  // else: the last ten digits of the phone number.
  await pool.query(
    `UPDATE leads l SET person_id = p.id, updated_at = NOW()
       FROM people p
      WHERE l.person_id IS NULL
        AND right(regexp_replace(p.phone, '\\D', '', 'g'), 10) = l.phone`
  );

  const result = await pool.query(
    `WITH first_gift AS (
       SELECT DISTINCT ON (l.id)
              l.id AS lead_id, d.id AS donation_id, d.amount, d.created_at
         FROM leads l
         JOIN donations d ON d.person_id = l.person_id
        WHERE l.person_id IS NOT NULL
          AND l.converted_donation_id IS NULL
          -- AND not already converted by a human or by a QR payment.
          --
          -- Both of those deliberately leave converted_donation_id NULL, so
          -- without this line they stayed eligible for ever: a caller who
          -- recorded 50,000 in cash would find it silently rewritten to a 101
          -- donation the same donor made on annadan a week later, redated,
          -- and relabelled 'auto' as though DRM had observed it.
          AND l.converted_at IS NULL
          AND d.created_at >= l.created_at
        ORDER BY l.id, d.created_at ASC
     )
     UPDATE leads l SET
       converted_donation_id = f.donation_id,
       converted_amount      = f.amount,
       converted_at          = f.created_at,
       status                = 'converted',
       -- 'auto': DRM saw the donation arrive and matched it. Distinct from a
       -- caller asserting it, because the two are not equally good evidence
       -- and the reports say which.
       converted_via         = 'auto',
       -- The chase stops the moment the money lands. Leaving the callback set
       -- put a donor who had already given back on the follow-ups board the
       -- next morning as somebody the temple still owed a call.
       next_follow_up_at     = NULL,
       follow_up_note        = NULL,
       awaiting_qr_at        = NULL,
       updated_at            = NOW()
     FROM first_gift f
     WHERE l.id = f.lead_id
     RETURNING l.id`
  );

  // And the promises they had made are kept. Closed rather than deleted, so
  // what was promised and what came of it both stay on the record - and so
  // nobody is alerted at nine tomorrow morning to chase a donation that
  // arrived yesterday.
  if (result.rowCount) {
    await pool.query(
      `UPDATE lead_reminders
          SET status = 'done', completed_at = NOW(), updated_at = NOW()
        WHERE status = 'open' AND lead_id = ANY($1::uuid[])`,
      [result.rows.map((r) => r.id)]
    );
  }

  return result.rowCount ?? 0;
}

/* ---------------------------------------------------------------- settings */

// Everything the client needs to render a dropdown, fetched once and cached
// there. Statuses, dispositions, settings and the people leads can be assigned
// to - four round trips collapsed into one, because the calling screen needs
// all four before it can show anything.
router.get('/config', async (_req, res) => {
  try {
    const [statuses, dispositions, settings, users, batches, preachers] = await Promise.all([
      pool.query(`SELECT * FROM crm_statuses WHERE active ORDER BY sort_order, label`),
      pool.query(`SELECT * FROM crm_dispositions WHERE active ORDER BY sort_order, label`),
      pool.query(`SELECT key, value FROM crm_settings`),
      pool.query(`SELECT id, name, email, role FROM users ORDER BY name`),
      // The sheets, for anywhere a screen wants to narrow to one of them.
      // Only those that actually produced leads: a draft nobody committed is
      // an entry in the upload history, not something to filter a board by.
      pool.query(
        `SELECT id, filename, sheet_name, label, leads_added, created_at
           FROM lead_import_batches
          WHERE leads_added > 0
          ORDER BY created_at DESC LIMIT 60`
      ),
      pool.query(`SELECT id, code, name FROM preachers WHERE active ORDER BY code`),
    ]);

    res.json({
      statuses: statuses.rows,
      dispositions: dispositions.rows,
      settings: Object.fromEntries(settings.rows.map((r) => [r.key, r.value])),
      users: users.rows,
      batches: batches.rows,
      preachers: preachers.rows,
    });
  } catch (err) {
    console.error('crm.config error:', err);
    res.status(500).json({ error: 'Could not load calling settings' });
  }
});

// Configuration is an admin's to change. These three were reachable by any
// caller, protected only by the setup screen's nav link being hidden - so one
// fetch() from a browser console could retire every stage, change how many
// times a lead is dialled, or switch on "callers see all leads".
router.put('/settings/:key', authorize('admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `INSERT INTO crm_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING key, value`,
      [req.params.key, JSON.stringify(req.body?.value ?? null), req.user?.userId ?? null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('crm.setSetting error:', err);
    res.status(500).json({ error: 'Could not save that setting' });
  }
});

// Add or edit a stage. Deleting is not offered on purpose: leads already sitting
// in a stage would be orphaned by it, so a stage is retired with active=false
// and stops appearing in the dropdowns while old leads keep their history.
router.put('/statuses/:slug', authorize('admin'), async (req, res) => {
  const { label, tone, sort_order, is_won, is_lost, is_open, active } = req.body ?? {};
  try {
    const result = await pool.query(
      `INSERT INTO crm_statuses (slug, label, tone, sort_order, is_won, is_lost, is_open, active)
       VALUES ($1, $2, COALESCE($3,'slate'), COALESCE($4,0), COALESCE($5,FALSE), COALESCE($6,FALSE), COALESCE($7,TRUE), COALESCE($8,TRUE))
       ON CONFLICT (slug) DO UPDATE SET
         label      = COALESCE(EXCLUDED.label, crm_statuses.label),
         tone       = COALESCE($3, crm_statuses.tone),
         sort_order = COALESCE($4, crm_statuses.sort_order),
         is_won     = COALESCE($5, crm_statuses.is_won),
         is_lost    = COALESCE($6, crm_statuses.is_lost),
         is_open    = COALESCE($7, crm_statuses.is_open),
         active     = COALESCE($8, crm_statuses.active)
       RETURNING *`,
      [
        String(req.params.slug).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 30),
        str(label, 60),
        str(tone, 20),
        num(sort_order),
        is_won ?? null,
        is_lost ?? null,
        is_open ?? null,
        active ?? null,
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('crm.putStatus error:', err);
    res.status(500).json({ error: 'Could not save that stage' });
  }
});

router.put('/dispositions/:slug', authorize('admin'), async (req, res) => {
  const { label, counts_connected, suggests_status, wants_follow_up, sort_order, active } = req.body ?? {};
  try {
    const result = await pool.query(
      `INSERT INTO crm_dispositions (slug, label, counts_connected, suggests_status, wants_follow_up, sort_order, active)
       VALUES ($1, $2, COALESCE($3,FALSE), $4, COALESCE($5,FALSE), COALESCE($6,0), COALESCE($7,TRUE))
       ON CONFLICT (slug) DO UPDATE SET
         label            = COALESCE(EXCLUDED.label, crm_dispositions.label),
         counts_connected = COALESCE($3, crm_dispositions.counts_connected),
         suggests_status  = COALESCE($4, crm_dispositions.suggests_status),
         wants_follow_up  = COALESCE($5, crm_dispositions.wants_follow_up),
         sort_order       = COALESCE($6, crm_dispositions.sort_order),
         active           = COALESCE($7, crm_dispositions.active)
       RETURNING *`,
      [
        String(req.params.slug).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 30),
        str(label, 60),
        counts_connected ?? null,
        str(suggests_status, 30),
        wants_follow_up ?? null,
        num(sort_order),
        active ?? null,
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('crm.putDisposition error:', err);
    res.status(500).json({ error: 'Could not save that call outcome' });
  }
});

/* ------------------------------------------------------------ lead filters */

const LEAD_COLUMNS = `
  l.id, l.phone, l.name, l.alt_phone, l.email, l.city, l.person_id,
  l.source, l.source_detail, l.source_site, l.status, l.assigned_to,
  l.tags, l.remarks, l.next_follow_up_at, l.follow_up_note,
  l.last_contacted_at, l.last_outcome, l.call_attempts, l.expected_amount,
  l.converted_donation_id, l.converted_amount, l.converted_at,
  l.do_not_call, l.invalid_reason, l.created_at, l.updated_at,
  l.preacher_id, l.donor_code, l.converted_via, l.converted_note,
  -- Giving from the office's own sheets. Shown to the caller, never added to
  -- anything DRM raised - see the schema note on external_total_donated.
  l.external_total_donated, l.external_recent_donated, l.external_last_donation_at,
  l.external_account_count, l.external_account_type,
  pr.code AS preacher_code, pr.name AS preacher_name,
  u.name AS assigned_to_name,
  s.label AS status_label, s.tone AS status_tone, s.is_open AS status_is_open,
  -- Shown on the lead row so a caller knows whether they are ringing a stranger
  -- or someone who has given eleven times before picking up the phone.
  p.total_donated, p.donation_count, p.last_donation_at`;

const LEAD_JOINS = `
  FROM leads l
  LEFT JOIN users u ON l.assigned_to = u.id
  LEFT JOIN preachers pr ON l.preacher_id = pr.id
  LEFT JOIN crm_statuses s ON l.status = s.slug
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(d.amount),0)::numeric AS total_donated,
           COUNT(*)::int                      AS donation_count,
           MAX(d.created_at)                  AS last_donation_at
      FROM donations d
     WHERE d.person_id = l.person_id
  ) p ON l.person_id IS NOT NULL`;

interface Filters {
  where: string;
  values: unknown[];
  next: number;
}

/**
 * Whether this person may see every lead, or only their own.
 *
 * WHY THIS IS READ ON EVERY REQUEST
 * `callers_see_all_leads` has existed in settings since the beginning, with a
 * toggle on the setup screen and a default of off - and no code anywhere read
 * it. So it was off, looked off, and did nothing: a caller could open the
 * leads screen, or the CSV export, and take the temple's entire donor base
 * with lifetime giving figures, twenty thousand rows at a time.
 *
 * Only callers are narrowed. An admin, accountant or coordinator sees the lot
 * by the nature of their job; the setting exists to decide one question, which
 * is whether a caller's world is their own assignment or the whole temple.
 *
 * Unassigned leads stay visible to everybody even when narrowing, because a
 * lead nobody owns that nobody can see is a lead nobody rings.
 */
async function leadScopeFor(user?: { role?: string; userId?: string }): Promise<string | null> {
  if (user?.role !== 'caller') return null;
  const r = await pool.query(`SELECT value FROM crm_settings WHERE key = 'callers_see_all_leads'`);
  if (r.rows[0]?.value === true) return null;
  return user?.userId ?? null;
}

/** The SQL that narrows to one caller, appended to a built filter. */
function withScope(f: Filters, scope: string | null): Filters {
  if (!scope) return f;
  const clause = `(l.assigned_to = $${f.next}::uuid OR l.assigned_to IS NULL)`;
  return {
    where: f.where ? `${f.where} AND ${clause}` : `WHERE ${clause}`,
    values: [...f.values, scope],
    next: f.next + 1,
  };
}

// One filter builder for the list, the export and the bulk actions. If the
// export could reach rows the list cannot show, staff would be acting on leads
// they never saw - the same rule the prasadam module follows.
function buildLeadFilters(q: Record<string, unknown>, startIdx = 1): Filters {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let i = startIdx;

  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String) : String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  // A calling list, by id. Expanded into the list's own conditions rather than
  // joined, so the leads screen and the queue select exactly the same people -
  // "See them" on a list card has to show what the caller is about to be given.
  if (q.list) {
    conditions.push(`l.id IN (
      SELECT l2.id FROM leads l2, calling_lists cl
       WHERE cl.id = $${i}::uuid
         AND (cl.import_batch_id IS NULL OR l2.import_batch_id = cl.import_batch_id)
         AND (cl.tag         IS NULL OR cl.tag = ANY(l2.tags))
         AND (cl.preacher_id IS NULL OR l2.preacher_id = cl.preacher_id)
         AND (cl.status_slug IS NULL OR l2.status = cl.status_slug)
         AND (cl.source      IS NULL OR l2.source = cl.source)
         AND (cl.city        IS NULL OR l2.city ILIKE '%' || cl.city || '%')
         AND (cl.min_external_total IS NULL OR l2.external_total_donated >= cl.min_external_total)
    )`);
    values.push(String(q.list));
    i++;
  }
  if (q.status) {
    conditions.push(`l.status = ANY($${i++})`);
    values.push(arr(q.status));
  }
  if (q.source) {
    conditions.push(`l.source = ANY($${i++})`);
    values.push(arr(q.source));
  }
  if (q.site) {
    conditions.push(`l.source_site = ANY($${i++})`);
    values.push(arr(q.site));
  }
  if (q.assigned_to) {
    // The literal string "unassigned" rather than a separate flag, so one
    // dropdown can offer "Unassigned" alongside the caller names.
    if (String(q.assigned_to) === 'unassigned') conditions.push(`l.assigned_to IS NULL`);
    else {
      conditions.push(`l.assigned_to = $${i++}`);
      values.push(q.assigned_to);
    }
  }
  if (q.tag) {
    conditions.push(`l.tags && $${i++}`);
    values.push(arr(q.tag));
  }
  // The sheet a lead came in on. The office thinks in workbooks - "the
  // Janmashtami file", "last year's general donations" - and until now the only
  // way to see one sheet's leads was to build a calling list for it, which is a
  // heavier thing than someone asking which of the March people owe a callback.
  if (q.batch) {
    if (String(q.batch) === 'none') conditions.push(`l.import_batch_id IS NULL`);
    else {
      conditions.push(`l.import_batch_id = ANY($${i++}::uuid[])`);
      values.push(arr(q.batch));
    }
  }
  // "Ring everyone Jagat Tarini Mataji brought in" is one of the commonest
  // ways the office builds a list, so the preacher is a first-class filter.
  // Accepts the code (JTMD) or the id, because the office speaks in codes.
  if (q.preacher) {
    if (String(q.preacher) === 'none') conditions.push(`l.preacher_id IS NULL`);
    else {
      conditions.push(`(l.preacher_id::text = $${i} OR pr.code = upper($${i}))`);
      values.push(String(q.preacher));
      i++;
    }
  }
  // Lifetime giving from the sheets - the other way lists get built: "everyone
  // who has given over a lakh and nothing lately".
  if (q.min_external) {
    conditions.push(`l.external_total_donated >= $${i++}`);
    values.push(num(q.min_external));
  }
  if (q.search) {
    conditions.push(`(l.name ILIKE $${i} OR l.phone ILIKE $${i} OR l.email ILIKE $${i} OR l.city ILIKE $${i})`);
    values.push(`%${String(q.search).trim()}%`);
    i++;
  }

  // What is due. "today" includes anything overdue as well, because a caller
  // asking what they have to do today means everything outstanding, not a
  // window that quietly hides last Tuesday's promise.
  if (q.due) {
    const due = String(q.due);
    if (due === 'overdue') conditions.push(`l.next_follow_up_at < date_trunc('day', NOW())`);
    else if (due === 'today') conditions.push(`l.next_follow_up_at < date_trunc('day', NOW()) + INTERVAL '1 day'`);
    else if (due === 'today_only')
      conditions.push(`l.next_follow_up_at >= date_trunc('day', NOW()) AND l.next_follow_up_at < date_trunc('day', NOW()) + INTERVAL '1 day'`);
    else if (due === 'upcoming') conditions.push(`l.next_follow_up_at >= date_trunc('day', NOW()) + INTERVAL '1 day'`);
    else if (due === 'none') conditions.push(`l.next_follow_up_at IS NULL`);
    if (due !== 'none') conditions.push(`l.next_follow_up_at IS NOT NULL`);
  }

  if (q.open === 'true') conditions.push(`COALESCE(s.is_open, TRUE) = TRUE`);
  // Converted means converted. Keying on the donation link hid every lead
  // that gave by QR or by cash from the leads screen's own Converted filter.
  if (q.converted === 'true') conditions.push(`l.converted_at IS NOT NULL`);
  if (q.do_not_call === 'true') conditions.push(`l.do_not_call = TRUE`);
  else if (q.do_not_call !== 'include') conditions.push(`l.do_not_call = FALSE`);

  if (q.start_date) {
    conditions.push(`l.created_at >= $${i++}`);
    values.push(q.start_date);
  }
  if (q.end_date) {
    conditions.push(`l.created_at < ($${i++}::date + INTERVAL '1 day')`);
    values.push(q.end_date);
  }

  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', values, next: i };
}

const SORTS: Record<string, string> = {
  due: 'l.next_follow_up_at ASC NULLS LAST, l.created_at ASC',
  newest: 'l.created_at DESC',
  oldest: 'l.created_at ASC',
  name: 'lower(l.name) ASC NULLS LAST',
  value: 'COALESCE(l.expected_amount, 0) DESC, l.created_at ASC',
  attempts: 'l.call_attempts ASC, l.created_at ASC',
  untouched: 'l.last_contacted_at ASC NULLS FIRST, l.created_at ASC',
};

/* ------------------------------------------------------------------- leads */

// ORDER MATTERS. These two literal paths must be registered before
// "/leads/:id", or Express matches "sample.csv" as an id and the download
// 404s with "Lead not found" - which reads as a broken button, not a
// routing mistake, so it is the kind of bug that survives a long time.
// Real-looking rows rather than "string, string, string", and offered next to
// every upload button: the commonest reason an import fails is a column name.
const LEAD_SAMPLE_ROWS = [
  ['Name', 'Mobile Number', 'Email', 'City', 'Remarks', 'Expected Amount', 'Tags'],
  ['Radha Krishna Das', '9876543210', 'radha@example.com', 'Visakhapatnam', 'Gave at Janmashtami last year', '5000', 'janmashtami;lapsed'],
  ['Sita Devi', '9812345678', '', 'Hyderabad', 'Met at the Gita stall', '1100', 'gita-stall'],
  ['Gopal Rao', '9700011122', 'gopal@example.com', 'Vizag', 'Asked to be called after Diwali', '', 'diwali'],
];

router.get('/leads/sample.csv', (_req, res) => {
  const csv = LEAD_SAMPLE_ROWS.map((r) =>
    r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')
  ).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="lead-upload-sample.csv"');
  // BOM so Excel opens it as UTF-8 rather than mangling any Indian names in it.
  res.send('﻿' + csv + '\n');
});

// The same sample as a workbook, for an office that works in Excel and would
// otherwise have to go through the "text import" dialog to see it.
router.get('/leads/sample.xlsx', async (_req, res) => {
  try {
    const buffer = await buildWorkbook('Leads', LEAD_SAMPLE_ROWS);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="lead-upload-sample.xlsx"');
    res.send(buffer);
  } catch (err) {
    console.error('crm.leadSampleXlsx error:', err);
    res.status(500).json({ error: 'Could not build the sample file' });
  }
});

// The list on screen, as a file. Honours every filter, for the same reason the
// import does: staff must never be able to export rows the screen cannot show.
router.get('/leads/export.csv', (req, res) => exportLeadsCsv(req, res));

/* ------------------------------------------------- unfinished donations
 *
 * REGISTERED BEFORE /leads/:id, AND THAT IS THE WHOLE POINT
 *
 * Express matches in registration order. With these below the `/leads/:id`
 * handler, a request for /leads/abandoned was read as a lead whose id is the
 * word "abandoned", which Postgres then refused to cast to a uuid - so the
 * page answered 500 with "Could not load that lead" and the screen showed
 * zeroes with no explanation of what had gone wrong.
 */

/**
 * Bring DRM's copy of the sites' unfinished donations up to date.
 *
 * WHY THERE IS A COPY AT ALL
 * The first version asked both sites on every page load - up to twenty HTTP
 * round trips to two Mongo databases before a caller saw a single row. The
 * data changes slowly (a donation is only "abandoned" after an hour) and is
 * read constantly, which is exactly the shape that belongs in a table.
 *
 * Upserts on (site, external id), so a sync that returns the same attempt for
 * the fiftieth day running updates one row rather than making a fifty-first.
 * Nothing is ever deleted here: an attempt that drops out of the site's window
 * still happened, and a row somebody dismissed must not come back next week
 * because the site mentioned it again.
 *
 * Only one sync per site runs at a time. Two page loads a second apart would
 * otherwise each start a full crawl of both sites.
 */
async function syncAbandoned(
  sites: SiteKey[],
  opts: { days?: number; minMinutes?: number } = {}
): Promise<{ site: string; seen: number; error: string | null }[]> {
  const days = Math.min(365, Math.max(1, opts.days ?? 90));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const minMinutes = Math.max(15, opts.minMinutes ?? 60);
  const results: { site: string; seen: number; error: string | null }[] = [];

  for (const site of sites) {
    if (!isSiteConfigured(site)) {
      const error = 'Not connected — its URL and internal secret are not set on DRM, so it was not asked.';
      await pool.query(
        `INSERT INTO abandoned_sync_state (source_site, last_error, last_synced_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (source_site) DO UPDATE SET last_error = $2, last_synced_at = NOW(), running_since = NULL`,
        [site, error]
      );
      results.push({ site, seen: 0, error });
      continue;
    }

    // Claim the sync. If another request claimed it less than five minutes
    // ago, leave it alone - a crawl that has genuinely hung for longer than
    // that is better retried than waited on for ever.
    const claim = await pool.query(
      `INSERT INTO abandoned_sync_state (source_site, running_since)
       VALUES ($1, NOW())
       ON CONFLICT (source_site) DO UPDATE SET running_since = NOW()
         WHERE abandoned_sync_state.running_since IS NULL
            OR abandoned_sync_state.running_since < NOW() - INTERVAL '5 minutes'
       RETURNING source_site`,
      [site]
    );
    if (!claim.rows.length) {
      results.push({ site, seen: 0, error: null });
      continue;
    }

    let seen = 0;
    let error: string | null = null;
    try {
      for (let page = 1; page <= 10; page++) {
        const result = await fetchAbandonedPage(site, { page, limit: 200, since, minMinutes });
        for (const d of result.donations) {
          const phone = normalizePhone(d.mobile);
          if (!isDialable(phone)) continue;
          seen++;
          await pool.query(
            `INSERT INTO abandoned_attempts
               (source_site, external_id, phone, name, email, amount, purpose,
                source_page, status, attempted_at, last_seen_at)
             VALUES ($1,$2,$3,$4,$5,$6::numeric,$7,$8,$9,$10::timestamptz, NOW())
             ON CONFLICT (source_site, external_id) DO UPDATE SET
               -- The site is authoritative on everything except what DRM has
               -- decided about the row, so the dismissal is simply not touched.
               phone        = EXCLUDED.phone,
               name         = COALESCE(EXCLUDED.name, abandoned_attempts.name),
               email        = COALESCE(EXCLUDED.email, abandoned_attempts.email),
               amount       = COALESCE(EXCLUDED.amount, abandoned_attempts.amount),
               purpose      = COALESCE(EXCLUDED.purpose, abandoned_attempts.purpose),
               source_page  = COALESCE(EXCLUDED.source_page, abandoned_attempts.source_page),
               status       = EXCLUDED.status,
               attempted_at = EXCLUDED.attempted_at,
               last_seen_at = NOW()`,
            [
              site,
              String(d.externalId ?? ''),
              phone,
              d.name ?? null,
              d.email ?? null,
              d.amount ?? null,
              d.purpose ?? null,
              d.sourcePage ?? null,
              d.status ?? null,
              d.attemptedAt ?? new Date().toISOString(),
            ]
          );
        }
        if (!result.hasMore) break;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Unknown error';
    }

    // How many times each person tried, counted once per sync rather than on
    // every read.
    await pool.query(
      `UPDATE abandoned_attempts a SET attempts = c.n
         FROM (SELECT phone, COUNT(*)::int AS n FROM abandoned_attempts GROUP BY phone) c
        WHERE a.phone = c.phone AND a.attempts <> c.n`
    );

    await pool.query(
      `UPDATE abandoned_sync_state
          SET last_synced_at = NOW(), last_error = $2, rows_seen = $3, running_since = NULL
        WHERE source_site = $1`,
      [site, error, seen]
    );
    results.push({ site, seen, error });
  }

  return results;
}

/** How stale the copy may get before a read quietly refreshes it. */
const ABANDONED_STALE_MINUTES = 30;

/**
 * GET /leads/abandoned - the list a caller works through.
 *
 * Reads the stored copy, so it answers immediately. If that copy is older than
 * half an hour, a refresh is started in the background and the page still gets
 * the rows it has now - a caller opening the screen should never wait on two
 * Mongo sites to finish talking.
 *
 * Open to callers, unlike the bulk import below. The whole point is that a
 * caller can see who nearly gave and ring them; making them ask an admin to
 * run a sync first is how a list like this goes stale and stops being used.
 *
 * WHO IS HIDDEN, AND WHY IT IS COMPUTED HERE
 * Anybody who has since given, on either site, by any means. Neither site can
 * work that out - a donor who failed on annadan and retried on the main site
 * looks abandoned to annadan for ever - and a stored flag would be wrong until
 * the next refresh, so it is a join against DRM's own donations on every read.
 * Ringing somebody to chase money they have already given is the one thing
 * this feature must never do.
 */
router.get('/leads/abandoned', async (req, res) => {
  const sites = (String(req.query.sites ?? '').split(',').filter(Boolean) as SiteKey[]);
  const wanted = sites.length ? sites : (['hkmv', 'annadan'] as SiteKey[]);

  try {
    const state = await pool.query(
      `SELECT source_site, last_synced_at, last_error, running_since FROM abandoned_sync_state`
    );
    const byState = new Map(state.rows.map((r) => [r.source_site, r]));

    const stale = wanted.filter((site) => {
      const r = byState.get(site);
      if (!r || !r.last_synced_at) return true;
      return Date.now() - new Date(r.last_synced_at).getTime() > ABANDONED_STALE_MINUTES * 60_000;
    });

    // Never awaited unless the caller asked for fresh data. The page is for
    // reading, and reading must not block on somebody else's Mongo.
    if (req.query.fresh === 'true') {
      await syncAbandoned(wanted);
      // Re-read, because the state above was captured before that ran. Without
      // this the one request that definitely has fresh information reports the
      // state from before it - including saying a site is fine when the sync
      // just discovered it is not connected.
      const after = await pool.query(
        `SELECT source_site, last_synced_at, last_error, running_since FROM abandoned_sync_state`
      );
      byState.clear();
      for (const row of after.rows) byState.set(row.source_site, row);
    } else if (stale.length) {
      void syncAbandoned(stale).catch((e) =>
        console.error('crm.syncAbandoned background error:', (e as Error).message)
      );
    }

    /* ------------------------------------------------------------ filters */
    const conditions: string[] = ['a.dismissed_at IS NULL'];
    const values: unknown[] = [];
    let i = 1;

    conditions.push(`a.source_site = ANY($${i++}::text[])`);
    values.push(wanted);

    // How long ago they tried. Days rather than a date range, because the
    // question a caller asks is "who nearly gave this week".
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    conditions.push(`a.attempted_at >= NOW() - ($${i++} || ' days')::interval`);
    values.push(String(days));

    // Leave them alone until the attempt has had time to complete.
    conditions.push(`a.attempted_at <= NOW() - INTERVAL '15 minutes'`);

    if (req.query.min_amount) {
      conditions.push(`a.amount >= $${i++}::numeric`);
      values.push(Number(req.query.min_amount));
    }
    if (req.query.max_amount) {
      conditions.push(`a.amount <= $${i++}::numeric`);
      values.push(Number(req.query.max_amount));
    }
    if (req.query.status) {
      conditions.push(`a.status = ANY($${i++}::text[])`);
      values.push(String(req.query.status).split(',').filter(Boolean));
    }
    if (req.query.search) {
      conditions.push(`(a.name ILIKE $${i} OR a.phone ILIKE $${i} OR a.email ILIKE $${i})`);
      values.push(`%${String(req.query.search).trim()}%`);
      i++;
    }

    // Aliased to the OUTER query, which selects from the CTE as `l`. Using
    // `a.` here referenced the inner alias and failed with "missing FROM-clause
    // entry" - a whitelisted ORDER BY is still SQL that has to parse.
    const SORTS: Record<string, string> = {
      recent: 'l.attempted_at DESC',
      oldest: 'l.attempted_at ASC',
      amount: 'l.amount DESC NULLS LAST',
      attempts: 'l.attempts DESC, l.attempted_at DESC',
    };
    const order = SORTS[String(req.query.sort ?? '')] ?? SORTS.recent;

    // One row per person: somebody who tried four times is one phone call.
    // The row kept is their most recent attempt, which is the one worth
    // mentioning when the phone is answered.
    const rows = await pool.query(
      `WITH latest AS (
         SELECT DISTINCT ON (a.phone) a.*
           FROM abandoned_attempts a
          WHERE ${conditions.join(' AND ')}
          ORDER BY a.phone, a.attempted_at DESC
       )
       SELECT l.*,
              -- Did they give anyway? Any donation at or after the attempt,
              -- from either site, by any means.
              EXISTS (
                SELECT 1 FROM people p JOIN donations d ON d.person_id = p.id
                 WHERE right(regexp_replace(p.phone,'\\D','','g'), 10) = l.phone
                   AND d.created_at >= l.attempted_at
              ) AS gave_anyway,
              ld.id AS lead_id,
              ld.status AS lead_status,
              u.name AS assigned_to_name
         FROM latest l
         LEFT JOIN leads ld ON ld.phone = l.phone
         LEFT JOIN users u ON ld.assigned_to = u.id
        ORDER BY ${order}
        LIMIT 500`,
      values
    );

    const all = rows.rows;
    const open = all.filter((r) => !r.gave_anyway);
    const shown = req.query.include_settled === 'true' ? all : open;

    res.json({
      rows: shown,
      total: all.length,
      open: open.length,
      gave_anyway: all.length - open.length,
      already_leads: open.filter((r) => r.lead_id).length,
      // What walked away, over the people still worth ringing. This is the
      // number that decides whether the list is worth a shift.
      value_at_stake: open.reduce((sum, r) => sum + Number(r.amount ?? 0), 0),
      sites: wanted.map((site) => {
        const r = byState.get(site);
        return {
          site,
          last_synced_at: r?.last_synced_at ?? null,
          error: r?.last_error ?? null,
          refreshing: !!r?.running_since || stale.includes(site),
        };
      }),
    });
  } catch (err) {
    console.error('crm.abandoned error:', err);
    res.status(500).json({ error: 'Could not load the unfinished donations' });
  }
});

/** POST /leads/abandoned/refresh - ask both sites now, and wait for them. */
router.post('/leads/abandoned/refresh', async (req, res) => {
  const sites = (String(req.body?.sites ?? '').split(',').filter(Boolean) as SiteKey[]);
  try {
    const results = await syncAbandoned(sites.length ? sites : (['hkmv', 'annadan'] as SiteKey[]), {
      days: Number(req.body?.days) || 90,
    });
    res.json({ results });
  } catch (err) {
    console.error('crm.refreshAbandoned error:', err);
    res.status(500).json({ error: 'Could not reach the sites' });
  }
});

/** POST /leads/abandoned/:id/dismiss - not worth a call. Survives refreshes. */
router.post('/leads/abandoned/:id/dismiss', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE abandoned_attempts
          SET dismissed_at = NOW(), dismissed_by = $2::uuid
        WHERE id = $1 AND dismissed_at IS NULL RETURNING id`,
      [req.params.id, req.user?.userId ?? null]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'No such attempt' });
    res.json({ dismissed: true });
  } catch (err) {
    console.error('crm.dismissAbandoned error:', err);
    res.status(500).json({ error: 'Could not set that aside' });
  }
});

/**
 * POST /leads/abandoned/adopt - turn one of them into a lead, ready to ring.
 *
 * One at a time and by a caller, because that is how the list is actually
 * worked: read a row, decide it is worth a call, take it. The bulk sync below
 * stays for the office deciding to work a whole month at once.
 *
 * Refuses somebody who has since given. The client hides them, but a stale
 * screen must not be able to create the one lead this feature exists to avoid.
 */
router.post('/leads/abandoned/adopt', async (req, res) => {
  const b = req.body ?? {};
  const phone = normalizePhone(b.phone);
  if (!isDialable(phone)) return res.status(400).json({ error: 'That is not a number DRM can ring' });

  try {
    const gave = await pool.query(
      `SELECT MAX(d.created_at) AS last_gift
         FROM people p JOIN donations d ON d.person_id = p.id
        WHERE right(regexp_replace(p.phone,'\\D','','g'), 10) = $1`,
      [phone]
    );
    const last = gave.rows[0]?.last_gift ? new Date(gave.rows[0].last_gift) : null;
    if (last && b.attempted_at && last >= new Date(String(b.attempted_at))) {
      return res.status(409).json({
        error: 'They gave after that attempt — there is nothing to chase. Refresh the list.',
      });
    }

    const { lead, created } = await upsertLead(
      {
        phone,
        name: b.name,
        email: b.email,
        source: 'website',
        source_detail: `Unfinished donation${b.source_page ? ` on ${b.source_page}` : ''}`,
        source_site: b.source_site,
        expected_amount: b.amount ?? null,
        // Theirs to ring, since they are the one who took it off the list.
        assigned_to: b.assigned_to ?? req.user?.userId ?? null,
        tags: ['abandoned'],
      },
      req.user?.userId ?? null
    );

    if (created) {
      await pool.query(
        `INSERT INTO lead_activities (lead_id, user_id, kind, note, occurred_at)
         VALUES ($1,$2,'import',$3,COALESCE($4::timestamptz, NOW()))`,
        [
          lead.id,
          req.user?.userId ?? null,
          `Started a donation of ${b.amount ?? '?'}${b.purpose ? ` for ${b.purpose}` : ''} and did not complete it` +
            (Number(b.attempts) > 1 ? ` (${b.attempts} attempts)` : ''),
          b.attempted_at ?? null,
        ]
      );
    }

    res.status(created ? 201 : 200).json({ lead, created });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    if (status === 400) return res.status(400).json({ error: (err as Error).message });
    console.error('crm.adoptAbandoned error:', err);
    res.status(500).json({ error: 'Could not add that person as a lead' });
  }
});

router.get('/leads', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const sort = SORTS[String(req.query.sort || '')] || SORTS.due;

  try {
    const f = withScope(
      buildLeadFilters(req.query as Record<string, unknown>),
      await leadScopeFor(req.user)
    );
    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT ${LEAD_COLUMNS} ${LEAD_JOINS} ${f.where}
         ORDER BY ${sort} LIMIT $${f.next} OFFSET $${f.next + 1}`,
        [...f.values, limit, (page - 1) * limit]
      ),
      pool.query(`SELECT COUNT(*)::int AS n ${LEAD_JOINS} ${f.where}`, f.values),
    ]);

    res.json({ leads: rows.rows, total: total.rows[0].n, page, limit });
  } catch (err) {
    console.error('crm.listLeads error:', err);
    res.status(500).json({ error: 'Could not load leads' });
  }
});

// One lead, with its whole story. The activity stream is what a caller reads in
// the five seconds before the person picks up, so it comes down with the lead
// rather than as a second request that might not have landed yet.
router.get('/leads/:id', async (req, res) => {
  try {
    const scope = await leadScopeFor(req.user);
    const lead = await pool.query(
      `SELECT ${LEAD_COLUMNS} ${LEAD_JOINS}
        WHERE l.id = $1
          AND ($2::uuid IS NULL OR l.assigned_to = $2::uuid OR l.assigned_to IS NULL)`,
      [req.params.id, scope]
    );
    // 404 rather than 403 on purpose: a caller narrowed to their own leads
    // should not be able to confirm that a given lead id exists by the shape
    // of the refusal.
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead not found' });

    const [activities, donations, reminders] = await Promise.all([
      pool.query(
        `SELECT a.*, u.name AS user_name, d.label AS disposition_label
           FROM lead_activities a
           LEFT JOIN users u ON a.user_id = u.id
           LEFT JOIN crm_dispositions d ON a.disposition = d.slug
          WHERE a.lead_id = $1
          ORDER BY a.occurred_at DESC LIMIT 200`,
        [req.params.id]
      ),
      lead.rows[0].person_id
        ? pool.query(
            `SELECT id, amount, purpose, source_page, source_site, receipt_number, created_at
               FROM donations WHERE person_id = $1 ORDER BY created_at DESC LIMIT 25`,
            [lead.rows[0].person_id]
          )
        : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
      // This lead's promises. Sent with the lead rather than fetched
      // separately, because a reminder is part of what somebody needs to see
      // before ringing - "he already said Govardhan Puja" changes the call -
      // and a second request would mean the page could show the history while
      // still not knowing about the promise.
      //
      // Open ones first, in the order they fall due; everything settled after,
      // most recent first, so the record of what was promised and what came of
      // it stays readable without a filter.
      pool.query(
        `SELECT r.*, u.name AS assigned_to_name
           FROM lead_reminders r
           LEFT JOIN users u ON r.assigned_to = u.id
          WHERE r.lead_id = $1
          ORDER BY (r.status = 'open') DESC,
                   CASE WHEN r.status = 'open' THEN r.due_at END ASC,
                   r.due_at DESC
          LIMIT 50`,
        [req.params.id]
      ),
    ]);

    res.json({
      lead: lead.rows[0],
      activities: activities.rows,
      donations: donations.rows,
      reminders: reminders.rows,
    });
  } catch (err) {
    console.error('crm.getLead error:', err);
    res.status(500).json({ error: 'Could not load that lead' });
  }
});

/**
 * Creates a lead, or returns the one that already exists for this number.
 *
 * Never creates a second lead for a phone that is already there. That is the
 * entire duplicate story in this module: one number is one person to the
 * temple, and two rows means two callers ringing them on the same afternoon,
 * which is the thing donors actually complain about.
 *
 * Also links to an existing DRM person by phone automatically, so a caller
 * typing in a number they were handed on a slip immediately sees that this is a
 * donor of eleven years rather than a stranger.
 */
async function upsertLead(
  input: Record<string, unknown>,
  userId: string | null
): Promise<{ lead: Record<string, unknown>; created: boolean }> {
  const phone = normalizePhone(input.phone);
  if (!phone) throw Object.assign(new Error('A phone number is required'), { status: 400 });

  const person = await pool.query(`SELECT id, name, email FROM people WHERE right(regexp_replace(phone,'\\D','','g'), 10) = $1 LIMIT 1`, [phone]);
  const personId = person.rows[0]?.id ?? null;

  const result = await pool.query(
    `INSERT INTO leads (phone, name, alt_phone, email, city, person_id, source, source_detail,
                        source_site, status, assigned_to, assigned_at, tags, remarks,
                        next_follow_up_at, expected_amount, invalid_reason, created_by)
     -- Every placeholder is cast at its first use. Without the casts Postgres
     -- deduces a parameter's type from whatever literal it sits next to - $12
     -- beside '{}' comes out as text, not text[], and the insert is rejected
     -- with "column tags is of type text[] but expression is of type text".
     -- The same trap bit the prasadam status update; the casts are the fix.
     VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::uuid,
             COALESCE($7::text,'manual'), $8::text, $9::text, COALESCE($10::text,'new'),
             $11::uuid,
             CASE WHEN $11::uuid IS NULL THEN NULL ELSE NOW() END,
             COALESCE($12::text[], '{}'::text[]), $13::text, $14::timestamptz,
             $15::numeric, $16::text, $17::uuid)
     ON CONFLICT (phone) DO UPDATE SET
       -- An import must never blank out what a caller has since learned, so
       -- every field here fills a gap rather than replacing an answer.
       name              = COALESCE(leads.name, EXCLUDED.name),
       alt_phone         = COALESCE(leads.alt_phone, EXCLUDED.alt_phone),
       email             = COALESCE(leads.email, EXCLUDED.email),
       city              = COALESCE(leads.city, EXCLUDED.city),
       person_id         = COALESCE(EXCLUDED.person_id, leads.person_id),
       source_detail     = COALESCE(leads.source_detail, EXCLUDED.source_detail),
       tags              = ARRAY(SELECT DISTINCT unnest(leads.tags || EXCLUDED.tags)),
       expected_amount   = COALESCE(leads.expected_amount, EXCLUDED.expected_amount),
       updated_at        = NOW()
     RETURNING *, (xmax = 0) AS was_inserted`,
    [
      phone,
      str(input.name) ?? person.rows[0]?.name ?? null,
      str(input.alt_phone, 15),
      str(input.email) ?? person.rows[0]?.email ?? null,
      str(input.city, 120),
      personId,
      str(input.source, 20),
      str(input.source_detail),
      str(input.source_site, 20),
      str(input.status, 30),
      str(input.assigned_to, 36),
      Array.isArray(input.tags) ? input.tags.map((t) => String(t).slice(0, 40)) : null,
      str(input.remarks, 2000),
      asDate(input.next_follow_up_at),
      num(input.expected_amount),
      isDialable(phone) ? null : 'Not a valid 10-digit mobile number',
      userId,
    ]
  );

  const lead = result.rows[0];
  return { lead, created: lead.was_inserted === true };
}

router.post('/leads', async (req, res) => {
  try {
    const { lead, created } = await upsertLead(req.body ?? {}, req.user?.userId ?? null);
    if (created) {
      await pool.query(
        `INSERT INTO lead_activities (lead_id, user_id, kind, note) VALUES ($1,$2,'import',$3)`,
        [lead.id, req.user?.userId ?? null, `Lead added (${lead.source})`]
      );
    }
    res.status(created ? 201 : 200).json({ lead, created, duplicate: !created });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    if (status === 400) return res.status(400).json({ error: (err as Error).message });
    console.error('crm.createLead error:', err);
    res.status(500).json({ error: 'Could not save that lead' });
  }
});

/**
 * POST /promises - somebody rang US and said they would give.
 *
 * WHY THIS IS NOT JUST "ADD A LEAD"
 * The temple's phone rings and a donor says "I will give ten thousand on
 * Govardhan Puja". Until now that took three separate acts in DRM - find or
 * create the lead, set a callback on it, raise a reminder - each on a
 * different screen, which in practice meant it was written on paper and
 * remembered by whoever answered. A promise made to the temple deserves better
 * than somebody's memory.
 *
 * So this is one call that does all three:
 *   - finds the lead by phone, or creates one
 *   - books the callback so the follow-ups board shows it
 *   - raises a reminder, which is what actually alerts somebody in time
 *
 * The reminder is the point. A follow-up date is a working note; a reminder
 * carries lead times and raises an alert before the moment passes, which is
 * the difference between ringing on the morning they said and ringing a week
 * later to apologise.
 */
router.post('/promises', async (req, res) => {
  const b = req.body ?? {};
  const due = b.due_at ? new Date(String(b.due_at)) : null;
  if (!due || Number.isNaN(due.getTime())) {
    return res.status(400).json({ error: 'When did they say they would give?' });
  }
  if (!normalizePhone(b.phone)) {
    return res.status(400).json({ error: 'A phone number is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // upsertLead runs on the pool, not on this client, so the lead is NOT
    // inside the transaction below. That is deliberate and it is the lesser
    // evil: it owns the matching rules - phone normalisation, the link to an
    // existing person - and a second copy of those rules here would drift from
    // the first within a month. The cost is that a failure further down leaves
    // a lead with no reminder on it, which is a lead somebody can still ring;
    // the reverse, a reminder pointing at no lead, would be a broken row.
    const { lead, created } = await upsertLead(
      {
        phone: b.phone,
        name: b.name,
        city: b.city,
        email: b.email,
        source_detail: str(b.source_detail, 255) ?? 'Rang the temple',
        expected_amount: b.expected_amount ?? null,
        assigned_to: b.assigned_to ?? req.user?.userId ?? null,
      },
      req.user?.userId ?? null
    );

    const title =
      str(b.title, 200) ??
      (b.expected_amount
        ? `Promised ₹${Number(b.expected_amount).toLocaleString('en-IN')}`
        : 'Said they would donate');

    // The callback, so it appears on the follow-ups board alongside everything
    // else owed. Only moved earlier, never later: if this lead is already due a
    // call before this date, that earlier promise still stands.
    await client.query(
      `UPDATE leads SET
         next_follow_up_at = CASE
           WHEN next_follow_up_at IS NULL OR next_follow_up_at > $2::timestamptz
           THEN $2::timestamptz ELSE next_follow_up_at END,
         follow_up_note  = COALESCE($3, follow_up_note),
         expected_amount = COALESCE($4::numeric, expected_amount),
         updated_at = NOW()
       WHERE id = $1`,
      [lead.id, due.toISOString(), title, b.expected_amount ?? null]
    );

    const reminder = await client.query(
      `INSERT INTO lead_reminders
         (lead_id, title, note, occasion, due_at, expected_amount, lead_times, assigned_to, created_by)
       VALUES ($1::uuid,$2,$3,$4,$5::timestamptz,$6::numeric,$7::int[],
               COALESCE($8::uuid, (SELECT assigned_to FROM leads WHERE id = $1::uuid)), $9::uuid)
       RETURNING *`,
      [
        lead.id,
        title,
        str(b.note, 2000),
        str(b.occasion, 120),
        due.toISOString(),
        b.expected_amount ?? null,
        promiseLeadTimes(b.lead_times),
        str(b.assigned_to, 36),
        req.user?.userId ?? null,
      ]
    );

    await client.query(
      `INSERT INTO lead_activities (lead_id, user_id, kind, to_value, note)
       VALUES ($1::uuid,$2::uuid,'reminder',$3,$4)`,
      [
        lead.id,
        req.user?.userId ?? null,
        due.toISOString(),
        `They rang and said they would give. ${title}${b.occasion ? ` — ${String(b.occasion)}` : ''}`,
      ]
    );

    await client.query('COMMIT');
    res.status(201).json({ lead, created, reminder: reminder.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    const status = (err as { status?: number }).status ?? 500;
    if (status === 400) return res.status(400).json({ error: (err as Error).message });
    console.error('crm.promise error:', err);
    res.status(500).json({ error: 'Could not record that promise' });
  } finally {
    client.release();
  }
});

/**
 * Minutes-before values for a promise's alerts.
 *
 * Kept identical to the reminders route's own rule rather than shared through
 * an import, because the two files would otherwise have to import each other:
 * up to thirty days ahead, de-duplicated, largest first. The default here is
 * wider than a reminder booked mid-call - two days, one day, one hour - because
 * a promise made weeks out needs warning long before the morning it falls due.
 */
function promiseLeadTimes(v: unknown): number[] {
  const raw = Array.isArray(v) && v.length ? v : [2880, 1440, 60];
  const cleaned = raw
    .map((n) => Math.round(Number(n)))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 43200);
  return [...new Set(cleaned)].sort((a, b) => b - a);
}

/**
 * GET /leads/:id/removal - what deleting this lead would take with it.
 *
 * Asked before the confirmation is shown, so the warning names real numbers
 * rather than describing the idea of deletion. "This removes 4 calls and 1
 * promise" is a decision; "this cannot be undone" is a shrug.
 */
router.get('/leads/:id/removal', authorize('admin'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT l.name, l.phone,
              (SELECT COUNT(*)::int FROM lead_activities a WHERE a.lead_id = l.id) AS activities,
              (SELECT COUNT(*)::int FROM lead_reminders  m WHERE m.lead_id = l.id) AS reminders,
              (SELECT COUNT(*)::int FROM qr_shares       s WHERE s.lead_id = l.id) AS qr_shares,
              (SELECT COUNT(*)::int FROM qr_shares       s
                WHERE s.lead_id = l.id AND s.matched_at IS NOT NULL) AS qr_paid,
              l.converted_donation_id IS NOT NULL AS has_donation
         FROM leads l WHERE l.id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Lead not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('crm.removalPreview error:', err);
    res.status(500).json({ error: 'Could not check that lead' });
  }
});

/**
 * DELETE /leads/:id - remove a lead entirely.
 *
 * WHY THIS EXISTS AND WHY IT IS ADMIN-ONLY
 * Mostly for what put it here: a test lead somebody added to try the QR flow,
 * and the odd genuine mistake - a wrong number typed in, the same person
 * entered twice under two spellings. Callers do not get it. A caller who
 * cannot reach somebody should mark them so, not make them disappear; a lead
 * deleted to tidy a queue is a donor the temple then has no record of ever
 * having spoken to.
 *
 * WHAT GOES AND WHAT STAYS
 * The lead, its calls and notes, and its reminders go - those describe this
 * lead and mean nothing without it.
 *
 * Donations do NOT. They belong to the person and to the site that receipted
 * them, they are synced from there, and DRM deleting one would put it back on
 * the next sync while the 80G receipt stayed issued regardless.
 *
 * A QR share stays too, with its link to this lead cleared. A share that was
 * paid is a record of money arriving, and money that arrived must never
 * disappear because somebody tidied up the lead beside it. It stays on the QR
 * payments screen, still attached to the person if it ever was.
 */
router.delete('/leads/:id', authorize('admin'), async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM leads WHERE id = $1 RETURNING id, name, phone, converted_donation_id`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Lead not found' });

    // The only trace left once the rows are gone. Worth having: "who deleted
    // the lead for this number" is a question somebody eventually asks, and
    // the activity log that would have answered it is deleted along with it.
    console.log(
      `crm.deleteLead: ${req.user?.userId ?? 'unknown'} removed lead ${r.rows[0].phone}` +
        `${r.rows[0].name ? ` (${r.rows[0].name})` : ''}`
    );

    res.json({
      removed: true,
      phone: r.rows[0].phone,
      // Said back plainly, because it is the part people assume went too.
      donation_kept: !!r.rows[0].converted_donation_id,
    });
  } catch (err) {
    console.error('crm.deleteLead error:', err);
    res.status(500).json({ error: 'Could not remove that lead' });
  }
});

router.put('/leads/:id', async (req, res) => {
  const b = req.body ?? {};
  try {
    const before = await pool.query(`SELECT status, assigned_to FROM leads WHERE id = $1`, [req.params.id]);
    if (!before.rows.length) return res.status(404).json({ error: 'Lead not found' });

    const result = await pool.query(
      `UPDATE leads SET
         name              = COALESCE($1, name),
         alt_phone         = COALESCE($2, alt_phone),
         email             = COALESCE($3, email),
         city              = COALESCE($4, city),
         status            = COALESCE($5, status),
         assigned_to       = CASE WHEN $6::text = 'unassign' THEN NULL
                                  WHEN $6::text IS NULL THEN assigned_to
                                  ELSE $6::uuid END,
         assigned_at       = CASE WHEN $6::text IS NULL THEN assigned_at ELSE NOW() END,
         tags              = COALESCE($7, tags),
         remarks           = COALESCE($8, remarks),
         next_follow_up_at = CASE WHEN $9::text = 'clear' THEN NULL
                                  WHEN $9::text IS NULL THEN next_follow_up_at
                                  ELSE $9::timestamptz END,
         follow_up_note    = COALESCE($10, follow_up_note),
         expected_amount   = COALESCE($11, expected_amount),
         -- 'clear' rather than null, so "no preacher" can be chosen
         -- deliberately and is not the same as "field not sent".
         preacher_id       = CASE WHEN $14::text = 'clear' THEN NULL
                                  WHEN $14::text IS NULL THEN preacher_id
                                  ELSE $14::uuid END,
         -- Once set, do_not_call is only cleared by explicitly passing false.
         do_not_call       = COALESCE($12, do_not_call),
         updated_at        = NOW()
       WHERE id = $13 RETURNING *`,
      [
        str(b.name),
        str(b.alt_phone, 15),
        str(b.email),
        str(b.city, 120),
        str(b.status, 30),
        b.assigned_to === null ? 'unassign' : str(b.assigned_to, 36),
        Array.isArray(b.tags) ? b.tags.map((t: unknown) => String(t).slice(0, 40)) : null,
        str(b.remarks, 2000),
        b.next_follow_up_at === null ? 'clear' : asDate(b.next_follow_up_at),
        str(b.follow_up_note, 500),
        num(b.expected_amount),
        typeof b.do_not_call === 'boolean' ? b.do_not_call : null,
        req.params.id,
        b.preacher_id === null ? 'clear' : str(b.preacher_id, 36),
      ]
    );

    const lead = result.rows[0];
    // Only the transitions worth reading later. An edit to a spelling is not
    // history; a lead moving from interested to not interested is.
    if (b.status && b.status !== before.rows[0].status) {
      await pool.query(
        `INSERT INTO lead_activities (lead_id, user_id, kind, from_value, to_value, note)
         VALUES ($1,$2,'status_change',$3,$4,$5)`,
        [lead.id, req.user?.userId ?? null, before.rows[0].status, b.status, str(b.remarks, 500)]
      );
    }
    if (b.assigned_to !== undefined && b.assigned_to !== before.rows[0].assigned_to) {
      await pool.query(
        `INSERT INTO lead_activities (lead_id, user_id, kind, from_value, to_value)
         VALUES ($1,$2,'assignment',$3,$4)`,
        [lead.id, req.user?.userId ?? null, before.rows[0].assigned_to, b.assigned_to]
      );
    }

    res.json(lead);
  } catch (err) {
    console.error('crm.updateLead error:', err);
    res.status(500).json({ error: 'Could not save that lead' });
  }
});

/* ----------------------------------------------------------- the call itself */

/**
 * POST /leads/:id/call - log one call.
 *
 * This is the hot path: a caller hits it sixty times an hour, so it does
 * everything a single call implies in one request rather than making the screen
 * fire three. The disposition carries the rest with it:
 *
 *   - crm_dispositions.counts_connected decides the connected/unanswered split
 *   - suggests_status moves the lead unless the caller overrode it
 *   - wants_follow_up is why a callback date came down with the request
 *
 * The attempt counter and last_contacted_at are maintained here, not derived at
 * read time, because the calling queue sorts by them and a subquery per row
 * would show up immediately on a list of several thousand.
 */
router.post('/leads/:id/call', async (req, res) => {
  const b = req.body ?? {};
  const disposition = str(b.disposition, 30);
  if (!disposition) return res.status(400).json({ error: 'Pick what came of the call' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Everything a logged call changes, captured before it changes, so Undo
    // can put the lead back exactly rather than guessing at it afterwards.
    const lead = await client.query(
      `SELECT id, status, person_id, call_attempts, last_contacted_at, last_outcome,
              next_follow_up_at, follow_up_note, do_not_call, remarks,
              -- Needed by the conversion block below, and worth having in the
              -- undo payload: undoing a call that recorded a donation has to
              -- be able to put the lead back to not having one.
              converted_at, converted_amount, converted_via, expected_amount
         FROM leads WHERE id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (!lead.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Lead not found' });
    }

    const d = await client.query(
      `SELECT slug, counts_connected, suggests_status, wants_follow_up FROM crm_dispositions WHERE slug = $1`,
      [disposition]
    );
    if (!d.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Unknown call outcome "${disposition}"` });
    }

    // The caller may say otherwise - a "no answer" that actually connected and
    // was hung up on - so an explicit value wins over the disposition's default.
    const connected = typeof b.connected === 'boolean' ? b.connected : d.rows[0].counts_connected;
    const duration = num(b.duration_seconds);

    // Which run at which list this call belonged to. Verified against the
    // caller rather than trusted from the body, so one caller's shift can never
    // have another's calls counted into it. An unknown or finished session is
    // dropped to NULL rather than refused: losing the tally is a small thing
    // beside refusing to record a call that has already happened.
    const sessionId = str(b.session_id, 36);
    const session = sessionId
      ? await client.query(
          `SELECT id FROM calling_sessions WHERE id = $1 AND user_id = $2 AND ended_at IS NULL`,
          [sessionId, req.user?.userId ?? null]
        )
      : null;
    const activeSession = session?.rows[0]?.id ?? null;

    const activity = await client.query(
      `INSERT INTO lead_activities
         (lead_id, user_id, kind, direction, disposition, connected, duration_seconds,
          source, provider_call_id, recording_url, note, occurred_at, undo_payload, session_id)
       VALUES ($1,$2,'call',COALESCE($3,'outbound'),$4,$5,$6,COALESCE($7,'manual'),$8,$9,$10,COALESCE($11::timestamptz, NOW()),$12::jsonb,$13::uuid)
       RETURNING *`,
      [
        req.params.id,
        req.user?.userId ?? null,
        str(b.direction, 10),
        disposition,
        connected,
        duration !== null && duration >= 0 ? Math.round(duration) : null,
        str(b.source, 20),
        str(b.provider_call_id, 120),
        str(b.recording_url, 1000),
        str(b.note, 2000),
        asDate(b.occurred_at),
        JSON.stringify(lead.rows[0]),
        activeSession,
      ]
    );

    if (activeSession) {
      await client.query(
        `UPDATE calling_sessions SET
           calls_logged   = calls_logged + 1,
           connected      = connected + CASE WHEN $2 THEN 1 ELSE 0 END,
           last_active_at = NOW()
         WHERE id = $1`,
        [activeSession, connected === true]
      );
    }

    const nextStatus = str(b.status, 30) ?? d.rows[0].suggests_status ?? lead.rows[0].status;
    const followUp = b.next_follow_up_at === null ? null : asDate(b.next_follow_up_at);

    // How long before an unanswered lead comes back round. Configurable in
    // Settings because the right gap differs by campaign - a festival appeal
    // three days out cannot wait a week between attempts.
    const retry = await client.query(`SELECT value FROM crm_settings WHERE key = 'retry_after_days'`);
    const retryAfterDays = Math.max(1, Math.min(90, Number(retry.rows[0]?.value ?? 2)));

    const updated = await client.query(
      `UPDATE leads SET
         status            = COALESCE($1, status),
         last_contacted_at = NOW(),
         last_outcome      = $2,
         call_attempts     = call_attempts + 1,
         remarks           = COALESCE($3, remarks),
         -- Three cases, in order:
         --   a date the caller chose wins outright;
         --   an outcome that implies "try again" (no answer, busy, switched
         --     off) and no date given schedules the retry automatically, so an
         --     unanswered lead comes back round instead of falling into a hole
         --     nobody ever looks in - this is what keeps the queue alive;
         --   anything else clears the date, so the follow-up list doesn't fill
         --     with names nobody needs to ring again.
         next_follow_up_at = CASE
             WHEN $4::timestamptz IS NOT NULL THEN $4::timestamptz
             WHEN $5::boolean THEN COALESCE(next_follow_up_at, NOW() + ($9::int || ' days')::interval)
             ELSE NULL END,
         follow_up_note    = CASE WHEN $4::timestamptz IS NOT NULL THEN $6 ELSE follow_up_note END,
         do_not_call       = do_not_call OR $7::boolean,
         -- "They said they would pay by the QR I just sent."
         --
         -- Set here, on the call, because that is the only moment anybody
         -- knows it. It is what lets the screen that attributes an unmatched
         -- payment show the handful of people who actually said they would
         -- pay, instead of everyone who was ever sent a QR. Cleared the
         -- moment money arrives, so the list is always "still waiting".
         awaiting_qr_at    = CASE
             WHEN $10::boolean THEN NOW()
             ELSE awaiting_qr_at END,
         updated_at        = NOW()
       WHERE id = $8 RETURNING *`,
      [
        nextStatus,
        disposition,
        str(b.note, 2000),
        followUp,
        d.rows[0].wants_follow_up === true,
        str(b.follow_up_note, 500),
        disposition === 'do_not_call',
        req.params.id,
        retryAfterDays,
        disposition === 'will_pay_qr',
      ]
    );

    // And the share they were sent is marked as awaited too, which is what the
    // matcher reads. The most recent unmatched one for this lead: a caller
    // choosing this outcome has just pressed send, and marking an older share
    // they never mentioned would put weight on the wrong row.
    if (disposition === 'will_pay_qr') {
      await client.query(
        `UPDATE qr_shares SET awaiting_payment_at = NOW()
          WHERE id = (
            SELECT id FROM qr_shares
             WHERE lead_id = $1::uuid AND matched_at IS NULL
             ORDER BY created_at DESC LIMIT 1
          )`,
        [req.params.id]
      );
    }

    // "Donated now" moved the stage and recorded nothing else.
    //
    // The disposition suggests the 'converted' stage, so the lead correctly
    // left the queue - and then every conversion count, every rupee figure,
    // the leads screen's own Converted filter and the "one of your leads
    // donated" alert read it as a lead that never converted, because all of
    // them key on converted_at. A caller taking a donation on the call was the
    // one path through DRM that recorded a conversion nowhere.
    //
    // The amount is whatever the caller said, else what the lead was expected
    // to give, else nothing - an amount of zero is still a conversion, and a
    // conversion with no figure is better than a donation DRM denies happened.
    if (nextStatus === 'converted' && !lead.rows[0].converted_at) {
      await client.query(
        `UPDATE leads SET
           converted_amount   = COALESCE($2::numeric, expected_amount),
           converted_at       = NOW(),
           converted_via      = 'manual',
           converted_note     = COALESCE(converted_note, $3),
           conversion_seen_at = NOW(),
           awaiting_qr_at     = NULL
         WHERE id = $1`,
        [
          req.params.id,
          num(b.donated_amount) ?? num(b.expected_amount),
          `Gave on the call (${disposition})`,
        ]
      );
      // And the chase stops, exactly as it does on every other path money
      // arrives by.
      await client.query(
        `UPDATE lead_reminders SET status = 'done', completed_at = NOW(), updated_at = NOW()
          WHERE lead_id = $1 AND status = 'open'`,
        [req.params.id]
      );
    }

    if (nextStatus !== lead.rows[0].status) {
      await client.query(
        `INSERT INTO lead_activities (lead_id, user_id, kind, from_value, to_value)
         VALUES ($1,$2,'status_change',$3,$4)`,
        [req.params.id, req.user?.userId ?? null, lead.rows[0].status, nextStatus]
      );
    }

    // A promise made on the call becomes a reminder in the same request.
    //
    // This is the difference between a reminder feature people use and one they
    // don't. "I'll donate on Govardhan Puja evening" is said DURING the call -
    // if capturing it means finishing the call, finding the lead again and
    // opening a separate form, it gets captured perhaps a third of the time.
    // Here the caller types the occasion into the box already in front of them
    // and it is saved with the call.
    let reminder = null;
    const rem = b.reminder;
    if (rem && rem.due_at) {
      const remDue = asDate(rem.due_at);
      if (remDue) {
        const created = await client.query(
          `INSERT INTO lead_reminders
             (lead_id, title, note, occasion, due_at, expected_amount, lead_times, assigned_to, created_by)
           VALUES ($1,$2,$3,$4,$5::timestamptz,$6::numeric,
                   -- What the caller chose, else the temple's own default from
                   -- Calling setup, else the built-in. Read here rather than in
                   -- code so changing the setting changes the next reminder,
                   -- with nothing to redeploy and no copy of the default left
                   -- behind in a second place to disagree with it.
                   COALESCE(
                     $7::int[],
                     (SELECT ARRAY(SELECT jsonb_array_elements_text(value)::int)
                        FROM crm_settings WHERE key = 'reminder_lead_times'),
                     '{1440,60,15}'
                   ),
                   COALESCE((SELECT assigned_to FROM leads WHERE id = $1), $8::uuid), $8::uuid)
           RETURNING *`,
          [
            req.params.id,
            str(rem.title, 200) ?? `Said they would donate${rem.occasion ? ` at ${String(rem.occasion).slice(0, 80)}` : ''}`,
            str(rem.note, 2000) ?? str(b.note, 2000),
            str(rem.occasion, 120),
            remDue,
            num(rem.expected_amount) ?? num(b.expected_amount),
            Array.isArray(rem.lead_times) && rem.lead_times.length
              ? rem.lead_times.map((n: unknown) => Math.round(Number(n))).filter((n: number) => Number.isFinite(n) && n >= 0)
              : null,
            req.user?.userId ?? null,
          ]
        );
        reminder = created.rows[0];
        await client.query(
          `INSERT INTO lead_activities (lead_id, user_id, kind, to_value, note)
           VALUES ($1,$2,'reminder',$3,$4)`,
          [req.params.id, req.user?.userId ?? null, remDue, reminder.title]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ activity: activity.rows[0], lead: updated.rows[0], reminder });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('crm.logCall error:', err);
    res.status(500).json({ error: 'Could not log that call' });
  } finally {
    client.release();
  }
});

// A note without a call - someone replied on WhatsApp, or a preacher passed on
// what they heard at the temple.
router.post('/leads/:id/note', async (req, res) => {
  const note = str(req.body?.note, 2000);
  if (!note) return res.status(400).json({ error: 'Write something first' });
  try {
    const result = await pool.query(
      `INSERT INTO lead_activities (lead_id, user_id, kind, note) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, req.user?.userId ?? null, str(req.body?.kind, 20) ?? 'note', note]
    );
    await pool.query(`UPDATE leads SET remarks = $1, updated_at = NOW() WHERE id = $2`, [note, req.params.id]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('crm.addNote error:', err);
    res.status(500).json({ error: 'Could not save that note' });
  }
});

// Book a callback without logging a call - the quick action on the follow-ups
// board when someone asks to be rung next month.
router.post('/leads/:id/follow-up', async (req, res) => {
  const when = asDate(req.body?.at);
  try {
    const result = await pool.query(
      `UPDATE leads SET next_follow_up_at = $1, follow_up_note = $2, updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [when, str(req.body?.note, 500), req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Lead not found' });

    await pool.query(
      `INSERT INTO lead_activities (lead_id, user_id, kind, to_value, note) VALUES ($1,$2,'follow_up',$3,$4)`,
      [req.params.id, req.user?.userId ?? null, when, str(req.body?.note, 500)]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('crm.setFollowUp error:', err);
    res.status(500).json({ error: 'Could not set that follow-up' });
  }
});

/* ------------------------------------------------------------ bulk actions */

// Up to 2,000 leads at a time - reassigned, retired, tagged or silenced.
// That is an office action by its nature, and a caller reaching it could take
// the whole board or mark it do-not-call in one request.
router.post('/leads/bulk', authorize('admin', 'accountant'), async (req, res) => {
  const { ids, action } = req.body ?? {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Select at least one lead' });
  if (ids.length > 2000) return res.status(400).json({ error: 'Too many at once - filter down and work in batches' });

  try {
    let result;
    if (action === 'assign') {
      result = await pool.query(
        `UPDATE leads SET assigned_to = $1, assigned_at = NOW(), updated_at = NOW() WHERE id = ANY($2::uuid[]) RETURNING id`,
        [str(req.body.assigned_to, 36), ids]
      );
    } else if (action === 'status') {
      result = await pool.query(
        // The callback goes when the new stage is a closed one. Without this,
        // 300 leads bulk-set to Not interested vanished from the queue but
        // stayed in the follow-ups board's Overdue column for ever - red,
        // permanent, and disagreeing with the supervisor's overdue report,
        // which does honour the stage.
        `UPDATE leads l SET
           status = $1,
           next_follow_up_at = CASE
             WHEN COALESCE((SELECT s.is_open FROM crm_statuses s WHERE s.slug = $1), TRUE)
             THEN l.next_follow_up_at ELSE NULL END,
           awaiting_qr_at = CASE
             WHEN COALESCE((SELECT s.is_open FROM crm_statuses s WHERE s.slug = $1), TRUE)
             THEN l.awaiting_qr_at ELSE NULL END,
           updated_at = NOW()
         WHERE l.id = ANY($2::uuid[]) RETURNING l.id`,
        [str(req.body.status, 30), ids]
      );
    } else if (action === 'tag') {
      result = await pool.query(
        `UPDATE leads SET tags = ARRAY(SELECT DISTINCT unnest(tags || $1::text[])), updated_at = NOW()
         WHERE id = ANY($2::uuid[]) RETURNING id`,
        [(req.body.tags ?? []).map((t: unknown) => String(t).slice(0, 40)), ids]
      );
    } else if (action === 'untag') {
      result = await pool.query(
        `UPDATE leads SET tags = ARRAY(SELECT unnest(tags) EXCEPT SELECT unnest($1::text[])), updated_at = NOW()
         WHERE id = ANY($2::uuid[]) RETURNING id`,
        [(req.body.tags ?? []).map((t: unknown) => String(t)), ids]
      );
    } else if (action === 'follow_up') {
      result = await pool.query(
        `UPDATE leads SET next_follow_up_at = $1, updated_at = NOW() WHERE id = ANY($2::uuid[]) RETURNING id`,
        [asDate(req.body.at), ids]
      );
    } else if (action === 'preacher') {
      result = await pool.query(
        `UPDATE leads SET preacher_id = $1::uuid, updated_at = NOW() WHERE id = ANY($2::uuid[]) RETURNING id`,
        [str(req.body.preacher_id, 36), ids]
      );
    } else if (action === 'do_not_call') {
      result = await pool.query(
        // Opting out clears what would otherwise keep reaching them: a booked
        // callback, and any flag saying they are expected to pay.
        `UPDATE leads SET do_not_call = TRUE, status = 'dnc',
           next_follow_up_at = NULL, awaiting_qr_at = NULL, updated_at = NOW()
         WHERE id = ANY($1::uuid[]) RETURNING id`,
        [ids]
      );
    } else {
      return res.status(400).json({ error: `Unknown action "${action}"` });
    }

    res.json({ requested: ids.length, updated: result.rowCount ?? 0 });
  } catch (err) {
    console.error('crm.bulk error:', err);
    res.status(500).json({ error: 'Could not apply that to the selected leads' });
  }
});

/* ------------------------------------------------- pulling donors into leads */

/**
 * POST /leads/from-people - build a calling list out of DRM's own donors.
 *
 * This is how most calling actually starts at the temple: "ring everyone who
 * gave at Janmashtami last year and hasn't given since". Rather than export to
 * a spreadsheet and import it back, the filters run against people/donations
 * directly and the matching donors become leads, already linked, with their
 * giving history attached.
 *
 * Preview first (dry_run), because the difference between 40 names and 4,000 is
 * the difference between an afternoon and a fortnight, and nobody should find
 * that out after the fact.
 */
router.post('/leads/from-people', authorize('admin', 'accountant'), async (req, res) => {
  const b = req.body ?? {};
  const conditions: string[] = [`p.phone IS NOT NULL`];
  const values: unknown[] = [];
  let i = 1;

  if (b.site) {
    conditions.push(`p.source_sites && $${i++}`);
    values.push(Array.isArray(b.site) ? b.site : [b.site]);
  }
  if (b.min_total) {
    conditions.push(`COALESCE(g.total,0) >= $${i++}`);
    values.push(num(b.min_total));
  }
  if (b.max_total) {
    conditions.push(`COALESCE(g.total,0) <= $${i++}`);
    values.push(num(b.max_total));
  }
  if (b.gave_since) {
    conditions.push(`g.last_at >= $${i++}`);
    values.push(b.gave_since);
  }
  // "Lapsed": gave once, but not since this date. The whole point of most
  // calling lists.
  if (b.not_since) {
    conditions.push(`(g.last_at IS NULL OR g.last_at < $${i++})`);
    values.push(b.not_since);
  }
  if (b.purpose) {
    conditions.push(`EXISTS (SELECT 1 FROM donations d2 WHERE d2.person_id = p.id AND d2.purpose ILIKE $${i++})`);
    values.push(`%${b.purpose}%`);
  }
  if (b.has_donated === true) conditions.push(`g.n > 0`);

  const limit = Math.min(5000, Number(b.limit) || 500);

  const selectSql = `
    SELECT p.id, p.name, p.email, right(regexp_replace(p.phone,'\\D','','g'), 10) AS phone10,
           COALESCE(g.total,0) AS total, COALESCE(g.n,0) AS n, g.last_at
      FROM people p
      LEFT JOIN LATERAL (
        SELECT SUM(d.amount) AS total, COUNT(*)::int AS n, MAX(d.created_at) AS last_at
          FROM donations d WHERE d.person_id = p.id
      ) g ON TRUE
     WHERE ${conditions.join(' AND ')}
       AND length(right(regexp_replace(p.phone,'\\D','','g'), 10)) = 10
     ORDER BY COALESCE(g.total,0) DESC
     LIMIT $${i}`;

  try {
    const people = await pool.query(selectSql, [...values, limit]);

    if (b.dry_run !== false) {
      const already = await pool.query(
        `SELECT COUNT(*)::int AS n FROM leads WHERE phone = ANY($1::text[])`,
        [people.rows.map((r) => r.phone10)]
      );
      return res.json({
        matched: people.rows.length,
        already_leads: already.rows[0].n,
        would_add: people.rows.length - already.rows[0].n,
        sample: people.rows.slice(0, 10),
      });
    }

    let added = 0;
    let existing = 0;
    for (const p of people.rows) {
      const { created } = await upsertLead(
        {
          phone: p.phone10,
          name: p.name,
          email: p.email,
          source: 'donor',
          source_detail: str(b.list_name, 255) ?? 'Pulled from DRM donors',
          assigned_to: b.assigned_to,
          tags: b.tags,
          status: b.status,
        },
        req.user?.userId ?? null
      );
      created ? added++ : existing++;
    }

    res.json({ matched: people.rows.length, added, already_leads: existing });
  } catch (err) {
    console.error('crm.fromPeople error:', err);
    res.status(500).json({ error: 'Could not build that list' });
  }
});

/* ------------------------------------------------------- CSV in and out */

// Minimal CSV reader: quoted fields, embedded commas, doubled quotes, and both
// line endings. Deliberately not a dependency - the files here are contact
// lists typed by volunteers, and a parser we can read is worth more than one
// that handles RFC edge cases nobody will ever produce.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  // A UTF-8 BOM would otherwise become part of the first header name, so the
  // "phone" column silently fails to match.
  const src = text.replace(/^﻿/, '');

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

// Matches a header to a field by what people actually type. "Mobile No.",
// "Contact Number" and "phone" are all the phone column, and asking a volunteer
// to rename their spreadsheet's headers before uploading is how a feature goes
// unused.
const HEADER_ALIASES: Record<string, string[]> = {
  phone: ['phone', 'mobile', 'mobile no', 'mobile number', 'contact', 'contact no', 'contact number', 'number', 'whatsapp'],
  name: ['name', 'donor name', 'full name', 'contact name', 'person'],
  email: ['email', 'e-mail', 'email id', 'mail'],
  city: ['city', 'town', 'location', 'place'],
  alt_phone: ['alt phone', 'alternate phone', 'alternate number', 'second number', 'phone 2'],
  remarks: ['remarks', 'notes', 'note', 'comment', 'comments', 'description'],
  expected_amount: ['expected amount', 'amount', 'pledge', 'expected', 'target'],
  tags: ['tags', 'tag', 'category', 'group'],
};

function mapHeaders(header: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  header.forEach((raw, idx) => {
    // Trailing trim matters: "Mobile No." becomes "mobile no " once the full
    // stop is turned into a space, and would then match nothing at all.
    const h = raw.toLowerCase().replace(/[._\-#]+/g, ' ').replace(/\s+/g, ' ').trim();
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (map[field] === undefined && aliases.includes(h)) map[field] = idx;
    }
  });
  return map;
}

/**
 * POST /leads/import/preview - read the file and say what would happen.
 *
 * Nothing is written. Two phases rather than one because a contact list is the
 * kind of file where a third of the rows turn out to be landlines, blanks, or
 * people already being called by someone else - and finding that out from a
 * summary beforehand is very different from finding it out from a queue that
 * suddenly has 900 dead numbers in it.
 *
 * Rows are sorted into four buckets, and each is shown with examples:
 *   new        will be added
 *   duplicate  already a lead; the existing one is kept and gaps filled
 *   invalid    not a dialable 10-digit mobile
 *   blank      no phone at all
 */
router.post('/leads/import/preview', authorize('admin', 'accountant'), async (req, res) => {
  // Two ways in. `csv` is raw text, which is what the browser sends when it
  // read the file itself. `rows` is a grid the browser already has, which is
  // what it sends for an Excel file - /api/files/parse turned the workbook into
  // rows of text and the person picked the sheet. Either way the code below is
  // looking at the same thing: a header row and some rows under it.
  let rows: string[][];
  if (Array.isArray(req.body?.rows)) {
    rows = (req.body.rows as unknown[][])
      .map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : []))
      .filter((r) => r.some((c) => c.trim() !== ''));
  } else {
    const text = String(req.body?.csv ?? '');
    if (!text.trim()) return res.status(400).json({ error: 'The file looks empty' });
    rows = parseCsv(text);
  }
  if (rows.length < 2) return res.status(400).json({ error: 'The file needs a header row and at least one lead' });

  const header = rows[0];
  const map = mapHeaders(header);
  if (map.phone === undefined) {
    return res.status(400).json({
      error: 'No phone column found',
      detail: `Looked for one of: ${HEADER_ALIASES.phone.join(', ')}. Found: ${header.join(', ')}`,
    });
  }

  const parsed = rows.slice(1).map((r, idx) => {
    const at = (f: string) => (map[f] === undefined ? '' : (r[map[f]] ?? '').trim());
    const phone = normalizePhone(at('phone'));
    return {
      row: idx + 2,
      phone,
      name: at('name') || null,
      email: at('email') || null,
      city: at('city') || null,
      alt_phone: at('alt_phone') || null,
      remarks: at('remarks') || null,
      expected_amount: num(at('expected_amount')),
      tags: at('tags') ? at('tags').split(/[;|]/).map((t) => t.trim()).filter(Boolean) : [],
      raw: at('phone'),
    };
  });

  const blank = parsed.filter((p) => !p.phone);
  const invalid = parsed.filter((p) => p.phone && !isDialable(p.phone));
  const dialable = parsed.filter((p) => isDialable(p.phone));

  try {
    // Deduplicate within the file itself first - the same number twice in one
    // spreadsheet is common and would otherwise be reported as one new and one
    // duplicate, which reads as a bug.
    const seen = new Set<string>();
    const unique = dialable.filter((p) => (seen.has(p.phone) ? false : (seen.add(p.phone), true)));
    const repeatedInFile = dialable.length - unique.length;

    const existing = await pool.query(
      `SELECT l.phone, l.name, l.status, l.do_not_call, u.name AS assigned_to_name
         FROM leads l LEFT JOIN users u ON l.assigned_to = u.id
        WHERE l.phone = ANY($1::text[])`,
      [unique.map((p) => p.phone)]
    );
    const existingByPhone = new Map(existing.rows.map((r) => [r.phone, r]));

    // Which of these are already donors DRM knows - worth surfacing, because
    // "42 of these 300 have given before" changes how the calls are approached.
    const known = await pool.query(
      `SELECT right(regexp_replace(phone,'\\D','','g'), 10) AS p
         FROM people WHERE right(regexp_replace(phone,'\\D','','g'), 10) = ANY($1::text[])`,
      [unique.map((p) => p.phone)]
    );
    const knownPhones = new Set(known.rows.map((r) => r.p));

    const duplicates = unique.filter((p) => existingByPhone.has(p.phone));
    const fresh = unique.filter((p) => !existingByPhone.has(p.phone));

    res.json({
      total: parsed.length,
      columns_found: Object.keys(map),
      columns_ignored: header.filter((_, idx) => !Object.values(map).includes(idx)),
      counts: {
        new: fresh.length,
        duplicate: duplicates.length,
        repeated_in_file: repeatedInFile,
        invalid: invalid.length,
        blank: blank.length,
        already_donors: fresh.filter((p) => knownPhones.has(p.phone)).length,
        do_not_call: duplicates.filter((p) => existingByPhone.get(p.phone)?.do_not_call).length,
      },
      samples: {
        new: fresh.slice(0, 8),
        duplicate: duplicates.slice(0, 8).map((p) => ({ ...p, existing: existingByPhone.get(p.phone) })),
        invalid: invalid.slice(0, 8),
      },
      rows: fresh.concat(duplicates),
    });
  } catch (err) {
    console.error('crm.importPreview error:', err);
    res.status(500).json({ error: 'Could not read that file' });
  }
});

// POST /leads/import/commit - write what the preview showed.
//
// Takes the rows back from the client rather than re-parsing, so what is
// written is exactly what was shown. skip_duplicates defaults to false: the
// upsert fills gaps in an existing lead without overwriting anything a caller
// has learned, which is almost always what is wanted.
router.post('/leads/import/commit', authorize('admin', 'accountant'), async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'Nothing to import' });
  if (rows.length > 10000) return res.status(400).json({ error: 'That is more than 10,000 rows - split the file' });

  const listName = str(req.body?.list_name, 255) ?? 'Uploaded list';
  const assignedTo = str(req.body?.assigned_to, 36);
  const extraTags = Array.isArray(req.body?.tags) ? req.body.tags.map((t: unknown) => String(t).slice(0, 40)) : [];
  const skipDuplicates = req.body?.skip_duplicates === true;

  let added = 0;
  let updated = 0;
  let skipped = 0;
  const failures: { phone: string; error: string }[] = [];

  for (const r of rows) {
    const phone = normalizePhone(r.phone);
    if (!isDialable(phone)) { skipped++; continue; }
    try {
      const existing = skipDuplicates
        ? await pool.query(`SELECT 1 FROM leads WHERE phone = $1`, [phone])
        : { rowCount: 0 };
      if (existing.rowCount) { skipped++; continue; }

      const { lead, created } = await upsertLead(
        {
          phone,
          name: r.name,
          email: r.email,
          city: r.city,
          alt_phone: r.alt_phone,
          remarks: r.remarks,
          expected_amount: r.expected_amount,
          tags: [...(Array.isArray(r.tags) ? r.tags : []), ...extraTags],
          source: 'csv',
          source_detail: listName,
          assigned_to: assignedTo,
        },
        req.user?.userId ?? null
      );
      if (created) {
        added++;
        await pool.query(
          `INSERT INTO lead_activities (lead_id, user_id, kind, note) VALUES ($1,$2,'import',$3)`,
          [lead.id, req.user?.userId ?? null, `Imported from "${listName}"`]
        );
      } else updated++;
    } catch (err) {
      failures.push({ phone, error: err instanceof Error ? err.message.slice(0, 200) : 'Unknown' });
    }
  }

  res.json({ added, updated, skipped, failed: failures.length, failures: failures.slice(0, 20) });
});

async function exportLeadsCsv(req: import('express').Request, res: import('express').Response) {
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s =
      v instanceof Date
        ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')} ` +
          `${String(v.getHours()).padStart(2, '0')}:${String(v.getMinutes()).padStart(2, '0')}`
        : Array.isArray(v)
        ? v.join('; ')
        : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  try {
    const f = withScope(
      buildLeadFilters(req.query as Record<string, unknown>),
      await leadScopeFor(req.user)
    );
    const rows = await pool.query(
      `SELECT ${LEAD_COLUMNS} ${LEAD_JOINS} ${f.where} ORDER BY l.next_follow_up_at ASC NULLS LAST LIMIT 20000`,
      f.values
    );

    const cols: [string, string][] = [
      ['Name', 'name'], ['Phone', 'phone'], ['Email', 'email'], ['City', 'city'],
      ['Status', 'status_label'], ['Assigned to', 'assigned_to_name'], ['Source', 'source'],
      ['List', 'source_detail'], ['Tags', 'tags'], ['Attempts', 'call_attempts'],
      ['Last outcome', 'last_outcome'], ['Last contacted', 'last_contacted_at'],
      ['Follow-up due', 'next_follow_up_at'], ['Follow-up note', 'follow_up_note'],
      ['Expected amount', 'expected_amount'], ['Donated', 'converted_amount'],
      ['Given before (total)', 'total_donated'], ['Donations before', 'donation_count'],
      ['Remarks', 'remarks'], ['Added', 'created_at'],
    ];

    const csv = [
      cols.map((c) => c[0]).join(','),
      ...rows.rows.map((r) => cols.map((c) => cell(r[c[1]])).join(',')),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + csv);
  } catch (err) {
    console.error('crm.exportLeads error:', err);
    res.status(500).json({ error: 'Could not build that export' });
  }
}

/* ----------------------------------------------------------- calling queue */

/**
 * GET /queue - what to call next.
 *
 * The order is the whole product. A caller should never have to decide who to
 * ring, so this answers it: anything overdue first (a promise already broken),
 * then today's callbacks, then leads nobody has touched, then everything else
 * oldest-first. Closed stages, do-not-call and leads that have run out of
 * attempts are excluded.
 */
router.get('/queue', async (req, res) => {
  const limit = Math.min(100, Number(req.query.limit) || 25);
  const mine = req.query.mine !== 'false';
  const listId = String(req.query.list_id ?? '').trim();

  try {
    const attempts = await maxAttempts();

    // A list narrows the queue without changing its order. That separation is
    // the point: the caller chooses WHICH work, DRM still decides WHO is most
    // urgent within it, so choosing a list can never put an overdue promise
    // behind a stranger nobody has rung.
    const list = listId ? await loadList(listId) : null;
    if (listId && !list) return res.status(404).json({ error: 'That list is not available' });
    const pred = listPredicate(list, 4);

    const rows = await pool.query(
      `SELECT ${LEAD_COLUMNS} ${LEAD_JOINS}
        WHERE ${CALLABLE}
          AND l.call_attempts < $1
          AND ($2::uuid IS NULL OR l.assigned_to = $2::uuid OR l.assigned_to IS NULL)
          AND ${DUE_NOW}
          ${pred.sql}
        ORDER BY
          -- Overdue promises first, then today, then never-touched, then age.
          CASE WHEN l.next_follow_up_at < NOW() THEN 0
               WHEN l.next_follow_up_at IS NOT NULL THEN 1
               WHEN l.last_contacted_at IS NULL THEN 2
               ELSE 3 END,
          l.next_follow_up_at ASC NULLS LAST,
          l.created_at ASC
        LIMIT $3`,
      [attempts, mine ? req.user?.userId ?? null : null, limit, ...pred.values]
    );

    // How much of this list is left, counted the same way. Sent with the queue
    // so the caller's progress bar is a fact about the database rather than a
    // number the browser has been adding up since the page loaded - which is
    // what made it vanish on every refresh.
    const remaining = await pool.query(
      `SELECT COUNT(*)::int AS to_call ${LEAD_JOINS}
        WHERE ${CALLABLE}
          AND l.call_attempts < $1
          AND ($2::uuid IS NULL OR l.assigned_to = $2::uuid OR l.assigned_to IS NULL)
          AND ${DUE_NOW}
          ${listPredicate(list, 3).sql}`,
      [attempts, mine ? req.user?.userId ?? null : null, ...pred.values]
    );

    res.json({
      leads: rows.rows,
      to_call: remaining.rows[0].to_call,
      list: list ? { id: list.id, name: list.name } : null,
    });
  } catch (err) {
    console.error('crm.queue error:', err);
    res.status(500).json({ error: 'Could not load the calling queue' });
  }
});

/**
 * DELETE /activities/:id - undo a logged call.
 *
 * Restores the lead to the state captured in undo_payload when the call was
 * logged, removes the activity and the status-change row that came with it, and
 * deletes any reminder the same call created.
 *
 * Deliberately NOT a general "delete any activity": only a call, only one that
 * carries its own undo payload, and only within a short window. A CRM where
 * history can be quietly erased is one where nobody can trust a report - the
 * point here is fixing a slip in the seconds after it happens, not editing the
 * past.
 */
router.delete('/activities/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Your own call, and only yours. Without the user_id predicate a caller
    // could undo a colleague's just-logged call, rolling that lead's stage,
    // attempt count and callback date back inside the half hour the
    // leaderboard is counting - and an admin can still fix anything.
    const act = await client.query(
      `SELECT * FROM lead_activities
        WHERE id = $1 AND kind = 'call' AND undo_payload IS NOT NULL
          AND created_at > NOW() - INTERVAL '30 minutes'
          AND ($2::text = 'admin' OR user_id = $3::uuid)
        FOR UPDATE`,
      [req.params.id, req.user?.role ?? '', req.user?.userId ?? null]
    );
    if (!act.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Nothing to undo - that call is too old, was already undone, or was not yours.' });
    }

    const a = act.rows[0];
    const before = a.undo_payload as Record<string, unknown>;

    await client.query(
      `UPDATE leads SET
         status            = $1,
         call_attempts     = $2,
         last_contacted_at = $3,
         last_outcome      = $4,
         next_follow_up_at = $5,
         follow_up_note    = $6,
         do_not_call       = $7,
         remarks           = $8,
         -- A call that recorded a donation has to be undoable as one. Without
         -- these three, undoing "Donated now" left the lead converted with the
         -- money still on it while every other trace of the call was removed.
         converted_at      = $9::timestamptz,
         converted_amount  = $10::numeric,
         converted_via     = $11,
         updated_at        = NOW()
       WHERE id = $12`,
      [
        before.status,
        before.call_attempts,
        before.last_contacted_at,
        before.last_outcome,
        before.next_follow_up_at,
        before.follow_up_note,
        before.do_not_call,
        before.remarks,
        before.converted_at ?? null,
        before.converted_amount ?? null,
        before.converted_via ?? null,
        a.lead_id,
      ]
    );

    // The status change and the reminder were part of the same action, so they
    // go with it. Bounded to the second either side of the call rather than
    // "the latest", so an undo can never reach back past somebody else's work.
    await client.query(
      `DELETE FROM lead_activities
        WHERE lead_id = $1 AND kind IN ('status_change','reminder')
          AND created_at BETWEEN $2::timestamptz - INTERVAL '2 seconds'
                             AND $2::timestamptz + INTERVAL '2 seconds'`,
      [a.lead_id, a.created_at]
    );
    await client.query(
      `DELETE FROM lead_reminders
        WHERE lead_id = $1
          AND created_at BETWEEN $2::timestamptz - INTERVAL '2 seconds'
                             AND $2::timestamptz + INTERVAL '2 seconds'`,
      [a.lead_id, a.created_at]
    );
    // Take the call back off the session's tally, or the counter on the
    // caller's screen creeps upward every time somebody fixes a slip. GREATEST
    // guards the floor: a session whose counters were somehow already at zero
    // must not go negative and start showing "-1 calls".
    if (a.session_id) {
      await client.query(
        `UPDATE calling_sessions SET
           calls_logged = GREATEST(0, calls_logged - 1),
           connected    = GREATEST(0, connected - CASE WHEN $2 THEN 1 ELSE 0 END)
         WHERE id = $1`,
        [a.session_id, a.connected === true]
      );
    }

    await client.query(`DELETE FROM lead_activities WHERE id = $1`, [req.params.id]);

    await client.query('COMMIT');
    res.json({ undone: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('crm.undoCall error:', err);
    res.status(500).json({ error: 'Could not undo that call' });
  } finally {
    client.release();
  }
});

/* -------------------------------------------------- conversions */

/**
 * GET /conversions/unseen - "one of your leads donated".
 *
 * The missing half of automatic linking. Without it a lead quietly moves to
 * Donated and the caller who earned it never finds out, so it stays on their
 * mental list and they ring a donor who has already given - which is the most
 * embarrassing call a fundraising team can make.
 *
 * Scoped to the caller the lead was assigned to, plus unassigned ones, the same
 * rule the queue and the reminders use.
 */
router.get('/conversions/unseen', async (req, res) => {
  try {
    await reconcileConversions();
    const rows = await pool.query(
      `SELECT l.id, l.name, l.phone, l.converted_amount, l.converted_at, l.converted_via,
              d.purpose, d.source_site
         FROM leads l
         LEFT JOIN donations d ON l.converted_donation_id = d.id
        -- Any conversion the caller has not been told about, not only the
        -- ones with a receipt row. A QR payment an admin attributed, or cash
        -- somebody recorded, is exactly the news this alert exists to carry -
        -- and it could never fire for either.
        WHERE l.converted_at IS NOT NULL
          AND l.conversion_seen_at IS NULL
          AND (l.assigned_to = $1::uuid OR l.assigned_to IS NULL)
          -- Anything older than a fortnight is history, not news.
          AND l.converted_at > NOW() - INTERVAL '14 days'
        ORDER BY l.converted_at DESC LIMIT 20`,
      [req.user?.userId ?? null]
    );
    res.json({ conversions: rows.rows });
  } catch (err) {
    console.error('crm.unseenConversions error:', err);
    // Never an error banner over a caller's work; it retries on the next poll.
    res.json({ conversions: [] });
  }
});

router.post('/conversions/seen', async (req, res) => {
  // An empty list used to mean "every lead in the temple", because the
  // condition collapsed to `AND TRUE`. One request from any caller cleared
  // every colleague's unseen-donation notices.
  if (!Array.isArray(req.body?.ids) || !req.body.ids.length) {
    return res.status(400).json({ error: 'Which conversions have been seen?' });
  }
  const ids: string[] = (req.body.ids as string[]).slice(0, 500).map(String);
  try {
    await pool.query(
      `UPDATE leads SET conversion_seen_at = NOW()
        WHERE conversion_seen_at IS NULL AND id = ANY($1::uuid[])`,
      [ids]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('crm.markConversionsSeen error:', err);
    res.status(500).json({ error: 'Could not update those' });
  }
});

/**
 * POST /leads/:id/donated - the caller says money arrived.
 *
 * For giving DRM cannot see: cash at the counter, a bank transfer, a cheque
 * handed to a preacher. Recorded as 'manual' so the reports can separate what
 * the system observed from what a caller asserted - a distinction that matters
 * the moment anyone uses these numbers to judge a caller's work.
 *
 * Deliberately does NOT create a donation row. DRM's donations come from the
 * two sites, which issue the 80G receipts; inventing one here would produce a
 * donation with no receipt behind it and break the reconciliation against the
 * sites. The amount is recorded against the lead, and the real donation links
 * itself automatically when the site's own entry syncs across.
 */
router.post('/leads/:id/donated', async (req, res) => {
  const amount = num(req.body?.amount);
  if (amount === null || amount <= 0) return res.status(400).json({ error: 'How much did they give?' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query(`SELECT status FROM leads WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Lead not found' });
    }

    const result = await client.query(
      `UPDATE leads SET
         status             = 'converted',
         converted_amount   = $1::numeric,
         converted_at       = COALESCE($2::timestamptz, NOW()),
         converted_via      = 'manual',
         converted_note     = $3,
         conversion_seen_at = NOW(),
         next_follow_up_at  = NULL,
         updated_at         = NOW()
       WHERE id = $4 RETURNING *`,
      [amount, asDate(req.body?.at), str(req.body?.note, 1000), req.params.id]
    );

    await client.query(
      `INSERT INTO lead_activities (lead_id, user_id, kind, from_value, to_value, note)
       VALUES ($1,$2,'status_change',$3,'converted',$4)`,
      [
        req.params.id,
        req.user?.userId ?? null,
        before.rows[0].status,
        `Donated ${amount}${req.body?.note ? ` — ${String(req.body.note).slice(0, 200)}` : ''} (recorded by hand)`,
      ]
    );

    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('crm.markDonated error:', err);
    res.status(500).json({ error: 'Could not record that donation' });
  } finally {
    client.release();
  }
});

/* ------------------------------------------------- abandoned donations */

/**
 * POST /leads/sync-abandoned - turn unfinished donations into leads.
 *
 * Somebody filled in the form on annadan or the main site, reached the payment
 * screen and never came back. They are the strongest leads the temple has: the
 * decision to give was already made, and the usual reason it did not complete
 * is a UPI app that failed or a phone that rang, not a change of heart.
 *
 * THE RULE THAT MATTERS: never call someone who actually gave. Two ways that
 * could happen, and both are handled here rather than on the sites -
 *
 *   they retried and it worked   the site still holds the failed attempt, and
 *                                would hand it over forever. DRM has every
 *                                completed donation from BOTH sites, so it can
 *                                see the successful retry even when it happened
 *                                on the other site, which neither site can.
 *
 *   they gave later anyway       a donation any time after the abandoned attempt
 *                                means the conversation has moved on.
 *
 * Preview first (dry_run, the default), because how many of these exist is
 * unknown until you look and the answer might be four thousand.
 */
router.post('/leads/sync-abandoned', authorize('admin', 'accountant'), async (req, res) => {
  const b = req.body ?? {};
  const days = Math.min(365, Math.max(1, Number(b.days) || 30));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const minMinutes = Math.max(15, Number(b.min_minutes) || 60);
  const maxPages = 10;

  try {
    const sites = (Array.isArray(b.sites) && b.sites.length ? b.sites : ['hkmv', 'annadan']) as SiteKey[];

    // Pull from every configured site first, then decide. A site that isn't
    // set up is skipped rather than failing the whole sync - a temple running
    // only the main site should still be able to use this.
    const found: Record<string, unknown>[] = [];
    const siteErrors: { site: string; error: string }[] = [];

    for (const site of sites) {
      if (!isSiteConfigured(site)) continue;
      try {
        for (let page = 1; page <= maxPages; page++) {
          const result = await fetchAbandonedPage(site, { page, limit: 200, since, minMinutes });
          for (const d of result.donations) {
            const phone = normalizePhone(d.mobile);
            if (isDialable(phone)) {
              found.push({ ...d, phone });
            }
          }
          if (!result.hasMore) break;
        }
      } catch (err) {
        siteErrors.push({ site, error: err instanceof Error ? err.message : 'Unknown error' });
      }
    }

    // One row per person - someone who tried three times is one phone call, not
    // three. Keep the most recent attempt, which is the one worth mentioning.
    const byPhone = new Map<string, Record<string, unknown>>();
    for (const d of found) {
      const key = String(d.phone);
      const seen = byPhone.get(key);
      if (!seen || new Date(String(d.attemptedAt)) > new Date(String(seen.attemptedAt))) {
        byPhone.set(key, { ...d, attempts: Number(seen?.attempts ?? 0) + 1 });
      } else {
        seen.attempts = Number(seen.attempts ?? 1) + 1;
      }
    }
    const unique = [...byPhone.values()];

    if (!unique.length) {
      return res.json({ found: 0, gave_anyway: 0, already_leads: 0, would_add: 0, added: 0, site_errors: siteErrors });
    }

    const phones = unique.map((d) => String(d.phone));

    // Did they give anyway? Across both sites, at any point at or after the
    // attempt. This is the check the sites cannot do for themselves.
    const gave = await pool.query(
      `SELECT right(regexp_replace(p.phone,'\\D','','g'), 10) AS phone10, MAX(d.created_at) AS last_gift
         FROM people p JOIN donations d ON d.person_id = p.id
        WHERE right(regexp_replace(p.phone,'\\D','','g'), 10) = ANY($1::text[])
        GROUP BY 1`,
      [phones]
    );
    const lastGiftByPhone = new Map(gave.rows.map((r) => [r.phone10, new Date(r.last_gift)]));

    const recovered = unique.filter((d) => {
      const last = lastGiftByPhone.get(String(d.phone));
      return last !== undefined && last >= new Date(String(d.attemptedAt));
    });
    const recoveredPhones = new Set(recovered.map((d) => String(d.phone)));
    const stillOwed = unique.filter((d) => !recoveredPhones.has(String(d.phone)));

    const existing = await pool.query(`SELECT phone FROM leads WHERE phone = ANY($1::text[])`, [
      stillOwed.map((d) => String(d.phone)),
    ]);
    const existingPhones = new Set(existing.rows.map((r) => r.phone));
    const fresh = stillOwed.filter((d) => !existingPhones.has(String(d.phone)));

    if (b.dry_run !== false) {
      return res.json({
        found: unique.length,
        gave_anyway: recovered.length,
        already_leads: stillOwed.length - fresh.length,
        would_add: fresh.length,
        // Worth showing: the money that walked away is what justifies the calls.
        value_at_stake: fresh.reduce((sum, d) => sum + (Number(d.amount) || 0), 0),
        sample: fresh.slice(0, 10).map((d) => ({
          name: d.name,
          phone: d.phone,
          amount: d.amount,
          purpose: d.purpose,
          page: d.sourcePage,
          attemptedAt: d.attemptedAt,
          site: d.sourceSite,
        })),
        site_errors: siteErrors,
      });
    }

    let added = 0;
    let updated = 0;
    for (const d of stillOwed) {
      try {
        const { lead, created } = await upsertLead(
          {
            phone: d.phone,
            name: d.name,
            email: d.email,
            source: 'website',
            // The page tells the caller what the conversation is about, which
            // is most of what they need before dialling.
            source_detail: `Unfinished donation${d.sourcePage ? ` on ${d.sourcePage}` : ''}`,
            source_site: d.sourceSite,
            // What they tried to give is the natural ask when calling back.
            expected_amount: d.amount,
            assigned_to: b.assigned_to,
            tags: ['abandoned', ...(Array.isArray(b.tags) ? b.tags : [])],
          },
          req.user?.userId ?? null
        );
        if (created) {
          added++;
          await pool.query(
            `INSERT INTO lead_activities (lead_id, user_id, kind, note, occurred_at)
             VALUES ($1,$2,'import',$3,$4)`,
            [
              lead.id,
              req.user?.userId ?? null,
              `Started a donation of ${d.amount ?? '?'}${d.purpose ? ` for ${d.purpose}` : ''} and did not complete it` +
                (Number(d.attempts) > 1 ? ` (${d.attempts} attempts)` : ''),
              d.attemptedAt,
            ]
          );
        } else updated++;
      } catch (err) {
        console.error('crm.syncAbandoned upsert error:', err);
      }
    }

    res.json({
      found: unique.length,
      gave_anyway: recovered.length,
      added,
      already_leads: updated,
      site_errors: siteErrors,
    });
  } catch (err) {
    console.error('crm.syncAbandoned error:', err);
    res.status(500).json({ error: 'Could not fetch unfinished donations from the sites' });
  }
});

export default router;
export { reconcileConversions, normalizePhone as normalizeLeadPhone, isDialable };
