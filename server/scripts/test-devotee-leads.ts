// Devotee leads: each devotee sees only the leads they added, nobody else sees them at all, and a
// logged follow-up moves the lead the way the screen promises. Then the phone reminders: sent once
// when due, again only after the time is changed, never for stale follow-ups.
//
// Never sends a push: the sender is replaced by one that records what would have gone out.
//
//   NODE_ENV=development DATABASE_URL=...drm_test npx tsx scripts/test-devotee-leads.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { runMigrations } from '../src/db/migrate';
import { confineRole, generateToken } from '../src/middleware/auth';
import devoteeLeadsRoutes from '../src/routes/devoteeLeads';
import peopleRoutes from '../src/routes/people';
import phoneAppRoutes from '../src/routes/phoneApp';
import { setPushSender, type PushMessage } from '../src/services/webPush';
import { devoteeReminderTick } from '../src/services/devoteeReminders';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

let failures = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}`, ok ? '' : JSON.stringify(d)?.slice(0, 400));
  if (!ok) failures++;
};

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const GONE = '33333333-3333-3333-3333-333333333333';
const ADMIN = '44444444-4444-4444-4444-444444444444';

async function main() {
  await runMigrations();
  await pool.query(`TRUNCATE devotees, devotee_otps, devotee_leads, devotee_lead_activities, devotee_calls, push_subscriptions, app_devices, phone_calls, incoming_rings, users RESTART IDENTITY CASCADE`);
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role) VALUES
       ($1, 'Devotee A', 'a@devotee.test', 'x', 'devotee'),
       ($2, 'Devotee B', 'b@devotee.test', 'x', 'devotee'),
       ($3, 'Devotee Gone', 'g@devotee.test', 'x', 'devotee'),
       ($4, 'Admin', 'admin@test', 'x', 'admin')`,
    [A, B, GONE, ADMIN]
  );
  await pool.query(
    `INSERT INTO devotees (name, phone, user_id, active) VALUES
       ('Devotee A', '9000000001', $1, TRUE), ('Devotee B', '9000000002', $2, TRUE), ('Devotee Gone', '9000000003', $3, FALSE)`,
    [A, B, GONE]
  );
  const tA = generateToken({ userId: A, role: 'devotee' });
  const tB = generateToken({ userId: B, role: 'devotee' });
  const tGone = generateToken({ userId: GONE, role: 'devotee' });
  const tAdmin = generateToken({ userId: ADMIN, role: 'admin' });

  const app = express();
  app.use(express.json());
  app.use('/api', confineRole('devotee', ['/seva-wall/devotee-record', '/seva-wall/mine', '/devotee', '/app/devices', '/auth/me']));
  app.use('/api/devotee', devoteeLeadsRoutes);
  app.use('/api/people', peopleRoutes);
  app.use('/api/app', phoneAppRoutes);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const call = (method: string, path: string, body?: unknown, token?: string) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const data = body ? JSON.stringify(body) : '';
      const req = http.request(
        { port, path, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(token ? { authorization: `Bearer ${token}` } : {}) } },
        (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(d || '{}') })); }
      );
      req.on('error', reject);
      req.end(data);
    });
  const device = (method: string, path: string, key: string, body?: unknown) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const data = body ? JSON.stringify(body) : '';
      const req = http.request(
        { port, path, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-device-key': key } },
        (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(d || '{}') })); }
      );
      req.on('error', reject);
      req.end(data);
    });
  const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

  console.log('\n--- who gets in ---');
  let r = await call('GET', '/api/devotee/leads');
  check('no sign-in: refused', r.status === 401, r);
  r = await call('GET', '/api/devotee/leads', undefined, tAdmin);
  check('an admin cannot read devotee leads', r.status === 403, r);
  r = await call('GET', '/api/devotee/leads', undefined, tGone);
  check('a devotee switched off in the list is refused, token or not', r.status === 403 && /switched off/i.test(r.body.error), r);
  r = await call('GET', '/api/people', undefined, tA);
  check('a devotee still cannot reach donor records', r.status === 403, r);

  console.log('\n--- adding a lead ---');
  r = await call('POST', '/api/devotee/leads', { phone: '9876543210' }, tA);
  check('the name is required', r.status === 400 && /name/i.test(r.body.error), r);
  r = await call('POST', '/api/devotee/leads', { name: 'Ravi' }, tA);
  check('the number is required', r.status === 400 && /mobile/i.test(r.body.error), r);
  r = await call('POST', '/api/devotee/leads', { name: 'Ravi', phone: '12345' }, tA);
  check('a short number is refused', r.status === 400, r);
  r = await call('POST', '/api/devotee/leads', { name: '  Ravi   Kumar ', phone: '+91 98765 43210' }, tA);
  check('name and number are enough', r.status === 201 && r.body.lead.name === 'Ravi Kumar' && r.body.lead.phone === '9876543210', r);
  check('a new lead starts as new, warm, with nothing given', r.body.lead.status === 'new' && r.body.lead.priority === 'warm' && r.body.lead.total_donated === 0, r.body.lead);
  const ravi = r.body.lead.id as string;
  r = await call('POST', '/api/devotee/leads', { name: 'Ravi again', phone: '9876543210' }, tA);
  check('the same number twice is refused, pointing at the first', r.status === 409 && r.body.lead_id === ravi, r);
  r = await call('POST', '/api/devotee/leads', { name: 'Ravi (B)', phone: '9876543210', area: 'MVP Colony' }, tB);
  check('another devotee may have the same person as their own lead', r.status === 201, r);
  const raviB = r.body.lead.id as string;
  r = await call(
    'POST',
    '/api/devotee/leads',
    {
      name: 'Lakshmi', phone: '9123456780', email: 'lakshmi@example.com', occupation: 'Teacher', interest: 'annadanam',
      source: 'temple_visit', priority: 'hot', expected_amount: '5000', address_line: '12-3, Beach Road', area: 'Siripuram',
      city: 'Visakhapatnam', pincode: '530003', latitude: 17.72, longitude: 83.31, date_of_birth: '1980-05-14',
      next_follow_up_at: inMinutes(-90),
    },
    tA
  );
  check('a full lead is kept as entered', r.status === 201 && r.body.lead.interest === 'annadanam' && r.body.lead.expected_amount === 5000 && r.body.lead.latitude === 17.72 && r.body.lead.date_of_birth === '1980-05-14', r);
  const lakshmi = r.body.lead.id as string;
  r = await call('POST', '/api/devotee/leads', { name: 'X', phone: '9000011111', interest: 'lottery' }, tA);
  check('an interest not on the list is refused', r.status === 400, r);
  r = await call('POST', '/api/devotee/leads', { name: 'X', phone: '9000011111', latitude: 17.7 }, tA);
  check('half a map pin is refused', r.status === 400 && /map/i.test(r.body.error), r);
  r = await call('POST', '/api/devotee/leads', { name: 'X', phone: '9000011111', pincode: '5300' }, tA);
  check('a short PIN code is refused', r.status === 400, r);

  console.log('\n--- each devotee sees only their own ---');
  r = await call('GET', '/api/devotee/leads', undefined, tA);
  check('A lists their two leads', r.status === 200 && r.body.total === 2 && r.body.rows.every((x: any) => x.id !== raviB), r.body);
  r = await call('GET', '/api/devotee/leads', undefined, tB);
  check('B lists only their one', r.body.total === 1 && r.body.rows[0].id === raviB, r.body);
  r = await call('GET', `/api/devotee/leads/${raviB}`, undefined, tA);
  check("A cannot open B's lead", r.status === 404, r);
  r = await call('PATCH', `/api/devotee/leads/${raviB}`, { name: 'Taken' }, tA);
  check("nor change it", r.status === 404, r);
  r = await call('POST', `/api/devotee/leads/${raviB}/activities`, { outcome: 'not_answered' }, tA);
  check("nor log on it", r.status === 404, r);
  r = await call('DELETE', `/api/devotee/leads/${raviB}`, undefined, tA);
  check("nor delete it", r.status === 404, r);
  check("and B's lead is untouched", (await pool.query(`SELECT name FROM devotee_leads WHERE id = $1`, [raviB])).rows[0]?.name === 'Ravi (B)');
  r = await call('GET', '/api/devotee/leads/not-a-uuid', undefined, tA);
  check('a bad id is just not found', r.status === 404, r);

  console.log('\n--- editing ---');
  r = await call('PATCH', `/api/devotee/leads/${ravi}`, { area: 'Gajuwaka' }, tA);
  check('one field changes, the rest stay', r.status === 200 && r.body.lead.area === 'Gajuwaka' && r.body.lead.name === 'Ravi Kumar', r);
  r = await call('PATCH', `/api/devotee/leads/${ravi}`, { name: '' }, tA);
  check('the name cannot be cleared', r.status === 400, r);
  r = await call('PATCH', `/api/devotee/leads/${ravi}`, { phone: '9123456780' }, tA);
  check("a number already on another of A's leads is refused", r.status === 409 && r.body.lead_id === lakshmi, r);
  r = await call('PATCH', `/api/devotee/leads/${ravi}`, { area: '' }, tA);
  check('an optional field can be cleared', r.status === 200 && r.body.lead.area === null, r);

  console.log('\n--- following up ---');
  r = await call('POST', `/api/devotee/leads/${ravi}/activities`, {}, tA);
  check('an empty follow-up is refused', r.status === 400, r);
  r = await call('POST', `/api/devotee/leads/${ravi}/activities`, { outcome: 'not_answered', channel: 'call', next_follow_up_at: inMinutes(120) }, tA);
  check('not answered: status, one unanswered, next try set', r.status === 201 && r.body.lead.status === 'not_answered' && r.body.lead.unanswered_count === 1 && !!r.body.lead.next_follow_up_at && !!r.body.lead.last_contacted_at, r.body.lead);
  await call('POST', `/api/devotee/leads/${ravi}/activities`, { outcome: 'not_answered', channel: 'call' }, tA);
  r = await call('GET', `/api/devotee/leads/${ravi}`, undefined, tA);
  check('a second miss counts two, and with no time given the follow-up is done', r.body.lead.unanswered_count === 2 && r.body.lead.next_follow_up_at === null, r.body.lead);
  r = await call('POST', `/api/devotee/leads/${ravi}/activities`, { outcome: 'call_later' }, tA);
  check('call later needs a time', r.status === 400 && /when/i.test(r.body.error), r);
  r = await call('POST', `/api/devotee/leads/${ravi}/activities`, { outcome: 'call_later', next_follow_up_at: inMinutes(-30) }, tA);
  check('and not one in the past', r.status === 400, r);
  r = await call('POST', `/api/devotee/leads/${ravi}/activities`, { outcome: 'call_later', channel: 'call', note: 'In a meeting', next_follow_up_at: inMinutes(60) }, tA);
  check('call later: picked up, so the misses reset; time kept', r.status === 201 && r.body.lead.status === 'call_later' && r.body.lead.unanswered_count === 0 && !!r.body.lead.next_follow_up_at, r.body.lead);
  const before = r.body.lead.next_follow_up_at;
  r = await call('POST', `/api/devotee/leads/${ravi}/activities`, { note: 'Likes Annadanam' }, tA);
  check('a plain note leaves the status and the follow-up alone', r.status === 201 && r.body.lead.status === 'call_later' && r.body.lead.next_follow_up_at === before && r.body.activity.outcome === null, r.body);
  r = await call('POST', `/api/devotee/leads/${ravi}/activities`, { outcome: 'donated' }, tA);
  check('donated needs the amount', r.status === 400 && /amount/i.test(r.body.error), r);
  r = await call('POST', `/api/devotee/leads/${ravi}/activities`, { outcome: 'donated', donation: { amount: 1000, donated_on: '2999-01-01' } }, tA);
  check('and not a date in the future', r.status === 400, r);
  r = await call('POST', `/api/devotee/leads/${ravi}/activities`, { outcome: 'donated', channel: 'visit', donation: { amount: 2500, payment_mode: 'upi', reference: 'UTR123' } }, tA);
  check('donated: total, date and status', r.status === 201 && r.body.lead.status === 'donated' && r.body.lead.total_donated === 2500 && !!r.body.lead.last_donated_on && r.body.activity.amount === 2500 && r.body.activity.payment_mode === 'upi', r.body);
  r = await call('POST', `/api/devotee/leads/${ravi}/activities`, { outcome: 'donated', donation: { amount: 1500.5, donated_on: '2026-01-10' } }, tA);
  check('a second gift adds up; the latest date stays', r.body.lead.total_donated === 4000.5 && r.body.lead.last_donated_on !== '2026-01-10', r.body.lead);
  r = await call('POST', `/api/devotee/leads/${lakshmi}/activities`, { outcome: 'invalid_number', next_follow_up_at: inMinutes(60) }, tA);
  check('invalid number: nobody to ring, so no follow-up even if one was sent', r.status === 201 && r.body.lead.status === 'invalid_number' && r.body.lead.next_follow_up_at === null, r.body.lead);
  r = await call('GET', `/api/devotee/leads/${ravi}`, undefined, tA);
  check('the history lists every entry, newest first', r.body.activities.length === 6 && r.body.activities[0].amount === 1500.5, r.body.activities.map((a: any) => a.outcome));

  console.log('\n--- lists, filters, summary, map ---');
  const extra: string[] = [];
  for (const [name, phone, mins] of [['Due Earlier', '9811111111', -10], ['Due Later Today', '9822222222', 5], ['Next Month', '9833333333', 60 * 24 * 20]] as const) {
    const x = await call('POST', '/api/devotee/leads', { name, phone, next_follow_up_at: inMinutes(mins) }, tA);
    extra.push(x.body.lead.id);
  }
  r = await call('GET', '/api/devotee/leads?due=overdue', undefined, tA);
  check('overdue: only the one already past', r.body.total === 1 && r.body.rows[0].name === 'Due Earlier', r.body.rows.map((x: any) => x.name));
  r = await call('GET', '/api/devotee/leads?due=upcoming', undefined, tA);
  check('upcoming: after today', r.body.rows.some((x: any) => x.name === 'Next Month') && r.body.rows.every((x: any) => x.name !== 'Due Earlier'), r.body.rows.map((x: any) => x.name));
  r = await call('GET', '/api/devotee/leads?sort=due', undefined, tA);
  check('sorted by due: overdue first, none last', r.body.rows[0].name === 'Due Earlier' && r.body.rows[r.body.rows.length - 1].next_follow_up_at === null, r.body.rows.map((x: any) => x.name));
  r = await call('GET', '/api/devotee/leads?q=43210', undefined, tA);
  check('search by part of the number', r.body.total === 1 && r.body.rows[0].id === ravi, r.body);
  r = await call('GET', '/api/devotee/leads?q=laksh', undefined, tA);
  check('search by name', r.body.total === 1 && r.body.rows[0].id === lakshmi, r.body);
  r = await call('GET', '/api/devotee/leads?q=100%25', undefined, tA);
  check('a % in the search is just a character', r.status === 200 && r.body.total === 0, r.body);
  r = await call('GET', '/api/devotee/leads?status=donated', undefined, tA);
  check('status filter, with counts for every status', r.body.total === 1 && r.body.counts.donated === 1 && r.body.counts.invalid_number === 1 && r.body.counts.new === 3, r.body.counts);
  r = await call('GET', '/api/devotee/summary', undefined, tA);
  check('summary: totals are A\'s alone', r.status === 200 && r.body.total === 5 && r.body.donors === 1 && r.body.donated_total === 4000.5 && r.body.overdue === 1, r.body);
  check('summary: due list and recent activity', r.body.due.some((x: any) => x.name === 'Due Earlier') && r.body.recent.length > 0 && r.body.recent[0].lead_name, r.body);
  r = await call('GET', '/api/devotee/leads/map', undefined, tA);
  check('map: pins only for leads with a location', r.body.rows.length === 1 && r.body.rows[0].id === lakshmi && r.body.without_location === 4, r.body);
  r = await call('GET', '/api/devotee/reminders', undefined, tA);
  check('reminders: due and coming, not the closed one', r.body.rows.some((x: any) => x.name === 'Due Earlier') && r.body.rows.every((x: any) => x.id !== lakshmi), r.body.rows.map((x: any) => x.name));

  console.log('\n--- phone reminders ---');
  const pushed: { endpoint: string; m: PushMessage }[] = [];
  let goneEndpoint = '';
  setPushSender(async (sub, m) => {
    if (sub.endpoint === goneEndpoint) return { ok: false, gone: true };
    pushed.push({ endpoint: sub.endpoint, m });
    return { ok: true };
  });
  delete process.env.WEB_PUSH_PUBLIC_KEY;
  r = await call('POST', '/api/devotee/push/subscribe', { endpoint: 'https://push.example/a1', keys: { p256dh: 'k', auth: 'a' } }, tA);
  check('no push keys on the server: subscribing says so', r.status === 503, r);
  process.env.WEB_PUSH_PUBLIC_KEY = 'test-public-key';
  r = await call('GET', '/api/devotee/config', undefined, tA);
  check('the page is given the push key', r.body.push_key === 'test-public-key', r.body);
  r = await call('POST', '/api/devotee/push/subscribe', { endpoint: 'http://insecure', keys: { p256dh: 'k', auth: 'a' } }, tA);
  check('a bad subscription is refused', r.status === 400, r);
  r = await call('POST', '/api/devotee/push/subscribe', { endpoint: 'https://push.example/a1', keys: { p256dh: 'k', auth: 'a' } }, tA);
  check('A subscribes a browser', r.status === 200, r);

  // A's overdue lead from earlier is due; Lakshmi's was closed; another is days stale.
  await pool.query(`UPDATE devotee_leads SET next_follow_up_at = NOW() - INTERVAL '3 days' WHERE id = $1`, [extra[2]]);
  let t = await devoteeReminderTick();
  check('the due follow-up is pushed to A, opening the lead', pushed.length === 1 && pushed[0].m.url === `/devotee/leads/${extra[0]}` && /Due Earlier/.test(pushed[0].m.title), pushed);
  check('the stale one (3 days late) is not announced', pushed.every((p) => !p.m.url.endsWith(extra[2])), { t, pushed });
  t = await devoteeReminderTick();
  check('the next run sends nothing again', pushed.length === 1 && t.claimed === 0, t);
  r = await call('PATCH', `/api/devotee/leads/${extra[0]}`, { next_follow_up_at: inMinutes(-1) }, tA);
  await devoteeReminderTick();
  check('a changed time is a new reminder', pushed.length === 2, pushed.length);

  // B has a due follow-up but no browser subscribed: nothing to send to, nothing sent to A.
  await call('POST', `/api/devotee/leads/${raviB}/activities`, { note: 'x', next_follow_up_at: inMinutes(-2) }, tB);
  await devoteeReminderTick();
  check("B's reminder never reaches A's browser", pushed.length === 2, pushed);

  goneEndpoint = 'https://push.example/a1';
  await call('PATCH', `/api/devotee/leads/${extra[1]}`, { next_follow_up_at: inMinutes(-1) }, tA);
  await devoteeReminderTick();
  check('a subscription the push service has dropped is forgotten', (await pool.query(`SELECT COUNT(*)::int n FROM push_subscriptions WHERE user_id = $1`, [A])).rows[0].n === 0);

  console.log('\n--- bulk upload from a file ---');
  const csv = [
    'Full Name,WhatsApp Number,Area,City,Priority,Interest,Birthday,Next follow-up,Notes',
    'Upload One,98490 11111,MVP Colony,Visakhapatnam,High,Annadanam,14-05-1980,25-12-2026 5:30 pm,From the stall',
    'Upload Two,+91 9849022222,Siripuram,,low,Temple Construction,,,',
    'No Number,,Gajuwaka,,,,,,',
    'Bad Date,9849033333,,,,,31/02/19xx,,',
    'Upload One Again,9849011111,,,,,,,',
    `Already Mine,${'9123456780'},,,,,,,`,
    ',,,,,,,,',
  ].join('\n');
  const b64 = Buffer.from(csv).toString('base64');
  r = await call('POST', '/api/devotee/leads/import', { filename: 'mine.csv', base64: b64 }, tA);
  check('checking a file writes nothing and reports it', r.status === 200 && r.body.added === 0 && r.body.total === 6 && r.body.ready === 2, r.body);
  check('headings are matched loosely', r.body.columns.name === 'Full Name' && r.body.columns.phone === 'WhatsApp Number', r.body.columns);
  check('a row without a number, and one with a bad date, are named with the reason', r.body.problems.length === 2 && r.body.problems.some((p: any) => p.row === 4 && /mobile/i.test(p.reason)) && r.body.problems.some((p: any) => p.row === 5 && /Birthday/.test(p.reason)), r.body.problems);
  check('a number repeated in the file, and one already a lead, are left out', r.body.duplicates.length === 2 && r.body.duplicates.some((d: any) => /row 2/.test(d.reason)) && r.body.duplicates.some((d: any) => /Already/.test(d.reason)), r.body.duplicates);
  check('nothing was saved by checking', (await pool.query(`SELECT COUNT(*)::int n FROM devotee_leads WHERE phone LIKE '984901111%'`)).rows[0].n === 0);
  r = await call('POST', '/api/devotee/leads/import', { filename: 'mine.csv', base64: b64, apply: true }, tA);
  check('adding saves exactly the ready rows', r.status === 200 && r.body.added === 2, r.body);
  const up = (await pool.query(`SELECT name, priority, interest, area, date_of_birth, next_follow_up_at, notes FROM devotee_leads WHERE owner_id = $1 AND phone = '9849011111'`, [A])).rows[0];
  check('with every column read: priority, interest, birthday, follow-up time (IST), notes',
    up?.priority === 'hot' && up.interest === 'annadanam' && up.area === 'MVP Colony' && up.date_of_birth === '1980-05-14' &&
      new Date(up.next_follow_up_at).toISOString() === '2026-12-25T12:00:00.000Z' && up.notes === 'From the stall', up);
  check('"low" and "Temple Construction" are understood', (await pool.query(`SELECT priority, interest FROM devotee_leads WHERE phone = '9849022222'`)).rows[0]?.interest === 'temple_construction');
  check("the existing lead was not touched", (await pool.query(`SELECT name FROM devotee_leads WHERE id = $1`, [lakshmi])).rows[0].name === 'Lakshmi');
  r = await call('POST', '/api/devotee/leads/import', { filename: 'mine.csv', base64: b64, apply: true }, tA);
  check('uploading the same file again adds nothing', r.body.added === 0 && r.body.ready === 0, r.body);
  check("another devotee's leads are untouched", (await pool.query(`SELECT COUNT(*)::int n FROM devotee_leads WHERE owner_id = $1`, [B])).rows[0].n === 1);
  r = await call('POST', '/api/devotee/leads/import', { filename: 'x.csv', base64: Buffer.from('Area,City\nMVP,Vizag').toString('base64') }, tA);
  check('a file without Name and Mobile columns is refused with what it found', r.status === 400 && /Name column and a Mobile column/.test(r.body.error), r.body);
  r = await call('POST', '/api/devotee/leads/import', { filename: 'mine.csv', base64: b64 }, tAdmin);
  check('an admin cannot upload into a devotee portal', r.status === 403, r);
  await pool.query(`DELETE FROM devotee_leads WHERE phone IN ('9849011111', '9849022222')`);

  console.log('\n--- call recording on a devotee\'s phone ---');
  r = await call('POST', '/api/app/devices', { install_id: 'install-devotee-a', model: 'Test' }, tA);
  check('a devotee can link their phone', r.status === 200 && !!r.body.device_key, r);
  const keyA = r.body.device_key as string;
  const keyB = (await call('POST', '/api/app/devices', { install_id: 'install-devotee-b' }, tB)).body.device_key as string;
  await pool.query(`INSERT INTO leads (name, phone) VALUES ('DRM Lead', '9500000001')`);
  r = await device('GET', '/api/app/numbers', keyA);
  const nums = (r.body.numbers ?? []) as string[];
  check("the phone is given only A's own lead numbers", r.status === 200 && nums.includes('9123456780') && !nums.includes('9500000001'), nums);
  const t0 = new Date(Date.now() - 10 * 60_000).toISOString();
  r = await device('POST', '/api/app/calls', keyA, {
    calls: [
      { key: 'a-1', type: 2, phone: '+91 91234 56780', started_at: t0, duration_seconds: 125, lead_id: lakshmi },
      { key: 'a-2', type: 2, phone: '9999988888', started_at: t0, duration_seconds: 60 },
      { key: 'a-3', type: 3, phone: '9123456780', started_at: t0, duration_seconds: 0 },
    ],
  });
  const res1 = r.body.results as any[];
  check('a call with their lead is kept and its recording asked for', r.status === 200 && !!res1[0].id && res1[0].want_recording === true, r.body);
  check('a personal call is not kept', res1[1].id === null, res1);
  check('a missed call is kept, with no recording wanted', !!res1[2].id && res1[2].want_recording === false && res1[2].direction === 'missed', res1);
  check("nothing went into DRM's call log", (await pool.query(`SELECT COUNT(*)::int n FROM phone_calls`)).rows[0].n === 0);
  r = await device('POST', '/api/app/calls', keyA, { calls: [{ key: 'a-1', type: 2, phone: '9123456780', started_at: t0, duration_seconds: 125 }] });
  check('the same call twice is one call', r.body.results[0].id === res1[0].id && (await pool.query(`SELECT COUNT(*)::int n FROM devotee_calls`)).rows[0].n === 2, r.body);
  r = await device('POST', '/api/app/calls', keyB, { calls: [{ key: 'b-1', type: 2, phone: '9123456780', started_at: t0, duration_seconds: 30 }] });
  check("B's phone cannot file a call against A's lead", r.body.results[0].id === null, r.body);
  await device('POST', `/api/app/calls/${res1[0].id}/no-recording`, keyB);
  check("B's phone cannot touch A's call", (await pool.query(`SELECT recording_status FROM devotee_calls WHERE id = $1`, [res1[0].id])).rows[0].recording_status === 'waiting');

  r = await call('GET', `/api/devotee/leads/${lakshmi}`, undefined, tA);
  check('the lead page lists its calls', r.body.calls?.length === 2 && r.body.calls.some((c: any) => c.duration_seconds === 125), r.body.calls);
  r = await call('GET', `/api/devotee/leads/${lakshmi}`, undefined, tB);
  check('another devotee cannot see them', r.status === 404, r);

  await pool.query(`UPDATE devotee_calls SET recording_status = 'uploaded', recording_key = 'devotee-recordings/x/test.m4a', recording_type = 'audio/mp4' WHERE id = $1`, [res1[0].id]);
  r = await call('GET', `/api/devotee/calls/${res1[0].id}/recording`, undefined, tB);
  check("another devotee cannot play A's recording", r.status === 404, r);
  r = await call('GET', `/api/devotee/calls/${res1[0].id}/recording`, undefined, tAdmin);
  check('an admin cannot play it either', r.status === 403, r);
  r = await call('GET', `/api/app/calls/${res1[0].id}/recording`, undefined, tAdmin);
  check("nor through DRM's recordings", r.status === 404, r);

  r = await device('POST', '/api/app/ringing', keyA, { phone: '9123456780', state: 'ringing' });
  check("caller ID on A's phone names A's own lead", r.body.known === true && r.body.name === 'Lakshmi', r.body);
  r = await device('POST', '/api/app/ringing', keyA, { phone: '9500000001', state: 'ringing' });
  check('and says nothing about a DRM lead', r.body.known === false && !r.body.name, r.body);
  check('and writes nothing to DRM', (await pool.query(`SELECT COUNT(*)::int n FROM incoming_rings`)).rows[0].n === 0);
  r = await call('GET', '/api/app/devices', undefined, tAdmin);
  check("devotees' phones are not on the admin Phones list", r.status === 200 && r.body.devices.every((d: any) => d.user_name !== 'Devotee A'), r.body);

  console.log('\n--- deleting ---');
  r = await call('DELETE', `/api/devotee/leads/${ravi}`, undefined, tA);
  check('A deletes their lead', r.status === 200, r);
  check('and its history goes with it', (await pool.query(`SELECT COUNT(*)::int n FROM devotee_lead_activities WHERE lead_id = $1`, [ravi])).rows[0].n === 0);
  check("B's lead with the same number is still there", (await pool.query(`SELECT COUNT(*)::int n FROM devotee_leads WHERE id = $1`, [raviB])).rows[0].n === 1);

  setPushSender(null);
  server.close();
  await pool.end();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await pool.end().catch(() => undefined); process.exit(1); });
