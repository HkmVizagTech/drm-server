/**
 * "Have they paid since?" - the rewrite settles exactly the same people.
 *
 * WHY THIS EXISTS
 * The Nearly gave list took eight seconds to open, and nearly all of it was
 * one clause of gaveSinceSql: for every abandoned attempt it walked every
 * donation made that day and ran a regular expression over two names. It was
 * rewritten so each half of that check can use an index.
 *
 * This rule decides who a caller rings. A donor chased for money they have
 * already given is the one thing the feature must never do, and a donor wrongly
 * HIDDEN is a gift nobody follows up. So a faster rule is only acceptable if it
 * is the same rule, and "it looks equivalent" is not a proof. This runs the OLD
 * SQL, copied verbatim below, and the NEW one over the same rows and requires
 * the same people - first on a small set built to hit every clause and every
 * edge, then on a dense set shaped like production, where it also times both
 * and confirms the new one really does use the indexes.
 *
 *   NODE_ENV=development DATABASE_URL=...drm_test npx tsx scripts/test-gave-since.ts
 */
import '../src/bootTimezone';
import pool from '../src/db/pool';
import { runMigrations } from '../src/db/migrate';
import { gaveSinceSql, nameKey } from '../src/services/gaveSince';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

/** The rule as it was before the rewrite. Do not "tidy" this - it is the reference. */
function legacyGaveSinceSql(a: string): string {
  return `(
    EXISTS (SELECT 1 FROM donations gx WHERE gx.external_ref = ${a}.external_id)
    OR EXISTS (
      SELECT 1 FROM people gp JOIN donations gd ON gd.person_id = gp.id
       WHERE right(regexp_replace(gp.phone, '\\D', '', 'g'), 10) = ${a}.phone
         AND gd.created_at >= ${a}.attempted_at)
    OR EXISTS (
      SELECT 1 FROM leads gl WHERE gl.phone = ${a}.phone AND gl.converted_at >= ${a}.attempted_at)
    OR (length(${nameKey(`${a}.name`)}) >= 4 AND EXISTS (
      SELECT 1 FROM donations gd JOIN people gp ON gp.id = gd.person_id
       WHERE gd.created_at >= ${a}.attempted_at
         AND gd.created_at < ${a}.attempted_at + INTERVAL '1 day'
         AND (${nameKey('gd.given_name')} = ${nameKey(`${a}.name`)} OR ${nameKey('gp.name')} = ${nameKey(`${a}.name`)})
         AND (position(' ' IN btrim(${a}.name)) > 0 OR gd.amount = ${a}.amount)))
  )`;
}

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${label}`);
  failures++;
  console.error(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`);
};

const settledBy = async (rule: string): Promise<string[]> => {
  const r = await pool.query(`SELECT a.external_id FROM abandoned_attempts a WHERE ${rule} ORDER BY a.external_id`);
  return r.rows.map((x: { external_id: string }) => x.external_id);
};

async function person(name: string, phone: string): Promise<string> {
  const r = await pool.query(`INSERT INTO people (name, phone) VALUES ($1,$2) RETURNING id`, [name, phone]);
  return r.rows[0].id;
}
async function gift(personId: string, amount: number, at: string, opts: { ref?: string; given?: string } = {}) {
  await pool.query(
    `INSERT INTO donations (person_id, amount, payment_mode, created_at, external_ref, given_name)
     VALUES ($1,$2,'upi',$3::timestamptz,$4,$5)`,
    [personId, amount, at, opts.ref ?? null, opts.given ?? null]
  );
}
async function attempt(id: string, phone: string, name: string | null, amount: number, at: string) {
  await pool.query(
    `INSERT INTO abandoned_attempts (source_site, external_id, phone, name, amount, attempted_at, status, source_page)
     VALUES ('hkmv',$1,$2,$3,$4,$5::timestamptz,'failed','/donate/seva')`,
    [id, phone, name, amount, at]
  );
}

async function main() {
  const m = await runMigrations();
  check('the migration (and its two new indexes) applies', m.ok, true);

  console.log('\n--- every clause and edge, new rule against old ---');
  await pool.query(`TRUNCATE abandoned_attempts, leads, person_names, donations, people RESTART IDENTITY CASCADE`);

  // One fixed instant, so "a day later" and the boundaries are exact.
  const T = '2026-01-15T10:00:00+05:30';
  const plus = (h: number) => new Date(new Date(T).getTime() + h * 3600_000).toISOString();

  const bystander = await person('Bystander Donor', '9000000000');

  // 1  the attempt itself was paid: same external id
  await attempt('c01-same-id', '9100000001', 'Anita Rao', 500, T);
  await gift(bystander, 500, plus(1), { ref: 'c01-same-id' });

  // 2  a donation from the same mobile, written with a country code and spaces
  await attempt('c02-phone-later', '9100000002', 'Bhanu Murthy', 500, T);
  const p2 = await person('Someone Else', '+91 91000 00002');
  await gift(p2, 100, plus(5));

  // 3  ...but one BEFORE the attempt does not count
  await attempt('c03-phone-earlier', '9100000003', 'Chandra Sekhar', 500, T);
  const p3 = await person('Chandra Sekhar', '9100000003');
  await gift(p3, 100, plus(-5));

  // 4  the lead was marked donated after the attempt
  await attempt('c04-lead-converted', '9100000004', 'Devi Prasad', 500, T);
  await pool.query(`INSERT INTO leads (name, phone, converted_at) VALUES ('Devi Prasad','9100000004',$1)`, [plus(3)]);

  // 5  same name from another number, spaces / dots / case ignored
  await attempt('c05-name-multiword', '9100000005', 'K. Ravi Kumar', 500, T);
  const p5 = await person('k ravi kumar', '9200000005');
  await gift(p5, 111, plus(3));

  // 6  the name is a family member's, on the donation rather than the donor
  await attempt('c06-name-given', '9100000006', 'Lakshmi Devi', 500, T);
  const p6 = await person('Giridhar Different', '9200000006');
  await gift(p6, 111, plus(1), { given: 'LAKSHMI  DEVI' });

  // 7  same name but two days later: outside the window
  await attempt('c07-name-too-late', '9100000007', 'Suresh Babu', 500, T);
  const p7 = await person('Suresh Babu', '9200000007');
  await gift(p7, 500, plus(48));

  // 8 / 9  one word is too common to trust alone: it must be the same amount too
  const p8 = await person('Ramesh', '9200000008');
  await gift(p8, 500, plus(2));
  await attempt('c08-oneword-same-amount', '9100000008', 'Ramesh', 500, T);
  await attempt('c09-oneword-diff-amount', '9100000009', 'Ramesh', 700, T);

  // 10  under four letters is never matched on name
  await attempt('c10-short-name', '9100000010', 'Raj', 300, T);
  const p10 = await person('Raj', '9200000010');
  await gift(p10, 300, plus(1));

  // 11 / 12  nothing matches; and a missing name
  await attempt('c11-no-match', '9100000011', 'Zorro Nobody', 500, T);
  await attempt('c12-null-name', '9100000012', null, 500, T);

  // 13 / 14  the window is [attempt, attempt + 1 day)
  await attempt('c13-boundary-start', '9100000013', 'Vamsi Krishna', 500, T);
  const p13 = await person('Vamsi Krishna', '9200000013');
  await gift(p13, 500, T);
  await attempt('c14-boundary-end', '9100000014', 'Hari Prasad', 500, T);
  const p14 = await person('Hari Prasad', '9200000014');
  await gift(p14, 500, plus(24));

  await pool.query('ANALYZE');

  const oldSet = await settledBy(legacyGaveSinceSql('a'));
  const newSet = await settledBy(gaveSinceSql('a'));
  const expected = [
    'c01-same-id', 'c02-phone-later', 'c04-lead-converted', 'c05-name-multiword',
    'c06-name-given', 'c08-oneword-same-amount', 'c13-boundary-start',
  ];

  check('the old rule settles the people we expect (the reference is sound)', oldSet, expected);
  check('the new rule settles exactly the same people', newSet, oldSet);

  console.log('\n--- a dense set shaped like production: same answers, and faster ---');
  await pool.query(`TRUNCATE abandoned_attempts, leads, person_names, donations, people RESTART IDENTITY CASCADE`);

  // Names are letters only and all different: nameKey drops digits, so "Person 17"
  // and "Person 18" would be the same name and the whole set would match itself.
  const word = (seed: string, from: number, len: number) =>
    `translate(substr(md5(${seed}), ${from}, ${len}), '0123456789', 'ghijklmnop')`;

  await pool.query(
    `INSERT INTO people (name, phone)
     SELECT initcap(${word('g::text', 1, 6)}) || ' ' || initcap(${word('g::text', 7, 6)}),
            '9' || lpad(g::text, 9, '0')
       FROM generate_series(1, 7800) g`
  );
  // About three hundred donations a day for thirty days - the shape that made
  // each attempt's one-day window expensive.
  await pool.query(
    `INSERT INTO donations (person_id, amount, payment_mode, created_at, given_name)
     SELECT p.id, 100 + (g % 40) * 50, 'upi', NOW() - (random() * 30 || ' days')::interval,
            CASE WHEN g % 9 = 0 THEN initcap(${word("'f' || g::text", 1, 7)}) END
       FROM generate_series(1, 9000) g
       JOIN people p ON p.id = (SELECT id FROM people OFFSET (g % 7800) LIMIT 1)`
  );
  await pool.query(
    `INSERT INTO abandoned_attempts (source_site, external_id, phone, name, amount, attempted_at, status, source_page)
     SELECT 'hkmv', 'x' || g, '8' || lpad(g::text, 9, '0'),
            initcap(${word("'a' || g::text", 1, 6)}) || ' ' || initcap(${word("'a' || g::text", 7, 6)}),
            500, NOW() - (random() * 29 || ' days')::interval, 'failed', '/donate/seva'
       FROM generate_series(1, 2600) g`
  );
  /* Forty attempts that really WERE settled by name, so "the two rules agree"
     is not trivially "nobody is settled". Forty existing donors are renamed to
     the names on the first forty attempts, and each gives within the window. */
  await pool.query(
    `UPDATE people p SET name = pk.name
       FROM (
         SELECT t.id, a.name
           FROM (SELECT id, row_number() OVER (ORDER BY phone) rn
                   FROM people WHERE phone >= '9000007000' ORDER BY phone LIMIT 40) t
           JOIN (SELECT name, row_number() OVER (ORDER BY external_id) rn
                   FROM abandoned_attempts ORDER BY external_id LIMIT 40) a ON a.rn = t.rn
       ) pk
      WHERE p.id = pk.id`
  );
  await pool.query(
    `INSERT INTO donations (person_id, amount, payment_mode, created_at)
     SELECT p.id, 500, 'upi', a.attempted_at + INTERVAL '3 hours'
       FROM people p JOIN abandoned_attempts a ON a.name = p.name`
  );
  await pool.query('ANALYZE');

  const timeIt = async (rule: string) => {
    const t0 = performance.now();
    const ids = await settledBy(rule);
    return { ms: Math.round(performance.now() - t0), ids };
  };
  await timeIt(gaveSinceSql('a')); // warm both
  await timeIt(legacyGaveSinceSql('a'));
  const oldRun = await timeIt(legacyGaveSinceSql('a'));
  const newRun = await timeIt(gaveSinceSql('a'));

  console.log(`       old rule ${oldRun.ms} ms, new rule ${newRun.ms} ms, over 2,600 attempts and 9,000 donations`);
  check('the same people are settled on the dense set', newRun.ids, oldRun.ids);
  check('some people really were settled (the comparison is not vacuous)', oldRun.ids.length > 0, true);
  check('the new rule is not slower', newRun.ms <= oldRun.ms, true);

  const plan = await pool.query(`EXPLAIN SELECT a.external_id FROM abandoned_attempts a WHERE ${gaveSinceSql('a')}`);
  const text = plan.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join('\n');
  check('Postgres uses the donations name index', /idx_donations_given_name_key/.test(text), true);
  check('Postgres uses the people name index', /idx_people_name_key/.test(text), true);

  console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
  await pool.end();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error('THREW:', e);
  await pool.end().catch(() => {});
  process.exit(1);
});
