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
import { recordCredit, reverseCreditFor } from '../services/credits';
import type { PoolClient } from 'pg';

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
 * Linked to somebody, by any route: a QR share, a lead or a person.
 *
 * A share used to be the only way, so "not linked" was written share_id IS
 * NULL everywhere. Money from a regular donor scanning the temple QR, or a
 * walk-in, had no share and could never be linked to anyone.
 */
const LINKED = (a = 'p') => `(${a}.share_id IS NOT NULL OR ${a}.lead_id IS NOT NULL OR ${a}.person_id IS NOT NULL)`;

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
    res.status(500).json({ error: 'Could not load storage status.' });
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
                  COALESCE(SUM(pm.amount) FILTER (WHERE ${LINKED('pm')}), 0)::numeric AS attributed,
                  COUNT(*)::int AS payments,
                  COUNT(*) FILTER (WHERE NOT ${LINKED('pm')})::int AS unattributed,
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
  if (!qrId) return res.status(400).json({ error: 'Enter the Razorpay QR ID.' });
  if (!label) return res.status(400).json({ error: 'Enter a QR name.' });
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
    if (!r.rows.length) return res.status(404).json({ error: 'QR not found.' });
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
  if (phone.length !== 10) return res.status(400).json({ error: 'Enter a 10-digit mobile number.' });
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
    if (!qr.rows.length) return res.status(404).json({ error: 'QR not found.' });
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
    return res.status(503).json({ error: 'Image upload is not set up yet.' });
  }
  if (!storage.hasPublicUrls()) {
    return res.status(503).json({
      error:
        'Image upload is not set up. Paste the Razorpay image link.',
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
    return res.status(400).json({ error: 'Image is over 2 MB. Use a smaller one.' });
  }

  try {
    const key = storage.keys.qrImage(String(req.params.id), ext);
    const put = await storage.putObject(key, buf, types[ext]);
    if (!put.ok) return res.status(502).json({ error: 'Could not store that image' });

    const r = await pool.query(
      `UPDATE razorpay_qrs SET image_key = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id, key]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'QR not found.' });
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
    if (!r.rows.length) return res.status(404).json({ error: 'QR not found.' });
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
        error: 'No image yet. Upload one or paste the Razorpay link.',
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
    if (!r.rows.length) return res.status(404).json({ error: 'QR not found.' });
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
export async function markLeadDonated(
  leadId: string,
  amount: number,
  note: string,
  client?: { query: typeof pool.query },
  creditTo?: string | null,
  /**
   * What this money was, for the ledger. Passed in rather than inferred,
   * because the caller of this function is the only thing that knows whether
   * it watched a QR get paid or is taking somebody's word for it.
   */
  evidence?: { qrPaymentId?: string; shareId?: string; personId?: string; occurredAt?: string | Date }
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

  /* AND THE CREDIT, which is the part that survives a reassignment.
   *
   * The UPDATE above still writes leads.converted_amount, because the lead's
   * own record should say what it was worth. But no report reads that column
   * for money any more - they read caller_credits. The difference matters the
   * day somebody bulk-reassigns two thousand leads: the leads move, and last
   * quarter's figures for both callers stay exactly as they were.
   *
   * recordCredit returns null when this evidence has already been credited,
   * which is the ordinary outcome of a re-delivered webhook, not a problem.
   *
   * NOTE THE CHANGE IN WHO GETS IT. The assigned_to update above still only
   * claims a lead nobody owns, because taking a colleague's lead off them
   * would be wrong. But the CREDIT goes to whoever actually shared the QR,
   * every time - including on a colleague's lead. Under the old model those
   * were the same decision, so a caller who rang somebody else's lead and got
   * them to pay credited the colleague and showed nothing for their own
   * shift. Separating the two is the point of having a ledger.
   */
  if (creditTo) {
    await recordCredit(
      {
        userId: creditTo,
        amount,
        kind: 'qr',
        occurredAt: evidence?.occurredAt ?? new Date(),
        leadId,
        qrPaymentId: evidence?.qrPaymentId ?? null,
        shareId: evidence?.shareId ?? null,
        personId: evidence?.personId ?? null,
        note,
      },
      client as never
    ).catch((e) => {
      // Never let bookkeeping take the money down with it. The conversion is
      // already written; a missing credit is a figure to repair, a failed
      // transaction here would be a donation DRM forgot.
      console.error('crmQr.markLeadDonated credit failed:', (e as Error).message);
      return null;
    });
  }
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
  if (!p.rows.length) return { matched: false, reason: 'Payment not found.' };
  if (p.rows[0].share_id) return { matched: false, reason: 'Already linked' };
  const pay = p.rows[0];

  // Money that did not arrive must not move a lead to Donated. A failed
  // payment is still stored - the caller may want to ring back - but it is
  // never attributed to anybody.
  const status = String(pay.status ?? '');
  if (status && status !== 'captured' && status !== 'authorized') {
    return await note(pay.id, { matched: false, reason: `Payment not complete (${status})` });
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
        'No QR or mobile number on this payment.',
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
          ? 'This QR was not sent in the last week'
          : 'No QR was sent to this number in the last week',
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
        ? 'No QR was sent near this time'
        : best.share.awaiting_payment_at
        ? `Looks like ${who ?? best.share.phone}, who promised. This QR went to others too. Please check.`
        : `Could be ${who ?? best?.share.phone}. This QR went to others too. Please check.`,
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
        `Looks like ${who ?? `the QR sent to ${best.share.phone}`}. It may be a website donation. Please check.`,
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
  const sharedBy = (best.share as ShareRow & { shared_by?: string | null }).shared_by ?? null;
  if (best.share.lead_id) {
    await markLeadDonated(
      best.share.lead_id,
      Number(pay.amount),
      'Paid by QR, linked automatically',
      undefined,
      sharedBy,
      { qrPaymentId: pay.id, shareId: best.share.id, occurredAt: pay.received_at }
    );
  } else if (sharedBy) {
    // A SHARE WITH NO LEAD STILL EARNED SOMEBODY THE MONEY.
    //
    // qr/share-to sends a QR straight to a number with no lead behind it - a
    // walk-in, a number read out on a call, somebody a preacher passed on.
    // Credit used to live entirely inside markLeadDonated, so every one of
    // those payments counted for the temple and for nobody, and a caller
    // working the phone that way showed a zero at the end of the day.
    await recordCredit({
      userId: sharedBy,
      amount: Number(pay.amount),
      kind: 'qr',
      occurredAt: pay.received_at,
      qrPaymentId: pay.id,
      shareId: best.share.id,
      note: 'Paid by QR, linked automatically',
    }).catch((e) => {
      console.error('crmQr.credit (no lead) failed:', (e as Error).message);
      return null;
    });
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
  /* EVERY JOIN HERE IS A LEFT JOIN, AND THAT IS THE FIX.
   *
   * This query used to begin `JOIN qr_shares s ON p.share_id = s.id`. A QR
   * payment that DRM could not match to a share therefore produced no row at
   * all, the function returned silently two lines later, and the donor got no
   * receipt - with nothing written down to say why. Those are precisely the
   * payments somebody is standing at a desk asking about: the money is in the
   * temple's account, Razorpay has it, DRM can see it on screen, and the one
   * thing nobody could do was give the donor their 80G certificate.
   *
   * The QR now comes from the payment's own qr_id as well as through a share,
   * so a payment into a known QR is receiptable whether or not DRM ever
   * worked out who sent it. What was missing instead is the donor's name and
   * address, and those are now typed in and stored on the payment - see the
   * donor_* columns and POST /qr/payments/:id/receipt.
   */
  const r = await pool.query(
    `SELECT p.*, COALESCE(s.lead_id, p.lead_id) AS lead_id, COALESCE(p.person_id, s.person_id) AS person_id,
            s.phone AS share_phone, pe.phone AS person_phone,
            -- Aliased away from "receipt_site" on purpose: qr_payments has a
            -- column of that name too (the site a receipt was actually raised
            -- against), and two output columns sharing a name means the later
            -- one silently wins and the stored choice is lost.
            COALESCE(q_share.receipt_site, q_direct.receipt_site) AS qr_receipt_site,
            COALESCE(q_share.purpose, q_direct.purpose)           AS qr_purpose,
            COALESCE(q_share.label, q_direct.label, 'no QR')      AS qr_label,
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
       LEFT JOIN qr_shares s ON p.share_id = s.id
       LEFT JOIN razorpay_qrs q_share ON s.qr_id = q_share.id
       -- The QR the money was actually paid into, which Razorpay tells us on
       -- qr_code.credited even when no share matches.
       LEFT JOIN razorpay_qrs q_direct ON q_direct.qr_id = p.qr_id
       LEFT JOIN leads l ON l.id = COALESCE(s.lead_id, p.lead_id)
       LEFT JOIN people pe ON COALESCE(p.person_id, s.person_id) = pe.id
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

  // Which 80G series the number comes out of. Falls back to whatever was
  // chosen when the receipt was raised by hand, for a payment with no QR at
  // all behind it.
  const site = (p.receipt_site || p.qr_receipt_site) as SiteKey | null;
  if (!site) {
    await pool.query(
      `UPDATE qr_payments SET receipt_status = 'skipped',
         receipt_error = 'No site is set on this QR, so DRM does not know which 80G series to use.'
       WHERE id = $1`,
      [paymentRowId]
    );
    return;
  }

  // A receipt needs somebody's name on it. For a matched payment that is the
  // donor DRM already knows; for an unmatched one it is whatever was typed in
  // when the receipt was raised. Razorpay's payer_name is a last resort - it
  // is often a VPA handle rather than a person.
  const donorName = p.donor_name || p.person_name || p.lead_name || p.payer_name || null;
  const donorPhone = p.donor_phone || p.share_phone || p.payer_phone || null;
  if (!donorName || !donorPhone) {
    await pool.query(
      `UPDATE qr_payments SET receipt_status = 'needs_donor',
         receipt_error = 'Add the donor''s name and number before raising this receipt.'
       WHERE id = $1`,
      [paymentRowId]
    );
    return;
  }

  await pool.query(`UPDATE qr_payments SET receipt_status = 'pending', receipt_error = NULL WHERE id = $1`, [
    paymentRowId,
  ]);

  try {
    const result = await createOfflineDonation(site, {
      donorName,
      donorMobile: donorPhone,
      donorEmail: p.donor_email || p.person_email || p.lead_email || null,
      amount: Number(p.amount),
      // It arrived by UPI through a Razorpay QR. Saying so keeps the site's own
      // books honest about how the money came in.
      paymentMode: 'upi',
      // The UTR when Razorpay sent one - it is what the donor sees on their
      // phone and what the bank statement shows - else the payment id. The
      // Razorpay id itself goes in its own field, so the site has both.
      referenceNo:
        p.raw?.payload?.payment?.entity?.acquirer_data?.rrn ||
        p.raw?.payload?.payment?.entity?.acquirer_data?.upi_transaction_id ||
        p.payment_id,
      gatewayPaymentId: p.payment_id,
      paymentDate: new Date(p.received_at).toISOString(),
      sevaName: p.purpose || p.qr_purpose || undefined,
      // 80G only when it was asked for (or, on rows from before the form
      // asked, when there is a PAN), and the PAN only with it. A certificate
      // without a PAN is no use to the donor.
      panNumber: (p.want_certificate ?? !!(p.donor_pan || p.pan)) ? p.donor_pan || p.pan || undefined : undefined,
      wantCertificate: (p.want_certificate ?? true) && !!(p.donor_pan || p.pan),
      wantPrasadam: !!p.want_prasadam,
      prasadamAddress: p.donor_address || p.address_text || undefined,
      // "On the name of" - who the donation is offered for. Rendered on both
      // sites' receipts and never once filled by DRM until now, so every
      // receipt DRM raised printed "---" where the donor expected a name.
      sevakName: p.sevak_name || undefined,
      sevakMobile: p.sevak_phone || undefined,
      billingParts: {
        door: p.address_door, house: p.address_house, street: p.address_street, area: p.address_area,
        city: p.address_city, state: p.address_state, pincode: p.address_pincode, country: p.address_country,
      },
      enteredByName: `DRM · QR ${p.qr_label}`,
      dccEnrolledById: p.preacher_dcc_id ? Number(p.preacher_dcc_id) : null,
      note: `Paid by QR during a call. Payment ID: ${p.payment_id}.`,
    });

    await pool.query(
      `UPDATE qr_payments SET
         receipt_status = 'issued',
         receipt_number = $2,
         external_donation_id = $3,
         receipt_site = $4,
         receipt_error = NULL
       WHERE id = $1`,
      [paymentRowId, result.receiptNumber, result.externalId, site]
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
         LEFT JOIN leads l ON l.id = COALESCE(s.lead_id, p.lead_id)
        WHERE p.id = $1 AND (s.shared_by = $2::uuid OR q.owner_id = $2::uuid
                             OR p.linked_by = $2::uuid OR l.assigned_to = $2::uuid
                             OR (NOT ${LINKED()} AND q.owner_id IS NULL))`,
      [req.params.id, req.user?.userId ?? null]
    );
    if (!ok.rows.length) return res.status(404).json({ error: 'Payment not found.' });
  }

  try {
    await pool.query(`UPDATE qr_payments SET receipt_status = NULL WHERE id = $1`, [req.params.id]);
    await issueReceiptForPayment(String(req.params.id));
    const r = await pool.query(
      `SELECT receipt_status, receipt_error, receipt_number FROM qr_payments WHERE id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Payment not found.' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('crm.retryReceipt error:', err);
    res.status(500).json({ error: 'Could not issue receipt. Try again.' });
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
        : // Money in, no receipt yet - what the "Raise a receipt" picker on
          // the donations screen lists. Refunded or failed payments are not
          // offered: a certificate for money the temple does not hold is the
          // one mistake a receipt can make that nobody can quietly fix.
          scope === 'needs_receipt'
        ? "p.receipt_number IS NULL AND COALESCE(p.status, 'captured') IN ('captured', 'authorized')"
        : scope === 'unmatched'
        ? `NOT ${LINKED()}`
        : // 'needs_donor' belongs here, and leaving it out hid the exact rows
          // this screen exists to surface: a payment that reached the receipt
          // step and stopped because nobody had typed the donor's name in.
          // Those sat under "Everything" only, which is the one view nobody
          // opens when they are working through what needs doing.
          "p.receipt_status IS NULL OR p.receipt_status IN ('failed','skipped','pending','needs_donor')",
    me: user?.role === 'caller' ? user?.userId ?? null : null,
  };
}

const QR_PAYMENT_FROM = `FROM qr_payments p
         LEFT JOIN razorpay_qrs q ON q.qr_id = p.qr_id
         LEFT JOIN users u ON q.owner_id = u.id
         LEFT JOIN qr_shares s ON p.share_id = s.id
         LEFT JOIN leads l ON l.id = COALESCE(s.lead_id, p.lead_id)
         LEFT JOIN people pe ON pe.id = COALESCE(p.person_id, s.person_id)
         LEFT JOIN users lu ON lu.id = p.linked_by
         -- Who the money is already counted for. On the list, not just the
         -- detail view: without it the screen cannot tell "nobody has this"
         -- from "nobody has looked", and the difference decides whether it is
         -- safe to press claim.
         LEFT JOIN caller_credits cc ON cc.qr_payment_id = p.id AND cc.status = 'active'
         LEFT JOIN users cu ON cc.user_id = cu.id`;

/** Spelled out once so the screen and the file cannot disagree about who is in. */
const QR_PAYMENT_VISIBLE = `($1::uuid IS NULL
               OR q.owner_id = $1::uuid
               OR s.shared_by = $1::uuid
               OR p.linked_by = $1::uuid
               OR l.assigned_to = $1::uuid
               -- Unclaimed money on a QR anybody may use. Theirs to recognise.
               OR (NOT ${LINKED()} AND q.owner_id IS NULL))`;

/**
 * The UTR - the 12-digit UPI transaction number the donor sees on their own
 * payment screen. Razorpay calls it the RRN and keeps it inside the event;
 * it is what a donor reads out when they ring to ask about their receipt.
 */
const QR_UTR = `COALESCE(p.raw #>> '{payload,payment,entity,acquirer_data,rrn}',
                         p.raw #>> '{payload,payment,entity,acquirer_data,upi_transaction_id}')`;

router.get('/qr/payments', authenticate, async (req, res) => {
  const { where, me } = qrPaymentScope(req.query as Record<string, unknown>, req.user);
  // Search by what somebody holding the payment screen can read off it: the
  // name, the UPI id, the phone, the amount, or the UTR.
  const term = String(req.query.q ?? '').trim().slice(0, 80);

  try {
    const rows = await pool.query(
      `SELECT p.id, p.payment_id, ${QR_UTR} AS utr, p.qr_id, p.amount, p.payer_phone, p.payer_vpa,
              p.payer_name, p.status, p.received_at, p.share_id, p.person_id,
              p.receipt_status, p.receipt_error, p.receipt_number, p.receipt_site,
              p.match_basis, p.match_score, p.match_note, p.last_event,
              q.label AS qr_label, q.receipt_site AS qr_receipt_site,
              u.name AS qr_owner, l.name AS lead_name, l.id AS lead_id,
              pe.name AS person_name, pe.phone AS person_phone,
              p.donor_name, p.donor_phone, p.link_kind, p.linked_by, lu.name AS linked_by_name,
              cc.user_id AS credit_user_id, cu.name AS credit_user_name
         ${QR_PAYMENT_FROM}
        WHERE (${where})
          AND ${QR_PAYMENT_VISIBLE}
          AND ($2::text = ''
               OR p.payer_name ILIKE '%' || $2 || '%'
               OR p.payer_vpa ILIKE '%' || $2 || '%'
               OR p.payer_phone LIKE '%' || $2 || '%'
               OR p.payment_id ILIKE '%' || $2 || '%'
               OR ${QR_UTR} LIKE '%' || $2 || '%'
               OR l.name ILIKE '%' || $2 || '%'
               OR pe.name ILIKE '%' || $2 || '%'
               OR pe.phone LIKE '%' || $2 || '%'
               OR p.donor_name ILIKE '%' || $2 || '%'
               OR p.donor_phone LIKE '%' || $2 || '%'
               OR p.amount::text = $2
               OR p.amount::text = $2 || '.00')
        ORDER BY p.received_at DESC LIMIT 200`,
      [me, term]
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
              -- The caller who shared the QR this money came back through, and
              -- separately who the money is actually counted for - those are
              -- usually the same person and the cases where they are not are
              -- exactly the ones somebody is trying to find in the file.
              su.name AS shared_by_name,
              cu.name AS credit_user_name
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
        { header: 'Counted for', value: (r) => r.credit_user_name },
        { header: 'Match basis', value: (r) => r.match_basis },
        { header: 'Match score', value: (r) => r.match_score, kind: 'number' },
        { header: 'Status', value: (r) => r.status },
        { header: 'Receipt no', value: (r) => r.receipt_number },
        { header: 'Razorpay payment id', value: (r) => r.payment_id },
      ],
    });
  } catch (err) {
    console.error('crm.exportQrPayments error:', err);
    res.status(500).json({ error: 'Could not download. Try again.' });
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
        WHERE NOT ${LINKED()}
          AND ($1::uuid IS NULL OR q.owner_id = $1::uuid OR q.owner_id IS NULL)
        ORDER BY p.received_at DESC LIMIT 200`,
      [me]
    );
    res.json({ payments: rows.rows });
  } catch (err) {
    console.error('crm.qrUnmatched error:', err);
    res.status(500).json({ error: 'Could not load payments.' });
  }
});

/* =========================================================================
   RAISING A RECEIPT FOR A QR PAYMENT, AND SAYING WHO RAISED IT
   ========================================================================= */

/**
 * GET /qr/payments/:id - everything about one payment.
 *
 * REGISTERED AFTER THE LITERAL /qr/payments/... ROUTES ABOVE, and it has to
 * stay there. Express matches in registration order, so a ":id" route placed
 * above /qr/payments/export.csv swallows "export.csv" as an id - which 404s
 * with "No such payment" and reads as a broken download button rather than a
 * routing mistake. There is a comment saying this on the leads routes too,
 * because it has already happened once.
 *
 * Exists because the receipt dialog needs to show what DRM already knows
 * about the donor before asking anybody to type it in again.
 */
router.get('/qr/payments/:id', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, ${QR_UTR} AS utr,
              COALESCE(q_share.label, q_direct.label)               AS qr_label,
              COALESCE(q_share.purpose, q_direct.purpose)           AS qr_purpose,
              COALESCE(p.receipt_site, q_share.receipt_site, q_direct.receipt_site) AS site_for_receipt,
              s.shared_by, s.phone AS share_phone, COALESCE(s.lead_id, p.lead_id) AS lead_id,
              COALESCE(p.person_id, s.person_id) AS person_id, pe.phone AS person_phone,
              lu.name AS linked_by_name,
              su.name AS shared_by_name,
              l.name AS lead_name, l.email AS lead_email, l.assigned_to AS lead_assigned_to,
              pe.name AS person_name, pe.email AS person_email, pe.pan AS person_pan,
              pe.address AS person_address,
              -- Who, if anyone, this money is already counted for. The dialog
              -- must not offer to credit a payment that is already credited,
              -- and an admin untangling one needs to see who has it.
              cc.id AS credit_id, cc.user_id AS credit_user_id, cu.name AS credit_user_name
         FROM qr_payments p
         LEFT JOIN qr_shares s ON p.share_id = s.id
         LEFT JOIN users su ON s.shared_by = su.id
         LEFT JOIN razorpay_qrs q_share ON s.qr_id = q_share.id
         LEFT JOIN razorpay_qrs q_direct ON q_direct.qr_id = p.qr_id
         LEFT JOIN leads l ON l.id = COALESCE(s.lead_id, p.lead_id)
         LEFT JOIN people pe ON COALESCE(p.person_id, s.person_id) = pe.id
         LEFT JOIN users lu ON lu.id = p.linked_by
         LEFT JOIN caller_credits cc ON cc.qr_payment_id = p.id AND cc.status = 'active'
         LEFT JOIN users cu ON cc.user_id = cu.id
        WHERE p.id = $1
          -- A caller sees their own QRs' money and their own shares, same as
          -- the list does. Without this the detail route would be a way round
          -- the scoping on the screen it is opened from.
          AND ($2::uuid IS NULL OR s.shared_by = $2::uuid
               OR q_share.owner_id = $2::uuid OR q_direct.owner_id = $2::uuid
               -- Unclaimed money on a QR anybody may use - the same rule as
               -- QR_PAYMENT_VISIBLE on the list. Without it the list showed
               -- these payments to every caller and then answered "Payment
               -- not found." the moment one pressed Send receipt.
               OR p.linked_by = $2::uuid OR l.assigned_to = $2::uuid
               OR (NOT ${LINKED()} AND q_direct.owner_id IS NULL))`,
      [req.params.id, req.user?.role === 'caller' ? req.user?.userId ?? null : null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Payment not found.' });
    res.json({ payment: rows[0] });
  } catch (err) {
    console.error('crm.qrPayment error:', err);
    res.status(500).json({ error: 'Could not load payment.' });
  }
});

/**
 * POST /qr/payments/:id/receipt - raise the 80G receipt, with the donor's
 * details and who the donation is offered for.
 *
 * WHY THIS IS SEPARATE FROM /issue-receipt
 * That one is a retry: it re-runs what DRM already knows. This one is the
 * first run for a payment DRM knows almost nothing about - money that came
 * into a QR with no share behind it, where there is no lead, no person record
 * and therefore no name to put on a certificate. Those payments could not be
 * receipted at all before, which is the complaint this answers.
 *
 * WHY CREDIT AND RECEIPT ARE DECIDED IN THE SAME CALL BUT NOT WELDED TOGETHER
 * They were welded together: attributing a payment both credited a caller and
 * fired a real 80G number in one action. That is a dangerous pairing, because
 * a mis-credited figure can be corrected and a duplicate receipt cannot be
 * withdrawn. Here the two are separate writes: `credit_me` decides only
 * whether a credit row is written, and the receipt is raised either way. A
 * caller helping with a donor who is not theirs gets the receipt out and
 * takes no credit for it - which is exactly what was asked for.
 */
router.post('/qr/payments/:id/receipt', authenticate, async (req, res) => {
  const b = req.body ?? {};
  const donorName = str(b.donor_name, 160);
  const donorPhone = (str(b.donor_phone, 15) ?? '').replace(/\D/g, '').slice(-10) || null;
  const site = str(b.site, 20);

  if (!donorName) return res.status(400).json({ error: 'Enter the Donor Name.' });
  if (!donorPhone || donorPhone.length !== 10) {
    return res.status(400).json({ error: 'Enter a 10-digit mobile number.' });
  }

  try {
    // Same visibility rule as the detail route: a caller acts on their own
    // QRs and shares, nobody else's.
    const me = req.user?.role === 'caller' ? req.user?.userId ?? null : null;
    const found = await pool.query(
      `SELECT p.id, p.amount, p.received_at, p.receipt_status, s.shared_by,
              COALESCE(s.lead_id, p.lead_id) AS lead_id,
              l.assigned_to AS lead_assigned_to
         FROM qr_payments p
         LEFT JOIN qr_shares s ON p.share_id = s.id
         LEFT JOIN razorpay_qrs q_share ON s.qr_id = q_share.id
         LEFT JOIN razorpay_qrs q_direct ON q_direct.qr_id = p.qr_id
         LEFT JOIN leads l ON l.id = COALESCE(s.lead_id, p.lead_id)
        WHERE p.id = $1
          AND ($2::uuid IS NULL OR s.shared_by = $2::uuid
               OR q_share.owner_id = $2::uuid OR q_direct.owner_id = $2::uuid
               -- Unclaimed money on a QR anybody may use - the same rule as
               -- QR_PAYMENT_VISIBLE on the list. Without it the list showed
               -- these payments to every caller and then answered "Payment
               -- not found." the moment one pressed Send receipt.
               OR p.linked_by = $2::uuid OR l.assigned_to = $2::uuid
               OR (NOT ${LINKED()} AND q_direct.owner_id IS NULL))`,
      [req.params.id, me]
    );
    if (!found.rows.length) return res.status(404).json({ error: 'Payment not found.' });
    const pay = found.rows[0];

    if (pay.receipt_status === 'issued') {
      return res.status(409).json({ error: 'Receipt already issued.' });
    }

    // Stored on the payment, not just passed through, so a reprint months
    // later says exactly what the original said.
    //
    // COALESCE on the donor fields, for that reason. The dialog only sends a
    // field it has an input for, and "" used to mean "set this donor's PAN to
    // nothing" - so raising a receipt for a payment that had an address and no
    // PAN wiped the address, and every receipt wiped the sevak's phone. An
    // audit field on a financial record must not be erasable by omission. A
    // genuine correction still goes through, because the form is prefilled
    // from the stored value and sends it back non-empty.
    await pool.query(
      `UPDATE qr_payments SET
         donor_name    = COALESCE(NULLIF($2, ''), donor_name),
         donor_phone   = COALESCE(NULLIF($3, ''), donor_phone),
         donor_email   = COALESCE(NULLIF($4, ''), donor_email),
         donor_pan     = COALESCE(NULLIF($5, ''), donor_pan),
         donor_address = COALESCE(NULLIF($6, ''), donor_address),
         purpose       = COALESCE($7, purpose),
         sevak_name    = COALESCE(NULLIF($8, ''), sevak_name),
         sevak_phone   = COALESCE(NULLIF($9, ''), sevak_phone),
         want_prasadam = COALESCE($12::boolean, want_prasadam),
         -- Said outright rather than read off the PAN: the PAN is kept even
         -- when a field arrives empty (see above), so "no 80G this time" has
         -- to be its own answer or it could never be given.
         want_certificate = COALESCE($13::boolean, want_certificate),
         receipt_site = COALESCE($10, receipt_site),
         receipt_by = $11, receipt_status = NULL, receipt_error = NULL
       WHERE id = $1`,
      [
        req.params.id,
        donorName,
        donorPhone,
        str(b.donor_email, 160),
        (str(b.donor_pan, 12) ?? '').toUpperCase() || null,
        str(b.donor_address, 400),
        str(b.purpose, 120),
        // "On the name of" - the person the donation is offered for. This is
        // what prints in the sevak field on both sites' receipts, and on
        // annadan it is also who gets the birthday message.
        str(b.sevak_name, 160),
        (str(b.sevak_phone, 15) ?? '').replace(/\D/g, '').slice(-10) || null,
        site,
        req.user?.userId ?? null,
        typeof b.want_prasadam === 'boolean' ? b.want_prasadam : null,
        typeof b.want_certificate === 'boolean' ? b.want_certificate : null,
      ]
    );

    // Every receipted payment belongs to somebody in DRM. A payment nobody
    // linked is linked here to the donor on the receipt - found by mobile
    // number, or added - so the donation shows on their record and the
    // payment stops showing as "Not linked".
    await autoLinkForReceipt(String(req.params.id), donorName, donorPhone, req.user).catch((e) =>
      console.error('crm.qrReceipt auto-link failed (non-fatal):', (e as Error).message)
    );

    await issueReceiptForPayment(String(req.params.id));

    const after = await pool.query(
      `SELECT receipt_status, receipt_error, receipt_number, external_donation_id
         FROM qr_payments WHERE id = $1`,
      [req.params.id]
    );
    const outcome = after.rows[0];

    /* THE CREDIT, DECIDED SEPARATELY AND ONLY ON A SUCCESSFUL RECEIPT.
     *
     * "Is this your lead?" in the dialog is this flag. Yes credits the caller;
     * no raises the receipt and credits nobody, which is the case where a
     * caller is simply helping a donor who belongs to somebody else.
     *
     * Not credited when the receipt failed: a credit for money whose receipt
     * the site rejected would be a figure with nothing behind it, and the
     * retry will come back through here anyway.
     */
    let credited = null;
    if (b.credit_me === true && outcome?.receipt_status === 'issued') {
      const creditTo = req.user?.userId ?? null;
      if (creditTo) {
        credited = await recordCredit({
          userId: creditTo,
          amount: Number(pay.amount),
          kind: 'qr',
          occurredAt: pay.received_at,
          qrPaymentId: pay.id,
          leadId: pay.lead_id ?? null,
          note: `Receipt issued for QR payment${donorName ? ` from ${donorName}` : ''}`,
          createdBy: creditTo,
        }).catch((e) => {
          console.error('crm.qrReceipt credit failed:', (e as Error).message);
          return null;
        });
      }
    }

    res.json({
      receipt_status: outcome?.receipt_status ?? null,
      receipt_error: outcome?.receipt_error ?? null,
      receipt_number: outcome?.receipt_number ?? null,
      external_donation_id: outcome?.external_donation_id ?? null,
      // null means "already credited to somebody" as well as "not asked for",
      // so the screen says what happened rather than implying a silent success.
      credited: !!credited,
    });
  } catch (err) {
    console.error('crm.qrReceipt error:', err);
    res.status(500).json({ error: 'Could not issue receipt. Try again.' });
  }
});

/**
 * POST /qr/payments/:id/claim - "that one was mine".
 *
 * The case this exists for: a donor pays into the temple's shared QR after a
 * call, and DRM cannot prove which call. The payment arrives attributed to
 * nobody, sits on the unmatched list, and the caller who actually earned it
 * has no way to say so. Over a month that is a real part of somebody's work
 * missing from their figures.
 *
 * This is weaker evidence than a matched share and the ledger says so: the
 * credit is written with kind 'qr' but a note recording that a person claimed
 * it, and an admin can see every claim and reverse one. The database decides
 * races, not this handler - a partial unique index means the second of two
 * simultaneous claims gets `null` back and is told the money is already
 * attributed, rather than both callers counting it.
 *
 * Deliberately does NOT raise a receipt. Attribution and a legal document
 * with the temple's name on it should not be one button; a mis-claim is
 * reversible and a duplicate 80G number is not.
 */
router.post('/qr/payments/:id/claim', authenticate, async (req, res) => {
  const me = req.user?.userId;
  if (!me) return res.status(401).json({ error: 'Sign in again' });

  // An admin may claim on somebody else's behalf - reconciling a shift after
  // the fact is their job. A caller may only claim for themselves.
  const forUser =
    req.user?.role === 'caller' ? me : str(req.body?.user_id, 36) ?? me;

  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.amount, p.received_at, p.payer_name,
              q.label AS qr_label,
              cc.id AS credit_id, cu.name AS credit_user_name
         FROM qr_payments p
         LEFT JOIN razorpay_qrs q ON q.qr_id = p.qr_id
         LEFT JOIN caller_credits cc ON cc.qr_payment_id = p.id AND cc.status = 'active'
         LEFT JOIN users cu ON cc.user_id = cu.id
        WHERE p.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Payment not found.' });
    const p = rows[0];

    if (p.credit_id) {
      return res.status(409).json({
        error: `Already counted for ${p.credit_user_name ?? 'another caller'}.`,
      });
    }

    const note = str(req.body?.note, 300);
    const credit = await recordCredit({
      userId: forUser,
      amount: Number(p.amount),
      kind: 'qr',
      occurredAt: p.received_at,
      qrPaymentId: p.id,
      note: note
        ? `Added by hand: ${note}`
        : `Added by hand${p.qr_label ? ` from QR ${p.qr_label}` : ''}`,
      createdBy: me,
    });

    if (!credit) {
      // Lost the race rather than hit an error. Said plainly, because the
      // screen refreshing to show somebody else's name on it would otherwise
      // look like the button did nothing.
      return res.status(409).json({ error: 'Someone else just added this to their total.' });
    }
    res.json({ claimed: true, credit });
  } catch (err) {
    console.error('crm.claimPayment error:', err);
    res.status(500).json({ error: 'Could not add to your total. Try again.' });
  }
});

/**
 * DELETE /qr/payments/:id/claim - take it back off somebody.
 *
 * Reversal, not deletion: the row stays with a reason on it. A credit is a
 * claim about money, and erasing one leaves no record that anybody ever made
 * it - which is exactly what you want to be able to look up when two people
 * disagree about a figure.
 */
router.delete('/qr/payments/:id/claim', authenticate, authorize('admin', 'accountant'), async (req, res) => {
  try {
    const n = await reverseCreditFor(
      { qrPaymentId: String(req.params.id) },
      req.user?.userId ?? '',
      str(req.body?.reason, 300) ?? 'Undone by an admin'
    );
    if (!n) return res.status(404).json({ error: 'This payment is not counted for anyone.' });
    res.json({ reversed: n });
  } catch (err) {
    console.error('crm.unclaimPayment error:', err);
    res.status(500).json({ error: 'Could not undo. Try again.' });
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

/* =========================================================================
   LINKING A PAYMENT TO WHOEVER PAID IT
   ========================================================================= */

type Who = { userId?: string; role?: string } | undefined;

/**
 * The payment, if this user may act on it - the same rule as the list.
 * Locked when a client is passed, because linking reads then writes.
 */
async function paymentFor(id: string, user: Who, client?: PoolClient) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const db = client ?? pool;
  const me = user?.role === 'caller' ? user?.userId ?? null : null;
  const r = await db.query(
    `SELECT p.*,
            COALESCE(pe.name, l.name, sl.name, p.donor_name) AS linked_name,
            COALESCE(pe.phone, l.phone, s.phone, p.donor_phone) AS linked_phone
       FROM qr_payments p
       LEFT JOIN qr_shares s ON p.share_id = s.id
       LEFT JOIN razorpay_qrs qs ON s.qr_id = qs.id
       LEFT JOIN razorpay_qrs qd ON qd.qr_id = p.qr_id
       LEFT JOIN leads l ON l.id = p.lead_id
       LEFT JOIN leads sl ON sl.id = s.lead_id
       LEFT JOIN people pe ON pe.id = COALESCE(p.person_id, s.person_id)
      WHERE p.id = $1
        AND ($2::uuid IS NULL OR s.shared_by = $2::uuid OR qs.owner_id = $2::uuid
             OR qd.owner_id = $2::uuid OR p.linked_by = $2::uuid
             OR l.assigned_to = $2::uuid OR sl.assigned_to = $2::uuid
             OR (NOT ${LINKED()} AND qd.owner_id IS NULL))
      ${client ? 'FOR UPDATE OF p' : ''}`,
    [id, me]
  );
  return r.rows[0] ?? null;
}

/** What a lead looked like before a link marked it Donated, for unlinking. */
async function leadBefore(client: PoolClient, leadId: string) {
  const b = await client.query(
    `SELECT status, converted_at, converted_amount, converted_via, converted_note, converted_donation_id,
            conversion_seen_at, next_follow_up_at, follow_up_note, awaiting_qr_at, alt_phone,
            assigned_to, assigned_at
       FROM leads WHERE id = $1 FOR UPDATE`,
    [leadId]
  );
  const open = await client.query(`SELECT id FROM lead_reminders WHERE lead_id = $1 AND status = 'open'`, [leadId]);
  return { lead_id: leadId, before: b.rows[0] ?? null, open_reminders: open.rows.map((r) => r.id as string) };
}

export type LinkTarget =
  | { kind: 'share'; id: string }
  | { kind: 'lead'; id: string }
  | { kind: 'person'; id: string }
  | { kind: 'new'; name: string; phone: string };

type LinkResult =
  | { ok: true; kind: string; name: string | null; phone: string | null; personId: string | null; existing?: boolean }
  | { ok: false; status: number; error: string };

/**
 * Link a payment (already locked by the caller's transaction) to a person.
 *
 * WHO IS CREDITED
 *   share  - whoever sent that QR, exactly as an automatic match does.
 *   lead   - the lead's caller. A lead nobody owns goes to the caller linking
 *            it, and becomes theirs, as markLeadDonated already does.
 *   person / new - the caller who linked it. An admin or accountant linking
 *            is reconciling, not earning, so nobody is credited; "Add to my
 *            total" on the row still works for whoever it really was.
 * Money already counted for somebody stays with them - recordCredit refuses a
 * second credit for the same payment.
 */
async function linkPayment(client: PoolClient, pay: any, target: LinkTarget, user: Who): Promise<LinkResult> {
  const me = user?.userId ?? null;
  const isCaller = user?.role === 'caller';
  if (pay.share_id || pay.lead_id || pay.person_id) {
    return { ok: false, status: 409, error: `Already linked to ${pay.linked_name ?? 'someone'}. Unlink it first.` };
  }
  const amount = Number(pay.amount);
  const evidence = { qrPaymentId: pay.id as string, occurredAt: pay.received_at as string };
  const note = 'Paid by QR, linked by hand';
  let undo: Record<string, unknown> = { donor_was: { name: pay.donor_name, phone: pay.donor_phone } };
  let name: string | null = null;
  let phone: string | null = null;
  let personId: string | null = null;
  let leadId: string | null = null;
  let shareId: string | null = null;
  let kind: string = target.kind;
  let existing = false;

  if (target.kind === 'share') {
    const sh = await client.query(
      `SELECT s.*, l.name AS lead_name FROM qr_shares s LEFT JOIN leads l ON l.id = s.lead_id
        WHERE s.id = $1 AND s.matched_at IS NULL AND ($2::uuid IS NULL OR s.shared_by = $2::uuid)`,
      [target.id, isCaller ? me : null]
    );
    if (!sh.rows.length) return { ok: false, status: 404, error: 'That QR send was not found, or is already linked.' };
    const share = sh.rows[0];
    shareId = share.id;
    personId = share.person_id ?? null;
    name = share.lead_name ?? null;
    phone = share.phone ?? null;
    await client.query(
      `UPDATE qr_shares SET matched_payment_id = $2, matched_amount = $3::numeric,
         matched_at = NOW(), matched_via = 'manual', matched_by = $4::uuid WHERE id = $1`,
      [share.id, pay.payment_id, amount, me]
    );
    if (share.lead_id) {
      undo = { ...undo, lead: await leadBefore(client, share.lead_id) };
      await markLeadDonated(share.lead_id, amount, note, client, share.shared_by ?? null, {
        ...evidence, shareId: share.id, personId: share.person_id ?? undefined,
      });
    } else if (share.shared_by) {
      await recordCredit(
        { userId: share.shared_by, amount, kind: 'qr', ...evidence, shareId: share.id, personId: share.person_id ?? undefined, note },
        client
      );
    }
  } else if (target.kind === 'lead') {
    const ld = await client.query(
      `SELECT * FROM leads WHERE id = $1 AND ($2::uuid IS NULL OR assigned_to = $2::uuid OR assigned_to IS NULL OR assigned_to IN (SELECT id FROM users WHERE role <> 'caller'))`,
      [target.id, isCaller ? me : null]
    );
    if (!ld.rows.length) return { ok: false, status: 404, error: 'Lead not found.' };
    const lead = ld.rows[0];
    leadId = lead.id;
    personId = lead.person_id ?? null;
    name = lead.name ?? null;
    phone = lead.phone ?? null;
    undo = { ...undo, lead: await leadBefore(client, lead.id) };
    // The lead's caller is credited. A lead parked with somebody who does not
    // make calls (an admin) is taken over by the caller linking it, as calling
    // it would.
    const ownerCalls = lead.assigned_to
      ? (await client.query(`SELECT role = 'caller' AS calls FROM users WHERE id = $1`, [lead.assigned_to])).rows[0]?.calls === true
      : false;
    if (lead.assigned_to && !ownerCalls && isCaller && me) {
      await client.query(`UPDATE leads SET assigned_to = $2::uuid, assigned_at = NOW() WHERE id = $1`, [lead.id, me]);
      (undo.lead as Record<string, unknown>).taken_from = lead.assigned_to;
      lead.assigned_to = me;
    }
    const creditTo = lead.assigned_to ?? (isCaller ? me : null);
    await markLeadDonated(lead.id, amount, note, client, creditTo, { ...evidence, personId: lead.person_id ?? undefined });
    // The number they paid from, so their next payment from it is recognised.
    const payer = phone10(pay.payer_phone);
    if (/^[6-9]\d{9}$/.test(payer) && payer !== lead.phone && !lead.alt_phone) {
      await client.query(`UPDATE leads SET alt_phone = $2 WHERE id = $1`, [lead.id, payer]);
      (undo.lead as Record<string, unknown>).set_alt_phone = true;
    }
  } else {
    let person;
    if (target.kind === 'person') {
      person = (await client.query(`SELECT id, name, phone FROM people WHERE id = $1`, [target.id])).rows[0];
      if (!person) return { ok: false, status: 404, error: 'Person not found.' };
    } else {
      const nm = String(target.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 160);
      const ph = phone10(target.phone);
      if (nm.length < 2) return { ok: false, status: 400, error: 'Enter the Donor Name.' };
      if (!/^[6-9]\d{9}$/.test(ph)) return { ok: false, status: 400, error: 'Enter a 10-digit mobile number.' };
      person = (await client.query(`SELECT id, name, phone FROM people WHERE phone = $1`, [ph])).rows[0];
      if (person) {
        // Already in DRM under this number - linked to that record rather
        // than a second one, which the unique phone would refuse anyway.
        existing = true;
        kind = 'person';
      } else {
        person = (
          await client.query(
            `INSERT INTO people (name, phone, roles) VALUES ($1, $2, ARRAY['donor']::TEXT[]) RETURNING id, name, phone`,
            [nm, ph]
          )
        ).rows[0];
        undo = { ...undo, created_person: person.id };
      }
    }
    personId = person.id;
    name = person.name;
    phone = person.phone;
    if (isCaller && me) {
      await recordCredit({ userId: me, amount, kind: 'qr', ...evidence, personId: person.id, note, createdBy: me }, client);
    }
  }

  await client.query(
    `UPDATE qr_payments SET share_id = $2, lead_id = $3, person_id = $4,
       linked_by = $5, linked_at = NOW(), link_kind = $6, link_undo = $7::jsonb,
       donor_name  = COALESCE(NULLIF(donor_name, ''), $8),
       donor_phone = COALESCE(NULLIF(donor_phone, ''), $9)
     WHERE id = $1`,
    [pay.id, shareId, leadId, personId, me, kind, JSON.stringify(undo), name, phone10(phone) || null]
  );
  return { ok: true, kind, name, phone, personId, existing };
}

/** Used by the receipt route: link to the donor on the receipt when nobody linked it. */
async function autoLinkForReceipt(id: string, donorName: string, donorPhone: string, user: Who) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pay = await paymentFor(id, user, client);
    if (!pay || pay.share_id || pay.lead_id || pay.person_id) {
      await client.query('ROLLBACK');
      return;
    }
    const r = await linkPayment(client, pay, { kind: 'new', name: donorName, phone: donorPhone }, user);
    await client.query(r.ok ? 'COMMIT' : 'ROLLBACK');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * GET /qr/payments/:id/who?q= - who could have paid this.
 *
 * With no search: the likely ones - a QR sent to somebody who promised, or
 * for the same amount, and anybody DRM knows on the number the money came
 * from. With a search: name or mobile across QR sends, leads and donors.
 * One row per mobile number, the most specific kind first.
 */
router.get('/qr/payments/:id/who', authenticate, async (req, res) => {
  try {
    const pay = await paymentFor(String(req.params.id), req.user);
    if (!pay) return res.status(404).json({ error: 'Payment not found.' });
    const isCaller = req.user?.role === 'caller';
    const me = isCaller ? req.user?.userId ?? null : null;
    const term = String(req.query.q ?? '').trim().slice(0, 80);
    const digits = term.replace(/\D/g, '');
    const byDigits = digits.length >= 4 ? digits.slice(-10) : '';
    const byText = byDigits ? '' : term;
    const payer = phone10(pay.payer_phone);
    const firstWord = String(pay.payer_name ?? '').includes('@') ? '' : String(pay.payer_name ?? '').trim().split(/\s+/)[0] ?? '';
    const suggest = !term;

    const [shares, leads, people] = await Promise.all([
      pool.query(
        `SELECT s.id, s.phone, s.lead_id, l.name, s.expected_amount, s.created_at, q.label AS qr_label,
                u.name AS owner_name,
                (s.awaiting_payment_at IS NOT NULL OR l.awaiting_qr_at IS NOT NULL) AS promised
           FROM qr_shares s
           JOIN razorpay_qrs q ON q.id = s.qr_id
           LEFT JOIN leads l ON l.id = s.lead_id
           LEFT JOIN users u ON u.id = s.shared_by
          WHERE s.matched_at IS NULL
            AND s.created_at > NOW() - INTERVAL '60 days'
            AND ($1::uuid IS NULL OR s.shared_by = $1::uuid)
            AND (CASE WHEN $2::boolean THEN
                   (s.awaiting_payment_at IS NOT NULL OR l.awaiting_qr_at IS NOT NULL
                    OR s.expected_amount = $3::numeric OR s.phone = $4
                    OR (q.qr_id = $5 AND s.created_at > $6::timestamptz - INTERVAL '7 days'))
                 ELSE (($7::text <> '' AND (l.name ILIKE '%' || $7 || '%'))
                       OR ($8::text <> '' AND s.phone LIKE '%' || $8 || '%')) END)
          ORDER BY (s.phone = $4) DESC, (s.expected_amount = $3::numeric) DESC,
                   (s.awaiting_payment_at IS NOT NULL OR l.awaiting_qr_at IS NOT NULL) DESC, s.created_at DESC
          LIMIT 10`,
        [me, suggest, pay.amount, payer, pay.qr_id, pay.received_at, byText, byDigits]
      ),
      pool.query(
        `SELECT l.id, l.name, l.phone, l.alt_phone, l.status, l.person_id, l.expected_amount, u.name AS owner_name,
                l.assigned_to
           FROM leads l
           LEFT JOIN users u ON u.id = l.assigned_to
          WHERE ($1::uuid IS NULL OR l.assigned_to = $1::uuid OR l.assigned_to IS NULL OR l.assigned_to IN (SELECT id FROM users WHERE role <> 'caller'))
            AND (CASE WHEN $2::boolean THEN
                   ($3::text <> '' AND (l.phone = $3 OR l.alt_phone = $3))
                   OR ($6::text <> '' AND length($6) >= 3 AND l.name ILIKE $6 || '%'
                       AND l.expected_amount = $7::numeric)
                 ELSE (($4::text <> '' AND l.name ILIKE '%' || $4 || '%')
                       OR ($5::text <> '' AND (l.phone LIKE '%' || $5 || '%' OR COALESCE(l.alt_phone,'') LIKE '%' || $5 || '%'))) END)
          ORDER BY (l.phone = $3) DESC, l.updated_at DESC NULLS LAST
          LIMIT 10`,
        [me, suggest, payer, byText, byDigits, firstWord, pay.amount]
      ),
      pool.query(
        `SELECT p.id, p.name, p.phone, p.email,
                (SELECT COUNT(*)::int FROM donations d WHERE d.person_id = p.id) AS donations
           FROM people p
          WHERE (CASE WHEN $1::boolean THEN $2::text <> '' AND p.phone = $2
                 ELSE (($3::text <> '' AND p.name ILIKE '%' || $3 || '%')
                       OR ($4::text <> '' AND p.phone LIKE '%' || $4 || '%')
                       OR ($3::text <> '' AND p.email ILIKE '%' || $3 || '%')) END)
          ORDER BY (p.phone = $2) DESC, p.updated_at DESC
          LIMIT 10`,
        [suggest, payer, byText, byDigits]
      ),
    ]);

    const seen = new Set<string>();
    const out: Record<string, unknown>[] = [];
    const add = (row: Record<string, unknown>) => {
      const key = String(row.phone ?? '') || String(row.id);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(row);
    };
    const amt = Number(pay.amount);
    for (const s of shares.rows) {
      add({
        kind: 'share', id: s.id, name: s.name, phone: s.phone,
        hint: `QR sent ${s.qr_label ? `(${s.qr_label}) ` : ''}${new Date(s.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}${s.owner_name ? ` by ${s.owner_name}` : ''}`,
        promised: !!s.promised,
        same_amount: s.expected_amount != null && Math.abs(Number(s.expected_amount) - amt) < 1,
        same_number: !!payer && s.phone === payer,
      });
    }
    for (const l of leads.rows) {
      add({
        kind: 'lead', id: l.id, name: l.name, phone: l.phone,
        hint: `Lead${l.owner_name ? ` · ${l.owner_name}` : ' · nobody yet'}${l.status === 'converted' ? ' · already donated' : ''}`,
        same_amount: l.expected_amount != null && Math.abs(Number(l.expected_amount) - amt) < 1,
        same_number: !!payer && (l.phone === payer || l.alt_phone === payer),
      });
    }
    for (const p of people.rows) {
      add({
        kind: 'person', id: p.id, name: p.name, phone: p.phone,
        hint: p.donations ? `Donor · ${p.donations} donation${p.donations === 1 ? '' : 's'}` : 'In DRM',
        same_number: !!payer && p.phone === payer,
      });
    }
    res.json({ results: out.slice(0, 20), payer: { phone: payer || null, name: firstWord ? pay.payer_name : null } });
  } catch (err) {
    console.error('crm.qrWho error:', err);
    res.status(500).json({ error: 'Could not search. Try again.' });
  }
});

/**
 * POST /qr/payments/:id/link
 *   { kind: 'share' | 'lead' | 'person', id }  or  { kind: 'new', name, phone }
 *
 * Says who paid. Does not raise the receipt - the screen shows the receipt
 * form next, filled in from whoever was picked, so what goes on the 80G
 * certificate is seen before it is sent.
 */
router.post('/qr/payments/:id/link', authenticate, async (req, res) => {
  const b = req.body ?? {};
  const kind = String(b.kind ?? '');
  let target: LinkTarget;
  if (kind === 'share' || kind === 'lead' || kind === 'person') {
    const id = str(b.id, 36);
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Pick who paid.' });
    target = { kind, id };
  } else if (kind === 'new') {
    target = { kind, name: String(b.name ?? ''), phone: String(b.phone ?? '') };
  } else {
    return res.status(400).json({ error: 'Pick who paid.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pay = await paymentFor(String(req.params.id), req.user, client);
    if (!pay) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Payment not found.' });
    }
    const r = await linkPayment(client, pay, target, req.user);
    if (!r.ok) {
      await client.query('ROLLBACK');
      return res.status(r.status).json({ error: r.error });
    }
    await client.query('COMMIT');
    const credit = await pool.query(
      `SELECT u.name FROM caller_credits c JOIN users u ON u.id = c.user_id
        WHERE c.qr_payment_id = $1 AND c.status = 'active' LIMIT 1`,
      [pay.id]
    );
    res.json({
      linked: true,
      kind: r.kind,
      name: r.name,
      phone: r.phone,
      person_id: r.personId,
      existing: !!r.existing,
      counted_for: credit.rows[0]?.name ?? null,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('crm.qrLink error:', err);
    res.status(500).json({ error: 'Could not link. Try again.' });
  } finally {
    client.release();
  }
});

/**
 * POST /qr/payments/:id/unlink { reason? } - "that was the wrong person".
 *
 * Only before the receipt is sent: once an 80G receipt is out in somebody's
 * name, the payment is theirs. Whoever linked it may unlink it; an admin or
 * accountant may unlink any, including an automatic match.
 *
 * Undoes what linking did: the credit is reversed, the QR send is free to
 * match again, and a lead that this link marked Donated goes back to how it
 * was - promises reopened, status restored. A person added only for this
 * link is left in DRM: they may have been right about the person and wrong
 * about the payment.
 */
router.post('/qr/payments/:id/unlink', authenticate, async (req, res) => {
  const me = req.user?.userId ?? '';
  const elevated = req.user?.role === 'admin' || req.user?.role === 'accountant';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pay = await paymentFor(String(req.params.id), req.user, client);
    if (!pay || !(pay.share_id || pay.lead_id || pay.person_id)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'This payment is not linked.' });
    }
    if (pay.receipt_status === 'issued' || pay.receipt_status === 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'The receipt is already sent, so this link stays.' });
    }
    if (!elevated && pay.linked_by !== me) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only the person who linked it, or an admin, can unlink it.' });
    }

    await reverseCreditFor({ qrPaymentId: pay.id }, me, str(req.body?.reason, 300) ?? 'Unlinked: wrong person', client);

    // The lead this money converted, if any - for saying so when there is
    // nothing recorded to put it back to.
    let leadOfLink: string | null = pay.lead_id ?? null;
    if (pay.share_id) {
      const sl = await client.query(`SELECT lead_id FROM qr_shares WHERE id = $1`, [pay.share_id]);
      leadOfLink = leadOfLink ?? sl.rows[0]?.lead_id ?? null;
      await client.query(
        `UPDATE qr_shares SET matched_payment_id = NULL, matched_amount = NULL, matched_at = NULL,
           matched_via = NULL, matched_by = NULL WHERE id = $1`,
        [pay.share_id]
      );
    }

    const undo = (pay.link_undo ?? {}) as {
      lead?: { lead_id: string; before: Record<string, any> | null; open_reminders: string[]; set_alt_phone?: boolean };
      donor_was?: { name: string | null; phone: string | null };
    };
    let leadRestored = false;
    if (undo.lead?.before) {
      const bf = undo.lead.before;
      const r = await client.query(
        `UPDATE leads SET status = $2, converted_at = $3::timestamptz, converted_amount = $4::numeric,
                converted_via = $5, converted_note = $6, converted_donation_id = $7::uuid,
                conversion_seen_at = $8::timestamptz, next_follow_up_at = $9::timestamptz,
                follow_up_note = $10, awaiting_qr_at = $11::timestamptz, assigned_to = $12::uuid,
                assigned_at = $13::timestamptz,
                alt_phone = CASE WHEN $14::boolean THEN $15 ELSE alt_phone END,
                updated_at = NOW()
          WHERE id = $1 AND status = 'converted'`,
        [
          undo.lead.lead_id, bf.status, bf.converted_at, bf.converted_amount, bf.converted_via, bf.converted_note,
          bf.converted_donation_id, bf.conversion_seen_at, bf.next_follow_up_at, bf.follow_up_note,
          bf.awaiting_qr_at, bf.assigned_to, bf.assigned_at, !!undo.lead.set_alt_phone, bf.alt_phone ?? null,
        ]
      );
      leadRestored = (r.rowCount ?? 0) > 0;
      if (leadRestored && undo.lead.open_reminders?.length) {
        await client.query(
          `UPDATE lead_reminders SET status = 'open', completed_at = NULL, updated_at = NOW()
            WHERE id = ANY($1::uuid[]) AND status = 'done'`,
          [undo.lead.open_reminders]
        );
      }
      if (leadRestored) {
        await client.query(
          `INSERT INTO lead_activities (lead_id, user_id, kind, from_value, to_value, note)
           VALUES ($1::uuid, $2::uuid, 'status_change', 'converted', $3, $4)`,
          [undo.lead.lead_id, me || null, bf.status, 'QR payment unlinked: it was not theirs']
        );
      }
    }

    await client.query(
      `UPDATE qr_payments SET share_id = NULL, lead_id = NULL, person_id = NULL,
         linked_by = NULL, linked_at = NULL, link_kind = NULL, link_undo = NULL,
         donor_name = $2, donor_phone = $3,
         receipt_status = CASE WHEN receipt_status = 'needs_donor' THEN NULL ELSE receipt_status END
       WHERE id = $1`,
      [pay.id, undo.donor_was ? undo.donor_was.name : pay.donor_name, undo.donor_was ? undo.donor_was.phone : pay.donor_phone]
    );
    await client.query('COMMIT');
    res.json({
      unlinked: true,
      // A lead converted by an automatic match has nothing recorded to go back
      // to, so it stays Donated. Said, so somebody can fix it by hand.
      lead_left_donated: !!leadOfLink && !leadRestored,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('crm.qrUnlink error:', err);
    res.status(500).json({ error: 'Could not unlink. Try again.' });
  } finally {
    client.release();
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
  if (!shareId) return res.status(400).json({ error: 'Pick who paid.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pay = await paymentFor(String(req.params.id), req.user, client);
    if (!pay) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Payment not found.' });
    }
    // A caller may only attribute a payment to a QR they themselves shared -
    // linkPayment enforces it. Without that, attributing was a one-click way
    // to move a colleague's donation onto your own figures.
    const r = await linkPayment(client, pay, { kind: 'share', id: shareId }, req.user);
    if (!r.ok) {
      await client.query('ROLLBACK');
      return res.status(r.status === 409 ? 409 : 404).json({ error: r.status === 409 ? r.error : 'Not found.' });
    }
    await client.query('COMMIT');

    // Kept for anything still calling this directly: it belongs to somebody
    // now, so the donor is owed a receipt, the same as an automatic match.
    // The QR payments screen uses /link instead and shows the form first.
    if (req.body?.send_receipt !== false) {
      void issueReceiptForPayment(pay.id).catch((e) =>
        console.error('crm.issueReceipt error:', (e as Error).message)
      );
    }

    res.json({ attached: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('crm.attachPayment error:', err);
    res.status(500).json({ error: 'Could not link payment. Try again.' });
  } finally {
    client.release();
  }
});

export default router;
