/**
 * When the Nearly gave list may crawl the sites, and when it must not.
 *
 * THE FAILURE THIS SUITE EXISTS TO CATCH
 * The list answers in about thirty milliseconds and took eight to fifteen
 * seconds to arrive, because it was waiting on a crawl its own request had
 * started. That happened twice, for two different reasons, and both looked like
 * a slow query:
 *
 *   1. The staleness test returned on reach before it reached the time throttle,
 *      and synced_days is NULL on a deployment whose last success predates the
 *      column - so every site was stale on every request.
 *   2. last_synced_at only moves when a sync SUCCEEDS. A site whose syncs keep
 *      failing therefore looked "never synced", and every page load blocked on
 *      a crawl that then failed again.
 *
 * No database and no network: abandonedSyncAction is a pure function.
 *   npm run test:abandonedsync
 */
import { abandonedSyncAction } from '../src/routes/crm';

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  if (actual === expected) return console.log(`  ok   ${label}`);
  failures++;
  console.error(`  FAIL ${label}\n       expected ${expected}\n       got      ${actual}`);
};

const NOW = Date.parse('2026-10-10T12:00:00Z');
const ago = (mins: number) => new Date(NOW - mins * 60_000).toISOString();
const act = (state: { last_synced_at?: string | null } | undefined, lastAttemptMinsAgo?: number) =>
  abandonedSyncAction(state, lastAttemptMinsAgo === undefined ? undefined : NOW - lastAttemptMinsAgo * 60_000, NOW);

console.log('\n--- a site that keeps failing must never block a request ---');
// A state row exists (it was tried) but last_synced_at is null (it never worked).
check('tried before, never succeeded: do not wait for it', act({ last_synced_at: null }), 'background');
check('...and not again straight after an attempt', act({ last_synced_at: null }, 2), 'none');
check('...nor nine minutes later', act({ last_synced_at: null }, 9), 'none');
check('...but retried once the cooldown is over', act({ last_synced_at: null }, 11), 'background');

console.log('\n--- a stale site is refreshed in the background, not waited for ---');
check('last success nine days ago', act({ last_synced_at: ago(60 * 24 * 9) }), 'background');
check('...unless it was attempted lately', act({ last_synced_at: ago(60 * 24 * 9) }, 3), 'none');

console.log('\n--- a fresh site is left alone ---');
check('synced two minutes ago', act({ last_synced_at: ago(2) }), 'none');
check('synced twenty-nine minutes ago', act({ last_synced_at: ago(29) }), 'none');
check('synced thirty-one minutes ago', act({ last_synced_at: ago(31) }), 'background');

console.log('\n--- only a site DRM has never contacted at all may block ---');
check('no state row: genuinely the first time, so wait', act(undefined), 'await');
check('...once, not on every request while it fails', act(undefined, 1), 'none');

console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
