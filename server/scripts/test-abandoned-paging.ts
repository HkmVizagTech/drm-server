/**
 * "Nearly gave" - paging, ordering and the date range.
 *
 * THE PROBLEM THIS SUITE PINS DOWN
 * GET /leads/abandoned answered with a bare LIMIT 500. Thirty days across two
 * sites is five hundred rows of joins and EXISTS subqueries rebuilt on every
 * load, for a screen nobody scrolls past the first twenty of - so the list
 * took seconds to open and got slower as the temple grew.
 *
 * Paging fixes that, and the cases below are the ways paging goes wrong:
 * a page that overlaps the one before it, a last page computed from the wrong
 * total, an order that is not stable so row 20 appears on both page 1 and
 * page 2, and - the one that matters most here - a default that quietly
 * changes what the EXPORT returns, because the export builds its query from
 * the same helper.
 *
 *   NODE_ENV=development DATABASE_URL=...drm_test npx tsx scripts/test-abandoned-paging.ts
 */
import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import crmRoutes from '../src/routes/crm';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${label}`);
  failures++;
  console.error(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`);
};

const app = express();
app.use(express.json());
app.use('/api/crm', crmRoutes);
const server = app.listen(0);
const port = () => (server.address() as import('net').AddressInfo).port;

let token = '';
const get = (qs: string): Promise<any> =>
  new Promise((resolve, reject) => {
    http.get(
      { host: 'localhost', port: port(), path: `/api/crm/leads/abandoned?${qs}`, headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => {
          try { resolve(JSON.parse(b)); } catch { reject(new Error(`${res.statusCode}: ${b.slice(0, 200)}`)); }
        });
      }
    ).on('error', reject);
  });

async function seed() {
  await pool.query(`TRUNCATE abandoned_attempts, abandoned_sync_state, leads, person_names, donations, people RESTART IDENTITY CASCADE`);
  const u = await pool.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ('Admin','a@t','x','admin') RETURNING id, role`
  );
  token = generateToken({ userId: u.rows[0].id, role: u.rows[0].role });

  /* Mark both sites as freshly synced and deep enough for the view.

     Without this the handler treats them as NEVER synced and AWAITS a live
     crawl of two external Mongo sites - the test would hang or fail on the
     network, and a test that reaches the internet is not a test. */
  await pool.query(
    `INSERT INTO abandoned_sync_state (source_site, last_synced_at, synced_days)
     VALUES ('hkmv', NOW(), 365), ('annadan', NOW(), 365)`
  );

  // 25 attempts, one per day going back, newest first at day 1.
  const rows: string[] = [];
  for (let n = 1; n <= 25; n++) {
    rows.push(
      `('hkmv','EXT${n}','90000000${String(n).padStart(2, '0')}','Donor ${n}',${100 * n},
        NOW() - INTERVAL '${n} days', 'failed', '/donate/seva')`
    );
  }
  await pool.query(
    `INSERT INTO abandoned_attempts
       (source_site, external_id, phone, name, amount, attempted_at, status, source_page)
     VALUES ${rows.join(',')}`
  );
}

async function main() {
  await seed();

  console.log('\n--- paging ---');
  const p1 = await get('days=30&limit=10&page=1&sort=recent');
  const p2 = await get('days=30&limit=10&page=2&sort=recent');
  const p3 = await get('days=30&limit=10&page=3&sort=recent');
  check('page 1 is a page, not the lot', p1.rows.length, 10);
  check('page 2 is full too', p2.rows.length, 10);
  check('the last page holds the remainder', p3.rows.length, 5);
  check('25 rows match', p1.matching, 25);
  check('three pages', p1.total_pages, 3);
  check('the page number comes back', p2.page, 2);

  const ids = new Set([...p1.rows, ...p2.rows, ...p3.rows].map((r: any) => r.id));
  check('no row appears on two pages', ids.size, 25);

  console.log('\n--- order ---');
  const first = p1.rows.map((r: any) => r.name);
  check('recent first', first[0], 'Donor 1');
  check('and descending', first[9], 'Donor 10');

  // Give three of them a lead that has been rung.
  await pool.query(
    `INSERT INTO leads (name, phone, last_contacted_at)
     SELECT a.name, a.phone, NOW() FROM abandoned_attempts a WHERE a.external_id IN ('EXT1','EXT2','EXT3')`
  );
  const un = await get('days=30&limit=10&page=1&sort=uncalled');
  check('nobody rung yet comes first', un.rows.slice(0, 3).map((r: any) => r.name), ['Donor 4', 'Donor 5', 'Donor 6']);
  check('...and the rung ones are not on page 1 top', un.rows.some((r: any) => r.name === 'Donor 1'), false);

  console.log('\n--- the date range ---');
  const iso = (d: number) => {
    const x = new Date(Date.now() - d * 86400_000);
    return x.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  };
  const ranged = await get(`days=30&from_date=${iso(5)}&to_date=${iso(3)}&limit=50&sort=recent`);
  check('only the chosen days', ranged.rows.map((r: any) => r.name).sort(), ['Donor 3', 'Donor 4', 'Donor 5']);

  console.log('\n--- an old caller sees no change ---');
  const bare = await get('days=30&sort=recent');
  check('no page parameter still returns everything', bare.rows.length, 25);
  check('and reports itself complete', bare.complete, true);

  console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
  server.close();
  await pool.end();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => { console.error('THREW:', e); server.close(); await pool.end().catch(() => {}); process.exit(1); });
