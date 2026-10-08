// Nearly gave, as it happens.
//
// HOW IT WORKED BEFORE
// The Nearly gave screen kept a copy of both sites' unfinished donations and
// refreshed it only when somebody opened the screen and the copy was over half
// an hour old - and the sites only handed over attempts at least an hour old.
// So a payment that failed at 10:00 reached DRM somewhere after 11:00, and
// only if someone happened to look.
//
// HOW IT WORKS NOW
// Every minute DRM asks both sites for the last few hours:
//   - a FAILED payment comes back straight away (the sites return failed ones
//     whatever their age), and the bell rings for it within a minute or two;
//   - a donation still PENDING (or "created" on annadan) comes back once it is
//     5 minutes old. The site sends its WhatsApp reminder at 3 minutes; a donor
//     who still has not paid by 5 is worth a call.
// Each person is announced once. Nobody is announced who has since donated
// (same mobile, or the same name within a day - see gaveSince.ts), is marked
// do-not-call, or was set aside. The full sync behind the screen is unchanged
// and still fills in history.

import pool from '../db/pool';
import { fetchAbandonedPage, isSiteConfigured, type AbandonedDonation, type SiteKey } from './hkmvClient';
import { notify } from './notifications';
import { gaveSinceSql } from './gaveSince';

const SITES: SiteKey[] = ['hkmv', 'annadan'];
const SITE_LABEL: Record<string, string> = { hkmv: 'harekrishnavizag.org', annadan: 'annadan' };
/** A pending donation younger than this may still be paid; it is not news yet. */
export const PENDING_GRACE_MINUTES = 5;
/** Only the recent past rings the bell - a first run must not announce last month. */
const ANNOUNCE_WITHIN_HOURS = 3;

let polling = false;

/** Ask both sites for the last few hours, store what they say, then announce. */
export async function pollNearlyGave(
  /** routes/crm's storeAbandonedAttempt - passed in so this service does not import a route. */
  store: (site: SiteKey, d: AbandonedDonation) => Promise<boolean>
): Promise<{ stored: number; announced: number }> {
  if (polling) return { stored: 0, announced: 0 };
  polling = true;
  let stored = 0;
  try {
    const since = new Date(Date.now() - 6 * 3600_000).toISOString();
    for (const site of SITES) {
      if (!isSiteConfigured(site)) continue;
      try {
        for (let page = 1; page <= 3; page++) {
          const r = await fetchAbandonedPage(site, { page, limit: 200, since, minMinutes: PENDING_GRACE_MINUTES });
          for (const d of r.donations) if (await store(site, d)) stored++;
          if (!r.hasMore) break;
        }
      } catch (e) {
        // A site that is down is tried again in a few minutes.
        console.warn(`[nearly-gave] ${site} not reachable:`, (e as Error).message);
      }
    }
    const announced = await announceNearlyGave();
    return { stored, announced };
  } finally {
    polling = false;
  }
}

/**
 * Raise a notification for each person who has just failed to pay, or left a
 * donation unfinished for 15 minutes. One per person, however many tries.
 */
export async function announceNearlyGave(): Promise<number> {
  const { rows } = await pool.query(
    `WITH fresh AS (
       SELECT a.*
         FROM abandoned_attempts a
        WHERE a.notified_at IS NULL
          AND a.dismissed_at IS NULL
          AND a.attempted_at > NOW() - ($1::int * INTERVAL '1 hour')
          AND (a.status = 'failed' OR a.attempted_at <= NOW() - ($2::int * INTERVAL '1 minute'))
          -- Gave since, on either site: not news, and not somebody to ring.
          AND NOT ${gaveSinceSql('a')}
          AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.phone = a.phone AND l.do_not_call)
     ),
     latest AS (
       SELECT DISTINCT ON (phone) * FROM fresh ORDER BY phone, attempted_at DESC
     )
     SELECT l.*, (SELECT COUNT(*)::int FROM fresh f WHERE f.phone = l.phone) AS tries
       FROM latest l
      ORDER BY l.attempted_at`,
    [ANNOUNCE_WITHIN_HOURS, PENDING_GRACE_MINUTES]
  );

  let n = 0;
  for (const a of rows) {
    const failed = a.status === 'failed';
    const amount = a.amount ? `₹${Number(a.amount).toLocaleString('en-IN')}` : null;
    const when = new Date(a.attempted_at).toLocaleTimeString('en-IN', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'Asia/Kolkata',
    });
    const ok = await notify({
      kind: 'nearly_gave',
      title: `${failed ? 'Payment failed' : 'Did not finish'} · ${a.name || a.phone}${amount ? ` · ${amount}` : ''}`,
      body: [
        `${failed ? 'Failed' : 'Started'} at ${when}`,
        a.tries > 1 ? `tried ${a.tries} times` : null,
        a.purpose,
        SITE_LABEL[a.source_site] ?? a.source_site,
      ]
        .filter(Boolean)
        .join(' · '),
      link: `/calling/pending`,
      phone: a.phone,
      refKey: `ng:${a.id}`,
    });
    if (ok) n++;
    // Every try of theirs in the window is now announced, not just this one.
    await pool.query(
      `UPDATE abandoned_attempts SET notified_at = NOW()
        WHERE phone = $1 AND notified_at IS NULL AND attempted_at <= $2::timestamptz`,
      [a.phone, a.attempted_at]
    );
  }
  return n;
}
