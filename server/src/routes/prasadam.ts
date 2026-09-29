import { Router } from 'express';
import pool from '../db/pool';
import { authenticate } from '../middleware/auth';
import { canonPageSql, groupPredicateSql, isPageGroup } from '../utils/pageGroups';
import { displayPurposeSql } from '../utils/donationLabel';
import { updatePrasadamStatus, isSiteConfigured, type SiteKey } from '../services/hkmvClient';
import { buildWorkbook } from '../utils/spreadsheet';

const router = Router();
router.use(authenticate);

// Statuses a delivery can be moved to. Whitelisted rather than trusted from the
// body - status drives the WhatsApp triggers below, so a typo must not create a
// silent third state that no screen ever shows.
const STATUSES = ['pending', 'packed', 'shipped', 'delivered', 'returned'] as const;
type Status = (typeof STATUSES)[number];
const isStatus = (v: unknown): v is Status => STATUSES.includes(v as Status);

// Identity across systems is the last 10 digits of the phone - the same rule
// the donor sync uses. An uploaded courier file will have "+91 98765 43210",
// "919876543210" or "98765-43210" for what is one donor.
function normalizePhone(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  return digits.length > 10 ? digits.slice(-10) : digits;
}

// ---------------------------------------------------------------------------
// Filters shared by the list, the export and the import preview.
//
// One builder for all three on purpose: if the export could select rows the
// list cannot show, staff would be marking deliveries they never saw.
interface Filters {
  where: string;
  values: unknown[];
  next: number;
}

function buildFilters(q: Record<string, unknown>, startIdx = 1): Filters {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = startIdx;

  const status = typeof q.status === 'string' ? q.status : '';
  if (status && status !== 'all') {
    if (!isStatus(status)) throw new Error(`Unknown status "${status}"`);
    conditions.push(`d.status = $${idx}`);
    values.push(status);
    idx++;
  }

  if (q.person_id) {
    conditions.push(`d.person_id = $${idx}`);
    values.push(q.person_id);
    idx++;
  }

  // Which donation site the delivery belongs to.
  if (q.site) {
    conditions.push(`d.source_site = $${idx}`);
    values.push(q.site);
    idx++;
  }

  // Free-text over donor name, phone and tracking number - what someone has in
  // hand when a donor rings up asking where their prasadam is.
  if (typeof q.search === 'string' && q.search.trim()) {
    conditions.push(
      `(p.name ILIKE $${idx} OR p.phone ILIKE $${idx} OR d.tracking_number ILIKE $${idx})`
    );
    values.push(`%${q.search.trim()}%`);
    idx++;
  }

  if (q.from_date) {
    conditions.push(`d.created_at >= $${idx}`);
    values.push(q.from_date);
    idx++;
  }
  if (q.to_date) {
    conditions.push(`d.created_at < ($${idx}::date + INTERVAL '1 day')`);
    values.push(q.to_date);
    idx++;
  }

  // Include / exclude by the donation behind the delivery.
  //
  // This is the filter that decides what goes on a courier manifest, so it cuts
  // both ways: include_purpose keeps only those sevas, exclude_purpose drops
  // them. Matched case-insensitively because the source sites send free-text
  // seva names ("Gau Seva", "gau seva").
  const listOf = (v: unknown): string[] =>
    typeof v === 'string' && v.trim()
      ? v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      : [];

  const includePurpose = listOf(q.include_purpose);
  if (includePurpose.length) {
    conditions.push(
      `EXISTS (SELECT 1 FROM donations dn WHERE dn.id = d.donation_id AND lower(${displayPurposeSql('dn.purpose', 'dn.source_page')}) = ANY($${idx}::text[]))`
    );
    values.push(includePurpose);
    idx++;
  }

  const excludePurpose = listOf(q.exclude_purpose);
  if (excludePurpose.length) {
    // NOT EXISTS, so a delivery with no donation linked is KEPT rather than
    // silently dropped by the exclusion - it was never one of the excluded
    // sevas to begin with.
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM donations dn WHERE dn.id = d.donation_id AND lower(${displayPurposeSql('dn.purpose', 'dn.source_page')}) = ANY($${idx}::text[]))`
    );
    values.push(excludePurpose);
    idx++;
  }

  // Include / exclude by the page the donation came from, using the same
  // canonical spelling the dashboard groups by.
  if (typeof q.include_page === 'string' && q.include_page.trim()) {
    conditions.push(
      `EXISTS (SELECT 1 FROM donations dn WHERE dn.id = d.donation_id
                 AND (${canonPageSql('dn.source_page')}) = $${idx})`
    );
    values.push('/' + q.include_page.trim().toLowerCase().replace(/^\/+|\/+$/g, ''));
    idx++;
  }

  if (typeof q.group === 'string' && isPageGroup(q.group)) {
    conditions.push(
      `EXISTS (SELECT 1 FROM donations dn WHERE dn.id = d.donation_id
                 AND ${groupPredicateSql(q.group, 'dn.source_page', 'dn.source_site')})`
    );
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    values,
    next: idx,
  };
}

// The columns every screen and the export read, including the donation behind
// the delivery so staff can see WHICH donation earned the prasadam.
const SELECT_COLUMNS = `
  d.id, d.person_id, d.donation_id, d.address, d.status, d.courier_name,
  d.tracking_number, d.dispatched_at, d.delivered_at, d.notes, d.created_at,
  d.source_site, d.marked_at, d.marked_via,
  -- Whether the source site has caught up with what was marked here. Shown as a
  -- small badge so staff can see at a glance that a row is out of step, rather
  -- than discovering it when a box gets couriered twice.
  d.site_sync_status, d.site_sync_error, d.site_synced_at,
  p.name  AS donor_name,
  p.phone AS donor_phone,
  u.name  AS marked_by_name,
  dn.amount        AS donation_amount,
  ${displayPurposeSql('dn.purpose', 'dn.source_page')} AS donation_purpose,
  dn.created_at    AS donation_date,
  dn.receipt_number AS donation_receipt,
  ${canonPageSql('dn.source_page')} AS donation_page`;

const FROM_JOINS = `
  FROM prasadam_deliveries d
  JOIN people p         ON d.person_id = p.id
  LEFT JOIN donations dn ON d.donation_id = dn.id
  LEFT JOIN users u      ON d.marked_by = u.id`;

// ---------------------------------------------------------------------------
// GET / - the fulfilment queue.
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const f = buildFilters(req.query as Record<string, unknown>);

    const [rows, totals] = await Promise.all([
      pool.query(
        `SELECT ${SELECT_COLUMNS} ${FROM_JOINS} ${f.where}
         ORDER BY d.created_at DESC
         LIMIT $${f.next} OFFSET $${f.next + 1}`,
        [...f.values, limit, offset]
      ),
      // Counts per status for the whole filtered set, not just this page - the
      // tabs must not change meaning as you page through.
      pool.query(
        `SELECT d.status, COUNT(*) AS count ${FROM_JOINS} ${f.where} GROUP BY d.status`,
        f.values
      ),
    ]);

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of totals.rows) {
      byStatus[r.status] = Number(r.count);
      total += Number(r.count);
    }

    res.json({
      deliveries: rows.rows,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      byStatus,
    });
  } catch (err) {
    console.error('prasadam.list error:', err);
    res.status(400).json({ error: (err as Error).message });
  }
});

// GET /filters - the values actually present, so the filter dropdowns offer
// real options rather than a hardcoded list that matches nothing.
router.get('/filters', async (_req, res) => {
  const [purposes, pages, sites] = await Promise.all([
    pool.query(`
      SELECT lower(${displayPurposeSql('dn.purpose', 'dn.source_page')}) AS purpose, COUNT(*) AS count
      FROM prasadam_deliveries d JOIN donations dn ON d.donation_id = dn.id
      WHERE dn.purpose IS NOT NULL AND btrim(dn.purpose) <> ''
      GROUP BY lower(${displayPurposeSql('dn.purpose', 'dn.source_page')}) ORDER BY count DESC LIMIT 60
    `),
    pool.query(`
      SELECT ${canonPageSql('dn.source_page')} AS page, COUNT(*) AS count
      FROM prasadam_deliveries d JOIN donations dn ON d.donation_id = dn.id
      WHERE dn.source_page IS NOT NULL AND btrim(dn.source_page) <> ''
      GROUP BY ${canonPageSql('dn.source_page')} ORDER BY count DESC LIMIT 60
    `),
    pool.query(`
      SELECT source_site AS site, COUNT(*) AS count
      FROM prasadam_deliveries GROUP BY source_site ORDER BY count DESC
    `),
  ]);
  res.json({
    purposes: purposes.rows.map((r) => ({ purpose: r.purpose, count: Number(r.count) })),
    pages: pages.rows.map((r) => ({ page: r.page, count: Number(r.count) })),
    sites: sites.rows.map((r) => ({ site: r.site, count: Number(r.count) })),
  });
});

// ---------------------------------------------------------------------------
// GET /candidates?phone= - every open delivery for one donor.
//
// The answer to "this donor has three pending deliveries, which one arrived?".
// The UI shows these and the person picks; nothing is guessed.
router.get('/candidates', async (req, res) => {
  const phone = normalizePhone(String(req.query.phone || ''));
  if (!phone) return res.status(400).json({ error: 'A phone number is required' });

  const result = await pool.query(
    `SELECT ${SELECT_COLUMNS} ${FROM_JOINS}
     WHERE regexp_replace(p.phone, '\\D', '', 'g') LIKE $1
       AND d.status <> 'delivered'
     ORDER BY d.created_at DESC`,
    [`%${phone}`]
  );
  res.json({ phone, candidates: result.rows });
});

// Queue a new delivery - defaults to the person's saved prasadam/home address
router.post('/', async (req, res) => {
  const { person_id, donation_id, address, notes } = req.body;

  let deliveryAddress = address;
  if (!deliveryAddress) {
    const person = await pool.query('SELECT prasadam_address, address FROM people WHERE id = $1', [person_id]);
    if (!person.rows.length) return res.status(404).json({ error: 'Person not found' });
    deliveryAddress = person.rows[0].prasadam_address || person.rows[0].address;
  }
  if (!deliveryAddress) {
    return res.status(400).json({ error: 'No delivery address on file for this person' });
  }

  const result = await pool.query(
    `INSERT INTO prasadam_deliveries (person_id, donation_id, address, notes)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [person_id, donation_id ?? null, deliveryAddress, notes ?? null]
  );
  res.status(201).json(result.rows[0]);
});

// ---------------------------------------------------------------------------
// Applying a status to a set of deliveries.
//
// Used by the single-row update, the bulk action and the import commit, so all
// three write the same columns, raise the same WhatsApp triggers and record the
// same audit trail. Runs in one transaction: a half-applied courier manifest is
// worse than a rejected one, because nobody knows which half.
async function applyStatus(
  ids: string[],
  status: Status,
  opts: {
    userId?: string;
    via: 'manual' | 'bulk' | 'import';
    courierName?: string | null;
    trackingNumber?: string | null;
    notes?: string | null;
    deliveredAt?: string | null;
    /**
     * Ask the SOURCE SITE to WhatsApp the donor as well.
     *
     * Almost always leave this off. DRM raises its own prasadam_shipped /
     * prasadam_delivered trigger a few lines below, and that is the one place
     * the donor should be messaged from - turning this on as well means the
     * donor gets the same news twice, from two systems, with two wordings.
     * It exists for the case where DRM's own trigger queue is disabled and the
     * site's template is the one being relied on.
     */
    notifyDonorOnSite?: boolean;
  }
): Promise<{ updated: number; rows: Record<string, unknown>[] }> {
  if (!ids.length) return { updated: 0, rows: [] };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      // $1 is cast to text at EVERY use. Without the casts Postgres tries to
      // deduce one type from both the assignment (varchar, from the column) and
      // the comparisons against string literals (text), and rejects the whole
      // statement with "inconsistent types deduced for parameter $1".
      `UPDATE prasadam_deliveries SET
         status          = $1::text,
         courier_name    = COALESCE($2, courier_name),
         tracking_number = COALESCE($3, tracking_number),
         notes           = COALESCE($4, notes),
         dispatched_at   = CASE WHEN $1::text = 'shipped'   THEN COALESCE(dispatched_at, NOW()) ELSE dispatched_at END,
         -- An uploaded file can carry the courier's own delivery date, so a
         -- supplied timestamp wins; otherwise this is the moment it was marked.
         delivered_at    = CASE WHEN $1::text = 'delivered' THEN COALESCE($5::timestamptz, delivered_at, NOW()) ELSE delivered_at END,
         marked_by       = $6,
         marked_at       = NOW(),
         marked_via      = $7
       WHERE id = ANY($8::uuid[])
       RETURNING id, person_id, status, courier_name, tracking_number, delivered_at, external_ref, source_site`,
      [
        status,
        opts.courierName ?? null,
        opts.trackingNumber ?? null,
        opts.notes ?? null,
        opts.deliveredAt ?? null,
        opts.userId ?? null,
        opts.via,
        ids,
      ]
    );

    // Notify the donor, through the same trigger queue the rest of DRM uses.
    if (status === 'shipped' || status === 'delivered') {
      for (const row of result.rows) {
        await client.query(
          `INSERT INTO triggers (person_id, trigger_type, payload) VALUES ($1, $2, $3)`,
          [
            row.person_id,
            status === 'shipped' ? 'prasadam_shipped' : 'prasadam_delivered',
            JSON.stringify({
              delivery_id: row.id,
              courier_name: row.courier_name,
              tracking_number: row.tracking_number,
              via: opts.via,
            }),
          ]
        );
      }
    }

    await client.query('COMMIT');

    // Push to the source sites AFTER the commit, deliberately. Two reasons: an
    // HTTP call to another server must never be made with a transaction open
    // (it would hold locks on these rows for as long as the far end takes to
    // answer), and a site being down must never undo work a human just did.
    // The local mark is the record; the push is best-effort reconciliation.
    void pushStatusToSites(result.rows, status, opts.notifyDonorOnSite === true).catch((err) => {
      console.error('prasadam.pushStatusToSites error:', err);
    });

    return { updated: result.rowCount ?? 0, rows: result.rows };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// DRM's vocabulary against what the sites can actually store.
//
// DRM tracks five states because the temple's own workflow has five: a box can
// be packed and waiting for the courier. Neither site has that, and neither has
// anything to say about it, so "packed" is reported as still pending there -
// which is true from the donor's point of view, and the alternative (claiming
// it shipped) would be a lie that reaches the donor as a WhatsApp message.
const SITE_STATUS: Record<Status, 'pending' | 'shipped' | 'delivered' | 'cancelled'> = {
  pending: 'pending',
  packed: 'pending',
  shipped: 'shipped',
  delivered: 'delivered',
  returned: 'cancelled',
};

/**
 * Mirrors a status change onto the site the donation came from.
 *
 * Runs outside the transaction, one row at a time, and records the outcome per
 * row so the screen can show which deliveries the sites have caught up with.
 * Nothing here throws to the caller: the staff member has already been told
 * their mark succeeded, because it did.
 *
 * Three outcomes are recorded, and they mean different things:
 *   synced      - the site stored it
 *   unsupported - the site answered honestly that it cannot represent this
 *                 state (annadan has no "cancelled", for instance). Not a
 *                 failure and not worth retrying; the two sides simply differ.
 *   failed      - the site was unreachable or refused. Worth retrying.
 */
async function pushStatusToSites(
  rows: Record<string, unknown>[],
  status: Status,
  notifyDonorOnSite: boolean
): Promise<void> {
  const siteStatus = SITE_STATUS[status];

  for (const row of rows) {
    const externalRef = row.external_ref ? String(row.external_ref) : '';
    const site = String(row.source_site || '') as SiteKey;

    // Offline deliveries entered in DRM have no counterpart on either site, so
    // there is nothing to push and nothing wrong with that.
    if (!externalRef || (site !== 'hkmv' && site !== 'annadan')) continue;
    if (!isSiteConfigured(site)) continue;

    let syncStatus: 'synced' | 'unsupported' | 'failed';
    let syncError: string | null = null;

    try {
      const result = await updatePrasadamStatus(site, externalRef, {
        status: siteStatus,
        courierName: row.courier_name ? String(row.courier_name) : null,
        trackingNumber: row.tracking_number ? String(row.tracking_number) : null,
        deliveredAt: row.delivered_at ? new Date(row.delivered_at as string).toISOString() : null,
        notify: notifyDonorOnSite,
      });
      syncStatus = result.applied ? 'synced' : 'unsupported';
      syncError = result.applied ? null : result.message;
    } catch (err) {
      syncStatus = 'failed';
      syncError = err instanceof Error ? err.message.slice(0, 500) : 'Unknown error';
    }

    await pool
      .query(
        `UPDATE prasadam_deliveries
            SET site_sync_status = $1, site_sync_error = $2, site_synced_at = NOW()
          WHERE id = $3`,
        [syncStatus, syncError, row.id]
      )
      .catch((err) => console.error('prasadam.recordSyncState error:', err));
  }
}

// PUT /:id - one delivery (pack / ship with tracking / deliver / return)
router.put('/:id', async (req, res) => {
  const { status, courier_name, tracking_number, notes, delivered_at } = req.body;
  if (status !== undefined && !isStatus(status)) {
    return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
  }

  if (status === undefined) {
    // Editing courier details without moving the delivery along.
    const result = await pool.query(
      `UPDATE prasadam_deliveries SET
         courier_name    = COALESCE($1, courier_name),
         tracking_number = COALESCE($2, tracking_number),
         notes           = COALESCE($3, notes)
       WHERE id = $4 RETURNING *`,
      [courier_name ?? null, tracking_number ?? null, notes ?? null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Delivery not found' });
    return res.json(result.rows[0]);
  }

  const { updated } = await applyStatus([req.params.id], status, {
    userId: req.user?.userId,
    via: 'manual',
    courierName: courier_name,
    trackingNumber: tracking_number,
    notes,
    deliveredAt: delivered_at,
  });
  if (!updated) return res.status(404).json({ error: 'Delivery not found' });

  const fresh = await pool.query(`SELECT ${SELECT_COLUMNS} ${FROM_JOINS} WHERE d.id = $1`, [req.params.id]);
  res.json(fresh.rows[0]);
});

// POST /bulk-status - several deliveries at once, from the tick boxes.
router.post('/bulk-status', async (req, res) => {
  const { ids, status, courier_name, tracking_number, delivered_at } = req.body ?? {};

  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: 'Select at least one delivery' });
  }
  if (ids.length > 1000) {
    return res.status(400).json({ error: 'Too many at once - filter down and do it in batches of 1000 or fewer' });
  }
  if (!isStatus(status)) {
    return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
  }

  try {
    const { updated } = await applyStatus(ids, status, {
      userId: req.user?.userId,
      via: 'bulk',
      courierName: courier_name,
      trackingNumber: tracking_number,
      deliveredAt: delivered_at,
    });
    // requested vs updated: an id that matched nothing is worth saying out loud
    // rather than reporting a clean success over a partial one.
    res.json({ requested: ids.length, updated, skipped: ids.length - updated, status });
  } catch (err) {
    console.error('prasadam.bulkStatus error:', err);
    res.status(500).json({ error: 'Could not update those deliveries' });
  }
});

// POST /resync - push already-marked deliveries to their sites again.
//
// The push after a mark is best-effort: a site being down or restarting leaves
// rows recorded here and stale there. Rather than a background job nobody can
// see, this is a button - the screen shows how many rows are out of step, and
// this retries them.
//
// "unsupported" rows are excluded on purpose. Those are not failures waiting to
// clear; they are states the site genuinely cannot hold, and retrying them
// forever would just keep producing the same honest refusal.
router.post('/resync', async (req, res) => {
  const limit = Math.min(Number(req.body?.limit) || 200, 1000);

  try {
    const stale = await pool.query(
      `SELECT id, status, courier_name, tracking_number, delivered_at, external_ref, source_site
         FROM prasadam_deliveries
        WHERE marked_at IS NOT NULL
          AND external_ref IS NOT NULL
          AND source_site IN ('hkmv','annadan')
          AND (site_sync_status IS NULL OR site_sync_status = 'failed')
        ORDER BY marked_at DESC
        LIMIT $1`,
      [limit]
    );

    if (!stale.rows.length) {
      return res.json({ attempted: 0, synced: 0, unsupported: 0, failed: 0, message: 'Everything is already in step.' });
    }

    // Grouped by status because pushStatusToSites maps one status for the whole
    // batch - a mixed list would otherwise need one call per row anyway.
    const byStatus = new Map<Status, Record<string, unknown>[]>();
    for (const row of stale.rows) {
      const s = row.status as Status;
      if (!isStatus(s)) continue;
      if (!byStatus.has(s)) byStatus.set(s, []);
      byStatus.get(s)!.push(row);
    }
    for (const [s, rows] of byStatus) await pushStatusToSites(rows, s, false);

    const after = await pool.query(
      `SELECT site_sync_status AS s, COUNT(*)::int AS n
         FROM prasadam_deliveries WHERE id = ANY($1::uuid[]) GROUP BY 1`,
      [stale.rows.map((r) => r.id)]
    );
    const count = (k: string) => after.rows.find((r) => r.s === k)?.n ?? 0;

    res.json({
      attempted: stale.rows.length,
      synced: count('synced'),
      unsupported: count('unsupported'),
      failed: count('failed') + count(null as unknown as string),
    });
  } catch (err) {
    console.error('prasadam.resync error:', err);
    res.status(500).json({ error: 'Could not re-sync those deliveries' });
  }
});

// ---------------------------------------------------------------------------
// GET /export.csv - the courier manifest, honouring every filter on screen.
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  // Dates go out as "2026-09-29 14:30", not JavaScript's default
  // "Tue Sep 29 2026 05:26:00 GMT+0000 (Coordinated Universal Time)" - this
  // file is read by a courier and opened in Excel, which cannot parse the
  // latter as a date at all.
  const s =
    v instanceof Date
      ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')} ` +
        `${String(v.getHours()).padStart(2, '0')}:${String(v.getMinutes()).padStart(2, '0')}`
      : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const EXPORT_COLUMNS: { key: string; header: string }[] = [
  { key: 'id', header: 'Delivery ID' },
  { key: 'donor_name', header: 'Donor' },
  { key: 'donor_phone', header: 'Phone' },
  { key: 'address', header: 'Address' },
  { key: 'status', header: 'Status' },
  { key: 'courier_name', header: 'Courier' },
  { key: 'tracking_number', header: 'Tracking number' },
  { key: 'donation_amount', header: 'Donation amount' },
  { key: 'donation_purpose', header: 'Seva' },
  { key: 'donation_page', header: 'Page' },
  { key: 'donation_receipt', header: 'Receipt no' },
  { key: 'source_site', header: 'Site' },
  { key: 'created_at', header: 'Queued at' },
  { key: 'dispatched_at', header: 'Dispatched at' },
  { key: 'delivered_at', header: 'Delivered at' },
];

router.get('/export.csv', async (req, res) => {
  try {
    const f = buildFilters(req.query as Record<string, unknown>);
    const result = await pool.query(
      `SELECT ${SELECT_COLUMNS} ${FROM_JOINS} ${f.where} ORDER BY d.created_at DESC LIMIT 20000`,
      f.values
    );

    const header = EXPORT_COLUMNS.map((c) => csvCell(c.header)).join(',');
    const body = result.rows
      .map((row) => EXPORT_COLUMNS.map((c) => csvCell(row[c.key])).join(','))
      .join('\n');

    const stamp = new Date().toISOString().slice(0, 10);
    const label = typeof req.query.status === 'string' && req.query.status ? req.query.status : 'all';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="prasadam-${label}-${stamp}.csv"`);
    // A BOM so Excel opens Indian names and addresses as UTF-8 rather than
    // mangling them - these files go straight to a courier.
    res.send('﻿' + header + '\n' + body + '\n');
  } catch (err) {
    console.error('prasadam.export error:', err);
    res.status(400).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Import: preview, then commit. Never one step.
//
// The courier returns a file with a phone number and maybe a name - not a
// delivery id. One phone can have several open deliveries, and marking the
// wrong one is invisible until a donor complains. So the upload only ever
// REPORTS what it would do: matched rows, ambiguous rows with their candidates
// for a human to choose from, and rows that matched nothing. The commit takes
// explicit delivery ids that the person has seen.

interface ImportRow {
  rowNumber: number;
  phone: string;
  name?: string;
  trackingNumber?: string;
  deliveredAt?: string;
}

// The sample file offered beside the upload box. The three rows deliberately
// spell the phone number three different ways, because that is the field that
// decides whether a row matches at all and couriers each have their own habit.
const COURIER_SAMPLE_ROWS = [
  ['Donor Name', 'Phone', 'Tracking Number', 'Delivered Date'],
  ['Ramesh Kumar', '9876543210', 'BD10001', '2026-09-20'],
  ['Lakshmi Devi', '+91 98765 43211', 'BD10002', '2026-09-21'],
  ['Suresh Babu', '919876543212', '', '2026-09-21'],
];

router.get('/import/sample.xlsx', async (_req, res) => {
  try {
    const buffer = await buildWorkbook('Deliveries', COURIER_SAMPLE_ROWS);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="prasadam-upload-sample.xlsx"');
    res.send(buffer);
  } catch (err) {
    console.error('prasadam.sampleXlsx error:', err);
    res.status(500).json({ error: 'Could not build the sample file' });
  }
});

router.post('/import/preview', async (req, res) => {
  const rows: unknown = req.body?.rows;
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: 'No rows to preview' });
  }
  if (rows.length > 5000) {
    return res.status(400).json({ error: 'That file is too large - split it into batches of 5000 rows or fewer' });
  }

  const parsed: ImportRow[] = rows.map((r: Record<string, unknown>, i) => ({
    rowNumber: Number(r.rowNumber) || i + 1,
    phone: normalizePhone(String(r.phone ?? '')),
    name: r.name ? String(r.name) : undefined,
    trackingNumber: r.trackingNumber ? String(r.trackingNumber) : undefined,
    deliveredAt: r.deliveredAt ? String(r.deliveredAt) : undefined,
  }));

  const phones = Array.from(new Set(parsed.map((r) => r.phone).filter(Boolean)));
  const byPhone = new Map<string, Record<string, unknown>[]>();

  if (phones.length) {
    const found = await pool.query(
      `SELECT ${SELECT_COLUMNS}, regexp_replace(p.phone, '\\D', '', 'g') AS phone_digits
       ${FROM_JOINS}
       WHERE d.status <> 'delivered'
         AND right(regexp_replace(p.phone, '\\D', '', 'g'), 10) = ANY($1::text[])
       ORDER BY d.created_at DESC`,
      [phones]
    );
    for (const row of found.rows) {
      const key = String(row.phone_digits).slice(-10);
      if (!byPhone.has(key)) byPhone.set(key, []);
      byPhone.get(key)!.push(row);
    }
  }

  const matched: { row: ImportRow; delivery: Record<string, unknown> }[] = [];
  const ambiguous: { row: ImportRow; candidates: Record<string, unknown>[] }[] = [];
  const unmatched: { row: ImportRow; reason: string }[] = [];

  for (const row of parsed) {
    if (!row.phone) {
      unmatched.push({ row, reason: 'No usable phone number in this row' });
      continue;
    }
    const candidates = byPhone.get(row.phone) ?? [];

    if (candidates.length === 0) {
      unmatched.push({ row, reason: 'No open delivery for this number (already delivered, or never queued)' });
      continue;
    }
    if (candidates.length === 1) {
      matched.push({ row, delivery: candidates[0] });
      continue;
    }

    // Several open deliveries. A tracking number in the file settles it without
    // troubling anyone; otherwise a human chooses.
    if (row.trackingNumber) {
      const exact = candidates.filter(
        (c) => String(c.tracking_number ?? '').trim() === row.trackingNumber!.trim()
      );
      if (exact.length === 1) {
        matched.push({ row, delivery: exact[0] });
        continue;
      }
    }
    ambiguous.push({ row, candidates });
  }

  res.json({
    summary: {
      rows: parsed.length,
      matched: matched.length,
      ambiguous: ambiguous.length,
      unmatched: unmatched.length,
    },
    matched,
    ambiguous,
    unmatched,
  });
});

router.post('/import/commit', async (req, res) => {
  const { deliveries, courier_name } = req.body ?? {};
  if (!Array.isArray(deliveries) || !deliveries.length) {
    return res.status(400).json({ error: 'Nothing to apply' });
  }
  if (deliveries.length > 5000) {
    return res.status(400).json({ error: 'Too many at once - apply in batches of 5000 or fewer' });
  }

  // Each entry can carry its own delivered_at (the courier's date), so group by
  // date and apply each group, rather than flattening everything to "now".
  const byDate = new Map<string, string[]>();
  for (const entry of deliveries as { id?: string; delivered_at?: string }[]) {
    if (!entry?.id) continue;
    const key = entry.delivered_at || '';
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key)!.push(entry.id);
  }

  try {
    let updated = 0;
    for (const [deliveredAt, ids] of byDate) {
      const result = await applyStatus(ids, 'delivered', {
        userId: req.user?.userId,
        via: 'import',
        courierName: courier_name ?? null,
        deliveredAt: deliveredAt || null,
      });
      updated += result.updated;
    }
    const requested = Array.from(byDate.values()).reduce((n, ids) => n + ids.length, 0);
    res.json({ requested, updated, skipped: requested - updated });
  } catch (err) {
    console.error('prasadam.importCommit error:', err);
    res.status(500).json({ error: 'Could not apply that file' });
  }
});

export default router;
