/**
 * Where the eight seconds go in "Nearly gave".
 *
 * NOT A TEST - a measurement. It seeds drm_test at roughly production shape
 * (hundreds of abandoned attempts against thousands of donors and donations),
 * runs the real endpoint, and prints the plan Postgres actually chose.
 *
 * WHY MEASURE RATHER THAN READ THE SQL
 * Pagination was added on the assumption that returning 500 rows was the cost.
 * It was not: LIMIT applies after the CTEs are fully built, so the work was
 * unchanged and the screen stayed slow. Guessing a second time would be worse
 * than the first, because the next guess is an index on a live table.
 *
 *   NODE_ENV=development DATABASE_URL=...drm_test npx tsx scripts/bench-abandoned.ts
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

const ATTEMPTS = 400;
const PEOPLE = 4000;
const DONATIONS = 12000;

const app = express();
app.use(express.json());
app.use('/api/crm', crmRoutes);
const server = app.listen(0);
const port = () => (server.address() as import('net').AddressInfo).port;
let token = '';

const hit = (qs: string): Promise<{ ms: number; rows: number; status: number }> =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    http.get(
      { host: 'localhost', port: port(), path: `/api/crm/leads/abandoned?${qs}`, headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => {
          const ms = Date.now() - t0;
          try { resolve({ ms, rows: (JSON.parse(b).rows ?? []).length, status: res.statusCode ?? 0 }); }
          catch { reject(new Error(`${res.statusCode}: ${b.slice(0, 200)}`)); }
        });
      }
    ).on('error', reject);
  });

async function seed() {
  console.log(`seeding ${PEOPLE} people, ${DONATIONS} donations, ${ATTEMPTS} attempts...`);
  await pool.query(`TRUNCATE abandoned_attempts, abandoned_sync_state, leads, person_names, donations, people RESTART IDENTITY CASCADE`);
  /* ON CONFLICT so this is re-runnable.

     users is NOT in the TRUNCATE above - wiping it would cascade into
     everything that references a user - so a second run hit the unique
     constraint on email and died before measuring anything. */
  const u = await pool.query(
    `INSERT INTO users (name,email,password_hash,role) VALUES ('Bench','bench@test.invalid','x','admin')
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, role`
  );
  token = generateToken({ userId: u.rows[0].id, role: u.rows[0].role });
  await pool.query(`INSERT INTO abandoned_sync_state (source_site,last_synced_at,synced_days) VALUES ('hkmv',NOW(),365),('annadan',NOW(),365)`);

  await pool.query(
    `INSERT INTO people (name, phone, roles)
     SELECT 'Donor ' || g, '9' || lpad(g::text, 9, '0'), ARRAY['donor']::TEXT[]
       FROM generate_series(1, $1) g`, [PEOPLE]
  );
  /* Donations are all OLDER than any attempt, deliberately.

     The first version of this seed put them at random dates in the last 400
     days, so most attempts had a donation AFTER them - which is exactly what
     gave_anyway looks for. All 400 rows were filtered out as "already gave"
     and the benchmark proudly measured an empty list in 20ms.

     A benchmark that measures nothing is worse than no benchmark: it says the
     thing is fast. Here every donation predates every attempt, so the rows
     survive and the gave-anyway check still has to do all its work to decide
     that - which is the cost being measured. */
  await pool.query(
    `INSERT INTO donations (person_id, amount, payment_mode, created_at, external_ref, given_name)
     SELECT p.id, 100 + (g % 50) * 100, 'upi',
            NOW() - ((g % 300) + 120 || ' days')::interval,
            'D' || g, p.name
       FROM generate_series(1, $1) g
       JOIN people p ON p.id = (SELECT id FROM people OFFSET (g % $2) LIMIT 1)`,
    [DONATIONS, PEOPLE]
  );
  await pool.query(
    `INSERT INTO abandoned_attempts (source_site, external_id, phone, name, amount, attempted_at, status, source_page)
     SELECT CASE WHEN g % 2 = 0 THEN 'hkmv' ELSE 'annadan' END,
            'A' || g, '9' || lpad(((g * 7) % $2)::text, 9, '0'), 'Donor ' || ((g * 7) % $2),
            500 + (g % 20) * 100, NOW() - ((g % 29) + 1 || ' days')::interval,
            'failed', '/donate/seva'
       FROM generate_series(1, $1) g`,
    [ATTEMPTS, PEOPLE]
  );
  // A third of them already have a lead, half of those already rung - so the
  // `uncalled` sort has something to sort and the lead join has rows to find.
  await pool.query(
    `INSERT INTO leads (name, phone, last_contacted_at)
     SELECT a.name, a.phone,
            CASE WHEN random() < 0.5 THEN NOW() - INTERVAL '2 days' ELSE NULL END
       FROM abandoned_attempts a WHERE (('x' || md5(a.phone))::bit(32)::int % 3) = 0
     ON CONFLICT DO NOTHING`
  );
  await pool.query('ANALYZE');
  console.log('seeded.\n');
}

async function main() {
  await seed();

  const sanity = await hit('days=30&sort=recent&page=1&limit=25');
  if (!sanity.rows) {
    console.error(`\nThe seed produced NO rows (status ${sanity.status}). Every attempt was`);
    console.error('filtered out, so any timing below would be the cost of returning nothing.');
    console.error('Fix the seed before trusting a number.\n');
    server.close();
    await pool.end();
    process.exit(1);
  }

  console.log('--- the endpoint, as the screen calls it ---');
  for (const qs of [
    'days=30&sort=uncalled&page=1&limit=25',
    'days=30&sort=recent&page=1&limit=25',
    'days=30&sort=recent',
  ]) {
    await hit(qs); // warm
    const runs = [await hit(qs), await hit(qs), await hit(qs)];
    const best = Math.min(...runs.map((r) => r.ms));
    console.log(`  ${String(best).padStart(6)}ms  ${String(runs[0].rows).padStart(4)} rows   ?${qs}`);
  }

  console.log('\n--- where the time goes, per query ---');
  const parts: [string, string][] = [
    ['gave-anyway check, per row', `SELECT COUNT(*) FROM abandoned_attempts a WHERE ${(await import('../src/services/gaveSince')).gaveSinceSql('a')}`],
    ['the name-match clause alone',
      `SELECT COUNT(*) FROM abandoned_attempts a WHERE EXISTS (
         SELECT 1 FROM donations gd JOIN people gp ON gp.id = gd.person_id
          WHERE gd.created_at >= a.attempted_at AND gd.created_at < a.attempted_at + INTERVAL '1 day'
            AND (lower(regexp_replace(COALESCE(gd.given_name,''),'[^a-zA-Z]','','g')) = lower(regexp_replace(COALESCE(a.name,''),'[^a-zA-Z]','','g'))
              OR lower(regexp_replace(COALESCE(gp.name,''),'[^a-zA-Z]','','g')) = lower(regexp_replace(COALESCE(a.name,''),'[^a-zA-Z]','','g'))))`],
    ['phone match alone (has an index)',
      `SELECT COUNT(*) FROM abandoned_attempts a WHERE EXISTS (
         SELECT 1 FROM people gp JOIN donations gd ON gd.person_id = gp.id
          WHERE right(regexp_replace(gp.phone,'\\D','','g'),10) = a.phone AND gd.created_at >= a.attempted_at)`],
    ['leads lookup by phone',
      `SELECT COUNT(*) FROM abandoned_attempts a WHERE EXISTS (SELECT 1 FROM leads gl WHERE gl.phone = a.phone)`],
  ];
  for (const [label, sql] of parts) {
    const t0 = Date.now();
    await pool.query(sql);
    console.log(`  ${String(Date.now() - t0).padStart(6)}ms  ${label}`);
  }

  console.log('\n--- scans Postgres chose (seq scan on a big table = missing index) ---');
  const plan = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
     SELECT COUNT(*) FROM abandoned_attempts a WHERE ${(await import('../src/services/gaveSince')).gaveSinceSql('a')}`
  );
  for (const r of plan.rows as { 'QUERY PLAN': string }[]) {
    const line = r['QUERY PLAN'];
    if (/Seq Scan|Execution Time|Planning Time|Nested Loop|Materialize/.test(line)) console.log('   ' + line.trim());
  }

  server.close();
  await pool.end();
}

main().catch(async (e) => { console.error('THREW:', e); server.close(); await pool.end().catch(() => {}); process.exit(1); });
