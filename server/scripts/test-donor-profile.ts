// "A donor's name in Sankalpam opens their giving profile."
//
// The shared profile (services/donorProfile.ts) that both the WhatsApp chat and the Sankalpam list use:
// found by DRM id or by mobile number, totals right, nothing for a number nobody has given from.
//
//   DATABASE_URL=postgresql://localhost/drm_test npx tsx scripts/test-donor-profile.ts

import '../src/bootTimezone';
import pool from '../src/db/pool';
import { runMigrations } from '../src/db/migrate';
import { buildDonorProfile, findDonorPerson } from '../src/services/donorProfile';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}
let failures = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}`, ok ? '' : JSON.stringify(d)?.slice(0, 500));
  if (!ok) failures++;
};

async function main() {
  await runMigrations();
  const ph = '9876500123';
  await pool.query(`DELETE FROM donations WHERE person_id IN (SELECT id FROM people WHERE phone = $1)`, [ph]);
  await pool.query(`DELETE FROM people WHERE phone = $1`, [ph]);
  const p = (await pool.query(`INSERT INTO people (name, phone) VALUES ('Profile Test', $1) RETURNING id`, [ph])).rows[0];
  for (const [amt, purpose] of [[1000, 'Annadan'], [500, 'Annadan'], [2500, 'Sankalpam']] as const) {
    await pool.query(`INSERT INTO donations (person_id, amount, purpose, payment_mode) VALUES ($1, $2, $3, 'upi')`, [p.id, amt, purpose]);
  }

  const byPhone = await findDonorPerson(null, `+91 ${ph.slice(0, 5)} ${ph.slice(5)}`);
  check('found by mobile number, whatever the spacing', byPhone?.id === p.id, byPhone);
  const byId = await findDonorPerson(p.id, null);
  check('found by DRM id', byId?.id === p.id);
  check('a number nobody gave from is not a donor', (await findDonorPerson(null, '9000000001')) === null);
  check('a short number finds nobody', (await findDonorPerson(null, '12345')) === null);

  const prof: any = await buildDonorProfile(byPhone);
  check('3 donations, ₹4000 in all', prof.stats.count === 3 && prof.stats.total === 4000, prof.stats);
  check('largest ₹2500, average ₹1333', prof.stats.largest === 2500 && Math.round(prof.stats.average) === 1333, prof.stats);
  check('Annadan ₹1500 over 2, first in "gives for"', prof.by_purpose[0].purpose === 'Sankalpam' && prof.by_purpose.some((x: any) => x.purpose === 'Annadan' && x.total === 1500), prof.by_purpose);
  check('every gift is listed', prof.donations.length === 3);
  check('no person gives person: null', (await buildDonorProfile(null)).person === null);

  await pool.query(`DELETE FROM donations WHERE person_id = $1`, [p.id]);
  await pool.query(`DELETE FROM people WHERE id = $1`, [p.id]);
  await pool.end();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
