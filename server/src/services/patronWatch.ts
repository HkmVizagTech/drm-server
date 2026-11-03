// Patron requests, as they happen.
//
// Every minute DRM asks the temple site for the last few hours of "Become a
// Patron" submissions, stores them (each becomes a lead - see routes/crmPatron),
// and rings the bell once for each new person. The screen's own full sync still
// fills in history; this is only what makes a request reach a caller within a
// minute or two instead of whenever somebody opens the page.

import pool from '../db/pool';
import { fetchPatronRequestPage, isSiteConfigured, type PatronRequest } from './hkmvClient';
import { notify } from './notifications';

/** Only the recent past rings the bell - a first run must not announce last year. */
const ANNOUNCE_WITHIN_HOURS = 24;

let polling = false;

export async function pollPatronRequests(
  /** routes/crmPatron's storePatronRequest - passed in so this service does not import a route. */
  store: (p: PatronRequest) => Promise<boolean>
): Promise<{ stored: number; announced: number }> {
  if (polling) return { stored: 0, announced: 0 };
  polling = true;
  let stored = 0;
  try {
    if (!isSiteConfigured('hkmv')) return { stored: 0, announced: 0 };
    const since = new Date(Date.now() - 6 * 3600_000).toISOString();
    try {
      for (let page = 1; page <= 3; page++) {
        const r = await fetchPatronRequestPage('hkmv', { page, limit: 200, since });
        for (const p of r.requests) if (await store(p)) stored++;
        if (!r.hasMore) break;
      }
    } catch (e) {
      // A site that is down is tried again in a minute.
      console.warn('[patron] site not reachable:', (e as Error).message);
    }
    return { stored, announced: await announcePatrons() };
  } finally {
    polling = false;
  }
}

/** One bell per request that nobody has been told about, unless it was set aside. */
export async function announcePatrons(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT p.id, p.phone, p.name, p.city, p.state, p.requested_at
       FROM patron_requests p
       LEFT JOIN leads l ON l.id = p.lead_id
      WHERE p.notified_at IS NULL
        AND p.dismissed_at IS NULL
        AND p.requested_at > NOW() - ($1::int * INTERVAL '1 hour')
        AND COALESCE(l.do_not_call, FALSE) = FALSE
      ORDER BY p.requested_at`,
    [ANNOUNCE_WITHIN_HOURS]
  );
  let n = 0;
  for (const p of rows) {
    const place = [p.city, p.state].filter(Boolean).join(', ');
    const ok = await notify({
      kind: 'patron',
      title: `New patron request · ${p.name || p.phone}`,
      body: ['Wants to become a patron', place || null].filter(Boolean).join(' · '),
      link: '/calling/patrons',
      phone: p.phone,
      refKey: `pt:${p.id}`,
    });
    if (ok) n++;
    await pool.query(`UPDATE patron_requests SET notified_at = NOW() WHERE id = $1`, [p.id]);
  }
  return n;
}
