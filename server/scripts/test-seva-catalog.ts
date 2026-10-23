/**
 * The seva catalog and the Seva Code on receipts.
 *
 * A fake donation site stands in for the real one (a test database may only reach a
 * local address), so what DRM actually SENDS to the site is checked, not assumed.
 *
 *   NODE_ENV=development DATABASE_URL=...drm_test npx tsx scripts/test-seva-catalog.ts
 */
import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import { runMigrations } from '../src/db/migrate';
import sevaCatalogRoutes from '../src/routes/sevaCatalog';
import donationsRoutes from '../src/routes/donations';
import { seedSevaCatalog, resolveSeva } from '../src/services/sevaCatalog';
import { seedRows } from '../src/db/sevaCatalogSeed';
import { buildOfflineBody } from '../src/services/hkmvClient';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

/* A stand-in for the donation sites: records what it is sent and issues a receipt. */
const received: { path: string; body: any }[] = [];
const fake = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString();
    if (req.method === 'POST' && req.url === '/api/internal/drm/donations/offline') {
      const body = JSON.parse(raw || '{}');
      received.push({ path: req.url, body });
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ donation: { _id: 'site-1', receiptNumber: 'HKMI|T|1', donorName: body.donorName ?? body.name, amount: body.amount } }));
    }
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  });
});

const app = express();
app.use(express.json());
app.use('/api/seva-catalog', sevaCatalogRoutes);
app.use('/api/donations', donationsRoutes);
let base = '';
const ADMIN = '11111111-1111-1111-1111-111111111111';
const CALLER = '33333333-3333-3333-3333-333333333333';
const tokens = {
  admin: generateToken({ userId: ADMIN, email: 'a@t', role: 'admin' } as never),
  caller: generateToken({ userId: CALLER, email: 'c@t', role: 'caller' } as never),
};

const call = (as: keyof typeof tokens, method: string, path: string, body?: unknown) =>
  new Promise<any>((resolve, reject) => {
    const u = new URL(`${base}${path}`);
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
        headers: { authorization: `Bearer ${tokens[as]}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => { try { resolve({ http: res.statusCode, ...JSON.parse(d || '{}') }); } catch { resolve({ http: res.statusCode }); } });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${label}`);
  failures++;
  console.error(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`);
};

async function main() {
  const m = await runMigrations();
  check('the migration applies', m.ok, true);
  await pool.query(`TRUNCATE seva_catalog, qr_payments, collections, donations, person_names, people, users RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO users (id, name, email, password_hash, role) VALUES ($1,'Admin','a@t','x','admin'), ($2,'Caller','c@t','x','caller')`, [ADMIN, CALLER]);

  const api = http.createServer(app).listen(0);
  await new Promise((r) => api.once('listening', r));
  base = `http://127.0.0.1:${(api.address() as any).port}`;
  await new Promise((r) => fake.listen(0, '127.0.0.1', () => r(null)));
  const site = `http://127.0.0.1:${(fake.address() as any).port}`;
  process.env.HKMV_API_URL = site; process.env.HKMV_INTERNAL_SECRET = 's';
  process.env.ANNADAN_API_URL = site; process.env.ANNADAN_INTERNAL_SECRET = 's';

  console.log('\n--- the temple\'s list loads, once, with no duplicates ---');
  const rows = seedRows();
  check('every row has its own identity', new Set(rows.map((r) => `${r.subCategoryId}:${r.subCodeId ?? 0}`)).size, rows.length);
  check('the list is loaded when the catalog is empty', await seedSevaCatalog(), rows.length);
  check('and never again', await seedSevaCatalog(), 0);
  check('the database holds each exactly once', (await pool.query(`SELECT COUNT(*)::int AS n FROM seva_catalog`)).rows[0].n, rows.length);
  const dup = await pool.query(`SELECT COUNT(*)::int AS n FROM (SELECT sub_category_id, COALESCE(sub_code_id,0) FROM seva_catalog GROUP BY 1,2 HAVING COUNT(*) > 1) x`);
  check('no identity appears twice', dup.rows[0].n, 0);
  const brick = (await pool.query(`SELECT * FROM seva_catalog WHERE code = 'BSC'`)).rows;
  check('Brick Seva is there with its code', [brick.length, brick[0].category, brick[0].sub_category, brick[0].sub_code], [1, 'General Donation', 'Brick Seva', null]);
  const deep = (await pool.query(`SELECT code, sub_code, sub_code_id, is_tax_exempted FROM seva_catalog WHERE sub_category = 'Deepotsava' ORDER BY sub_code_id LIMIT 1`)).rows[0];
  check('a seva with sub codes keeps them', deep, { code: 'DEEP', sub_code: 'Annadana Seva', sub_code_id: 1, is_tax_exempted: true });

  console.log('\n--- who can see and change the list ---');
  const list = await call('caller', 'GET', '/api/seva-catalog?active=true');
  check('a caller can read the list', [list.http, list.total], [200, rows.length]);
  const newSeva = { category: 'Test Category', category_id: 50, code: 'TST', sub_category: 'Test Seva', sub_category_id: 500, sub_code: '', sub_code_id: '' };
  check('a caller cannot add a seva', (await call('caller', 'POST', '/api/seva-catalog', newSeva)).http, 403);
  check('an admin can', (await call('admin', 'POST', '/api/seva-catalog', newSeva)).http, 201);
  check('the same seva again is refused', (await call('admin', 'POST', '/api/seva-catalog', newSeva)).http, 409);
  check('a sub category ID that belongs to another seva is refused', (await call('admin', 'POST', '/api/seva-catalog', { ...newSeva, sub_category: 'Something else', sub_code: 'X', sub_code_id: 9001 })).http, 409);
  check('a sub code needs its ID', (await call('admin', 'POST', '/api/seva-catalog', { ...newSeva, sub_category_id: 501, sub_code: 'Named' })).http, 400);
  check('a code is required', (await call('admin', 'POST', '/api/seva-catalog', { ...newSeva, sub_category_id: 502, code: '' })).http, 400);
  const added = (await pool.query(`SELECT id FROM seva_catalog WHERE code = 'TST'`)).rows[0].id;
  check('a seva can be switched off', (await call('admin', 'PATCH', `/api/seva-catalog/${added}`, { is_active: false })).http, 200);
  check('and is then left out of what receipts offer', (await call('caller', 'GET', '/api/seva-catalog?active=true')).total, rows.length);
  check('but nothing was deleted', (await pool.query(`SELECT COUNT(*)::int AS n FROM seva_catalog`)).rows[0].n, rows.length + 1);

  console.log('\n--- importing the real sheet checks the list and never duplicates it ---');
  const heads = ['Account Type', 'Seva Category', 'Seva Sub Category', 'Seva Code', 'Seva Sub Code', 'SevaCategoryId', 'SevaSubCategoryId', 'SevaSubCategoryCodeId', 'IsActive', 'IsTaxEempted'];
  const sheet = [
    ['HKMI', 'General Donation', 'Brick Seva', 'BSC', 'NULL', '2', '103', 'NULL', '1', 'NULL'],                  // matches
    ['HKMI', 'Cultural Program', 'Deepotsava', 'DEEP', 'Annadana Seva', '3', '5', '1', '1', '0'],               // tax differs
    ['HKMI', 'Cultural Program', 'Sankranti', 'SANK', 'Goda Kalyanam Seva', '3', '111', '144', '1', '0'],        // new
    ['HKMI', 'Cultural Program', 'Sankranti', 'SANK', 'Goda Kalyanam Seva', '3', '111', '144', '1', '0'],        // repeated
    ['HKMI', 'Cultural Program', 'Wrong Name', 'DEEP', 'Mandapa Seva', '3', '5', '2', '1', '0'],                 // sub category id clash
    ['HKMI', '', 'No Category', 'X', 'NULL', '', '700', 'NULL', '1', 'NULL'],                                    // problem
  ];
  const imp = (dry: boolean) => call('admin', 'POST', '/api/seva-catalog/import', { headers: heads, rows: sheet, dry_run: dry });
  const before = (await pool.query(`SELECT COUNT(*)::int AS n FROM seva_catalog`)).rows[0].n;
  const d = await imp(true);
  check('a dry run says what would happen', [d.new, d.changed, d.same, d.repeated, d.problems], [1, 1, 1, 1, 2]);
  check('it names the field that differs', d.changes[0].fields.map((f: any) => f.field), ['Tax exempted']);
  check('and reports the rest of the list as not in this file', d.not_in_file > 100, true);
  check('a dry run writes nothing', (await pool.query(`SELECT COUNT(*)::int AS n FROM seva_catalog`)).rows[0].n, before);
  check('only an admin can import', (await call('caller', 'POST', '/api/seva-catalog/import', { headers: heads, rows: sheet })).http, 403);
  await pool.query(`UPDATE seva_catalog SET is_active = FALSE WHERE code = 'BSC'`);
  const real = await imp(false);
  check('the real import adds the new one and corrects the different one', [real.new, real.changed], [1, 1]);
  check('importing the same sheet again changes nothing', [(await imp(false)).new, (await imp(false)).changed], [0, 0]);
  check('the sheet did not switch a seva back on', (await pool.query(`SELECT is_active FROM seva_catalog WHERE code = 'BSC'`)).rows[0].is_active, false);
  await pool.query(`UPDATE seva_catalog SET is_active = TRUE WHERE code = 'BSC'`);
  check('the corrected tax value is stored', (await pool.query(`SELECT is_tax_exempted FROM seva_catalog WHERE sub_category = 'Deepotsava' AND sub_code_id = 1`)).rows[0].is_tax_exempted, false);

  console.log('\n--- what a receipt sends to the site ---');
  const bsc = (await pool.query(`SELECT id FROM seva_catalog WHERE code = 'BSC'`)).rows[0].id;
  const deepId = (await pool.query(`SELECT id FROM seva_catalog WHERE sub_category = 'Deepotsava' AND sub_code_id = 1`)).rows[0].id;
  check('the name is the sub category, with the sub code when there is one',
    [(await resolveSeva(bsc))?.name, (await resolveSeva(deepId))?.name], ['Brick Seva', 'Deepotsava - Annadana Seva']);
  check('a seva switched off is not offered', await resolveSeva(added), null);
  check('...but one already chosen can still be resolved for a retry', (await resolveSeva(added, pool, { allowInactive: true }))?.code, 'TST');
  check('a made-up id is nothing', await resolveSeva('00000000-0000-0000-0000-000000000000'), null);

  const body = (site: 'hkmv' | 'annadan', code: string | null) =>
    buildOfflineBody(site, { donorName: 'D', donorMobile: '9', amount: 1, paymentMode: 'cash', referenceNo: 'r', sevaName: 'Brick Seva', sevaCode: code });
  check('the main site gets the Seva Code', (body('hkmv', 'BSC') as any).sevaCode, 'BSC');
  check('no code, no field', 'sevaCode' in body('hkmv', null), false);
  check('annadan is never sent a Seva Code', 'sevaCode' in body('annadan', 'BSC'), false);
  process.env.SEVA_CODE_FIELD = 'seva_code';
  check('the field name can be changed without a release', [(body('hkmv', 'BSC') as any).seva_code, 'sevaCode' in body('hkmv', 'BSC')], ['BSC', false]);
  delete process.env.SEVA_CODE_FIELD;

  const offline = (extra: Record<string, unknown>) =>
    call('admin', 'POST', '/api/donations/offline', {
      site: 'hkmv', donor_name: 'Test Donor', donor_mobile: '9000000099', amount: 500, payment_mode: 'cash', ...extra,
    });
  received.length = 0;
  const r1 = await offline({ seva_catalog_id: deepId });
  check('a cash receipt with a listed seva is issued', [r1.http, r1.receiptNumber], [201, 'HKMI|T|1']);
  check('and the site was sent the Seva Code and the seva name',
    [received[0]?.body.sevaCode, received[0]?.body.sevaName], ['DEEP', 'Deepotsava - Annadana Seva']);
  received.length = 0;
  const r2 = await offline({ seva_catalog_id: added });
  check('a seva that is switched off is refused, and nothing reaches the site', [r2.http, received.length], [400, 0]);
  received.length = 0;
  const r3 = await offline({ seva_catalog_id: '00000000-0000-0000-0000-000000000000' });
  check('so is one that does not exist', [r3.http, received.length], [400, 0]);
  received.length = 0;
  const r4 = await offline({ seva_name: 'Annadan' });
  check('the old way still works: a typed seva, no code', [r4.http, received[0]?.body.sevaName, 'sevaCode' in (received[0]?.body ?? {})], [201, 'Annadan', false]);
  received.length = 0;
  const r5 = await offline({ site: 'annadan', seva_catalog_id: deepId });
  check('annadan gets the seva as its occasion and no code', [r5.http, received[0]?.body.occasion, 'sevaCode' in (received[0]?.body ?? {})], [201, 'Deepotsava - Annadana Seva', false]);

  api.close(); fake.close();
  await pool.end();
  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nall passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
