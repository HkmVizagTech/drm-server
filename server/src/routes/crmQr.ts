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

import { Router, type RequestHandler } from 'express';
import crypto from 'crypto';
import pool from '../db/pool';
import { authenticate, authorize } from '../middleware/auth';
import * as storage from '../services/storage';
import { createOfflineDonation, type SiteKey } from '../services/hkmvClient';
import {
  describeFilters,
  sendExport,
  EXPORT_ROW_CAP,
  type ExportFormat,
} from '../utils/export';

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
      // WHAT "RAISED" MEANS ON A QR, AND WHY IT CHANGED
      //
      // It used to sum qr_shares.matched_amount - money DRM had managed to
      // attribute to a particular share. But these QRs exist for one purpose:
      // a caller shares them on a call. So every rupee that arrives through
      // one was raised by calling, whether or not DRM worked out which call.
      // Counting only the attributed ones understated the QR by exactly the
      // payments nobody had got round to attributing yet, which is the worst
      // possible thing to under-report: the ones needing attention.
      //
      // So: raised is every captured payment on the QR. `attributed` is the
      // part tied to a donor, and the gap between them is the work outstanding.
      `SELECT q.*, u.name AS owner_name,
              c.shares, c.matched,
              p.raised, p.attributed, p.payments, p.unattributed, p.last_payment_at
         FROM razorpay_qrs q
         LEFT JOIN users u ON q.owner_id = u.id
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS shares,
                  COUNT(*) FILTER (WHERE s.matched_at IS NOT NULL)::int AS matched
             FROM qr_shares s WHERE s.qr_id = q.id
         ) c ON TRUE
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(pm.amount), 0)::numeric AS raised,
                  COALESCE(SUM(pm.amount) FILTER (WHERE pm.share_id IS NOT NULL), 0)::numeric AS attributed,
                  COUNT(*)::int AS payments,
                  COUNT(*) FILTER (WHERE pm.share_id IS NULL)::int AS unattributed,
                  MAX(pm.received_at) AS last_payment_at
             FROM qr_payments pm
            WHERE pm.qr_id = q.qr_id
              AND COALESCE(pm.status, 'captured') IN ('captured', 'authorized')
         ) p ON TRUE
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
/**
 * POST /qr/share-to - send a QR to a number DRM has never heard of.
 *
 * The share-by-lead route above assumes the person is already a lead, because
 * it was written for the calling screen. A caller who rang somebody from their
 * own phone, or who is standing in the temple with a number on a slip, has no
 * lead to share against - and without one the share is not recorded, so the
 * payment that follows arrives attached to nothing and has to be attributed by
 * hand or not at all.
 *
 * So this makes the lead first and then shares, which means every QR that
 * leaves DRM is recorded the same way whatever route it took out.
 */
router.post('/qr/share-to', authenticate, async (req, res) => {
  const phone = String(req.body?.phone ?? '').replace(/\D/g, '').slice(-10);
  if (phone.length !== 10) return res.status(400).json({ error: 'A 10-digit number is needed' });
  if (!str(req.body?.qr_id, 36)) return res.status(400).json({ error: 'Choose a QR to send' });

  try {
    const existing = await pool.query(`SELECT id FROM leads WHERE phone = $1`, [phone]);
    let leadId: string = existing.rows[0]?.id;

    if (!leadId) {
      const person = await pool.query(
        `SELECT id FROM people WHERE right(regexp_replace(phone,'\\D','','g'), 10) = $1 LIMIT 1`,
        [phone]
      );
      const made = await pool.query(
        `INSERT INTO leads (phone, name, person_id, source, source_detail, assigned_to, assigned_at, created_by)
         VALUES ($1,$2,$3::uuid,'manual','QR sent outside a DRM call',$4::uuid, NOW(), $4::uuid)
         RETURNING id`,
        [phone, str(req.body?.name, 255), person.rows[0]?.id ?? null, req.user?.userId ?? null]
      );
      leadId = made.rows[0].id;
      await pool.query(
        `INSERT INTO lead_activities (lead_id, user_id, kind, note)
         VALUES ($1::uuid,$2::uuid,'import','Added when a QR was sent to this number')`,
        [leadId, req.user?.userId ?? null]
      );
    }

    // Straight through the ordinary share handler, so the row, the message and
    // the WhatsApp link are built in exactly one place.
    req.params.id = leadId;
    return shareQrToLead(req, res, () => undefined);
  } catch (err) {
    console.error('crm.shareQrTo error:', err);
    res.status(500).json({ error: 'Could not send that QR' });
  }
});

const shareQrToLead: RequestHandler = async (req, res) => {
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
      // 'qr_share', not 'note'. The link-sharing path logs 'whatsapp' and the
      // lead's history renders that as a sentence; a QR share fell through to
      // the generic "Note", so the one action that leads to money looked like
      // somebody typing a remark.
      `INSERT INTO lead_activities (lead_id, user_id, kind, note, session_id)
       VALUES ($1,$2,'qr_share',$3,$4::uuid)`,
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
};

router.post('/leads/:id/share-qr', authenticate, shareQrToLead);

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

/**
 * GET /qrs/:id/image.png - the QR image, served by DRM.
 *
 * WHY PROXY SOMETHING WE ALREADY HAVE A URL FOR
 * The caller's browser copies this image to the clipboard so they can paste it
 * into WhatsApp, and reading pixels out of a cross-origin image is blocked
 * unless the far end sends CORS headers. An R2 public bucket does not by
 * default, and Razorpay's CDN is not ours to configure. Served from DRM's own
 * origin, the question does not arise.
 *
 * Always PNG on the way out: the clipboard API is only dependable with PNG,
 * and a JPEG that silently fails to copy would look like a broken button.
 */
router.get('/qrs/:id/image.png', authenticate, async (req, res) => {
  try {
    const r = await pool.query(`SELECT image_key, image_url, label FROM razorpay_qrs WHERE id = $1`, [
      req.params.id,
    ]);
    if (!r.rows.length) return res.status(404).json({ error: 'No such QR' });
    const q = r.rows[0];

    let buf: Buffer | null = null;
    let type = 'image/png';

    if (q.image_key) {
      buf = await storage.getObject(q.image_key);
      if (q.image_key.endsWith('.jpg') || q.image_key.endsWith('.jpeg')) type = 'image/jpeg';
      else if (q.image_key.endsWith('.webp')) type = 'image/webp';
    }

    // Nothing uploaded, so fetch Razorpay's own image and pass it through.
    if (!buf && q.image_url) {
      const upstream = await fetch(q.image_url).catch(() => null);
      if (upstream?.ok) {
        buf = Buffer.from(await upstream.arrayBuffer());
        type = upstream.headers.get('content-type') ?? 'image/png';
      }
    }

    if (!buf) {
      return res.status(404).json({
        error: 'This QR has no image yet. Upload one, or paste the Razorpay image link.',
      });
    }

    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(buf);
  } catch (err) {
    console.error('crm.qrImageProxy error:', err);
    res.status(500).json({ error: 'Could not fetch that image' });
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
  awaiting_payment_at: string | null;
  /** The lead's own expected amount, when the share carries none. */
  lead_expected_amount: string | null;
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
function scoreShare(
  share: ShareRow,
  payment: { amount: number; payer_phone: string | null; received_at: Date },
  context: { alone: boolean }
): number | null {
  const shared = new Date(share.created_at);
  const hours = (payment.received_at.getTime() - shared.getTime()) / 3_600_000;
  // Before the share, or more than a week after, is somebody else's payment.
  if (hours < -0.05 || hours > 168) return null;

  let score = 0;
  if (payment.payer_phone && payment.payer_phone === share.phone) score += 100;

  // NOTHING ELSE IT COULD BE
  //
  // This is the case the first version of the scoring got wrong, and it is the
  // ordinary one. A UPI payment carries no phone number, and a caller mid-call
  // rarely stops to type an amount - so a QR shared four minutes ago scored 25
  // against a bar of 60 and sat waiting for a human to attribute the obvious.
  //
  // What the score was failing to represent is that this QR belongs to one
  // caller, they shared it with exactly one person in the window, and money
  // then arrived through it. There is no other candidate; there is no rival
  // explanation. That is stronger evidence than a matching round-number
  // amount, and it is now weighted like it.
  //
  // It is not conclusive - a donor could forward the picture to somebody else
  // - which is why it does not simply assert the match, and why a second share
  //   on the same QR removes it entirely and sends both to a human.
  if (context.alone) score += 40;

  // They said on the call that they would pay by this QR. A person who said so
  // twenty minutes ago is a likelier source of this money than one who was
  // sent a QR and said nothing.
  if (share.awaiting_payment_at) score += 20;

  // The amount. The share's own figure first - what the caller heard them say
  // - and failing that the lead's standing expectation, which is often the
  // ask the list was built around.
  const expected =
    (share.expected_amount ? Number(share.expected_amount) : null) ??
    (share.lead_expected_amount ? Number(share.lead_expected_amount) : null);
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

/** What tied the payment to the share - or would have, had it worked. */
type MatchBasis = 'qr' | 'phone';

interface MatchResult {
  matched: boolean;
  shareId?: string;
  score?: number;
  basis?: MatchBasis;
  /** Why not, in words a person can act on. Only set when matched is false. */
  reason?: string;
}

/**
 * Record why a payment stayed unattached, and hand the reason back.
 *
 * WHY THIS IS WRITTEN DOWN
 * An unmatched payment used to be a row on a screen with no explanation, and
 * "why is this one sitting here" was answerable only by reading the code. The
 * three reasons are very different jobs: a QR nobody shared from DRM is an
 * office process to fix, a missing QR id is a webhook subscription to add, and
 * a near-miss score is one click of human judgement. The screen can only say
 * which if the matcher says which.
 */
/**
 * Everything that must happen to a lead when their money arrives.
 *
 * WHY THIS IS ONE FUNCTION
 * There were two copies of this - the automatic match and the one a human
 * links by hand - and they had already drifted: both wrote a stage that does
 * not exist, neither cleared the callback, and neither closed the promise the
 * donor had made. So a donor who paid was still in the queue to be rung, still
 * on the follow-ups board as owed a call, and still had a reminder that would
 * alert somebody to chase a donation that had already arrived. Three different
 * people would have contacted them about it.
 *
 * Paying is the end of the chase. Everything that exists to make somebody ring
 * this person has to stop at the same moment, and doing that in one place is
 * the only way it stays true of both paths.
 *
 * Takes an optional client so the manual path can do it inside its own
 * transaction; the webhook path has no transaction to join and uses the pool.
 */
async function markLeadDonated(
  leadId: string,
  amount: number,
  note: string,
  client?: { query: typeof pool.query },
  creditTo?: string | null
): Promise<void> {
  const db = client ?? pool;

  // Credit the caller who actually did it.
  //
  // Every per-caller figure in DRM is keyed on who the lead is assigned to.
  // A QR shared with somebody nobody owns - a walk-in, a number off a slip,
  // an unassigned row in a sheet - converted into money that then belonged to
  // no caller at all: it counted towards the temple's total and towards
  // nobody's work. Only when the lead is going spare, so this can never take
  // a colleague's lead away from them.
  if (creditTo) {
    await db.query(
      `UPDATE leads SET assigned_to = $2::uuid, assigned_at = NOW()
        WHERE id = $1 AND assigned_to IS NULL`,
      [leadId, creditTo]
    );
  }

  await db.query(
    `UPDATE leads SET
       status             = 'converted',
       converted_amount   = COALESCE(converted_amount, 0) + $2::numeric,
       converted_at       = COALESCE(converted_at, NOW()),
       converted_via      = 'manual',
       converted_note     = COALESCE(converted_note, $3),
       -- The chase stops here. A callback still booked would put them back on
       -- the follow-ups board tomorrow morning as somebody the temple owes a
       -- call, which is no longer true.
       next_follow_up_at  = NULL,
       follow_up_note     = NULL,
       -- Cleared so they leave the "awaiting a QR payment" list; the payment
       -- they were awaiting is this one.
       awaiting_qr_at     = NULL,
       conversion_seen_at = NOW(),
       updated_at         = NOW()
     WHERE id = $1`,
    [leadId, amount, note]
  );

  // The promise they made is kept. Marked done rather than deleted, so the
  // record of what was promised and what came of it survives.
  await db.query(
    `UPDATE lead_reminders
        SET status = 'done', completed_at = NOW(), updated_at = NOW()
      WHERE lead_id = $1 AND status = 'open'`,
    [leadId]
  );

  await db.query(
    `INSERT INTO lead_activities (lead_id, kind, to_value, note)
     VALUES ($1::uuid, 'status_change', 'converted', $2)`,
    [leadId, note]
  );
}

/** A lead's name for a note, or their number when they have no name yet. */
async function leadLabel(leadId: string): Promise<string | null> {
  const r = await pool.query(`SELECT name, phone FROM leads WHERE id = $1`, [leadId]);
  if (!r.rows.length) return null;
  return r.rows[0].name || r.rows[0].phone || null;
}

async function note(rowId: string, result: MatchResult): Promise<MatchResult> {
  await pool
    .query(
      `UPDATE qr_payments SET match_basis = $2, match_score = $3::int, match_note = $4 WHERE id = $1`,
      [rowId, result.basis ?? null, result.score == null ? null : Math.round(result.score), result.reason ?? null]
    )
    .catch((e) => console.error('crm.matchNote error:', (e as Error).message));
  return result;
}

/**
 * Take a payment Razorpay has reported and try to attach it to a share.
 *
 * Exported so the webhook and the reconcile sweep use one implementation -
 * two copies of a matching rule is how a payment ends up credited twice.
 */
export async function matchPayment(paymentId: string): Promise<MatchResult> {
  const p = await pool.query(`SELECT * FROM qr_payments WHERE payment_id = $1`, [paymentId]);
  if (!p.rows.length) return { matched: false, reason: 'No such payment' };
  if (p.rows[0].share_id) return { matched: false, reason: 'Already attached' };
  const pay = p.rows[0];

  // Money that did not arrive must not move a lead to Donated. A failed
  // payment is still stored - the caller may want to ring back - but it is
  // never attributed to anybody.
  const status = String(pay.status ?? '');
  if (status && status !== 'captured' && status !== 'authorized') {
    return await note(pay.id, { matched: false, reason: `The payment is ${status}, not captured` });
  }

  // HOW A PAYMENT IS TIED BACK TO A SHARE
  // By the QR it was paid into, when Razorpay tells us which one that was; and
  // failing that, by the payer's own phone number, when Razorpay has one. If
  // it has neither there is nothing here to reason from, and guessing on
  // amount and timing alone would credit the wrong caller sooner or later.
  const basis: MatchBasis | null = pay.qr_id ? 'qr' : pay.payer_phone ? 'phone' : null;
  if (!basis) {
    return await note(pay.id, {
      matched: false,
      reason:
        'Razorpay did not say which QR this was paid into, and the payment carries no phone number. ' +
        'Subscribe to the qr_code.credited event if this keeps happening.',
    });
  }

  const candidates = await pool.query(
    `SELECT s.*, l.expected_amount AS lead_expected_amount
       FROM qr_shares s
       JOIN razorpay_qrs q ON s.qr_id = q.id
       LEFT JOIN leads l ON s.lead_id = l.id
      WHERE CASE WHEN $1::text IS NOT NULL THEN q.qr_id = $1 ELSE s.phone = $3::text END
        AND s.matched_at IS NULL
        AND s.created_at > $2::timestamptz - INTERVAL '7 days'
        AND s.created_at <= $2::timestamptz + INTERVAL '5 minutes'
      ORDER BY s.created_at DESC
      LIMIT 50`,
    [pay.qr_id, pay.received_at, pay.payer_phone]
  );
  if (!candidates.rows.length) {
    return await note(pay.id, {
      matched: false,
      basis,
      reason:
        basis === 'qr'
          ? 'That QR was not shared from DRM in the week before this payment'
          : 'Nothing was shared to that number in the week before this payment',
    });
  }

  // Counted before scoring, and over the shares that are actually in the
  // window rather than every row the query returned - a share made eight days
  // ago is not a rival explanation for this payment, so its presence must not
  // take the "nothing else it could be" weight away from the one that is.
  const payment = {
    amount: Number(pay.amount),
    payer_phone: pay.payer_phone as string | null,
    received_at: new Date(pay.received_at),
  };
  const plausible = (candidates.rows as ShareRow[]).filter(
    (s) => scoreShare(s, payment, { alone: false }) !== null
  );

  let best: { share: ShareRow; score: number } | null = null;
  for (const s of plausible) {
    const score = scoreShare(s, payment, { alone: plausible.length === 1 });
    if (score !== null && (!best || score > best.score)) best = { share: s, score };
  }

  if (!best || best.score < CONFIDENT) {
    // Naming the likeliest one is the whole value of this state. "Not certain
    // enough" tells somebody nothing they can act on; "looks like Ramesh, who
    // said he would pay" is a decision they can make in one click.
    //
    // A donor who promised on the call is deliberately NOT auto-matched when
    // somebody else was sent the same QR in the same window. They are the
    // likelier source of the money, not the certain one - the other person can
    // pay without ever having said they would, and crediting the wrong caller
    // is worse than asking.
    const who = best?.share.lead_id ? await leadLabel(best.share.lead_id) : null;
    return await note(pay.id, {
      matched: false,
      basis,
      score: best?.score,
      reason: !best
        ? 'Every candidate was outside the window for this payment'
        : best.share.awaiting_payment_at
        ? `Looks like ${who ?? best.share.phone}, who said on the call they would pay by QR — but the same QR went to somebody else too, so confirm it.`
        : `Could be ${who ?? best?.share.phone}, but the same QR went to more than one person around then. Confirm it.`,
    });
  }

  // A phone match is a suggestion, never a decision - and this is the reason.
  //
  // The temple's websites take their donations through the same Razorpay
  // account, so with payment.captured subscribed, a donation made on
  // harekrishnavizag.org arrives here too, carrying no QR id and the donor's
  // own number. If that donor had been rung last week and sent a QR, the phone
  // would match, DRM would credit the caller, and - far worse - it would raise
  // a SECOND 80G receipt for money the site has already receipted.
  //
  // Razorpay cannot tell DRM which of the two it was. A person can, in one
  // click, so the payment waits for them with the likely answer written on it.
  if (basis === 'phone') {
    const who = best.share.lead_id ? await leadLabel(best.share.lead_id) : null;
    return await note(pay.id, {
      matched: false,
      basis,
      score: best.score,
      reason:
        `Looks like ${who ?? `the share to ${best.share.phone}`}, but Razorpay did not say this came ` +
        'through a QR - it may be a website donation that is already receipted. Confirm it here.',
    });
  }

  await pool.query(
    `UPDATE qr_shares SET
       matched_payment_id = $2, matched_amount = $3::numeric,
       matched_at = NOW(), matched_via = 'auto'
     WHERE id = $1`,
    [best.share.id, pay.payment_id, pay.amount]
  );
  await pool.query(
    `UPDATE qr_payments SET share_id = $2, person_id = $3,
       match_basis = $4, match_score = $5::int, match_note = NULL
     WHERE id = $1`,
    [pay.id, best.share.id, best.share.person_id, basis, Math.round(best.score)]
  );

  // Move the lead.
  //
  // THE STATUS SLUG MATTERS MORE THAN IT LOOKS
  // This used to write 'donated', which is not a stage that exists. Every
  // consequence followed from that one word: crm_statuses had no row for it,
  // so is_open fell back to TRUE and the donor who had just paid stayed in the
  // calling queue to be rung again; is_won was unknown, so no conversion
  // report counted them; and the stage badge showed a raw slug. The real slug
  // is 'converted', whose label is "Donated".
  //
  // 'manual' rather than 'auto' is deliberate and unchanged: 'auto' in DRM
  // means a donation that arrived through a site and was matched on the
  // donor's own number. A QR payment matched on timing is a strong inference,
  // not an observation, and the reports must not present the two as equal.
  if (best.share.lead_id) {
    await markLeadDonated(
      best.share.lead_id,
      Number(pay.amount),
      'Paid by QR, matched automatically',
      undefined,
      (best.share as ShareRow & { shared_by?: string | null }).shared_by ?? null
    );
  }

  // The donor has paid and is owed a receipt. Not awaited: the webhook must
  // answer Razorpay promptly or it retries, and issuing a receipt means calling
  // another system that may be slow. What happened is recorded on the payment
  // and shown on the unmatched-and-unreceipted screen.
  void issueReceiptForPayment(pay.id).catch((e) =>
    console.error('crm.issueReceipt error:', (e as Error).message)
  );

  return { matched: true, shareId: best.share.id, score: best.score, basis };
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
            -- The preacher who brought this donor in, from the lead or from
            -- the donor record, so DCC records the receipt as enrolled by
            -- them rather than under the site's generic default.
            COALESCE(pr_lead.id_number, pr_person.id_number) AS preacher_dcc_id,
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
       LEFT JOIN preachers pr_lead ON l.preacher_id = pr_lead.id
       LEFT JOIN preachers pr_person ON pe.preacher_id = pr_person.id
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
      dccEnrolledById: p.preacher_dcc_id ? Number(p.preacher_dcc_id) : null,
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
 * The events this endpoint acts on, and why exactly these.
 *
 * WHICH EVENT CARRIES THE QR ID - THE WHOLE POINT OF THIS LIST
 * A Razorpay payment object does NOT say which QR it was paid into. There is
 * no qr_id on it, and there is no field to look one up from. The only delivery
 * that names the QR is `qr_code.credited`, whose payload carries both the
 * qr_code entity AND the payment entity:
 *
 *   qr_code.credited  -> payload.qr_code.entity.id  +  payload.payment.entity
 *   payment.captured  -> payload.payment.entity                (no QR anywhere)
 *
 * So `qr_code.credited` is the one subscription DRM genuinely needs. An
 * earlier version of this handler ignored every event that did not begin with
 * "payment" and then read the QR id out of payload.qr_code - a field that
 * filter had already thrown away. On a `payment.captured` subscription alone
 * it stored every QR donation with a null QR id and matched precisely none of
 * them, forever.
 *
 * `payment.captured` and `payment.authorized` are kept as a second path
 * because they arrive for every payment including ones taken outside a QR, and
 * because the two events can arrive in either order: whichever comes first
 * creates the row, and the other fills in what it knows. `payment.failed` is
 * stored too, so a caller ringing back can see the donor tried.
 */
const HANDLED_EVENTS = new Set([
  'qr_code.credited',
  'payment.captured',
  'payment.authorized',
  'payment.failed',
]);

/**
 * Find the QR id anywhere in a webhook body.
 *
 * WHY THIS IS A SEARCH AND NOT A PATH
 * The documented place is payload.qr_code.entity.id, and that is tried first.
 * But the whole of this feature rests on getting that one string out of one
 * delivery, and a provider that moves or nests a field differently than the
 * docs show would break it silently - a null column, no error, every donation
 * unattributed until somebody noticed weeks later. A Razorpay QR id has a
 * shape nothing else in the payload shares (qr_ followed by an id), so after
 * the known paths this walks the body and takes the first one it finds.
 *
 * Bounded depth, and it never looks inside `notes`, which is free text the
 * temple controls and could contain anything.
 */
function findQrId(body: unknown, depth = 0): string | null {
  if (depth > 6 || body === null || typeof body !== 'object') return null;
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (key === 'notes') continue;
    if (typeof value === 'string') {
      // `id` on a qr_code entity, or any field carrying the same shape.
      if (/^qr_[A-Za-z0-9]{6,}$/.test(value)) return value.slice(0, 60);
    } else {
      const found = findQrId(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
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
    const event = String(req.body?.event ?? '');
    const payload = (req.body?.payload ?? {}) as {
      payment?: { entity?: Record<string, unknown> };
      qr_code?: { entity?: Record<string, unknown> };
    };
    const entity = payload.payment?.entity;

    if (!HANDLED_EVENTS.has(event) || !entity?.id) {
      // Answered 200 on purpose. Razorpay lets you subscribe to events DRM has
      // no use for, and retrying those for hours helps nobody.
      return res.json({ ignored: true, event: event || null });
    }

    const notes = (entity.notes ?? {}) as Record<string, unknown>;
    const contact = String(entity.contact ?? '').replace(/\D/g, '').slice(-10);

    // The QR id, in order of how much it is worth trusting: what Razorpay
    // itself says on a qr_code.credited, then a qr_id somebody put in the QR's
    // notes by hand. The notes fallback exists because notes ride along onto
    // every payment taken through that QR, so a temple that fills them in gets
    // matching even on a payment.captured-only subscription.
    const qrId =
      str(payload.qr_code?.entity?.id, 60) ??
      str((payload.qr_code as { id?: unknown } | undefined)?.id, 60) ??
      findQrId(payload) ??
      str(notes.qr_id ?? notes.qrId ?? notes.qr_code, 60);

    // WHY NOT EVERY PAYMENT IS STORED
    // The temple's websites take their donations through this same Razorpay
    // account. With payment.captured subscribed, every website donation is
    // delivered here as well - and those are already recorded, already
    // receipted, and already synced into DRM from the site itself. Keeping
    // them would turn this table into a second, worse copy of the donations
    // table and bury the handful of QR payments a caller actually needs to
    // see.
    //
    // So a payment is kept when there is a reason to think it is one of ours:
    // Razorpay named the QR, or it came from a number a caller sent a QR to in
    // the last week. Anything else is somebody else's business, answered 200
    // and forgotten. The payment.captured for a real QR donation that arrives
    // before its qr_code.credited is not lost by this - the credited event
    // that follows carries the QR id and stores it.
    const keep =
      !!qrId ||
      (!!contact &&
        (
          await pool.query(
            `SELECT 1 FROM qr_shares
              WHERE phone = $1 AND matched_at IS NULL
                AND created_at > NOW() - INTERVAL '7 days'
              LIMIT 1`,
            [contact]
          )
        ).rows.length > 0);

    if (!keep) {
      return res.json({ ignored: true, event, reason: 'not a payment DRM shared a QR for' });
    }

    const stored = await pool.query(
      `INSERT INTO qr_payments
         (payment_id, qr_id, amount, payer_phone, payer_vpa, payer_name, status, raw, received_at, last_event)
       VALUES ($1,$2,$3::numeric,$4,$5,$6,$7,$8::jsonb, to_timestamp($9), $10)
       ON CONFLICT (payment_id) DO UPDATE SET
         -- Whichever delivery knows the QR wins, and neither can erase it:
         -- the two events arrive in either order, and a payment.captured that
         -- knows nothing must not blank out what qr_code.credited established.
         qr_id      = COALESCE(EXCLUDED.qr_id, qr_payments.qr_id),
         payer_phone = COALESCE(EXCLUDED.payer_phone, qr_payments.payer_phone),
         payer_vpa  = COALESCE(EXCLUDED.payer_vpa, qr_payments.payer_vpa),
         payer_name = COALESCE(EXCLUDED.payer_name, qr_payments.payer_name),
         status     = COALESCE(EXCLUDED.status, qr_payments.status),
         raw        = EXCLUDED.raw,
         last_event = EXCLUDED.last_event
       RETURNING id, payment_id, share_id`,
      [
        String(entity.id),
        qrId,
        Number(entity.amount ?? 0) / 100,
        contact || null,
        str(entity.vpa, 120),
        str(notes.name ?? entity.email, 160),
        str(entity.status, 20),
        // The WHOLE event, not just the payment entity. When a QR id fails to
        // turn up, the only way to find out what Razorpay actually sent is to
        // look at what it sent - and by then the delivery is long gone.
        JSON.stringify(req.body),
        Number(entity.created_at ?? Math.floor(Date.now() / 1000)),
        event.slice(0, 40),
      ]
    );

    // Run on every delivery, not only the first. A payment stored unmatched by
    // payment.captured is matched by the qr_code.credited that follows it,
    // which is the whole reason the two paths exist. matchPayment returns
    // early once a payment already has a share, so a third redelivery is free.
    const result = await matchPayment(stored.rows[0].payment_id);
    res.json({ stored: true, event, ...result });
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
  // A caller may raise or re-raise the receipt for money that came through
  // their own QR, or a share they made. That is the point of the button: the
  // donor is often still on the phone saying it has not arrived. Anyone else's
  // payment is refused, and an admin or accountant may do any of them.
  if (req.user?.role === 'caller') {
    const ok = await pool.query(
      `SELECT 1 FROM qr_payments p
         LEFT JOIN qr_shares s ON p.share_id = s.id
         LEFT JOIN razorpay_qrs q ON q.qr_id = p.qr_id
        WHERE p.id = $1 AND (s.shared_by = $2::uuid OR q.owner_id = $2::uuid)`,
      [req.params.id, req.user?.userId ?? null]
    );
    if (!ok.rows.length) return res.status(404).json({ error: 'No such payment' });
  }

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
/**
 * Which payments this request may see, built once for the screen and the file.
 *
 * `me` is the caller scope, and it is wider than "mine" on purpose.
 *
 * Scoped to their own QR or their own share, a caller could not see the
 * payment they were waiting for: most temples hand out one shared QR, which
 * has no owner, and an unmatched payment has no share yet either. So the one
 * screen built for attributing a payment showed the caller nothing, and they
 * could not attribute the money they had just raised.
 *
 * So: payments through a QR assigned to them, payments against a share they
 * made, and unmatched payments on the temple's shared QRs - which is exactly
 * the set that could plausibly be theirs. Somebody else's matched payment
 * stays hidden, and so does the raw Razorpay event on every row.
 */
function qrPaymentScope(
  q: Record<string, unknown>,
  user?: { role?: string; userId?: string }
): { where: string; me: string | null } {
  const scope = String(q.scope ?? 'attention');
  return {
    where:
      scope === 'all'
        ? 'TRUE'
        : scope === 'unmatched'
        ? 'p.share_id IS NULL'
        : "p.share_id IS NULL OR p.receipt_status IS NULL OR p.receipt_status IN ('failed','skipped','pending')",
    me: user?.role === 'caller' ? user?.userId ?? null : null,
  };
}

const QR_PAYMENT_FROM = `FROM qr_payments p
         LEFT JOIN razorpay_qrs q ON q.qr_id = p.qr_id
         LEFT JOIN users u ON q.owner_id = u.id
         LEFT JOIN qr_shares s ON p.share_id = s.id
         LEFT JOIN leads l ON s.lead_id = l.id`;

/** Spelled out once so the screen and the file cannot disagree about who is in. */
const QR_PAYMENT_VISIBLE = `($1::uuid IS NULL
               OR q.owner_id = $1::uuid
               OR s.shared_by = $1::uuid
               -- Unclaimed money on a QR anybody may use. Theirs to recognise.
               OR (p.share_id IS NULL AND q.owner_id IS NULL))`;

router.get('/qr/payments', authenticate, async (req, res) => {
  const { where, me } = qrPaymentScope(req.query as Record<string, unknown>, req.user);

  try {
    const rows = await pool.query(
      `SELECT p.id, p.payment_id, p.qr_id, p.amount, p.payer_phone, p.payer_vpa,
              p.payer_name, p.status, p.received_at, p.share_id, p.person_id,
              p.receipt_status, p.receipt_error, p.receipt_number, p.receipt_site,
              p.match_basis, p.match_score, p.match_note, p.last_event,
              q.label AS qr_label, q.receipt_site AS qr_receipt_site,
              u.name AS qr_owner, l.name AS lead_name, l.id AS lead_id
         ${QR_PAYMENT_FROM}
        WHERE (${where})
          AND ${QR_PAYMENT_VISIBLE}
        ORDER BY p.received_at DESC LIMIT 200`,
      [me]
    );
    res.json({ payments: rows.rows, scope: me ? 'mine' : 'all' });
  } catch (err) {
    console.error('crm.qrPayments error:', err);
    res.status(500).json({ error: 'Could not load the QR payments' });
  }
});

/**
 * The QR payments on screen, as a file.
 *
 * Caller-reachable, like the screen, and scoped by the same qrPaymentScope -
 * a caller downloads the payments they can see and nobody else's.
 *
 * The screen stops at 200 rows because that is a list somebody reads top-down;
 * a file is read by sorting and totalling, so it runs to the shared row cap
 * instead. A download silently cut off at 200 would be a reconciliation that
 * comes up short with nothing on the file to say why.
 */
async function exportQrPaymentsFile(
  req: import('express').Request,
  res: import('express').Response,
  format: ExportFormat
) {
  try {
    const { where, me } = qrPaymentScope(req.query as Record<string, unknown>, req.user);
    const rows = await pool.query(
      `SELECT p.payment_id, p.amount, p.payer_name, p.payer_phone, p.status,
              p.received_at, p.receipt_number, p.match_basis, p.match_score,
              q.label AS qr_label, l.name AS lead_name,
              -- The caller who shared the QR this money came back through, which
              -- is who the conversion was credited to.
              su.name AS shared_by_name
         ${QR_PAYMENT_FROM}
         LEFT JOIN users su ON s.shared_by = su.id
        WHERE (${where})
          AND ${QR_PAYMENT_VISIBLE}
        ORDER BY p.received_at DESC LIMIT ${EXPORT_ROW_CAP + 1}`,
      [me]
    );
    const truncated = rows.rows.length > EXPORT_ROW_CAP;

    await sendExport(res, format, {
      name: 'qr-payments',
      truncated,
      rows: truncated ? rows.rows.slice(0, EXPORT_ROW_CAP) : rows.rows,
      filterSummary: describeFilters(req.query as Record<string, unknown>, { scope: 'Showing' }),
      columns: [
        { header: 'Received at', value: (r) => r.received_at, kind: 'datetime' },
        { header: 'Amount', value: (r) => r.amount, kind: 'money' },
        { header: 'Payer name', value: (r) => r.payer_name },
        { header: 'Payer phone', value: (r) => r.payer_phone, kind: 'phone' },
        { header: 'QR', value: (r) => r.qr_label },
        { header: 'Matched lead', value: (r) => r.lead_name },
        { header: 'Matched to caller', value: (r) => r.shared_by_name },
        { header: 'Match basis', value: (r) => r.match_basis },
        { header: 'Match score', value: (r) => r.match_score, kind: 'number' },
        { header: 'Status', value: (r) => r.status },
        { header: 'Receipt no', value: (r) => r.receipt_number },
        { header: 'Razorpay payment id', value: (r) => r.payment_id },
      ],
    });
  } catch (err) {
    console.error('crm.exportQrPayments error:', err);
    res.status(500).json({ error: 'Could not build that export' });
  }
}

// Nothing in this router answers GET /qr/payments/:id, which is the only thing
// that could swallow these - Express matches in order and "export.csv" is a
// perfectly good :id as far as a route pattern is concerned. That is the trap
// that once made /leads/sample.csv answer "Lead not found". Anyone adding a
// GET /qr/payments/:id later must put it BELOW these two.
router.get('/qr/payments/export.csv', authenticate, (req, res) =>
  exportQrPaymentsFile(req, res, 'csv')
);
router.get('/qr/payments/export.xlsx', authenticate, (req, res) =>
  exportQrPaymentsFile(req, res, 'xlsx')
);

/** GET /qr/unmatched - payments nobody has claimed. A screen, not a dead letter box. */
router.get('/qr/unmatched', authenticate, async (req, res) => {
  const me = req.user?.role === 'caller' ? req.user?.userId ?? null : null;
  try {
    const rows = await pool.query(
      `SELECT p.id, p.payment_id, p.qr_id, p.amount, p.payer_phone, p.payer_vpa,
              p.payer_name, p.status, p.received_at, p.match_note, p.match_score,
              q.label AS qr_label, u.name AS qr_owner
         FROM qr_payments p
         LEFT JOIN razorpay_qrs q ON q.qr_id = p.qr_id
         LEFT JOIN users u ON q.owner_id = u.id
        WHERE p.share_id IS NULL
          AND ($1::uuid IS NULL OR q.owner_id = $1::uuid OR q.owner_id IS NULL)
        ORDER BY p.received_at DESC LIMIT 200`,
      [me]
    );
    res.json({ payments: rows.rows });
  } catch (err) {
    console.error('crm.qrUnmatched error:', err);
    res.status(500).json({ error: 'Could not load the unmatched payments' });
  }
});

/**
 * GET /qr/shares - what has been sent and what came of it.
 *
 * `awaiting=true` narrows to the people who actually said on the call that
 * they would pay by QR. That is the list somebody attributing a payment wants
 * to see first: most shares were sent to people who said nothing, and one of
 * the few who promised is almost certainly who this money is from. The screen
 * can widen to everything in one click, because "almost certainly" is not
 * always.
 */
router.get('/qr/shares', authenticate, async (req, res) => {
  const mine = req.query.mine !== 'false';
  const awaitingOnly = req.query.awaiting === 'true';
  const unmatchedOnly = req.query.unmatched === 'true';
  try {
    const rows = await pool.query(
      `SELECT s.*, q.label AS qr_label, l.name AS lead_name, l.awaiting_qr_at,
              u.name AS shared_by_name
         FROM qr_shares s
         JOIN razorpay_qrs q ON s.qr_id = q.id
         LEFT JOIN leads l ON s.lead_id = l.id
         LEFT JOIN users u ON s.shared_by = u.id
        WHERE ($1::uuid IS NULL OR s.shared_by = $1::uuid)
          AND ($2::boolean = FALSE OR s.awaiting_payment_at IS NOT NULL OR l.awaiting_qr_at IS NOT NULL)
          AND ($3::boolean = FALSE OR s.matched_at IS NULL)
        -- Promised first, then most recent. Whoever is attributing a payment
        -- reads top-down and stops at the first plausible row.
        ORDER BY (s.awaiting_payment_at IS NOT NULL OR l.awaiting_qr_at IS NOT NULL) DESC,
                 s.created_at DESC
        LIMIT 200`,
      [mine ? req.user?.userId ?? null : null, awaitingOnly, unmatchedOnly]
    );
    res.json({ shares: rows.rows });
  } catch (err) {
    console.error('crm.qrShares error:', err);
    res.status(500).json({ error: 'Could not load the QR history' });
  }
});

/**
 * POST /qr/payments/:id/attach - a human links a payment to a share.
 *
 * Attributing a payment credits a conversion to a caller and fires a real 80G
 * receipt to a named donor, so who may do it matters. A caller may attribute
 * to their own shares and no one else's; an admin or accountant may attribute
 * to anybody's, because untangling a mis-sent QR is their job.
 */
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
    // A caller may only attribute a payment to a QR they themselves shared.
    // Without this, attributing was a one-click way to move a colleague's
    // donation onto your own conversion figures - and to raise a real 80G
    // receipt in the wrong donor's name while doing it.
    const share = await client.query(
      `SELECT * FROM qr_shares
        WHERE id = $1 AND ($2::uuid IS NULL OR shared_by = $2::uuid)`,
      [shareId, req.user?.role === 'caller' ? req.user?.userId ?? null : null]
    );
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
      await markLeadDonated(
        share.rows[0].lead_id,
        Number(pay.rows[0].amount),
        'Paid by QR, linked by hand',
        client,
        share.rows[0].shared_by ?? null
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
