// WhatsApp chat: callers and admins talk to donors from DRM.
//
// THE PIECES
//   provider   - how a message actually leaves (Flaxxa today; Gupshup can be added behind the same shape)
//   ingest     - turns the provider's webhook (Meta format) into conversations, messages and ticks
//   send       - the rules for sending: the 24-hour window, opt-out, size and type limits, no double sends
//   media      - pictures and files, kept by DRM (R2 when set up, otherwise the database), never hot-linked
//
// THE RULES THAT SHAPE EVERYTHING
//   1. WhatsApp lets a business send free-form text and media only within 24 hours of the donor's last
//      message to us. After that only an approved TEMPLATE may start the conversation again.
//   2. A donor who writes STOP is not messaged again by DRM until they write START.
//   3. The provider says "success" when it accepted a message, not when it was delivered, and its
//      webhook can arrive twice, late, or out of order. So a tick never goes backwards, a repeated
//      message id is stored once, and a message is failed only while it has not been delivered.

import { createHash, randomUUID } from 'crypto';
import pool from '../db/pool';
import * as storage from './storage';
import { publish } from './waEvents';

/* ------------------------------------------------------------------ phones */

/** One key per person: 10 digits for an Indian number (as people.phone), the full digits otherwise. */
export function phoneKey(raw: unknown): string {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10) return d;
  if (d.length === 12 && d.startsWith('91')) return d.slice(2);
  if (d.length === 11 && d.startsWith('0')) return d.slice(1);
  return d;
}

/** Can WhatsApp deliver to this key? An Indian mobile, or an international number of a sane length. */
export function isValidKey(key: string): boolean {
  if (/^[6-9]\d{9}$/.test(key)) return true;
  return key.length >= 11 && key.length <= 15 && !key.startsWith('0');
}

/** The number as the provider wants it: country code first, digits only. */
export const toWaNumber = (key: string): string => (key.length === 10 ? `91${key}` : key);

/* ------------------------------------------------------------------ limits */

export const WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_TEXT = 4096;
/** Raw bytes. An upload travels as base64 inside JSON (25 MB limit), which is a third bigger. */
export const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
const MAX_INBOUND_BYTES = 25 * 1024 * 1024;

type MediaKind = 'image' | 'video' | 'audio' | 'document';
const MEDIA_RULES: { kind: MediaKind; mimes: string[]; max: number }[] = [
  { kind: 'image', mimes: ['image/jpeg', 'image/png'], max: 5 * 1024 * 1024 },
  { kind: 'video', mimes: ['video/mp4', 'video/3gpp'], max: 15 * 1024 * 1024 },
  { kind: 'audio', mimes: ['audio/mpeg', 'audio/ogg', 'audio/aac', 'audio/mp4', 'audio/amr'], max: 15 * 1024 * 1024 },
  {
    kind: 'document',
    mimes: [
      'application/pdf',
      'text/plain',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
    max: 15 * 1024 * 1024,
  },
];

/** What the bytes really are, for the types we can recognise; the client's claim is not trusted for them. */
export function sniffMime(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.slice(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (b.slice(4, 8).toString('latin1') === 'ftyp') return 'video/mp4';
  if (b.slice(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
  if (b.slice(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export type MediaCheck =
  | { ok: true; kind: MediaKind; mime: string; filename: string }
  | { ok: false; error: string };

/** Is this file something WhatsApp will carry, within its size limit? */
export function checkOutboundMedia(bytes: Buffer, claimedMime: string, filename: string): MediaCheck {
  if (!bytes.length) return { ok: false, error: 'The file is empty.' };
  const sniffed = sniffMime(bytes);
  if (sniffed === 'image/webp') return { ok: false, error: 'WhatsApp does not accept WebP pictures here. Send a JPG or PNG.' };
  const claimed = String(claimedMime || '').toLowerCase().split(';')[0].trim();
  // A recognised type decides; for office documents and text the declared type has to be on the list.
  const mime = sniffed ?? claimed;
  const rule = MEDIA_RULES.find((r) => r.mimes.includes(mime));
  if (!rule) {
    return { ok: false, error: 'This kind of file cannot be sent on WhatsApp. Use a JPG or PNG picture, MP4 video, MP3/OGG audio, or a PDF/Word/Excel document.' };
  }
  if (sniffed && claimed && claimed !== sniffed && !(rule.kind === 'audio' && claimed.startsWith('audio/'))) {
    // e.g. a PDF renamed .jpg: go by the bytes, but never let a video pass as a picture, or the reverse.
    const claimedRule = MEDIA_RULES.find((r) => r.mimes.includes(claimed));
    if (claimedRule && claimedRule.kind !== rule.kind) return { ok: false, error: 'The file does not match its type.' };
  }
  if (bytes.length > rule.max) {
    return { ok: false, error: `That ${rule.kind} is too large. WhatsApp allows up to ${Math.round(rule.max / 1048576)} MB for ${rule.kind === 'image' ? 'pictures' : rule.kind + 's'}.` };
  }
  const clean = storage.safeName(filename || `${rule.kind}`);
  return { ok: true, kind: rule.kind, mime, filename: clean };
}

/* ---------------------------------------------------------------- provider */

export type SendResult =
  | { ok: true; providerMsgId: string | null; wamid: string | null }
  | { ok: false; reason: 'not_configured' | 'rejected' | 'failed'; detail: string };

export interface TemplateInfo {
  name: string;
  language: string;
  body: string;
  paramCount: number;
  /** The picture/video/document the template carries in its header, or null for a text-only template. */
  header: 'IMAGE' | 'VIDEO' | 'DOCUMENT' | null;
}

export interface WaProvider {
  name: string;
  configured(): boolean;
  sendText(to: string, text: string): Promise<SendResult>;
  sendMedia(to: string, file: { bytes: Buffer; mime: string; filename: string; kind: MediaKind }, caption: string): Promise<SendResult>;
  sendTemplate(to: string, name: string, language: string, params: string[]): Promise<SendResult>;
  /** A template whose header is a picture/video/document, sent with that file. */
  sendTemplateWithMedia(to: string, name: string, language: string, params: string[], file: { bytes: Buffer; mime: string; filename: string }): Promise<SendResult>;
  listTemplates(): Promise<TemplateInfo[]>;
  /** An error the provider recorded after accepting the message, or null if none (yet). */
  messageError(providerMsgId: string): Promise<string | null>;
}

const FLAXXA = 'https://wapi.flaxxa.com/api/v1';

function flaxxaResult(res: Response, body: Record<string, unknown>): SendResult {
  if (body.status === 'success' && (body.message_id || body.message_wamid)) {
    return {
      ok: true,
      providerMsgId: body.message_id != null ? String(body.message_id) : null,
      wamid: body.message_wamid ? String(body.message_wamid) : null,
    };
  }
  return { ok: false, reason: 'rejected', detail: String(body.message ?? body.msg ?? `HTTP ${res.status}`).slice(0, 200) };
}

export const flaxxaProvider: WaProvider = {
  name: 'flaxxa',
  configured: () => !!process.env.FLAXXA_TOKEN,

  async sendText(to, text) {
    const token = process.env.FLAXXA_TOKEN;
    if (!token) return { ok: false, reason: 'not_configured', detail: 'FLAXXA_TOKEN is not set' };
    try {
      const res = await fetch(`${FLAXXA}/sendmessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, phone: to, message: text }),
        signal: AbortSignal.timeout(20000),
      });
      return flaxxaResult(res, (await res.json().catch(() => ({}))) as Record<string, unknown>);
    } catch (e) {
      return { ok: false, reason: 'failed', detail: (e as Error).message };
    }
  },

  async sendMedia(to, file, caption) {
    const token = process.env.FLAXXA_TOKEN;
    if (!token) return { ok: false, reason: 'not_configured', detail: 'FLAXXA_TOKEN is not set' };
    try {
      const form = new FormData();
      form.append('token', token);
      form.append('phone', to);
      if (caption) form.append('message', caption);
      // The field Flaxxa reads the file from. Set FLAXXA_MEDIA_FIELD if their account uses another name.
      form.append(process.env.FLAXXA_MEDIA_FIELD || 'attachment', new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.filename);
      const res = await fetch(`${FLAXXA}/sendmessagewithattachment`, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
      return flaxxaResult(res, (await res.json().catch(() => ({}))) as Record<string, unknown>);
    } catch (e) {
      return { ok: false, reason: 'failed', detail: (e as Error).message };
    }
  },

  async sendTemplate(to, name, language, params) {
    const token = process.env.FLAXXA_TOKEN;
    if (!token) return { ok: false, reason: 'not_configured', detail: 'FLAXXA_TOKEN is not set' };
    try {
      const res = await fetch(`${FLAXXA}/sendtemplatemessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          phone: to,
          template_name: name,
          template_language: language || 'en',
          components: params.length ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] : [],
        }),
        signal: AbortSignal.timeout(20000),
      });
      return flaxxaResult(res, (await res.json().catch(() => ({}))) as Record<string, unknown>);
    } catch (e) {
      return { ok: false, reason: 'failed', detail: (e as Error).message };
    }
  },

  async sendTemplateWithMedia(to, name, language, params, file) {
    const token = process.env.FLAXXA_TOKEN;
    if (!token) return { ok: false, reason: 'not_configured', detail: 'FLAXXA_TOKEN is not set' };
    try {
      const form = new FormData();
      form.append('token', token);
      form.append('phone', to);
      form.append('template_name', name);
      form.append('template_language', language || 'en');
      form.append('components', JSON.stringify(params.length ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] : []));
      form.append('header_attachment', new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.filename);
      const res = await fetch(`${FLAXXA}/sendtemplatemessage_withattachment`, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      // This endpoint answers with the WhatsApp id when it accepted the message (as the brick message relies on).
      if (body.message_wamid || body.wamid || (body.status === 'success' && body.message_id)) {
        return { ok: true, providerMsgId: body.message_id != null ? String(body.message_id) : null, wamid: String(body.message_wamid ?? body.wamid ?? '') || null };
      }
      return { ok: false, reason: 'rejected', detail: String(body.message ?? body.msg ?? `HTTP ${res.status}`).slice(0, 200) };
    } catch (e) {
      return { ok: false, reason: 'failed', detail: (e as Error).message };
    }
  },

  async listTemplates() {
    const token = process.env.FLAXXA_TOKEN;
    if (!token) return [];
    const res = await fetch(`${FLAXXA}/getTemplates?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(20000) });
    const data = (await res.json().catch(() => ({}))) as { templates?: Array<Record<string, unknown>> };
    const out: TemplateInfo[] = [];
    for (const t of data.templates ?? []) {
      if (String(t.status ?? '').toUpperCase() !== 'APPROVED') continue;
      let comps: Array<{ type?: string; format?: string; text?: string }> = [];
      try {
        comps = typeof t.components === 'string' ? JSON.parse(t.components) : ((t.components as never) ?? []);
      } catch {
        comps = [];
      }
      const body = comps.find((c) => String(c.type).toUpperCase() === 'BODY')?.text ?? '';
      const header = comps.find((c) => String(c.type).toUpperCase() === 'HEADER');
      const nums = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
      out.push({
        name: String(t.name),
        language: String(t.language ?? 'en'),
        body,
        paramCount: nums.length ? Math.max(...nums) : 0,
        header: header && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(String(header.format).toUpperCase()) ? (String(header.format).toUpperCase() as 'IMAGE' | 'VIDEO' | 'DOCUMENT') : null,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },

  async messageError(providerMsgId) {
    const token = process.env.FLAXXA_TOKEN;
    if (!token) return null;
    try {
      const res = await fetch(`${FLAXXA}/get_message_response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, message_id: Number(providerMsgId) || providerMsgId }),
        signal: AbortSignal.timeout(10000),
      });
      const d = (await res.json().catch(() => ({}))) as { data?: { error?: string; error_details?: string } };
      const e = d?.data?.error_details || d?.data?.error;
      return e ? String(e).slice(0, 200) : null;
    } catch {
      return null;
    }
  },
};

/** The provider in use. A second one (Gupshup) is added here and chosen per conversation. */
export function providerFor(_name = 'flaxxa'): WaProvider {
  return flaxxaProvider;
}

let templateCache: { at: number; list: TemplateInfo[] } | null = null;
/** Approved templates (text ones, and ones that carry a picture/video/document), cached for 10 minutes. */
export async function chatTemplates(force = false): Promise<TemplateInfo[]> {
  if (!force && templateCache && Date.now() - templateCache.at < 10 * 60 * 1000) return templateCache.list;
  const list = await providerFor().listTemplates();
  templateCache = { at: Date.now(), list };
  return list;
}

/* ------------------------------------------------------------------- media */

export async function saveMedia(bytes: Buffer, mime: string, filename: string): Promise<string | null> {
  const ext = (filename.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
  if (storage.isConfigured()) {
    const key = `wa/${new Date().getFullYear()}/${randomUUID()}.${ext}`;
    const put = await storage.putObject(key, bytes, mime, { cacheSeconds: 3600 });
    if (put.ok) return key;
  }
  try {
    const r = await pool.query(`INSERT INTO wa_media (mime, bytes) VALUES ($1, $2) RETURNING id`, [mime, bytes]);
    return `db:${r.rows[0].id}`;
  } catch (e) {
    console.error('wa media save failed:', (e as Error).message);
    return null;
  }
}

export async function loadMedia(key: string): Promise<Buffer | null> {
  if (key.startsWith('db:')) {
    const r = await pool.query(`SELECT bytes FROM wa_media WHERE id = $1`, [key.slice(3)]).catch(() => null);
    return r?.rows[0]?.bytes ?? null;
  }
  return storage.getObject(key);
}

/** Fetch a provider media link: some need no header, Meta's need the account token. */
async function downloadInbound(url: string): Promise<{ bytes: Buffer; type: string }> {
  const attempts: Record<string, string>[] = [{}];
  if (/lookaside\.fbsbx\.com|graph\.facebook\.com/.test(url)) {
    for (const t of [process.env.META_TOKEN, process.env.FLAXXA_TOKEN].filter(Boolean) as string[]) attempts.push({ Authorization: `Bearer ${t}` });
  }
  let last = 'download failed';
  for (const headers of attempts) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
      if (!r.ok) { last = `HTTP ${r.status}`; continue; }
      if (Number(r.headers.get('content-length') || 0) > MAX_INBOUND_BYTES) throw new Error('file too large');
      const bytes = Buffer.from(await r.arrayBuffer());
      if (bytes.length > MAX_INBOUND_BYTES) throw new Error('file too large');
      return { bytes, type: r.headers.get('content-type') || '' };
    } catch (e) {
      last = (e as Error).message;
    }
  }
  throw new Error(last);
}

/** Copy a donor's picture/file into DRM's own storage. Never throws; the message keeps its source link to retry. */
export async function persistInboundMedia(messageId: string): Promise<boolean> {
  const m = (await pool.query(`SELECT media_src_url, media_mime, media_name, media_key FROM wa_messages WHERE id = $1`, [messageId])).rows[0];
  if (!m || m.media_key || !m.media_src_url) return !!m?.media_key;
  try {
    const { bytes, type } = await downloadInbound(m.media_src_url);
    const mime = (sniffMime(bytes) || m.media_mime || type || 'application/octet-stream').split(';')[0];
    const key = await saveMedia(bytes, mime, m.media_name || 'file');
    if (!key) return false;
    await pool.query(`UPDATE wa_messages SET media_key = $2, media_mime = $3, media_size = $4 WHERE id = $1`, [messageId, key, mime, bytes.length]);
    return true;
  } catch (e) {
    console.warn(`wa inbound media not saved: ${(e as Error).message}`);
    return false;
  }
}

/* ----------------------------------------------------------- conversations */

export interface Conversation {
  id: string;
  phone: string;
  person_id: string | null;
  display_name: string | null;
  assigned_to: string | null;
  last_message_at: string | null;
  last_message_text: string | null;
  last_message_dir: string | null;
  last_inbound_at: string | null;
  unread_count: number;
  opted_out: boolean;
}

/** Find or make the conversation for a number, joined to the donor in DRM when there is one. */
export async function ensureConversation(rawPhone: string, profileName?: string | null, personId?: string | null): Promise<Conversation | null> {
  const key = phoneKey(rawPhone);
  if (!isValidKey(key)) return null;
  let person: { id: string; name: string } | null = null;
  if (personId) {
    person = (await pool.query(`SELECT id, name FROM people WHERE id = $1`, [personId])).rows[0] ?? null;
  }
  if (!person) {
    person = (await pool.query(`SELECT id, name FROM people WHERE RIGHT(regexp_replace(phone, '\\D', '', 'g'), 10) = RIGHT($1, 10) AND LENGTH($1) = 10 ORDER BY created_at LIMIT 1`, [key])).rows[0] ?? null;
  }
  const name = (person?.name || profileName || '').trim().slice(0, 200) || null;
  const r = await pool.query(
    `INSERT INTO wa_conversations (phone, person_id, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (phone) DO UPDATE SET
       person_id = COALESCE(wa_conversations.person_id, EXCLUDED.person_id),
       display_name = CASE WHEN EXCLUDED.person_id IS NOT NULL OR wa_conversations.display_name IS NULL
                           THEN COALESCE(EXCLUDED.display_name, wa_conversations.display_name)
                           ELSE wa_conversations.display_name END
     RETURNING *`,
    [key, person?.id ?? null, name]
  );
  return r.rows[0] as Conversation;
}

export const windowOpen = (c: Pick<Conversation, 'last_inbound_at'>, now = Date.now()): boolean =>
  !!c.last_inbound_at && now - new Date(c.last_inbound_at).getTime() < WINDOW_MS;

export function windowEndsAt(c: Pick<Conversation, 'last_inbound_at'>): string | null {
  return c.last_inbound_at ? new Date(new Date(c.last_inbound_at).getTime() + WINDOW_MS).toISOString() : null;
}

/* ------------------------------------------------------------------- ticks */

const RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };

/**
 * Apply a tick to a message. Ticks only move forward; 'failed' wins only over a message that was never
 * delivered. Returns whether anything changed.
 */
export type Applied = 'changed' | 'same' | 'missing';
export async function applyStatus(where: { wamid?: string; id?: string }, status: 'sent' | 'delivered' | 'read' | 'failed', at: Date, error?: string): Promise<Applied> {
  const row = (
    await pool.query(`SELECT id, status FROM wa_messages WHERE ${where.id ? 'id = $1' : 'wamid = $1'} AND direction = 'outbound'`, [where.id ?? where.wamid])
  ).rows[0] as { id: string; status: string } | undefined;
  if (!row) return 'missing';
  const cur = RANK[row.status] ?? -1;
  if (status === 'failed') {
    if (cur >= 2 || row.status === 'failed') return 'same';
    await pool.query(`UPDATE wa_messages SET status = 'failed', error = $2, status_at = NOW() WHERE id = $1`, [row.id, (error || 'WhatsApp could not deliver this message').slice(0, 300)]);
    publishConv(row.id, 'status');
    return 'changed';
  }
  // A late 'failed' is overruled by a real delivery/read that arrives after it.
  if (row.status !== 'failed' && (RANK[status] ?? 0) <= cur) return 'same';
  await pool.query(
    `UPDATE wa_messages SET status = $2::varchar,
            error = NULL,
            status_at = NOW(),
            delivered_at = CASE WHEN $2::varchar IN ('delivered', 'read') THEN COALESCE(delivered_at, $3::timestamptz) ELSE delivered_at END,
            read_at = CASE WHEN $2::varchar = 'read' THEN COALESCE(read_at, $3::timestamptz) ELSE read_at END
      WHERE id = $1`,
    [row.id, status, at]
  );
  publishConv(row.id, 'status');
  return 'changed';
}

/** Tell watching screens that a message in some conversation changed. */
function publishConv(messageId: string, t: 'msg' | 'status'): void {
  pool.query(`SELECT conversation_id FROM wa_messages WHERE id = $1`, [messageId]).then((r) => {
    if (r.rows[0]) publish({ t, c: r.rows[0].conversation_id });
  }).catch(() => undefined);
}

/**
 * A text sent through Flaxxa comes back without a WhatsApp id, so the provider's later ticks cannot be
 * matched by it. Match them to the oldest message to that number that is still waiting for one.
 */
async function adoptWamid(recipientKey: string, wamid: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE wa_messages m SET wamid = $2
      WHERE m.id = (
        SELECT m2.id FROM wa_messages m2 JOIN wa_conversations c ON c.id = m2.conversation_id
         WHERE c.phone = $1 AND m2.direction = 'outbound' AND m2.wamid IS NULL AND m2.status IN ('queued', 'sent')
           AND NOT EXISTS (SELECT 1 FROM wa_messages x WHERE x.wamid = $2)
           AND m2.created_at > NOW() - INTERVAL '2 hours'
         ORDER BY m2.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING m.id`,
    [recipientKey, wamid]
  );
  return (r.rowCount ?? 0) > 0;
}

/** Ask the provider about messages it accepted but never reported on; mark the ones it refused. */
export async function reconcilePending(conversationId: string): Promise<void> {
  const rows = (
    await pool.query(
      `SELECT id, provider_msg_id FROM wa_messages
        WHERE conversation_id = $1 AND direction = 'outbound' AND status IN ('queued', 'sent') AND wamid IS NULL
          AND provider_msg_id IS NOT NULL AND created_at < NOW() - INTERVAL '15 seconds' AND created_at > NOW() - INTERVAL '6 hours'
        ORDER BY created_at DESC LIMIT 5`,
      [conversationId]
    )
  ).rows as { id: string; provider_msg_id: string }[];
  for (const m of rows) {
    const err = await providerFor().messageError(m.provider_msg_id);
    if (err) await applyStatus({ id: m.id }, 'failed', new Date(), err);
  }
}

/* ------------------------------------------------------------------ ingest */

interface MetaMsg {
  from?: string; id?: string; type?: string; timestamp?: string;
  text?: { body?: string };
  image?: { caption?: string; url?: string; link?: string; mime_type?: string };
  video?: { caption?: string; url?: string; link?: string; mime_type?: string };
  audio?: { url?: string; link?: string; mime_type?: string };
  document?: { caption?: string; filename?: string; url?: string; link?: string; mime_type?: string };
  sticker?: { url?: string; link?: string; mime_type?: string };
  location?: { name?: string; latitude?: number; longitude?: number; address?: string };
  contacts?: Array<{ name?: { formatted_name?: string }; phones?: Array<{ phone?: string }> }>;
  reaction?: { emoji?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
}

export interface Parsed { type: string; body: string; mediaUrl?: string; mime?: string; filename?: string }

/** One inbound message, as plain text plus any attachment. Unknown types are kept, not dropped. */
export function parseInbound(m: MetaMsg): Parsed {
  const t = String(m.type || 'text');
  const link = (x?: { url?: string; link?: string }) => x?.url || x?.link || '';
  switch (t) {
    case 'text': return { type: 'text', body: m.text?.body ?? '' };
    case 'image': return { type: 'image', body: m.image?.caption ?? '', mediaUrl: link(m.image), mime: m.image?.mime_type || 'image/jpeg' };
    case 'video': return { type: 'video', body: m.video?.caption ?? '', mediaUrl: link(m.video), mime: m.video?.mime_type || 'video/mp4' };
    case 'audio': return { type: 'audio', body: '', mediaUrl: link(m.audio), mime: m.audio?.mime_type || 'audio/ogg' };
    case 'document': return { type: 'document', body: m.document?.caption ?? '', mediaUrl: link(m.document), mime: m.document?.mime_type || 'application/pdf', filename: m.document?.filename };
    case 'sticker': return { type: 'sticker', body: '', mediaUrl: link(m.sticker), mime: m.sticker?.mime_type || 'image/webp' };
    case 'location': return { type: 'location', body: [m.location?.name, m.location?.address, m.location?.latitude != null ? `${m.location.latitude}, ${m.location.longitude}` : ''].filter(Boolean).join(' · ') };
    case 'contacts': return { type: 'contacts', body: (m.contacts ?? []).map((c) => `${c.name?.formatted_name ?? 'Contact'}${c.phones?.[0]?.phone ? ` ${c.phones[0].phone}` : ''}`).join(', ') };
    case 'reaction': return { type: 'reaction', body: m.reaction?.emoji ? `Reacted ${m.reaction.emoji}` : 'Removed a reaction' };
    case 'button': return { type: 'text', body: m.button?.text ?? '' };
    case 'interactive': return { type: 'text', body: m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '' };
    default: return { type: 'other', body: `[${t} message]` };
  }
}

const preview = (p: Parsed) => {
  if (p.body) return p.body.slice(0, 140);
  return ({ image: 'Photo', video: 'Video', audio: 'Voice message', document: 'Document', sticker: 'Sticker' } as Record<string, string>)[p.type] ?? '';
};

const STOP_WORDS = new Set(['stop', 'unsubscribe', 'stop all', 'opt out', 'optout']);
const START_WORDS = new Set(['start', 'subscribe', 'unstop', 'opt in', 'optin']);

/**
 * Take in a webhook body. Safe to call twice with the same body: a message id is stored once and a
 * tick never moves backwards. Returns counts, for the log.
 */
export async function ingestWebhook(body: unknown): Promise<{ messages: number; statuses: number }> {
  const out = { messages: 0, statuses: 0 };
  const entries = (body as { entry?: Array<{ changes?: Array<{ value?: Record<string, unknown> }> }> })?.entry ?? [];
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      const value = change.value as {
        messages?: MetaMsg[];
        statuses?: Array<{ id?: string; status?: string; timestamp?: string; recipient_id?: string; errors?: Array<{ title?: string; message?: string; code?: number }> }>;
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
      } | undefined;
      if (!value) continue;

      for (const m of value.messages ?? []) {
        try {
          if (!m.id || !m.from) continue;
          const key = phoneKey(m.from);
          const profile = value.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? null;
          const conv = await ensureConversation(key, profile);
          if (!conv) continue;
          const p = parseInbound(m);
          const at = m.timestamp && Number(m.timestamp) > 0 ? new Date(Number(m.timestamp) * 1000) : new Date();
          const ins = await pool.query(
            `INSERT INTO wa_messages (conversation_id, direction, msg_type, body, media_src_url, media_mime, media_name, wamid, status, created_at)
             VALUES ($1, 'inbound', $2, $3, $4, $5, $6, $7, 'received', $8)
             ON CONFLICT (wamid) WHERE wamid IS NOT NULL DO NOTHING RETURNING id`,
            [conv.id, p.type, p.body || null, p.mediaUrl || null, p.mime || null, p.filename ? storage.safeName(p.filename) : null, m.id, at]
          );
          if (!ins.rowCount) continue; // delivered before
          out.messages++;
          const word = p.type === 'text' ? p.body.trim().toLowerCase() : '';
          const optOut = STOP_WORDS.has(word) ? true : START_WORDS.has(word) ? false : null;
          // A reaction is not a message to answer: it does not open the 24-hour window or count as unread.
          const real = p.type !== 'reaction';
          await pool.query(
            `UPDATE wa_conversations SET
               last_message_at = GREATEST(COALESCE(last_message_at, $2), $2),
               last_message_text = CASE WHEN last_message_at IS NULL OR $2 >= last_message_at THEN $3 ELSE last_message_text END,
               last_message_dir = CASE WHEN last_message_at IS NULL OR $2 >= last_message_at THEN 'inbound' ELSE last_message_dir END,
               last_inbound_at = CASE WHEN $4 THEN GREATEST(COALESCE(last_inbound_at, $2), $2) ELSE last_inbound_at END,
               unread_count = unread_count + CASE WHEN $4 THEN 1 ELSE 0 END,
               opted_out = COALESCE($5, opted_out),
               updated_at = NOW()
             WHERE id = $1`,
            [conv.id, at, preview(p), real, optOut]
          );
          publish({ t: 'msg', c: conv.id });
          if (p.mediaUrl) void persistInboundMedia(ins.rows[0].id).then(() => publish({ t: 'status', c: conv.id }));
        } catch (e) {
          console.error('wa ingest message failed:', (e as Error).message);
        }
      }

      for (const s of value.statuses ?? []) {
        try {
          const st = ({ sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' } as Record<string, 'sent' | 'delivered' | 'read' | 'failed'>)[String(s.status)];
          if (!st || !s.id) continue;
          const at = s.timestamp && Number(s.timestamp) > 0 ? new Date(Number(s.timestamp) * 1000) : new Date();
          const err = s.errors?.[0] ? `${s.errors[0].title || s.errors[0].message || 'Failed'}${s.errors[0].code ? ` (${s.errors[0].code})` : ''}` : undefined;
          let applied = await applyStatus({ wamid: s.id }, st, at, err);
          // Only a tick for a message we hold no id for is matched by number; a repeat of one we know is just a repeat.
          if (applied === 'missing' && s.recipient_id) {
            if (await adoptWamid(phoneKey(s.recipient_id), s.id)) applied = await applyStatus({ wamid: s.id }, st, at, err);
          }
          if (applied === 'changed') out.statuses++;
        } catch (e) {
          console.error('wa ingest status failed:', (e as Error).message);
        }
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------------- send */

export interface MessageRow {
  id: string; conversation_id: string; direction: string; msg_type: string; body: string | null;
  media_key: string | null; media_mime: string | null; media_name: string | null; media_size: number | null;
  template_name: string | null; status: string; error: string | null; sent_by: string | null;
  created_at: string; delivered_at: string | null; read_at: string | null;
}

export type SendOutcome =
  | { ok: true; message: MessageRow; duplicate?: boolean }
  | { ok: false; httpStatus: number; code: string; error: string };

const fail = (httpStatus: number, code: string, error: string): SendOutcome => ({ ok: false, httpStatus, code, error });

/** A per-person limit on sending, so a stuck key or a script cannot flood donors. */
const sendLog = new Map<string, number[]>();
export function sendAllowed(userId: string, now = Date.now()): boolean {
  const recent = (sendLog.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 40) { sendLog.set(userId, recent); return false; }
  recent.push(now);
  sendLog.set(userId, recent);
  return true;
}

export type OutboundInput =
  | { kind: 'text'; text: string; clientRef?: string }
  | { kind: 'media'; bytes: Buffer; mime: string; filename: string; caption?: string; clientRef?: string }
  | { kind: 'template'; name: string; language: string; params: string[]; file?: { bytes: Buffer; mime: string; filename: string }; clientRef?: string };

const MESSAGE_COLS = `id, conversation_id, direction, msg_type, body, media_key, media_mime, media_name, media_size,
  template_name, status, error, sent_by, created_at, delivered_at, read_at`;

/** Send one message to a conversation, with every rule applied. */
export async function sendOutbound(conv: Conversation, userId: string, input: OutboundInput): Promise<SendOutcome> {
  if (conv.opted_out) return fail(403, 'opted_out', 'This donor asked not to be messaged (they wrote STOP). Do not send until they write START.');
  if (!isValidKey(conv.phone)) return fail(400, 'bad_number', 'This is not a WhatsApp number.');
  // A safety for trying the screen on a laptop: only the listed numbers can be messaged (WA_SEND_ALLOWLIST=9876543210,...).
  const allow = (process.env.WA_SEND_ALLOWLIST ?? '').split(',').map((x) => phoneKey(x)).filter(Boolean);
  if (allow.length && !allow.includes(conv.phone)) return fail(403, 'test_mode', `Test mode: this server may only message ${allow.map((a) => '+91 ' + a).join(', ')}.`);
  if (!sendAllowed(userId)) return fail(429, 'slow_down', 'Too many messages in a minute. Wait a little and try again.');
  const provider = providerFor();
  if (!provider.configured()) return fail(503, 'not_configured', 'WhatsApp is not set up on this server yet (FLAXXA_TOKEN).');

  const clientRef = input.clientRef ? String(input.clientRef).slice(0, 64) : null;
  if (clientRef) {
    const dup = await pool.query(`SELECT ${MESSAGE_COLS} FROM wa_messages WHERE conversation_id = $1 AND client_ref = $2`, [conv.id, clientRef]);
    if (dup.rows[0]) return { ok: true, message: dup.rows[0], duplicate: true };
  }

  const open = windowOpen(conv);
  if (input.kind !== 'template' && !open) {
    return fail(409, 'window_closed', conv.last_inbound_at
      ? 'It has been more than 24 hours since this donor last wrote, so WhatsApp only allows an approved template message now.'
      : 'This donor has not written to us yet, so WhatsApp only allows an approved template message to start the chat.');
  }

  let msgType = 'text';
  let body: string | null = null;
  let mediaKey: string | null = null;
  let mediaMime: string | null = null;
  let mediaName: string | null = null;
  let mediaSize: number | null = null;
  let templateName: string | null = null;
  let send: () => Promise<SendResult>;
  const to = toWaNumber(conv.phone);

  if (input.kind === 'text') {
    const text = input.text.replace(/\r\n/g, '\n').trim();
    if (!text) return fail(400, 'empty', 'Type a message first.');
    if (text.length > MAX_TEXT) return fail(400, 'too_long', `A message can be up to ${MAX_TEXT} characters.`);
    body = text;
    send = () => provider.sendText(to, text);
  } else if (input.kind === 'media') {
    const check = checkOutboundMedia(input.bytes, input.mime, input.filename);
    if (!check.ok) return fail(400, 'bad_file', check.error);
    const caption = (input.caption ?? '').trim().slice(0, 1024);
    msgType = check.kind;
    body = caption || null;
    mediaMime = check.mime;
    mediaName = check.filename;
    mediaSize = input.bytes.length;
    mediaKey = await saveMedia(input.bytes, check.mime, check.filename);
    if (!mediaKey) return fail(500, 'storage', 'Could not store the file. Try again.');
    send = () => provider.sendMedia(to, { bytes: input.bytes, mime: check.mime, filename: check.filename, kind: check.kind }, caption);
  } else {
    const tpl = (await chatTemplates().catch(() => [])).find((t) => t.name === input.name && t.language === input.language)
      ?? (await chatTemplates().catch(() => [])).find((t) => t.name === input.name);
    if (!tpl) return fail(400, 'bad_template', 'That template is not available.');
    const params = input.params.map((p) => String(p ?? '').trim());
    if (params.length !== tpl.paramCount || params.some((p) => !p)) return fail(400, 'bad_params', `Fill in all ${tpl.paramCount} value${tpl.paramCount === 1 ? '' : 's'} for this template.`);
    templateName = tpl.name;
    msgType = 'template';
    body = tpl.body.replace(/\{\{(\d+)\}\}/g, (_m, n) => params[Number(n) - 1] ?? '');
    if (tpl.header) {
      // A template with a picture/video/document in its header cannot go without that file.
      if (!input.file) return fail(400, 'bad_file', `This template carries a ${tpl.header.toLowerCase()}. Attach one to send it.`);
      const check = checkOutboundMedia(input.file.bytes, input.file.mime, input.file.filename);
      if (!check.ok) return fail(400, 'bad_file', check.error);
      const want = tpl.header.toLowerCase();
      if (check.kind !== want) return fail(400, 'bad_file', `This template needs a ${want}, not a ${check.kind}.`);
      msgType = check.kind;
      mediaMime = check.mime;
      mediaName = check.filename;
      mediaSize = input.file.bytes.length;
      mediaKey = await saveMedia(input.file.bytes, check.mime, check.filename);
      if (!mediaKey) return fail(500, 'storage', 'Could not store the file. Try again.');
      const f = { bytes: input.file.bytes, mime: check.mime, filename: check.filename };
      send = () => provider.sendTemplateWithMedia(to, tpl.name, tpl.language, params, f);
    } else {
      if (input.file) return fail(400, 'bad_file', 'This template has no picture. Choose one that does, or remove the attachment.');
      send = () => provider.sendTemplate(to, tpl.name, tpl.language, params);
    }
  }

  let msgId: string;
  try {
    const ins = await pool.query(
      `INSERT INTO wa_messages (conversation_id, direction, msg_type, body, media_key, media_mime, media_name, media_size, template_name, status, sent_by, client_ref)
       VALUES ($1, 'outbound', $2, $3, $4, $5, $6, $7, $8, 'queued', $9, $10) RETURNING id`,
      [conv.id, msgType, body, mediaKey, mediaMime, mediaName, mediaSize, templateName, userId, clientRef]
    );
    msgId = ins.rows[0].id;
  } catch (e) {
    // Two clicks raced past the check above: the other one holds the send.
    if ((e as { code?: string }).code === '23505' && clientRef) {
      const dup = await pool.query(`SELECT ${MESSAGE_COLS} FROM wa_messages WHERE conversation_id = $1 AND client_ref = $2`, [conv.id, clientRef]);
      if (dup.rows[0]) return { ok: true, message: dup.rows[0], duplicate: true };
    }
    throw e;
  }

  const r = await send();
  if (r.ok) {
    await pool.query(`UPDATE wa_messages SET status = 'sent', provider_msg_id = $2, wamid = $3, status_at = NOW() WHERE id = $1`, [msgId, r.providerMsgId, r.wamid]);
  } else {
    const nice = r.reason === 'not_configured' ? r.detail : r.reason === 'rejected' ? `WhatsApp refused it: ${r.detail}` : `Could not reach WhatsApp: ${r.detail}. It may or may not have gone - check before sending again.`;
    await pool.query(`UPDATE wa_messages SET status = 'failed', error = $2, status_at = NOW() WHERE id = $1`, [msgId, nice.slice(0, 300)]);
  }
  const shown = body ? body.slice(0, 140) : msgType === 'image' ? 'Photo' : msgType === 'video' ? 'Video' : msgType === 'audio' ? 'Voice message' : 'Document';
  await pool.query(
    `UPDATE wa_conversations SET last_message_at = NOW(), last_message_text = $2, last_message_dir = 'outbound',
            unread_count = 0, assigned_to = COALESCE(assigned_to, $3), updated_at = NOW() WHERE id = $1`,
    [conv.id, shown, userId]
  );
  const row = (await pool.query(`SELECT ${MESSAGE_COLS} FROM wa_messages WHERE id = $1`, [msgId])).rows[0] as MessageRow;
  publish({ t: 'msg', c: conv.id });
  return { ok: true, message: row };
}

/** For tests and logs: a short stable fingerprint, never the number itself. */
export const shortHash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);
