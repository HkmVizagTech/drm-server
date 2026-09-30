// Proves that the calling dashboard shows a caller their own work and nobody
// else's.
//
// WHY THIS FILE EXISTS
// The dashboard was protected by hiding its link in the sidebar. The endpoint
// itself answered the same temple-wide figures to everybody, so a caller who
// typed the URL read the whole team's calls, money and leaderboard. A hidden
// link is not a permission, and the only way to keep it from quietly becoming
// one again is a test that asks the endpoint directly, with a caller's token,
// the way a curious caller would.
//
// HOW TO RUN IT
//   createdb drm_test
//   DATABASE_URL=postgresql://localhost/drm_test npm run test:scope

import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import crmReports from '../src/routes/crmReports';
import crmRoutes from '../src/routes/crm';
import crmLists from '../src/routes/crmLists';
import crmReminders from '../src/routes/crmReminders';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(
    `Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}".\n` +
      'This script empties tables. Point it at a database whose name ends in _test.'
  );
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use('/api/crm', crmRoutes);
app.use('/api/crm', crmReports);
app.use('/api/crm', crmLists);
app.use('/api/crm', crmReminders);

let base = '';

const ADMIN = '11111111-1111-1111-1111-111111111111';
const ANA = '22222222-2222-2222-2222-222222222222';
const BEN = '33333333-3333-3333-3333-333333333333';

function get(path: string, as: { userId: string; role: string }): Promise<{ status: number; body: any }> {
  const token = generateToken({ userId: as.userId, email: `${as.userId}@test`, role: as.role } as never);
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${path}`,
      { method: 'GET', headers: { authorization: `Bearer ${token}` } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: d ? JSON.parse(d) : {} });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: d });
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function put(path: string, body: unknown, as: { userId: string; role: string }): Promise<{ status: number; body: any }> {
  const token = generateToken({ userId: as.userId, email: 'x@test', role: as.role } as never);
  const raw = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${path}`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': raw.length,
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d ? JSON.parse(d) : {} }));
      }
    );
    req.on('error', reject);
    req.end(raw);
  });
}

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

/**
 * Two callers with deliberately unequal days, so any figure that fails to
 * narrow shows up as Ana seeing a number bigger than her own rather than as a
 * subtle difference nobody spots.
 *
 *   Ana  2 leads, 3 calls (2 connected), 1 QR shared
 *   Ben  5 leads, 9 calls (1 connected), 4 QRs shared
 */
async function seed() {
  await pool.query(
    `TRUNCATE qr_payments, qr_shares, razorpay_qrs, lead_activities, leads, users RESTART IDENTITY CASCADE`
  );
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role) VALUES
       ($1,'Admin','a@test','x','admin'),
       ($2,'Ana','ana@test','x','caller'),
       ($3,'Ben','ben@test','x','caller')`,
    [ADMIN, ANA, BEN]
  );
  await pool.query(
    `INSERT INTO razorpay_qrs (id, qr_id, label, active)
     VALUES ('44444444-4444-4444-4444-444444444444','qr_SCOPE0001','Shared QR',TRUE)`
  );

  const mkLeads = async (owner: string, n: number, prefix: string) => {
    for (let i = 0; i < n; i++) {
      await pool.query(
        `INSERT INTO leads (phone, name, status, assigned_to, expected_amount)
         VALUES ($1,$2,'new',$3::uuid, 1000)`,
        [`${prefix}${String(i).padStart(6, '0')}`, `${prefix} lead ${i}`, owner]
      );
    }
  };
  await mkLeads(ANA, 2, '9111');
  await mkLeads(BEN, 5, '9222');

  const someLead = (await pool.query(`SELECT id FROM leads LIMIT 1`)).rows[0].id;
  const mkCalls = async (user: string, n: number, connected: number) => {
    for (let i = 0; i < n; i++) {
      await pool.query(
        `INSERT INTO lead_activities (lead_id, user_id, kind, connected, occurred_at, source)
         VALUES ($1::uuid, $2::uuid, 'call', $3, NOW(), 'manual')`,
        [someLead, user, i < connected]
      );
    }
  };
  await mkCalls(ANA, 3, 2);
  await mkCalls(BEN, 9, 1);

  const mkShares = async (user: string, n: number) => {
    for (let i = 0; i < n; i++) {
      await pool.query(
        `INSERT INTO qr_shares (qr_id, lead_id, shared_by, phone, channel)
         VALUES ('44444444-4444-4444-4444-444444444444', $1::uuid, $2::uuid, $3, 'whatsapp')`,
        [someLead, user, `90000000${i}0`]
      );
    }
  };
  await mkShares(ANA, 1);
  await mkShares(BEN, 4);
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  await seed();

  console.log('\n1. an admin sees the temple');
  const admin = await get('/api/crm/dashboard?preset=today', { userId: ADMIN, role: 'admin' });
  check('200', admin.status === 200, admin.body);
  check('scope says team', admin.body.scope === 'team', admin.body.scope);
  check('all 7 leads', admin.body.leads.received === 7, admin.body.leads);
  check('all 12 calls', admin.body.calls.made === 12, admin.body.calls);
  check('all 5 QR shares', admin.body.qr.shared === 5, admin.body.qr);
  check('the leaderboard has both callers', admin.body.callers_today.length === 2, admin.body.callers_today);

  console.log('\n2. a caller sees only their own');
  const ana = await get('/api/crm/dashboard?preset=today', { userId: ANA, role: 'caller' });
  check('200', ana.status === 200, ana.body);
  check('scope says mine', ana.body.scope === 'mine', ana.body.scope);
  check('her 2 leads, not 7', ana.body.leads.received === 2, ana.body.leads);
  check('her 3 calls, not 12', ana.body.calls.made === 3, ana.body.calls);
  check('her 2 connected', ana.body.calls.connected === 2, ana.body.calls);
  check('her 1 QR share, not 5', ana.body.qr.shared === 1, ana.body.qr);
  check('her pipeline is 2 open leads, not 7', ana.body.pipeline.open_leads === 2, ana.body.pipeline);
  check('her follow-up counts cover 2 leads', ana.body.follow_ups.unscheduled === 2, ana.body.follow_ups);
  check(
    'the status breakdown counts 2',
    ana.body.by_status.reduce((t: number, s: { n: number }) => t + s.n, 0) === 2,
    ana.body.by_status
  );
  check(
    'the source breakdown counts 2',
    ana.body.by_source.reduce((t: number, s: { n: number }) => t + s.n, 0) === 2,
    ana.body.by_source
  );
  check('no leaderboard at all', ana.body.callers_today.length === 0, ana.body.callers_today);
  check(
    "Ben's name appears nowhere in the response",
    !JSON.stringify(ana.body).includes('Ben'),
    JSON.stringify(ana.body).slice(0, 400)
  );

  console.log('\n3. the other caller sees their own, not hers');
  const ben = await get('/api/crm/dashboard?preset=today', { userId: BEN, role: 'caller' });
  check('his 5 leads', ben.body.leads.received === 5, ben.body.leads);
  check('his 9 calls', ben.body.calls.made === 9, ben.body.calls);
  check('his 4 QR shares', ben.body.qr.shared === 4, ben.body.qr);

  console.log('\n4. the supervisory reports are refused to callers');
  for (const path of [
    '/api/crm/reports/callers',
    '/api/crm/reports/timeline',
    '/api/crm/reports/calls',
    '/api/crm/reports/conversion',
    '/api/crm/reports/follow-ups',
  ]) {
    const r = await get(`${path}?preset=today`, { userId: ANA, role: 'caller' });
    check(`${path} → 403`, r.status === 403, r.status);
  }
  const r = await get('/api/crm/reports/callers?preset=today', { userId: ADMIN, role: 'admin' });
  check('but an admin still gets them', r.status === 200, r.status);

  console.log('\n5. no token, no dashboard');
  const anon = await new Promise<number>((resolve) => {
    http.get(`${base}/api/crm/dashboard`, (res) => resolve(res.statusCode ?? 0));
  });
  check('401', anon === 401, anon);

  console.log('\n6. a caller cannot read the whole donor base');
  // `callers_see_all_leads` existed in settings, defaulted to off, had a
  // toggle on the setup screen - and no server code read it. A caller could
  // open the leads screen or the CSV export and take everything.
  await pool.query(`DELETE FROM crm_settings WHERE key = 'callers_see_all_leads'`);
  await pool.query(`INSERT INTO crm_settings (key, value) VALUES ('callers_see_all_leads','false'::jsonb)`);
  const mine = await pool.query(
    `INSERT INTO leads (phone, name, assigned_to) VALUES ('9101010101','Ana lead',$1::uuid) RETURNING id`,
    [ANA]
  );
  const theirs = await pool.query(
    `INSERT INTO leads (phone, name, assigned_to) VALUES ('9202020202','Ben lead',$1::uuid) RETURNING id`,
    [BEN]
  );
  await pool.query(`INSERT INTO leads (phone, name) VALUES ('9303030303','Nobody lead')`);

  let g = await get('/api/crm/leads?limit=100', { userId: ANA, role: 'caller' });
  const names = (g.body.leads ?? []).map((l: any) => l.name);
  check('her own lead is there', names.includes('Ana lead'), names);
  check('the unassigned one too', names.includes('Nobody lead'), names);
  check("but NOT a colleague's", !names.includes('Ben lead'), names);

  g = await get(`/api/crm/leads/${theirs.rows[0].id}`, { userId: ANA, role: 'caller' });
  check("and she cannot open it directly either", g.status === 404, g.status);
  g = await get(`/api/crm/leads/${mine.rows[0].id}`, { userId: ANA, role: 'caller' });
  check('her own opens fine', g.status === 200, g.status);

  g = await get('/api/crm/leads/export.csv', { userId: ANA, role: 'caller' });
  const csv = typeof g.body === 'string' ? g.body : JSON.stringify(g.body);
  check('the export is narrowed too', !/Ben lead/.test(csv), csv.slice(0, 200));

  // And with the setting on, she sees everything.
  await pool.query(`UPDATE crm_settings SET value = 'true'::jsonb WHERE key = 'callers_see_all_leads'`);
  g = await get('/api/crm/leads?limit=100', { userId: ANA, role: 'caller' });
  check(
    'switching the setting on opens it up',
    (g.body.leads ?? []).map((l: any) => l.name).includes('Ben lead'),
    (g.body.leads ?? []).length
  );
  const admin2 = await get('/api/crm/leads?limit=100', { userId: ADMIN, role: 'admin' });
  const adminNames = (admin2.body.leads ?? []).map((l: any) => l.name);
  check(
    'an admin always sees everything',
    ['Ana lead', 'Ben lead', 'Nobody lead'].every((n) => adminNames.includes(n)),
    adminNames.length
  );

  console.log('\n7. a caller cannot rewrite the temple\'s configuration');
  for (const path of ['/api/crm/settings/max_attempts', '/api/crm/statuses/new', '/api/crm/dispositions/interested']) {
    const r2 = await put(path, { value: 1, label: 'x' }, { userId: ANA, role: 'caller' });
    check(`${path} → 403`, r2.status === 403, r2.status);
  }

  console.log('\n8. the top-donor report cannot be used to read the users table');
  const inj = await get(
    `/api/crm/../reports/donors/top?period=${encodeURIComponent("1' UNION SELECT id,email,password_hash,1,1 FROM users--")}`,
    { userId: ADMIN, role: 'admin' }
  );
  check('the injection does not execute', inj.status !== 200 || !JSON.stringify(inj.body).includes('password'), inj.status);

  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall green\n');
  server.close();
  await pool.end();
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
