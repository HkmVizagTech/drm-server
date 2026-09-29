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
import { SiteKey, SITE_KEYS, getSite } from '../services/hkmvClient';

const router = Router();

// Constant-time-ish comparison. Node's timingSafeEqual needs equal-length
// buffers, so length is checked first - that leaks only the length, which for
// a fixed-length hex secret is not a secret.
function constantTimeEquals(provided: unknown, expected: string): boolean {
  if (!expected) return false;
  if (typeof provided !== 'string' || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

// Accept the secret of ANY configured donation site, and report which one
// matched.
//
// Each site gets its own secret so that a compromise of one doesn't hand over
// the other - which only works if this endpoint actually recognises more than
// one. An earlier version checked HKMV_INTERNAL_SECRET alone, which silently
// required every site to share the main site's secret.
function matchSite(provided: unknown): SiteKey | null {
  for (const key of SITE_KEYS) {
    const site = getSite(key);
    if (site.secret && constantTimeEquals(provided, site.secret)) return key;
  }
  return null;
}

router.use((req, res, next) => {
  const configured = SITE_KEYS.filter((k) => getSite(k).secret);
  if (!configured.length) {
    return res.status(503).json({
      error: 'Webhook endpoint is not configured - no site secret is set (HKMV_INTERNAL_SECRET / ANNADAN_INTERNAL_SECRET).',
    });
  }
  const matched = matchSite(req.headers['x-internal-secret']);
  if (!matched) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Remember which site's credential was used, so the handler can trust it
  // over anything self-declared in the request body.
  (req as unknown as { authedSite?: SiteKey }).authedSite = matched;
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
  const payload = req.body as DonorSnapshotInput & { reason?: string; triggeredByDonationId?: string; site?: string };

  if (!payload || !payload.donor || !payload.donor.mobile) {
    return res.status(400).json({ error: 'Payload must include donor.mobile' });
  }

  // Which site pushed this. The site whose SECRET authenticated the request
  // wins over anything the body claims - a caller holding annadan's key must
  // not be able to write rows attributed to the main site just by saying so.
  const authedSite = (req as unknown as { authedSite?: SiteKey }).authedSite;
  const claimed = (payload.donor?.sourceSite || payload.site) as SiteKey | undefined;
  const site = authedSite || claimed || 'hkmv';

  if (!SITE_KEYS.includes(site)) {
    return res.status(400).json({ error: `Unknown source site "${site}"` });
  }
  if (claimed && authedSite && claimed !== authedSite) {
    console.warn(`[webhook] payload claimed site "${claimed}" but authenticated as "${authedSite}" - using "${authedSite}"`);
  }

  try {
    const counts = await upsertDonorSnapshot(payload, site);
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
