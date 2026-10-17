/**
 * A hidden donor is not shown anywhere - and nothing is deleted.
 *
 * WHY THIS EXISTS
 * Two test runs raised real receipts on the live site for made-up donors, and
 * those donors appeared on the Donations page, the People page and in the
 * dashboard totals. They cannot be deleted (a receipt number is an 80G record
 * somebody can ask about), so a donor can be marked hidden instead and every
 * screen that lists donors or adds up money reads live_people / live_donations.
 *
 * What this pins down, in the order it matters: the donor is gone from EVERY
 * place a person looks (a missed screen shows a fake gift or a wrong total), the
 * rows are still in the tables, the sync from the site cannot bring them back,
 * and it can all be undone.
 *
 *   NODE_ENV=development DATABASE_URL=...drm_test npx tsx scripts/test-hidden-donors.ts
 */
import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import { runMigrations } from '../src/db/migrate';
import { upsertDonorSnapshot } from '../src/services/hkmvSync';
import donationsRoutes from '../src/routes/donations';
import peopleRoutes from '../src/routes/people';
import reportsRoutes from '../src/routes/reports';
import crmSessionsRoutes from '../src/routes/crmSessions';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use('/api/donations', donationsRoutes);
app.use('/api/people', peopleRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/crm', crmSessionsRoutes);
let base = '';
const ADMIN = '11111111-1111-1111-1111-111111111111';
const token = generateToken({ userId: ADMIN, email: 'a@t', role: 'admin' } as never);

const get = (path: string) =>
  new Promise<any>((resolve, reject) => {
    const u = new URL(`${base}${path}`);
    http.get(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { authorization: `Bearer ${token}` } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            const body = JSON.parse(d || '{}');
            // A list stays a list: spreading an array into an object turns it into
            // {"0": ..., "1": ...} and Array.isArray goes false, which read as "empty".
            resolve(Array.isArray(body) ? Object.assign(body, { http: res.statusCode }) : { http: res.statusCode, ...body });
          } catch { resolve({ http: res.statusCode, raw: d.slice(0, 200) }); }
        });
      }
    ).on('error', reject);
  });

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${label}`);
  failures++;
  console.error(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`);
};

const counts = async () =>
  (await pool.query(`SELECT (SELECT COUNT(*)::int FROM people) AS people, (SELECT COUNT(*)::int FROM donations) AS donations`)).rows[0];

async function main() {
  const m = await runMigrations();
  check('the migration applies', m.ok, true);

  await pool.query(`TRUNCATE donations, person_names, people, users RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO users (id, name, email, password_hash, role) VALUES ($1,'Admin','a@t','x','admin')`, [ADMIN]);

  const real = (await pool.query(`INSERT INTO people (name, phone) VALUES ('Real Donor','9000000001') RETURNING id`)).rows[0].id;
  const fake = (await pool.query(`INSERT INTO people (name, phone) VALUES ('Keep Me','9811100001') RETURNING id`)).rows[0].id;
  await pool.query(
    `INSERT INTO donations (person_id, amount, payment_mode, external_ref, payment_ref, source_site, receipt_number)
     VALUES ($1,1000,'upi','R1','real_ref','hkmv','HKMI|R|1'), ($2,700,'upi','F1','pay_keep','hkmv','HKMI|R|2')`,
    [real, fake]
  );

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;

  console.log('\n--- before: both are shown ---');
  let d = await get('/api/donations?limit=100');
  check('donations: two rows', d.donations?.length, 2);
  check('donations: the total is 1,700', d.filteredAmount, 1700);
  let p = await get('/api/people?limit=100');
  check('people: two donors', p.total, 2);

  console.log('\n--- hide the made-up donor ---');
  await pool.query(`UPDATE people SET hidden_at = NOW(), hidden_reason = 'test' WHERE id = $1`, [fake]);

  d = await get('/api/donations?limit=100');
  check('Donations page: one row', d.donations?.map((r: any) => r.donor_name), ['Real Donor']);
  check('...its count', d.total, 1);
  check('...its filtered total no longer includes the fake gift', d.filteredAmount, 1000);
  const purposes = await get('/api/donations/purposes');
  check('purpose filter counts only the real gift', (Array.isArray(purposes) ? purposes : []).reduce((n: number, r: any) => n + r.count, 0), 1);
  const sources = await get('/api/donations/sources');
  check('site filter counts only the real gift', (sources.sites ?? []).reduce((n: number, r: any) => n + r.count, 0), 1);
  const exportCsv = await new Promise<string>((resolve) => {
    const u = new URL(`${base}/api/donations/export.csv`);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { authorization: `Bearer ${token}` } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(b));
    });
  });
  check('the download leaves them out too', /Keep Me/.test(exportCsv), false);

  p = await get('/api/people?limit=100');
  check('People page: one donor', p.people?.map((r: any) => r.name), ['Real Donor']);
  check('...its count', p.total, 1);

  const dash = await get('/api/reports/dashboard');
  check('dashboard: lifetime giving is 1,000', dash.giving?.lifetimeTotal, 1000);
  check('dashboard: one gift', dash.giving?.lifetimeCount, 1);
  check('dashboard: one person', dash.people?.total, 1);
  const top = await get('/api/reports/donors/top');
  check('top donors: only the real one', (Array.isArray(top) ? top : top.donors ?? []).map((r: any) => r.name), ['Real Donor']);
  const period = await get('/api/reports/donations/period');
  check('giving by period adds up to 1,000', (Array.isArray(period) ? period : []).reduce((n: number, r: any) => n + Number(r.total), 0), 1000);

  const found = await get('/api/crm/search?q=Keep');
  check('the search box does not find them', (found.people ?? []).length, 0);
  const foundReal = await get('/api/crm/search?q=Real');
  check('...and still finds a real donor', (foundReal.people ?? []).length, 1);

  console.log('\n--- nothing was deleted ---');
  check('both donors and both donations are still in the tables', await counts(), { people: 2, donations: 2 });
  const kept = (await pool.query(`SELECT d.receipt_number FROM donations d WHERE d.person_id = $1`, [fake])).rows;
  check('the receipt number is still on the record', kept.map((r) => r.receipt_number), ['HKMI|R|2']);

  console.log('\n--- the site cannot bring them back ---');
  await upsertDonorSnapshot({
    donor: { name: 'Keep Me', mobile: '9811100001', donorSince: '2024-01-01T00:00:00.000Z' },
    donations: [{
      externalId: 'F1', amount: 700, type: 'Annadan', status: 'completed', createdAt: new Date().toISOString(),
      isRecurring: false, receiptNumber: 'HKMI|R|2', paymentRef: 'pay_keep', paymentMode: 'upi',
    }],
  } as never, 'hkmv');
  check('after the site re-sends the donor, still hidden',
    (await pool.query(`SELECT hidden_at IS NOT NULL AS hidden FROM people WHERE id = $1`, [fake])).rows[0].hidden, true);
  d = await get('/api/donations?limit=100');
  check('...and still off the Donations page', d.total, 1);
  check('...with no duplicate created', (await counts()).donations, 2);

  console.log('\n--- and it can be undone ---');
  await pool.query(`UPDATE people SET hidden_at = NULL, hidden_reason = NULL WHERE id = $1`, [fake]);
  d = await get('/api/donations?limit=100');
  check('un-hidden: back on the Donations page', d.total, 2);
  check('...with the total back', d.filteredAmount, 1700);

  server.close();
  await pool.end();
  console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
  process.exit(failures ? 1 : 0);
}
main().catch(async (e) => {
  console.error('THREW:', e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
