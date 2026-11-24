// "Old WhatsApp chats and messages are not in DRM."
//
// The copy of the WhatsApp CRM's old chats into DRM (services/waHistoryImport.ts), with a stand-in for the CRM's
// database: nothing here can reach the real one.
//
//   DATABASE_URL=postgresql://localhost/drm_test npx tsx scripts/test-wa-history-import.ts

import '../src/bootTimezone';
import pool from '../src/db/pool';
import { runMigrations } from '../src/db/migrate';
import { importHistory, importStatus, type CrmMessage, type HistorySource } from '../src/services/waHistoryImport';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

let failures = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}`, ok ? '' : JSON.stringify(d)?.slice(0, 500));
  if (!ok) failures++;
};

let n = 0;
const msg = (o: Partial<CrmMessage> & { contactPhone: string; sentAt: string }): CrmMessage => ({
  _id: `crm${String(++n).padStart(6, '0')}`,
  direction: 'inbound',
  type: 'text',
  status: 'received',
  ...o,
});
const source = (rows: CrmMessage[]): HistorySource => ({
  count: async () => rows.length,
  messages: async function* () { yield* rows; },
  close: async () => undefined,
});

async function main() {
  await runMigrations();
  await pool.query(`TRUNCATE wa_messages, wa_conversations, people RESTART IDENTITY CASCADE`);
  const donor = (await pool.query(`INSERT INTO people (name, phone) VALUES ('Ramesh Varma', '9000000001') RETURNING id`)).rows[0].id;

  // A chat DRM already holds from the live link: its newest message is NEWER than everything the CRM has.
  const live = (await pool.query(
    `INSERT INTO wa_conversations (phone, display_name, last_message_at, last_message_text, last_message_dir, last_inbound_at, unread_count)
     VALUES ('9000000002', 'Live Donor', '2026-11-20T10:00:00Z', 'a live message', 'inbound', '2026-11-20T10:00:00Z', 2) RETURNING id`
  )).rows[0].id;
  await pool.query(
    `INSERT INTO wa_messages (conversation_id, direction, msg_type, body, wamid, status, created_at) VALUES ($1, 'inbound', 'text', 'a live message', 'wamid.LIVE', 'received', '2026-11-20T10:00:00Z')`,
    [live]
  );

  const rows: CrmMessage[] = [
    msg({ contactPhone: '919000000001', contactName: 'Ramesh', body: 'Hare Krishna', sentAt: '2026-07-01T10:00:00Z', wamid: 'wamid.A1' }),
    msg({ contactPhone: '919000000001', direction: 'outbound', status: 'read', body: 'Hare Krishna Ramesh Ji', sentAt: '2026-07-01T10:01:00Z', wamid: 'wamid.A2', deliveredAt: '2026-07-01T10:01:05Z', readAt: '2026-07-01T10:02:00Z' }),
    msg({ contactPhone: '919000000001', type: 'image', body: '📷 Photo', mimeType: 'image/jpeg', sentAt: '2026-07-02T09:00:00Z', wamid: 'wamid.A3' }),
    msg({ contactPhone: '919000000001', type: 'reaction', body: '🙏', sentAt: '2026-07-03T09:00:00Z', wamid: 'wamid.A4' }),
    msg({ contactPhone: '919000000001', direction: 'outbound', status: 'draft', body: 'an AI draft nobody sent', sentAt: '2026-07-03T09:30:00Z' }),
    msg({ contactPhone: '919000000001', direction: 'outbound', status: 'sent', body: 'sent with no WhatsApp id', sentAt: '2026-07-04T09:00:00Z' }),
    msg({ contactPhone: '919000000001', type: 'list_reply', body: 'chose Annadanam', sentAt: '2026-07-05T09:00:00Z', wamid: 'wamid.A5' }),
    // already in DRM through the live link - an older echo of the same WhatsApp message
    msg({ contactPhone: '919000000002', body: 'a live message', sentAt: '2026-11-20T10:00:00Z', wamid: 'wamid.LIVE' }),
    msg({ contactPhone: '919000000002', body: 'earlier hello', sentAt: '2026-08-01T10:00:00Z', wamid: 'wamid.B1' }),
    // a donor who asked not to be messaged
    msg({ contactPhone: '919000000003', body: 'hello', sentAt: '2026-08-02T10:00:00Z', wamid: 'wamid.C1' }),
    msg({ contactPhone: '919000000003', body: ' STOP ', sentAt: '2026-08-03T10:00:00Z', wamid: 'wamid.C2' }),
    msg({ contactPhone: '123', body: 'not a phone number', sentAt: '2026-08-03T10:00:00Z' }),
  ];

  console.log('\n1. the first copy');
  await importHistory(source(rows));
  const st = await importStatus();
  check('it finishes', st.status === 'done' && !st.error, st);
  check('it saw every message the CRM held', st.total === rows.length && st.scanned === rows.length, st);
  check('a draft nobody sent is left out', st.drafts === 1, st);
  check('a message already in DRM through the live link is not copied again', (await pool.query(`SELECT COUNT(*)::int AS n FROM wa_messages WHERE wamid = 'wamid.LIVE'`)).rows[0].n === 1);
  check('a message from a number that is not a phone number is skipped', st.skipped === 2, st);
  check('the rest are copied', st.imported === rows.length - 3, st);

  console.log('\n2. a donor\'s chat');
  const c1 = (await pool.query(`SELECT * FROM wa_conversations WHERE phone = '9000000001'`)).rows[0];
  check('it is joined to the donor DRM knows', c1.person_id === donor && c1.display_name === 'Ramesh Varma', c1);
  const m1 = (await pool.query(`SELECT direction, msg_type, body, status, wamid, legacy_id, delivered_at, read_at FROM wa_messages WHERE conversation_id = $1 ORDER BY created_at`, [c1.id])).rows;
  check('every message is there, oldest first', m1.map((m: any) => m.body).join('|') === 'Hare Krishna|Hare Krishna Ramesh Ji|📷 Photo|🙏|sent with no WhatsApp id|chose Annadanam', m1.map((m: any) => m.body));
  check('who said what', m1[0].direction === 'inbound' && m1[1].direction === 'outbound');
  check('ticks come with it', m1[1].status === 'read' && m1[1].delivered_at && m1[1].read_at, m1[1]);
  check('an inbound message is "received"', m1[0].status === 'received');
  check('a type DRM has no word for is kept as "other"', m1[5].msg_type === 'other', m1[5]);
  check('the copy remembers the CRM\'s own id', m1.every((m: any) => /^crm\d{6}$/.test(m.legacy_id)));
  const pic = (await pool.query(`SELECT media_key, media_src_url, media_mime FROM wa_messages WHERE conversation_id = $1 AND msg_type = 'image'`, [c1.id])).rows[0];
  check('a picture is kept as a picture, with no file behind it (the CRM never saved one)', pic.media_key === null && pic.media_src_url === null && pic.media_mime === 'image/jpeg', pic);
  check('the chat\'s last line is the newest message', c1.last_message_text === 'chose Annadanam' && c1.last_message_dir === 'inbound', c1);
  check('the 24-hour window is the donor\'s last real message, not their reaction or a draft', new Date(c1.last_inbound_at).toISOString() === '2026-07-05T09:00:00.000Z', c1.last_inbound_at);
  check('nothing is marked unread', c1.unread_count === 0, c1);

  console.log('\n3. a chat DRM already had');
  const c2 = (await pool.query(`SELECT * FROM wa_conversations WHERE phone = '9000000002'`)).rows[0];
  check('an old message does not push the newer live one out of the way', c2.last_message_text === 'a live message' && new Date(c2.last_message_at).toISOString() === '2026-11-20T10:00:00.000Z', c2);
  check('its unread count is left alone', c2.unread_count === 2, c2);
  check('the older message is now above it in the chat', (await pool.query(`SELECT COUNT(*)::int AS n FROM wa_messages WHERE conversation_id = $1`, [c2.id])).rows[0].n === 2);

  console.log('\n4. STOP is respected');
  const c3 = (await pool.query(`SELECT opted_out FROM wa_conversations WHERE phone = '9000000003'`)).rows[0];
  check('a donor whose last word was STOP stays opted out', c3.opted_out === true, c3);
  check('and nobody else is', (await pool.query(`SELECT COUNT(*)::int AS n FROM wa_conversations WHERE opted_out`)).rows[0].n === 1);

  console.log('\n5. run again');
  const before = (await pool.query(`SELECT COUNT(*)::int AS n FROM wa_messages`)).rows[0].n;
  await importHistory(source(rows));
  const again = await importStatus();
  check('nothing is copied twice', again.imported === 0 && (await pool.query(`SELECT COUNT(*)::int AS n FROM wa_messages`)).rows[0].n === before, again);
  check('including the message the CRM holds no WhatsApp id for', (await pool.query(`SELECT COUNT(*)::int AS n FROM wa_messages WHERE body = 'sent with no WhatsApp id'`)).rows[0].n === 1);

  console.log('\n6. a copy that cannot start');
  const ok = await importHistory({ count: async () => { throw new Error('the database is down'); }, messages: async function* () {}, close: async () => undefined });
  const failed = await importStatus();
  check('says so, and does not throw', ok === true && failed.status === 'failed' && /down/.test(failed.error), failed);

  await pool.end();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
