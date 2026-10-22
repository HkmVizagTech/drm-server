// The seva wall: donors to the three temple-building sevas - Mandir nirmana,
// Brick and Square foot - whose name goes on the wall once they have given
// Rs 1,500 or more in one donation, and the life of each brick from "to print"
// to "sent to the donor".
//
// WHO DOES WHAT
//   admin                    everything, and the only one who can add a record
//                            or set a priority
//   brick_printer            sees ONLY the "bricks to print" table, read-only, and
//                            uploads the picture of the printed brick - and can
//                            look at it and replace it until a caller starts on it.
//                            Never sees a phone number, an amount or a receipt.
//   caller (e.g. Manas)      sees the Seva wall table - bricks whose picture is
//                            uploaded - calls the donor, sends the picture on
//                            WhatsApp, and records both ("call answered", "sent"),
//                            or sends a bad picture back to the printer
//   accountant, coordinator  can look at everything, change nothing
//
// STATUS
//   to_print -> in_review (printer uploads) -> sent (picture sent on WhatsApp)
//                  |  "call answered" is a mark on in_review, not a status
//                  \-> needs_reprint (sent back with a reason) -> in_review ...
//
// THE SEVA WALL TABLE ORDER (what a caller works through, top to bottom)
//   1. uploaded, not called, not sent     (longest waiting first)
//   2. called, picture not sent yet       (longest waiting first)
//   3. sent                               (most recent first)
// THE PRINT TABLE ORDER
//   sent-back bricks first, then high priority, then the oldest donation.
//
// THE LIST IS A QUERY, NOT A COPY. A donation that is one of these sevas, from
// the main site (or entered in DRM), of Rs 1,500 or more IS a row - nothing has
// to be added, and nothing is backfilled. seva_wall_items only holds what a
// donation cannot say (status, priority) and the records an admin adds by hand.
// A donation with no item row yet simply reads as "to print, medium".
//
// Annadan's own "brick seva" entries are not listed: the wall is HKM Vizag's.
//
// A brick has ONE picture. A new upload replaces the old one and the old file is
// deleted, so storage holds only pictures somebody will look at and the same
// picture is never kept twice. The record of what happened (uploaded, replaced,
// sent back and why) stays in seva_wall_events.

import { Router, Request, Response, NextFunction } from 'express';
import { createHash, randomUUID } from 'crypto';
import pool from '../db/pool';
import { authenticate } from '../middleware/auth';
import { isConfigured, putObject, getObject, deleteObject, publicUrl } from '../services/storage';
import type { UserRole } from '../types';

const router = Router();
router.use(authenticate);

export const WALL_MIN_AMOUNT = 1500;

/** Which wall seva a donation is, from its purpose and then the page it came from. */
export const WALL_KIND_SQL = `
  CASE
    WHEN d.purpose ~* 'brick'                         THEN 'brick'
    WHEN d.purpose ~* '(square|sq\\.? ?f|sqft)'       THEN 'square'
    WHEN d.purpose ~* 'mandir|mandhir'                THEN 'mandir'
    WHEN d.source_page ~* 'brick'                     THEN 'brick'
    WHEN d.source_page ~* '(sqft|square)'             THEN 'square'
    WHEN d.source_page ~* 'mandir'                    THEN 'mandir'
  END`;

const KINDS = ['brick', 'square', 'mandir'] as const;
const PRIORITIES = ['high', 'medium', 'low'] as const;
const VIEWS = ['contact', 'print', 'all'] as const;
type View = (typeof VIEWS)[number];

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const onTestDatabase = (): boolean =>
  /_test$/.test((process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '');

/* ------------------------------------------------------------------ roles */

const LOOK: UserRole[] = ['admin', 'accountant', 'volunteer_coordinator', 'caller', 'brick_printer'];
const MANAGE: UserRole[] = ['admin'];
const UPLOAD: UserRole[] = ['admin', 'brick_printer'];
const REVIEW: UserRole[] = ['admin', 'caller'];

function allow(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Your account cannot do that on the seva wall.' });
    }
    next();
  };
}

/** The statuses a list view shows. */
const VIEW_STATUSES: Record<View, string[] | null> = {
  all: null,
  print: ['to_print', 'needs_reprint'],
  contact: ['in_review', 'sent'],
};
const STAGES = ['to_call', 'called', 'sent', 'uploaded'] as const;

/** Which views a role may open, and which one it gets by default. */
function viewsFor(role: UserRole): { allowed: View[]; fallback: View } {
  if (role === 'brick_printer') return { allowed: ['print'], fallback: 'print' };
  if (role === 'caller') return { allowed: ['contact'], fallback: 'contact' };
  return { allowed: ['contact', 'print', 'all'], fallback: 'contact' };
}

/* -------------------------------------------------------------- the wall */

const DERIVED = `
  SELECT d.id AS ref, i.id AS item_id, 'donation'::text AS origin,
         COALESCE(NULLIF(d.given_name, ''), p.name)  AS donor_name,
         NULLIF(d.sevak_name, '')                    AS honoree_name,
         p.phone                                     AS phone,
         d.amount::float8                            AS amount,
         d.receipt_number                            AS receipt_number,
         (${WALL_KIND_SQL})                          AS kind,
         d.created_at                                AS donated_at,
         COALESCE(i.priority, 'medium')::text        AS priority,
         COALESCE(i.status, 'to_print')::text        AS status,
         i.review_note, i.reviewed_at, i.called_at, i.called_by, i.sent_at, i.sent_by
    FROM live_donations d
    JOIN live_people p ON p.id = d.person_id
    LEFT JOIN seva_wall_items i ON i.donation_id = d.id
   WHERE d.amount >= ${WALL_MIN_AMOUNT}
     AND COALESCE(d.source_site, 'hkmv') <> 'annadan'
     AND (${WALL_KIND_SQL}) IS NOT NULL`;

const MANUAL = `
  SELECT i.id AS ref, i.id AS item_id, 'manual'::text AS origin,
         i.donor_name, i.honoree_name, i.phone, i.amount::float8, i.receipt_number,
         i.kind::text, COALESCE(i.donated_on::timestamptz, i.created_at),
         i.priority::text, i.status::text, i.review_note, i.reviewed_at, i.called_at, i.called_by, i.sent_at, i.sent_by
    FROM seva_wall_items i
   WHERE i.donation_id IS NULL`;

const WALL = `(${DERIVED} UNION ALL ${MANUAL}) w`;

const PICTURE = `
  LEFT JOIN LATERAL (
    SELECT sp.id, sp.r2_key, sp.uploaded_at
      FROM seva_wall_pictures sp
     WHERE sp.item_id = w.item_id AND sp.state = 'current'
     ORDER BY sp.uploaded_at DESC LIMIT 1
  ) pic ON TRUE`;

const PRIORITY_RANK = `CASE w.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

/** What a brick printer is allowed to know about a row. No contact, money or receipt. */
function forPrinter(row: Record<string, unknown>) {
  const { ref, donor_name, honoree_name, kind, donated_at, priority, status, review_note, reviewed_at, has_image, uploaded_at } = row;
  return { ref, donor_name, honoree_name, kind, donated_at, priority, status, review_note, reviewed_at, has_image, uploaded_at };
}

router.get('/', allow(...LOOK), async (req, res) => {
  const role = req.user!.role;
  const { allowed, fallback } = viewsFor(role);
  const asked = String(req.query.view ?? '') as View;
  const view: View = allowed.includes(asked) ? asked : fallback;

  const kind = (KINDS as readonly string[]).includes(String(req.query.kind)) ? String(req.query.kind) : null;
  const priority = (PRIORITIES as readonly string[]).includes(String(req.query.priority))
    ? String(req.query.priority)
    : null;
  const stage = (STAGES as readonly string[]).includes(String(req.query.stage)) ? String(req.query.stage) : null;
  const search = String(req.query.search ?? '').trim();
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));

  const where: string[] = [];
  const values: unknown[] = [];

  // Which statuses this role may see at all, then which the view picks from those.
  // A printer also sees what they uploaded and nobody has started on yet, so they
  // can look at it and replace it; once a caller has called, it is locked.
  const roleStatuses =
    role === 'brick_printer'
      ? ['to_print', 'needs_reprint', 'in_review']
      : role === 'caller'
      ? ['in_review', 'sent']
      : null;
  const uploadedTab = view === 'print' && stage === 'uploaded';
  const viewStatuses = uploadedTab ? ['in_review'] : VIEW_STATUSES[view];
  const statuses = roleStatuses && viewStatuses ? viewStatuses.filter((s) => roleStatuses.includes(s)) : viewStatuses ?? roleStatuses;
  if (statuses) {
    values.push(statuses);
    where.push(`w.status = ANY($${values.length}::text[])`);
  }
  if (stage === 'to_call' || uploadedTab) where.push(`w.status = 'in_review' AND w.called_at IS NULL`);
  if (stage === 'called') where.push(`w.status = 'in_review' AND w.called_at IS NOT NULL`);
  if (stage === 'sent') where.push(`w.status = 'sent'`);
  if (kind) {
    values.push(kind);
    where.push(`w.kind = $${values.length}`);
  }
  if (priority) {
    values.push(priority);
    where.push(`w.priority = $${values.length}`);
  }
  if (search && role !== 'brick_printer') {
    values.push(`%${search}%`);
    const n = values.length;
    where.push(`(w.donor_name ILIKE $${n} OR w.honoree_name ILIKE $${n} OR w.phone ILIKE $${n} OR w.receipt_number ILIKE $${n})`);
  } else if (search) {
    // A printer searches by name only: the phone and receipt are not theirs to see.
    values.push(`%${search}%`);
    const n = values.length;
    where.push(`(w.donor_name ILIKE $${n} OR w.honoree_name ILIKE $${n})`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // The print list is the printer's work queue. A brick a reviewer sent back comes
  // first - somebody is waiting on it and it has already been done once - then
  // the most urgent, and within the same urgency the OLDEST donation first, so a
  // brick promised a month ago never sits behind one that came in this morning.
  //
  // The Seva wall table is what a caller works through top to bottom: pictures
  // nobody has acted on, then donors already called whose picture still has to go
  // out, then everything already sent. Longest waiting first inside each.
  const order =
    uploadedTab
      ? `pic.uploaded_at DESC NULLS LAST, w.ref`
      : view === 'print'
      ? `(w.status = 'needs_reprint') DESC, ${PRIORITY_RANK}, w.donated_at ASC, w.ref`
      : view === 'contact'
      ? `CASE WHEN w.status = 'sent' THEN 3 WHEN w.called_at IS NOT NULL THEN 2 ELSE 1 END,
         CASE WHEN w.status <> 'sent' THEN pic.uploaded_at END ASC NULLS LAST,
         w.sent_at DESC NULLS LAST, w.ref`
      : `w.donated_at DESC, w.ref`;

  try {
    const [rows, count, tally] = await Promise.all([
      pool.query(
        `SELECT w.*, pic.id AS picture_id, pic.r2_key, pic.uploaded_at AS picture_at,
                su.name AS sent_by_name, cu.name AS called_by_name
           FROM ${WALL} ${PICTURE}
           LEFT JOIN users su ON su.id = w.sent_by
           LEFT JOIN users cu ON cu.id = w.called_by
           ${clause}
          ORDER BY ${order}
          LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        values
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM ${WALL} ${clause}`, values),
      // Counts ignore the view's own filters on purpose: they say how much work
      // is in each stage, not how big the current list is.
      pool.query(
        `SELECT w.status, (w.called_at IS NOT NULL) AS called, COUNT(*)::int AS n FROM ${WALL} GROUP BY 1, 2`
      ),
    ]);

    const counts: Record<string, number> = { to_print: 0, needs_reprint: 0, to_call: 0, called: 0, sent: 0 };
    for (const r of tally.rows) {
      if (r.status === 'in_review') counts[r.called ? 'called' : 'to_call'] += r.n;
      else counts[r.status] += r.n;
    }

    const shaped = rows.rows.map((r) => {
      const { r2_key, picture_id, picture_at, item_id: _item, ...row } = r;
      void _item;
      const full = {
        ...row,
        has_image: !!picture_id,
        uploaded_at: picture_at ?? null,
        // The public link, for the WhatsApp message. Null when the picture is
        // only in the database (R2 not configured), in which case the message
        // goes without it.
        image_url: r2_key ? publicUrl(r2_key) : null,
      };
      return role === 'brick_printer' ? forPrinter(full) : full;
    });

    const total = count.rows[0].n as number;
    res.json({
      role,
      view,
      views: allowed,
      rows: shaped,
      total,
      page,
      limit,
      total_pages: Math.max(1, Math.ceil(total / limit)),
      min_amount: WALL_MIN_AMOUNT,
      counts:
        role === 'brick_printer'
          ? { to_print: counts.to_print, needs_reprint: counts.needs_reprint, uploaded: counts.to_call }
          : role === 'caller'
          ? { to_call: counts.to_call, called: counts.called, sent: counts.sent }
          : counts,
    });
  } catch (err) {
    console.error('seva-wall list error:', (err as Error).message);
    res.status(500).json({ error: 'Could not load the seva wall.' });
  }
});

/* -------------------------------------------------------------- add a record */

// A hand-entered record: a donation DRM never saw (cash at the temple, a receipt
// book). It joins the wall and the print queue, and touches nothing else - no
// donation, no receipt, no total. The receipt number is optional for now; when it
// is given and already belongs to a donation in DRM, the record is refused so one
// gift cannot be on the wall twice. One record by hand, or many from a sheet.

interface NewRecord {
  donor_name: string;
  honoree_name: string;
  phone: string;
  amount: number;
  receipt_number: string;
  kind: string;
  priority: string;
  donated_on: string;
}

/** What a column heading may be called in a sheet, after lower-casing and dropping punctuation. */
const HEADINGS: Record<keyof NewRecord, string[]> = {
  donor_name: ['donorname', 'donor', 'name', 'devoteename', 'nameonreceipt', 'fullname'],
  honoree_name: ['honoreename', 'honoree', 'onthenameof', 'inthenameof', 'nametoprint', 'sevakname'],
  phone: ['phone', 'phonenumber', 'mobile', 'mobilenumber', 'mobileno', 'contact', 'whatsapp'],
  amount: ['amount', 'amountdonated', 'donation', 'donationamount', 'amountrs', 'rs', 'rupees'],
  receipt_number: ['receiptno', 'receiptnumber', 'receipt', 'donationreceiptno', 'receiptid'],
  kind: ['seva', 'sevatype', 'kind', 'type', 'category', 'sevaname'],
  priority: ['priority'],
  donated_on: ['date', 'donationdate', 'donatedon', 'paiddate', 'dateofdonation'],
};
const REQUIRED_COLUMNS: (keyof NewRecord)[] = ['donor_name', 'phone', 'amount', 'kind'];
const COLUMN_LABEL: Record<keyof NewRecord, string> = {
  donor_name: 'Donor name', honoree_name: 'Honoree name', phone: 'Phone', amount: 'Amount',
  receipt_number: 'Receipt no.', kind: 'Seva', priority: 'Priority', donated_on: 'Date',
};

const squash = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function kindOf(text: string): string {
  const t = text.toLowerCase();
  if (/brick/.test(t)) return 'brick';
  if (/square|sq\.? ?f|sqft/.test(t)) return 'square';
  if (/mandir|mandhir/.test(t)) return 'mandir';
  return '';
}

function priorityOf(text: string): string {
  const t = text.trim().toLowerCase();
  if (['high', 'h', '1', 'urgent'].includes(t)) return 'high';
  if (['low', 'l', '3'].includes(t)) return 'low';
  return 'medium'; // blank, "medium", or anything not recognised
}

function dateOf(text: string): string | null {
  const t = text.trim();
  if (!t) return '';
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (!m) {
    const d = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(t);
    if (d) m = [d[0], d[3], d[2].padStart(2, '0'), d[1].padStart(2, '0')] as unknown as RegExpExecArray;
  }
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** Clean one record's raw values, or say what is wrong with it. */
function cleanRecord(raw: Partial<Record<keyof NewRecord, unknown>>): { record?: NewRecord; error?: string } {
  const problems: string[] = [];
  const donor = String(raw.donor_name ?? '').trim();
  const phone = String(raw.phone ?? '').replace(/\D/g, '').slice(-10);
  const amount = Number(String(raw.amount ?? '').replace(/[^0-9.]/g, ''));
  const kind = kindOf(String(raw.kind ?? ''));
  const date = dateOf(String(raw.donated_on ?? ''));
  if (!donor) problems.push('no donor name');
  if (phone.length !== 10) problems.push('phone is not 10 digits');
  if (!Number.isFinite(amount) || amount < WALL_MIN_AMOUNT) problems.push(`amount is below ${WALL_MIN_AMOUNT}`);
  if (!kind) problems.push('seva is not Brick, Square foot or Mandir');
  if (date === null) problems.push('date is not valid (use DD/MM/YYYY)');
  if (problems.length) return { error: problems.join(', ') };
  return {
    record: {
      donor_name: donor,
      honoree_name: String(raw.honoree_name ?? '').trim(),
      phone,
      amount,
      receipt_number: String(raw.receipt_number ?? '').trim(),
      kind,
      priority: priorityOf(String(raw.priority ?? '')),
      donated_on: date ?? '',
    },
  };
}

type Db = { query: (sql: string, values?: unknown[]) => Promise<{ rowCount: number | null; rows: any[] }> };

/** Why this record should not be added again, or null if it is new. */
async function duplicateOf(q: Db, r: NewRecord, opts: { againstDonations: boolean }): Promise<string | null> {
  if (r.receipt_number) {
    const hit = await q.query(
      `SELECT 1 FROM donations WHERE lower(btrim(receipt_number)) = lower($1)
       UNION ALL
       SELECT 1 FROM seva_wall_items WHERE donation_id IS NULL AND lower(receipt_number) = lower($1)`,
      [r.receipt_number]
    );
    if (hit.rowCount) return 'that receipt number is already in DRM';
  }
  const same = await q.query(
    `SELECT 1 FROM seva_wall_items
      WHERE donation_id IS NULL AND lower(donor_name) = lower($1) AND phone = $2 AND amount = $3 AND kind = $4
        AND donated_on IS NOT DISTINCT FROM NULLIF($5, '')::date`,
    [r.donor_name, r.phone, r.amount, r.kind, r.donated_on]
  );
  if (same.rowCount) return 'the same record was already added';
  if (opts.againstDonations) {
    // A donation DRM already has, for the same phone, amount and seva, is almost
    // certainly this one: it is on the wall already.
    const onWall = await q.query(
      `SELECT 1 FROM (${DERIVED}) w WHERE w.phone = $1 AND w.amount = $2 AND w.kind = $3 LIMIT 1`,
      [r.phone, r.amount, r.kind]
    );
    if (onWall.rowCount) return 'a donation with this phone, amount and seva is already on the wall';
  }
  return null;
}

async function insertRecord(q: Db, r: NewRecord, userId: string | null) {
  const res = await q.query(
    `INSERT INTO seva_wall_items
       (donor_name, honoree_name, phone, amount, receipt_number, kind, donated_on, priority, created_by)
     VALUES ($1, NULLIF($2, ''), $3, $4, NULLIF($5, ''), $6, NULLIF($7, '')::date, $8, $9)
     RETURNING id`,
    [r.donor_name, r.honoree_name, r.phone, r.amount, r.receipt_number, r.kind, r.donated_on, r.priority, userId]
  );
  return res.rows[0].id as string;
}

router.post('/', allow(...MANAGE), async (req, res) => {
  const b = req.body ?? {};
  const cleaned = cleanRecord({ ...b, priority: PRIORITIES.includes(String(b.priority) as never) ? b.priority : 'medium' });
  if (!cleaned.record) {
    const text = cleaned.error!;
    return res.status(400).json({ error: text[0].toUpperCase() + text.slice(1) + '.' });
  }
  try {
    const why = await duplicateOf(pool, cleaned.record, { againstDonations: false });
    if (why) return res.status(409).json({ error: why[0].toUpperCase() + why.slice(1) + '.' });
    res.status(201).json({ ref: await insertRecord(pool, cleaned.record, req.user?.userId ?? null) });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'That receipt number is already on the wall.' });
    }
    console.error('seva-wall add error:', (err as Error).message);
    res.status(500).json({ error: 'Could not add the record.' });
  }
});

// Many records from a sheet. The caller sends the sheet as it read it (headings
// plus rows of text); the headings are matched to the fields here, so the rule for
// "what counts as a Phone column" lives in one place. With dry_run the rows are
// only checked, so the person sees what would happen before anything is written.
// Good rows are added and bad rows are reported with their sheet row number - one
// bad row never blocks the rest.
router.post('/bulk', allow(...MANAGE), async (req, res) => {
  const headers: string[] = Array.isArray(req.body?.headers) ? req.body.headers.map(String) : [];
  const rows: unknown[][] = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const numbers: number[] = Array.isArray(req.body?.row_numbers) ? req.body.row_numbers.map(Number) : [];
  const dryRun = req.body?.dry_run !== false;
  if (!headers.length || !rows.length) return res.status(400).json({ error: 'The file has no rows.' });
  if (rows.length > 2000) return res.status(400).json({ error: 'Upload 2,000 rows or fewer at a time.' });

  // Which column is which field.
  const column: Partial<Record<keyof NewRecord, number>> = {};
  headers.forEach((h, i) => {
    const key = squash(h);
    for (const field of Object.keys(HEADINGS) as (keyof NewRecord)[]) {
      if (column[field] === undefined && HEADINGS[field].includes(key)) column[field] = i;
    }
  });
  const missing = REQUIRED_COLUMNS.filter((f) => column[f] === undefined);
  if (missing.length) {
    return res.status(400).json({
      error: `The file needs a column for: ${missing.map((f) => COLUMN_LABEL[f]).join(', ')}.`,
      missing: missing.map((f) => COLUMN_LABEL[f]),
    });
  }

  type Outcome = { row: number; status: 'ok' | 'error' | 'duplicate'; message?: string; donor_name?: string };
  const outcomes: Outcome[] = [];
  const good: { record: NewRecord; at: number }[] = [];
  const seen = new Map<string, number>();

  try {
    for (let i = 0; i < rows.length; i++) {
      const at = numbers[i] ?? i + 2; // sheet row number: headings are row 1
      const raw: Partial<Record<keyof NewRecord, unknown>> = {};
      for (const f of Object.keys(column) as (keyof NewRecord)[]) raw[f] = rows[i][column[f]!];
      if (Object.values(raw).every((v) => !String(v ?? '').trim())) continue; // a blank line
      const cleaned = cleanRecord(raw);
      if (!cleaned.record) {
        outcomes.push({ row: at, status: 'error', message: cleaned.error, donor_name: String(raw.donor_name ?? '').trim() });
        continue;
      }
      const r = cleaned.record;
      const key = [r.donor_name.toLowerCase(), r.phone, r.amount, r.kind, r.donated_on, r.receipt_number.toLowerCase()].join('|');
      const dupRow = seen.get(key);
      if (dupRow) {
        outcomes.push({ row: at, status: 'duplicate', message: `repeated in this file (same as row ${dupRow})`, donor_name: r.donor_name });
        continue;
      }
      seen.set(key, at);
      const why = await duplicateOf(pool, r, { againstDonations: true });
      if (why) {
        outcomes.push({ row: at, status: 'duplicate', message: why, donor_name: r.donor_name });
        continue;
      }
      good.push({ record: r, at });
      outcomes.push({ row: at, status: 'ok', donor_name: r.donor_name });
    }

    let added = 0;
    if (!dryRun && good.length) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const g of good) {
          await insertRecord(client, g.record, req.user?.userId ?? null);
          added++;
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    }

    res.json({
      dry_run: dryRun,
      ready: good.length,
      added,
      problems: outcomes.filter((o) => o.status === 'error').length,
      duplicates: outcomes.filter((o) => o.status === 'duplicate').length,
      // Only the rows that need a look, so a 2,000-row sheet does not come back as 2,000 lines.
      issues: outcomes.filter((o) => o.status !== 'ok').slice(0, 200),
    });
  } catch (err) {
    console.error('seva-wall bulk error:', (err as Error).message);
    res.status(500).json({ error: 'Could not add the records. Nothing was added.' });
  }
});

/* ------------------------------------------------------- one row, by ref */

interface Item {
  id: string;
  donation_id: string | null;
  status: string;
  priority: string;
  called_at: Date | null;
}

/**
 * The item row for a wall row, creating it the first time something is done to a
 * donation that has none yet. Refuses a donation that is not on the wall.
 */
async function itemFor(ref: string): Promise<Item | null> {
  if (!UUID_RE.test(ref)) return null;
  const existing = await pool.query(
    'SELECT id, donation_id, status, priority, called_at FROM seva_wall_items WHERE id = $1 OR donation_id = $1',
    [ref]
  );
  if (existing.rows[0]) return existing.rows[0] as Item;
  const onWall = await pool.query(`SELECT 1 FROM (${DERIVED}) w WHERE w.ref = $1`, [ref]);
  if (!onWall.rowCount) return null;
  const made = await pool.query(
    `INSERT INTO seva_wall_items (donation_id) VALUES ($1)
     ON CONFLICT (donation_id) DO UPDATE SET donation_id = EXCLUDED.donation_id
     RETURNING id, donation_id, status, priority, called_at`,
    [ref]
  );
  return made.rows[0] as Item;
}

/** Write down a step in a brick's life. Never fatal: the step itself already happened. */
async function logEvent(
  q: { query: (sql: string, values: unknown[]) => Promise<unknown> },
  itemId: string,
  action: string,
  userId: string | undefined,
  note?: string
) {
  try {
    await q.query('INSERT INTO seva_wall_events (item_id, action, note, by_user) VALUES ($1, $2, $3, $4)', [
      itemId, action, note ?? null, userId ?? null,
    ]);
  } catch (e) {
    console.error('seva-wall event log failed (non-fatal):', (e as Error).message);
  }
}

const notFound = (res: Response) => res.status(404).json({ error: 'That record is not on the seva wall.' });

router.patch('/:ref', allow(...MANAGE), async (req, res) => {
  const priority = String(req.body?.priority ?? '');
  if (!(PRIORITIES as readonly string[]).includes(priority)) {
    return res.status(400).json({ error: 'Choose high, medium or low.' });
  }
  try {
    const item = await itemFor(String(req.params.ref));
    if (!item) return notFound(res);
    await pool.query('UPDATE seva_wall_items SET priority = $2, updated_at = NOW() WHERE id = $1', [item.id, priority]);
    res.json({ ref: String(req.params.ref), priority });
  } catch (err) {
    console.error('seva-wall priority error:', (err as Error).message);
    res.status(500).json({ error: 'Could not change the priority.' });
  }
});

// The printer uploads the picture of the printed brick. That moves it to the Seva
// wall for review. It can be uploaded again - to replace a picture that is not
// good - while the brick is still to print, sent back, or waiting with nobody
// having called yet. Once a caller has called or sent it, the picture is what the
// donor was told about, so it is locked.
//
// ONE PICTURE PER BRICK. The new file replaces the old one and the old file is
// deleted (the database copy and the R2 object), so storage never fills with
// pictures nobody will look at. The same file uploaded again is refused.
router.post('/:ref/image', allow(...UPLOAD), async (req, res) => {
  const mime = String(req.body?.mime ?? '').toLowerCase();
  const base64 = String(req.body?.base64 ?? '');
  if (!IMAGE_TYPES.includes(mime)) return res.status(400).json({ error: 'Upload a JPG, PNG or WebP picture.' });
  if (!base64) return res.status(400).json({ error: 'No picture received.' });
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length) return res.status(400).json({ error: 'Could not read that picture.' });
  if (bytes.length > MAX_IMAGE_BYTES) return res.status(413).json({ error: 'That picture is over 5 MB. Use a smaller one.' });
  const hash = createHash('sha256').update(bytes).digest('hex');

  const locked = (status: string, calledAt: unknown) =>
    status === 'sent'
      ? 'This brick has already been sent to the donor.'
      : status === 'in_review' && calledAt
      ? 'A caller has already started on this brick, so its picture cannot be changed.'
      : null;

  try {
    const item = await itemFor(String(req.params.ref));
    if (!item) return notFound(res);
    const why = locked(item.status, item.called_at);
    if (why) return res.status(409).json({ error: why });

    const pictureId = randomUUID();
    let r2Key: string | null = null;
    if (isConfigured() && !onTestDatabase()) {
      const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
      const key = `seva-wall/${item.id}/${pictureId}.${ext}`;
      if ((await putObject(key, bytes, mime)).ok) r2Key = key;
    }

    let replaced: { id: string; r2_key: string | null }[] = [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Re-check under a lock so two uploads at once cannot both go through.
      const now = await client.query('SELECT status, called_at FROM seva_wall_items WHERE id = $1 FOR UPDATE', [item.id]);
      const why2 = locked(now.rows[0].status, now.rows[0].called_at);
      if (why2) {
        await client.query('ROLLBACK');
        if (r2Key) void deleteObject(r2Key);
        return res.status(409).json({ error: why2 });
      }
      const same = await client.query('SELECT 1 FROM seva_wall_pictures WHERE item_id = $1 AND sha256 = $2', [item.id, hash]);
      if (same.rowCount) {
        await client.query('ROLLBACK');
        if (r2Key) void deleteObject(r2Key);
        return res.status(409).json({ error: 'That is the same picture as before. Upload the new one.' });
      }
      const old = await client.query('SELECT id, r2_key FROM seva_wall_pictures WHERE item_id = $1', [item.id]);
      replaced = old.rows;
      await client.query('DELETE FROM seva_wall_pictures WHERE item_id = $1', [item.id]);
      await client.query(
        `INSERT INTO seva_wall_pictures (id, item_id, mime, data, r2_key, size_bytes, sha256, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [pictureId, item.id, mime, r2Key ? null : bytes, r2Key, bytes.length, hash, req.user?.userId ?? null]
      );
      await client.query(
        `UPDATE seva_wall_items SET status = 'in_review', review_note = NULL, updated_at = NOW() WHERE id = $1`,
        [item.id]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (r2Key) void deleteObject(r2Key);
      throw e;
    } finally {
      client.release();
    }

    // The new picture is safely in; now the old files can go. A failure here only
    // leaves an orphan in the bucket, never a lost picture, so it is logged and
    // not raised.
    for (const o of replaced) if (o.r2_key) void deleteObject(o.r2_key);
    await logEvent(pool, item.id, replaced.length ? 'replaced' : 'uploaded', req.user?.userId);
    res.status(201).json({ ref: String(req.params.ref), status: 'in_review', replaced: replaced.length > 0 });
  } catch (err) {
    console.error('seva-wall upload error:', (err as Error).message);
    res.status(500).json({ error: 'Could not save the picture.' });
  }
});

// A printer may look at a picture only while they can still replace it (uploaded,
// nobody has called yet); everyone else with access may always look.
router.get('/:ref/image', allow(...LOOK), async (req, res) => {
  try {
    if (!UUID_RE.test(String(req.params.ref))) return res.status(404).json({ error: 'No picture for this record.' });
    const printerOnly = req.user!.role === 'brick_printer' ? `AND i.status = 'in_review' AND i.called_at IS NULL` : '';
    const r = await pool.query(
      `SELECT sp.mime, sp.data, sp.r2_key
         FROM seva_wall_pictures sp
         JOIN seva_wall_items i ON i.id = sp.item_id
        WHERE (i.id = $1 OR i.donation_id = $1) ${printerOnly}
        ORDER BY sp.uploaded_at DESC
        LIMIT 1`,
      [String(req.params.ref)]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'No picture for this record.' });
    const bytes: Buffer | null = r.rows[0].r2_key ? await getObject(r.rows[0].r2_key) : r.rows[0].data;
    if (!bytes) return res.status(404).json({ error: 'The picture could not be read. Try again.' });
    res.setHeader('Content-Type', r.rows[0].mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(bytes);
  } catch (err) {
    console.error('seva-wall image error:', (err as Error).message);
    res.status(500).json({ error: 'Could not load the picture.' });
  }
});

// "WhatsApp message sent": the picture has gone to the donor. DRM cannot see
// WhatsApp, so this is the caller's own word, recorded with who and when - which
// is why it is a button they press and not something the WhatsApp link does by
// itself. It does not need a call first: some donors are simply messaged.
// "Call answered": the caller reached the donor. It is a mark on a brick that is
// waiting to be sent, not a status of its own, and it is what moves the row from
// "not called" to "called, picture not sent yet" in the Seva wall table.
router.post('/:ref/called', allow(...REVIEW), async (req, res) => {
  try {
    const item = await itemFor(String(req.params.ref));
    if (!item) return notFound(res);
    const r = await pool.query(
      `UPDATE seva_wall_items
          SET called_at = COALESCE(called_at, NOW()), called_by = COALESCE(called_by, $2), updated_at = NOW()
        WHERE id = $1 AND status = 'in_review'
        RETURNING id`,
      [item.id, req.user?.userId ?? null]
    );
    if (!r.rowCount) return res.status(409).json({ error: 'Only a brick whose picture is waiting to be sent can be marked called.' });
    await logEvent(pool, item.id, 'called', req.user?.userId);
    res.json({ ref: String(req.params.ref), called: true });
  } catch (err) {
    console.error('seva-wall called error:', (err as Error).message);
    res.status(500).json({ error: 'Could not mark it called.' });
  }
});

router.post('/:ref/mark-sent', allow(...REVIEW), async (req, res) => {
  try {
    const item = await itemFor(String(req.params.ref));
    if (!item) return notFound(res);
    const r = await pool.query(
      `UPDATE seva_wall_items
          SET status = 'sent', sent_by = $2, sent_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'in_review'
        RETURNING id`,
      [item.id, req.user?.userId ?? null]
    );
    if (!r.rowCount) return res.status(409).json({ error: 'Only a brick whose picture is uploaded can be marked sent.' });
    await logEvent(pool, item.id, 'sent', req.user?.userId);
    res.json({ ref: String(req.params.ref), status: 'sent' });
  } catch (err) {
    console.error('seva-wall mark-sent error:', (err as Error).message);
    res.status(500).json({ error: 'Could not mark it sent.' });
  }
});

// The picture is not good enough. The brick goes back to the printer with the
// reason - at the top of their list - and the picture is kept, marked sent back,
// not deleted. A new picture starts a fresh round of calling, so the "called"
// mark is cleared; the events table still has that it happened.
router.post('/:ref/send-back', allow(...REVIEW), async (req, res) => {
  const note = String(req.body?.note ?? '').trim().slice(0, 300);
  if (!note) return res.status(400).json({ error: 'Say what is wrong, so the printer knows what to fix.' });
  try {
    const item = await itemFor(String(req.params.ref));
    if (!item) return notFound(res);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const moved = await client.query(
        `UPDATE seva_wall_items
            SET status = 'needs_reprint', review_note = $2, reviewed_by = $3, reviewed_at = NOW(),
                called_at = NULL, called_by = NULL, updated_at = NOW()
          WHERE id = $1 AND status = 'in_review'
          RETURNING id`,
        [item.id, note, req.user?.userId ?? null]
      );
      if (!moved.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Only a brick that is in review can be sent back.' });
      }
      await client.query(
        `UPDATE seva_wall_pictures SET state = 'sent_back', sent_back_note = $2
          WHERE item_id = $1 AND state = 'current'`,
        [item.id, note]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    await logEvent(pool, item.id, 'sent_back', req.user?.userId, note);
    res.json({ ref: String(req.params.ref), status: 'needs_reprint' });
  } catch (err) {
    console.error('seva-wall send-back error:', (err as Error).message);
    res.status(500).json({ error: 'Could not send it back.' });
  }
});

export default router;
