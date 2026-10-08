// The bell: nearly gave as it happens, Sankalpam each morning, and adding one
// person to Sankalpam from their page.
//
//   DATABASE_URL=postgresql://localhost/drm_test npx tsx scripts/test-notifications.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import notificationsRoutes from '../src/routes/notifications';
import sankalpamRoutes from '../src/routes/sankalpam';
import crmRoutes from '../src/routes/crm';
import { announceNearlyGave } from '../src/services/nearlyGaveWatch';
import { sankalpMorning } from '../src/utils/cron';
import { upsertDonorSnapshot } from '../src/services/hkmvSync';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use('/api/notifications', notificationsRoutes);
app.use('/api/sankalpam', sankalpamRoutes);
app.use('/api/crm', crmRoutes);

let base = '';
const ANA = '22222222-2222-2222-2222-222222222222';
const ACC = '44444444-4444-4444-4444-444444444444';
const ana = { userId: ANA, role: 'caller' };
const acc = { userId: ACC, role: 'accountant' };

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
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600));
  }
}

let ext = 0;
const attempt = (phone: string, status: string, minutesAgo: number, name = 'Ravi', amount = 1100) =>
  pool.query(
    `INSERT INTO abandoned_attempts (source_site, external_id, phone, name, amount, purpose, status, attempted_at)
     VALUES ('hkmv', $1, $2, $3, $4, 'Gau seva', $5, NOW() - ($6::int * INTERVAL '1 minute'))`,
    [`t-${++ext}`, phone, name, amount, status, minutesAgo]
  );
const ngCount = async () => Number((await pool.query(`SELECT COUNT(*) FROM drm_notifications WHERE kind = 'nearly_gave'`)).rows[0].count);

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;

  await pool.query(`TRUNCATE drm_notifications, drm_notification_seen, abandoned_attempts, sankalpam_calls, sankalpam_sends, sankalpam_dates, sankalpam_donors RESTART IDENTITY CASCADE`);
  await pool.query(`TRUNCATE people, leads, users RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO users (id, name, email, password_hash, role) VALUES ($1,'Ana','ana@t','x','caller'), ($2,'Acc','acc@t','x','accountant')`, [ANA, ACC]);

  console.log('\n1. nearly gave, as it happens');
  await attempt('9000000001', 'failed', 2, 'Failed Fast');
  await attempt('9000000002', 'pending', 3, 'Still Paying');
  await attempt('9000000003', 'pending', 20, 'Walked Away', 2500);
  await attempt('9000000003', 'pending', 18, 'Walked Away', 2500);
  await attempt('9000000004', 'failed', 60 * 30, 'Last Month');
  // Paid after failing.
  await attempt('9000000005', 'failed', 10, 'Paid Later');
  await upsertDonorSnapshot(
    { donor: { name: 'Paid Later', mobile: '9000000005', donorSince: new Date().toISOString() },
      donations: [{ externalId: 'paid-1', amount: 1100, type: 'Gau seva', status: 'completed', createdAt: new Date().toISOString(), isRecurring: false }] },
    'hkmv'
  );
  // Failed on one number, paid from another under the same full name.
  await attempt('9000000006', 'failed', 4, 'Sita Devi Rao', 5001);
  await upsertDonorSnapshot(
    { donor: { name: 'SITA DEVI RAO', mobile: '9111111106', donorSince: new Date().toISOString() },
      donations: [{ externalId: 'paid-6', amount: 5001, type: 'Gau seva', status: 'completed', createdAt: new Date().toISOString(), isRecurring: false }] },
    'annadan'
  );
  // A one-word name is too common: another "Ramesh" paying a different amount
  // is not taken as this one.
  await attempt('9000000007', 'failed', 4, 'Ramesh', 1000);
  await upsertDonorSnapshot(
    { donor: { name: 'Ramesh', mobile: '9111111107', donorSince: new Date().toISOString() },
      donations: [{ externalId: 'paid-7', amount: 251, type: 'Gau seva', status: 'completed', createdAt: new Date().toISOString(), isRecurring: false }] },
    'hkmv'
  );
  let n = await announceNearlyGave();
  const titles = (await pool.query(`SELECT title, body FROM drm_notifications ORDER BY created_at`)).rows;
  check('a failed payment is announced at once', titles.some((t) => t.title.startsWith('Payment failed · Failed Fast')), titles);
  check('one still on the payment page is not', !titles.some((t) => t.title.includes('Still Paying')), titles);
  check('one left 5 minutes is, once, saying how many tries', titles.filter((t) => t.title.includes('Walked Away')).length === 1 && titles.find((t) => t.title.includes('Walked Away'))?.body.includes('tried 2 times'), titles);
  check('nobody from last month, nobody who paid since', !titles.some((t) => /Last Month|Paid Later/.test(t.title)), { n, titles });
  check('nobody who paid from another number under the same full name', !titles.some((t) => /Sita/.test(t.title)), titles);
  check('but a one-word name needs the same amount too', titles.some((t) => /Ramesh/.test(t.title)), titles);
  check('three in all', n === 3, n);
  n = await announceNearlyGave();
  check('running again announces nothing twice', n === 0 && (await ngCount()) === 3);
  await pool.query(`UPDATE abandoned_attempts SET attempted_at = NOW() - INTERVAL '6 minutes' WHERE phone = '9000000002'`);
  n = await announceNearlyGave();
  check('5 minutes on, the unfinished one is announced', n === 1);

  console.log('\n2. the feed');
  let r = await req('GET', '/api/notifications', ana);
  check('four for the caller, all unread', r.body.notifications?.length === 4 && r.body.unread === 4, r.body);
  check('each nearly gave one knows its attempt, for Call', r.body.notifications.every((x: any) => x.attempt_id), r.body.notifications);
  // Walked Away pays now: the notification says so, no call needed.
  await upsertDonorSnapshot(
    { donor: { name: 'Walked Away', mobile: '9000000003', donorSince: new Date().toISOString() },
      donations: [{ externalId: 'paid-3', amount: 2500, type: 'Gau seva', status: 'completed', createdAt: new Date().toISOString(), isRecurring: false }] },
    'hkmv'
  );
  r = await req('GET', '/api/notifications', ana);
  const wa = r.body.notifications.find((x: any) => x.title.includes('Walked Away'));
  const ff = r.body.notifications.find((x: any) => x.title.includes('Failed Fast'));
  check('once they pay, the notification says "donated since"', wa?.paid_since === true && ff?.paid_since === false, { wa, ff });
  r = await req('POST', '/api/notifications/seen', ana, {});
  r = await req('GET', '/api/notifications', ana);
  check('read once seen', r.body.unread === 0, r.body.unread);
  r = await req('GET', '/api/notifications', acc);
  check('not for an accountant', r.status === 403);

  console.log('\n3. Sankalpam each morning');
  const today = new Date(Date.now() + 5.5 * 3600e3);
  const d = (await pool.query(`INSERT INTO sankalpam_donors (donor_name, phone) VALUES ('Today Donor', '9000000011') RETURNING id`)).rows[0].id;
  await pool.query(
    `INSERT INTO sankalpam_dates (donor_id, occasion, month, day, created_at) VALUES ($1, 'Birthday', $2, $3, NOW() - INTERVAL '40 days')`,
    [d, today.getUTCMonth() + 1, today.getUTCDate()]
  );
  await pool.query(`INSERT INTO sankalpam_donors (donor_name, phone) VALUES ('No Days', '9000000012')`);
  await sankalpMorning();
  await sankalpMorning();
  const sk = (await pool.query(`SELECT title, body, link FROM drm_notifications WHERE kind = 'sankalpam' ORDER BY ref_key`)).rows;
  check('the day\'s videos, once', sk.filter((x) => x.title.startsWith('Sankalpam today: 1')).length === 1, sk);
  check('and the donors to ring for their days', sk.some((x) => x.link === '/sankalpam?tab=need' && x.body.includes('1 not rung yet')), sk);

  console.log('\n4. "Add to Sankalpam" from a person\'s page');
  await upsertDonorSnapshot(
    { donor: { name: 'Small Giver', mobile: '9000000021', dob: '1990-03-14', donorSince: new Date().toISOString() },
      donations: [{ externalId: 'sg-1', amount: 101, type: 'Annadan', status: 'completed', createdAt: new Date().toISOString(), isRecurring: false }] },
    'annadan'
  );
  const pid = (await pool.query(`SELECT id FROM people WHERE phone = '9000000021'`)).rows[0].id;
  r = await req('GET', `/api/sankalpam/by-person/${pid}`, ana);
  check('not on the list yet', r.body.donor === null, r.body);
  r = await req('POST', `/api/sankalpam/from-person/${pid}`, ana, {});
  check('added whatever they gave, with the birthday from their form', r.status === 201 && r.body.days === 1, r.body);
  const sid = r.body.id;
  const src = (await pool.query(`SELECT source FROM sankalpam_donors WHERE id = $1`, [sid])).rows[0];
  check('marked as from donations', src.source === 'donors', src);
  r = await req('POST', `/api/sankalpam/from-person/${pid}`, ana, {});
  check('adding again points at the same entry', r.body.existing === true && r.body.id === sid, r.body);
  r = await req('GET', `/api/sankalpam/by-person/${pid}`, ana);
  check('and the page now says so', r.body.donor?.id === sid && r.body.donor.days === 1, r.body);
  await pool.query(`INSERT INTO people (name, phone) VALUES ('Volunteer', '9000000031')`);
  const vid = (await pool.query(`SELECT id FROM people WHERE phone = '9000000031'`)).rows[0].id;
  r = await req('POST', `/api/sankalpam/from-person/${vid}`, ana, {});
  const vsrc = (await pool.query(`SELECT source FROM sankalpam_donors WHERE id = $1`, [r.body.id])).rows[0];
  check('somebody who never gave is "added by hand"', r.status === 201 && vsrc.source === 'manual', vsrc);

  console.log('\n5. a day from a donation form rings the bell');
  await upsertDonorSnapshot(
    { donor: { name: 'Small Giver', mobile: '9000000021', donorSince: new Date().toISOString() },
      donations: [{ externalId: 'sg-2', amount: 101, type: 'Annadan', status: 'completed', createdAt: new Date().toISOString(), isRecurring: false,
                    occasion: 'Anniversary', sevaDate: '2026-12-01' }] as any },
    'annadan'
  );
  const day = (await pool.query(`SELECT title, body, link FROM drm_notifications WHERE ref_key LIKE 'sk-day:%'`)).rows;
  check('"New special day" for them', day.length === 1 && day[0].body.startsWith('1 Dec · Anniversary') && day[0].link.includes(sid), day);

  console.log('\n6. the Nearly gave list');
  await pool.query(`INSERT INTO leads (phone, name, status, last_contacted_at, assigned_to) VALUES ('9000000003', 'Walked Away', 'contacted', NOW() - INTERVAL '10 minutes', $1)`, [ANA]);
  r = await req('GET', '/api/crm/leads/abandoned?days=7', ana);
  const phones = (r.body.rows ?? []).map((x: any) => x.phone);
  check('a failed payment is on the list at once', phones.includes('9000000001'), phones);
  check('one pending 6 minutes is on it', phones.includes('9000000002'), phones);
  check('paid before anyone rang: off the list', !phones.includes('9000000005') && !phones.includes('9000000006'), phones);
  const paid = r.body.rows?.find((x: any) => x.phone === '9000000003');
  check('paid after a call: still shown, marked donated', paid?.gave_anyway === true && paid.called_since === true && r.body.paid_after_call === 1, paid);
  await attempt('9000000008', 'pending', 2, 'Just Started');
  r = await req('GET', '/api/crm/leads/abandoned?days=7', ana);
  check('one pending 2 minutes is not on it yet', !(r.body.rows ?? []).some((x: any) => x.phone === '9000000008'));

  console.log('\n7. ringing anyone on Sankalpam to check their details');
  r = await req('GET', '/api/sankalpam/donors?need=check', ana);
  const before = r.body.counts?.need_check;
  check('everyone active is on "Check details"', r.body.donors?.length === before && before >= 3, r.body.counts);
  const first = r.body.donors[0].id;
  r = await req('POST', `/api/sankalpam/donors/${first}/calls`, ana, { outcome: 'verified', note: 'all fine' });
  check('"Details correct" is saved', r.status === 201, r.body);
  r = await req('GET', '/api/sankalpam/donors?need=check', ana);
  check('and they leave the list for a year', r.body.counts.need_check === before - 1 && !r.body.donors.some((x: any) => x.id === first), r.body.counts);

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
