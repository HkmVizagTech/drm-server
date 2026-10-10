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
import { fetchAbandonedPage, isSiteConfigured, type SiteKey, type AbandonedDonation } from '../services/hkmvClient';
import { gaveSinceSql } from '../services/gaveSince';
import { PENDING_GRACE_MINUTES } from '../services/nearlyGaveWatch';
import { buildWorkbook } from '../utils/spreadsheet';
import { parseDate, istDate } from '../bootTimezone';
import { recordCredit } from '../services/credits';
import { leadMoneyState, rupees } from '../services/leadMoney';
import {
  sendExport, formatFrom, describeFilters, EXPORT_ROW_CAP, type ExportFormat,
} from '../utils/export';
// The queue's filter lives with the lists it belongs to, so a change to what
// counts as callable changes the queue and every list's count together.
import { CALLABLE, DUE_NOW, FROM_DONATIONS_PAGE, LIST_MATCH, NOT_CLAIMED_BY_OTHERS, listPredicate, loadList, maxAttempts } from './crmLists';

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

// Bare dates resolve to midnight in India rather than UTC - see parseDate.
const asDate = parseDate;

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
     RETURNING l.id, l.assigned_to, l.person_id, f.donation_id, f.amount, f.created_at`
  );

  /* CREDIT THE CALLER WHOSE LEAD IT WAS.
   *
   * Written here, at the moment the match is made, rather than read back out
   * of leads.assigned_to whenever a report runs. That is the whole difference:
   * the credit records who was working this lead when the money arrived, and
   * stays true afterwards even if the lead is reassigned, bulk-moved, or the
   * caller leaves.
   *
   * occurred_at is the donation's own date, not now. A sync that catches up a
   * week of donations must credit each one on the day it arrived, or Monday
   * swallows the whole week and the four days before it read as empty.
   */
  for (const row of result.rows) {
    if (!row.assigned_to || !Number(row.amount)) continue;
    await recordCredit({
      userId: row.assigned_to,
      amount: row.amount,
      kind: 'lead',
      occurredAt: row.created_at,
      leadId: row.id,
      donationId: row.donation_id,
      personId: row.person_id,
      note: 'Donated on the site after being called',
    }).catch((e) =>
      // Never take the conversion down with the bookkeeping. The lead is
      // already marked converted; a missing credit is a figure to repair, a
      // thrown error here would undo a match DRM had correctly made.
      console.error('crm.reconcileConversions credit failed:', (e as Error).message)
    );
  }

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
    res.status(500).json({ error: 'Could not save call result.' });
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
  p.total_donated, p.donation_count, p.last_donation_at,
  -- Who rang them last, so a list or a search can say "you called" or
  -- "Ravi called" next to the colour for where they are.
  lc.last_caller_id, lc.last_caller_name,
  ld.label AS last_outcome_label,
  -- How the calls went, beside call_attempts (which counts every call): the
  -- ones nobody picked up, and the ones where THEY rang the temple back.
  (SELECT COUNT(*)::int FROM lead_activities ca
    WHERE ca.lead_id = l.id AND ca.kind = 'call' AND ca.connected IS FALSE) AS calls_missed,
  (SELECT COUNT(*)::int FROM lead_activities ca
    WHERE ca.lead_id = l.id AND ca.kind = 'call' AND ca.direction = 'inbound') AS calls_in`;

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
  ) p ON l.person_id IS NOT NULL
  LEFT JOIN LATERAL (
    SELECT a.user_id AS last_caller_id, cu.name AS last_caller_name
      FROM lead_activities a LEFT JOIN users cu ON cu.id = a.user_id
     WHERE a.lead_id = l.id AND a.kind = 'call'
     ORDER BY a.occurred_at DESC LIMIT 1
  ) lc ON TRUE
  LEFT JOIN crm_dispositions ld ON ld.slug = l.last_outcome`;

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

/**
 * "Due to call now" is a question about the person asking: the list card's
 * figure is their share, so "See them" has to be too - theirs or nobody's.
 */
function callableScope(q: Record<string, unknown>, user?: { userId?: string }): string | null {
  return q.callable === 'true' ? user?.userId ?? null : null;
}

/** The SQL that narrows to one caller, appended to a built filter. */
function withScope(f: Filters, scope: string | null): Filters {
  if (!scope) return f;
  const clause = `(l.assigned_to = $${f.next}::uuid OR l.assigned_to IS NULL OR l.assigned_to IN (SELECT id FROM users WHERE role <> 'caller'))`;
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
    conditions.push(`EXISTS (SELECT 1 FROM calling_lists cl WHERE cl.id = $${i}::uuid AND ${LIST_MATCH('cl', 'l')})`);
    values.push(String(q.list));
    i++;
  }
  // "Due" for a calling list's "See them": exactly what a session on it would
  // hand over (callable, attempts left, due by the end of today).
  // The viewer's own share (theirs or nobody's) is added by the handlers,
  // which know who is asking; see callableScope.
  if (q.callable === 'true') {
    conditions.push(`${CALLABLE} AND ${DUE_NOW}
      AND l.call_attempts < COALESCE((SELECT (value #>> '{}')::int FROM crm_settings WHERE key = 'max_attempts'), 6)`);
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
  // Dates, so a tile on the overview opens exactly the leads it counted:
  // "added this month", "gave this month". The same day boundaries as the
  // dashboard's own window, so the list and the number agree.
  const day = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null);
  for (const [key, col] of [['added', 'l.created_at'], ['converted', 'l.converted_at']] as const) {
    const from = day(q[`${key}_from`]);
    const to = day(q[`${key}_to`]);
    if (from) {
      conditions.push(`${col} >= $${i++}::date`);
      values.push(from);
    }
    if (to) {
      conditions.push(`${col} < ($${i++}::date + INTERVAL '1 day')`);
      values.push(to);
    }
  }
  // Where the calling has got to with them. "me" needs the caller's id, so it
  // arrives as called_by=<user id>.
  if (q.called) {
    const c = String(q.called);
    if (c === 'never') conditions.push(`l.last_contacted_at IS NULL`);
    else if (c === 'today') conditions.push(`l.last_contacted_at >= date_trunc('day', NOW())`);
    else if (c === 'week') conditions.push(`l.last_contacted_at >= NOW() - INTERVAL '7 days'`);
    else if (c === 'called') conditions.push(`l.last_contacted_at IS NOT NULL`);
    else if (c === 'not_today' || c === 'no_answer') conditions.push(callFilterSql(c, 'l')!);
  }
  if (q.called_by && /^[0-9a-f-]{36}$/i.test(String(q.called_by))) {
    conditions.push(`EXISTS (SELECT 1 FROM lead_activities ca WHERE ca.lead_id = l.id AND ca.kind = 'call' AND ca.user_id = $${i++}::uuid)`);
    values.push(String(q.called_by));
  }
  // Still being worked: an open stage, and not "do not call" - the overview's
  // "Hoped for" counts exactly these.
  if (q.open === 'true') {
    conditions.push(`l.do_not_call = FALSE
      AND NOT EXISTS (SELECT 1 FROM crm_statuses os WHERE os.slug = l.status AND os.is_open = FALSE)`);
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
//
// THE PREACHER ID COLUMN IS HERE BECAUSE THE SAMPLE IS THE DOCUMENTATION.
//
// The importer has understood "Preacher ID" (and "Enrolled by ID", "DCC ID",
// "Counsellor ID", "Sevak ID") for a while, and it is what makes the donation
// receipt say "enrolled by" the right person. But it was missing from this
// sample - and a column nobody is shown is a column nobody fills in. Every
// sheet uploaded in that period lost the attribution silently.
//
// Blank in the third row on purpose: it is optional, and leaving one row empty
// says that more clearly than a sentence somewhere else would. A sheet with no
// preacher id falls back to the site's default, same as HKMV does.
const LEAD_SAMPLE_ROWS = [
  ['Name', 'Mobile Number', 'Email', 'City', 'Preacher ID', 'Enrolled By', 'Remarks', 'Expected Amount', 'Tags'],
  ['Radha Krishna Das', '9876543210', 'radha@example.com', 'Visakhapatnam', '1042', 'Hari Priya Das', 'Gave at Janmashtami last year', '5000', 'janmashtami;lapsed'],
  ['Sita Devi', '9812345678', '', 'Hyderabad', '1042', 'Hari Priya Das', 'Met at the Gita stall', '1100', 'gita-stall'],
  ['Gopal Rao', '9700011122', 'gopal@example.com', 'Vizag', '', '', 'Asked to be called after Diwali', '', 'diwali'],
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
    res.status(500).json({ error: 'Could not download sample file.' });
  }
});

// The list on screen, as a file. Honours every filter, for the same reason the
// import does: staff must never be able to export rows the screen cannot show.
// Both extensions answer the same handler; ?format=xlsx also works, so the
// client can offer a CSV/Excel choice without knowing two paths.
// The extension picks the format, and ?format=xlsx picks it too, so the client
// can offer a CSV/Excel choice from one path. The format is passed as an
// argument rather than written back onto req.query, because in Express 5
// req.query is a getter and assigning to it throws.
router.get('/leads/export.csv', (req, res) => exportLeadsFile(req, res, 'csv'));
router.get('/leads/export.xlsx', (req, res) => exportLeadsFile(req, res, 'xlsx'));

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
/**
 * Store one unfinished donation from a site. False when it cannot be used (no
 * number to ring, no id to key on, no date). Shared by the full sync behind
 * the Nearly gave screen and the quick poll that raises notifications.
 */
export async function storeAbandonedAttempt(site: SiteKey, d: AbandonedDonation): Promise<boolean> {
  const phone = normalizePhone(d.mobile);
  const externalId = String(d.externalId ?? '').trim();
  if (!isDialable(phone) || !externalId || !d.attemptedAt) return false;
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
      externalId.slice(0, 80),
      phone,
      cut(d.name, 255),
      cut(d.email, 255),
      d.amount ?? null,
      // The sites' seva names and page URLs are free text and overrun
      // these columns. Unclipped, one 270-character festival name
      // threw mid-crawl and cost every page after it.
      cut(d.purpose, 255),
      cut(d.sourcePage, 255),
      cut(d.status, 20),
      d.attemptedAt,
    ]
  );
  return true;
}

async function syncAbandoned(
  sites: SiteKey[],
  opts: { days?: number; minMinutes?: number } = {}
): Promise<{ site: string; seen: number; error: string | null }[]> {
  const days = Math.min(365, Math.max(1, opts.days ?? 90));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  // Pending ones from five minutes old - the site has sent its WhatsApp
  // reminder at three, and a donor still not done by five is worth a call.
  const minMinutes = Math.max(3, opts.minMinutes ?? PENDING_GRACE_MINUTES);
  const results: {
    site: string;
    seen: number;
    skipped?: number;
    truncated?: boolean;
    /** Another request was already crawling this site; nothing was fetched. */
    alreadyRunning?: boolean;
    error: string | null;
  }[] = [];

  for (const site of sites) {
    if (!isSiteConfigured(site)) {
      const error = 'Not connected.';
      // Not marked as checked: it was not. Only the reason is recorded, so a
      // site that is simply not connected does not also claim a timestamp.
      await pool.query(
        `INSERT INTO abandoned_sync_state (source_site, last_error)
         VALUES ($1, $2)
         ON CONFLICT (source_site) DO UPDATE SET last_error = $2, running_since = NULL`,
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
       RETURNING source_site, running_since`,
      [site]
    );
    if (!claim.rows.length) {
      // Somebody else is already doing it. Reported as such rather than as a
      // sync that found nothing, so "Checked just now" is never shown for a
      // site nobody contacted.
      results.push({ site, seen: 0, error: null, alreadyRunning: true });
      continue;
    }
    // The token this run holds. The release is guarded on it, so a crawl that
    // hangs past the five-minute escape hatch and then finishes cannot clear a
    // newer run's claim or overwrite its result.
    const token = claim.rows[0].running_since as string;

    let seen = 0;
    let skipped = 0;
    let truncated = false;
    let error: string | null = null;
    try {
      for (let page = 1; page <= MAX_ABANDONED_PAGES; page++) {
        const result = await fetchAbandonedPage(site, { page, limit: 200, since, minMinutes });
        for (const d of result.donations) {
          // No number to ring, no id to key on, or no date to place it: all
          // three make the row unusable. Counted, because a silent drop is how
          // "the site has 2,000 and DRM shows 1,870" becomes unexplainable.
          if (await storeAbandonedAttempt(site, d)) seen++;
          else skipped++;
        }
        if (!result.hasMore) break;
        // Still more to come and this was the last page we will ask for. The
        // figure that follows is a floor, not a total, and saying so is the
        // difference between a number somebody can act on and one they cannot.
        if (page === MAX_ABANDONED_PAGES) truncated = true;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Unknown error';
    }

    // Released only if this run still holds the claim, and - the important
    // part - last_synced_at and synced_days move ONLY on success. A site that
    // fails every time used to mark itself freshly checked, which both hid the
    // staleness and blocked retries for half an hour.
    await pool.query(
      `UPDATE abandoned_sync_state SET
         last_synced_at = CASE WHEN $2::text IS NULL THEN NOW() ELSE last_synced_at END,
         synced_days    = CASE WHEN $2::text IS NULL THEN $4::int ELSE synced_days END,
         last_error     = $2,
         rows_seen      = $3,
         rows_skipped   = $5::int,
         truncated      = $6::boolean,
         running_since  = NULL
       WHERE source_site = $1 AND running_since = $7::timestamptz`,
      [site, error, seen, days, skipped, truncated, token]
    );
    results.push({ site, seen, skipped, truncated, error });
  }

  return results;
}

/** How stale the copy may get before a read quietly refreshes it. */
const ABANDONED_STALE_MINUTES = 30;

/**
 * How many pages of 200 to crawl per site.
 *
 * Was ten. A first sync against a site holding 4,800 attempts stored the
 * newest 2,000 and reported success, so the backfill was short by thousands of
 * people and nothing said so. Raised, and the state now records when the
 * ceiling was actually hit.
 */
const MAX_ABANDONED_PAGES = 40;

/**
 * "Was their last call unanswered?" for a lead aliased `ld` - the latest call
 * logged to them did not connect. Shared by Leads and Nearly gave.
 */
const LAST_CALL_UNANSWERED = (ld: string) => `(SELECT lc.connected IS FALSE FROM lead_activities lc
   WHERE lc.lead_id = ${ld}.id AND lc.kind = 'call' ORDER BY lc.occurred_at DESC LIMIT 1)`;

/**
 * The caller's quick filter, the same words on Leads and Nearly gave:
 * called today, not called today (including never), or last call not answered.
 * `ld` is the lead's alias; somebody with no lead has never been called.
 */
function callFilterSql(called: unknown, ld: string): string | null {
  const c = String(called ?? '');
  if (c === 'today') return `${ld}.last_contacted_at >= date_trunc('day', NOW())`;
  if (c === 'not_today') return `(${ld}.last_contacted_at IS NULL OR ${ld}.last_contacted_at < date_trunc('day', NOW()))`;
  if (c === 'no_answer') return `${LAST_CALL_UNANSWERED(ld)} IS TRUE`;
  return null;
}

/** Clip to a column width. The sites' free text overruns these regularly. */
const cut = (v: unknown, n: number): string | null => {
  const t = String(v ?? '').trim();
  return t ? t.slice(0, n) : null;
};
/**
 * The "nearly gave" query, built once and used by both the screen and the
 * download.
 *
 * EXTRACTED SO THE EXPORT CANNOT DRIFT. This logic lived inside the list
 * handler, which meant an export would have had to re-derive it - and a
 * re-derived filter is a filter that will disagree with the screen the first
 * time somebody adds a condition to one and not the other. The person who
 * downloads a list and acts on it is the one who pays for that.
 */
function buildAbandonedQuery(
  q: Record<string, unknown>,
  wanted: SiteKey[],
  viewDays: number
): { base: string; values: unknown[]; order: string } {
  /* ------------------------------------------------------------ filters
   *
   * TWO GROUPS, AND THE ORDER MATTERS
   *
   * `scope` decides which attempts exist at all for this view - the sites
   * chosen, the period, anybody set aside. `narrow` is what the caller is
   * looking for within that: an amount band, an outcome, a name.
   *
   * The scope filters run BEFORE one-row-per-person is picked; the narrowing
   * ones run after. Mixing them meant the amount filter changed WHICH
   * attempt represented each person: a donor who tried ₹25,000 in September
   * and ₹500 last week was represented by the ₹500 row unfiltered, and by
   * the ₹25,000 row the moment you asked for "at least ₹1,000". Narrowing
   * the filter made the headline figure fifty times larger, and neither
   * number was wrong on its own terms - which is the worst kind.
   */
  const scope: string[] = [];
  const narrow: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  // Set aside is per PERSON. Dismissing one of somebody's four attempts used
  // to promote the next one into the list on the following load, taking the
  // value at stake up rather than down.
  //
  // But only the attempts up to when they were set aside. It used to hide the
  // phone for ever, so somebody set aside in March who tried again in
  // October - a new, warm attempt - never appeared, and nothing said why.
  //
  // `set_aside=true` turns the view round: only the people set aside, so the
  // decision can be seen and undone.
  const setAsideRule = `EXISTS (
    SELECT 1 FROM abandoned_attempts d
     WHERE d.phone = a.phone AND d.dismissed_at IS NOT NULL
       AND a.attempted_at <= d.dismissed_at
  )`;
  scope.push(q.set_aside === 'true' ? setAsideRule : `NOT ${setAsideRule}`);

  scope.push(`a.source_site = ANY($${i++}::text[])`);
  scope.push(`NOT ${FROM_DONATIONS_PAGE('a')}`);
  values.push(wanted);

  // How long ago they tried. Days rather than a date range, because the
  // question a caller asks is "who nearly gave this week".
  scope.push(`a.attempted_at >= NOW() - ($${i++} || ' days')::interval`);
  values.push(String(viewDays));

  // A failed payment is shown at once. One still pending is left alone for
  // five minutes, while the donor may still be on the payment page.
  scope.push(`(a.status = 'failed' OR a.attempted_at <= NOW() - INTERVAL '${PENDING_GRACE_MINUTES} minutes')`);

  /* An explicit date range, which NARROWS the `days` window rather than
     replacing it.

     Both, not one or the other: `days` also decides how far back the sites are
     crawled, so a range outside it would ask the database for rows nothing has
     ever fetched and report an honest-looking zero. Picking a range the sync
     has not reached is a question DRM cannot answer, and the screen widens the
     period rather than pretending otherwise.

     Resolved in IST because the session is (db/pool.ts) - "15 September" means
     midnight to midnight in India. The upper bound adds a day rather than
     using <=, so the whole of the end date is included; a bare <= on a
     timestamp silently means "up to 00:00 on that morning" and drops the day
     the person actually chose. */
  if (q.from_date) {
    scope.push(`a.attempted_at >= $${i++}::date`);
    values.push(String(q.from_date));
  }
  if (q.to_date) {
    scope.push(`a.attempted_at < ($${i++}::date + INTERVAL '1 day')`);
    values.push(String(q.to_date));
  }

  // Guarded against NaN: a non-numeric min_amount used to reach Postgres as
  // 'NaN'::numeric, which sorts above every number, so the endpoint answered
  // 200 with no rows and zero at stake rather than an error.
  const minAmount = Number(q.min_amount);
  if (q.min_amount !== undefined && Number.isFinite(minAmount)) {
    narrow.push(`l.amount >= $${i++}::numeric`);
    values.push(minAmount);
  }
  const maxAmount = Number(q.max_amount);
  if (q.max_amount !== undefined && Number.isFinite(maxAmount)) {
    narrow.push(`l.amount <= $${i++}::numeric`);
    values.push(maxAmount);
  }
  if (q.status) {
    narrow.push(`l.status = ANY($${i++}::text[])`);
    values.push(String(q.status).split(',').filter(Boolean));
  }
  // Called today / not called today / last call not answered.
  const callWhere = callFilterSql(q.called, 'ld');
  if (callWhere) narrow.push(callWhere);
  if (q.search) {
    narrow.push(`(l.name ILIKE $${i} OR l.phone ILIKE $${i} OR l.email ILIKE $${i})`);
    values.push(`%${String(q.search).trim()}%`);
    i++;
  }

  // Aliased to the OUTER query, which selects from the CTE as `l`. Using
  // `a.` here referenced the inner alias and failed with "missing FROM-clause
  // entry" - a whitelisted ORDER BY is still SQL that has to parse.
  const SORTS: Record<string, string> = {
    /* THE ONE A SHIFT ACTUALLY STARTS FROM: nobody has rung them yet, newest
       first.

       "Recent" alone buries the useful rows. A list sorted purely by when
       somebody tried mixes the twenty people a caller already spoke to
       yesterday in among the ones nobody has touched, so the work of finding
       the next real call is done by eye, on every page, for ever.

       `IS NULL DESC` puts the never-contacted first because in Postgres true
       sorts after false, so DESC brings true up. Ties fall back to the newest
       attempt, which is the same order "recent" gives. */
    uncalled: '(l.lead_last_contacted_at IS NULL) DESC, l.attempted_at DESC',
    recent: 'l.attempted_at DESC',
    oldest: 'l.attempted_at ASC',
    amount: 'l.amount DESC NULLS LAST',
    attempts: 'l.attempts DESC, l.attempted_at DESC',
  };
  /* Default stays `recent`, NOT `uncalled`.

     This endpoint is read by more than the screen in front of us - the export
     and "add all matching" build the same query - and silently reordering what
     a caller downloads is not this change's business. The screen asks for
     `uncalled` explicitly. */
  const order = SORTS[String(q.sort ?? '')] ?? SORTS.recent;

  // One row per person: somebody who tried four times is one phone call.
  // The row kept is their most recent attempt, which is the one worth
  // mentioning when the phone is answered.
  //
  // THE TOTALS ARE COMPUTED IN SQL, OVER EVERYTHING
  //
  // They used to be summed in JavaScript over the rows this query returned -
  // which is capped at 500. So on a list longer than that, "value at stake"
  // silently reported the value of the first five hundred people and nothing
  // else. The figure dropped from about twelve lakhs to seven the moment the
  // page started reading a stored copy, and the money had not gone anywhere:
  // the old version fetched the sites live with no cap, and the new one was
  // adding up a page of the answer and calling it the answer.
  //
  // A total and a page are different questions. The page is capped because
  // nobody scrolls five hundred rows; the total must not be, because it is
  // what decides whether the list is worth a shift.
  const base = `
    WITH in_scope AS (
      SELECT a.* FROM abandoned_attempts a
       WHERE ${scope.join(' AND ')}
    ),
    latest AS (
      SELECT DISTINCT ON (a.phone) a.*,
             -- How many times THIS person tried, within the period and the
             -- sites being looked at. The stored column counts every attempt
             -- ever, across both sites and including dismissed ones, so a
             -- "Today, annadan only" view was showing "tried 7 times" for
             -- somebody who tried once today.
             COUNT(*) OVER (PARTITION BY a.phone)::int AS attempts_in_view
        FROM in_scope a
       ORDER BY a.phone, a.attempted_at DESC
    ),
    resolved AS (
      SELECT l.*,
             -- Did they give anyway? Same mobile, a lead marked as donated,
             -- or the same name within a day - see services/gaveSince.ts.
             ${gaveSinceSql('l')} AS gave_anyway,
             -- Rung since they tried (kept for the export and the counts;
             -- anyone who has paid leaves the list, called or not).
             (ld.last_contacted_at IS NOT NULL AND ld.last_contacted_at >= l.attempted_at) AS called_since,
             -- For the quick filter's counts.
             COALESCE(ld.last_contacted_at >= date_trunc('day', NOW()), FALSE) AS called_today,
             COALESCE(${LAST_CALL_UNANSWERED('ld')}, FALSE) AS last_unanswered,
             ld.id AS lead_id,
             ld.status AS lead_status,
             -- So the screen can say "do not call" and hide the Call button,
             -- and know whether the lead is somebody else's before offering
             -- to open it.
             ld.do_not_call AS lead_do_not_call,
             ld.assigned_to AS lead_assigned_to,
             ld.last_outcome AS lead_last_outcome,
             ld.last_contacted_at AS lead_last_contacted_at,
             -- How many times they have been rung, how many went unanswered,
             -- and how many times they rang back.
             ld.call_attempts AS lead_call_attempts,
             (SELECT COUNT(*)::int FROM lead_activities ca
               WHERE ca.lead_id = ld.id AND ca.kind = 'call' AND ca.connected IS FALSE) AS lead_calls_missed,
             (SELECT COUNT(*)::int FROM lead_activities ca
               WHERE ca.lead_id = ld.id AND ca.kind = 'call' AND ca.direction = 'inbound') AS lead_calls_in,
             (SELECT MAX(d.dismissed_at) FROM abandoned_attempts d WHERE d.phone = l.phone) AS set_aside_at,
             u.name AS assigned_to_name,
             -- Whether the lead is with somebody who makes calls. A lead an
             -- admin added for themselves is parked, not being worked, and a
             -- caller may take it over; a fellow caller's lead stays theirs.
             (u.role = 'caller') AS lead_owner_calls
        FROM latest l
        LEFT JOIN leads ld ON ld.phone = l.phone
        LEFT JOIN users u ON ld.assigned_to = u.id
        ${narrow.length ? `WHERE ${narrow.join(' AND ')}` : ''}
    )`;
  return { base, values, order };
}



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

    // How far back this view is asking. The sync has to cover at least that,
    // or the screen quietly shows a year's filter over ninety days of data and
    // reports a total for a period it never actually fetched.
    const viewDays = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const syncDays = Math.max(90, viewDays);

    const stale = wanted.filter((site) => {
      const r = byState.get(site);
      if (!r || !r.last_synced_at) return true;
      // Old in TIME, or short in REACH. The second half is the one that bit:
      // a sync for ninety days three minutes ago made a year's view look fresh
      // while answering it out of a quarter of the data, and pressing "Check
      // the sites now" only reset the clock on the same ninety days.
      if ((r.synced_days ?? 0) < viewDays) return true;
      return Date.now() - new Date(r.last_synced_at).getTime() > ABANDONED_STALE_MINUTES * 60_000;
    });

    // A site DRM has never asked is a different situation from a stale one. A
    // stale copy is yesterday's answer, which is worth showing while today's
    // is fetched; no copy at all is no answer, and returning a confident zero
    // while a sync runs in the background is how a screen tells somebody there
    // is nothing to ring when there are four thousand people.
    const never = wanted.filter((site) => !byState.get(site)?.last_synced_at);

    // Never awaited unless the caller asked for fresh data, or there is no
    // data at all. The page is for reading, and reading must not block on
    // somebody else's Mongo when there is something to read.
    if (req.query.fresh === 'true' || never.length) {
      await syncAbandoned(req.query.fresh === 'true' ? wanted : never, { days: syncDays });
      // Re-read, because the state above was captured before that ran. Without
      // this the one request that definitely has fresh information reports the
      // state from before it - including saying a site is fine when the sync
      // just discovered it is not connected, or "not checked yet" for a site
      // it has this second finished checking.
      const after = await pool.query(
        `SELECT source_site, last_synced_at, last_error, running_since FROM abandoned_sync_state`
      );
      byState.clear();
      for (const row of after.rows) byState.set(row.source_site, row);
    } else if (stale.length) {
      void syncAbandoned(stale, { days: syncDays }).catch((e) =>
        console.error('crm.syncAbandoned background error:', (e as Error).message)
      );
    }

    const q = req.query as Record<string, unknown>;
    const built = buildAbandonedQuery(q, wanted, viewDays);
    const { base, values, order } = built;

    /* PAGINATION, ADDED WITHOUT CHANGING WHAT AN OLD CALLER GETS.

       This used to be a bare LIMIT 500. On thirty days of two sites that is
       five hundred rows of joins and EXISTS subqueries assembled on every
       load, for a screen nobody scrolls past the first twenty of - which is
       why the list took seconds to open.

       The defaults are chosen so that a request with no page or limit behaves
       EXACTLY as it did: page 1, limit 500, offset 0. The export and
       "add all matching" build their queries from the same helper and pass
       neither, so they are untouched. Only a caller that asks for a page gets
       one.

       `limit` is clamped rather than trusted: ?limit=100000 would hand back
       the whole table and undo the point of the change, and ?limit=0 would
       return an empty page that reads as "nobody to call". */
    const pageNo = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(500, Math.max(1, Number(req.query.limit) || 500));
    const offset = (pageNo - 1) * perPage;

    // How many sit behind each quick filter - worked out without that filter,
    // so the numbers on the buttons do not change as you switch between them.
    //
    // Deliberately NOT paged: these are counts over everything the other
    // filters match, and a count of one page is not a count.
    const unfiltered = buildAbandonedQuery({ ...q, called: undefined }, wanted, viewDays);
    const [page, totals, callCounts] = await Promise.all([
      pool.query(
        `${base}
         SELECT * FROM resolved l
          ${req.query.include_settled === 'true' ? '' : 'WHERE NOT gave_anyway'}
          ORDER BY ${order}
          LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, perPage, offset]
      ),
      pool.query(
        `${base}
         SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE NOT gave_anyway)::int AS open,
                COUNT(*) FILTER (WHERE gave_anyway)::int AS gave_anyway,
                COUNT(*) FILTER (WHERE gave_anyway AND called_since)::int AS paid_after_call,
                COUNT(*) FILTER (WHERE NOT gave_anyway AND lead_id IS NOT NULL)::int AS already_leads,
                COALESCE(SUM(amount) FILTER (WHERE NOT gave_anyway), 0)::numeric AS value_at_stake
           FROM resolved`,
        values
      ),
      pool.query(
        `${unfiltered.base}
         SELECT COUNT(*) FILTER (WHERE NOT gave_anyway)::int AS "all",
                COUNT(*) FILTER (WHERE NOT gave_anyway AND NOT called_today)::int AS not_today,
                COUNT(*) FILTER (WHERE NOT gave_anyway AND called_today)::int AS today,
                COUNT(*) FILTER (WHERE NOT gave_anyway AND last_unanswered)::int AS no_answer
           FROM resolved`,
        unfiltered.values
      ),
    ]);

    const t = totals.rows[0];

    // How many rows the filters match, which is what the pager counts through.
    // `open` when settled donors are hidden, `total` when they are shown -
    // the same number the list is actually paging over, or the last page is
    // computed from a count the query never returns.
    const matching = req.query.include_settled === 'true' ? t.total : t.open;

    res.json({
      rows: page.rows,
      // Compared against the real total, not the page length: at exactly 500
      // the old form said "showing the first 500 of 500".
      complete: page.rows.length >= matching,
      // Pagination. Additive - a client that ignores these reads `rows` as
      // before, because without a page parameter `rows` IS the old answer.
      page: pageNo,
      limit: perPage,
      total_pages: Math.max(1, Math.ceil(matching / perPage)),
      matching,
      total: t.total,
      open: t.open,
      gave_anyway: t.gave_anyway,
      // Paid after a caller rang them (they leave the list like anyone who paid).
      paid_after_call: t.paid_after_call,
      call_counts: callCounts.rows[0],
      already_leads: t.already_leads,
      // What walked away, over everybody still worth ringing - not over the
      // page. This is the number that decides whether the list is worth a
      // shift, so it has to cover the whole shift.
      value_at_stake: Number(t.value_at_stake),
      sites: wanted.map((site) => {
        const r = byState.get(site);
        return {
          site,
          last_synced_at: r?.last_synced_at ?? null,
          synced_days: r?.synced_days ?? null,
          error: r?.last_error ?? null,
          refreshing: !!r?.running_since || stale.includes(site),
          // Rows the site returned that DRM could not use, and whether the
          // crawl stopped before the site ran out. Both mean the figure is a
          // floor rather than a total, which the screen has to be able to say.
          rows_skipped: r?.rows_skipped ?? 0,
          truncated: !!r?.truncated,
        };
      }),
    });
  } catch (err) {
    console.error('crm.abandoned error:', err);
    res.status(500).json({ error: 'Could not load Nearly gave.' });
  }
});

/**
 * The "nearly gave" list, as a file.
 *
 * Deliberately does NOT trigger a sync. A download is a read of what the
 * screen is showing; making it fetch two external sites first would mean the
 * file sometimes differs from the list the person was looking at when they
 * pressed the button, which is the one thing an export must never do.
 */
async function exportAbandonedFile(
  req: import('express').Request,
  res: import('express').Response,
  format: ExportFormat
) {
  try {
    const q = req.query as Record<string, unknown>;
    const sites = String(q.sites ?? '').split(',').filter(Boolean) as SiteKey[];
    const wanted = sites.length ? sites : (['hkmv', 'annadan'] as SiteKey[]);
    const viewDays = Math.min(365, Math.max(1, Number(q.days) || 30));
    const { base, values, order } = buildAbandonedQuery(q, wanted, viewDays);

    const rows = await pool.query(
      `${base}
       SELECT * FROM resolved l
        ${q.include_settled === 'true' ? '' : 'WHERE NOT gave_anyway'}
        ORDER BY ${order}
        LIMIT ${EXPORT_ROW_CAP + 1}`,
      values
    );
    const truncated = rows.rows.length > EXPORT_ROW_CAP;

    await sendExport(res, format, {
      name: 'nearly-gave',
      truncated,
      rows: truncated ? rows.rows.slice(0, EXPORT_ROW_CAP) : rows.rows,
      filterSummary: describeFilters(q, {
        days: 'Last N days',
        sites: 'Sites',
        min_amount: 'Minimum amount',
        max_amount: 'Maximum amount',
        status: 'Payment status',
        search: 'Search',
        include_settled: 'Including those who gave anyway',
        called: 'Calls',
        sort: 'Sorted by',
      }),
      columns: [
        { header: 'Name', value: (r) => r.name },
        { header: 'Phone', value: (r) => r.phone, kind: 'phone' },
        { header: 'Email', value: (r) => r.email },
        { header: 'Amount', value: (r) => r.amount, kind: 'money' },
        { header: 'Purpose', value: (r) => r.purpose },
        { header: 'Site', value: (r) => r.source_site },
        { header: 'Page', value: (r) => r.source_page },
        { header: 'Payment status', value: (r) => r.status },
        { header: 'Tried at', value: (r) => r.attempted_at, kind: 'datetime' },
        { header: 'Times tried', value: (r) => r.attempts_in_view, kind: 'number' },
        { header: 'Gave anyway', value: (r) => (r.gave_anyway ? 'Yes' : 'No') },
        { header: 'Already a lead', value: (r) => (r.lead_id ? 'Yes' : 'No') },
        { header: 'Lead status', value: (r) => r.lead_status },
        { header: 'Assigned to', value: (r) => r.assigned_to_name },
      ],
    });
  } catch (err) {
    console.error('crm.exportAbandoned error:', err);
    res.status(500).json({ error: 'Could not download. Try again.' });
  }
}

router.get('/leads/abandoned/export.csv', (req, res) => exportAbandonedFile(req, res, 'csv'));
router.get('/leads/abandoned/export.xlsx', (req, res) => exportAbandonedFile(req, res, 'xlsx'));

/** POST /leads/abandoned/refresh - ask both sites now, and wait for them. */
router.post('/leads/abandoned/refresh', async (req, res) => {
  const sites = (String(req.body?.sites ?? '').split(',').filter(Boolean) as SiteKey[]);
  try {
    // The window the screen is showing, so pressing the button on a year view
    // actually fetches the year. Without this it refetched ninety days and
    // reset the staleness clock, which made the button the one thing
    // guaranteeing the year was never fetched.
    const days = Math.min(365, Math.max(1, Number(req.body?.days) || 90));
    const results = await syncAbandoned(sites.length ? sites : (['hkmv', 'annadan'] as SiteKey[]), { days });
    res.json({ results });
  } catch (err) {
    console.error('crm.refreshAbandoned error:', err);
    res.status(500).json({ error: 'Could not reach the sites' });
  }
});

/** POST /leads/abandoned/:id/dismiss - not worth a call. Survives refreshes. */
router.post('/leads/abandoned/:id/dismiss', async (req, res) => {
  try {
    // Every attempt by that person, not the one row somebody clicked.
    //
    // The list is one row per person; the table underneath is one row per
    // attempt. Dismissing a single attempt removed it from the dedupe and
    // promoted the person's NEXT attempt into the list, so somebody who tried
    // four times needed setting aside four times - and the value at stake went
    // UP each time, because the earlier attempts were for more money.
    const r = await pool.query(
      `UPDATE abandoned_attempts
          SET dismissed_at = NOW(), dismissed_by = $2::uuid
        WHERE phone = (SELECT phone FROM abandoned_attempts WHERE id = $1)
          AND dismissed_at IS NULL
        RETURNING id`,
      [req.params.id, req.user?.userId ?? null]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json({ dismissed: true, attempts: r.rows.length });
  } catch (err) {
    console.error('crm.dismissAbandoned error:', err);
    res.status(500).json({ error: 'Could not set that aside' });
  }
});

/** POST /leads/abandoned/:id/restore - undo "Set aside". */
router.post('/leads/abandoned/:id/restore', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE abandoned_attempts SET dismissed_at = NULL, dismissed_by = NULL
        WHERE phone = (SELECT phone FROM abandoned_attempts WHERE id = $1)
          AND dismissed_at IS NOT NULL
        RETURNING id`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Nothing to bring back' });
    res.json({ restored: true, attempts: r.rows.length });
  } catch (err) {
    console.error('crm.restoreAbandoned error:', err);
    res.status(500).json({ error: 'Could not bring that back' });
  }
});

export interface AdoptResult {
  created: number;
  already_yours: number;
  already_others: number;
  do_not_call: number;
  gave_anyway: number;
  /** Leads ready to ring, in the order they were picked. */
  lead_ids: string[];
}

/**
 * Turn rows of the Nearly gave view into leads, many at once.
 *
 * The same rules as adopting one, applied to each: never somebody who has
 * since given (the view's gave_anyway), never re-opening a do-not-call, and
 * never taking a lead a colleague already owns - that one is counted and
 * left where it is. `assignTo` null leaves new leads unassigned, which is
 * what a session wants: the claim on whoever is on screen keeps two callers
 * apart without making the whole list one person's.
 */
export async function adoptAbandonedRows(
  rows: Record<string, unknown>[],
  opts: { assignTo: string | null; userId: string | null; takeParked?: boolean }
): Promise<AdoptResult> {
  const out: AdoptResult = { created: 0, already_yours: 0, already_others: 0, do_not_call: 0, gave_anyway: 0, lead_ids: [] };
  for (const r of rows) {
    if (r.gave_anyway) {
      out.gave_anyway++;
      continue;
    }
    if (r.lead_id) {
      if (r.lead_do_not_call) {
        out.do_not_call++;
        continue;
      }
      // Somebody else's lead stays theirs - whoever is adopting, and whoever
      // it is being handed to. Only the acting person's own leads, or the
      // person they are handing to's, count as "already yours".
      if (r.lead_assigned_to && r.lead_assigned_to !== opts.userId && r.lead_assigned_to !== opts.assignTo) {
        // Parked with somebody who does not make calls - an admin who added
        // the whole list for themselves, say. A caller working the list takes
        // it over; otherwise the one person ringing these donors could never
        // reach them, and nobody else was going to.
        if (opts.takeParked && r.lead_owner_calls === false && opts.userId) {
          await pool.query(
            `UPDATE leads SET assigned_to = $2::uuid, assigned_at = NOW(), updated_at = NOW()
              WHERE id = $1 AND assigned_to = $3::uuid`,
            [r.lead_id, opts.userId, r.lead_assigned_to]
          );
          out.already_yours++;
          out.lead_ids.push(String(r.lead_id));
          continue;
        }
        out.already_others++;
        continue;
      }
      // Already a lead and free (or already theirs): claim it if asked to.
      if (!r.lead_assigned_to && opts.assignTo) {
        await pool.query(
          `UPDATE leads SET assigned_to = $2::uuid, assigned_at = NOW(),
                  tags = ARRAY(SELECT DISTINCT unnest(tags || '{abandoned}'::text[])), updated_at = NOW()
            WHERE id = $1 AND assigned_to IS NULL`,
          [r.lead_id, opts.assignTo]
        );
      }
      out.already_yours++;
      out.lead_ids.push(String(r.lead_id));
      continue;
    }
    const phone = normalizePhone(r.phone);
    if (!isDialable(phone)) continue;
    const { lead, created } = await upsertLead(
      {
        phone,
        name: r.name,
        email: r.email,
        source: 'website',
        source_detail: `Unfinished donation${r.source_page ? ` on ${r.source_page}` : ''}`,
        source_site: r.source_site,
        expected_amount: r.amount ?? null,
        assigned_to: opts.assignTo,
        tags: ['abandoned'],
      },
      opts.userId
    );
    if (created) {
      out.created++;
      await pool.query(
        `INSERT INTO lead_activities (lead_id, user_id, kind, note, occurred_at)
         VALUES ($1,$2,'import',$3,COALESCE($4::timestamptz, NOW()))`,
        [
          lead.id,
          opts.userId,
          `Started a donation of ${r.amount ?? '?'}${r.purpose ? ` for ${r.purpose}` : ''} and did not complete it` +
            (Number(r.attempts_in_view) > 1 ? ` (${r.attempts_in_view} attempts)` : ''),
          r.attempted_at ?? null,
        ]
      );
    } else out.already_yours++;
    if (!lead.do_not_call) out.lead_ids.push(String(lead.id));
  }
  return out;
}

/**
 * The Nearly gave rows a request is talking about: the ticked ones (`ids`,
 * attempt ids as the list returned them) or, with `all`, everybody the
 * filters find - "select all 212 matching", not just the 50 on screen.
 */
export async function abandonedRowsFor(
  q: Record<string, unknown>,
  ids: string[] | null
): Promise<Record<string, unknown>[]> {
  const sites = String(q.sites ?? '').split(',').filter(Boolean) as SiteKey[];
  const wanted = sites.length ? sites : (['hkmv', 'annadan'] as SiteKey[]);
  const viewDays = Math.min(365, Math.max(1, Number(q.days) || 30));
  const { base, values, order } = buildAbandonedQuery({ ...q, set_aside: undefined }, wanted, viewDays);
  const r = await pool.query(
    `${base}
     SELECT * FROM resolved l
      WHERE ${ids ? `l.id = ANY($${values.length + 1}::uuid[])` : 'NOT gave_anyway'}
      ORDER BY ${order}
      LIMIT 2000`,
    ids ? [...values, ids] : values
  );
  return r.rows;
}

/**
 * POST /leads/abandoned/adopt-bulk - add many of them as leads at once.
 *
 * { ids?: attempt ids, all?: true, filters: {the list's own query},
 *   assign: 'me' | 'none' | <user id, admin only> }
 *
 * Answers with what happened to each kind of row, so the screen can say
 * "38 added, 4 were already yours, 2 belong to Arjun, 1 asked not to be
 * called" instead of a bare success.
 */
router.post('/leads/abandoned/adopt-bulk', async (req, res) => {
  const b = req.body ?? {};
  const ids = Array.isArray(b.ids) ? b.ids.map(String).slice(0, 2000) : null;
  if (!b.all && !ids?.length) return res.status(400).json({ error: 'Pick at least one person' });

  const me = req.user?.userId ?? null;
  const elevated = req.user?.role === 'admin' || req.user?.role === 'accountant';
  let assignTo: string | null = me;
  if (b.assign === 'none') assignTo = null;
  else if (b.assign && b.assign !== 'me') {
    if (!elevated) return res.status(403).json({ error: 'Only an admin can give leads to others.' });
    assignTo = str(b.assign, 36);
  }

  try {
    const rows = await abandonedRowsFor((b.filters ?? {}) as Record<string, unknown>, b.all ? null : ids);
    const result = await adoptAbandonedRows(rows, {
      assignTo,
      userId: me,
      // A caller adding for themselves takes over leads parked with staff
      // who do not call.
      takeParked: req.user?.role === 'caller' && assignTo === me,
    });
    res.json({ requested: b.all ? rows.length : ids!.length, ...result });
  } catch (err) {
    console.error('crm.adoptAbandonedBulk error:', err);
    res.status(500).json({ error: 'Could not add those as leads' });
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
  if (!isDialable(phone)) return res.status(400).json({ error: 'Enter a 10-digit mobile number.' });

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
        error: 'They have already donated. Refresh the list.',
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

/**
 * GET /leads/ids - every lead the leads screen's filters find, as ids.
 *
 * What "Select all 1,240 matching" sends to the bulk actions, the list
 * builder and "Call these now". Built with the same filter and the same scope
 * as the screen, so the selection is exactly what the person was looking at.
 */
router.get('/leads/ids', async (req, res) => {
  const sort = SORTS[String(req.query.sort || '')] || SORTS.due;
  try {
    const f = withScope(
      withScope(buildLeadFilters(req.query as Record<string, unknown>), await leadScopeFor(req.user)),
      callableScope(req.query as Record<string, unknown>, req.user)
    );
    const r = await pool.query(`SELECT l.id ${LEAD_JOINS} ${f.where} ORDER BY ${sort} LIMIT 5001`, f.values);
    const ids = r.rows.map((x) => x.id);
    res.json({ ids: ids.slice(0, 5000), truncated: ids.length > 5000 });
  } catch (err) {
    console.error('crm.leadIds error:', err);
    res.status(500).json({ error: 'Could not select those leads' });
  }
});

router.get('/leads', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const sort = SORTS[String(req.query.sort || '')] || SORTS.due;

  try {
    const f = withScope(
      withScope(buildLeadFilters(req.query as Record<string, unknown>), await leadScopeFor(req.user)),
      callableScope(req.query as Record<string, unknown>, req.user)
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
          AND ($2::uuid IS NULL OR l.assigned_to = $2::uuid OR l.assigned_to IS NULL OR l.assigned_to IN (SELECT id FROM users WHERE role <> 'caller'))`,
      [req.params.id, scope]
    );
    // 404 rather than 403 on purpose: a caller narrowed to their own leads
    // should not be able to confirm that a given lead id exists by the shape
    // of the refusal.
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead not found' });

    const [activities, donations, reminders, nearlyGave] = await Promise.all([
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
      // What they last tried to give on a website, so a call opened from a
      // list says "you were giving ₹2,000 for Annadan on Tuesday" just as a
      // call inside a run does.
      pool.query(
        `SELECT a.amount, a.purpose, a.source_site, a.source_page, a.attempted_at, a.status
           FROM abandoned_attempts a WHERE a.phone = $1 AND NOT ${FROM_DONATIONS_PAGE('a')}
          ORDER BY a.attempted_at DESC LIMIT 1`,
        [lead.rows[0].phone]
      ),
    ]);

    res.json({
      lead: lead.rows[0],
      activities: activities.rows,
      donations: donations.rows,
      reminders: reminders.rows,
      nearly_gave: nearlyGave.rows[0] ?? null,
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
  if (!phone) throw Object.assign(new Error('Enter a mobile number.'), { status: 400 });

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
    const b = { ...(req.body ?? {}) } as Record<string, unknown>;
    const isCaller = req.user?.role === 'caller';
    const me = req.user?.userId ?? null;
    if (isCaller) {
      // A caller adds a lead for themselves - a walk-in, a number somebody
      // passed on. They cannot set its stage or hand it to someone else.
      b.assigned_to = me;
      delete b.status;
      if (!['manual', 'walk_in', 'referral', 'event'].includes(String(b.source ?? ''))) b.source = 'manual';
    }
    const { lead, created } = await upsertLead(b, me);
    let owner: string | null = null;
    if (!created && isCaller && me && lead.assigned_to !== me) {
      // Already a lead. Free, or parked with somebody who does not make
      // calls: it becomes theirs. A fellow caller's: it stays, and they are
      // told whose it is rather than "already exists".
      const taken = await pool.query(
        `UPDATE leads SET assigned_to = $2::uuid, assigned_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND (assigned_to IS NULL
                OR assigned_to IN (SELECT id FROM users WHERE role <> 'caller'))
          RETURNING *`,
        [lead.id, me]
      );
      if (taken.rows.length) Object.assign(lead, taken.rows[0]);
      else {
        const o = await pool.query(`SELECT name FROM users WHERE id = $1`, [lead.assigned_to]);
        owner = o.rows[0]?.name ?? 'another caller';
      }
    }
    if (created) {
      await pool.query(
        `INSERT INTO lead_activities (lead_id, user_id, kind, note) VALUES ($1,$2,'import',$3)`,
        [lead.id, req.user?.userId ?? null, `Lead added (${lead.source})`]
      );
    }
    res.status(created ? 201 : 200).json({ lead, created, duplicate: !created, owner_name: owner });
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
    return res.status(400).json({ error: 'Pick the promise date.' });
  }
  if (!normalizePhone(b.phone)) {
    return res.status(400).json({ error: 'Enter a mobile number.' });
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
        `They called and promised. ${title}${b.occasion ? `, ${String(b.occasion)}` : ''}`,
      ]
    );

    await client.query('COMMIT');
    res.status(201).json({ lead, created, reminder: reminder.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    const status = (err as { status?: number }).status ?? 500;
    if (status === 400) return res.status(400).json({ error: (err as Error).message });
    console.error('crm.promise error:', err);
    res.status(500).json({ error: 'Could not save promise. Try again.' });
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

/**
 * POST /calls/outside - a call that did not come out of the queue.
 *
 * THE GAP THIS CLOSES
 * DRM assumed every call starts on the calling screen, with a lead already in
 * front of the caller. Real days are not like that. Somebody rings the temple
 * and the caller rings back from their own phone; a devotee passes on a number
 * on a slip of paper; a donor from last year is called directly because the
 * caller remembers them. In every one of those the money may still arrive
 * through a QR - and until now none of it was recorded anywhere, so the call
 * never happened as far as DRM was concerned and the payment that followed had
 * no share to match against.
 *
 * One request records the lot: find or create the lead by number, log the call
 * with its outcome, optionally book a callback, optionally raise a reminder
 * for a promise, and hand back the lead id so the caller can go straight on to
 * share a QR against it.
 *
 * Everything is attributed to whoever is signed in, because they are the one
 * who made the call.
 */
router.post('/calls/outside', async (req, res) => {
  const b = req.body ?? {};
  const phone = normalizePhone(b.phone);
  if (!isDialable(phone)) return res.status(400).json({ error: 'Enter a mobile number.' });

  const disposition = str(b.disposition, 30);
  if (!disposition) return res.status(400).json({ error: 'Pick a call result.' });

  try {
    const d = await pool.query(
      `SELECT slug, counts_connected, suggests_status, wants_follow_up
         FROM crm_dispositions WHERE slug = $1`,
      [disposition]
    );
    if (!d.rows.length) return res.status(400).json({ error: `Unknown call result "${disposition}".` });

    const { lead, created } = await upsertLead(
      {
        phone,
        name: b.name,
        email: b.email,
        city: b.city,
        source_detail: str(b.source_detail, 255) ?? 'Called outside DRM',
        expected_amount: b.expected_amount ?? null,
        // Theirs: they made the call. Only applied to a lead that is going
        // spare - upsertLead leaves an existing assignment alone.
        assigned_to: req.user?.userId ?? null,
      },
      req.user?.userId ?? null
    );

    // From here it is the ordinary call path, reached by its own handler so
    // there is exactly one implementation of what logging a call does - the
    // status move, the attempt count, the retry scheduling, the reminder, the
    // conversion when they gave on the call. Duplicating any of that here is
    // how the two ways of making a call would start to disagree.
    const inner = {
      ...b,
      direction: str(b.direction, 10) ?? 'outbound',
      source: 'manual',
    };

    // Called in-process rather than over HTTP: one transaction, no second
    // round trip, and no token to forward to ourselves.
    const result = await logCallForLead(String(lead.id), inner, req.user ?? null);

    // `lead` from the call is the updated row; the one from upsertLead is how
    // it looked a moment earlier, so the newer one wins.
    res.status(201).json({ created, ...result });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    if (status === 400) return res.status(400).json({ error: (err as Error).message });
    console.error('crm.outsideCall error:', err);
    res.status(500).json({ error: 'Could not save call. Try again.' });
  }
});

router.put('/leads/:id', async (req, res) => {
  const b = req.body ?? {};
  try {
    const before = await pool.query(`SELECT status, assigned_to, phone, alt_phone FROM leads WHERE id = $1`, [req.params.id]);
    if (!before.rows.length) return res.status(404).json({ error: 'Lead not found' });

    // A caller limited to their own leads may edit only those (and unowned
    // ones) - the same rule that decides what they can open.
    const scope = await leadScopeFor(req.user);
    if (scope && before.rows[0].assigned_to && before.rows[0].assigned_to !== scope) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    // THE NUMBER ITSELF CAN NOW BE CORRECTED.
    // It could not, because the phone is the lead's identity - so a sheet
    // with one digit wrong left a lead nobody could ring and nobody could
    // fix, short of deleting it and losing its history. Changing it is
    // allowed when the new number is dialable and is not already somebody
    // else's lead; that second case is answered with who has it, because the
    // likely truth is that they are the same person entered twice.
    let newPhone: string | null = null;
    if (b.phone !== undefined && b.phone !== null && String(b.phone).trim() !== '') {
      const p = normalizePhone(b.phone);
      if (!isDialable(p)) return res.status(400).json({ error: 'Enter a 10-digit mobile number.' });
      if (p !== before.rows[0].phone) {
        const clash = await pool.query(`SELECT id, name FROM leads WHERE phone = $1 AND id <> $2`, [p, req.params.id]);
        if (clash.rows.length) {
          return res.status(409).json({
            error: `${clash.rows[0].name ?? 'Another lead'} already has that number`,
            lead_id: clash.rows[0].id,
          });
        }
        newPhone = p;
      }
    }
    let altPhone: string | null | undefined;
    if (b.alt_phone === null || (typeof b.alt_phone === 'string' && b.alt_phone.trim() === '')) altPhone = null;
    else if (b.alt_phone !== undefined) {
      const a = normalizePhone(b.alt_phone);
      if (!isDialable(a)) return res.status(400).json({ error: 'Other number must be 10 digits.' });
      altPhone = a;
    }

    const result = await pool.query(
      `UPDATE leads SET
         name              = COALESCE($1, name),
         alt_phone         = CASE WHEN $16::boolean THEN $2 ELSE alt_phone END,
         phone             = COALESCE($15, phone),
         -- A corrected number is a dialable one.
         invalid_reason    = CASE WHEN $15::text IS NOT NULL THEN NULL ELSE invalid_reason END,
         person_id         = CASE WHEN $15::text IS NULL THEN person_id
                                  ELSE COALESCE((SELECT p.id FROM people p
                                                  WHERE right(regexp_replace(p.phone,'\D','','g'), 10) = $15
                                                  LIMIT 1), person_id) END,
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
        altPhone ?? null,
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
        newPhone,
        altPhone !== undefined,
      ]
    );

    const lead = result.rows[0];
    if (newPhone) {
      await pool.query(
        `INSERT INTO lead_activities (lead_id, user_id, kind, from_value, to_value, note)
         VALUES ($1,$2,'note',$3,$4,$5)`,
        [lead.id, req.user?.userId ?? null, before.rows[0].phone, newPhone, `Number corrected from ${before.rows[0].phone} to ${newPhone}`]
      );
    }
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
    if ((err as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'Another lead already has that number' });
    }
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
/**
 * Everything logging a call does, as a function.
 *
 * WHY IT IS NOT JUST THE ROUTE HANDLER
 * A call can start in two places now: the calling screen, working the queue,
 * and a caller who rang somebody from their own phone and is recording it
 * afterwards. Both have to do exactly the same thing to the lead - the stage
 * move, the attempt count, the automatic retry date, the promise, the
 * conversion when the donor gave on the call - and a second copy of that would
 * drift from this one inside a month.
 *
 * Throws with a `status` for the caller to translate; the routes below do.
 */
async function logCallForLead(
  leadId: string,
  b: Record<string, unknown>,
  user: { userId?: string; role?: string } | null
): Promise<{ activity: Record<string, unknown>; lead: Record<string, unknown>; reminder: unknown }> {
  const disposition = str(b.disposition, 30);
  if (!disposition) throw Object.assign(new Error('Pick a call result.'), { status: 400 });

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
              converted_at, converted_amount, converted_via, expected_amount,
              -- And the rest of what a call can change, so Undo puts it all
              -- back: the "said they'd pay by QR" flag, and the conversion's
              -- note and seen-marker.
              awaiting_qr_at, converted_note, conversion_seen_at
         FROM leads WHERE id = $1 FOR UPDATE`,
      [leadId]
    );
    if (!lead.rows.length) {
      await client.query('ROLLBACK');
      throw Object.assign(new Error('Lead not found'), { status: 404 });
    }

    const d = await client.query(
      `SELECT slug, counts_connected, suggests_status, wants_follow_up FROM crm_dispositions WHERE slug = $1`,
      [disposition]
    );
    if (!d.rows.length) {
      await client.query('ROLLBACK');
      throw Object.assign(new Error(`Unknown call result "${disposition}".`), { status: 400 });
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
          [sessionId, user?.userId ?? null]
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
        leadId,
        user?.userId ?? null,
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
             -- A callback still ahead is kept. One already in the past is
             -- NOT: keeping it is what left a "No answer" on an overdue
             -- callback overdue for ever - first in the queue every time,
             -- rung again within the minute.
             WHEN $5::boolean THEN CASE
               WHEN next_follow_up_at > NOW() THEN next_follow_up_at
               ELSE NOW() + ($9::int || ' days')::interval END
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
        leadId,
        retryAfterDays,
        disposition === 'will_pay_qr',
      ]
    );

    // And the share they were sent is marked as awaited too, which is what the
    // matcher reads. The most recent unmatched one for this lead: a caller
    // choosing this outcome has just pressed send, and marking an older share
    // they never mentioned would put weight on the wrong row.
    // What Undo needs beyond the lead row: which share was flagged and what
    // it said before, and which promises "Donated now" closed.
    const undoExtra: Record<string, unknown> = {};
    if (disposition === 'will_pay_qr') {
      const share = await client.query(
        `SELECT id, awaiting_payment_at FROM qr_shares
          WHERE lead_id = $1::uuid AND matched_at IS NULL
          ORDER BY created_at DESC LIMIT 1`,
        [leadId]
      );
      if (share.rows.length) {
        undoExtra.qr_share = { id: share.rows[0].id, awaiting_payment_at: share.rows[0].awaiting_payment_at };
        await client.query(`UPDATE qr_shares SET awaiting_payment_at = NOW() WHERE id = $1`, [share.rows[0].id]);
      }
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
          leadId,
          num(b.donated_amount) ?? num(b.expected_amount),
          `Gave on the call (${disposition})`,
        ]
      );
      // And the chase stops, exactly as it does on every other path money
      // arrives by.
      const closed = await client.query(
        `UPDATE lead_reminders SET status = 'done', completed_at = NOW(), updated_at = NOW()
          WHERE lead_id = $1 AND status = 'open'
          RETURNING id`,
        [leadId]
      );
      if (closed.rows.length) undoExtra.closed_reminders = closed.rows.map((r) => r.id);
    }

    if (nextStatus !== lead.rows[0].status) {
      await client.query(
        `INSERT INTO lead_activities (lead_id, user_id, kind, from_value, to_value)
         VALUES ($1,$2,'status_change',$3,$4)`,
        [leadId, user?.userId ?? null, lead.rows[0].status, nextStatus]
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
    const rem = (b.reminder ?? null) as Record<string, unknown> | null;
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
            leadId,
            str(rem.title, 200) ?? `Said they would donate${rem.occasion ? ` at ${String(rem.occasion).slice(0, 80)}` : ''}`,
            str(rem.note, 2000) ?? str(b.note, 2000),
            str(rem.occasion, 120),
            remDue,
            num(rem.expected_amount) ?? num(b.expected_amount),
            Array.isArray(rem.lead_times) && rem.lead_times.length
              ? rem.lead_times.map((n: unknown) => Math.round(Number(n))).filter((n: number) => Number.isFinite(n) && n >= 0)
              : null,
            user?.userId ?? null,
          ]
        );
        reminder = created.rows[0];
        await client.query(
          `INSERT INTO lead_activities (lead_id, user_id, kind, to_value, note)
           VALUES ($1,$2,'reminder',$3,$4)`,
          [leadId, user?.userId ?? null, remDue, reminder.title]
        );
        // A promise holds the lead until it is due. Without this, "I'll give
        // at Govardhan Puja" with no callback date left next_follow_up_at
        // empty - which the queue reads as "ring now" - so the donor who had
        // just promised was handed to the next caller the same afternoon.
        await client.query(
          `UPDATE leads SET next_follow_up_at = GREATEST(COALESCE(next_follow_up_at, $2::timestamptz), $2::timestamptz)
            WHERE id = $1`,
          [leadId, remDue]
        );
      }
    }

    // This person is done in the caller's session.
    if (activeSession) {
      await client.query(
        `UPDATE calling_session_items SET state = 'done', outcome = $3, done_at = NOW(), note = NULL
          WHERE session_id = $1 AND lead_id = $2`,
        [activeSession, leadId, disposition]
      );
    }

    if (Object.keys(undoExtra).length) {
      await client.query(
        `UPDATE lead_activities SET undo_payload = undo_payload || $2::jsonb WHERE id = $1`,
        [activity.rows[0].id, JSON.stringify({ _extra: undoExtra })]
      );
    }

    await client.query('COMMIT');
    return { activity: activity.rows[0], lead: updated.rows[0], reminder };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

router.post('/leads/:id/call', async (req, res) => {
  try {
    const result = await logCallForLead(req.params.id, req.body ?? {}, req.user ?? null);
    res.status(201).json(result);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status) return res.status(status).json({ error: (err as Error).message });
    console.error('crm.logCall error:', err);
    res.status(500).json({ error: 'Could not save call. Try again.' });
  }
});

// A note without a call - someone replied on WhatsApp, or a preacher passed on
// what they heard at the temple.
router.post('/leads/:id/note', async (req, res) => {
  const note = str(req.body?.note, 2000);
  if (!note) return res.status(400).json({ error: 'Write a note first.' });
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
  if (ids.length > 5000) return res.status(400).json({ error: 'Too many selected. Pick 5000 or fewer.' });

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
    res.status(500).json({ error: 'Could not update leads. Try again.' });
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
    res.status(500).json({ error: 'Could not make the list. Try again.' });
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
    if (!text.trim()) return res.status(400).json({ error: 'The file is empty.' });
    rows = parseCsv(text);
  }
  if (rows.length < 2) return res.status(400).json({ error: 'Add column names and at least one lead.' });

  const header = rows[0];
  const map = mapHeaders(header);
  if (map.phone === undefined) {
    return res.status(400).json({
      error: 'No Mobile Number column found.',
      detail: `Use one of: ${HEADER_ALIASES.phone.join(', ')}. Your file has: ${header.join(', ')}`,
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
  if (rows.length > 10000) return res.status(400).json({ error: 'Too many leads. Upload 10,000 or fewer.' });

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

/**
 * The leads on screen, as a file.
 *
 * SCOPE IS THE POINT, not an afterthought. This runs buildLeadFilters and
 * withScope(leadScopeFor(...)) - exactly what GET /leads runs - so a caller
 * who cannot see the whole donor base on the screen cannot download it either.
 * Sharing the filter builder rather than re-deriving one here is what keeps
 * that true when somebody adds the next filter.
 */
async function exportLeadsFile(
  req: import('express').Request,
  res: import('express').Response,
  format?: ExportFormat
) {
  try {
    const f = withScope(
      buildLeadFilters(req.query as Record<string, unknown>),
      await leadScopeFor(req.user)
    );
    const rows = await pool.query(
      `SELECT ${LEAD_COLUMNS} ${LEAD_JOINS} ${f.where} ORDER BY l.next_follow_up_at ASC NULLS LAST LIMIT ${EXPORT_ROW_CAP + 1}`,
      f.values
    );
    const truncated = rows.rows.length > EXPORT_ROW_CAP;

    await sendExport(res, format ?? formatFrom(req.query as Record<string, unknown>), {
      name: 'leads',
      truncated,
      rows: truncated ? rows.rows.slice(0, EXPORT_ROW_CAP) : rows.rows,
      filterSummary: describeFilters(req.query as Record<string, unknown>, {
        search: 'Search',
        status: 'Status',
        source: 'Source',
        assigned_to: 'Assigned to',
        due: 'Follow-up',
        preacher: 'Preacher',
        start_date: 'Added from',
        end_date: 'Added to',
      }),
      columns: [
        { header: 'Name', value: (r) => r.name },
        { header: 'Phone', value: (r) => r.phone, kind: 'phone' },
        { header: 'Email', value: (r) => r.email },
        { header: 'City', value: (r) => r.city },
        { header: 'Status', value: (r) => r.status_label },
        { header: 'Assigned to', value: (r) => r.assigned_to_name },
        { header: 'Source', value: (r) => r.source },
        { header: 'List', value: (r) => r.source_detail },
        { header: 'Tags', value: (r) => r.tags },
        { header: 'Attempts', value: (r) => r.call_attempts, kind: 'number' },
        { header: 'Last outcome', value: (r) => r.last_outcome },
        { header: 'Last contacted', value: (r) => r.last_contacted_at, kind: 'datetime' },
        { header: 'Follow-up due', value: (r) => r.next_follow_up_at, kind: 'datetime' },
        { header: 'Follow-up note', value: (r) => r.follow_up_note },
        { header: 'Expected amount', value: (r) => r.expected_amount, kind: 'money' },
        { header: 'Donated', value: (r) => r.converted_amount, kind: 'money' },
        { header: 'Given before (total)', value: (r) => r.total_donated, kind: 'money' },
        { header: 'Donations before', value: (r) => r.donation_count, kind: 'number' },
        { header: 'Remarks', value: (r) => r.remarks },
        { header: 'Added', value: (r) => r.created_at, kind: 'datetime' },
      ],
    });
  } catch (err) {
    console.error('crm.exportLeads error:', err);
    res.status(500).json({ error: 'Could not download. Try again.' });
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
    if (listId && !list) return res.status(404).json({ error: 'List not found.' });
    const pred = listPredicate(list, 4);

    const rows = await pool.query(
      `SELECT ${LEAD_COLUMNS} ${LEAD_JOINS}
        WHERE ${CALLABLE}
          AND l.call_attempts < $1
          AND ($2::uuid IS NULL OR l.assigned_to = $2::uuid OR l.assigned_to IS NULL OR l.assigned_to IN (SELECT id FROM users WHERE role <> 'caller'))
          AND ${DUE_NOW}
          AND ${NOT_CLAIMED_BY_OTHERS(4 + pred.values.length)}
          ${pred.sql}
        ORDER BY
          -- Overdue promises first, then today, then never-touched, then age.
          CASE WHEN l.next_follow_up_at < NOW() THEN 0
               WHEN l.next_follow_up_at IS NOT NULL THEN 1
               WHEN l.last_contacted_at IS NULL AND 'abandoned' = ANY(l.tags) THEN 2
               WHEN l.last_contacted_at IS NULL THEN 3
               ELSE 4 END,
          l.next_follow_up_at ASC NULLS LAST,
          l.created_at ASC
        LIMIT $3`,
      [attempts, mine ? req.user?.userId ?? null : null, limit, ...pred.values, req.user?.userId ?? null]
    );

    // How much of this list is left, counted the same way. Sent with the queue
    // so the caller's progress bar is a fact about the database rather than a
    // number the browser has been adding up since the page loaded - which is
    // what made it vanish on every refresh.
    const remaining = await pool.query(
      `SELECT COUNT(*)::int AS to_call ${LEAD_JOINS}
        WHERE ${CALLABLE}
          AND l.call_attempts < $1
          AND ($2::uuid IS NULL OR l.assigned_to = $2::uuid OR l.assigned_to IS NULL OR l.assigned_to IN (SELECT id FROM users WHERE role <> 'caller'))
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
    res.status(500).json({ error: 'Could not load your list.' });
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
      return res.status(404).json({ error: "Can't undo this call now." });
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
         -- Payloads written before these were captured do not have them; the
         -- lead keeps what it has rather than being blanked.
         awaiting_qr_at     = CASE WHEN $13::boolean THEN $14::timestamptz ELSE awaiting_qr_at END,
         converted_note     = CASE WHEN $13::boolean THEN $15::text ELSE converted_note END,
         conversion_seen_at = CASE WHEN $13::boolean THEN $16::timestamptz ELSE conversion_seen_at END,
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
        Object.prototype.hasOwnProperty.call(before, 'awaiting_qr_at'),
        before.awaiting_qr_at ?? null,
        before.converted_note ?? null,
        before.conversion_seen_at ?? null,
      ]
    );

    // What the call did outside the lead row.
    const extra = (before._extra ?? {}) as { qr_share?: { id: string; awaiting_payment_at: string | null }; closed_reminders?: string[] };
    if (extra.qr_share?.id) {
      await client.query(`UPDATE qr_shares SET awaiting_payment_at = $2::timestamptz WHERE id = $1 AND matched_at IS NULL`, [
        extra.qr_share.id,
        extra.qr_share.awaiting_payment_at ?? null,
      ]);
    }
    // "Donated now" closed every open promise; undoing it opens them again.
    // Without this an undone slip silently cancelled the donor's reminders.
    if (extra.closed_reminders?.length) {
      await client.query(
        `UPDATE lead_reminders SET status = 'open', completed_at = NULL, updated_at = NOW()
          WHERE id = ANY($1::uuid[]) AND status = 'done'`,
        [extra.closed_reminders]
      );
    }
    // Back to "still to ring" in the session it was logged from.
    if (a.session_id) {
      await client.query(
        `UPDATE calling_session_items SET state = 'pending', outcome = NULL, done_at = NULL
          WHERE session_id = $1 AND lead_id = $2 AND state = 'done'`,
        [a.session_id, a.lead_id]
      );
    }

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
    // The reminder a call made is written in the same transaction, so it has
    // exactly the call's timestamp. Matching on that rather than a window
    // around it: a window also caught a promise made on the PREVIOUS call a
    // second earlier, so undoing a slip deleted the donor's real promise.
    const extraPre = (before._extra ?? {}) as { closed_reminders?: string[] };
    await client.query(
      `DELETE FROM lead_reminders
        WHERE lead_id = $1 AND created_at = $2::timestamptz
          AND NOT (id = ANY($3::uuid[]))`,
      [a.lead_id, a.created_at, extraPre.closed_reminders ?? []]
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
          AND (l.assigned_to = $1::uuid OR l.assigned_to IS NULL OR l.assigned_to IN (SELECT id FROM users WHERE role <> 'caller'))
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
    return res.status(400).json({ error: 'Nothing selected.' });
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
    res.status(500).json({ error: 'Could not update. Try again.' });
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
  if (amount === null || amount <= 0) return res.status(400).json({ error: 'Enter the amount.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query(`SELECT status FROM leads WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Lead not found' });
    }

    /* THE MONEY IS ALREADY HERE.
     *
     * Their QR payment, PhonePe entry or site donation has been linked and
     * counted. Writing the caller's word on top would be the same gift twice
     * - in the lead's amount and, when the payment's credit is not on the
     * lead, in the caller's total. A second, separate gift is recorded where
     * its money is: Collected by PhonePe, or the QR payment itself. */
    const money = await leadMoneyState(client, String(req.params.id), { at: asDate(req.body?.at) });
    if (money?.converted && !money.wordOnly && money.near) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Already counted: ${rupees(money.saidAmount)} from their payment. Nothing added. A new donation goes under Collected by PhonePe.`,
      });
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

    /* THE CALLER'S OWN WORD, recorded as such.
     *
     * This endpoint deliberately creates no donation row - the site's entry
     * is the money, and this is somebody saying it arrived. The credit mirrors
     * that: it is written to whoever recorded it rather than to whoever the
     * lead is assigned to, because the person who got the donor to pay is the
     * person on this request.
     *
     * Credited at the time they say it happened, not at the time they typed
     * it in, so a caller writing up Friday's shift on Monday does not empty
     * Friday and inflate Monday.
     */
    const recordedBy = req.user?.userId ?? null;
    if (recordedBy) {
      await recordCredit(
        {
          userId: recordedBy,
          amount,
          kind: 'lead',
          occurredAt: result.rows[0].converted_at ?? new Date(),
          leadId: String(req.params.id),
          personId: result.rows[0].person_id ?? null,
          note: str(req.body?.note, 300) ?? 'Added by hand after a call',
          createdBy: recordedBy,
        },
        client
      );
    }

    await client.query(
      `INSERT INTO lead_activities (lead_id, user_id, kind, from_value, to_value, note)
       VALUES ($1,$2,'status_change',$3,'converted',$4)`,
      [
        req.params.id,
        req.user?.userId ?? null,
        before.rows[0].status,
        `Donated ${amount}${req.body?.note ? `: ${String(req.body.note).slice(0, 200)}` : ''} (added by hand)`,
      ]
    );

    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('crm.markDonated error:', err);
    res.status(500).json({ error: 'Could not save donation. Try again.' });
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
            // Not the standalone /donations page's - see FROM_DONATIONS_PAGE.
            //
            // Named sourcePage, not `page`: a const named `page` here would
            // shadow the loop variable, and shadowing is hoisted - line 3415's
            // `page` would resolve to this binding, which is still in its TDZ,
            // so every fetch threw ReferenceError before it was sent.
            const sourcePage = String(d.sourcePage ?? '');
            if (
              site === 'hkmv' &&
              (/^(https?:\/\/[^/]+)?\/?donations(\/|\?|#|$)/i.test(sourcePage) || d.purpose === 'Donation')
            ) continue;
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
    // Somebody set aside on the Nearly gave screen stays set aside here too,
    // unless they have tried again since. The bulk import used to ignore that
    // and turn every one of them back into a lead.
    const setAside = await pool.query(
      `SELECT phone, MAX(dismissed_at) AS at FROM abandoned_attempts
        WHERE phone = ANY($1::text[]) AND dismissed_at IS NOT NULL GROUP BY phone`,
      [phones]
    );
    const setAsideAt = new Map(setAside.rows.map((r) => [r.phone, new Date(r.at)]));
    const stillOwed = unique.filter((d) => {
      if (recoveredPhones.has(String(d.phone))) return false;
      const at = setAsideAt.get(String(d.phone));
      return !(at && new Date(String(d.attemptedAt)) <= at);
    });

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
    res.status(500).json({ error: 'Could not load Nearly gave. Try again.' });
  }
});

export default router;
export {
  reconcileConversions, normalizePhone as normalizeLeadPhone, isDialable,
  LEAD_COLUMNS, LEAD_JOINS, buildLeadFilters, withScope, leadScopeFor,
};
