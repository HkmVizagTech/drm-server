// Receipt PDFs: fetching them from the sites, and caching them safely.
//
// WHERE RECEIPTS COME FROM
// DRM does not generate them. Each site allocates its own 80G number from its
// own series and renders its own PDF, and DRM proxies that. Keeping it that
// way is deliberate: two systems issuing numbers into one series is how a
// charity ends up with duplicate 80G receipts.
//
// WHY A CACHE IS SAFE HERE, WHEN CACHES USUALLY ARE NOT
// The usual objection is staleness - the cached copy and the real one drift
// apart and nobody notices. That is avoided here by not having an
// invalidation step at all.
//
// The cache key contains a fingerprint of the fields the receipt renders: its
// number, the amount, the donor's name, their address, the date. Correct any
// of them and the fingerprint changes, so the next request asks for a
// DIFFERENT object, misses, and fetches a fresh PDF. The old object is not
// invalidated; it is simply never requested again. There is no step to forget.
//
// This also means the cache NOTICES a change rather than hiding one. If a site
// quietly reissues a receipt with a new number, the fingerprint moves and the
// new PDF is fetched - where a time-based cache would have served the old one
// until it expired.
//
// One more guard: nothing is cached for a donation without a receipt number.
// A receipt that has not settled yet is exactly the thing that will change.

import crypto from 'crypto';
import pool from '../db/pool';
import { fetchReceiptPdf, type SiteKey } from './hkmvClient';
import * as storage from './storage';

export interface ReceiptSource {
  site: SiteKey;
  externalDonationId: string;
  receiptNumber?: string | null;
  amount?: number | string | null;
  donorName?: string | null;
  address?: string | null;
  issuedAt?: string | Date | null;
}

/**
 * A fingerprint of everything printed on the receipt.
 *
 * Deliberately over-inclusive. A field that does not appear on the PDF costs
 * an occasional needless refetch; a field that DOES appear and is left out
 * means serving a receipt with a donor's old address on it, and one of those
 * mistakes is very much worse than the other.
 */
export function receiptFingerprint(src: ReceiptSource): string {
  // Whitespace and case are collapsed on the free-text fields, so "MYAKALA
  // SRIKANTH" and "Myakala  Srikanth" do not each get their own cached copy of
  // an identical receipt. Only differences a reader would SEE should move the
  // key - being over-sensitive merely wastes a refetch, but it wastes one on
  // every download, which is the whole point of the cache.
  const flat = (v: string | null | undefined) =>
    (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

  const parts = [
    flat(src.receiptNumber),
    String(src.amount ?? ''),
    flat(src.donorName),
    flat(src.address),
    src.issuedAt ? new Date(src.issuedAt).toISOString().slice(0, 10) : '',
  ];
  return crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

export interface ReceiptResult {
  buffer: Buffer;
  /** Where it came from, so the screen can be honest about it. */
  from: 'cache' | 'site';
  receiptNumber: string | null;
}

/**
 * Get a receipt PDF, from the cache when it is certainly the right one.
 *
 * `force` skips the cache read - the button for the rare case where somebody
 * believes the site has changed something DRM cannot see. It still writes the
 * fresh copy back.
 */
export async function getReceipt(src: ReceiptSource, force = false): Promise<ReceiptResult> {
  // No receipt number means nothing has settled yet, and an unsettled receipt
  // is precisely the thing that will change. Fetch, serve, cache nothing.
  const cacheable = storage.isConfigured() && !!src.receiptNumber;
  const fingerprint = receiptFingerprint(src);
  const key = storage.keys.receipt(src.site, src.externalDonationId, fingerprint);

  if (cacheable && !force) {
    const hit = await storage.getObject(key);
    if (hit) {
      // Best-effort bookkeeping. A failure to count a read must never fail
      // the read itself.
      void pool
        .query(
          `UPDATE receipt_cache SET last_served_at = NOW(), serve_count = serve_count + 1
            WHERE site = $1 AND external_donation_id = $2 AND fingerprint = $3`,
          [src.site, src.externalDonationId, fingerprint]
        )
        .catch(() => undefined);
      return { buffer: hit, from: 'cache', receiptNumber: src.receiptNumber ?? null };
    }
  }

  const res = await fetchReceiptPdf(src.site, src.externalDonationId);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(
      body.slice(0, 200) || `The site returned ${res.status} for that receipt.`
    ) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  const buffer = Buffer.from(await res.arrayBuffer());

  if (cacheable) {
    // Fire and forget. The donor's download has already succeeded by now, and
    // a bucket problem must not turn it into an error.
    void (async () => {
      const put = await storage.putObject(key, buffer, 'application/pdf');
      if (!put.ok) return;
      await pool
        .query(
          `INSERT INTO receipt_cache (site, external_donation_id, fingerprint, storage_key, receipt_number, bytes)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (site, external_donation_id, fingerprint) DO UPDATE SET
             storage_key = EXCLUDED.storage_key, bytes = EXCLUDED.bytes, fetched_at = NOW()`,
          [src.site, src.externalDonationId, fingerprint, key, src.receiptNumber ?? null, buffer.length]
        )
        .catch((e) => console.error('receipts.cacheRecord error:', e.message));
    })();
  }

  return { buffer, from: 'site', receiptNumber: src.receiptNumber ?? null };
}

/**
 * What DRM knows about a donation, in the shape the fingerprint wants.
 *
 * The address is taken from the donor record rather than the donation, because
 * that is the only address DRM holds - and it is why the fingerprint matters:
 * if a donor corrects their address here, the fingerprint moves and DRM stops
 * serving the copy it had. Whether the SITE then prints the new address is the
 * site's business; what this guarantees is that DRM never serves a PDF it has
 * reason to believe is out of date.
 */
export async function receiptSourceForDonation(donationId: string): Promise<ReceiptSource | null> {
  const r = await pool.query(
    `SELECT d.external_ref, d.source_site, d.receipt_number, d.amount, d.receipt_issued_at, d.created_at,
            p.name,
            COALESCE(
              NULLIF(concat_ws(', ',
                NULLIF(p.address_door,''), NULLIF(p.address_house,''), NULLIF(p.address_street,''),
                NULLIF(p.address_area,''), NULLIF(p.address_city,''), NULLIF(p.address_state,''),
                NULLIF(p.address_pincode,'')), ''),
              p.address
            ) AS address
       FROM donations d
       JOIN people p ON d.person_id = p.id
      WHERE d.id = $1`,
    [donationId]
  );
  if (!r.rows.length || !r.rows[0].external_ref) return null;
  const d = r.rows[0];
  return {
    site: (d.source_site === 'annadan' ? 'annadan' : 'hkmv') as SiteKey,
    externalDonationId: String(d.external_ref),
    receiptNumber: d.receipt_number,
    amount: d.amount,
    donorName: d.name,
    address: d.address,
    issuedAt: d.receipt_issued_at ?? d.created_at,
  };
}
