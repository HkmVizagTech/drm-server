// "Only ring the people who have given at least ₹500" - on Leads, in a run
// started from Leads, on a calling list, and on Start calling.
//
//   DATABASE_URL=postgresql://localhost/drm_test npx tsx scripts/test-given-filter.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import crmRoutes from '../src/routes/crm';
import crmListsRoutes from '../src/routes/crmLists';
import crmSessionsRoutes from '../src/routes/crmSessions';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use('/api/crm', crmRoutes);
app.use('/api/crm', crmListsRoutes);
app.use('/api/crm', crmSessionsRoutes);
let base = '';
const ADMIN = '11111111-1111-1111-1111-111111111111';
const token = generateToken({ userId: ADMIN, role: 'admin' } as never);

function get(path: string) {
  return new Promise<any>((resolve, reject) => {
    http.get(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d || '{}')));
    }).on('error', reject);
  });
}

function post(path: string, body: unknown) {
  return new Promise<any>((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(`${base}${path}`);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(d || '{}') }));
      }
    );
    r.on('error', reject);
    r.end(data);
  });
}

let failures = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}`, ok ? '' : JSON.stringify(d)?.slice(0, 500));
  if (!ok) failures++;
};

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  await pool.query(`TRUNCATE calling_lists, lead_activities, leads, lead_import_batches, donations, people, users RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO users (id, name, email, password_hash, role) VALUES ($1,'Admin','a@t','x','admin')`, [ADMIN]);
  const batch = (await pool.query(`INSERT INTO lead_import_batches (filename) VALUES ('Janmashtami.xlsx') RETURNING id`)).rows[0].id;
  const other = (await pool.query(`INSERT INTO lead_import_batches (filename) VALUES ('Other.xlsx') RETURNING id`)).rows[0].id;
  const person = (await pool.query(`INSERT INTO people (name, phone) VALUES ('Site Donor','9800000004') RETURNING id`)).rows[0].id;
  await pool.query(`INSERT INTO donations (person_id, amount, payment_mode) VALUES ($1, 700, 'upi'), ($1, 600, 'upi')`, [person]);
  const add = async (phone: string, name: string, b: string, ext: number | null, personId: string | null = null, converted: number | null = null) =>
    (await pool.query(
      `INSERT INTO leads (phone, name, import_batch_id, external_total_donated, person_id, converted_amount, converted_at)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $6::numeric IS NULL THEN NULL ELSE NOW() END) RETURNING id`,
      [phone, name, b, ext, personId, converted]
    )).rows[0].id as string;
  const never = await add('9800000001', 'Never gave', batch, null);
  const little = await add('9800000002', 'Gave 200', batch, 200);
  const big = await add('9800000003', 'Gave 5000 (sheet)', batch, 5000);
  const site = await add('9800000004', 'Gave 1300 (site)', batch, 100, person);
  const afterCall = await add('9800000005', 'Gave 1000 after a call', batch, null, null, 1000);
  await add('9800000006', 'Other sheet big donor', other, 9000);

  const ids = async (q: string) => new Set<string>(((await get(`/api/crm/leads/ids?${q}`)).ids ?? []) as string[]);
  const sheet500 = await ids(`batch=${batch}&min_given=500`);
  check('the sheet, ₹500 or more: sheet total, site donations and money after a call all count', sheet500.size === 3 && sheet500.has(big) && sheet500.has(site) && sheet500.has(afterCall), [...sheet500]);
  check('never gave and gave ₹200 are left out', !sheet500.has(never) && !sheet500.has(little));
  const sheet1000 = await ids(`batch=${batch}&min_given=1000`);
  check('₹1,000 or more', sheet1000.size === 3, [...sheet1000]);
  const sheet2000 = await ids(`batch=${batch}&min_given=2000`);
  check('₹2,000 or more: only the big donor', sheet2000.size === 1 && sheet2000.has(big), [...sheet2000]);
  const site1300 = await ids(`batch=${batch}&min_given=1300`);
  check('site donations are added up (700 + 600), not taken one at a time', site1300.has(site), [...site1300]);
  const none = await ids(`batch=${batch}&min_given=none`);
  check('"Nothing given yet" finds only the one who never gave', none.size === 1 && none.has(never), [...none]);
  const list = await get(`/api/crm/leads?batch=${batch}&min_given=500`);
  const listIds = new Set((list.leads ?? list.data ?? []).map((l: any) => l.id));
  check('the Leads list shows the same people', listIds.size === 3, list);

  const cl = (await pool.query(
    `INSERT INTO calling_lists (name, import_batch_id, min_external_total, created_by) VALUES ('Janmashtami donors', $1, 1000, $2) RETURNING id`,
    [batch, ADMIN]
  )).rows[0].id;
  const listed = await ids(`list=${cl}`);
  check('a calling list with "given at least ₹1,000" uses the same rule', listed.size === 3 && listed.has(site) && listed.has(afterCall) && listed.has(big), [...listed]);

  // ---- Start calling: the "Given at least" chips
  await pool.query(`TRUNCATE calling_sessions, lead_reminders CASCADE`);
  const all = (await pool.query(
    `INSERT INTO calling_lists (name, import_batch_id, created_by) VALUES ('Janmashtami sheet', $1, $2) RETURNING id`,
    [batch, ADMIN]
  )).rows[0].id;
  const card = (r: any) => (r.lists ?? []).find((l: any) => l.list_id === all);
  const plain = await get(`/api/crm/sessions/sources`);
  const at2000 = await get(`/api/crm/sessions/sources?min_given=2000`);
  check('Start calling: the sheet card holds all 5 with "Any amount"', card(plain)?.count === 5, card(plain));
  check('Start calling: ₹2,000+ narrows the sheet card to 1', card(at2000)?.count === 1 && at2000.min_given === 2000, card(at2000));
  check('Start calling: ₹2,000+ narrows "Everyone due" too', at2000.sources.find((s: any) => s.kind === 'everything')?.count === 2, at2000.sources);
  const promised = (await pool.query(
    `INSERT INTO lead_reminders (lead_id, title, due_at, status) VALUES ($1, 'Promised', NOW() - INTERVAL '1 hour', 'open') RETURNING id`, [never]
  )).rowCount;
  const p0 = (await get(`/api/crm/sessions/sources`)).sources.find((s: any) => s.kind === 'reminders')?.count;
  const p2000 = (await get(`/api/crm/sessions/sources?min_given=2000`)).sources.find((s: any) => s.kind === 'reminders');
  check('Promises due is never narrowed: a promise matters more than past giving', promised === 1 && p0 === 1 && p2000?.count === 1 && p2000?.key === 'reminders', { p0, p2000 });
  check('Start calling: card keys carry the amount', card(at2000)?.key === `list:${all}|given:2000`, card(at2000)?.key);

  const run = await post('/api/crm/sessions', { source: { kind: 'list', list_id: all, min_given: 1000 } });
  const items = (await pool.query(`SELECT lead_id FROM calling_session_items WHERE session_id = $1`, [run.session?.id])).rows.map((r) => r.lead_id);
  check('a run started at ₹1,000+ holds only those 3', run.status === 201 && items.length === 3 && items.includes(big) && items.includes(site) && items.includes(afterCall), { run: run.status, items });
  check('its name says the amount', /gave ₹1,000\+$/.test(run.session?.label ?? run.session?.source_label ?? ''), run.session);
  const again = await post('/api/crm/sessions', { source: { kind: 'list', list_id: all, min_given: 1000 } });
  check('starting it again carries on with the same run', again.resumed === true && again.session?.id === run.session?.id, again);
  const unfiltered = await post('/api/crm/sessions', { source: { kind: 'list', list_id: all } });
  check('the same sheet with "Any amount" is a separate run of 5', unfiltered.status === 201 && unfiltered.session?.id !== run.session?.id && unfiltered.count === 5, unfiltered);
  const openRuns = (await get(`/api/crm/sessions/sources?min_given=1000`)).open ?? [];
  const mine = openRuns.find((o: any) => o.id === run.session?.id);
  check('the open run remembers its amount (for Start over)', mine?.min_given === 1000 && mine?.key === `list:${all}|given:1000`, openRuns);
  const bad = await post('/api/crm/sessions', { source: { kind: 'list', list_id: all, min_given: 'lots' } });
  check('a nonsense amount is ignored, not an error', bad.resumed === true && bad.session?.id === unfiltered.session?.id, bad);

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
