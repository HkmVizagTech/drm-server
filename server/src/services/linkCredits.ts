// Payments through a link a caller sent count for that caller.
//
// WHY THIS EXISTS
// A link used to credit somebody only if an admin had assigned that one link
// to one caller in Calling settings. Everything else - every link a caller
// added or copied for themselves, and every shared link nobody had assigned -
// carried no tracking code, and the money that came through it was credited
// to nobody. Callers watched donors pay through links they had sent and saw
// nothing on their own screen.
//
// NOW, TWO WAYS, MOST CERTAIN FIRST
//   1. Every send from DRM gets its own code (link_sends.token), put on the
//      link as utm_campaign. The donation comes back carrying it, and
//      creditLinkSend() credits the caller who sent it. Exact.
//   2. A donation with no code - one made before this, or the donor typed the
//      address instead of tapping the link - is credited by
//      creditRecentLinkSends() to the caller who sent a link to that donor's
//      number in the 7 days before they paid.
//
// NEVER TWICE
// A credit is one per donation (uq_credit_per_donation), and both ways skip a
// donation that already has one. A donation that is really a QR payment is left
// alone: the QR payment has its own credit. Because this runs before the lead
// conversion credit (routes/crm.ts reconcileConversions), the caller who sent
// the link is credited ahead of whoever the lead happens to be assigned to.

import { randomBytes } from 'crypto';
import type { PoolClient } from 'pg';
import pool from '../db/pool';
import { recordCredit } from './credits';
import { QR_DONATION_MATCH } from './qrDonationDate';

/** How long after a link is sent a payment from that donor still counts for the sender. */
export const LINK_CREDIT_DAYS = 7;

const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

/** "drm-s-" plus ten letters: one send. ("drm-" alone is an admin-assigned link.) */
export function mintSendToken(): string {
  const bytes = randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `drm-s-${out}`;
}

/** Not a QR payment: those are credited through the payment itself. */
const NOT_QR = (d: string) => `NOT EXISTS (
  SELECT 1 FROM qr_payments p
   WHERE p.donation_id = ${d}.id OR ${QR_DONATION_MATCH.replace(/\bd\./g, `${d}.`)})`;

/**
 * 1. A donation that came back with a send code: credit whoever sent it.
 * Returns true when the code was a send code (credited now or already).
 */
export async function creditLinkSend(
  client: PoolClient,
  donation: { donationId: string; personId: string; amount: number | string; occurredAt: Date | string; token: string }
): Promise<boolean> {
  const r = await client.query(
    `SELECT s.user_id, s.link_id, s.lead_id, l.label, ld.name AS lead_name
       FROM link_sends s
       LEFT JOIN crm_links l ON l.id = s.link_id
       LEFT JOIN leads ld ON ld.id = s.lead_id
      WHERE s.token = $1`,
    [donation.token]
  );
  if (!r.rows.length) return false;
  const s = r.rows[0];
  await recordCredit(
    {
      kind: 'link',
      userId: s.user_id,
      amount: donation.amount,
      occurredAt: donation.occurredAt,
      donationId: donation.donationId,
      linkId: s.link_id,
      personId: donation.personId,
      note: `Donation through the link${s.label ? ` "${s.label}"` : ''} sent${s.lead_name ? ` to ${s.lead_name}` : ''}`,
    },
    client
  );
  return true;
}

/**
 * 2. Donations of the last 90 days with no credit yet, from a donor a caller
 * sent a link to in the 7 days before they paid. Returns how many it credited.
 */
export async function creditRecentLinkSends(db: { query: PoolClient['query'] } = pool): Promise<number> {
  const r = await db.query(
    `SELECT DISTINCT ON (d.id)
            d.id AS donation_id, d.amount, d.created_at, d.person_id,
            a.user_id, a.lead_id, ld.name AS lead_name
       FROM donations d
       JOIN people p ON p.id = d.person_id
       JOIN leads ld
         ON ld.person_id = d.person_id
         OR ld.phone = right(regexp_replace(COALESCE(p.phone, ''), '\\D', '', 'g'), 10)
       JOIN lead_activities a
         ON a.lead_id = ld.id AND a.kind = 'whatsapp' AND a.user_id IS NOT NULL
        AND a.to_value LIKE 'http%'
        AND a.occurred_at <= d.created_at
        AND a.occurred_at > d.created_at - INTERVAL '${LINK_CREDIT_DAYS} days'
      WHERE d.created_at > NOW() - INTERVAL '90 days'
        AND COALESCE(d.amount, 0) > 0
        AND NOT EXISTS (SELECT 1 FROM caller_credits c WHERE c.donation_id = d.id AND c.status = 'active')
        AND ${NOT_QR('d')}
      -- The latest send before they paid: the link they acted on.
      ORDER BY d.id, a.occurred_at DESC`
  );
  let n = 0;
  for (const row of r.rows) {
    const done = await recordCredit({
      kind: 'link',
      userId: row.user_id,
      amount: row.amount,
      occurredAt: row.created_at,
      donationId: row.donation_id,
      personId: row.person_id,
      note: `Donated within ${LINK_CREDIT_DAYS} days of being sent a link${row.lead_name ? ` (${row.lead_name})` : ''}`,
    }).catch((e) => {
      console.error('linkCredits.creditRecentLinkSends failed for one donation:', (e as Error).message);
      return null;
    });
    if (done) n++;
  }
  return n;
}

/* ===================================================================== */
/* 3. A caller's own UTM links (My links), shared anywhere.               */
/* ===================================================================== */
//
// A caller saves a link with their own utm_campaign in My links and shares it
// wherever they like - WhatsApp status, a group, Instagram. DRM never sees
// those sends, but the donation comes back carrying the link's UTM values, and
// that is enough: a donation whose utm_campaign (and utm_source / utm_medium,
// where the link sets them) matches exactly ONE caller's own links counts for
// that caller.
//
// A code that a temple link also uses, or two callers both use, credits
// nobody - DRM cannot tell whose it was. routes/crmLinks.ts refuses such a
// code when a link is saved, and gives every own link without one a code of
// its own (radha-gau-seva), so in practice each caller's code is theirs.

/** A link's UTM values, lower-cased, from its URL. */
export function utmOf(url: string): { source: string | null; medium: string | null; campaign: string | null } {
  try {
    const u = new URL(url);
    const v = (k: string) => (u.searchParams.get(k) ?? '').trim().toLowerCase() || null;
    return { source: v('utm_source'), medium: v('utm_medium'), campaign: v('utm_campaign') };
  } catch {
    return { source: null, medium: null, campaign: null };
  }
}

/** The URL with its utm_campaign set (or the URL unchanged if it cannot be read). */
export function withCampaign(url: string, code: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set('utm_campaign', code);
    return u.toString();
  } catch {
    return url;
  }
}

const slug = (s: string, max: number) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');

type Db = { query: PoolClient['query'] };

/**
 * Who else uses this code, if anybody: another caller's link, or a temple
 * link. Null when it is free (or used only by this caller's own links).
 */
export async function codeTakenBy(db: Db, code: string, ownerId: string, exceptLinkId?: string | null): Promise<string | null> {
  const r = await db.query(
    `SELECT l.owner_user_id, u.name
       FROM crm_links l LEFT JOIN users u ON u.id = l.owner_user_id
      WHERE l.utm_campaign = lower($1)
        AND ($3::uuid IS NULL OR l.id <> $3::uuid)
        AND (l.owner_user_id IS NULL OR l.owner_user_id <> $2::uuid)
      LIMIT 1`,
    [code, ownerId, exceptLinkId ?? null]
  );
  if (!r.rows.length) return null;
  return r.rows[0].owner_user_id ? `${r.rows[0].name ?? 'another caller'}'s link` : 'a temple link';
}

/** A code of this caller's own, from their first name and the link's name: "radha-gau-seva". */
export async function personalCode(db: Db, ownerId: string, label: string, exceptLinkId?: string | null): Promise<string> {
  const u = await db.query(`SELECT name FROM users WHERE id = $1`, [ownerId]);
  const first = slug(String(u.rows[0]?.name ?? 'caller').split(/\s+/)[0] ?? 'caller', 16) || 'caller';
  const base = `${first}-${slug(label, 30) || 'link'}`;
  for (let n = 1; n < 100; n++) {
    const code = n === 1 ? base : `${base}-${n}`;
    const used = await db.query(
      `SELECT 1 FROM crm_links WHERE utm_campaign = $1 AND ($2::uuid IS NULL OR id <> $2::uuid) LIMIT 1`,
      [code, exceptLinkId ?? null]
    );
    if (!used.rows.length) return code;
  }
  return `${base}-${randomBytes(3).toString('hex')}`;
}

/** The caller whose own link this donation's UTM matches, if exactly one. */
const OWNER_LINKS = `
  SELECT l.id, l.label, l.owner_user_id, l.created_at
    FROM crm_links l
   WHERE l.utm_campaign = lower(trim($1))
     AND (l.utm_source IS NULL OR l.utm_source = lower(trim(COALESCE($2, ''))))
     AND (l.utm_medium IS NULL OR l.utm_medium = lower(trim(COALESCE($3, ''))))`;

export async function creditUtmLink(
  client: PoolClient,
  donation: {
    donationId: string;
    personId: string;
    amount: number | string;
    occurredAt: Date | string;
    utmCampaign: string | null;
    utmSource?: string | null;
    utmMedium?: string | null;
  }
): Promise<boolean> {
  if (!donation.utmCampaign) return false;
  const r = await client.query(`${OWNER_LINKS} ORDER BY l.created_at`, [
    donation.utmCampaign,
    donation.utmSource ?? null,
    donation.utmMedium ?? null,
  ]);
  const owners = new Set(r.rows.map((x) => x.owner_user_id as string | null));
  if (!r.rows.length || owners.has(null) || owners.size !== 1) return false;
  const link = r.rows[0];
  await recordCredit(
    {
      kind: 'link',
      userId: link.owner_user_id,
      amount: donation.amount,
      occurredAt: donation.occurredAt,
      donationId: donation.donationId,
      linkId: link.id,
      personId: donation.personId,
      note: `Donation through the link "${link.label}" (utm_campaign=${String(donation.utmCampaign).trim().toLowerCase()})`,
    },
    client
  );
  return true;
}

/**
 * Donations of the last year with no credit yet whose UTM matches exactly one
 * caller's own links - including ones that arrived before the link was saved
 * in DRM. Returns how many it credited.
 */
export async function creditUtmLinks(db: Db = pool): Promise<number> {
  const r = await db.query(
    `WITH m AS (
       SELECT d.id AS donation_id, d.amount, d.created_at, d.person_id, lower(trim(d.utm_campaign)) AS code,
              COUNT(DISTINCT l.owner_user_id) AS owners,
              bool_or(l.owner_user_id IS NULL) AS any_temple,
              (array_agg(l.owner_user_id ORDER BY l.created_at))[1] AS owner,
              (array_agg(l.id ORDER BY l.created_at))[1] AS link_id,
              (array_agg(l.label ORDER BY l.created_at))[1] AS label
         FROM donations d
         JOIN crm_links l
           ON l.utm_campaign = lower(trim(d.utm_campaign))
          AND (l.utm_source IS NULL OR l.utm_source = lower(trim(COALESCE(d.utm_source, ''))))
          AND (l.utm_medium IS NULL OR l.utm_medium = lower(trim(COALESCE(d.utm_medium, ''))))
        WHERE d.utm_campaign IS NOT NULL
          AND d.created_at > NOW() - INTERVAL '365 days'
          AND COALESCE(d.amount, 0) > 0
          AND NOT EXISTS (SELECT 1 FROM caller_credits c WHERE c.donation_id = d.id AND c.status = 'active')
          AND ${NOT_QR('d')}
        GROUP BY d.id, d.amount, d.created_at, d.person_id, d.utm_campaign
     )
     SELECT * FROM m WHERE owners = 1 AND NOT any_temple`
  );
  let n = 0;
  for (const row of r.rows) {
    const done = await recordCredit({
      kind: 'link',
      userId: row.owner,
      amount: row.amount,
      occurredAt: row.created_at,
      donationId: row.donation_id,
      linkId: row.link_id,
      personId: row.person_id,
      note: `Donation through the link "${row.label}" (utm_campaign=${row.code})`,
    }).catch((e) => {
      console.error('linkCredits.creditUtmLinks failed for one donation:', (e as Error).message);
      return null;
    });
    if (done) n++;
  }
  return n;
}
