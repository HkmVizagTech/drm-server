// WhatsApp thanks after a campaign donation (services/waThanks.ts). Gupshup is
// replaced by a fake, so nothing is sent.
//
//   DATABASE_URL=postgresql://localhost/drm_test npx tsx scripts/test-wa-thanks.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import waThanksRoutes from '../src/routes/waThanks';
import { DEFAULT_THANKS, cleanThanksSettings, queueThanks, saveThanksSettings, thanksTick, campaignKey, greetingName } from '../src/services/waThanks';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}
process.env.GUPSHUP_API_KEY = 'test-key';
process.env.GUPSHUP_APP_NAME = 'TestApp';
process.env.GUPSHUP_SOURCE_NUMBER = '917075176108';

// The fake Gupshup: records every send; a number ending 0000 is refused.
const sent: Record<string, string>[] = [];
const fakeFetch = (async (_url: string, init: { body: string; headers: Record<string, string> }) => {
  const f = Object.fromEntries(new URLSearchParams(init.body));
  sent.push({ ...f, apikey: init.headers.apikey });
  const ok = !f.destination.endsWith('0000');
  return new Response(JSON.stringify(ok ? { status: 'submitted', messageId: `m-${sent.length}` } : { status: 'error', message: 'Template not approved' }), {
    status: ok ? 202 : 400,
  });
}) as unknown as typeof fetch;
globalThis.fetch = fakeFetch;

const app = express();
app.use(express.json());
app.use('/api/wa-thanks', waThanksRoutes);
let base = '';
const ADMIN = '11111111-1111-1111-1111-111111111111';
const admin = { userId: ADMIN, role: 'admin' };
const caller = { userId: '22222222-2222-2222-2222-222222222222', role: 'caller' };

function req(method: string, path: string, as: { userId: string; role: string }, body?: unknown) {
  const raw = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const headers: Record<string, string | number> = {
    authorization: `Bearer ${generateToken({ userId: as.userId, email: 'x@t', role: as.role } as never)}`,
  };
  if (raw) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = raw.length;
  }
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const r = http.request(`${base}${path}`, { method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d ? JSON.parse(d) : {} }));
    });
    r.on('error', reject);
    if (raw) r.write(raw);
    r.end();
  });
}

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 700));
  }
}

let n = 0;
/** A donation at an India-time moment ("2026-10-10 10:00") or "now minus N minutes". */
async function donation(phone: string, name: string, at: string | number, page: string | null = '/pitru-paksha', site = 'hkmv', givenName?: string, seva = 'Annadana Seva') {
  n++;
  let person = (await pool.query(`SELECT id FROM people WHERE phone = $1`, [phone])).rows[0]?.id;
  if (!person) person = (await pool.query(`INSERT INTO people (name, phone) VALUES ($1, $2) RETURNING id`, [name, phone])).rows[0].id;
  const when = typeof at === 'number' ? `NOW() - ($5::int * INTERVAL '1 minute')` : `($5::timestamp AT TIME ZONE 'Asia/Kolkata')`;
  await pool.query(
    `INSERT INTO donations (person_id, amount, payment_mode, source_site, source_page, external_ref, given_name, created_at, purpose, occasion)
     VALUES ($1, 1116, 'upi', $2, $3, $4, $6, ${when}, left($7, 30), $7)`,
    [person, site, page, `w-${n}`, at, givenName ?? null, seva]
  );
}
const istTime = (iso: string) => new Date(new Date(iso).getTime() + 5.5 * 3600e3).toISOString().slice(11, 16);

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;

  await pool.query(`TRUNCATE wa_thanks_sends`);
  await pool.query(`DELETE FROM crm_settings WHERE key = 'wa_thanks'`);
  await pool.query(`TRUNCATE people, users RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO users (id, name, email, password_hash, role) VALUES ($1,'Admin','a@t','x','admin')`, [ADMIN]);

  console.log('\n1. settings');
  check('switching on needs a template id', cleanThanksSettings({ enabled: true }, DEFAULT_THANKS) === 'Add the Gupshup template id before switching it on.');
  check('a .webp image is refused', typeof cleanThanksSettings({ header_image: 'https://x.in/a.webp' }, DEFAULT_THANKS) === 'string');
  check('a short template id is refused', typeof cleanThanksSettings({ template_id: '3598241980329839' }, DEFAULT_THANKS) === 'string');
  const tidy = cleanThanksSettings({ page: 'https://www.harekrishnavizag.org/Pitru-Paksha/?utm=1' }, DEFAULT_THANKS);
  check('the page can be pasted as a full link', typeof tidy === 'object' && tidy.page === '/pitru-paksha', tidy);
  check('names: as given, ALL CAPS tidied, blank is "Devotee"', greetingName('chaitanya') === 'chaitanya' && greetingName('K RAVI KUMAR') === 'K Ravi Kumar' && greetingName('  ') === 'Devotee');

  console.log('\n2. who is queued, and when (campaign day 10 Oct)');
  const s = { ...DEFAULT_THANKS, enabled: true, template_id: 'f12a709c-bc1f-429b-84d5-1262bc01a73c', header_image: 'https://example.org/amavasya.jpg' };
  await donation('9000000001', 'Morning Donor', '2026-10-10 10:00');
  await donation('9000000002', 'Evening Donor', '2026-10-10 20:00');
  await donation('9000000003', 'Late Donor', '2026-10-10 21:40');
  await donation('9000000004', 'Too Late', '2026-10-10 21:50');
  await donation('9000000001', 'Morning Donor', '2026-10-10 15:00'); // gave twice
  await donation('9000000005', 'Query Link', '2026-10-10 11:00', 'pitru-paksha?utm_source=fb');
  await donation('9000000006', 'Other Page', '2026-10-10 11:00', '/gau-seva');
  await donation('9000000007', 'Day Before', '2026-10-09 11:00');
  await donation('9000000008', 'Annadan Site', '2026-10-10 11:00', '/pitru-paksha', 'annadan');
  await donation('9000000009', 'Paid For Mother', '2026-10-10 09:00', '/pitru-paksha', 'hkmv', 'Lakshmi Devi');
  const q = await queueThanks(s);
  const rows = (await pool.query(`SELECT phone, name, status, send_at, error FROM wa_thanks_sends ORDER BY phone`)).rows;
  const by = Object.fromEntries(rows.map((r) => [r.phone, r]));
  check('only /pitru-paksha on hkmv, on the day: six people', q === 6 && rows.length === 6, rows.map((r) => r.phone));
  check('the same page with a query string counts', !!by['9000000005']);
  check('another page, another day, the annadan site do not', !by['9000000006'] && !by['9000000007'] && !by['9000000008']);
  check('two hours after a morning donation', istTime(by['9000000001'].send_at) === '12:00', by['9000000001']);
  check('once per person, for the first donation', rows.filter((r) => r.phone === '9000000001').length === 1);
  check('an 8 pm donation: at 9:30 pm, not 10 pm', istTime(by['9000000002'].send_at) === '21:30', by['9000000002']);
  check('a 9:40 pm donation: 15 minutes later, 9:55 pm', istTime(by['9000000003'].send_at) === '21:55', by['9000000003']);
  check('a 9:50 pm donation is too late, skipped and said why', by['9000000004'].status === 'skipped' && /too late/.test(by['9000000004'].error), by['9000000004']);
  check('the name on the donation, not the account', by['9000000009'].name === 'Lakshmi Devi', by['9000000009']);
  check('running again queues nobody twice', (await queueThanks(s)) === 0);

  console.log('\n2b. precise about the seva');
  await pool.query(`TRUNCATE wa_thanks_sends`);
  await donation('9300000001', 'Gau Donor', '2026-10-10 10:00', '/pitru-paksha', 'hkmv', undefined, 'Gau Seva');
  await donation('9300000002', 'Bricks Donor', '2026-10-10 10:00', '/pitru-paksha', 'hkmv', undefined, 'Brick Seva');
  await donation('9300000003', 'Unknown Seva', '2026-10-10 10:00', '/pitru-paksha', 'hkmv', undefined, 'Tulasi Seva');
  // Gave to Brick (switched off below) first, then Sadhu Bhojan.
  await donation('9300000004', 'Two Sevas', '2026-10-10 09:00', '/pitru-paksha', 'hkmv', undefined, 'Brick Seva');
  await donation('9300000004', 'Two Sevas', '2026-10-10 11:00', '/pitru-paksha', 'hkmv', undefined, 'Sadhu Bhojan Seva');
  const precise = { ...s, sevas: s.sevas.map((x) => (x.name === 'Brick Seva' ? { ...x, on: false } : x)) };
  await queueThanks(precise);
  const sv = Object.fromEntries((await pool.query(`SELECT phone, seva, seva_text, status, error, send_at FROM wa_thanks_sends`)).rows.map((r) => [r.phone, r]));
  check('Annadana donors are thanked for Annadan seva', sv['9000000001']?.seva_text === 'Pitru paksha Annadan seva', sv['9000000001']);
  check('a Gau Seva donor is thanked for Gau seva, not Annadan', sv['9300000001']?.seva_text === 'Pitru paksha Gau seva' && sv['9300000001'].status === 'waiting', sv['9300000001']);
  check('a seva switched off is not sent, and says which seva', sv['9300000002']?.status === 'skipped' && /Brick Seva/.test(sv['9300000002'].error) && !sv['9300000002'].seva_text, sv['9300000002']);
  check('a seva not on the list is not sent either', sv['9300000003']?.status === 'skipped' && /Tulasi Seva/.test(sv['9300000003'].error), sv['9300000003']);
  check('someone who gave to two: thanked for the one switched on, at its time', sv['9300000004']?.seva_text === 'Pitru paksha Sadhu Bhojan seva' && istTime(sv['9300000004'].send_at) === '13:00', sv['9300000004']);
  // Switched back on later in the day: picked up on the next pass.
  const brickOn = { ...precise, sevas: precise.sevas.map((x) => ({ ...x, on: true })) };
  await queueThanks(brickOn);
  const b2 = (await pool.query(`SELECT seva_text, status FROM wa_thanks_sends WHERE phone = '9300000002'`)).rows[0];
  check('a seva switched on later is picked up then', b2.status === 'waiting' && b2.seva_text === 'Pitru paksha Brick seva', b2);
  const noWords = cleanThanksSettings({ sevas: [{ name: 'Gau Seva', text: '' }] }, DEFAULT_THANKS);
  check('a seva without words for {{2}} is refused', typeof noWords === 'string' && /Gau Seva/.test(noWords as string), noWords);

  console.log('\n3. sending, on the day');
  await pool.query(`TRUNCATE wa_thanks_sends`);
  // Step 2's donations are dated 10 Oct - which may be today.
  await pool.query(`TRUNCATE people RESTART IDENTITY CASCADE`);
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const live = { ...s, day: today, last_send: '23:58', stop_at: '23:59' };
  await saveThanksSettings(live, ADMIN);
  // Pick times that are "today" in India whatever the clock says now.
  const nowIst = new Date(Date.now() + 5.5 * 3600e3);
  const minsToday = nowIst.getUTCHours() * 60 + nowIst.getUTCMinutes();
  const dueAgo = Math.min(150, minsToday);
  await donation('9100000001', 'Due Donor', dueAgo);
  await donation('9100000002', 'Recent Donor', Math.min(10, minsToday));
  await donation('9100000000', 'Refused Number', dueAgo);
  sent.length = 0;
  const t = await thanksTick(fakeFetch);
  if (dueAgo < 120) console.log('  (it is early morning in India - the due cases are shorter than two hours and are skipped)');
  const after = Object.fromEntries((await pool.query(`SELECT phone, status, error, message_id FROM wa_thanks_sends`)).rows.map((r) => [r.phone, r]));
  if (dueAgo >= 120) {
    check('a donation two hours old is sent', after['9100000001']?.status === 'sent' && after['9100000001'].message_id, after['9100000001']);
    check('one ten minutes old waits', after['9100000002']?.status === 'waiting', after['9100000002']);
    check('a refused send is failed, with Gupshup\'s reason', after['9100000000']?.status === 'failed' && /not approved/.test(after['9100000000'].error), after['9100000000']);
    const m = sent.find((x) => x.destination === '919100000001')!;
    const tpl = JSON.parse(m.template);
    check('the template, {{1}} the name and {{2}} the seva', tpl.id === live.template_id && tpl.params[0] === 'Due Donor' && tpl.params[1] === 'Pitru paksha Annadan seva', tpl);
    check('the image header goes in message, not params', JSON.parse(m.message).image.link === live.header_image && tpl.params.length === 2, m);
    check('from the Gupshup number and app, with the key', m.source === '917075176108' && m['src.name'] === 'TestApp' && m.apikey === 'test-key' && m.channel === 'whatsapp', m);
    check('the tick counts what it did', t.sent === 1 && t.failed === 1, t);
  }
  const again = await thanksTick(fakeFetch);
  check('nothing is sent twice', again.sent === 0 && sent.filter((x) => x.destination === '919100000001').length <= 1, again);

  console.log('\n4. switched off');
  await saveThanksSettings({ ...live, enabled: false }, ADMIN);
  await pool.query(`UPDATE wa_thanks_sends SET send_at = NOW() - INTERVAL '1 minute' WHERE status = 'waiting'`);
  const before = sent.length;
  await thanksTick(fakeFetch);
  check('nothing goes out while it is off', sent.length === before);

  console.log('\n5. after the stop time');
  await saveThanksSettings({ ...live, day: '2026-01-01', enabled: true }, ADMIN);
  await pool.query(`INSERT INTO wa_thanks_sends (campaign, phone, name, send_at) VALUES ($1, '9200000001', 'Old', '2026-01-01 12:00+05:30')`, [campaignKey({ ...live, day: '2026-01-01' })]);
  await thanksTick(fakeFetch);
  const old = (await pool.query(`SELECT status FROM wa_thanks_sends WHERE phone = '9200000001'`)).rows[0];
  check('anything still waiting is skipped, never sent late', old.status === 'skipped', old);
  await saveThanksSettings({ ...live, enabled: true }, ADMIN);

  console.log('\n6. the screen');
  let r = await req('GET', '/api/wa-thanks', caller);
  check('admins only', r.status === 403);
  r = await req('GET', '/api/wa-thanks', admin);
  check('settings, counts and the list', r.status === 200 && r.body.gupshup_ready === true && r.body.rows.length >= 2 && r.body.today.people >= 3, { c: r.body.counts, t: r.body.today });
  r = await req('PUT', '/api/wa-thanks', admin, { sevas: [{ name: 'Gau Seva', text: '' }], enabled: true });
  check('a bad change is refused, nothing half-saved', r.status === 400 && /\{\{2\}\}/.test(r.body.error), r.body);
  const newList = DEFAULT_THANKS.sevas.map((x) => (x.name === 'Annadana Seva' ? { ...x, text: 'Mahalaya Annadan seva' } : x));
  r = await req('PUT', '/api/wa-thanks', admin, { sevas: newList, enabled: false });
  check('a good change is saved', r.status === 200 && r.body.settings.sevas[0].text === 'Mahalaya Annadan seva' && r.body.settings.enabled === false, r.body);
  r = await req('GET', '/api/wa-thanks', admin);
  check('the screen shows the day\'s donors by seva', Array.isArray(r.body.by_seva), r.body.by_seva);
  sent.length = 0;
  r = await req('POST', '/api/wa-thanks/test', admin, { phone: '98480 22338', name: 'Test Devotee', seva: 'Gau Seva' });
  check('a test goes to the number given, with that seva\'s words', r.status === 200 && sent[0]?.destination === '919848022338' && JSON.parse(sent[0].template).params[0] === 'Test Devotee' && JSON.parse(sent[0].template).params[1] === 'Pitru paksha Gau seva', { r: r.body, s: sent[0] });
  r = await req('POST', '/api/wa-thanks/test', admin, { phone: '9848000000' });
  check('a refused test says why', r.status === 502 && /not approved/.test(r.body.error), r.body);
  const failed = (await pool.query(`SELECT id FROM wa_thanks_sends WHERE status = 'failed' LIMIT 1`)).rows[0];
  if (failed) {
    r = await req('POST', `/api/wa-thanks/${failed.id}/retry`, admin);
    const back = (await pool.query(`SELECT status FROM wa_thanks_sends WHERE id = $1`, [failed.id])).rows[0];
    check('a failed one can be tried again', r.status === 200 && ['waiting', 'sending', 'failed', 'sent'].includes(back.status), back);
  }

  await new Promise((ok) => setTimeout(ok, 1500));
  server.close();
  await pool.end();
  console.log(failures ? `\n${failures} FAILED` : '\nall green');
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
