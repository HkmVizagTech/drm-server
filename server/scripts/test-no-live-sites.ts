/**
 * A test database must never reach a live donation site.
 *
 * WHY THIS EXISTS
 * Every test loads the server's own .env, which holds the live sites' addresses
 * and secrets, and nothing stopped a test that raises a receipt from using them.
 * Two did: a fake donor "Lakshmi" (Rs 301) and a fake "Keep Me" (Rs 700) were each
 * given a real receipt number in the live main site's 80G series. This pins down
 * the lock that now prevents it, in hkmvClient.ts.
 *
 * No database and no network: the address used is .invalid, which cannot resolve,
 * so even if the lock were broken this could not reach anything.
 *   npm run test:nolivesites
 */
import { isSiteConfigured, createOfflineDonation } from '../src/services/hkmvClient';

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  if (actual === expected) return console.log(`  ok   ${label}`);
  failures++;
  console.error(`  FAIL ${label}\n       expected ${expected}\n       got      ${actual}`);
};

async function main() {
  process.env.HKMV_API_URL = 'https://example.invalid';
  process.env.HKMV_INTERNAL_SECRET = 'not-a-real-secret';

  console.log('\n--- a test database ---');
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/drm_test';
  check('a remote site counts as not connected', isSiteConfigured('hkmv'), false);
  let refused = '';
  try {
    await createOfflineDonation('hkmv', {
      donorName: 'X', donorMobile: '9000000000', amount: 1, paymentMode: 'upi', referenceNo: 'x',
    } as never);
  } catch (e) {
    refused = (e as Error).message;
  }
  check('raising a receipt is refused before any request is made', /not connected/.test(refused), true);

  process.env.HKMV_API_URL = 'http://localhost:9';
  check('a local stand-in is still allowed, so a test can run its own fake site', isSiteConfigured('hkmv'), true);
  process.env.HKMV_API_URL = 'http://127.0.0.1:9';
  check('...on 127.0.0.1 too', isSiteConfigured('hkmv'), true);

  console.log('\n--- the real database ---');
  process.env.HKMV_API_URL = 'https://example.invalid';
  process.env.DATABASE_URL = 'postgresql://u:p@host.proxy.rlwy.net:5432/railway';
  check('a remote site is connected, as it must be in production', isSiteConfigured('hkmv'), true);

  console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
  process.exit(failures ? 1 : 0);
}
main();
