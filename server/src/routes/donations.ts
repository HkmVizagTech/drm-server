import { Router } from 'express';
import pool from '../db/pool';
import { normalizeAddress, type Address } from '../utils/address';
import { authenticate, authorize } from '../middleware/auth';
import {
  createOfflineDonation,
  fetchDonorSnapshot,
  fetchReceiptPdf,
  isSiteConfigured,
  resendReceipt,
  SiteKey,
} from '../services/hkmvClient';
import { upsertDonorSnapshot } from '../services/hkmvSync';
import { canonPage, canonPageSql, groupPredicateSql, isPageGroup } from '../utils/pageGroups';
import { displayPurposeSql } from '../utils/donationLabel';

const router = Router();
router.use(authenticate);

// List donations with filters
router.get('/', async (req, res) => {
  const { purpose, source, from_date, to_date, receipt_generated, search, source_site, source_page, campaign, group } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  // lower() on both sides so the filter matches regardless of how the seva name
  // was cased upstream - the dropdown is populated from lowered values.
  // Matched against the SAME expression /purposes offers, or picking
  // "/donations" from the dropdown would filter on a value no row stores and
  // silently return nothing.
  if (purpose) {
    conditions.push(`lower(${displayPurposeSql('d.purpose', 'd.source_page')}) = lower($${idx})`);
    values.push(purpose);
    idx++;
  }
  if (source) { conditions.push(`d.source = $${idx}`); values.push(source); idx++; }
  if (from_date) { conditions.push(`d.created_at >= $${idx}`); values.push(from_date); idx++; }
  if (to_date) { conditions.push(`d.created_at <= $${idx}`); values.push(to_date); idx++; }
  if (receipt_generated !== undefined && receipt_generated !== '') {
    conditions.push(`d.receipt_generated = $${idx}`);
    values.push(receipt_generated === 'true');
    idx++;
  }
  if (search) {
    conditions.push(`(p.name ILIKE $${idx} OR p.phone ILIKE $${idx} OR d.receipt_number ILIKE $${idx})`);
    values.push(`%${search}%`);
    idx++;
  }
  if (source_site) { conditions.push(`d.source_site = $${idx}`); values.push(source_site); idx++; }
  // Compared in the same canonical shape the dashboard groups by (lower-case,
  // one leading slash, no trailing slash) - the sites spell the same page as
  // "donations", "/donations" and "/Donations/", so a raw equality check here
  // would send the dashboard's own links to an empty list.
  if (source_page) {
    conditions.push(`(${canonPageSql('d.source_page')}) = $${idx}`);
    values.push(canonPage(String(source_page)));
    idx++;
  }
  // Whole bucket rather than one page: ?group=donations returns /donations AND
  // everything nested under it, ?group=donate the seva campaign pages. The
  // predicate comes from utils/pageGroups so this list and the dashboard can
  // never disagree about what belongs where. Not parameterised because it is a
  // fixed fragment chosen by an allowlist - `group` itself never reaches SQL.
  if (isPageGroup(group)) {
    conditions.push(groupPredicateSql(group, 'd.source_page', 'd.source_site'));
  }
  if (campaign)    { conditions.push(`d.campaign = $${idx}`);    values.push(campaign);    idx++; }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // The filtered total is returned alongside the page so the UI can show
  // "showing 1-25 of 4,004" and render real pagination instead of silently
  // truncating at the page limit.
  const [data, count, sum] = await Promise.all([
    pool.query(
      // display_purpose alongside the raw purpose, never instead of it: the
      // table shows the readable label while the filters, the CSV and anything
      // reconciled against the source site keep the value that site sent.
      `SELECT d.*, p.name as donor_name, p.phone as donor_phone,
              ${displayPurposeSql('d.purpose', 'd.source_page')} AS display_purpose
       FROM donations d JOIN people p ON d.person_id = p.id
       ${where} ORDER BY d.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, limit, offset]
    ),
    pool.query(`SELECT COUNT(*) FROM donations d JOIN people p ON d.person_id = p.id ${where}`, values),
    pool.query(`SELECT COALESCE(SUM(d.amount), 0) AS total FROM donations d JOIN people p ON d.person_id = p.id ${where}`, values),
  ]);

  const total = Number(count.rows[0].count);

  res.json({
    donations: data.rows.map((r) => ({ ...r, amount: Number(r.amount) })),
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    filteredAmount: Number(sum.rows[0].total),
  });
});

// Distinct purposes actually present in the data, for the filter dropdown.
//
// A hardcoded list of four purposes was fine when every donation was entered
// here by hand, but purposes synced from hkmsite2.0 are free-text seva names -
// so a fixed dropdown can't filter most of the real data. Matching is
// case-insensitive for the same reason the dashboard groups that way.
router.get('/purposes', async (_req, res) => {
  const result = await pool.query(`
    SELECT lower(${displayPurposeSql('purpose', 'source_page')}) AS purpose, COUNT(*) AS count
    FROM donations
    GROUP BY lower(${displayPurposeSql('purpose', 'source_page')})
    ORDER BY count DESC
  `);
  res.json(result.rows.map((r) => ({ purpose: r.purpose, count: Number(r.count) })));
});

// Distinct source sites and pages present in the data, for the filters.
// Derived from the rows rather than hardcoded, because each site adds campaign
// pages (/janmashtami, /govardhan, ...) without DRM knowing in advance.
router.get('/sources', async (_req, res) => {
  const [sites, pages] = await Promise.all([
    pool.query(`
      SELECT source_site, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
      FROM donations GROUP BY source_site ORDER BY total DESC
    `),
    // Canonicalised, so the dropdown offers "/donations" once rather than
    // "donations" and "/donations" as two entries that each show half the rows.
    pool.query(`
      SELECT source_site,
             '/' || btrim(lower(btrim(source_page)), '/') AS source_page,
             COUNT(*) AS count,
             COALESCE(SUM(amount), 0) AS total
      FROM donations
      WHERE source_page IS NOT NULL AND btrim(source_page) <> ''
      GROUP BY source_site, '/' || btrim(lower(btrim(source_page)), '/')
      ORDER BY count DESC
      LIMIT 60
    `),
  ]);
  res.json({
    sites: sites.rows.map((r) => ({ site: r.source_site, count: Number(r.count), total: Number(r.total) })),
    pages: pages.rows.map((r) => ({
      site: r.source_site,
      page: r.source_page,
      count: Number(r.count),
      total: Number(r.total),
    })),
  });
});

// Summary stats
router.get('/summary', async (_req, res) => {
  const result = await pool.query(`
    SELECT
      purpose,
      SUM(amount) as total,
      COUNT(*) as count
    FROM donations
    WHERE receipt_generated = false
    GROUP BY purpose
  `);
  res.json(result.rows);
});

// Record a donation
router.post('/', async (req, res) => {
  const { person_id, amount, type, purpose, payment_mode, source } = req.body;
  const result = await pool.query(
    `INSERT INTO donations (person_id, amount, type, purpose, payment_mode, source)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [person_id, amount, type, purpose, payment_mode, source]
  );
  res.status(201).json(result.rows[0]);
});

// Bulk sync donations (from live site)
// ---------------------------------------------------------------------------
// POST /offline - record a donation taken in cash, cheque, UPI or bank transfer.
//
// DRM does not issue receipts. The admin picks which site the receipt should
// come from, and that site's existing offline path runs: DCC is called, the
// 80G receipt number is allocated from that site's own series, the PDF is
// generated and WhatsApp goes out. Exactly what happens when staff use that
// site's own admin form.
//
// Then DRM pulls the donor's fresh snapshot back and upserts it, so the donation
// appears here immediately with its real receipt number instead of waiting for
// the next import.
router.post('/offline', async (req, res) => {
  const {
    site,
    donor_name,
    donor_mobile,
    donor_email,
    amount,
    payment_mode,
    reference_no,
    payment_date,
    seva_name,
    pan_number,
    want_certificate,
    want_prasadam,
    prasadam_address,
    note,
  } = req.body ?? {};

  // Validate here as well as on the site. Not redundant: a clear message from
  // DRM beats a round trip that comes back with another system's wording, and
  // it keeps an obviously bad entry off a live donation database entirely.
  const errors: string[] = [];
  if (site !== 'hkmv' && site !== 'annadan') errors.push('Choose which site should issue the receipt');
  else if (!isSiteConfigured(site)) errors.push(`The ${site} site is not configured on this server`);

  const amt = Number(amount);
  if (!String(donor_name || '').trim()) errors.push('Donor name is required');
  if (!String(donor_mobile || '').replace(/\D/g, '')) errors.push('A mobile number is required for the receipt');
  if (!Number.isFinite(amt) || amt <= 0) errors.push('Enter a valid amount');
  if (!String(reference_no || '').trim()) {
    errors.push('A reference number is required — the UTR, cheque number or receipt book number');
  }
  if (!['cash', 'cheque', 'upi', 'bank'].includes(String(payment_mode))) {
    errors.push('Payment mode must be cash, cheque, upi or bank');
  }
  if (want_prasadam && !String(prasadam_address || '').trim()) {
    errors.push('A delivery address is needed when prasadam is requested');
  }
  if (want_certificate && !String(pan_number || '').trim()) {
    errors.push('A PAN is needed for an 80G certificate');
  }
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  const siteKey = site as SiteKey;

  // Who is recording this, for the audit trail and for the note that shows on
  // the source site's own record.
  let enteredByName: string | null = null;
  if (req.user?.userId) {
    const u = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.userId]);
    enteredByName = u.rows[0]?.name ?? null;
  }

  let issued;
  try {
    issued = await createOfflineDonation(siteKey, {
      donorName: String(donor_name).trim(),
      donorMobile: String(donor_mobile).trim(),
      donorEmail: donor_email ? String(donor_email).trim() : null,
      amount: amt,
      paymentMode: String(payment_mode),
      referenceNo: String(reference_no).trim(),
      paymentDate: payment_date || null,
      sevaName: seva_name ? String(seva_name).trim() : null,
      panNumber: pan_number ? String(pan_number).trim() : null,
      wantCertificate: !!want_certificate,
      wantPrasadam: !!want_prasadam,
      prasadamAddress: prasadam_address ? String(prasadam_address).trim() : null,
      // The parts, so the site's receipt renders a laid-out address instead of
      // one line. Sent as given, or taken from the donor's saved address when
      // the form did not supply them.
      prasadamParts: normalizeAddress(req.body?.prasadam_parts as Partial<Address>),
      billingParts: normalizeAddress(req.body?.address_parts as Partial<Address>),
      note: note ? String(note).trim() : null,
      enteredByName,
    });
  } catch (err) {
    const e = err as Error & { status?: number };
    console.error('donations.offline error:', e.message);
    // 409 (duplicate reference) is passed through as 409 so the UI can say
    // "already recorded" rather than "something went wrong". Anything else the
    // site refused is a 502: DRM is fine, the upstream declined.
    const status = e.status === 409 || e.status === 400 ? e.status : 502;
    return res.status(status).json({ error: e.message });
  }

  // The receipt exists on the source site now. Pulling the donor's snapshot
  // back is a convenience, so a failure here must not read as a failed
  // donation - it just means this row appears on the next import instead.
  // "synced" means THIS donation is now visible in DRM - not merely that the
  // donor lookup answered. The site can return a snapshot that does not yet
  // include the new donation (DCC still working, or the read lagging the write),
  // and reporting success then would have the UI claim a row that isn't there.
  let synced = false;
  try {
    const snapshot = await fetchDonorSnapshot(siteKey, String(donor_mobile));
    if (snapshot?.found) {
      const result = await upsertDonorSnapshot(snapshot, siteKey);

      if (issued.externalId) {
        // Also correct what the sync path cannot know. upsertDonation writes a
        // fixed payment_mode of 'upi' because that is what the overwhelming
        // majority of website donations are - but this one was taken in cash,
        // by cheque or over a bank transfer, and staff need to see that. The
        // reference number goes into payment_ref for the same reason: it is
        // how this donation is traced back to the bank statement or receipt book.
        const marked = await pool.query(
          `UPDATE donations SET
             entered_by   = $1,
             source       = 'offline',
             payment_mode = $4,
             payment_ref  = COALESCE(payment_ref, $5)
           WHERE external_ref = $2 AND person_id = $3
           RETURNING id`,
          [
            req.user?.userId ?? null,
            issued.externalId,
            result.personId,
            String(payment_mode),
            String(reference_no).trim(),
          ]
        );
        synced = (marked.rowCount ?? 0) > 0;
      }
    }
  } catch (err) {
    console.error('donations.offline sync-back failed (non-fatal):', (err as Error).message);
  }

  res.status(201).json({
    site: siteKey,
    receiptNumber: issued.receiptNumber,
    externalId: issued.externalId,
    donorName: issued.donorName,
    amount: issued.amount,
    synced,
    message: issued.receiptNumber
      ? `Receipt ${issued.receiptNumber} issued by the ${siteKey === 'annadan' ? 'annadan' : 'main'} site.` +
        (synced ? '' : ' It will show in this list after the next import.')
      : 'Donation recorded. The receipt number has not come back yet — it will appear once DCC responds.',
  });
});

router.post('/sync', async (req, res) => {
  const { donations } = req.body;
  const results = [];

  for (const d of donations) {
    // Upsert person by phone, then insert donation
    const person = await pool.query(
      `INSERT INTO people (name, phone, email)
       VALUES ($1, $2, $3)
       ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, email = COALESCE(EXCLUDED.email, people.email)
       RETURNING id`,
      [d.name, d.phone, d.email]
    );
    const donation = await pool.query(
      `INSERT INTO donations (person_id, amount, type, purpose, payment_mode, source)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [person.rows[0].id, d.amount, d.type || 'one-time', d.purpose, d.payment_mode, d.source]
    );
    results.push(donation.rows[0]);
  }

  res.json({ synced: results.length, donations: results });
});

// Mark a donation's 80G receipt as issued -> fires a receipt_ready trigger for WhatsApp delivery
router.patch('/:id/receipt', async (req, res) => {
  const { id } = req.params;
  const { receipt_number, receipt_url } = req.body;

  const result = await pool.query(
    `UPDATE donations SET
       receipt_generated = TRUE,
       receipt_number = COALESCE($1, receipt_number),
       receipt_url = COALESCE($2, receipt_url),
       receipt_issued_at = NOW()
     WHERE id = $3 RETURNING *`,
    [receipt_number ?? null, receipt_url ?? null, id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Donation not found' });

  const donation = result.rows[0];
  await pool.query(
    `INSERT INTO triggers (person_id, trigger_type, payload) VALUES ($1, 'receipt_ready', $2)`,
    [
      donation.person_id,
      JSON.stringify({
        donation_id: id,
        amount: donation.amount,
        receipt_number: donation.receipt_number,
        receipt_url: donation.receipt_url,
      }),
    ]
  );
  res.json(donation);
});

// Streams the real 80G receipt PDF from hkmsite2.0 for a donation that was
// synced in from there (external_ref = its Mongo _id). A donation created
// natively in DRM has no external_ref and no receipt file to proxy - use
// PATCH /:id/receipt for those instead.
// Ask the originating site to re-send its WhatsApp receipt for this donation.
//
// DRM deliberately does not compose or send the receipt itself: the template,
// the receipt numbering and the PDF all live on the site that issued it, and
// duplicating any of that here would produce receipts that differ from the
// originals a donor already has.
router.post('/:id/resend-receipt', async (req, res) => {
  const result = await pool.query(
    'SELECT external_ref, source_site, receipt_number, receipt_generated FROM donations WHERE id = $1',
    [req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Donation not found' });

  const { external_ref, source_site, receipt_generated } = result.rows[0];

  if (!external_ref) {
    return res.status(400).json({
      error: 'This donation was recorded directly in DRM, so there is no site receipt to resend.',
    });
  }
  if (!receipt_generated) {
    return res.status(400).json({ error: 'No receipt has been issued for this donation yet.' });
  }

  try {
    const outcome = await resendReceipt((source_site || 'hkmv') as SiteKey, external_ref);
    res.json({
      resent: true,
      sentTo: outcome.sentTo ?? null,
      receiptNumber: outcome.receiptNumber ?? result.rows[0].receipt_number ?? null,
      site: source_site || 'hkmv',
    });
  } catch (err) {
    // Preserve the site's own status. 409 (no receipt issued yet) and 429
    // (just sent) are deliberate refusals, not outages - reporting them as 502
    // makes a correct safety guard look like a broken server.
    const e = err as Error & { status?: number; alreadySent?: boolean };
    const status = e.status === 409 || e.status === 429 ? e.status : 502;
    res.status(status).json({ error: e.message, alreadySent: Boolean(e.alreadySent) });
  }
});

router.get('/:id/receipt-file', async (req, res) => {
  const { id } = req.params;
  const result = await pool.query('SELECT external_ref, receipt_number FROM donations WHERE id = $1', [id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Donation not found' });

  const { external_ref, receipt_number, source_site } = result.rows[0];
  if (!external_ref) {
    return res.status(400).json({ error: 'This donation has no linked hkmsite2.0 record to fetch a receipt file from.' });
  }

  try {
    const upstream = await fetchReceiptPdf((source_site || 'hkmv') as SiteKey, external_ref);
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return res.status(upstream.status).json({ error: text || 'Could not fetch the receipt from hkmsite2.0' });
    }
    const arrayBuffer = await upstream.arrayBuffer();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="receipt-${(receipt_number || id).replace(/[^a-zA-Z0-9-]/g, '-')}.pdf"`
    );
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

export default router;
