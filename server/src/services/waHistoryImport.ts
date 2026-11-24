// Old WhatsApp chats, copied into DRM from the WhatsApp CRM's database.
//
// WHY THIS EXISTS
// DRM's chat only holds what arrived after the live link from the WhatsApp CRM was switched on. Every earlier
// chat sits in the CRM's own database (MongoDB), so a donor's history in DRM began on the day of the link.
// This copies the rest in: every conversation and message the CRM holds, so a donor's whole WhatsApp history is
// in one place.
//
// IT ONLY EVER READS THE CRM
// The CRM is a live system with its own screens and its own bulk sends. Nothing here writes to it, and the
// connection asks for a secondary where it can. The address comes from WA_CRM_MONGODB_URI.
//
// SAFE TO RUN AGAIN
//   - every message carries the CRM's own id (legacy_id), and a message DRM already holds - copied before, or
//     delivered live through the link (same WhatsApp message id) - is skipped, never doubled;
//   - a chat's last-message line and 24-hour window are recomputed from the messages themselves, so an old
//     message never moves a newer one out of the way or reopens a window;
//   - nothing is marked unread: these are old messages, not new ones;
//   - a donor whose last word in the old chat was STOP stays opted out. Importing never switches anyone back on.
//
// PICTURES AND FILES
// The CRM never saved received pictures permanently: it holds the provider's temporary link, which stopped
// working within a day or two (Meta's within minutes). The words of those messages are copied, and the picture
// shows as "no longer available" - the honest state of a file that is no longer anywhere. Nothing is fetched
// from those links.

import { MongoClient } from 'mongodb';
import pool from '../db/pool';
import { ensureConversation, isValidKey, phoneKey, START_WORDS, STOP_WORDS } from './whatsappChat';

const BATCH = 500;
let running = false;

/** One message as the CRM stores it (models/Message.js there). */
export interface CrmMessage {
  _id: { toString(): string } | string;
  contactPhone?: string;
  contactName?: string | null;
  direction?: string;
  type?: string;
  body?: string | null;
  mimeType?: string | null;
  templateName?: string | null;
  status?: string;
  wamid?: string | null;
  sentAt?: Date | string | null;
  deliveredAt?: Date | string | null;
  readAt?: Date | string | null;
}

/** Where the old messages come from. The CRM's database in production; a stand-in in the tests. */
export interface HistorySource {
  count(): Promise<number>;
  messages(): AsyncIterable<CrmMessage>;
  close(): Promise<void>;
}

/** The CRM's database, read-only. Throws if WA_CRM_MONGODB_URI is not set. */
export async function crmSource(): Promise<HistorySource> {
  const uri = process.env.WA_CRM_MONGODB_URI;
  if (!uri) throw new Error('The WhatsApp CRM database is not connected (WA_CRM_MONGODB_URI is not set).');
  const client = new MongoClient(uri, { readPreference: 'secondaryPreferred', serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const messages = client.db().collection<CrmMessage>('messages');
  return {
    count: () => messages.countDocuments({}),
    messages: () => messages.find({}).sort({ sentAt: 1, _id: 1 }).batchSize(BATCH) as unknown as AsyncIterable<CrmMessage>,
    close: () => client.close(),
  };
}

export async function importStatus() {
  const r = await pool.query(
    `SELECT status, total, scanned, imported, skipped, drafts, conversations, error, started_at, finished_at FROM wa_history_import WHERE id = 1`
  );
  return r.rows[0];
}

const TYPE: Record<string, string> = {
  text: 'text', image: 'image', video: 'video', audio: 'audio', voice: 'audio', file: 'document', document: 'document',
  sticker: 'sticker', reaction: 'reaction', contact: 'contacts', contacts: 'contacts', location: 'location', template: 'template',
};

const asDate = (v: unknown): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

interface Row {
  conv: string;
  direction: 'inbound' | 'outbound';
  type: string;
  body: string | null;
  mime: string | null;
  template: string | null;
  wamid: string | null;
  status: string;
  at: Date;
  deliveredAt: Date | null;
  readAt: Date | null;
  legacyId: string;
}

/** What DRM's message status is for a CRM one. Inbound is always "received". */
function statusOf(direction: 'inbound' | 'outbound', crm: string | undefined): string {
  if (direction === 'inbound') return 'received';
  return crm === 'read' ? 'read' : crm === 'delivered' ? 'delivered' : crm === 'failed' ? 'failed' : 'sent';
}

async function insertBatch(rows: Row[]): Promise<number> {
  if (!rows.length) return 0;
  const cols = 13;
  const values: unknown[] = [];
  const tuples = rows.map((r, i) => {
    const o = i * cols;
    values.push(r.conv, r.direction, r.type, r.body, r.mime, r.template, r.wamid, r.status, r.at, r.deliveredAt, r.readAt, r.readAt ?? r.deliveredAt ?? r.at, r.legacyId);
    return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8}, $${o + 9}, $${o + 10}, $${o + 11}, $${o + 12}, $${o + 13})`;
  });
  const r = await pool.query(
    `INSERT INTO wa_messages (conversation_id, direction, msg_type, body, media_mime, template_name, wamid, status, created_at, delivered_at, read_at, status_at, legacy_id)
     VALUES ${tuples.join(', ')}
     ON CONFLICT DO NOTHING`,
    values
  );
  return r.rowCount ?? 0;
}

/** Bring the chats the copy touched in line with their messages. */
async function settle(conversationIds: string[]): Promise<void> {
  for (let i = 0; i < conversationIds.length; i += BATCH) {
    const ids = conversationIds.slice(i, i + BATCH);
    await pool.query(
      `WITH last AS (
         SELECT DISTINCT ON (conversation_id) conversation_id, created_at, direction,
                COALESCE(NULLIF(left(body, 200), ''),
                         CASE msg_type WHEN 'image' THEN 'Photo' WHEN 'video' THEN 'Video' WHEN 'audio' THEN 'Voice message'
                                       WHEN 'document' THEN 'Document' WHEN 'sticker' THEN 'Sticker' ELSE '' END) AS text
           FROM wa_messages WHERE conversation_id = ANY($1::uuid[]) ORDER BY conversation_id, created_at DESC),
       inb AS (
         SELECT conversation_id, MAX(created_at) AS at FROM wa_messages
          WHERE conversation_id = ANY($1::uuid[]) AND direction = 'inbound' AND msg_type <> 'reaction' GROUP BY conversation_id)
       UPDATE wa_conversations c SET
         last_message_text = CASE WHEN c.last_message_at IS NULL OR l.created_at >= c.last_message_at THEN l.text ELSE c.last_message_text END,
         last_message_dir  = CASE WHEN c.last_message_at IS NULL OR l.created_at >= c.last_message_at THEN l.direction ELSE c.last_message_dir END,
         last_message_at   = GREATEST(c.last_message_at, l.created_at),
         last_inbound_at   = GREATEST(c.last_inbound_at, inb.at),
         updated_at = NOW()
        FROM last l LEFT JOIN inb ON inb.conversation_id = l.conversation_id
       WHERE c.id = l.conversation_id`,
      [ids]
    );
    // A donor whose last STOP/START word in the whole chat is a STOP is opted out. Never the other way round.
    await pool.query(
      `UPDATE wa_conversations c SET opted_out = TRUE, updated_at = NOW()
         FROM (SELECT DISTINCT ON (conversation_id) conversation_id, lower(btrim(body)) AS word
                 FROM wa_messages
                WHERE conversation_id = ANY($1::uuid[]) AND direction = 'inbound' AND msg_type = 'text'
                  AND lower(btrim(body)) = ANY($2::text[])
                ORDER BY conversation_id, created_at DESC) s
        WHERE c.id = s.conversation_id AND NOT c.opted_out AND s.word = ANY($3::text[])`,
      [ids, [...STOP_WORDS, ...START_WORDS], [...STOP_WORDS]]
    );
  }
}

/**
 * Copy every old chat in. Returns false if a copy is already running. Never throws: the outcome is in the
 * status row, which is what the screen shows.
 */
export async function importHistory(source?: HistorySource): Promise<boolean> {
  if (running) return false;
  running = true;
  let src: HistorySource | undefined = source;
  try {
    await pool.query(
      `UPDATE wa_history_import SET status = 'running', total = 0, scanned = 0, imported = 0, skipped = 0, drafts = 0, conversations = 0,
              error = NULL, started_at = NOW(), finished_at = NULL WHERE id = 1`
    );
    src = src ?? (await crmSource());
    const total = await src.count();
    await pool.query(`UPDATE wa_history_import SET total = $1 WHERE id = 1`, [total]);

    const convByPhone = new Map<string, string | null>();
    const touched = new Set<string>();
    let scanned = 0;
    let imported = 0;
    let skipped = 0;
    let drafts = 0;
    let rows: Row[] = [];

    const flush = async () => {
      const added = await insertBatch(rows);
      imported += added;
      skipped += rows.length - added;
      rows = [];
      await pool.query(`UPDATE wa_history_import SET scanned = $1, imported = $2, skipped = $3, drafts = $4, conversations = $5 WHERE id = 1`, [
        scanned, imported, skipped, drafts, touched.size,
      ]);
    };

    for await (const m of src.messages()) {
      scanned++;
      if (m.status === 'draft') {
        drafts++; // an AI draft nobody sent: not part of the conversation
        continue;
      }
      const key = phoneKey(m.contactPhone);
      if (!isValidKey(key)) {
        skipped++;
        continue;
      }
      if (!convByPhone.has(key)) {
        const conv = await ensureConversation(key, m.contactName ?? null);
        convByPhone.set(key, conv?.id ?? null);
      }
      const conv = convByPhone.get(key);
      const at = asDate(m.sentAt);
      if (!conv || !at) {
        skipped++;
        continue;
      }
      touched.add(conv);
      const direction = m.direction === 'inbound' ? 'inbound' : 'outbound';
      rows.push({
        conv,
        direction,
        type: TYPE[String(m.type ?? 'text')] ?? 'other',
        body: m.body ? String(m.body) : null,
        mime: m.mimeType ? String(m.mimeType).slice(0, 100) : null,
        template: m.templateName ? String(m.templateName).slice(0, 120) : null,
        wamid: m.wamid ? String(m.wamid).slice(0, 200) : null,
        status: statusOf(direction, m.status),
        at,
        deliveredAt: asDate(m.deliveredAt),
        readAt: asDate(m.readAt),
        legacyId: String(typeof m._id === 'string' ? m._id : m._id.toString()).slice(0, 40),
      });
      if (rows.length >= BATCH) await flush();
    }
    await flush();
    await settle([...touched]);
    await pool.query(`UPDATE wa_history_import SET status = 'done', finished_at = NOW() WHERE id = 1`);
  } catch (e) {
    console.error('waHistoryImport failed:', (e as Error).message);
    await pool
      .query(`UPDATE wa_history_import SET status = 'failed', error = $1, finished_at = NOW() WHERE id = 1`, [(e as Error).message.slice(0, 500)])
      .catch(() => undefined);
  } finally {
    await src?.close().catch(() => undefined);
    running = false;
  }
  return true;
}
