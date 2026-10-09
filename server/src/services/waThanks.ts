// WhatsApp thank-you after a campaign donation - first for Mahalaya Amavasya:
// everybody who donates on harekrishnavizag.org/pitru-paksha that day gets the
// approved "special prayers were offered today" message about two hours later.
//
// WHY IT RUNS IN DRM
// DRM already holds every completed donation from the site within seconds,
// so it can decide who to thank and when without asking the site anything.
// The site does no extra work at all on a busy campaign day.
//
// WHICH SEVA
// The page offers several sevas - Annadana, Sadhu Bhojan, Gau Seva, Brick,
// Square Foot. Each is listed in the settings with its own words for {{2}}
// and its own on/off, so a Gau Seva donor is thanked for Gau Seva (or not at
// all), never for Annadana. A seva that is not on the list is not sent, and
// the screen says so.
//
// HOW IT WORKS
// Every two minutes, while switched on in DRM (WhatsApp thanks):
//   1. Queue: each campaign donation of the day, once per mobile number. Its
//      send time is two hours after the donation - but the message says the
//      prayers were offered "today", so it must arrive the same evening:
//        due before the last send time (21:30)  -> two hours after
//        otherwise                              -> at 21:30, or 15 minutes
//                                                  after the donation if later
//        that would be after the stop time (22:00) -> not sent, marked skipped
//   2. Send: whatever is due, one at a time, through Gupshup - the same API and
//      sender number the site uses for receipts.
// Nothing is sent after the stop time, and nothing outside the campaign day.
//
// SETTINGS live in crm_settings (key wa_thanks) so the template id and image
// can be pasted in on the day without a deploy. The Gupshup key, app name and
// sender number come from the server's environment, as on the site.

import pool from '../db/pool';
import { APP_TIMEZONE } from '../bootTimezone';

export interface ThanksSettings {
  enabled: boolean;
  /** The page, as the site records it, e.g. "/pitru-paksha". */
  page: string;
  /** The campaign day, YYYY-MM-DD, India time. */
  day: string;
  delay_minutes: number;
  /** HH:MM - no send is booked later than this unless the donation came later. */
  last_send: string;
  /** HH:MM - nothing at all goes out after this. */
  stop_at: string;
  /** Gupshup's template id (the long uuid, not the Facebook number). */
  template_id: string;
  /** A public JPG or PNG link for the template's image header. Empty: no header. */
  header_image: string;
  /** Per seva on the page: whether it is thanked, and what fills {{2}}. */
  sevas: SevaChoice[];
}

export interface SevaChoice {
  /** The seva as the page names it - what DRM holds for the donation. */
  name: string;
  /** What fills {{2}} for a donation to this seva. */
  text: string;
  on: boolean;
}

export const DEFAULT_THANKS: ThanksSettings = {
  enabled: false,
  page: '/pitru-paksha',
  day: '2026-10-10',
  delay_minutes: 120,
  last_send: '21:30',
  stop_at: '22:00',
  template_id: '',
  header_image: '',
  // The five sevas on harekrishnavizag.org/pitru-paksha, by their names there.
  sevas: [
    { name: 'Annadana Seva', text: 'Pitru paksha Annadan seva', on: true },
    { name: 'Sadhu Bhojan Seva', text: 'Pitru paksha Sadhu Bhojan seva', on: true },
    { name: 'Gau Seva', text: 'Pitru paksha Gau seva', on: true },
    { name: 'Brick Seva', text: 'Pitru paksha Brick seva', on: true },
    { name: 'Square Foot Seva', text: 'Pitru paksha Square Foot seva', on: true },
  ],
};

const KEY = 'wa_thanks';

export async function readThanksSettings(): Promise<ThanksSettings> {
  const r = await pool.query(`SELECT value FROM crm_settings WHERE key = $1`, [KEY]);
  const stored = (r.rows[0]?.value ?? {}) as Partial<ThanksSettings> & { seva_text?: string };
  const out = { ...DEFAULT_THANKS, ...stored };
  // Saved before sevas were separate: one wording for everyone.
  if (!Array.isArray(stored.sevas)) out.sevas = DEFAULT_THANKS.sevas.map((x) => ({ ...x }));
  delete (out as { seva_text?: string }).seva_text;
  return out;
}

/** Checked and tidied - anything odd is refused rather than half-applied. */
export function cleanThanksSettings(input: Record<string, unknown>, current: ThanksSettings): ThanksSettings | string {
  const next = { ...current };
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if ('enabled' in input) next.enabled = input.enabled === true;
  if ('page' in input) {
    const p = String(input.page ?? '').trim().toLowerCase()
      .replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
    if (!/^\/?[a-z0-9][a-z0-9/_-]*$/.test(p)) return 'Enter the page, e.g. /pitru-paksha';
    next.page = p.startsWith('/') ? p : `/${p}`;
  }
  if ('day' in input) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.day))) return 'Pick the campaign day.';
    next.day = String(input.day);
  }
  if ('delay_minutes' in input) {
    const n = Math.round(Number(input.delay_minutes));
    if (!Number.isFinite(n) || n < 0 || n > 600) return 'The gap must be between 0 and 600 minutes.';
    next.delay_minutes = n;
  }
  for (const k of ['last_send', 'stop_at'] as const) {
    if (k in input) {
      if (!time.test(String(input[k]))) return 'Times are HH:MM, e.g. 21:30';
      next[k] = String(input[k]);
    }
  }
  if (next.stop_at < next.last_send) return 'The stop time must be after the last send time.';
  if ('template_id' in input) {
    const t = String(input.template_id ?? '').trim();
    if (t && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) {
      return 'The template id is the long Gupshup id, like f12a709c-bc1f-429b-84d5-1262bc01a73c.';
    }
    next.template_id = t;
  }
  if ('header_image' in input) {
    const u = String(input.header_image ?? '').trim();
    if (u && !/^https:\/\/\S+$/i.test(u)) return 'The image must be an https:// link.';
    if (u && /\.webp(\?|$)/i.test(u)) return 'WhatsApp only takes JPG or PNG images, not .webp.';
    next.header_image = u;
  }
  if ('sevas' in input) {
    if (!Array.isArray(input.sevas)) return 'The seva list is not valid.';
    const list: SevaChoice[] = [];
    const seen = new Set<string>();
    for (const raw of input.sevas as Record<string, unknown>[]) {
      const name = String(raw?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const text = String(raw?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!name) return 'Every seva needs its name, as the page shows it.';
      if (!text) return `Enter the words for {{2}} for ${name}.`;
      if (seen.has(name.toLowerCase())) return `${name} is listed twice.`;
      seen.add(name.toLowerCase());
      list.push({ name, text, on: raw?.on !== false });
    }
    next.sevas = list;
  }
  if (next.enabled && !next.template_id) return 'Add the Gupshup template id before switching it on.';
  if (next.enabled && !next.sevas.some((x) => x.on)) return 'Pick at least one seva to thank.';
  return next;
}

export async function saveThanksSettings(s: ThanksSettings, userId: string | null) {
  await pool.query(
    `INSERT INTO crm_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [KEY, JSON.stringify(s), userId]
  );
}

/** One campaign per page and day, so a later campaign starts with a clean slate. */
export const campaignKey = (s: ThanksSettings) => `${s.page}@${s.day}`.slice(0, 80);

/** The page as the site may have spelled it: "pitru-paksha", "/pitru-paksha", a full URL, or with a query. */
export function pagePattern(page: string): string {
  const slug = page.replace(/^\//, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^(https?://[^/]+)?/?${slug}(/|\\?|#|$)`;
}

export function gupshupConfigured(): boolean {
  return Boolean(process.env.GUPSHUP_API_KEY && process.env.GUPSHUP_APP_NAME && process.env.GUPSHUP_SOURCE_NUMBER);
}

/**
 * Queue the day's campaign donations that are not queued yet. Returns how many
 * were added. One per mobile number: somebody who donates twice is thanked once,
 * for the first donation.
 */
export async function queueThanks(s: ThanksSettings): Promise<number> {
  // seva name (lower case) -> the words for {{2}}, for the sevas switched on.
  const words = Object.fromEntries(s.sevas.filter((x) => x.on).map((x) => [x.name.toLowerCase(), x.text]));
  const r = await pool.query(
    `WITH times AS (
       SELECT ($3::date + $5::time) AT TIME ZONE '${APP_TIMEZONE}' AS last_send,
              ($3::date + $6::time) AT TIME ZONE '${APP_TIMEZONE}' AS stop_at
     ),
     found AS (
       SELECT d.id AS donation_id, p.id AS person_id,
              right(regexp_replace(p.phone, '\\D', '', 'g'), 10) AS phone,
              COALESCE(NULLIF(btrim(d.given_name), ''), p.name) AS name,
              d.amount, d.created_at,
              -- The seva as the page named it: occasion holds it in full,
              -- purpose cut to 30 characters for older rows.
              COALESCE(NULLIF(btrim(d.occasion), ''), d.purpose) AS seva
         FROM donations d JOIN people p ON p.id = d.person_id
        WHERE d.source_site = 'hkmv'
          AND COALESCE(d.source_page, '') ~* $2
          AND (d.created_at AT TIME ZONE '${APP_TIMEZONE}')::date = $3::date
          AND right(regexp_replace(COALESCE(p.phone, ''), '\\D', '', 'g'), 10) ~ '^[6-9][0-9]{9}$'
     ),
     worded AS (
       SELECT f.*, $7::jsonb ->> lower(btrim(f.seva)) AS seva_text FROM found f
     ),
     -- One per person: their first donation to a seva being thanked, else
     -- their first donation (recorded as not sent, with the reason).
     one AS (
       SELECT DISTINCT ON (phone) * FROM worded
        ORDER BY phone, (seva_text IS NULL), created_at
     ),
     timed AS (
       SELECT o.*,
              CASE
                WHEN o.seva_text IS NULL THEN NULL
                WHEN o.created_at + ($4::int * INTERVAL '1 minute') <= t.last_send
                  THEN o.created_at + ($4::int * INTERVAL '1 minute')
                WHEN GREATEST(t.last_send, o.created_at + INTERVAL '15 minutes') <= t.stop_at
                  THEN GREATEST(t.last_send, o.created_at + INTERVAL '15 minutes')
              END AS send_at
         FROM one o CROSS JOIN times t
     )
     INSERT INTO wa_thanks_sends (campaign, donation_id, person_id, phone, name, amount, donated_at, seva, seva_text, send_at, status, error)
     SELECT $1, donation_id, person_id, phone, name, amount, created_at, left(seva, 120), seva_text, send_at,
            CASE WHEN send_at IS NULL THEN 'skipped' ELSE 'waiting' END,
            CASE WHEN seva_text IS NULL THEN 'Seva not on the list: ' || COALESCE(seva, 'none recorded')
                 WHEN send_at IS NULL THEN 'Donated too late in the day for the message' END
       FROM timed
     ON CONFLICT (campaign, phone) DO UPDATE SET
       -- Somebody first seen on a seva not being thanked who then gives to
       -- one that is: thank them for that one, unless already done.
       donation_id = EXCLUDED.donation_id, seva = EXCLUDED.seva, seva_text = EXCLUDED.seva_text,
       amount = EXCLUDED.amount, donated_at = EXCLUDED.donated_at, send_at = EXCLUDED.send_at,
       status = EXCLUDED.status, error = EXCLUDED.error
     WHERE wa_thanks_sends.seva_text IS NULL AND wa_thanks_sends.status = 'skipped' AND EXCLUDED.seva_text IS NOT NULL`,
    [campaignKey(s), pagePattern(s.page), s.day, s.delay_minutes, s.last_send, s.stop_at, JSON.stringify(words)]
  );
  return r.rowCount ?? 0;
}

/** First name for the greeting would guess wrong too often; the name as given, tidied. */
export function greetingName(name: string | null): string {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!n) return 'Devotee';
  // ALL CAPS reads as shouting in a greeting.
  return n === n.toUpperCase() ? n.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase()) : n;
}

export interface GupshupResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/** Send the approved template through Gupshup. Never throws. */
export async function sendThanks(
  s: ThanksSettings,
  phone10: string,
  name: string | null,
  /** What fills {{2}} - the words for the seva they donated to. */
  sevaText: string,
  fetcher: typeof fetch = fetch
): Promise<GupshupResult> {
  if (!gupshupConfigured()) return { ok: false, error: 'Gupshup is not set up on the DRM server (GUPSHUP_API_KEY, GUPSHUP_APP_NAME, GUPSHUP_SOURCE_NUMBER).' };
  if (!s.template_id) return { ok: false, error: 'No template id.' };
  const form = new URLSearchParams();
  form.set('channel', 'whatsapp');
  form.set('source', String(process.env.GUPSHUP_SOURCE_NUMBER).replace(/\D/g, ''));
  form.set('destination', `91${phone10}`);
  form.set('src.name', String(process.env.GUPSHUP_APP_NAME));
  // params are positional: {{1}} the name, {{2}} the seva. The image header is
  // not a param - it goes in `message`, as Gupshup requires.
  form.set('template', JSON.stringify({ id: s.template_id, params: [greetingName(name), sevaText] }));
  if (s.header_image) form.set('message', JSON.stringify({ type: 'image', image: { link: s.header_image } }));
  try {
    const res = await fetcher('https://api.gupshup.io/wa/api/v1/template/msg', {
      method: 'POST',
      headers: { apikey: String(process.env.GUPSHUP_API_KEY), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON - reported below */
    }
    // Success is {"status":"submitted","messageId":"..."}; anything else failed.
    if (res.ok && body.status === 'submitted' && body.messageId) return { ok: true, messageId: String(body.messageId) };
    const why = (body.message as string) || (body.reason as string) || text.slice(0, 300) || `HTTP ${res.status}`;
    return { ok: false, error: `Gupshup: ${why}` };
  } catch (e) {
    return { ok: false, error: `Could not reach Gupshup: ${(e as Error).message}` };
  }
}

let running = false;

/** One pass: queue new donations, then send what is due. */
export async function thanksTick(fetcher: typeof fetch = fetch): Promise<{ queued: number; sent: number; failed: number; skipped: number }> {
  const out = { queued: 0, sent: 0, failed: 0, skipped: 0 };
  if (running) return out;
  running = true;
  try {
    const s = await readThanksSettings();
    if (!s.enabled || !s.template_id) return out;
    out.queued = await queueThanks(s);
    const key = campaignKey(s);
    // A send cut off half way (a restart mid-pass) goes back in the queue.
    await pool.query(
      `UPDATE wa_thanks_sends SET status = 'waiting'
        WHERE campaign = $1 AND status = 'sending' AND send_at < NOW() - INTERVAL '10 minutes'`,
      [key]
    );

    // Past the stop time: whatever is still waiting will not go out today.
    const late = await pool.query(
      `UPDATE wa_thanks_sends SET status = 'skipped', error = 'Not sent before the stop time'
        WHERE campaign = $1 AND status = 'waiting'
          AND NOW() > ($2::date + $3::time) AT TIME ZONE '${APP_TIMEZONE}'`,
      [key, s.day, s.stop_at]
    );
    out.skipped = late.rowCount ?? 0;
    if (!gupshupConfigured()) return out;

    // Claimed before sending, so two DRM instances cannot send the same one.
    const due = await pool.query(
      `UPDATE wa_thanks_sends SET status = 'sending', attempts = attempts + 1
        WHERE id IN (SELECT id FROM wa_thanks_sends
                      WHERE campaign = $1 AND status = 'waiting' AND send_at <= NOW()
                      ORDER BY send_at LIMIT 60 FOR UPDATE SKIP LOCKED)
        RETURNING id, phone, name, seva_text`,
      [key]
    );
    for (const row of due.rows) {
      const r = await sendThanks(s, row.phone, row.name, row.seva_text, fetcher);
      if (r.ok) {
        out.sent++;
        await pool.query(
          `UPDATE wa_thanks_sends SET status = 'sent', sent_at = NOW(), message_id = $2, error = NULL WHERE id = $1`,
          [row.id, r.messageId]
        );
      } else {
        out.failed++;
        await pool.query(`UPDATE wa_thanks_sends SET status = 'failed', error = $2 WHERE id = $1`, [row.id, r.error?.slice(0, 500)]);
      }
      // About one a second - a burst of hundreds is how a number gets flagged.
      await new Promise((ok) => setTimeout(ok, 1000));
    }
    return out;
  } finally {
    running = false;
  }
}
