// "All these calls - incoming, outgoing and everything - need to be counted in
// total calls made."
//
//   DATABASE_URL=postgresql://localhost/drm_test npx tsx scripts/test-call-totals.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import crmRoutes from '../src/routes/crm';
import crmReportsRoutes from '../src/routes/crmReports';
import authRoutes from '../src/routes/auth';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use('/api/crm', crmRoutes);
app.use('/api/crm', crmReportsRoutes);
app.use('/api/auth', authRoutes);
let base = '';
const ADMIN = '11111111-1111-1111-1111-111111111111';
const ANA = '22222222-2222-2222-2222-222222222222';

function get(path: string, as: { userId: string; role: string }): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(`${base}${path}`, { headers: { authorization: `Bearer ${generateToken({ userId: as.userId, role: as.role } as never)}` } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(d || '{}') }));
    }).on('error', reject);
  });
}

let failures = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}`, ok ? '' : JSON.stringify(d)?.slice(0, 600));
  if (!ok) failures++;
};

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  await pool.query(`TRUNCATE phone_calls, sankalpam_calls, sankalpam_dates, sankalpam_donors, lead_activities, app_devices, leads, users RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO users (id, name, email, password_hash, role) VALUES ($1,'Admin','a@t','x','admin'), ($2,'Ana','ana@t','x','caller')`, [ADMIN, ANA]);
  const dev = (await pool.query(`INSERT INTO app_devices (install_id, user_id, key_hash) VALUES ('i', $1, 'h') RETURNING id`, [ANA])).rows[0].id;
  const lead = async (phone: string) => (await pool.query(`INSERT INTO leads (phone, name, assigned_to) VALUES ($1, 'L', $2) RETURNING id`, [phone, ANA])).rows[0].id as string;
  const act = async (leadId: string, minsAgo: number, direction = 'outbound', connected = true) =>
    (await pool.query(
      `INSERT INTO lead_activities (lead_id, user_id, kind, direction, connected, disposition, source, occurred_at)
       VALUES ($1, $2, 'call', $3, $4, 'interested', 'manual', NOW() - make_interval(mins => $5)) RETURNING id`,
      [leadId, ANA, direction, connected, minsAgo]
    )).rows[0].id as string;
  let k = 0;
  const pc = (phone: string, leadId: string | null, minsAgo: number, opts: { direction?: string; secs?: number; activity?: string | null } = {}) =>
    pool.query(
      `INSERT INTO phone_calls (device_id, user_id, call_key, direction, phone, lead_id, activity_id, started_at, duration_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() - make_interval(mins => $8), $9)`,
      [dev, ANA, `k${++k}`, opts.direction ?? 'outbound', phone, leadId, opts.activity ?? null, minsAgo, opts.secs ?? 60]
    );

  // 1. Saved on the call screen, and the phone's record linked to it: one call.
  const l1 = await lead('9000000001');
  await pc('9000000001', l1, 120, { activity: await act(l1, 118) });
  // 2. Saved, the phone's record not linked yet: still one call.
  const l2 = await lead('9000000002');
  await act(l2, 58);
  await pc('9000000002', l2, 60);
  // 3. Dialled on the phone, nothing saved: counted.
  const l3 = await lead('9000000003');
  await pc('9000000003', l3, 50, { secs: 0 });
  // 4. They rang, answered (the app saves it as an incoming call).
  const l4 = await lead('9000000004');
  await pc('9000000004', l4, 40, { direction: 'inbound', activity: await act(l4, 40, 'inbound', true) });
  // 5. They rang, missed.
  const l5 = await lead('9000000005');
  await pc('9000000005', l5, 30, { direction: 'missed', secs: 0, activity: await act(l5, 30, 'missed', false) });
  // 6. A Sankalpam call.
  const d6 = (await pool.query(`INSERT INTO sankalpam_donors (donor_name, phone) VALUES ('S6', '9000000006') RETURNING id`)).rows[0].id;
  await pool.query(`INSERT INTO sankalpam_calls (donor_id, outcome, called_by, called_at) VALUES ($1, 'got_details', $2, NOW() - INTERVAL '20 minutes')`, [d6, ANA]);
  // 7. A Sankalpam call the phone also saw (the donor is a lead too): one call.
  const l7 = await lead('9000000007');
  const d7 = (await pool.query(`INSERT INTO sankalpam_donors (donor_name, phone) VALUES ('S7', '9000000007') RETURNING id`)).rows[0].id;
  await pool.query(`INSERT INTO sankalpam_calls (donor_id, outcome, called_by, called_at) VALUES ($1, 'no_answer', $2, NOW() - INTERVAL '9 minutes')`, [d7, ANA]);
  await pc('9000000007', l7, 10, { secs: 0 });
  // 8. Dialled twice, saved once: two calls.
  const l8 = await lead('9000000008');
  const a8 = await act(l8, 5);
  await pc('9000000008', l8, 7, { secs: 0, activity: a8 });
  await pc('9000000008', l8, 6);

  console.log('\nthe overview (Ana)');
  const d = await get('/api/crm/dashboard?range=today', { userId: ANA, role: 'caller' });
  const c = d.calls;
  check('9 calls in all', c?.made === 9, c);
  check('5 outgoing (2 of them not saved), 1 incoming, 1 missed, 2 Sankalpam',
    c?.breakdown?.outgoing === 5 && c.breakdown.not_saved === 2 && c.breakdown.incoming === 1 && c.breakdown.missed === 1 && c.breakdown.sankalpam === 2, c?.breakdown);

  console.log('\nthe admin overview and the caller report agree');
  const ad = await get('/api/crm/dashboard?range=today', { userId: ADMIN, role: 'admin' });
  check('team total 9', ad.calls?.made === 9, ad.calls);
  const ana = (ad.callers ?? ad.by_caller ?? []).find((x: any) => x.id === ANA || x.user_id === ANA);
  check("Ana's leaderboard row says 9", ana?.calls === 9, ad.callers ?? ad.by_caller);
  const rep = await get('/api/crm/reports/callers?range=today', { userId: ADMIN, role: 'admin' });
  const row = (rep.callers ?? rep.rows ?? []).find((x: any) => x.id === ANA);
  check('caller report: 9', row?.calls === 9, rep);
  const tl = await get('/api/crm/reports/timeline?range=today', { userId: ADMIN, role: 'admin' });
  const tlSum = (tl.buckets ?? []).reduce((s: number, b: any) => s + Number(b.calls), 0);
  check('timeline: 9', tlSum === 9, tl.buckets);
  const cr = await get('/api/crm/reports/calls?range=today', { userId: ADMIN, role: 'admin' });
  check('call report: 9, with "Not saved in DRM" and "Sankalpam call" rows', cr.totals?.made === 9 &&
    cr.by_disposition?.some((x: any) => x.label === 'Not saved in DRM' && x.n === 2) &&
    cr.by_disposition?.some((x: any) => x.label === 'Sankalpam call' && x.n === 2), cr);
  const team = await get('/api/auth/users', { userId: ADMIN, role: 'admin' });
  const t = (team.users ?? []).find((u: any) => u.id === ANA);
  check('team page, last 7 days: 9', t?.calls_7d === 9, t);

  console.log('\nonce the phone record is linked, the total does not change');
  await pool.query(`UPDATE phone_calls SET activity_id = (SELECT id FROM lead_activities WHERE lead_id = $1) WHERE lead_id = $1`, [l2]);
  check('still 9', (await get('/api/crm/dashboard?range=today', { userId: ANA, role: 'caller' })).calls?.made === 9);

  server.close();
  await pool.end();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
