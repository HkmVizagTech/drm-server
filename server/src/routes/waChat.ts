// WhatsApp chat API: callers and admins talk to donors.
//
// Everyone who can open this can see every conversation - a caller messages any donor in DRM, and anyone
// who writes to the WhatsApp number appears here too. What is guarded is what could embarrass the
// temple: nothing is sent to a donor who wrote STOP, nothing free-form after the 24-hour window, no
// file WhatsApp would refuse, and nothing twice.

import { Router, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import pool from '../db/pool';
import { authenticate, authorize } from '../middleware/auth';
import { addClient, publish } from '../services/waEvents';
import { searchContacts, syncContacts, syncStatus } from '../services/whatsappContacts';
import {
  Conversation,
  chatTemplates,
  ensureConversation,
  ingestWebhook,
  loadMedia,
  persistInboundMedia,
  phoneKey,
  isValidKey,
  providerFor,
  reconcilePending,
  sendOutbound,
  windowEndsAt,
  windowOpen,
  MAX_MEDIA_BYTES,
} from '../services/whatsappChat';

const router = Router();
router.use(authenticate, authorize('admin', 'caller'));

const idOk = (v: unknown) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

/** A conversation as the screen needs it: the window state and who it belongs to, never raw columns only. */
function shape(c: Conversation & { assigned_name?: string | null; person_name?: string | null }) {
  return {
    id: c.id,
    phone: c.phone,
    person_id: c.person_id,
    name: c.person_name || c.display_name || null,
    assigned_to: c.assigned_to,
    assigned_name: c.assigned_name ?? null,
    last_message_at: c.last_message_at,
    last_message_text: c.last_message_text,
    last_message_dir: c.last_message_dir,
    unread_count: c.unread_count,
    opted_out: c.opted_out,
    window_open: windowOpen(c),
    window_ends_at: windowEndsAt(c),
  };
}

async function getConv(id: string): Promise<(Conversation & { assigned_name: string | null; person_name: string | null }) | null> {
  if (!idOk(id)) return null;
  const r = await pool.query(
    `SELECT c.*, u.name AS assigned_name, p.name AS person_name
       FROM wa_conversations c
       LEFT JOIN users u ON u.id = c.assigned_to
       LEFT JOIN people p ON p.id = c.person_id
      WHERE c.id = $1`,
    [id]
  );
  return r.rows[0] ?? null;
}

// The live channel: one open connection per screen. See services/waEvents.ts.
router.get('/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n: connected\n\n');
  addClient(res);
});

// Find anyone to start a chat with: donors in DRM and every contact in the temple's WhatsApp.
router.get('/contacts', async (req, res) => {
  try {
    res.json({ contacts: await searchContacts(String(req.query.q ?? '')) });
  } catch (e) {
    console.error('waChat.contacts error:', (e as Error).message);
    res.status(500).json({ error: 'Could not search contacts.', contacts: [] });
  }
});
router.get('/contacts/sync', async (_req, res) => res.json(await syncStatus()));
// Copying all of Flaxxa's contacts takes a while; it runs in the background and reports its progress.
router.post('/contacts/sync', authorize('admin'), async (_req, res) => {
  if (!providerFor().configured()) return res.status(503).json({ error: 'WhatsApp is not set up on this server yet (FLAXXA_TOKEN).' });
  const st = await syncStatus();
  if (st.status === 'running') return res.status(202).json({ started: false, running: true });
  void syncContacts();
  res.status(202).json({ started: true });
});

// What the screen needs to warn about before anyone types.
router.get('/status', (_req, res) => {
  res.json({
    configured: providerFor().configured(),
    provider: providerFor().name,
    max_media_mb: Math.floor(MAX_MEDIA_BYTES / 1048576),
    receiving: !!process.env.WA_CHAT_WEBHOOK_SECRET,
  });
});

// Has this number written to the temple in the last 24 hours (as far as DRM has seen)? The Seva wall asks
// before opening a chat, so a caller is told up front when only their own WhatsApp can send.
router.get('/window', async (req, res) => {
  const key = phoneKey(String(req.query.phone ?? ''));
  if (!isValidKey(key)) return res.status(400).json({ error: 'Enter a valid WhatsApp number.' });
  const c = (await pool.query(`SELECT last_inbound_at, opted_out FROM wa_conversations WHERE phone = $1`, [key])).rows[0];
  res.json({ replied: c ? windowOpen(c) : false, ends_at: c ? windowEndsAt(c) : null, opted_out: !!c?.opted_out });
});

router.get('/unread-count', async (_req, res) => {
  const r = await pool.query(`SELECT COALESCE(SUM(unread_count), 0)::int AS n, COUNT(*) FILTER (WHERE unread_count > 0)::int AS chats FROM wa_conversations`);
  res.json({ count: r.rows[0].n, chats: r.rows[0].chats });
});

router.get('/conversations', async (req, res) => {
  const q = String(req.query.q ?? '').trim().slice(0, 80);
  const filter = String(req.query.filter ?? 'all');
  const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 100);
  const before = req.query.before ? new Date(String(req.query.before)) : null;
  const where: string[] = ['c.last_message_at IS NOT NULL'];
  const vals: unknown[] = [];
  if (q) {
    const digits = q.replace(/\D/g, '');
    vals.push(`%${q}%`);
    let cond = `(c.display_name ILIKE $${vals.length} OR p.name ILIKE $${vals.length}`;
    if (digits.length >= 3) { vals.push(`%${digits}%`); cond += ` OR c.phone LIKE $${vals.length}`; }
    where.push(`${cond})`);
  }
  if (filter === 'unread') where.push('c.unread_count > 0');
  else if (filter === 'mine') { vals.push(req.user!.userId); where.push(`c.assigned_to = $${vals.length}`); }
  else if (filter === 'unassigned') where.push('c.assigned_to IS NULL');
  if (before && !Number.isNaN(before.getTime())) { vals.push(before); where.push(`c.last_message_at < $${vals.length}`); }
  vals.push(limit + 1);
  const r = await pool.query(
    `SELECT c.*, u.name AS assigned_name, p.name AS person_name
       FROM wa_conversations c
       LEFT JOIN users u ON u.id = c.assigned_to
       LEFT JOIN people p ON p.id = c.person_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.last_message_at DESC
      LIMIT $${vals.length}`,
    vals
  );
  const more = r.rows.length > limit;
  res.json({ conversations: r.rows.slice(0, limit).map(shape), more });
});

// Open (or start) the chat with a number or a donor.
router.post('/conversations', async (req, res) => {
  const personId = req.body?.person_id ? String(req.body.person_id) : null;
  if (personId && !idOk(personId)) return res.status(400).json({ error: 'That donor was not found.' });
  let phone = String(req.body?.phone ?? '');
  if (!phone && personId) {
    phone = (await pool.query(`SELECT phone FROM people WHERE id = $1`, [personId])).rows[0]?.phone ?? '';
  }
  const key = phoneKey(phone);
  if (!isValidKey(key)) return res.status(400).json({ error: 'Enter a valid WhatsApp number.' });
  const conv = await ensureConversation(key, null, personId);
  if (!conv) return res.status(400).json({ error: 'Enter a valid WhatsApp number.' });
  const full = await getConv(conv.id);
  res.json({ conversation: shape(full!) });
});

router.get('/conversations/:id', async (req, res) => {
  const c = await getConv(req.params.id);
  if (!c) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ conversation: shape(c) });
});

router.get('/conversations/:id/messages', async (req, res) => {
  const c = await getConv(req.params.id);
  if (!c) return res.status(404).json({ error: 'Conversation not found' });
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const cols = `m.id, m.direction, m.msg_type, m.body, m.media_mime, m.media_name, m.media_size, m.template_name, m.status, m.error,
                m.created_at, m.delivered_at, m.read_at, (m.media_key IS NOT NULL) AS has_media, (m.media_src_url IS NOT NULL) AS media_pending_src,
                u.name AS sent_by_name, wi.share_token AS wall_share_token`;
  const from = `FROM wa_messages m LEFT JOIN users u ON u.id = m.sent_by LEFT JOIN seva_wall_items wi ON wi.id = m.wall_item_id WHERE m.conversation_id = $1`;
  let rows;
  if (req.query.after) {
    // The live refresh: only what is new or has changed a tick since.
    const after = new Date(String(req.query.after));
    if (Number.isNaN(after.getTime())) return res.status(400).json({ error: 'Bad time' });
    rows = (await pool.query(
      `SELECT ${cols} ${from} AND (m.created_at > $2 OR m.status_at > $2) ORDER BY m.created_at ASC LIMIT 200`,
      [c.id, after]
    )).rows;
  } else if (req.query.before) {
    const before = new Date(String(req.query.before));
    if (Number.isNaN(before.getTime())) return res.status(400).json({ error: 'Bad time' });
    rows = (await pool.query(`SELECT ${cols} ${from} AND m.created_at < $2 ORDER BY m.created_at DESC LIMIT $3`, [c.id, before, limit + 1])).rows.reverse();
  } else {
    rows = (await pool.query(`SELECT ${cols} ${from} ORDER BY m.created_at DESC LIMIT $2`, [c.id, limit + 1])).rows.reverse();
  }
  const more = !req.query.after && rows.length > limit;
  if (more) rows = rows.slice(1);
  // A Seva wall brick's public picture page, for sending it from the caller's own WhatsApp when the
  // temple's number was refused (the old way: a link, since a wa.me message cannot carry a picture).
  const base = (process.env.PUBLIC_APP_URL ?? '').replace(/\/+$/, '') || `${String(req.get('x-forwarded-proto') ?? req.protocol).split(',')[0]}://${req.get('host')}`;
  rows = rows.map(({ wall_share_token, ...m }: Record<string, unknown>) => ({ ...m, wall_share_url: wall_share_token ? `${base}/b/${String(wall_share_token).trim()}` : null }));
  void reconcilePending(c.id).catch(() => undefined);
  res.json({ messages: rows, more, conversation: shape(c), server_time: new Date().toISOString() });
});

router.post('/conversations/:id/read', async (req, res) => {
  if (!idOk(req.params.id)) return res.status(404).json({ error: 'Conversation not found' });
  await pool.query(`UPDATE wa_conversations SET unread_count = 0 WHERE id = $1 AND unread_count > 0`, [req.params.id]);
  publish({ t: 'conv', c: req.params.id });
  res.json({ ok: true });
});

router.put('/conversations/:id/assign', async (req, res) => {
  const c = await getConv(req.params.id);
  if (!c) return res.status(404).json({ error: 'Conversation not found' });
  const want = req.body?.user_id ? String(req.body.user_id) : null;
  // A caller takes a chat or lets it go; handing it to someone else is the admin's call.
  if (req.user!.role !== 'admin' && want && want !== req.user!.userId) return res.status(403).json({ error: 'Only an admin can give a chat to someone else.' });
  if (req.user!.role !== 'admin' && !want && c.assigned_to && c.assigned_to !== req.user!.userId) return res.status(403).json({ error: 'This chat belongs to someone else.' });
  if (want) {
    if (!idOk(want)) return res.status(400).json({ error: 'Unknown team member.' });
    const u = await pool.query(`SELECT 1 FROM users WHERE id = $1 AND role IN ('admin', 'caller')`, [want]);
    if (!u.rowCount) return res.status(400).json({ error: 'Unknown team member.' });
  }
  await pool.query(`UPDATE wa_conversations SET assigned_to = $2, updated_at = NOW() WHERE id = $1`, [c.id, want]);
  publish({ t: 'conv', c: c.id });
  res.json({ conversation: shape((await getConv(c.id))!) });
});

router.get('/team', async (_req, res) => {
  const r = await pool.query(`SELECT id, name, role FROM users WHERE role IN ('admin', 'caller') AND COALESCE(is_active, TRUE) ORDER BY name`).catch(() =>
    pool.query(`SELECT id, name, role FROM users WHERE role IN ('admin', 'caller') ORDER BY name`)
  );
  res.json({ users: r.rows });
});

async function send(req: Request, res: Response, build: (c: Conversation) => Promise<Parameters<typeof sendOutbound>[2] | string>) {
  const c = await getConv(req.params.id as string);
  if (!c) return res.status(404).json({ error: 'Conversation not found' });
  const input = await build(c);
  if (typeof input === 'string') return res.status(400).json({ error: input, code: 'bad_request' });
  const out = await sendOutbound(c, req.user!.userId, input);
  if (!out.ok) return res.status(out.httpStatus).json({ error: out.error, code: out.code });
  const full = await getConv(c.id);
  res.status(out.duplicate ? 200 : 201).json({ message: out.message, duplicate: !!out.duplicate, conversation: shape(full!) });
}

router.post('/conversations/:id/messages', (req, res) =>
  send(req, res, async () => {
    if (typeof req.body?.text !== 'string') return 'Type a message first.';
    return { kind: 'text', text: req.body.text, clientRef: req.body?.client_ref };
  }).catch((e) => { console.error('waChat.send error:', e); res.status(500).json({ error: 'Could not send. Try again.' }); })
);

router.post('/conversations/:id/media', (req, res) =>
  send(req, res, async () => {
    const b64 = String(req.body?.base64 ?? '');
    if (!b64) return 'No file received.';
    // Reject by size before decoding: base64 is a third bigger than the bytes it carries.
    if (b64.length > Math.ceil((MAX_MEDIA_BYTES * 4) / 3) + 8) return `That file is too large. The limit is ${Math.floor(MAX_MEDIA_BYTES / 1048576)} MB.`;
    return {
      kind: 'media', bytes: Buffer.from(b64, 'base64'), mime: String(req.body?.mime ?? ''),
      filename: String(req.body?.filename ?? 'file').slice(0, 200), caption: typeof req.body?.caption === 'string' ? req.body.caption : '',
      clientRef: req.body?.client_ref, wallRef: req.body?.wall_ref ? String(req.body.wall_ref) : undefined,
    };
  }).catch((e) => { console.error('waChat.media error:', e); res.status(500).json({ error: 'Could not send. Try again.' }); })
);

router.post('/conversations/:id/template', (req, res) =>
  send(req, res, async () => {
    if (!req.body?.name) return 'Choose a template.';
    const b64 = req.body?.base64 ? String(req.body.base64) : '';
    if (b64.length > Math.ceil((MAX_MEDIA_BYTES * 4) / 3) + 8) return `That file is too large. The limit is ${Math.floor(MAX_MEDIA_BYTES / 1048576)} MB.`;
    return {
      kind: 'template', name: String(req.body.name), language: String(req.body.language ?? 'en'),
      params: Array.isArray(req.body.params) ? req.body.params.map(String) : [], clientRef: req.body?.client_ref,
      wallRef: req.body?.wall_ref ? String(req.body.wall_ref) : undefined,
      file: b64 ? { bytes: Buffer.from(b64, 'base64'), mime: String(req.body?.mime ?? ''), filename: String(req.body?.filename ?? 'file').slice(0, 200) } : undefined,
    };
  }).catch((e) => { console.error('waChat.template error:', e); res.status(500).json({ error: 'Could not send. Try again.' }); })
);

router.get('/templates', async (req, res) => {
  try {
    res.json({ templates: await chatTemplates(req.query.refresh === '1') });
  } catch (e) {
    console.error('waChat.templates error:', (e as Error).message);
    res.status(502).json({ error: 'Could not load the template list from WhatsApp.', templates: [] });
  }
});

// A picture or file in a chat, served by DRM (a private link the browser could not open on its own).
router.get('/messages/:id/media', async (req, res) => {
  if (!idOk(req.params.id)) return res.status(404).json({ error: 'Not found' });
  let m = (await pool.query(`SELECT media_key, media_mime, media_name FROM wa_messages WHERE id = $1`, [req.params.id])).rows[0];
  if (!m) return res.status(404).json({ error: 'Not found' });
  if (!m.media_key) {
    // The copy failed when the message arrived; try once more from the provider's link.
    if (await persistInboundMedia(req.params.id)) {
      m = (await pool.query(`SELECT media_key, media_mime, media_name FROM wa_messages WHERE id = $1`, [req.params.id])).rows[0];
    }
    if (!m?.media_key) return res.status(404).json({ error: 'This file is no longer available.' });
  }
  const bytes = await loadMedia(m.media_key);
  if (!bytes) return res.status(404).json({ error: 'This file is no longer available.' });
  const inline = /^(image\/(jpeg|png|webp)|video\/|audio\/|application\/pdf)/.test(m.media_mime || '');
  res.setHeader('Content-Type', m.media_mime || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${String(m.media_name || 'file').replace(/[^\w.\- ]/g, '_')}"`);
  res.send(bytes);
});

export default router;

/* ------------------------------------------------------------------ webhook */

/**
 * Where the provider's events arrive (forwarded by the WhatsApp CRM, in Meta's format). Public, so it is
 * guarded by a shared secret; with none set it refuses everything. It answers 200 for any body it could
 * read - a retry storm helps nobody - and 401/503 only for the credential.
 */
export const webhookRouter = Router();

function secretOk(given: unknown, want: string): boolean {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

webhookRouter.post('/', async (req, res) => {
  const want = process.env.WA_CHAT_WEBHOOK_SECRET;
  if (!want) return res.status(503).json({ error: 'WhatsApp chat webhook is not configured (WA_CHAT_WEBHOOK_SECRET).' });
  if (!secretOk(req.headers['x-webhook-secret'], want)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const r = await ingestWebhook(req.body);
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error('wa webhook error:', (e as Error).message);
    res.json({ ok: true });
  }
});
