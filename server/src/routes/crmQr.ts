// Razorpay QR codes a caller can share mid-call.
//
// WHAT HAPPENS TODAY, WITHOUT THIS
// A donor says "send me the QR". The caller opens WhatsApp on their own phone
// and sends a QR image from their gallery. The donor pays. Razorpay records a
// payment against that QR and nothing else: no lead, no caller, no call. A week
// later somebody reconciles a bank statement by hand and guesses.
//
// WHAT THIS CHANGES
// The caller shares from DRM, so DRM knows a row exists - this QR went to this
// number, for this lead, by this caller, in this session, at this moment. When
// Razorpay reports the payment, that row is what it is matched against.
//
// WHY NO RAZORPAY API KEYS ARE NEEDED TO SHARE
// The QRs are made once in the Razorpay dashboard and their ids pasted in here.
// Sharing is a WhatsApp message with an image URL - no API call at all. Keys
// are only wanted for reading payments back, and even that is optional: the
// webhook pushes, and the reconcile sweep is a convenience for when a webhook
// was missed.
//
// MATCHING IS A GUESS, AND SAYS SO
// A UPI payment carries a VPA, sometimes a name, often no phone number at all.
// So a match is scored, not asserted: the same QR, close in time, the right
// amount, the payer's phone if there is one. A confident match is applied; a
// doubtful one goes to a screen for a human. Nothing is silently attributed,
// because a donation credited to the wrong caller is worse than one credited
// to nobody.

import { Router } from 'express';
import crypto from 'crypto';
import pool from '../db/pool';
import { authenticate, authorize } from '../middleware/auth';
import * as storage from '../services/storage';
import { createOfflineDonation, type SiteKey } from '../services/hkmvClient';

const router = Router();

/**
 * The webhook lives on its own router, mounted OUTSIDE /api/crm.
 *
 * It cannot sit with the rest. crmRoutes calls router.use(authenticate), and a
 * router-level use() runs for every path under its mount point - including
 * paths that router has no route for. So a request to /api/crm/qr/webhook
 * entered crmRoutes, was refused for having no token, and never reached this
 * file at all. Razorpay would have seen nothing but 401s.
 */
export const webhookRouter = Router();

const str = (v: unknown, max = 255): string | null => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};
const phone10 = (v: unknown): string => String(v ?? '').replace(/\D/g, '').slice(-10);

/**
 * The image a donor actually receives.
 *
 * A branded image uploaded by the temple wins over Razorpay's plain square,
 * but only when the bucket can give it a public URL - a donor's phone fetches
 * this straight from WhatsApp, with no DRM session, so a private object would
 * simply fail to load. Falls back to the pasted Razorpay URL, which is how
 * every QR works before anybody uploads anything.
 */
function qrImage(q: { image_key?: string | null; image_url?: string | null }): string | null {
  if (q.image_key) {
    const url = storage.publicUrl(q.image_key);
    if (url) return url;
  }
  return q.image_url ?? null;
}

/**
 * GET /storage/status - whether file storage is set up, and what that means.
 *
 * The screens ask this rather than assuming, so an unconfigured bucket shows
 * as a plain explanation of what is not being kept instead of a broken button
 * or a silent absence.
 */
router.get('/storage/status', authenticate, async (_req, res) => {
  try {
    const counts = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM lead_import_batches WHERE file_key IS NOT NULL) AS sheets_kept,
         (SELECT COUNT(*)::int FROM lead_import_batches) AS sheets_total,
         (SELECT COUNT(*)::int FROM receipt_cache) AS receipts_cached,
         (SELECT COALESCE(SUM(bytes),0)::bigint FROM receipt_cache) AS receipt_bytes,
         (SELECT COUNT(*)::int FROM razorpay_qrs WHERE image_key IS NOT NULL) AS qr_images`
    );
    res.json({
      configured: storage.isConfigured(),
      public_urls: storage.hasPublicUrls(),
      ...counts.rows[0],
    });
  } catch (err) {
    console.error('crm.storageStatus error:', err);
    res.status(500).json({ error: 'Could not read the storage status' });
  }
});

/* =========================================================== the QR codes */

router.get('/qrs', authenticate, async (req, res) => {
  // A caller sees their own plus the temple's shared ones; an admin sees the
  // lot, because somebody has to be able to find a QR that was assigned to a
  // person who has since left.
  const all = req.query.all === 'true' && req.user?.role === 'admin';
  try {
    const rows = await pool.query(
      `SELECT q.*, u.name AS owner_name,
              c.shares, c.matched, c.raised
         FROM razorpay_qrs q
         LEFT JOIN users u ON q.owner_id = u.id
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS shares,
                  COUNT(*) FILTER (WHERE s.matched_at IS NOT NULL)::int AS matched,
                  COALESCE(SUM(s.matched_amount), 0)::numeric AS raised
             FROM qr_shares s WHERE s.qr_id = q.id
         ) c ON TRUE
        WHERE ($1::boolean OR (q.active AND (q.owner_id IS NULL OR q.owner_id = $2::uuid)))
        ORDER BY q.owner_id IS NULL, u.name NULLS FIRST, q.label`,
      [all, req.user?.userId ?? null]
    );
    res.json({ qrs: rows.rows });
  } catch (err) {
    console.error('crm.listQrs error:', err);
    res.status(500).json({ error: 'Could not load the QR codes' });
  }
});

router.post('/qrs', authenticate, authorize('admin'), async (req, res) => {
  const qrId = str(req.body?.qr_id, 60);
  const label = str(req.body?.label, 120);
  if (!qrId) return res.status(400).json({ error: "The QR's id from Razorpay is needed" });
  if (!label) return res.status(400).json({ error: 'Give the QR a label the caller will recognise' });
  // Razorpay QR ids look like qr_XXXXXXXXXXXX. Checked rather than enforced,
  // because a rejected id is worse than an odd-looking one that works.
  const looksRight = /^qr_[A-Za-z0-9]+$/.test(qrId);

  try {
    const r = await pool.query(
      `INSERT INTO razorpay_qrs (qr_id, label, image_url, purpose, fixed_amount, owner_id, notes, created_by, receipt_site)
       VALUES ($1,$2,$3,$4,$5::numeric,$6::uuid,$7,$8::uuid,$9)
       ON CONFLICT (qr_id) DO UPDATE SET
         receipt_site = COALESCE(EXCLUDED.receipt_site, razorpay_qrs.receipt_site),
         label = EXCLUDED.label,
         image_url = COALESCE(EXCLUDED.image_url, razorpay_qrs.image_url),
         purpose = COALESCE(EXCLUDED.purpose, razorpay_qrs.purpose),
         fixed_amount = COALESCE(EXCLUDED.fixed_amount, razorpay_qrs.fixed_amount),
         owner_id = EXCLUDED.owner_id,
         notes = COALESCE(EXCLUDED.notes, razorpay_qrs.notes),
         active = TRUE,
         updated_at = NOW()
       RETURNING *`,
      [
        qrId,
        label,
        str(req.body?.image_url, 1000),
        str(req.body?.purpose, 80),
        req.body?.fixed_amount ? Number(req.body.fixed_amount) : null,
        str(req.body?.owner_id, 36),
        str(req.body?.notes, 2000),
        req.user?.userId ?? null,
        req.body?.receipt_site === 'annadan' || req.body?.receipt_site === 'hkmv'
          ? req.body.receipt_site
          : null,
      ]
    );
    res.status(201).json({ qr: r.rows[0], warning: looksRight ? null : "That doesn't look like a Razorpay QR id (they start with qr_)." });
  } catch (err) {
    console.error('crm.createQr error:', err);
    res.status(500).json({ error: 'Could not save that QR' });
  }
});

router.put('/qrs/:id', authenticate, authorize('admin'), async (req, res) => {
  const b = req.body ?? {};
  try {
    const r = await pool.query(
      `UPDATE razorpay_qrs SET
         label = COALESCE($2, label),
         image_url = COALESCE($3, image_url),
         purpose = COALESCE($4, purpose),
         owner_id = CASE WHEN $5::boolean THEN $6::uuid ELSE owner_id END,
         active = COALESCE($7::boolean, active),
         notes = COALESCE($8, notes),
         receipt_site = COALESCE($9, receipt_site),
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [
        req.params.id,
        str(b.label, 120),
        str(b.image_url, 1000),
        str(b.purpose, 80),
        b.owner_id !== undefined,
        str(b.owner_id, 36),
        typeof b.active === 'boolean' ? b.active : null,
        str(b.notes, 2000),
        b.receipt_site === 'annadan' || b.receipt_site === 'hkmv' ? b.receipt_site : null,
      ]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'No such QR' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('crm.updateQr error:', err);
    res.status(500).json({ error: 'Could not save that QR' });
  }
});

/* ============================================================== sharing it */

/**
 * POST /leads/:id/share-qr - record that a QR went to this lead, and build the
 * WhatsApp message.
 *
 * The row is written BEFORE the caller presses send in WhatsApp, and that order
 * is deliberate. DRM cannot know whether they actually sent it - click-to-chat
 * opens a window and says nothing back - so the honest record is "this was
 * offered at this moment", which is exactly what a later payment needs to be
 * matched against. A share that never got sent simply never matches anything.
 */
router.post('/leads/:id/share-qr', authenticate, async (req, res) => {
  const qrRowId = str(req.body?.qr_id, 36);
  if (!qrRowId) return res.status(400).json({ error: 'Choose a QR to send' });

  try {
    const lead = await pool.query(
      `SELECT l.*, p.id AS pid FROM leads l LEFT JOIN people p ON l.person_id = p.id WHERE l.id = $1`,
      [req.params.id]
    );
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead not found' });
    const l = lead.rows[0];

    const qr = await pool.query(
      `SELECT * FROM razorpay_qrs WHERE id = $1 AND active
         AND (owner_id IS NULL OR owner_id = $2::uuid OR $3 = 'admin')`,
      [qrRowId, req.user?.userId ?? null, req.user?.role ?? '']
    );
    if (!qr.rows.length) return res.status(404).json({ error: 'That QR is not available to you' });
    const q = qr.rows[0];

    const amount = req.body?.expected_amount ? Number(req.body.expected_amount) : null;

    const share = await pool.query(
      `INSERT INTO qr_shares
         (qr_id, lead_id, person_id, shared_by, session_id, phone, expected_amount, channel, note)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7::numeric,$8,$9)
       RETURNING *`,
      [
        q.id,
        l.id,
        l.pid,
        req.user?.userId ?? null,
        str(req.body?.session_id, 36),
        phone10(l.phone),
        amount,
        str(req.body?.channel, 20) ?? 'whatsapp',
        str(req.body?.note, 2000),
      ]
    );

    // The message. The QR image URL goes in as a link rather than an
    // attachment because click-to-chat cannot attach a file - WhatsApp will
    // preview it, and the donor can long-press to save it.
    const name = l.name ? ` ${String(l.name).split(' ')[0]}` : '';
    const forWhat = q.purpose ? ` for ${q.purpose}` : '';
    const amountLine = amount ? `\nAmount: ₹${Number(amount).toLocaleString('en-IN')}` : '';
    const message =
      `Hare Krishna${name}, thank you for speaking with me.\n\n` +
      `Here is the QR to donate${forWhat}:\n${qrImage(q) || '(QR image)'}${amountLine}\n\n` +
      `Hare Krishna Movement, Visakhapatnam`;

    await pool.query(
      `INSERT INTO lead_activities (lead_id, user_id, kind, note, session_id)
       VALUES ($1,$2,'note',$3,$4::uuid)`,
      [
        l.id,
        req.user?.userId ?? null,
        `Opened WhatsApp with the ${q.label} QR${amount ? ` for ₹${Number(amount).toLocaleString('en-IN')}` : ''}.`,
        str(req.body?.session_id, 36),
      ]
    );

    res.status(201).json({
      share: share.rows[0],
      qr: { label: q.label, image_url: q.image_url, purpose: q.purpose },
      message,
      wa_url: `https://wa.me/91${phone10(l.phone)}?text=${encodeURIComponent(message)}`,
    });
  } catch (err) {
    console.error('crm.shareQr error:', err);
    res.status(500).json({ error: 'Could not share that QR' });
  }
});

/**
 * POST /qrs/:id/image - upload a branded QR image.
 *
 * Razorpay hosts a plain black-and-white square. This lets the temple send the
 * one it designed - logo, seva name, the deity - which is what a donor on
 * WhatsApp actually recognises.
 *
 * Needs a PUBLIC bucket, and says so rather than silently storing something no
 * donor can fetch: the image is loaded by a phone straight from a WhatsApp
 * message, with no DRM session behind it.
 */
router.post('/qrs/:id/image', authenticate, authorize('admin'), async (req, res) => {
  if (!storage.isConfigured()) {
    return res.status(503).json({ error: 'File storage is not set up, so images cannot be uploaded yet.' });
  }
  if (!storage.hasPublicUrls()) {
    return res.status(503).json({
      error:
        'This bucket has no public URL set, so a donor could not load the image. Set R2_PUBLIC_BASE_URL, or paste the Razorpay image link instead.',
    });
  }

  const base64 = String(req.body?.base64 ?? '');
  const filename = str(req.body?.filename, 255) ?? 'qr.png';
  if (!base64) return res.status(400).json({ error: 'No image received' });

  const ext = (filename.split('.').pop() ?? 'png').toLowerCase();
  const types: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
  if (!types[ext]) return res.status(400).json({ error: 'Use a PNG, JPG or WebP image' });

  const buf = Buffer.from(base64, 'base64');
  // A QR image is tens of kilobytes. Anything past two megabytes is a photo
  // somebody picked by mistake, and it would be slow to load on the phone it
  // is meant for.
  if (buf.length > 2 * 1024 * 1024) {
    return res.status(400).json({ error: 'That image is over 2 MB. A QR image should be far smaller.' });
  }

  try {
    const key = storage.keys.qrImage(String(req.params.id), ext);
    const put = await storage.putObject(key, buf, types[ext]);
    if (!put.ok) return res.status(502).json({ error: 'Could not store that image' });

    const r = await pool.query(
      `UPDATE razorpay_qrs SET image_key = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id, key]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'No such QR' });
    res.json({ qr: r.rows[0], url: put.url });
  } catch (err) {
    console.error('crm.qrImage error:', err);
    res.status(500).json({ error: 'Could not save that image' });
  }
});

/** Back to Razorpay's own image. */
router.delete('/qrs/:id/image', authenticate, authorize('admin'), async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE razorpay_qrs SET image_key = NULL, updated_at = NOW() WHERE id = $1 RETURNING image_key`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'No such QR' });
    res.json({ removed: true });
  } catch (err) {
    console.error('crm.removeQrImage error:', err);
    res.status(500).json({ error: 'Could not remove that image' });
  }
});

/* ========================================================= matching payments */

interface ShareRow {
  id: string;
  qr_id: string;
  phone: string;
  expected_amount: string | null;
  created_at: string;
  lead_id: string | null;
  person_id: string | null;
}

/**
 * Score a share against a payment.
 *
 * Returns null when the share cannot be the one. Higher is better; the caller
 * decides what counts as confident.
 *
 * The weights say what DRM actually knows. The payer's phone matching is near
 * proof, so it dominates. Time is the weakest signal but the most commonly
 * available, so it only breaks ties. The amount matters but must not be
 * required: donors round up, donors give less than they said, and a donor who
 * promised ₹5,000 and sent ₹5,100 is still that donor.
 */
function scoreShare(share: ShareRow, payment: { amount: number; payer_phone: string | null; received_at: Date }): number | null {
  const shared = new Date(share.created_at);
  const hours = (payment.received_at.getTime() - shared.getTime()) / 3_600_000;
  // Before the share, or more than a week after, is somebody else's payment.
  if (hours < -0.05 || hours > 168) return null;

  let score = 0;
  if (payment.payer_phone && payment.payer_phone === share.phone) score += 100;

  const expected = share.expected_amount ? Number(share.expected_amount) : null;
  if (expected) {
    const diff = Math.abs(payment.amount - expected) / expected;
    if (diff < 0.005) score += 40;
    else if (diff < 0.1) score += 20;
    else if (diff < 0.5) score += 5;
  }

  // Sooner is likelier: most QR donations happen while the caller is still on
  // the line, or within the hour.
  if (hours <= 1) score += 25;
  else if (hours <= 6) score += 15;
  else if (hours <= 24) score += 8;
  else score += 2;

  return score;
}

/** A score at or above this is applied without asking anybody. */
const CONFIDENT = 60;

/**
 * Take a payment Razorpay has reported and try to attach it to a share.
 *
 * Exported so the webhook and the reconcile sweep use one implementation -
 * two copies of a matching rule is how a payment ends up credited twice.
 */
export async function matchPayment(paymentId: string): Promise<{ matched: boolean; shareId?: string; score?: number }> {
  const p = await pool.query(`SELECT * FROM qr_payments WHERE payment_id = $1`, [paymentId]);
  if (!p.rows.length || p.rows[0].share_id) return { matched: false };
  const pay = p.rows[0];

  const candidates = await pool.query(
    `SELECT s.* FROM qr_shares s
       JOIN razorpay_qrs q ON s.qr_id = q.id
      WHERE q.qr_id = $1
        AND s.matched_at IS NULL
        AND s.created_at > $2::timestamptz - INTERVAL '7 days'
        AND s.created_at <= $2::timestamptz + INTERVAL '5 minutes'
      ORDER BY s.created_at DESC
      LIMIT 50`,
    [pay.qr_id, pay.received_at]
  );
  if (!candidates.rows.length) return { matched: false };

  let best: { share: ShareRow; score: number } | null = null;
  for (const s of candidates.rows as ShareRow[]) {
    const score = scoreShare(s, {
      amount: Number(pay.amount),
      payer_phone: pay.payer_phone,
      received_at: new Date(pay.received_at),
    });
    if (score !== null && (!best || score > best.score)) best = { share: s, score };
  }

  if (!best || best.score < CONFIDENT) return { matched: false, score: best?.score };

  await pool.query(
    `UPDATE qr_shares SET
       matched_payment_id = $2, matched_amount = $3::numeric,
       matched_at = NOW(), matched_via = 'auto'
     WHERE id = $1`,
    [best.share.id, pay.payment_id, pay.amount]
  );
  await pool.query(
    `UPDATE qr_payments SET share_id = $2, person_id = $3 WHERE id = $1`,
    [pay.id, best.share.id, best.share.person_id]
  );

  // Move the lead. Recorded as 'manual' rather than 'auto' on purpose: 'auto'
  // in DRM means a donation that arrived through a site and was matched on the
  // donor's own phone number. A QR payment matched on timing and amount is a
  // strong inference, not an observation, and the reports must not present the
  // two as equal evidence.
  if (best.share.lead_id) {
    await pool.query(
      `UPDATE leads SET
         status = 'donated',
         converted_amount = COALESCE(converted_amount, 0) + $2::numeric,
         converted_at = COALESCE(converted_at, NOW()),
         converted_via = 'manual',
         converted_note = COALESCE(converted_note, 'Paid by QR, matched automatically'),
         updated_at = NOW()
       WHERE id = $1`,
      [best.share.lead_id, pay.amount]
    );
  }

  // The donor has paid and is owed a receipt. Not awaited: the webhook must
  // answer Razorpay promptly or it retries, and issuing a receipt means calling
  // another system that may be slow. What happened is recorded on the payment
  // and shown on the unmatched-and-unreceipted screen.
  void issueReceiptForPayment(pay.id).catch((e) =>
    console.error('crm.issueReceipt error:', (e as Error).message)
  );

  return { matched: true, shareId: best.share.id, score: best.score };
}

/**
 * Turn a matched QR payment into a real donation with an 80G receipt.
 *
 * THE HOLE THIS CLOSES
 * Matching a payment used to move the lead to Donated and stop there. No
 * donation record, no receipt number, no PDF - a donor gave five thousand
 * rupees through a QR and got nothing they could claim against tax.
 *
 * DRM cannot issue a receipt itself, and should not: each site allocates 80G
 * numbers from its own series, and two systems numbering into one series is
 * how a charity ends up with duplicates. So this goes down the site's own
 * offline-donation path - the same one a staff member uses for a cash
 * donation - which allocates the number, renders the PDF and sends it on
 * WhatsApp, exactly as it does for every other donation.
 *
 * The Razorpay payment id travels as the reference number, which also makes
 * this safe to retry: the sites reject a duplicate reference, so a second
 * attempt cannot raise a second receipt for the same money.
 */
export async function issueReceiptForPayment(paymentRowId: string): Promise<void> {
  const r = await pool.query(
    `SELECT p.*, s.lead_id, s.person_id, s.phone AS share_phone,
            q.receipt_site, q.purpose, q.label AS qr_label,
            l.name AS lead_name, l.email AS lead_email,
            pe.name AS person_name, pe.email AS person_email, pe.pan,
            pe.address_door, pe.address_house, pe.address_street, pe.address_area,
            pe.address_city, pe.address_state, pe.address_pincode, pe.address_country,
            pe.address AS address_text
       FROM qr_payments p
       JOIN qr_shares s ON p.share_id = s.id
       JOIN razorpay_qrs q ON s.qr_id = q.id
       LEFT JOIN leads l ON s.lead_id = l.id
       LEFT JOIN people pe ON s.person_id = pe.id
      WHERE p.id = $1`,
    [paymentRowId]
  );
  if (!r.rows.length) return;
  const p = r.rows[0];

  // Already done, or already being done. Guards against a webhook redelivery
  // racing the first attempt into two receipts.
  if (p.receipt_status === 'issued' || p.receipt_status === 'pending') return;

  if (!p.receipt_site) {
    await pool.query(
      `UPDATE qr_payments SET receipt_status = 'skipped',
         receipt_error = 'No site is set on this QR, so DRM does not know which 80G series to use.'
       WHERE id = $1`,
      [paymentRowId]
    );
    return;
  }

  await pool.query(`UPDATE qr_payments SET receipt_status = 'pending', receipt_error = NULL WHERE id = $1`, [
    paymentRowId,
  ]);

  try {
    const name = p.person_name || p.lead_name || p.payer_name || `Donor ${p.share_phone}`;
    const result = await createOfflineDonation(p.receipt_site as SiteKey, {
      donorName: name,
      donorMobile: p.share_phone,
      donorEmail: p.person_email || p.lead_email || null,
      amount: Number(p.amount),
      // It arrived by UPI through a Razorpay QR. Saying so keeps the site's own
      // books honest about how the money came in.
      paymentMode: 'upi',
      referenceNo: p.payment_id,
      paymentDate: new Date(p.received_at).toISOString(),
      sevaName: p.purpose || undefined,
      panNumber: p.pan || undefined,
      // Only where there is a PAN to put on it; a certificate without one is
      // no use to the donor.
      wantCertificate: !!p.pan,
      wantPrasadam: false,
      prasadamAddress: p.address_text || undefined,
      billingParts: {
        door: p.address_door, house: p.address_house, street: p.address_street, area: p.address_area,
        city: p.address_city, state: p.address_state, pincode: p.address_pincode, country: p.address_country,
      },
      enteredByName: `DRM · QR ${p.qr_label}`,
      note: `Paid by QR during a call. Razorpay payment ${p.payment_id}.`,
    });

    await pool.query(
      `UPDATE qr_payments SET
         receipt_status = 'issued',
         receipt_number = $2,
         external_donation_id = $3,
         receipt_site = $4,
         receipt_error = NULL
       WHERE id = $1`,
      [paymentRowId, result.receiptNumber, result.externalId, p.receipt_site]
    );
  } catch (e) {
    const err = e as Error & { status?: number };
    // A duplicate reference means the receipt already exists on that site,
    // which is a success from the donor's point of view even though the call
    // failed. Recorded as such rather than left looking like a failure
    // somebody has to chase.
    const duplicate = err.status === 409;
    await pool.query(
      `UPDATE qr_payments SET receipt_status = $2, receipt_error = $3 WHERE id = $1`,
      [paymentRowId, duplicate ? 'issued' : 'failed', duplicate ? null : err.message]
    );
  }
}

/**
 * POST /qr/webhook - Razorpay tells us about a payment.
 *
 * Mounted without the JWT (Razorpay has no token) and verified by signature
 * instead. Always answers 200 on a well-formed request, even when nothing
 * matches: Razorpay retries anything else, and a payment DRM cannot attribute
 * is still a payment worth storing rather than a delivery worth repeating.
 */
webhookRouter.post('/webhook', async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'No webhook secret is configured' });

  const signature = String(req.headers['x-razorpay-signature'] ?? '');
  // The raw body, captured by the verify hook in index.ts. A signature checked
  // against re-serialised JSON would fail on key order alone.
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (!raw) return res.status(400).json({ error: 'No raw body to verify' });

  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const ok =
    signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!ok) return res.status(401).json({ error: 'Bad signature' });

  try {
    const event = req.body?.event as string;
    const entity = req.body?.payload?.payment?.entity as Record<string, unknown> | undefined;
    if (!entity || !String(event ?? '').startsWith('payment')) return res.json({ ignored: true });

    const notes = (entity.notes ?? {}) as Record<string, unknown>;
    const contact = String(entity.contact ?? '').replace(/\D/g, '').slice(-10);

    const stored = await pool.query(
      `INSERT INTO qr_payments
         (payment_id, qr_id, amount, payer_phone, payer_vpa, payer_name, status, raw, received_at)
       VALUES ($1,$2,$3::numeric,$4,$5,$6,$7,$8::jsonb, to_timestamp($9))
       ON CONFLICT (payment_id) DO UPDATE SET status = EXCLUDED.status, raw = EXCLUDED.raw
       RETURNING id, payment_id`,
      [
        String(entity.id),
        str(req.body?.payload?.qr_code?.entity?.id ?? notes.qr_id, 60),
        Number(entity.amount ?? 0) / 100,
        contact || null,
        str(entity.vpa, 120),
        str(notes.name ?? entity.email, 160),
        str(entity.status, 20),
        JSON.stringify(entity),
        Number(entity.created_at ?? Math.floor(Date.now() / 1000)),
      ]
    );

    const result = await matchPayment(stored.rows[0].payment_id);
    res.json({ stored: true, ...result });
  } catch (err) {
    console.error('crm.qrWebhook error:', err);
    // Still 200: Razorpay would otherwise retry for hours over a bug of ours.
    res.json({ stored: false });
  }
});

/**
 * POST /qr/payments/:id/issue-receipt - try again.
 *
 * For the case where the site refused the entry - it was down, or the entry
 * was rejected - and somebody wants another go once it is fixed. Safe to press
 * twice: the sites reject a duplicate reference number, so a second attempt
 * cannot raise a second receipt for the same money.
 */
router.post('/qr/payments/:id/issue-receipt', authenticate, async (req, res) => {
  try {
    await pool.query(`UPDATE qr_payments SET receipt_status = NULL WHERE id = $1`, [req.params.id]);
    await issueReceiptForPayment(String(req.params.id));
    const r = await pool.query(
      `SELECT receipt_status, receipt_error, receipt_number FROM qr_payments WHERE id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'No such payment' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('crm.retryReceipt error:', err);
    res.status(500).json({ error: 'Could not issue that receipt' });
  }
});

/**
 * GET /qr/payments - what has come in, and what became of it.
 *
 * Defaults to everything needing attention: unmatched, or matched but with no
 * receipt raised. Those are the two states somebody has to act on, and keeping
 * them on one screen is what stops the second one being forgotten - a donation
 * credited to the right lead with no receipt behind it looks finished from
 * every other angle.
 */
router.get('/qr/payments', authenticate, async (req, res) => {
  const scope = String(req.query.scope ?? 'attention');
  const where =
    scope === 'all'
      ? 'TRUE'
      : scope === 'unmatched'
      ? 'p.share_id IS NULL'
      : "p.share_id IS NULL OR p.receipt_status IS NULL OR p.receipt_status IN ('failed','skipped','pending')";
  try {
    const rows = await pool.query(
      `SELECT p.*, q.label AS qr_label, q.receipt_site AS qr_receipt_site,
              u.name AS qr_owner, l.name AS lead_name, l.id AS lead_id
         FROM qr_payments p
         LEFT JOIN razorpay_qrs q ON q.qr_id = p.qr_id
         LEFT JOIN users u ON q.owner_id = u.id
         LEFT JOIN qr_shares s ON p.share_id = s.id
         LEFT JOIN leads l ON s.lead_id = l.id
        WHERE ${where}
        ORDER BY p.received_at DESC LIMIT 200`
    );
    res.json({ payments: rows.rows });
  } catch (err) {
    console.error('crm.qrPayments error:', err);
    res.status(500).json({ error: 'Could not load the QR payments' });
  }
});

/** GET /qr/unmatched - payments nobody has claimed. A screen, not a dead letter box. */
router.get('/qr/unmatched', authenticate, async (_req, res) => {
  try {
    const rows = await pool.query(
      `SELECT p.*, q.label AS qr_label, u.name AS qr_owner
         FROM qr_payments p
         LEFT JOIN razorpay_qrs q ON q.qr_id = p.qr_id
         LEFT JOIN users u ON q.owner_id = u.id
        WHERE p.share_id IS NULL
        ORDER BY p.received_at DESC LIMIT 200`
    );
    res.json({ payments: rows.rows });
  } catch (err) {
    console.error('crm.qrUnmatched error:', err);
    res.status(500).json({ error: 'Could not load the unmatched payments' });
  }
});

/** GET /qr/shares - what has been sent and what came of it. */
router.get('/qr/shares', authenticate, async (req, res) => {
  const mine = req.query.mine !== 'false';
  try {
    const rows = await pool.query(
      `SELECT s.*, q.label AS qr_label, l.name AS lead_name, u.name AS shared_by_name
         FROM qr_shares s
         JOIN razorpay_qrs q ON s.qr_id = q.id
         LEFT JOIN leads l ON s.lead_id = l.id
         LEFT JOIN users u ON s.shared_by = u.id
        WHERE ($1::uuid IS NULL OR s.shared_by = $1::uuid)
        ORDER BY s.created_at DESC LIMIT 200`,
      [mine ? req.user?.userId ?? null : null]
    );
    res.json({ shares: rows.rows });
  } catch (err) {
    console.error('crm.qrShares error:', err);
    res.status(500).json({ error: 'Could not load the QR history' });
  }
});

/** POST /qr/payments/:id/attach - a human links a payment to a share. */
router.post('/qr/payments/:id/attach', authenticate, async (req, res) => {
  const shareId = str(req.body?.share_id, 36);
  if (!shareId) return res.status(400).json({ error: 'Choose who this payment was from' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pay = await client.query(`SELECT * FROM qr_payments WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!pay.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No such payment' });
    }
    const share = await client.query(`SELECT * FROM qr_shares WHERE id = $1`, [shareId]);
    if (!share.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No such share' });
    }

    await client.query(
      `UPDATE qr_shares SET matched_payment_id = $2, matched_amount = $3::numeric,
         matched_at = NOW(), matched_via = 'manual', matched_by = $4::uuid WHERE id = $1`,
      [shareId, pay.rows[0].payment_id, pay.rows[0].amount, req.user?.userId ?? null]
    );
    await client.query(`UPDATE qr_payments SET share_id = $2, person_id = $3 WHERE id = $1`, [
      pay.rows[0].id,
      shareId,
      share.rows[0].person_id,
    ]);

    if (share.rows[0].lead_id) {
      await client.query(
        `UPDATE leads SET status = 'donated',
           converted_amount = COALESCE(converted_amount, 0) + $2::numeric,
           converted_at = COALESCE(converted_at, NOW()),
           converted_via = 'manual',
           converted_note = COALESCE(converted_note, 'Paid by QR, linked by hand'),
           updated_at = NOW()
         WHERE id = $1`,
        [share.rows[0].lead_id, pay.rows[0].amount]
      );
    }

    await client.query('COMMIT');

    // Now that it belongs to somebody, the donor is owed a receipt for it -
    // the same as if the webhook had matched it itself.
    void issueReceiptForPayment(pay.rows[0].id).catch((e) =>
      console.error('crm.issueReceipt error:', (e as Error).message)
    );

    res.json({ attached: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('crm.attachPayment error:', err);
    res.status(500).json({ error: 'Could not link that payment' });
  } finally {
    client.release();
  }
});

export default router;
