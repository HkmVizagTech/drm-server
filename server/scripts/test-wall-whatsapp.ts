// The seva wall's WhatsApp icon sends the brick's picture and message from DRM.
// Nothing leaves this machine: fetch is replaced by a stand-in for Flaxxa.
//
//   NODE_ENV=development DATABASE_URL=...drm_test npx tsx scripts/test-wall-whatsapp.ts

import '../src/bootTimezone';
process.env.SEVA_WALL_FROM = '2026-01-01';
import express from 'express';
import pool from '../src/db/pool';
import { runMigrations } from '../src/db/migrate';
import { generateToken } from '../src/middleware/auth';
import sevaWallRoutes from '../src/routes/sevaWall';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}
process.env.FLAXXA_TOKEN = 'test-token';
delete process.env.R2_ACCOUNT_ID;
delete process.env.FLAXXA_SEVA_THANKS_TEMPLATE;

const realFetch = globalThis.fetch;
interface Call { url: string; body: unknown; form?: Record<string, unknown> }
const calls: Call[] = [];
let nextId = 7000;
const TEMPLATES = { status: 'success', templates: [{ name: 'seva_thanks_donate', language: 'en', status: 'APPROVED', components: JSON.stringify([{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hare Krishna {{1}}, thank you for your {{2}}.' }]) }] };
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('http://127.0.0.1')) return realFetch(input as never, init);
  if (!url.startsWith('https://wapi.flaxxa.com/')) throw new Error(`test refuses to call ${url}`);
  const call: Call = { url, body: null };
  if (init?.body instanceof FormData) {
    call.form = {};
    init.body.forEach((v, k) => { call.form![k] = v instanceof Blob ? `[file ${v.type} ${v.size}b]` : v; });
  } else if (typeof init?.body === 'string') call.body = JSON.parse(init.body);
  calls.push(call);
  const out = url.includes('/getTemplates') ? TEMPLATES : { status: 'success', message_id: ++nextId, message_wamid: null };
  return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

let failures = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}`, ok ? '' : JSON.stringify(d)?.slice(0, 300));
  if (!ok) failures++;
};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function main() {
  await runMigrations();
  await pool.query(`TRUNCATE wa_messages, wa_conversations, wa_media, seva_wall_pictures, seva_wall_items, people, users RESTART IDENTITY CASCADE`);
  const ADMIN = '11111111-1111-1111-1111-111111111111';
  const ACCT = '33333333-3333-3333-3333-333333333333';
  await pool.query(`INSERT INTO users (id, name, email, password_hash, role) VALUES ($1,'Admin','a@t','x','admin'),($2,'Acct','c@t','x','accountant')`, [ADMIN, ACCT]);
  const item = async (name: string, phone: string, picture: Buffer | null, mime = 'image/png') => {
    const r = await pool.query(
      `INSERT INTO seva_wall_items (donor_name, phone, amount, kind, status, called_at) VALUES ($1,$2,5000,'square','in_review', NOW()) RETURNING id`, [name, phone]);
    if (picture) await pool.query(`INSERT INTO seva_wall_pictures (item_id, mime, data, size_bytes) VALUES ($1,$2,$3,$4)`, [r.rows[0].id, mime, picture, picture.length]);
    return r.rows[0].id as string;
  };
  const a = await item('Ramesh Kumar', '9876543210', PNG);
  const noPic = await item('No Picture', '9876500002', null);
  const noPhone = await item('No Phone', '123', PNG);
  const webp = await item('Web P', '9876500003', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(40)]), 'image/webp');

  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.use('/api/seva-wall', sevaWallRoutes);
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const post = async (ref: string, body: unknown, role = 'admin', uid = ADMIN) => {
    const r = await realFetch(`http://127.0.0.1:${port}/api/seva-wall/${ref}/send-whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${generateToken({ userId: uid, role } as never)}` }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const MSG = 'Hare Krishna, thank you for your Square foot seva.';

  console.log('\n--- the donor has not written: nothing can be sent without a template ---');
  let r = await post(a, { message: MSG });
  check('refused, saying why, with nothing sent', r.status === 409 && r.json.code === 'window_closed' && calls.filter((c) => !c.url.includes('getTemplates')).length === 0, r);

  console.log('\n--- the donor wrote in the last 24 hours: the picture goes with the message ---');
  await pool.query(`INSERT INTO wa_conversations (phone, display_name, last_inbound_at, last_message_at) VALUES ('9876543210', 'Ramesh Kumar', NOW(), NOW()) ON CONFLICT (phone) DO UPDATE SET last_inbound_at = NOW()`);
  calls.length = 0;
  r = await post(a, { message: MSG });
  const c = calls[0];
  check('sent as a picture with the message as its caption', r.status === 200 && r.json.ok === true && c?.url.endsWith('/sendmessagewithattachment') && c.form?.phone === '919876543210' && c.form?.message === MSG && String(c.form?.attachment).startsWith('[file image/png'), { r, c });
  const wm = (await pool.query(`SELECT msg_type, body, status FROM wa_messages ORDER BY created_at DESC LIMIT 1`)).rows[0];
  check('kept in the WhatsApp chat so the donor reply lands there', wm.msg_type === 'image' && wm.body === MSG && wm.status === 'sent', wm);
  const it = (await pool.query(`SELECT whatsapp_sent_at, status FROM seva_wall_items WHERE id = $1`, [a])).rows[0];
  check('the brick is marked "WhatsApp sent", and finished (it had been called)', !!it.whatsapp_sent_at && it.status === 'sent', it);

  console.log('\n--- the checks ---');
  check('an accountant cannot send', (await post(a, { message: MSG }, 'accountant', ACCT)).status === 403);
  r = await post(noPic, { message: MSG });
  check('a brick with no picture is refused', r.status === 409 && r.json.code === 'no_picture', r);
  r = await post(noPhone, { message: MSG });
  check('a donor with no usable phone is refused', r.status === 400, r);
  r = await post(a, { message: '   ' });
  check('an empty message is refused', r.status === 400 && r.json.code === 'empty', r);
  r = await post(a, { message: 'x'.repeat(1025) });
  check('a message over the picture-caption limit is refused, not cut', r.status === 400 && r.json.code === 'too_long', r);
  r = await post('00000000-0000-0000-0000-000000000000', { message: MSG });
  check('an unknown record is a clean 404', r.status === 404, r);
  await pool.query(`INSERT INTO wa_conversations (phone, last_inbound_at, last_message_at) VALUES ('9876500003', NOW(), NOW())`);
  r = await post(webp, { message: MSG });
  check('a WebP picture is turned away (the screen converts it and tries again)', r.status === 422 && r.json.code === 'webp', r);
  calls.length = 0;
  r = await post(webp, { message: MSG, jpeg_base64: PNG.toString('base64') });
  check('with the converted picture it goes', r.status === 200 && calls.some((x) => String(x.form?.attachment).startsWith('[file image/png')), { r, calls });
  await pool.query(`UPDATE wa_conversations SET opted_out = TRUE WHERE phone = '9876543210'`);
  r = await post(a, { message: MSG });
  check('a donor who wrote STOP is not sent anything', r.status === 403 && r.json.code === 'opted_out', r);
  await pool.query(`UPDATE wa_conversations SET opted_out = FALSE WHERE phone = '9876543210'`);

  console.log('\n--- after 24 hours, with an approved picture template ---');
  await pool.query(`UPDATE wa_conversations SET last_inbound_at = NOW() - INTERVAL '3 days' WHERE phone = '9876543210'`);
  const b = await item('Ramesh Kumar', '9876543210', PNG);
  r = await post(b, { message: MSG, seva_label: 'Square foot seva' });
  check('without a template configured it still says so', r.status === 409 && r.json.code === 'window_closed', r);
  process.env.FLAXXA_SEVA_THANKS_TEMPLATE = 'seva_thanks_donate';
  calls.length = 0;
  r = await post(b, { message: MSG, seva_label: 'Square foot seva' });
  const t = calls.find((x) => x.url.endsWith('/sendtemplatemessage_withattachment'));
  check('with it, the template goes with the picture, the donor name and the seva', r.status === 200 && r.json.via === 'template' && t?.form?.template_name === 'seva_thanks_donate' && String(t.form?.header_attachment).startsWith('[file image/png') && JSON.parse(String(t.form?.components))[0].parameters.map((p: { text: string }) => p.text).join('|') === 'Ramesh Kumar|Square foot seva', { r, t });
  process.env.FLAXXA_SEVA_THANKS_TEMPLATE = 'not_a_template';
  r = await post(b, { message: MSG });
  check('a template name Flaxxa does not have is reported, not guessed', r.status === 409, r);

  server.close();
  await pool.end();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await pool.end().catch(() => undefined); process.exit(1); });
