/**
 * One phone, one donor, many names.
 *
 * THE FAILURE THIS SUITE EXISTS TO CATCH
 * A donor gave in her own name, then gave again from the same phone in her
 * mother's name. DRM renamed her. The donations route did it outright
 * (`ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name`) and the sync
 * route did it politely, keeping the loser in people.name_alt and calling it a
 * conflict for staff to resolve. Both ended with the donor's own name gone and
 * the calling team greeting her as her mother.
 *
 * Every case below is a way that could come back: the primary moving, a name
 * being lost, a third name evicting the second, a placeholder outranking a
 * real name, and the count under each name going wrong.
 *
 *   DATABASE_URL=postgresql://localhost/drm_test npx tsx scripts/test-donor-names.ts
 */
import '../src/bootTimezone';
import pool from '../src/db/pool';
import { registerName, namesFor, nameKey, isPlaceholderName } from '../src/services/personNames';
import { decideName } from '../src/services/profileSync';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${label}`);
  failures++;
  console.error(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`);
}

async function seed(): Promise<string> {
  await pool.query(`TRUNCATE person_names, donations, people RESTART IDENTITY CASCADE`);
  const p = await pool.query(
    `INSERT INTO people (name, phone, roles) VALUES ($1,$2,ARRAY['donor']::TEXT[]) RETURNING id`,
    ['Giridhar', '9876543210']
  );
  return p.rows[0].id;
}

async function main() {
  console.log('\n--- the pure rule ---');
  check('a second real name does not take the primary',
    decideName('Giridhar', 'Lakshmi', 'hkmv').name, 'Giridhar');
  check('...and is handed back to be recorded',
    decideName('Giridhar', 'Lakshmi', 'hkmv').alt, 'Lakshmi');
  check('a real name displaces a placeholder',
    decideName('Donor 9876543210', 'Giridhar', 'hkmv').name, 'Giridhar');
  check('a placeholder never displaces a real name',
    decideName('Giridhar', 'Donor 9876543210', 'hkmv').name, 'Giridhar');
  check('nameKey flattens case and spacing', nameKey('  RAVI   Das '), 'ravi das');
  check('placeholder recognised', isPlaceholderName('Donor 9876543210'), true);

  console.log('\n--- the roster ---');
  const id = await seed();
  await registerName(pool, id, 'Giridhar', 'drm');
  await registerName(pool, id, 'Lakshmi', 'hkmv');
  await registerName(pool, id, 'Venkata Rao', 'annadan');
  let names = await namesFor(id);
  check('all three names kept', names.map((n) => n.name), ['Giridhar', 'Lakshmi', 'Venkata Rao']);
  check('the first name is primary', names.filter((n) => n.is_primary).map((n) => n.name), ['Giridhar']);

  await registerName(pool, id, '  giridhar  ', 'hkmv');
  names = await namesFor(id);
  check('the same name typed differently adds nothing', names.length, 3);

  console.log('\n--- what was given under each name ---');
  /* given_name is who the gift was FROM; sevak_name is who it was FOR.

     A daughter giving in her mother's name fills in both, and the 80G stays in
     the daughter's name - which is the whole reason they are two fields. */
  const give = (donor: string | null, onNameOf: string | null, amount: number) =>
    pool.query(
      `INSERT INTO donations (person_id, amount, payment_mode, given_name, sevak_name)
       VALUES ($1,$2,'upi',$3,$4)`,
      [id, amount, donor, onNameOf]
    );
  await give('Giridhar', null, 1000);        // her own gift
  await give('Giridhar', 'Lakshmi', 500);    // given in her mother's name
  await give('Giridhar', 'Lakshmi', 2500);   // and again
  await give(null, null, 700);               // taken before either was recorded

  names = await namesFor(id);
  const by = Object.fromEntries(names.map((n) => [n.name, { n: n.donation_count, t: n.donation_total }]));
  check('the mother is credited the gifts offered for her', by['Lakshmi'],     { n: 2, t: 3000 });
  check('the daughter keeps all she gave, plus history',   by['Giridhar'],    { n: 4, t: 4700 });
  check('a name with no gifts reads zero',                 by['Venkata Rao'], { n: 0, t: 0 });

  console.log('\n--- the primary cannot be lost ---');
  const fresh = await pool.query(`SELECT name FROM people WHERE id = $1`, [id]);
  check('people.name never moved', fresh.rows[0].name, 'Giridhar');

  const dupes = await pool.query(
    `SELECT COUNT(*)::int n FROM person_names WHERE person_id = $1 AND is_primary`, [id]);
  check('exactly one primary', dupes.rows[0].n, 1);

  console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
  await pool.end();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
