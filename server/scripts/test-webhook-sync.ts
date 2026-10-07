/**
 * The website webhook, end to end, against a real database.
 *
 * WHY THIS EXISTS
 * upsertDonorSnapshot is the path every website donation travels: the site
 * takes the money, issues the 80G, then posts the donor's snapshot here. It is
 * also the one path the other suites do not touch, and a column was recently
 * added to its donation INSERT. A parameter list that does not match its
 * placeholders throws at RUNTIME, not at compile time - tsc cannot count
 * $-placeholders inside a template string - so the first thing to find out
 * would otherwise be a 500 on a live webhook and a donation missing from DRM.
 *
 * Nobody loses money when that happens: the payment completed on the site and
 * the receipt was issued there. But DRM silently stops knowing about it, which
 * is the kind of fault that is noticed a month later in a total that will not
 * reconcile. So it is checked here instead.
 *
 *   NODE_ENV=development DATABASE_URL=...drm_test npx tsx scripts/test-webhook-sync.ts
 */
import '../src/bootTimezone';
import pool from '../src/db/pool';
import { upsertDonorSnapshot } from '../src/services/hkmvSync';
import { namesFor } from '../src/services/personNames';

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

const snapshot = (name: string, externalId: string, amount: number) => ({
  donor: {
    name,
    mobile: '9876500011',
    email: 'test@example.invalid',
    panNumber: 'ABCDE1234F',
    donorSince: '2024-01-01T00:00:00.000Z',
  },
  donations: [
    {
      externalId,
      amount,
      type: 'Annadan',
      status: 'completed',
      createdAt: '2026-01-15T10:00:00.000Z',
      isRecurring: false,
      receiptNumber: `R-${externalId}`,
      receiptIssuedAt: '2026-01-15T10:01:00.000Z',
      sourcePage: '/donations/annadan',
      paymentRef: `UTR${externalId}`,
      paymentMode: 'upi',
    },
  ],
});

async function main() {
  await pool.query(`TRUNCATE person_names, donations, people RESTART IDENTITY CASCADE`);

  console.log('\n--- a donation arrives from the website ---');
  const first = await upsertDonorSnapshot(snapshot('Giridhar', 'EXT-1', 1100) as never, 'hkmv');
  check('the webhook completed without throwing', first.donationsSynced, 1);
  check('the donor was created', first.created, true);

  const d1 = await pool.query(`SELECT given_name, amount::float, receipt_number FROM donations`);
  check('the donation landed', d1.rows.length, 1);
  check('given_name recorded from the snapshot', d1.rows[0].given_name, 'Giridhar');

  console.log('\n--- the same donor gives again under her mother\'s name ---');
  const second = await upsertDonorSnapshot(snapshot('Lakshmi', 'EXT-2', 2500) as never, 'hkmv');
  check('still one donor, not two', second.personId, first.personId);

  const people = await pool.query(`SELECT COUNT(*)::int n FROM people`);
  check('one person row for one phone', people.rows[0].n, 1);

  const name = await pool.query(`SELECT name FROM people`);
  check('the donor was NOT renamed', name.rows[0].name, 'Giridhar');

  const names = await namesFor(first.personId);
  check('both names on the roster', names.map((n) => n.name).sort(), ['Giridhar', 'Lakshmi']);
  check('the first name is still primary',
    names.filter((n) => n.is_primary).map((n) => n.name), ['Giridhar']);

  console.log('\n--- the site re-sends the same snapshot (it does, on retries) ---');
  const again = await upsertDonorSnapshot(snapshot('Lakshmi', 'EXT-2', 2500) as never, 'hkmv');
  const count = await pool.query(`SELECT COUNT(*)::int n FROM donations`);
  check('no duplicate donation', count.rows[0].n, 2);
  check('still the same donor', again.personId, first.personId);

  const unchanged = await pool.query(`SELECT given_name FROM donations WHERE external_ref = 'EXT-1'`);
  check('an existing donation is never relabelled', unchanged.rows[0].given_name, 'Giridhar');

  console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
  await pool.end();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => { console.error('THREW:', e); await pool.end().catch(() => {}); process.exit(1); });
