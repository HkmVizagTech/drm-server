// Keeps DRM's recurring donations in step with the sites.
//
// A subscription row in DRM only changed when its donor happened to be synced, so statuses went stale
// (a payer shown as cancelled, a lapsed one still active). This asks each site, donor by donor, for
// the subscriptions DRM already knows - a few dozen donors, not the whole list - and writes back what
// the site says: status, last charge and charge count (the same upsert every other sync uses).
//
// Runs once a day and shortly after the server starts, and on demand from the Recurring screen.
// It only READS from the sites; it never raises or changes anything there.

import pool from '../db/pool';
import { fetchDonorSnapshot, isSiteConfigured, type HkmvDonorSnapshot, type SiteKey } from './hkmvClient';
import { upsertDonorSnapshot } from './hkmvSync';

export type SnapshotFetcher = (site: SiteKey, phone: string) => Promise<HkmvDonorSnapshot>;

let running = false;

export async function refreshSubscriptions(
  fetcher: SnapshotFetcher = fetchDonorSnapshot
): Promise<{ checked: number; updated: number; failed: number; skipped: boolean }> {
  if (running) return { checked: 0, updated: 0, failed: 0, skipped: true };
  running = true;
  const out = { checked: 0, updated: 0, failed: 0, skipped: false };
  try {
    // Donors with a subscription a site told us about, that is not already finished.
    const donors = await pool.query(
      `SELECT DISTINCT p.phone, s.source_site
         FROM subscriptions s JOIN people p ON p.id = s.person_id
        WHERE s.external_ref IS NOT NULL AND s.source_site IN ('hkmv', 'annadan')
          AND (s.status IN ('active', 'paused') OR s.site_status IS NULL OR s.updated_at > NOW() - INTERVAL '60 days')`
    );
    for (const d of donors.rows as { phone: string; source_site: SiteKey }[]) {
      if (!isSiteConfigured(d.source_site)) continue;
      out.checked++;
      try {
        const snap = await fetcher(d.source_site, String(d.phone));
        if (snap?.found) {
          await upsertDonorSnapshot(snap as never, d.source_site);
          out.updated++;
        }
      } catch (e) {
        out.failed++;
        console.error(`[subscriptions] refresh failed for a donor on ${d.source_site}:`, (e as Error).message);
      }
      await new Promise((r) => setTimeout(r, 150)); // gently: it is the sites' live servers
    }
    console.log(`[subscriptions] refreshed: ${out.checked} donors, ${out.updated} updated, ${out.failed} failed`);
    return out;
  } finally {
    running = false;
  }
}
