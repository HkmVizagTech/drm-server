// Inbound webhooks from hkmsite2.0-server (the live donation site).
//
// This is the "live connection": the moment a donation completes over there,
// its post-completion pipeline POSTs the donor's updated snapshot here and
// DRM reflects it immediately - no manual sync, no polling.
//
// AUTH: shared secret header, NOT the admin JWT. hkmsite2.0 calls this
// server-to-server with no logged-in user, so `authenticate` would reject it.
// This router is therefore mounted OUTSIDE the authenticated route group and
// guards itself with the same HKMV_INTERNAL_SECRET used for outbound calls,
// so one secret configures the connection in both directions.

import { Router } from 'express';
import { upsertDonorSnapshot, DonorSnapshotInput } from '../services/hkmvSync';

const router = Router();

// Constant-time-ish comparison. Node's timingSafeEqual needs equal-length
// buffers, so length is checked first - that leaks only the length, which for
// a fixed-length hex secret is not a secret.
function secretMatches(provided: unknown): boolean {
  const expected = process.env.HKMV_INTERNAL_SECRET || '';
  if (!expected) return false;
  if (typeof provided !== 'string' || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

router.use((req, res, next) => {
  if (!process.env.HKMV_INTERNAL_SECRET) {
    return res.status(503).json({ error: 'Webhook endpoint is not configured (HKMV_INTERNAL_SECRET unset)' });
  }
  if (!secretMatches(req.headers['x-internal-secret'])) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// POST /api/webhooks/hkmv/donor-updated
// Body is the same snapshot shape GET /api/internal/donors/by-mobile/:mobile
// returns, so push and pull share one upsert path in hkmvSync.
//
// Idempotent by construction (people keyed by phone, everything else by
// external_ref), which matters because hkmsite2.0 may legitimately send the
// same donor more than once - e.g. a subscription charge and a retry.
router.post('/hkmv/donor-updated', async (req, res) => {
  const payload = req.body as DonorSnapshotInput & { reason?: string; triggeredByDonationId?: string };

  if (!payload || !payload.donor || !payload.donor.mobile) {
    return res.status(400).json({ error: 'Payload must include donor.mobile' });
  }

  try {
    const counts = await upsertDonorSnapshot(payload);
    console.log(
      `[webhook] hkmv donor-updated (${payload.reason || 'unspecified'}): person=${counts.personId} ` +
      `created=${counts.created} donations=${counts.donationsSynced} subs=${counts.subscriptionsSynced} prasadam=${counts.deliveriesSynced}`
    );
    res.json({ ok: true, ...counts });
  } catch (err) {
    // Log loudly - a failure here means DRM is silently drifting out of date.
    // Respond 500 so hkmsite2.0 records the failure in its own logs too.
    console.error('[webhook] hkmv donor-updated failed:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
