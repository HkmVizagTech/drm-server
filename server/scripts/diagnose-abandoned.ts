/**
 * Where the time goes in "Nearly gave", on the REAL database.
 *
 * READ ONLY, and safe to point at production: every statement runs inside a
 * READ ONLY transaction with a statement timeout, and it is rolled back at the
 * end. It prints timings and the shape of the plan - never a donor row.
 *
 * Unlike the other scripts it does not insist on a _test database, because the
 * whole point is to measure the data that is actually slow. A synthetic seed
 * answered in thirty milliseconds while production took eight seconds.
 *
 *   npx tsx scripts/diagnose-abandoned.ts
 */
import '../src/bootTimezone';
import pool from '../src/db/pool';
import { buildAbandonedQuery } from '../src/routes/crm';

async function main() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    await c.query(`SET LOCAL statement_timeout = '60s'`);

    const rtt: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      await c.query('SELECT 1');
      rtt.push(Math.round(performance.now() - t0));
    }
    console.log(`round trip to the database: ${rtt.join(', ')} ms\n`);

    const counts = await c.query(
      `SELECT (SELECT COUNT(*) FROM abandoned_attempts) AS attempts,
              (SELECT COUNT(*) FROM people) AS people,
              (SELECT COUNT(*) FROM donations) AS donations,
              (SELECT COUNT(*) FROM leads) AS leads,
              (SELECT COUNT(*) FROM lead_activities) AS activities`
    );
    console.log('table sizes:', JSON.stringify(counts.rows[0]), '\n');

    const q = { days: '30', sort: 'uncalled' };
    const { base, values, order } = buildAbandonedQuery(q, ['hkmv', 'annadan'], 30);

    const time = async (label: string, sql: string, params: unknown[]) => {
      const t0 = performance.now();
      const r = await c.query(sql, params);
      console.log(`${String(Math.round(performance.now() - t0)).padStart(7)} ms  ${label}  (${r.rowCount} rows)`);
    };

    const pageSql = `${base} SELECT * FROM resolved l WHERE NOT gave_anyway ORDER BY ${order} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;

    console.log('--- the queries the endpoint runs, one at a time ---');
    await time('page   (25 rows)', pageSql, [...values, 25, 0]);
    await time(
      'totals',
      `${base} SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE NOT gave_anyway)::int AS open FROM resolved`,
      values
    );

    console.log('\n--- plan for the page query: only the steps that cost real time ---');
    const plan = await c.query(`EXPLAIN (ANALYZE, BUFFERS) ${pageSql}`, [...values, 25, 0]);
    for (const row of plan.rows as { 'QUERY PLAN': string }[]) {
      const line = row['QUERY PLAN'];
      const m = line.match(/actual time=[\d.]+\.\.([\d.]+) rows=[\d.]+ loops=(\d+)/);
      const total = m ? Number(m[1]) * Number(m[2]) : 0;
      if (total >= 150 || /Execution Time|Planning Time/.test(line)) {
        console.log(`  ${line.replace(/\s+/g, ' ').slice(0, 170)}  [~${Math.round(total)} ms]`);
      }
    }
    await c.query('ROLLBACK');
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch(async (e) => {
  console.error('FAILED:', (e as Error).message);
  await pool.end().catch(() => {});
  process.exit(1);
});
