// Web Push: a notification on the phone or laptop from a page that is not open.
//
// The browser hands DRM a subscription (an endpoint at Google's, Mozilla's or Apple's push
// service, plus two keys); DRM signs each message with its VAPID key pair and posts it there.
// Configured by three variables:
//
//   WEB_PUSH_PUBLIC_KEY / WEB_PUSH_PRIVATE_KEY   npx web-push generate-vapid-keys
//   WEB_PUSH_SUBJECT                             mailto: address the push services can contact
//
// With the keys missing nothing is sent and the pages say reminders work only while DRM is open.
// The keys must not change once devotees have subscribed: a new pair orphans every subscription.

import webpush from 'web-push';
import pool from '../db/pool';

export interface PushMessage {
  title: string;
  body: string;
  /** The page to open when the notification is tapped. */
  url: string;
  /** Notifications with the same tag replace each other instead of piling up. */
  tag?: string;
}

interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** ok, or gone (the browser unsubscribed: forget it), or a failure worth only a log line. */
type Result = { ok: true } | { ok: false; gone: boolean; error?: string };
type Sender = (sub: Subscription, message: PushMessage) => Promise<Result>;

let configured: boolean | null = null;

export function pushPublicKey(): string | null {
  return process.env.WEB_PUSH_PUBLIC_KEY?.trim() || null;
}

function ready(): boolean {
  if (configured !== null) return configured;
  const pub = pushPublicKey();
  const priv = process.env.WEB_PUSH_PRIVATE_KEY?.trim();
  if (!pub || !priv) return (configured = false);
  try {
    webpush.setVapidDetails(process.env.WEB_PUSH_SUBJECT?.trim() || 'mailto:admin@harekrishnavizag.org', pub, priv);
    configured = true;
  } catch (e) {
    console.error('[web-push] The VAPID keys are not valid:', (e as Error).message);
    configured = false;
  }
  return configured;
}

const realSender: Sender = async (sub, message) => {
  try {
    // A reminder that arrives a day late is noise, so the push service may drop it after 6 hours.
    await webpush.sendNotification(sub, JSON.stringify(message), { TTL: 6 * 60 * 60, urgency: 'high' });
    return { ok: true };
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode;
    return { ok: false, gone: status === 404 || status === 410, error: (e as Error).message };
  }
};

let sender: Sender | null = null;
/** Tests swap the sender for one that records what would have gone out. Null restores the real one. */
export function setPushSender(s: Sender | null) {
  sender = s;
}

/** Can a reminder be pushed right now? True when keys are set, or a test has supplied a sender. */
export function pushEnabled(): boolean {
  return sender !== null || ready();
}

/** Send to every browser the user has subscribed. Subscriptions the push service has dropped are deleted. */
export async function sendPushToUser(userId: string, message: PushMessage): Promise<{ sent: number; removed: number }> {
  if (!pushEnabled()) return { sent: 0, removed: 0 };
  const send = sender ?? realSender;
  const subs = (
    await pool.query(`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`, [userId])
  ).rows as { id: string; endpoint: string; p256dh: string; auth: string }[];

  let sent = 0;
  let removed = 0;
  for (const s of subs) {
    const r = await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, message);
    if (r.ok) {
      sent++;
      await pool.query(`UPDATE push_subscriptions SET last_used_at = NOW() WHERE id = $1`, [s.id]);
    } else if (r.gone) {
      removed++;
      await pool.query(`DELETE FROM push_subscriptions WHERE id = $1`, [s.id]);
    } else {
      console.error('[web-push] send failed:', r.error);
    }
  }
  return { sent, removed };
}

/** Keep (or refresh) a browser's subscription for a user. An endpoint moves to whoever subscribed it last. */
export async function saveSubscription(userId: string, body: unknown, userAgent?: string): Promise<boolean> {
  const b = (body && typeof body === 'object' ? body : {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof b.endpoint === 'string' ? b.endpoint.trim() : '';
  const p256dh = typeof b.keys?.p256dh === 'string' ? b.keys.p256dh : '';
  const auth = typeof b.keys?.auth === 'string' ? b.keys.auth : '';
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 2000 || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) {
    return false;
  }
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE
       SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent, created_at = NOW()`,
    [userId, endpoint, p256dh, auth, userAgent?.slice(0, 300) ?? null]
  );
  return true;
}

export async function removeSubscription(userId: string, endpoint: unknown): Promise<void> {
  if (typeof endpoint !== 'string' || !endpoint) return;
  await pool.query(`DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`, [userId, endpoint]);
}
