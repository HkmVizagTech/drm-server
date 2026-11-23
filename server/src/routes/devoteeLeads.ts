// A devotee's own leads: add people, follow them up, record what they gave, see them on a map.
//
// Mounted at /api/devotee. Only the 'devotee' role gets in, and only while the devotee is still
// switched on in the devotee list. Every query is scoped by owner_id = the signed-in devotee, so
// one devotee never sees another's leads - and no other role, admins included, can read them
// here. Nothing in this router reads DRM's people, donations or leads, or anything synced from
// the HKM and Annadan sites.
//
//   GET    /config                    map key and push key for the pages
//   GET    /summary                   counts, follow-ups due, recent activity
//   GET    /leads                     list: q, status, due, priority, sort, page, limit
//   GET    /leads/map                 every lead with a map pin
//   GET    /leads/:id                 one lead and its history
//   POST   /leads                     add
//   POST   /leads/import              many from an Excel or CSV file: check first, then add
//   PATCH  /leads/:id                 edit (only the fields sent)
//   DELETE /leads/:id                 remove, with its history
//   POST   /leads/:id/activities      log a follow-up; moves the status and the next follow-up
//   GET    /reminders                 follow-ups due and coming, for the page and the app to alert on
//   GET    /calls/:id/recording       a call's recording, for the devotee who made the call - nobody else
//   GET    /receipts                  the receipts this devotee raised
//   POST   /receipts                  raise one straight to DCC (HKMI or TSC) and file it on the lead; no WhatsApp
//                                     is sent - the devotee shares it from their own phone
//   POST   /receipts/:id/retry        send one DCC did not issue again
//   GET    /receipts/:id/file         its PDF
//   POST   /push/subscribe            keep this browser's push subscription
//   POST   /push/unsubscribe

import { Router, type NextFunction, type Request, type Response } from 'express';
import pool from '../db/pool';
import { authenticate } from '../middleware/auth';
import { APP_TIMEZONE } from '../bootTimezone';
import { STATUSES, logActivity, parseActivity, parseLead } from '../services/devoteeLeads';
import { atTemple, readLeadFile } from '../services/devoteeImport';
import { pushPublicKey, removeSubscription, saveSubscription } from '../services/webPush';
import { deleteRecordingsForLead } from '../services/devoteeCalls';
import * as storage from '../services/storage';
import { istDate } from '../bootTimezone';
import { dccAccountTypeOf, dccSevaOf, resolveSeva } from '../services/sevaCatalog';
import {
  enrolledByFor,
  issueDevoteeReceipt,
  renderDevoteeReceipt,
  type DevoteeReceiptRow,
  type PayMode,
} from '../services/devoteeDcc';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Day boundaries at the temple, whatever zone the database session is in.
const TZ = `'${APP_TIMEZONE}'`;
const TODAY_START = `(date_trunc('day', NOW() AT TIME ZONE ${TZ}) AT TIME ZONE ${TZ})`;
const TODAY_END = `((date_trunc('day', NOW() AT TIME ZONE ${TZ}) + INTERVAL '1 day') AT TIME ZONE ${TZ})`;
const MONTH_START = `date_trunc('month', NOW() AT TIME ZONE ${TZ})::date`;

/** The columns a page gets for a lead. NUMERIC as float8 so amounts arrive as numbers, not strings. */
const LEAD_COLS = `
  l.id, l.name, l.phone, l.alt_phone, l.email, l.occupation, l.organisation, l.interest, l.source,
  l.referred_by, l.priority, l.expected_amount::float8 AS expected_amount, l.date_of_birth, l.anniversary_date,
  l.address_line, l.area, l.city, l.pincode, l.landmark, l.latitude, l.longitude, l.notes, l.status,
  l.next_follow_up_at, l.last_contacted_at, l.unanswered_count, l.total_donated::float8 AS total_donated,
  l.last_donated_on, l.created_at, l.updated_at`;
const ACTIVITY_COLS = `
  a.id, a.lead_id, a.channel, a.outcome, a.note, a.next_follow_up_at, a.amount::float8 AS amount,
  a.donated_on, a.payment_mode, a.purpose, a.reference, a.created_at`;

/** Devotees only, and only while they are still on the devotee list. */
async function devoteeOnly(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== 'devotee') {
    return res.status(403).json({ error: 'This part of DRM is for devotees only.' });
  }
  try {
    const on = await pool.query(`SELECT 1 FROM devotees WHERE user_id = $1 AND active`, [req.user.userId]);
    if (!on.rows.length) {
      return res.status(403).json({ error: 'Your devotee access has been switched off. Please contact the temple office.' });
    }
    next();
  } catch (err) {
    console.error('devoteeLeads.guard error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

router.use(authenticate, devoteeOnly);

/** One place for the 500: the devotee sees a plain sentence, the log gets the detail. */
const handle =
  (name: string, fn: (req: Request, res: Response, owner: string) => Promise<unknown>) =>
  async (req: Request, res: Response) => {
    try {
      await fn(req, res, req.user!.userId);
    } catch (err) {
      console.error(`devoteeLeads.${name} error:`, err);
      if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  };

const isUniquePhone = (err: unknown) => (err as { code?: string; constraint?: string }).code === '23505';

async function duplicateOf(owner: string, phone: string) {
  return (await pool.query(`SELECT id, name FROM devotee_leads WHERE owner_id = $1 AND phone = $2`, [owner, phone])).rows[0] as
    | { id: string; name: string }
    | undefined;
}

router.get(
  '/config',
  handle('config', async (_req, res) => {
    res.json({
      maps_key: process.env.GOOGLE_MAPS_API_KEY?.trim() || null,
      map_id: process.env.GOOGLE_MAPS_MAP_ID?.trim() || null,
      push_key: pushPublicKey(),
    });
  })
);

router.get(
  '/summary',
  handle('summary', async (_req, res, owner) => {
    const [totals, byStatus, month, doneToday, due, recent] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE next_follow_up_at < NOW())::int AS overdue,
                COUNT(*) FILTER (WHERE next_follow_up_at >= NOW() AND next_follow_up_at < ${TODAY_END})::int AS due_today,
                COUNT(*) FILTER (WHERE next_follow_up_at >= ${TODAY_END}
                                   AND next_follow_up_at < ${TODAY_END} + INTERVAL '7 days')::int AS upcoming_week,
                COUNT(*) FILTER (WHERE total_donated > 0)::int AS donors,
                COALESCE(SUM(total_donated), 0)::float8 AS donated_total,
                COUNT(*) FILTER (WHERE created_at >= ${TODAY_START})::int AS added_today
           FROM devotee_leads WHERE owner_id = $1`,
        [owner]
      ),
      pool.query(`SELECT status, COUNT(*)::int AS n FROM devotee_leads WHERE owner_id = $1 GROUP BY status`, [owner]),
      pool.query(
        `SELECT COALESCE(SUM(amount), 0)::float8 AS amount, COUNT(*)::int AS gifts
           FROM devotee_lead_activities
          WHERE owner_id = $1 AND outcome = 'donated' AND donated_on >= ${MONTH_START}`,
        [owner]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM devotee_lead_activities
          WHERE owner_id = $1 AND outcome IS NOT NULL AND created_at >= ${TODAY_START}`,
        [owner]
      ),
      pool.query(
        `SELECT ${LEAD_COLS} FROM devotee_leads l
          WHERE l.owner_id = $1 AND l.next_follow_up_at < ${TODAY_END}
          ORDER BY l.next_follow_up_at LIMIT 25`,
        [owner]
      ),
      pool.query(
        `SELECT ${ACTIVITY_COLS}, l.name AS lead_name
           FROM devotee_lead_activities a JOIN devotee_leads l ON l.id = a.lead_id
          WHERE a.owner_id = $1
          ORDER BY a.created_at DESC LIMIT 8`,
        [owner]
      ),
    ]);
    res.json({
      ...totals.rows[0],
      by_status: Object.fromEntries(byStatus.rows.map((r) => [r.status, r.n])),
      donated_this_month: month.rows[0].amount,
      gifts_this_month: month.rows[0].gifts,
      follow_ups_done_today: doneToday.rows[0].n,
      due: due.rows,
      recent: recent.rows,
    });
  })
);

const SORTS: Record<string, string> = {
  // Due first (overdue at the top), then those with no follow-up, newest touched first.
  due: 'l.next_follow_up_at ASC NULLS LAST, l.updated_at DESC',
  recent: 'l.updated_at DESC',
  created: 'l.created_at DESC',
  name: 'lower(l.name) ASC',
  donated: 'l.total_donated DESC, l.updated_at DESC',
};

router.get(
  '/leads',
  handle('list', async (req, res, owner) => {
    const where = ['l.owner_id = $1'];
    const vals: unknown[] = [owner];
    const param = (v: unknown) => {
      vals.push(v);
      return `$${vals.length}`;
    };

    const q = String(req.query.q ?? '').trim().slice(0, 100);
    if (q) {
      const like = param(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      const digits = q.replace(/\D/g, '');
      where.push(
        `(l.name ILIKE ${like} OR l.area ILIKE ${like} OR l.city ILIKE ${like} OR l.organisation ILIKE ${like}` +
          (digits.length >= 3 ? ` OR l.phone LIKE ${param(`%${digits}%`)} OR l.alt_phone LIKE ${param(`%${digits}%`)}` : '') +
          ')'
      );
    }
    const status = String(req.query.status ?? '');
    if ((STATUSES as readonly string[]).includes(status)) where.push(`l.status = ${param(status)}`);
    const priority = String(req.query.priority ?? '');
    if (['hot', 'warm', 'cold'].includes(priority)) where.push(`l.priority = ${param(priority)}`);
    const due = String(req.query.due ?? '');
    if (due === 'overdue') where.push('l.next_follow_up_at < NOW()');
    else if (due === 'today') where.push(`l.next_follow_up_at >= NOW() AND l.next_follow_up_at < ${TODAY_END}`);
    else if (due === 'due') where.push(`l.next_follow_up_at < ${TODAY_END}`);
    else if (due === 'upcoming') where.push(`l.next_follow_up_at >= ${TODAY_END}`);
    else if (due === 'none') where.push('l.next_follow_up_at IS NULL');

    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '25'), 10) || 25, 1), 100);
    const page = Math.max(parseInt(String(req.query.page ?? '1'), 10) || 1, 1);
    const order = SORTS[String(req.query.sort ?? 'due')] ?? SORTS.due;
    const filter = where.join(' AND ');

    const [rows, count, counts] = await Promise.all([
      pool.query(
        `SELECT ${LEAD_COLS} FROM devotee_leads l WHERE ${filter}
          ORDER BY ${order} LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        vals
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM devotee_leads l WHERE ${filter}`, vals),
      pool.query(`SELECT status, COUNT(*)::int AS n FROM devotee_leads WHERE owner_id = $1 GROUP BY status`, [owner]),
    ]);
    const total = count.rows[0].n as number;
    res.json({
      rows: rows.rows,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      counts: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])),
    });
  })
);

router.get(
  '/leads/map',
  handle('map', async (_req, res, owner) => {
    const [pins, missing] = await Promise.all([
      pool.query(
        `SELECT l.id, l.name, l.phone, l.status, l.priority, l.address_line, l.area, l.city, l.pincode,
                l.latitude, l.longitude, l.next_follow_up_at, l.total_donated::float8 AS total_donated
           FROM devotee_leads l
          WHERE l.owner_id = $1 AND l.latitude IS NOT NULL AND l.longitude IS NOT NULL
          ORDER BY l.updated_at DESC LIMIT 2000`,
        [owner]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM devotee_leads WHERE owner_id = $1 AND (latitude IS NULL OR longitude IS NULL)`,
        [owner]
      ),
    ]);
    res.json({ rows: pins.rows, without_location: missing.rows[0].n });
  })
);

router.get(
  '/leads/:id',
  handle('get', async (req, res, owner) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Lead not found.' });
    const lead = (await pool.query(`SELECT ${LEAD_COLS} FROM devotee_leads l WHERE l.id = $1 AND l.owner_id = $2`, [id, owner])).rows[0];
    if (!lead) return res.status(404).json({ error: 'Lead not found.' });
    const [activities, calls] = await Promise.all([
      pool.query(
        `SELECT ${ACTIVITY_COLS} FROM devotee_lead_activities a
          WHERE a.lead_id = $1 AND a.owner_id = $2 ORDER BY a.created_at DESC LIMIT 200`,
        [id, owner]
      ),
      pool.query(
        `SELECT c.id, c.direction, c.started_at, c.duration_seconds, c.from_app, c.recording_status
           FROM devotee_calls c
          WHERE c.lead_id = $1 AND c.owner_id = $2
          ORDER BY c.started_at DESC LIMIT 100`,
        [id, owner]
      ),
    ]);
    res.json({ lead, activities: activities.rows, calls: calls.rows });
  })
);

router.post(
  '/leads',
  handle('create', async (req, res, owner) => {
    const parsed = parseLead(req.body, 'create');
    if (parsed.error !== undefined) return res.status(400).json({ error: parsed.error });
    const f = parsed.fields;
    const existing = await duplicateOf(owner, f.phone as string);
    if (existing) {
      return res.status(409).json({ error: `${existing.name} is already in your leads with this number.`, lead_id: existing.id });
    }
    const cols = Object.keys(f);
    const vals = Object.values(f);
    try {
      const row = (
        await pool.query(
          `INSERT INTO devotee_leads (owner_id, ${cols.join(', ')})
           VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
           RETURNING id`,
          [owner, ...vals]
        )
      ).rows[0];
      const lead = (await pool.query(`SELECT ${LEAD_COLS} FROM devotee_leads l WHERE l.id = $1`, [row.id])).rows[0];
      res.status(201).json({ lead });
    } catch (err) {
      // Two saves of the same new lead at once: the second finds the first.
      if (isUniquePhone(err)) {
        const dup = await duplicateOf(owner, f.phone as string);
        return res.status(409).json({ error: 'This number is already in your leads.', lead_id: dup?.id });
      }
      throw err;
    }
  })
);

/**
 * Upload many leads from an Excel or CSV file: { filename, base64, apply }. Without apply it only
 * checks and reports (ready, already in your leads, problems by row); with apply it adds the rows
 * that are ready. Nothing already there is changed.
 */
router.post(
  '/leads/import',
  handle('import', async (req, res, owner) => {
    const filename = String(req.body?.filename ?? 'leads.csv').slice(0, 255);
    const base64 = String(req.body?.base64 ?? '');
    if (!base64) return res.status(400).json({ error: 'No file received.' });
    const existing = new Set<string>(
      (await pool.query(`SELECT phone FROM devotee_leads WHERE owner_id = $1`, [owner])).rows.map((r) => r.phone as string)
    );
    let report;
    try {
      report = await readLeadFile(Buffer.from(base64, 'base64'), filename, existing);
    } catch (err) {
      const e = err as Error & { status?: number };
      return res.status(e.status ?? 400).json({ error: e.message || 'Could not read this file.' });
    }
    const summary = {
      sheet: report.sheet,
      columns: report.columns,
      total: report.total,
      ready: report.ready.length,
      problems: report.problems,
      duplicates: report.duplicates,
      preview: report.ready.slice(0, 8).map((r) => ({
        row: r.row,
        name: r.fields.name,
        phone: r.fields.phone,
        area: r.fields.area ?? r.fields.city ?? null,
        follow_up: r.fields.next_follow_up_at ? atTemple((r.fields.next_follow_up_at as Date).toISOString()) : null,
      })),
    };
    if (req.body?.apply !== true) return res.json({ ...summary, added: 0 });

    // All or nothing, so a fault part-way never leaves half a file in.
    const client = await pool.connect();
    let added = 0;
    try {
      await client.query('BEGIN');
      for (const r of report.ready) {
        const cols = Object.keys(r.fields);
        const ins = await client.query(
          `INSERT INTO devotee_leads (owner_id, ${cols.join(', ')})
           VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
           ON CONFLICT (owner_id, phone) DO NOTHING`,
          [owner, ...Object.values(r.fields)]
        );
        added += ins.rowCount ?? 0;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    res.json({ ...summary, added });
  })
);

router.patch(
  '/leads/:id',
  handle('update', async (req, res, owner) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Lead not found.' });
    const parsed = parseLead(req.body, 'update');
    if (parsed.error !== undefined) return res.status(400).json({ error: parsed.error });
    const f = parsed.fields;
    if (!Object.keys(f).length) return res.status(400).json({ error: 'Nothing to change.' });

    if (typeof f.phone === 'string') {
      const dup = await duplicateOf(owner, f.phone);
      if (dup && dup.id !== id) {
        return res.status(409).json({ error: `${dup.name} is already in your leads with this number.`, lead_id: dup.id });
      }
    }
    const vals: unknown[] = [id, owner];
    const sets = Object.entries(f).map(([k, v]) => {
      vals.push(v);
      return `${k} = $${vals.length}`;
    });
    // A new follow-up time is a new reminder.
    if ('next_follow_up_at' in f) sets.push('reminder_sent_at = NULL');
    try {
      const done = await pool.query(
        `UPDATE devotee_leads SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 AND owner_id = $2 RETURNING id`,
        vals
      );
      if (!done.rows.length) return res.status(404).json({ error: 'Lead not found.' });
    } catch (err) {
      if (isUniquePhone(err)) return res.status(409).json({ error: 'This number is already in your leads.' });
      throw err;
    }
    const lead = (await pool.query(`SELECT ${LEAD_COLS} FROM devotee_leads l WHERE l.id = $1`, [id])).rows[0];
    res.json({ lead });
  })
);

router.delete(
  '/leads/:id',
  handle('delete', async (req, res, owner) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Lead not found.' });
    // Its recordings go from storage too, not only their rows.
    await deleteRecordingsForLead(owner, id);
    const done = await pool.query(`DELETE FROM devotee_leads WHERE id = $1 AND owner_id = $2 RETURNING id`, [id, owner]);
    if (!done.rows.length) return res.status(404).json({ error: 'Lead not found.' });
    res.json({ deleted: true });
  })
);

router.post(
  '/leads/:id/activities',
  handle('activity', async (req, res, owner) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Lead not found.' });
    const parsed = parseActivity(req.body);
    if (parsed.error !== undefined) return res.status(400).json({ error: parsed.error });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const done = await logActivity(client, owner, id, parsed.input);
      if (!done) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Lead not found.' });
      }
      await client.query('COMMIT');
      const lead = (await pool.query(`SELECT ${LEAD_COLS} FROM devotee_leads l WHERE l.id = $1`, [id])).rows[0];
      const activity = (
        await pool.query(`SELECT ${ACTIVITY_COLS} FROM devotee_lead_activities a WHERE a.id = $1`, [done.activity.id])
      ).rows[0];
      res.status(201).json({ lead, activity });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  })
);

router.get(
  '/reminders',
  handle('reminders', async (_req, res, owner) => {
    // Due in the last week (still waiting) and everything set for the next 30 days: enough for the
    // page to alert while open and for the Android app to schedule ahead.
    const rows = await pool.query(
      `SELECT l.id, l.name, l.phone, l.status, l.next_follow_up_at
         FROM devotee_leads l
        WHERE l.owner_id = $1
          AND l.next_follow_up_at > NOW() - INTERVAL '7 days'
          AND l.next_follow_up_at < NOW() + INTERVAL '30 days'
        ORDER BY l.next_follow_up_at
        LIMIT 200`,
      [owner]
    );
    res.json({ rows: rows.rows, now: new Date().toISOString() });
  })
);

router.get(
  '/calls/:id/recording',
  handle('recording', async (req, res, owner) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'No recording for this call.' });
    // owner_id = the signed-in devotee: a recording is theirs to hear and nobody else's.
    const call = (
      await pool.query(
        `SELECT recording_key, recording_type FROM devotee_calls WHERE id = $1 AND owner_id = $2 AND recording_status = 'uploaded'`,
        [id, owner]
      )
    ).rows[0];
    if (!call) return res.status(404).json({ error: 'No recording for this call.' });
    const file = await storage.getObject(call.recording_key);
    if (!file) return res.status(404).json({ error: 'The recording could not be fetched. Try again.' });

    res.setHeader('Content-Type', call.recording_type || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, no-store');
    const range = String(req.headers.range ?? '');
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] || m[2])) {
      const size = file.length;
      const start = Math.max(0, m[1] ? Number(m[1]) : size - Number(m[2]));
      const end = Math.min(size - 1, m[1] && m[2] ? Number(m[2]) : size - 1);
      if (start > end) return res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
      res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      return res.end(file.subarray(start, end + 1));
    }
    res.setHeader('Content-Length', String(file.length));
    res.end(file);
  })
);

/* ------------------------------------------------------------------ receipts */
//
// Raised straight to DCC (services/devoteeDcc.ts) - not through the HKM site, and nothing the
// office or callers use is involved. DCC numbers the receipt, DRM draws the PDF, and no WhatsApp
// is sent: the devotee shares the receipt with the donor from their own phone.

const RECEIPT_COLS = `
  r.id, r.lead_id, r.account, r.seva_name, r.donor_name, r.donor_mobile, r.on_name_of,
  r.amount::float8 AS amount, r.payment_mode, r.reference, r.paid_on, r.receipt_number, r.share_token,
  r.status, r.dcc_error, r.created_at`;

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const PAY_MODES: PayMode[] = ['cash', 'upi', 'cheque', 'bank'];
/** The devotee's own payment words, for the lead's history. */
const LEAD_MODE: Record<PayMode, string> = { cash: 'cash', upi: 'upi', cheque: 'cheque', bank: 'bank_transfer' };

/** The devotee's lead for a donor: the one the receipt was raised from, else theirs with this number. */
async function leadForReceipt(owner: string, leadId: unknown, mobile: string): Promise<string | null> {
  if (typeof leadId === 'string' && UUID_RE.test(leadId)) {
    const r = await pool.query(`SELECT id FROM devotee_leads WHERE id = $1 AND owner_id = $2`, [leadId, owner]);
    if (r.rows.length) return r.rows[0].id;
  }
  const r = await pool.query(`SELECT id FROM devotee_leads WHERE owner_id = $1 AND phone = $2`, [owner, mobile]);
  return (r.rows[0]?.id as string | undefined) ?? null;
}

/**
 * An issued receipt, on the devotee's side: on the donor's lead (made if they have none) and in
 * its history as a donation. The receipt is already numbered by DCC, so nothing here may fail it.
 */
async function fileOnLead(owner: string, row: DevoteeReceiptRow & { lead_id: string | null }, receiptNumber: string) {
  try {
    let leadId = row.lead_id ?? (await leadForReceipt(owner, null, row.donor_mobile));
    if (!leadId) {
      leadId = (
        await pool.query(
          `INSERT INTO devotee_leads (owner_id, name, phone, email, interest, source)
           VALUES ($1, $2, $3, $4, 'general', 'personal')
           ON CONFLICT (owner_id, phone) DO UPDATE SET updated_at = NOW()
           RETURNING id`,
          [owner, row.donor_name.slice(0, 160), row.donor_mobile, row.donor_email]
        )
      ).rows[0].id as string;
    }
    await pool.query(`UPDATE devotee_receipts SET lead_id = $2 WHERE id = $1`, [row.id, leadId]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await logActivity(client, owner, leadId, {
        outcome: 'donated',
        channel: null,
        note: `Receipt raised - No. ${receiptNumber}`,
        next_follow_up_at: undefined,
        donation: {
          amount: Number(row.amount),
          donated_on: row.paid_on ?? istDate(),
          payment_mode: LEAD_MODE[row.payment_mode],
          purpose: row.seva_name?.slice(0, 120) ?? null,
          reference: receiptNumber.slice(0, 80),
        },
      });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    return leadId;
  } catch (e) {
    console.error('devoteeLeads.fileOnLead failed (non-fatal):', (e as Error).message);
    return row.lead_id;
  }
}

/** Send to DCC and answer the devotee: the receipt, or why it is not issued yet (it is kept to retry). */
async function issueAndAnswer(res: Response, owner: string, id: string, created: boolean) {
  const row = (await pool.query(`SELECT * FROM devotee_receipts WHERE id = $1 AND owner_id = $2`, [id, owner])).rows[0];
  const out = await issueDevoteeReceipt(row);
  if (!out.ok) {
    return res.status(502).json({
      error: `DCC did not issue the receipt: ${out.error} It is saved on your Receipts page - try again from there.`,
      id,
      status: 'failed',
    });
  }
  const leadId = await fileOnLead(owner, row, out.receiptNumber);
  const saved = (await pool.query(`SELECT ${RECEIPT_COLS} FROM devotee_receipts r WHERE r.id = $1`, [id])).rows[0];
  res.status(created ? 201 : 200).json({ ...saved, receiptNumber: out.receiptNumber, lead_id: leadId });
}

router.get(
  '/receipts',
  handle('receipts', async (req, res, owner) => {
    const q = String(req.query.q ?? '').trim().slice(0, 100);
    const vals: unknown[] = [owner];
    let where = 'r.owner_id = $1';
    if (q) {
      vals.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      where += ` AND (r.donor_name ILIKE $2 OR r.donor_mobile LIKE $2 OR r.receipt_number ILIKE $2 OR r.seva_name ILIKE $2)`;
    }
    const [rows, totals] = await Promise.all([
      pool.query(`SELECT ${RECEIPT_COLS} FROM devotee_receipts r WHERE ${where} ORDER BY r.created_at DESC LIMIT 200`, vals),
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'issued')::int AS count,
                COALESCE(SUM(amount) FILTER (WHERE status = 'issued'), 0)::float8 AS amount,
                COALESCE(SUM(amount) FILTER (WHERE status = 'issued' AND paid_on >= ${MONTH_START}), 0)::float8 AS this_month,
                COUNT(*) FILTER (WHERE status <> 'issued')::int AS not_issued
           FROM devotee_receipts WHERE owner_id = $1`,
        [owner]
      ),
    ]);
    res.json({ rows: rows.rows, ...totals.rows[0] });
  })
);

/** Raise a receipt: check it, keep it, send it to DCC. */
router.post(
  '/receipts',
  handle('raiseReceipt', async (req, res, owner) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = String(b.donor_name ?? '').trim().replace(/\s+/g, ' ');
    const mobile = String(b.donor_mobile ?? '').replace(/\D/g, '').slice(-10);
    const email = String(b.donor_email ?? '').trim().toLowerCase();
    const amount = Number(b.amount);
    const mode = String(b.payment_mode) as PayMode;
    const ref = String(b.reference_no ?? '').trim();
    const want80G = b.want_certificate === true;
    const pan = String(b.pan_number ?? '').trim().toUpperCase();
    const address = String(b.address ?? b.prasadam_address ?? '').trim();
    const paidOn = typeof b.payment_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.payment_date) ? b.payment_date : istDate();

    // The same checks as the office's receipts, so DCC never sees an entry it would refuse.
    if (!name) return res.status(400).json({ error: 'Enter the Donor Name.' });
    if (mobile.length !== 10) return res.status(400).json({ error: 'Enter a 10-digit Mobile Number.' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'That email address does not look right.' });
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e8) return res.status(400).json({ error: 'Enter a valid amount.' });
    if (!PAY_MODES.includes(mode)) return res.status(400).json({ error: 'Pick Cash, UPI, Cheque or Bank Transfer.' });
    if (mode !== 'cash' && !ref) return res.status(400).json({ error: mode === 'cheque' ? 'Enter the Cheque No.' : 'Enter the Transaction ID (UTR).' });
    if ((mode === 'upi' || mode === 'bank') && ref.length < 12) return res.status(400).json({ error: 'The Transaction ID (UTR) must be at least 12 characters.' });
    if (paidOn > istDate()) return res.status(400).json({ error: 'The date cannot be in the future.' });
    if (want80G && !PAN_RE.test(pan)) return res.status(400).json({ error: 'Enter a valid PAN Number for 80G.' });
    if (want80G && !address) return res.status(400).json({ error: 'Enter the Address for 80G.' });
    const seva = await resolveSeva(b.seva_catalog_id);
    if (!seva) return res.status(400).json({ error: 'Choose the Seva.' });
    const dcc = dccSevaOf(seva);

    // The id DCC de-duplicates on: the UTR or cheque number, or for cash one made here.
    const txn =
      mode === 'cash'
        ? `DV-CASH-${istDate().replace(/-/g, '')}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`
        : mode === 'cheque'
        ? `CHQ-${ref}`.slice(0, 80)
        : ref.slice(0, 80);
    const taken = (
      await pool.query(`SELECT receipt_number, status FROM devotee_receipts WHERE transaction_id = $1`, [txn])
    ).rows[0];
    if (taken) {
      return res.status(409).json({
        error: taken.receipt_number
          ? `This ${mode === 'cheque' ? 'cheque' : 'UTR'} already has a receipt (No. ${taken.receipt_number}).`
          : `A receipt for this ${mode === 'cheque' ? 'cheque' : 'UTR'} is already on your Receipts page - retry it from there.`,
      });
    }

    const enrolled = await enrolledByFor(owner);
    const pin = /\b(\d{6})\b/.exec(address)?.[1] ?? null;
    let id: string;
    try {
      id = (
        await pool.query(
          `INSERT INTO devotee_receipts
             (owner_id, lead_id, account, seva_catalog_id, seva_name, dcc_seva_category, dcc_seva_sub_category,
              dcc_seva_sub_category_code, donor_name, donor_mobile, donor_email, pan, address, pincode, on_name_of,
              amount, payment_mode, reference, transaction_id, paid_on, enrolled_by_id, enrolled_by_code, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, 'pending')
           RETURNING id`,
          [
            owner, await leadForReceipt(owner, b.lead_id, mobile), dccAccountTypeOf(seva) === 5 ? 'TSC' : 'HKMI', seva.id,
            seva.name.slice(0, 200), dcc.category, dcc.subCategory, String(dcc.subCategoryCode).slice(0, 40),
            name.slice(0, 160), mobile, email || null, want80G ? pan : null, address.slice(0, 500) || null, pin,
            String(b.sevak_name ?? '').trim().slice(0, 160) || null, amount, mode, ref.slice(0, 80) || null, txn, paidOn,
            enrolled.id, enrolled.code,
          ]
        )
      ).rows[0].id;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return res.status(409).json({ error: 'This payment already has a receipt.' });
      throw err;
    }
    await issueAndAnswer(res, owner, id, true);
  })
);

/** Send a receipt DCC did not issue again. DCC recognises the transaction, so it is never issued twice. */
router.post(
  '/receipts/:id/retry',
  handle('retryReceipt', async (req, res, owner) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Receipt not found.' });
    const row = (await pool.query(`SELECT status FROM devotee_receipts WHERE id = $1 AND owner_id = $2`, [id, owner])).rows[0];
    if (!row) return res.status(404).json({ error: 'Receipt not found.' });
    if (row.status === 'issued') return res.status(409).json({ error: 'This receipt is already issued.' });
    await issueAndAnswer(res, owner, id, false);
  })
);

/** The receipt PDF, for the devotee who raised it. */
router.get(
  '/receipts/:id/file',
  handle('receiptFile', async (req, res, owner) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Receipt not found.' });
    const row = (await pool.query(`SELECT * FROM devotee_receipts WHERE id = $1 AND owner_id = $2`, [id, owner])).rows[0];
    if (!row) return res.status(404).json({ error: 'Receipt not found.' });
    if (row.status !== 'issued') return res.status(409).json({ error: 'This receipt is not issued yet. Retry it first.' });
    const pdf = await renderDevoteeReceipt(row);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="receipt-${String(row.receipt_number).replace(/[^a-zA-Z0-9-]/g, '-')}.pdf"`);
    res.send(pdf);
  })
);

router.post(
  '/push/subscribe',
  handle('pushSubscribe', async (req, res, owner) => {
    if (!pushPublicKey()) return res.status(503).json({ error: 'Phone reminders are not set up on the server yet.' });
    const ok = await saveSubscription(owner, req.body, String(req.headers['user-agent'] ?? ''));
    if (!ok) return res.status(400).json({ error: 'This browser did not give a valid subscription.' });
    res.json({ ok: true });
  })
);

router.post(
  '/push/unsubscribe',
  handle('pushUnsubscribe', async (req, res, owner) => {
    await removeSubscription(owner, (req.body as { endpoint?: unknown })?.endpoint);
    res.json({ ok: true });
  })
);

export default router;
