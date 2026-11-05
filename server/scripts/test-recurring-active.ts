// Recurring donations: only the REALLY active ones are counted and shown, and a refresh from the sites
// brings the rest up to date.
//
// Never reaches a donation site: the fetcher is a stand-in, and the site address is a local one nothing
// listens on.
//
//   NODE_ENV=development DATABASE_URL=...drm_test npx tsx scripts/test-recurring-active.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { runMigrations } from '../src/db/migrate';
import { generateToken } from '../src/middleware/auth';
import subscriptionsRoutes from '../src/routes/subscriptions';
import reportsRoutes from '../src/routes/reports';
import { refreshSubscriptions } from '../src/services/subscriptionRefresh';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}
const real = (v?: string) => !!v && !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(v);
if (real(process.env.HKMV_API_URL) || real(process.env.ANNADAN_API_URL)) {
  console.error('Refusing to run with a real donation site address set.');
  process.exit(1);
}
// A local address nothing listens on: "configured" for the refresh, and unable to reach anything.
process.env.HKMV_API_URL = 'http://127.0.0.1:9';
process.env.HKMV_INTERNAL_SECRET = 'test';

let failures = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}`, ok ? '' : JSON.stringify(d)?.slice(0, 300));
  if (!ok) failures++;
};

async function main() {
  await runMigrations();
  await pool.query(`TRUNCATE subscriptions, donations, people, users RESTART IDENTITY CASCADE`);
  const ADMIN = '11111111-1111-1111-1111-111111111111';
  await pool.query(`INSERT INTO users (id, name, email, password_hash, role) VALUES ($1,'Admin','a@t','x','admin')`, [ADMIN]);

  let n = 0;
  const sub = async (label: string, o: { ext: string | null; status: string; site: string | null; site_status: string | null; last: string | null; freq?: string; amount: number; start?: string }) => {
    const phone = `90000000${String(++n).padStart(2, '0')}`;
    const p = (await pool.query(`INSERT INTO people (name, phone) VALUES ($1, $2) RETURNING id`, [label, phone])).rows[0].id as string;
    await pool.query(
      `INSERT INTO subscriptions (person_id, amount, frequency, status, external_ref, source_site, site_status, last_charged_at, start_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7, ${o.last ? `NOW() - INTERVAL '${o.last}'` : 'NULL'}, ${o.start ? `CURRENT_DATE - ${o.start}` : 'CURRENT_DATE - 200'})`,
      [p, o.amount, o.freq ?? 'monthly', o.status, o.ext, o.site ?? 'drm', o.site_status]
    );
    return { person: p, phone };
  };
  await sub('manual', { ext: null, status: 'active', site: null, site_status: null, last: null, amount: 500 });
  const paid = await sub('paid lately', { ext: 'sub_b', status: 'active', site: 'hkmv', site_status: 'completed', last: '5 days', amount: 1000 });
  const old = await sub('paid long ago', { ext: 'sub_c', status: 'active', site: 'hkmv', site_status: 'completed', last: '60 days', amount: 700 });
  await sub('annadan active', { ext: 'sub_d', status: 'active', site: 'annadan', site_status: 'active', last: '10 days', amount: 300 });
  await sub('pending', { ext: 'sub_e', status: 'active', site: 'annadan', site_status: 'pending', last: null, amount: 800 });
  await sub('never confirmed', { ext: 'sub_f', status: 'active', site: 'annadan', site_status: null, last: null, amount: 900 });
  await sub('yearly', { ext: 'sub_g', status: 'active', site: 'hkmv', site_status: 'completed', last: '200 days', freq: 'yearly', amount: 1200 });
  await sub('cancelled', { ext: 'sub_h', status: 'cancelled', site: 'hkmv', site_status: 'cancelled', last: '3 days', amount: 400 });

  const app = express();
  app.use(express.json());
  app.use('/api/subscriptions', subscriptionsRoutes);
  app.use('/api/reports', reportsRoutes);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const token = generateToken({ userId: ADMIN, role: 'admin' } as never);
  const get = (path: string) =>
    new Promise<any>((resolve, reject) => {
      http.get({ port, path, headers: { authorization: `Bearer ${token}` } }, (res) => {
        let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(JSON.parse(d || '{}')));
      }).on('error', reject);
    });

  console.log('\n--- what counts as really active ---');
  let r = await get('/api/subscriptions?status=active');
  const names = (r.subscriptions as { donor_name: string }[]).map((x) => x.donor_name).sort();
  check('the Active tab: by hand, paid lately, annadan active, yearly within its year', JSON.stringify(names) === JSON.stringify(['annadan active', 'manual', 'paid lately', 'yearly']), names);
  r = await get('/api/subscriptions?status=lapsed');
  const lapsed = (r.subscriptions as { donor_name: string; really_active: boolean }[]).map((x) => x.donor_name).sort();
  check('"Not charging": paid long ago, pending, never confirmed', JSON.stringify(lapsed) === JSON.stringify(['never confirmed', 'paid long ago', 'pending']), lapsed);
  check('and each says it is not really active', r.subscriptions.every((x: any) => x.really_active === false), r.subscriptions);
  r = await get('/api/subscriptions?status=cancelled');
  check('a cancelled one stays under Cancelled', r.subscriptions.length === 1, r);

  console.log('\n--- the dashboard card uses the same rule ---');
  r = await get('/api/reports/dashboard');
  // 500 + 1000 + 300 + 1200/12
  check('4 really active, worth 1,900 a month', r.recurring?.activeCount === 4 && Math.round(r.recurring?.monthlyValue) === 1900, r.recurring);

  console.log('\n--- a refresh from the sites brings one up to date ---');
  const asked: string[] = [];
  const out = await refreshSubscriptions(async (site, phone) => {
    asked.push(`${site}:${phone}`);
    if (phone === old.phone) {
      return {
        success: true,
        found: true,
        donor: { externalId: 'ext-old', name: 'paid long ago', mobile: old.phone },
        donations: [],
        subscriptions: [{ subscriptionId: 'sub_c', sevaName: 'Annadanam', amount: 700, status: 'completed', startedAt: new Date(Date.now() - 200 * 86400000).toISOString(), lastChargedAt: new Date(Date.now() - 2 * 86400000).toISOString(), chargeCount: 6 }],
      } as never;
    }
    if (phone === paid.phone) throw new Error('site unreachable');
    return { success: true, found: false } as never;
  });
  check('it asked for the donors DRM knows', asked.length >= 4, asked);
  check('one updated, one failed, the rest had nothing new', out.updated === 1 && out.failed === 1, out);
  const c = (await pool.query(`SELECT status, site_status FROM subscriptions WHERE external_ref = 'sub_c'`)).rows[0];
  check('the one that has paid since is active again', c.status === 'active' && c.site_status === 'completed', c);
  r = await get('/api/subscriptions?status=active');
  check('and now shown on the Active tab', (r.subscriptions as { donor_name: string }[]).some((x) => x.donor_name === 'paid long ago'), r.subscriptions.map((x: any) => x.donor_name));

  server.close();
  await pool.end();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await pool.end().catch(() => undefined); process.exit(1); });
