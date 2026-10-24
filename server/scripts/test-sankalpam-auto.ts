// A donor who gives a big gift goes on the Sankalpam list by themselves.
//
//   DATABASE_URL=postgresql://localhost/drm_sevawall_test npx tsx scripts/test-sankalpam-auto.ts

import '../src/bootTimezone';
import pool from '../src/db/pool';
import { upsertDonorSnapshot } from '../src/services/hkmvSync';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}\n       expected ${JSON.stringify(expected)}\n       got      ${JSON.stringify(actual)}`);
  }
};

let ext = 0;
function snap(mobile: string, name: string, amount: number, extra: Record<string, unknown> = {}, donor: Record<string, unknown> = {}, externalId?: string) {
  ext++;
  return {
    donor: { name, mobile, donorSince: '2025-01-01T00:00:00.000Z', ...donor },
    donations: [
      {
        externalId: externalId ?? `auto-${ext}`,
        amount,
        type: 'Annadan Seva',
        status: 'completed',
        createdAt: new Date(Date.now() - ext * 60000).toISOString(),
        isRecurring: false,
        paymentMode: 'online',
        ...extra,
      },
    ],
  };
}
const patron = async (phone: string) =>
  (await pool.query(`SELECT id, donor_name, source, active, person_id, phone FROM sankalpam_donors WHERE phone = $1`, [phone])).rows;
const notes = async () =>
  (await pool.query(`SELECT title FROM drm_notifications WHERE kind = 'sankalpam' AND title LIKE 'New Sankalpam donor%'`)).rows.length;

async function main() {
  await pool.query(`TRUNCATE sankalpam_calls, sankalpam_sends, sankalpam_dates, sankalpam_donors, drm_notifications RESTART IDENTITY CASCADE`);
  await pool.query(`TRUNCATE donations, people, users RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO crm_settings (key, value) VALUES ('sankalpam_min_gift', '5000'::jsonb) ON CONFLICT (key) DO UPDATE SET value = '5000'::jsonb`);

  console.log('\n1. one gift of ₹5,000 or more');
  await upsertDonorSnapshot(snap('9000000201', 'RAVI KUMAR', 5000), 'hkmv');
  let p = await patron('9000000201');
  check('the donor is on the Sankalpam list, from donations', [p.length, p[0]?.source, p[0]?.active, !!p[0]?.person_id], [1, 'donors', true, true]);
  check('with a tidy name', p[0]?.donor_name, 'Ravi Kumar');
  check('and the office is told in the bell', await notes(), 1);

  console.log('\n2. under ₹5,000, or only in total');
  await upsertDonorSnapshot(snap('9000000202', 'Small', 4999), 'hkmv');
  check('₹4,999 is not enough', (await patron('9000000202')).length, 0);
  await upsertDonorSnapshot(snap('9000000203', 'Meera', 3000), 'hkmv');
  await upsertDonorSnapshot(snap('9000000203', 'Meera', 3000), 'hkmv');
  check('two gifts of ₹3,000 do not add up to one big gift', (await patron('9000000203')).length, 0);

  console.log('\n3. the same gift arriving again');
  await upsertDonorSnapshot(snap('9000000201', 'Ravi Kumar', 5000, {}, {}, 'auto-1'), 'hkmv');
  check('adds nobody twice', (await patron('9000000201')).length, 1);
  check('and tells nobody twice', await notes(), 1);

  console.log('\n4. the days the form gives come with them');
  await upsertDonorSnapshot(snap('9000000204', 'Lakshmi', 7500, { occasion: 'Birthday', sevaDate: '2026-12-05' }, { dob: '1980-08-15' }), 'annadan');
  p = await patron('9000000204');
  const days = (await pool.query(`SELECT occasion, month, day FROM sankalpam_dates WHERE donor_id = $1 ORDER BY month`, [p[0].id])).rows;
  check('Annadan donors too, with their birthday and the booked day', [p.length, days.length], [1, 2]);

  console.log('\n5. who is left alone');
  await upsertDonorSnapshot(snap('9000000205', 'Sheet Person', 100), 'hkmv');
  await pool.query(`INSERT INTO sankalpam_donors (donor_name, phone, source) VALUES ('Sheet Person', '9000000205', 'sheet')`);
  await upsertDonorSnapshot(snap('9000000205', 'Sheet Person', 6000), 'hkmv');
  check('a patron already on the sheet is not added a second time', (await patron('9000000205')).length, 1);
  check('and is now linked to the donor', !!(await patron('9000000205'))[0].person_id, true);

  await upsertDonorSnapshot(snap('9000000206', 'Removed Patron', 100), 'hkmv');
  await pool.query(`INSERT INTO sankalpam_donors (donor_name, phone, source, active) VALUES ('Removed Patron', '9000000206', 'sheet', FALSE)`);
  await upsertDonorSnapshot(snap('9000000206', 'Removed Patron', 9000), 'hkmv');
  const rem = await patron('9000000206');
  check('a patron the office switched off is not brought back by a new gift', [rem.length, rem[0].active], [1, false]);

  await upsertDonorSnapshot(snap('9000000207', 'Test Donor', 100), 'hkmv');
  await pool.query(`UPDATE people SET hidden_at = NOW() WHERE phone = '9000000207'`);
  await upsertDonorSnapshot(snap('9000000207', 'Test Donor', 9000), 'hkmv');
  check('a donor hidden from DRM is not added', (await patron('9000000207')).length, 0);

  console.log('\n6. the amount can be changed, or the whole thing switched off');
  await pool.query(`UPDATE crm_settings SET value = '10000'::jsonb WHERE key = 'sankalpam_min_gift'`);
  await upsertDonorSnapshot(snap('9000000208', 'Mid Donor', 7000), 'hkmv');
  check('with the amount at ₹10,000, ₹7,000 is not enough', (await patron('9000000208')).length, 0);
  await upsertDonorSnapshot(snap('9000000209', 'Big Donor', 10000), 'hkmv');
  check('and ₹10,000 is', (await patron('9000000209')).length, 1);
  await pool.query(`UPDATE crm_settings SET value = '0'::jsonb WHERE key = 'sankalpam_min_gift'`);
  await upsertDonorSnapshot(snap('9000000210', 'Anyone', 99999), 'hkmv');
  check('at 0 nobody is added', (await patron('9000000210')).length, 0);

  console.log('\n7. a failure here never costs the donation');
  await pool.query(`UPDATE crm_settings SET value = '"oops"'::jsonb WHERE key = 'sankalpam_min_gift'`);
  await upsertDonorSnapshot(snap('9000000211', 'Safe Donor', 8000), 'hkmv');
  check('the donation is saved whatever the setting says', (await pool.query(`SELECT COUNT(*)::int AS n FROM donations d JOIN people p ON p.id = d.person_id WHERE p.phone = '9000000211'`)).rows[0].n, 1);

  console.log(failures ? `\n${failures} FAILED` : '\nall green');
  await pool.end();
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
