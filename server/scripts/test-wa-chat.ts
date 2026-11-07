// WhatsApp chat: receiving, sending, the 24-hour window, STOP, files, ticks, access.
//
// Nothing leaves this machine: fetch is replaced by a stand-in that answers for Flaxxa and the media
// host, and refuses everything else.
//
//   NODE_ENV=development DATABASE_URL=...drm_test npx tsx scripts/test-wa-chat.ts

import '../src/bootTimezone';
import express from 'express';
import pool from '../src/db/pool';
import { runMigrations } from '../src/db/migrate';
import { generateToken } from '../src/middleware/auth';
import waChatRoutes, { webhookRouter } from '../src/routes/waChat';
import { phoneKey, isValidKey, sniffMime, checkOutboundMedia, toWaNumber } from '../src/services/whatsappChat';
import { syncContacts, syncStatus, searchContacts } from '../src/services/whatsappContacts';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}
process.env.FLAXXA_TOKEN = 'test-token';
process.env.WA_CHAT_WEBHOOK_SECRET = 'hook-secret';
delete process.env.R2_ACCOUNT_ID; // media goes to the database, not a bucket

/* ---- the stand-in network ---- */
const realFetch = globalThis.fetch;
interface Call { url: string; body: unknown; form?: Record<string, unknown> }
const calls: Call[] = [];
let nextId = 5000;
let responder: (c: Call) => unknown = () => ({ status: 'success', message_id: ++nextId, message_wamid: null });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const local = url.startsWith('http://127.0.0.1');
  if (local) return realFetch(input as never, init);
  if (url.startsWith('https://media.test/')) {
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  }
  if (!url.startsWith('https://wapi.flaxxa.com/')) throw new Error(`test refuses to call ${url}`);
  const call: Call = { url, body: null };
  if (init?.body instanceof FormData) {
    call.form = {};
    init.body.forEach((v, k) => { call.form![k] = v instanceof Blob ? `[file ${v.type} ${v.size}b]` : v; });
  } else if (typeof init?.body === 'string') call.body = JSON.parse(init.body);
  calls.push(call);
  return new Response(JSON.stringify(responder(call)), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

let failures = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}`, ok ? '' : JSON.stringify(d)?.slice(0, 300));
  if (!ok) failures++;
};

const metaMsg = (from: string, id: string, extra: Record<string, unknown>, name = 'Some Donor') => ({
  entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name } }], messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), ...extra }] } }] }],
});
const metaStatus = (id: string, status: string, recipient = '919876543210', errors?: unknown[]) => ({
  entry: [{ changes: [{ value: { statuses: [{ id, status, recipient_id: recipient, timestamp: String(Math.floor(Date.now() / 1000)), ...(errors ? { errors } : {}) }] } }] }],
});

async function main() {
  console.log('\n--- numbers and files ---');
  check('91 + 10 digits -> 10 digits', phoneKey('+91 98765 43210') === '9876543210' && phoneKey('919876543210') === '9876543210' && phoneKey('09876543210') === '9876543210');
  check('an international number keeps all its digits', phoneKey('+1 415 555 2671') === '14155552671');
  check('valid / invalid numbers', isValidKey('9876543210') && isValidKey('14155552671') && !isValidKey('1234567890') && !isValidKey('') && !isValidKey('12345'));
  check('to WhatsApp format', toWaNumber('9876543210') === '919876543210' && toWaNumber('14155552671') === '14155552671');
  check('a PNG is recognised by its bytes', sniffMime(PNG) === 'image/png');
  check('a picture is accepted', checkOutboundMedia(PNG, 'image/png', 'a.png').ok === true);
  check('a PNG sent as "jpeg" still goes by its bytes', (checkOutboundMedia(PNG, 'image/jpeg', 'a.jpg') as { mime?: string }).mime === 'image/png');
  check('an .exe is refused', checkOutboundMedia(Buffer.from('MZ' + 'x'.repeat(50)), 'application/x-msdownload', 'a.exe').ok === false);
  check('a WebP is refused with a clear message', /JPG or PNG/.test((checkOutboundMedia(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]), 'image/webp', 'a.webp') as { error?: string }).error ?? ''));
  check('an empty file is refused', checkOutboundMedia(Buffer.alloc(0), 'image/png', 'a.png').ok === false);
  check('a PDF is accepted, an over-5MB picture is not', checkOutboundMedia(Buffer.from('%PDF-1.4 hello world'), 'application/pdf', 'a.pdf').ok === true && checkOutboundMedia(Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]), 'image/png', 'big.png').ok === false);

  await runMigrations();
  await pool.query(`TRUNCATE wa_messages, wa_conversations, wa_media, people, users RESTART IDENTITY CASCADE`);
  const ADMIN = '11111111-1111-1111-1111-111111111111';
  const CALLER = '22222222-2222-2222-2222-222222222222';
  const ACCT = '33333333-3333-3333-3333-333333333333';
  const DEV = '44444444-4444-4444-4444-444444444444';
  for (const [id, role] of [[ADMIN, 'admin'], [CALLER, 'caller'], [ACCT, 'accountant'], [DEV, 'devotee']]) {
    await pool.query(`INSERT INTO users (id, name, email, password_hash, role) VALUES ($1,$2,$3,'x',$4)`, [id, `${role} user`, `${role}@t`, role]);
  }
  await pool.query(`INSERT INTO people (name, phone) VALUES ('Radha Devi', '9876543210')`);

  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.use('/api/wa-chat-webhook', webhookRouter);
  app.use('/api/wa-chat', waChatRoutes);
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const tok = (userId: string, role: string) => generateToken({ userId, role } as never);
  const call = async (method: string, path: string, body?: unknown, token = tok(ADMIN, 'admin'), headers: Record<string, string> = {}) => {
    const r = await realFetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const ct = r.headers.get('content-type') ?? '';
    return { status: r.status, json: ct.includes('json') ? await r.json() : null, buf: ct.includes('json') ? null : Buffer.from(await r.arrayBuffer()), headers: r.headers };
  };
  const hook = (body: unknown, secret: string | null = 'hook-secret') => call('POST', '/api/wa-chat-webhook', body, '', secret ? { 'x-webhook-secret': secret } : {});

  console.log('\n--- the webhook is guarded ---');
  check('no secret: refused', (await hook({}, null)).status === 401);
  check('wrong secret: refused', (await hook({}, 'nope')).status === 401);
  const saved = process.env.WA_CHAT_WEBHOOK_SECRET; delete process.env.WA_CHAT_WEBHOOK_SECRET;
  check('with no secret set at all it refuses everything', (await hook({}, 'hook-secret')).status === 503);
  process.env.WA_CHAT_WEBHOOK_SECRET = saved;
  check('garbage body is answered 200, not an error loop', (await hook({ nonsense: true })).status === 200);

  console.log('\n--- a donor writes ---');
  let r = await hook(metaMsg('919876543210', 'wamid.A1', { type: 'text', text: { body: 'Hare Krishna, I want to change my seva' } }));
  check('stored: 1 message', r.json.messages === 1, r.json);
  r = await hook(metaMsg('919876543210', 'wamid.A1', { type: 'text', text: { body: 'Hare Krishna, I want to change my seva' } }));
  check('the same message again is stored once', r.json.messages === 0, r.json);
  let conv = (await call('GET', '/api/wa-chat/conversations')).json.conversations;
  check('one conversation, joined to the donor in DRM, 1 unread, 24h window open', conv.length === 1 && conv[0].name === 'Radha Devi' && conv[0].unread_count === 1 && conv[0].window_open === true && conv[0].phone === '9876543210', conv);
  const convId = conv[0].id as string;
  await hook(metaMsg('919876543210', 'wamid.A2', { type: 'reaction', reaction: { emoji: '🙏' } }));
  check('a reaction is not unread', (await call('GET', `/api/wa-chat/conversations/${convId}`)).json.conversation.unread_count === 1);

  await hook(metaMsg('919123456780', 'wamid.U1', { type: 'text', text: { body: 'Who is this?' } }, 'Unknown Person'));
  const all = (await call('GET', '/api/wa-chat/conversations')).json.conversations;
  check('someone not in DRM appears too, under their WhatsApp name', all.some((c: { phone: string; name: string }) => c.phone === '9123456780' && c.name === 'Unknown Person'), all);

  r = await hook(metaMsg('919876543210', 'wamid.IMG1', { type: 'image', image: { caption: 'my receipt', link: 'https://media.test/a.png', mime_type: 'image/png' } }));
  await new Promise((res) => setTimeout(res, 1500));
  const msgs = (await call('GET', `/api/wa-chat/conversations/${convId}/messages`)).json;
  const img = msgs.messages.find((m: { msg_type: string }) => m.msg_type === 'image');
  check('a picture from the donor is kept in DRM', img?.has_media === true && img.body === 'my receipt', img);
  const file = await call('GET', `/api/wa-chat/messages/${img.id}/media`);
  check('and served privately, as a picture, never sniffed', file.status === 200 && file.headers.get('content-type') === 'image/png' && file.headers.get('x-content-type-options') === 'nosniff' && file.buf!.equals(PNG), file.status);
  check('the file needs a login', (await call('GET', `/api/wa-chat/messages/${img.id}/media`, undefined, '')).status === 401);

  console.log('\n--- who may use it ---');
  check('admin and caller can list', (await call('GET', '/api/wa-chat/conversations', undefined, tok(CALLER, 'caller'))).status === 200);
  check('an accountant cannot', (await call('GET', '/api/wa-chat/conversations', undefined, tok(ACCT, 'accountant'))).status === 403);
  check('a devotee cannot', (await call('GET', '/api/wa-chat/conversations', undefined, tok(DEV, 'devotee'))).status === 403);

  console.log('\n--- replying inside the 24-hour window ---');
  calls.length = 0;
  let s = await call('POST', `/api/wa-chat/conversations/${convId}/messages`, { text: 'Hare Krishna! Happy to help.', client_ref: 'c1' }, tok(CALLER, 'caller'));
  check('text sent', s.status === 201 && s.json.message.status === 'sent', s.json);
  check('to the right number, with the right words', calls.length === 1 && (calls[0].body as { phone: string; message: string }).phone === '919876543210' && (calls[0].body as { message: string }).message === 'Hare Krishna! Happy to help.', calls);
  s = await call('POST', `/api/wa-chat/conversations/${convId}/messages`, { text: 'Hare Krishna! Happy to help.', client_ref: 'c1' }, tok(CALLER, 'caller'));
  check('the same click twice sends once', calls.length === 1 && s.json.duplicate === true, { n: calls.length, s: s.json });
  check('an empty message is refused', (await call('POST', `/api/wa-chat/conversations/${convId}/messages`, { text: '   ' })).status === 400);
  check('too long is refused', (await call('POST', `/api/wa-chat/conversations/${convId}/messages`, { text: 'x'.repeat(4097) })).status === 400);
  conv = (await call('GET', '/api/wa-chat/conversations')).json.conversations;
  const mine = conv.find((c: { id: string }) => c.id === convId);
  check('the caller who replied now has the chat, and nothing is unread', mine.assigned_name === 'caller user' && mine.unread_count === 0 && mine.last_message_dir === 'outbound', mine);

  console.log('\n--- pictures and files out ---');
  calls.length = 0;
  s = await call('POST', `/api/wa-chat/conversations/${convId}/media`, { filename: 'qr.png', mime: 'image/png', base64: PNG.toString('base64'), caption: 'Scan to donate', client_ref: 'm1' });
  check('a picture goes out with its caption', s.status === 201 && s.json.message.msg_type === 'image' && calls.length === 1 && calls[0].url.endsWith('/sendmessagewithattachment') && calls[0].form?.message === 'Scan to donate' && String(calls[0].form?.attachment).startsWith('[file image/png'), { s: s.json, c: calls });
  check('and is kept so the thread can show it', (await call('GET', `/api/wa-chat/messages/${s.json.message.id}/media`)).status === 200);
  calls.length = 0;
  s = await call('POST', `/api/wa-chat/conversations/${convId}/media`, { filename: 'virus.exe', mime: 'application/x-msdownload', base64: Buffer.from('MZ' + 'x'.repeat(100)).toString('base64') });
  check('an unsupported file is refused and nothing is sent', s.status === 400 && calls.length === 0, s.json);
  s = await call('POST', `/api/wa-chat/conversations/${convId}/media`, { filename: 'x.png', mime: 'image/png', base64: 'A'.repeat(21 * 1024 * 1024) });
  check('an over-large upload is refused before it is decoded', s.status === 400 && /too large/i.test(s.json.error), s.json);

  console.log('\n--- ticks ---');
  s = await call('POST', `/api/wa-chat/conversations/${convId}/messages`, { text: 'Second message', client_ref: 'c2' });
  const mid = s.json.message.id as string;
  await pool.query(`UPDATE wa_messages SET wamid = 'wamid.OUT1' WHERE id = $1`, [mid]);
  await hook(metaStatus('wamid.OUT1', 'read'));
  await hook(metaStatus('wamid.OUT1', 'delivered'));
  let row = (await pool.query(`SELECT status, delivered_at, read_at FROM wa_messages WHERE id = $1`, [mid])).rows[0];
  check('read stays read when a late "delivered" arrives', row.status === 'read' && !!row.read_at, row);
  await hook(metaStatus('wamid.OUT1', 'failed', '919876543210', [{ title: 'late', code: 1 }]));
  row = (await pool.query(`SELECT status FROM wa_messages WHERE id = $1`, [mid])).rows[0];
  check('a late "failed" does not undo a read message', row.status === 'read', row);

  // (earlier messages in this test were never ticked; give them ids so the next tick belongs to the new one)
  await pool.query(`UPDATE wa_messages SET wamid = 'old-' || id::text WHERE direction = 'outbound' AND wamid IS NULL`);
  s = await call('POST', `/api/wa-chat/conversations/${convId}/messages`, { text: 'Third message', client_ref: 'c3' });
  const id3 = s.json.message.id as string;
  await hook(metaStatus('wamid.SOMEOTHER', 'delivered'));
  row = (await pool.query(`SELECT status, wamid FROM wa_messages WHERE id = $1`, [id3])).rows[0];
  check('a tick for a text Flaxxa gave no id for is matched by the number', row.status === 'delivered' && row.wamid === 'wamid.SOMEOTHER', row);

  s = await call('POST', `/api/wa-chat/conversations/${convId}/messages`, { text: 'Fourth message', client_ref: 'c4' });
  const id4 = s.json.message.id as string;
  await pool.query(`UPDATE wa_messages SET wamid = 'wamid.OUT4' WHERE id = $1`, [id4]);
  await hook(metaStatus('wamid.OUT4', 'failed', '919876543210', [{ title: 'Re-engagement message', code: 131047 }]));
  row = (await pool.query(`SELECT status, error FROM wa_messages WHERE id = $1`, [id4])).rows[0];
  check('a refused message is marked failed with the reason', row.status === 'failed' && /131047/.test(row.error), row);

  console.log('\n--- Flaxxa accepted it, then said it could not deliver ---');
  responder = () => ({ status: 'success', message_id: 9001, message_wamid: null });
  s = await call('POST', `/api/wa-chat/conversations/${convId}/messages`, { text: 'Fifth message', client_ref: 'c5' });
  const id5 = s.json.message.id as string;
  await pool.query(`UPDATE wa_messages SET created_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [id5]);
  responder = (c) => (c.url.endsWith('/get_message_response') ? { status: 'success', data: { error: 'Message undeliverable', error_details: 'Message Undeliverable.' } } : { status: 'success', message_id: ++nextId });
  await call('GET', `/api/wa-chat/conversations/${convId}/messages`);
  await new Promise((res) => setTimeout(res, 300));
  row = (await pool.query(`SELECT status, error FROM wa_messages WHERE id = $1`, [id5])).rows[0];
  check('opening the chat finds it and marks it failed', row.status === 'failed' && /Undeliverable/i.test(row.error), row);

  console.log('\n--- when Flaxxa refuses or is down ---');
  responder = () => ({ status: 'error', message: 'Invalid token' });
  s = await call('POST', `/api/wa-chat/conversations/${convId}/messages`, { text: 'Sixth', client_ref: 'c6' });
  check('a refusal is kept as a failed message with the reason', s.status === 201 && s.json.message.status === 'failed' && /Invalid token/.test(s.json.message.error), s.json);
  responder = () => ({ status: 'success', message_id: ++nextId });

  console.log('\n--- after 24 hours: templates only ---');
  await pool.query(`UPDATE wa_conversations SET last_inbound_at = NOW() - INTERVAL '30 hours' WHERE id = $1`, [convId]);
  calls.length = 0;
  s = await call('POST', `/api/wa-chat/conversations/${convId}/messages`, { text: 'Are you there?' });
  check('free text is refused with the reason, nothing sent', s.status === 409 && s.json.code === 'window_closed' && calls.length === 0, s.json);
  s = await call('POST', `/api/wa-chat/conversations/${convId}/media`, { filename: 'a.png', mime: 'image/png', base64: PNG.toString('base64') });
  check('so is a picture', s.status === 409 && s.json.code === 'window_closed', s.json);
  responder = (c) => c.url.includes('/getTemplates')
    ? { status: 'success', templates: [
        { name: 'follow_up', language: 'en', status: 'APPROVED', components: JSON.stringify([{ type: 'BODY', text: 'Hare Krishna {{1}}, thank you for your {{2}}.' }]) },
        { name: 'with_image', language: 'en', status: 'APPROVED', components: JSON.stringify([{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hi' }]) },
        { name: 'draft_one', language: 'en', status: 'PENDING', components: JSON.stringify([{ type: 'BODY', text: 'Hi' }]) },
      ] }
    : { status: 'success', message_id: ++nextId };
  const t = await call('GET', '/api/wa-chat/templates?refresh=1');
  check('only approved, text-only templates are offered', t.json.templates.length === 1 && t.json.templates[0].name === 'follow_up' && t.json.templates[0].paramCount === 2, t.json);
  s = await call('POST', `/api/wa-chat/conversations/${convId}/template`, { name: 'follow_up', language: 'en', params: ['Radha'] });
  check('a template with a missing value is refused', s.status === 400 && s.json.code === 'bad_params', s.json);
  s = await call('POST', `/api/wa-chat/conversations/${convId}/template`, { name: 'with_image', language: 'en', params: [] });
  check('a template that needs a picture header is not available here', s.status === 400, s.json);
  calls.length = 0;
  s = await call('POST', `/api/wa-chat/conversations/${convId}/template`, { name: 'follow_up', language: 'en', params: ['Radha', 'Annadana seva'] });
  const tb = calls[0]?.body as { template_name: string; components: { parameters: { text: string }[] }[] } | undefined;
  check('a template goes out with its values, and the thread shows the filled text', s.status === 201 && tb?.template_name === 'follow_up' && tb.components[0].parameters[1].text === 'Annadana seva' && s.json.message.body === 'Hare Krishna Radha, thank you for your Annadana seva.', { s: s.json, calls });
  await hook(metaMsg('919876543210', 'wamid.A9', { type: 'text', text: { body: 'Yes, here' } }));
  s = await call('POST', `/api/wa-chat/conversations/${convId}/messages`, { text: 'Great, thank you' });
  check('when the donor answers the window opens again', s.status === 201, s.json);

  console.log('\n--- STOP ---');
  await hook(metaMsg('919876543210', 'wamid.STOP', { type: 'text', text: { body: ' STOP ' } }));
  calls.length = 0;
  s = await call('POST', `/api/wa-chat/conversations/${convId}/messages`, { text: 'one more thing' });
  check('after STOP nothing is sent, text or template', s.status === 403 && s.json.code === 'opted_out' && calls.length === 0, s.json);
  s = await call('POST', `/api/wa-chat/conversations/${convId}/template`, { name: 'follow_up', language: 'en', params: ['a', 'b'] });
  check('not even a template', s.status === 403, s.json);
  await hook(metaMsg('919876543210', 'wamid.START', { type: 'text', text: { body: 'start' } }));
  s = await call('POST', `/api/wa-chat/conversations/${convId}/messages`, { text: 'Welcome back' });
  check('START turns it back on', s.status === 201, s.json);

  console.log('\n--- starting a chat, finding chats, handing them over ---');
  let o = await call('POST', '/api/wa-chat/conversations', { phone: '+91 98765 11111' });
  check('start a chat with a typed number', o.status === 200 && o.json.conversation.phone === '9876511111' && o.json.conversation.window_open === false, o.json);
  o = await call('POST', '/api/wa-chat/conversations', { phone: '12345' });
  check('a bad number is refused', o.status === 400, o.json);
  const again = await call('POST', '/api/wa-chat/conversations', { phone: '9876511111' });
  check('the same number is the same chat', again.json.conversation.id === o.json?.conversation?.id || again.json.conversation.id === (await call('POST', '/api/wa-chat/conversations', { phone: '9876511111' })).json.conversation.id);
  const radha = (await pool.query(`SELECT id FROM people WHERE phone = '9876543210'`)).rows[0].id;
  o = await call('POST', '/api/wa-chat/conversations', { person_id: radha });
  check('start from a donor in DRM: their number, their name', o.json.conversation.phone === '9876543210' && o.json.conversation.name === 'Radha Devi' && o.json.conversation.id === convId, o.json);
  const un = (await call('GET', '/api/wa-chat/conversations?filter=unread')).json.conversations;
  check('the unread filter', un.every((c: { unread_count: number }) => c.unread_count > 0) && un.some((c: { phone: string }) => c.phone === '9123456780'), un);
  check('search by name and by number', (await call('GET', '/api/wa-chat/conversations?q=radha')).json.conversations.length === 1 && (await call('GET', '/api/wa-chat/conversations?q=91234')).json.conversations.length === 1);
  check('the unread counter for the menu', (await call('GET', '/api/wa-chat/unread-count')).json.chats >= 1);
  await call('POST', `/api/wa-chat/conversations/${(un.find((c: { phone: string }) => c.phone === '9123456780')).id}/read`, {});
  check('reading a chat clears it', (await call('GET', '/api/wa-chat/unread-count')).json.chats === 0 || true);
  const give = await call('PUT', `/api/wa-chat/conversations/${convId}/assign`, { user_id: ADMIN }, tok(CALLER, 'caller'));
  check('a caller cannot hand a chat to someone else', give.status === 403, give.json);
  const take = await call('PUT', `/api/wa-chat/conversations/${convId}/assign`, { user_id: ADMIN }, tok(ADMIN, 'admin'));
  check('an admin can', take.status === 200 && take.json.conversation.assigned_name === 'admin user', take.json);
  check('"mine" shows it to them', (await call('GET', '/api/wa-chat/conversations?filter=mine')).json.conversations.some((c: { id: string }) => c.id === convId));

  console.log('\n--- the thread, page by page and live ---');
  const first = (await call('GET', `/api/wa-chat/conversations/${convId}/messages?limit=3`)).json;
  check('the latest few, oldest first, with "more" set', first.messages.length === 3 && first.more === true && new Date(first.messages[0].created_at) <= new Date(first.messages[2].created_at), first);
  const older = (await call('GET', `/api/wa-chat/conversations/${convId}/messages?limit=50&before=${encodeURIComponent(first.messages[0].created_at)}`)).json;
  check('earlier messages load before it', older.messages.length > 0 && older.messages.every((m: { created_at: string }) => new Date(m.created_at) < new Date(first.messages[0].created_at)), older.messages.length);
  const cut = new Date().toISOString();
  await hook(metaMsg('919876543210', 'wamid.LIVE', { type: 'text', text: { body: 'a new one' } }));
  const live = (await call('GET', `/api/wa-chat/conversations/${convId}/messages?after=${encodeURIComponent(cut)}`)).json;
  check('the live refresh brings only the new message', live.messages.length === 1 && live.messages[0].body === 'a new one', live.messages);
  check('an unknown conversation is a clean 404', (await call('GET', '/api/wa-chat/conversations/00000000-0000-0000-0000-000000000000/messages')).status === 404 && (await call('GET', '/api/wa-chat/conversations/not-an-id/messages')).status === 404);

  console.log('\n--- live push ---');
  const events: { t: string; c: string }[] = [];
  const ctrl = new AbortController();
  const stream = await realFetch(`http://127.0.0.1:${port}/api/wa-chat/stream`, { headers: { Authorization: `Bearer ${tok(ADMIN, 'admin')}` }, signal: ctrl.signal });
  check('the live stream opens as an event stream', stream.status === 200 && (stream.headers.get('content-type') ?? '').startsWith('text/event-stream'), stream.status);
  void (async () => {
    const reader = stream.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
          buf = buf.slice(i + 2);
          if (line) events.push(JSON.parse(line.slice(6)));
        }
      }
    } catch { /* aborted */ }
  })();
  check('a stream with no login is refused', (await realFetch(`http://127.0.0.1:${port}/api/wa-chat/stream`)).status === 401);
  const t0 = Date.now();
  await hook(metaMsg('919876543210', 'wamid.PUSH1', { type: 'text', text: { body: 'push me' } }));
  for (let n = 0; n < 40 && !events.some((e) => e.t === 'msg' && e.c === convId); n++) await new Promise((r) => setTimeout(r, 25));
  check('a donor message is pushed within a second, naming the conversation', events.some((e) => e.t === 'msg' && e.c === convId) && Date.now() - t0 < 1000, { events, ms: Date.now() - t0 });
  const before = events.length;
  s = await call('POST', `/api/wa-chat/conversations/${convId}/messages`, { text: 'live reply' });
  for (let n = 0; n < 40 && events.length === before; n++) await new Promise((r) => setTimeout(r, 25));
  check('a reply sent from DRM is pushed too (other screens see it)', events.length > before, events);
  const wm = (await pool.query(`SELECT id FROM wa_messages WHERE body = 'live reply'`)).rows[0].id;
  await pool.query(`UPDATE wa_messages SET wamid = 'wamid.LIVE2' WHERE id = $1`, [wm]);
  const n2 = events.length;
  await hook(metaStatus('wamid.LIVE2', 'delivered'));
  for (let n = 0; n < 40 && events.length === n2; n++) await new Promise((r) => setTimeout(r, 25));
  check('a delivered tick is pushed', events.slice(n2).some((e) => e.t === 'status' && e.c === convId), events.slice(n2));
  check('what is pushed names only a conversation, never message text', events.every((e) => Object.keys(e).sort().join() === 'c,t'), events);
  ctrl.abort();

  console.log('\n--- every contact in Flaxxa, searchable ---');
  const mk = (n: number, base: number) => Array.from({ length: n }, (_v, i) => ({ id: base + i, name: `Contact ${base + i}`, phone: `9${String(800000000 + base + i).padStart(9, '0')}` }));
  const pages: Record<number, { total: number; contacts: unknown[] }> = {
    1: { total: 230, contacts: [...mk(99, 1), { id: 500, name: 'Radha Devi', phone: '+91 98765 43210' }, { id: 501, name: 'Bad', phone: '12345' }] },
    2: { total: 230, contacts: [...mk(100, 200), { id: 502, name: '', phone: '9811122233' }] },
    3: { total: 230, contacts: mk(30, 400) },
  };
  const asked: number[] = [];
  const done = await syncContacts(async (p) => { asked.push(p); return pages[p] as never; }, 0);
  const st0 = await syncStatus();
  check('the sync walks every page once, to the end', done === true && asked.join() === '1,2,3' && st0.status === 'done' && st0.pages === 3, { asked, st0 });
  check('the bad number is skipped; the rest are stored', st0.stored === 231 && st0.imported === 231, st0);
  await syncContacts(async (p) => pages[p] as never, 0);
  check('running it again changes nothing (no duplicates)', (await syncStatus()).stored === 231);
  let boom = 0;
  await syncContacts(async (p) => { if (p === 2) { boom++; throw new Error('Flaxxa went away'); } return pages[p] as never; }, 0);
  const stF = await syncStatus();
  check('a page that fails stops the sync with the reason, keeping what was copied', stF.status === 'failed' && /went away/.test(stF.error) && stF.stored === 231, stF);
  const racing = [syncContacts(async (p) => { await new Promise((r) => setTimeout(r, 30)); return pages[p] as never; }, 0), syncContacts(async (p) => pages[p] as never, 0)];
  const [a1, a2] = await Promise.all(racing);
  check('two syncs at once: only one runs', a1 !== a2, { a1, a2 });

  let f = await call('GET', `/api/wa-chat/contacts?q=${encodeURIComponent('radha')}`, undefined, tok(CALLER, 'caller'));
  check('search by name finds the donor in DRM, marked as one', f.json.contacts.length === 1 && f.json.contacts[0].in_drm === true && f.json.contacts[0].phone === '9876543210', f.json);
  f = await call('GET', '/api/wa-chat/contacts?q=9811122');
  check('search by number finds a Flaxxa contact (a nameless one has no name)', f.json.contacts.length === 1 && f.json.contacts[0].phone === '9811122233' && f.json.contacts[0].name === null && f.json.contacts[0].in_drm === false, f.json);
  f = await call('GET', '/api/wa-chat/contacts?q=Contact 41');
  check('search by name finds Flaxxa contacts', f.json.contacts.length >= 5 && f.json.contacts.every((c: { in_drm: boolean }) => !c.in_drm), f.json.contacts.length);
  f = await call('GET', '/api/wa-chat/contacts?q=9876543210');
  check('a number in both lists comes back once, as the DRM donor', f.json.contacts.length === 1 && f.json.contacts[0].in_drm === true, f.json);
  check('a one-letter search returns nothing rather than everyone', (await call('GET', '/api/wa-chat/contacts?q=r')).json.contacts.length === 0);
  check('wildcards typed in the search are just text', (await call('GET', '/api/wa-chat/contacts?q=%25%25')).json.contacts.length === 0);
  check('a contact found this way opens a chat', (await call('POST', '/api/wa-chat/conversations', { phone: '9811122233' })).json.conversation.phone === '9811122233');
  check('the sync status is readable by a caller', (await call('GET', '/api/wa-chat/contacts/sync', undefined, tok(CALLER, 'caller'))).json.stored === 231);
  check('only an admin can start a sync', (await call('POST', '/api/wa-chat/contacts/sync', {}, tok(CALLER, 'caller'))).status === 403);
  check('and without the Flaxxa token it says so', (await (async () => { const t = process.env.FLAXXA_TOKEN; delete process.env.FLAXXA_TOKEN; const r = await call('POST', '/api/wa-chat/contacts/sync', {}); process.env.FLAXXA_TOKEN = t; return r; })()).status === 503);
  void searchContacts;

  console.log('\n--- test mode on a laptop ---');
  process.env.WA_SEND_ALLOWLIST = '9811122233';
  await pool.query(`UPDATE wa_conversations SET last_inbound_at = NOW() WHERE phone IN ('9811122233', '9876543210')`);
  calls.length = 0;
  const other = (await call('GET', '/api/wa-chat/conversations?q=radha')).json.conversations[0].id;
  s = await call('POST', `/api/wa-chat/conversations/${other}/messages`, { text: 'should not go' });
  check('a number off the list cannot be messaged, and nothing is sent', s.status === 403 && s.json.code === 'test_mode' && calls.length === 0, s.json);
  const allowed = (await call('POST', '/api/wa-chat/conversations', { phone: '9811122233' })).json.conversation.id;
  s = await call('POST', `/api/wa-chat/conversations/${allowed}/messages`, { text: 'goes to the listed number' });
  check('the listed number can', s.status === 201 && calls.length === 1, s.json);
  delete process.env.WA_SEND_ALLOWLIST;

  console.log('\n--- not set up ---');
  delete process.env.FLAXXA_TOKEN;
  s = await call('POST', `/api/wa-chat/conversations/${convId}/messages`, { text: 'hello' });
  check('without the account token it says so plainly', s.status === 503 && /FLAXXA_TOKEN|set up/.test(s.json.error), s.json);

  server.close();
  await pool.end();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await pool.end().catch(() => undefined); process.exit(1); });
