// Follow-ups: who is listed, and when a lead stops coming back.
//
// THE TEMPLE'S RULES
//   - An unanswered call (no answer, busy, switched off) comes back, and after
//     FIVE in a row the lead is closed as "Not reachable": off Follow-ups and the
//     queue, but never deleted.
//   - Interested, will donate, will pay by QR and call back later come back too.
//     Only "not interested" leaves.
//   - A RETRY after an unanswered call is listed on the Follow-ups page only for
//     Nearly gave leads. For previous donors and uploaded sheets it does not
//     appear there - it comes back through the calling queue.
//
// Dates are covered in test-retry-morning.ts. This is about the list and the cap.
//
//   NODE_ENV=development DATABASE_URL=...drm_test npx tsx scripts/test-follow-up-rules.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import { runMigrations } from '../src/db/migrate';
import crmRoutes from '../src/routes/crm';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use('/api/crm', crmRoutes);
let base = '';
const ADMIN = '11111111-1111-1111-1111-111111111111';
const token = generateToken({ userId: ADMIN, email: 'a@t', role: 'admin' } as never);

function call(method: string, path: string, body?: unknown) {
  return new Promise<any>((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const u = new URL(`${base}${path}`);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        // `http`, not `status`: a lead row has its own `status` field (its stage), which
        // would overwrite the HTTP status and make a 200 look like "attempting".
        res.on('end', () => resolve({ ...JSON.parse(d || '{}'), http: res.statusCode }));
      }
    );
    r.on('error', reject);
    r.end(data);
  });
}
const post = (path: string, body: unknown) => call('POST', path, body);

let failures = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}`, ok ? '' : JSON.stringify(d)?.slice(0, 500));
  if (!ok) failures++;
};

let seq = 0;
/** A lead. `nearlyGave` leads carry the 'abandoned' tag, as an adopted Nearly gave row does. */
async function lead(opts: { nearlyGave?: boolean } = {}) {
  const phone = `98200${String(++seq).padStart(5, '0')}`;
  const r = await pool.query(
    `INSERT INTO leads (phone, name, source, tags) VALUES ($1, 'Test', $2, $3::text[]) RETURNING id`,
    [phone, opts.nearlyGave ? 'website' : 'csv', opts.nearlyGave ? ['abandoned'] : []]
  );
  return r.rows[0].id as string;
}

/** Ids on the Follow-ups page (all three lists), or on the plain leads list. */
async function onFollowUps(followups: boolean): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const due of ['overdue', 'today_only', 'upcoming']) {
    const r = await call('GET', `/api/crm/leads?due=${due}&limit=500${followups ? '&followups=true' : ''}`);
    for (const l of r.leads ?? []) ids.add(l.id);
  }
  return ids;
}

const row = async (id: string) =>
  (await pool.query(`SELECT status, next_follow_up_at, follow_up_auto, do_not_call FROM leads WHERE id = $1`, [id])).rows[0];
const activities = async (id: string) =>
  (await pool.query(`SELECT COUNT(*)::int AS n FROM lead_activities WHERE lead_id = $1 AND kind = 'call'`, [id])).rows[0].n as number;
const ring = (id: string, disposition: string, extra: Record<string, unknown> = {}) =>
  post(`/api/crm/leads/${id}/call`, { disposition, ...extra });

/** The day a system-booked follow-up was waiting for arrives: its date is today.
 *  The flag is set back on afterwards because changing the date clears it - which
 *  is the point of the trigger, and not what a lead whose day has simply come is. */
async function itsDay(id: string) {
  await pool.query(`UPDATE leads SET next_follow_up_at = date_trunc('day', NOW()) + INTERVAL '10 hours' WHERE id = $1`, [id]);
  await pool.query(`UPDATE leads SET follow_up_auto = TRUE WHERE id = $1`, [id]);
}

async function main() {
  // These dates assume the plain retry rule. The same-day evening retry (an unanswered
  // morning call comes back that evening) depends on the clock, so it is switched off
  // here and has its own test: test-evening-retry.ts.
  await pool.query(`INSERT INTO crm_settings (key, value) VALUES ('evening_retry_cutoff_hour', '0'::jsonb)
                    ON CONFLICT (key) DO UPDATE SET value = '0'::jsonb`);
  await pool.query(`TRUNCATE leads, users RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO users (id, name, email, password_hash, role) VALUES ($1,'Admin','a@t','x','admin')`, [ADMIN]);
  await pool.query(`UPDATE crm_settings SET value = '2'::jsonb, updated_by = NULL WHERE key = 'retry_after_days'`);
  await pool.query(`UPDATE crm_settings SET value = '5'::jsonb WHERE key = 'max_unanswered'`);
  const m = await runMigrations();
  check('the migration applies', m.ok, m);

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;

  console.log('\n--- the migration itself ---');
  check('"Not reachable" exists as a closed stage',
    (await pool.query(`SELECT 1 FROM crm_statuses WHERE slug = 'unreachable' AND is_open = FALSE AND is_won = FALSE AND is_lost = FALSE`)).rows.length === 1);
  check('the limit defaults to five',
    Number((await pool.query(`SELECT value FROM crm_settings WHERE key = 'max_unanswered'`)).rows[0].value) === 5);

  console.log('\n--- not before its day ---');
  const normalNoAnswer = await lead();
  const nearlyNoAnswer = await lead({ nearlyGave: true });
  const normalCallBack = await lead();
  const normalInterested = await lead();
  const nearlyBusy = await lead({ nearlyGave: true });
  const normalBusy = await lead();
  const booked = { normalNoAnswer, nearlyNoAnswer, normalCallBack, normalInterested, nearlyBusy, normalBusy };
  await ring(normalNoAnswer, 'no_answer');
  await ring(nearlyNoAnswer, 'no_answer');
  await ring(normalCallBack, 'call_back');
  await ring(normalInterested, 'interested');
  await ring(nearlyBusy, 'busy');
  await ring(normalBusy, 'busy');

  /* "16th evening I called, but 18th morning only I need to see it in follow-ups."
     Two days on, nobody said when: it must not be on the page before that day. */
  const early = await onFollowUps(true);
  const plain = await onFollowUps(false);
  for (const [name, id] of Object.entries(booked)) {
    check(`${name}: booked two days on, so NOT on Follow-ups yet`, !early.has(id));
  }
  check('...but each has its date, and the plain list and the queue still know',
    Object.values(booked).every((id) => plain.has(id)));

  console.log('\n--- who chose the date ---');
  check('the system booked it after an unanswered call', (await row(normalNoAnswer)).follow_up_auto === true);
  check('and after a connected call with no day picked', (await row(normalCallBack)).follow_up_auto === true);

  console.log('\n--- on its day ---');
  for (const id of Object.values(booked)) await itsDay(id);
  const page = await onFollowUps(true);
  check('Nearly gave, no answer: listed', page.has(nearlyNoAnswer));
  check('Nearly gave, busy: listed', page.has(nearlyBusy));
  check('normal data, no answer: NOT listed (it comes back through the queue)', !page.has(normalNoAnswer));
  check('normal data, busy: NOT listed', !page.has(normalBusy));
  check('normal data, call back later: listed', page.has(normalCallBack));
  check('normal data, interested: listed', page.has(normalInterested));

  console.log('\n--- a day the caller picks is listed at once ---');
  const chosen = await lead();
  const inFour = new Date(Date.now() + 4 * 86_400_000).toISOString();
  await ring(chosen, 'call_back', { next_follow_up_at: inFour });
  check('the caller chose the day: not the system\'s', (await row(chosen)).follow_up_auto === false);
  check('so it is listed under Coming up straight away', (await onFollowUps(true)).has(chosen));

  // A person sets a follow-up on a lead that carried a system retry: it must appear.
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
  const fu = await post(`/api/crm/leads/${normalNoAnswer}/follow-up`, { at: tomorrow });
  check('a person books a follow-up on it', fu.http === 200 || fu.http === 201, fu.http);
  check('...and that clears the system flag, whatever route set the date', (await row(normalNoAnswer)).follow_up_auto === false);
  check('...so it is now listed', (await onFollowUps(true)).has(normalNoAnswer));

  // A promise already booked further out is kept, and is not the system's.
  const promise = await lead();
  await pool.query(`UPDATE leads SET next_follow_up_at = NOW() + INTERVAL '6 days' WHERE id = $1`, [promise]);
  await ring(promise, 'no_answer');
  check('an unanswered call does not turn a booked promise into a retry', (await row(promise)).follow_up_auto === false);
  check('...and it stays listed', (await onFollowUps(true)).has(promise));

  console.log('\n--- not interested leaves, and nothing is deleted ---');
  const no = await lead({ nearlyGave: true });
  await ring(no, 'no_answer');
  await ring(no, 'not_interested');
  check('not interested: off the follow-ups', !(await onFollowUps(true)).has(no) && (await row(no)).next_follow_up_at === null);

  console.log('\n--- the fifth unanswered call closes the lead ---');
  const five = await lead({ nearlyGave: true });
  const outcomes = ['no_answer', 'busy', 'switched_off', 'no_answer'];
  for (const o of outcomes) {
    const r = await ring(five, o);
    check(`${o}: still open, due again`, r.http === 201 && (await row(five)).status === 'attempting' && !!(await row(five)).next_follow_up_at && r.lead.auto_closed === false, { r: r.lead });
  }
  check('four unanswered: booked two days on, not on Follow-ups before then', !(await onFollowUps(true)).has(five));
  await itsDay(five);
  check('...and on it the day it comes round', (await onFollowUps(true)).has(five));
  const fifth = await ring(five, 'busy');
  const closed = await row(five);
  check('the fifth: closed as Not reachable', closed.status === 'unreachable', closed);
  check('...with no follow-up date', closed.next_follow_up_at === null);
  check('...and the screen is told', fifth.lead.auto_closed === true && fifth.lead.unanswered_streak === 5, fifth.lead);
  check('...it is off Follow-ups', !(await onFollowUps(true)).has(five));
  check('...but the lead and all five calls are still on record', (await activities(five)) === 5);
  check('...and it is out of the calling queue (a closed stage)',
    (await pool.query(`SELECT COALESCE(s.is_open, TRUE) AS open FROM leads l LEFT JOIN crm_statuses s ON s.slug = l.status WHERE l.id = $1`, [five])).rows[0].open === false);

  console.log('\n--- a call that connects starts the count again ---');
  const reset = await lead();
  for (const o of ['no_answer', 'busy', 'no_answer']) await ring(reset, o);
  await ring(reset, 'interested');
  for (const o of ['no_answer', 'busy', 'switched_off', 'no_answer']) await ring(reset, o);
  check('three, a conversation, four more: still open (the streak is four)', (await row(reset)).status === 'attempting', await row(reset));
  await ring(reset, 'busy');
  check('and the fifth since the conversation closes it', (await row(reset)).status === 'unreachable', await row(reset));

  console.log('\n--- a reopened lead gets a fresh five ---');
  await pool.query(`UPDATE leads SET status = 'attempting' WHERE id = $1`, [five]);
  const again = await ring(five, 'no_answer');
  check('reopened, one more unanswered call: open, not closed again', (await row(five)).status === 'attempting' && again.lead.unanswered_streak === 1, again.lead);

  console.log('\n--- the caller can decide for themselves ---');
  const chosenDate = await lead();
  for (const o of ['no_answer', 'busy', 'no_answer', 'busy']) await ring(chosenDate, o);
  const pickDay = new Date(Date.now() + 4 * 86_400_000).toISOString();
  await ring(chosenDate, 'no_answer', { next_follow_up_at: pickDay });
  check('a date picked on the fifth: not closed, that date stands',
    (await row(chosenDate)).status !== 'unreachable' && Math.abs(+(await row(chosenDate)).next_follow_up_at - +new Date(pickDay)) < 60_000, await row(chosenDate));

  const chosenStatus = await lead();
  for (const o of ['no_answer', 'busy', 'no_answer', 'busy']) await ring(chosenStatus, o);
  await ring(chosenStatus, 'no_answer', { status: 'contacted' });
  check('a stage picked on the fifth: the caller\'s choice stands', (await row(chosenStatus)).status === 'contacted', await row(chosenStatus));

  console.log('\n--- the limit is a setting ---');
  await pool.query(`UPDATE crm_settings SET value = '2'::jsonb WHERE key = 'max_unanswered'`);
  const two = await lead();
  await ring(two, 'no_answer');
  check('limit two: one unanswered, open', (await row(two)).status === 'attempting');
  await ring(two, 'busy');
  check('limit two: the second closes it', (await row(two)).status === 'unreachable', await row(two));
  await pool.query(`UPDATE crm_settings SET value = '5'::jsonb WHERE key = 'max_unanswered'`);

  console.log('\n--- Undo ---');
  const undoable = await lead();
  for (const o of ['no_answer', 'busy', 'no_answer', 'busy']) await ring(undoable, o);
  const closing = await ring(undoable, 'no_answer');
  check('the fifth closes it', (await row(undoable)).status === 'unreachable');
  const undo = await call('DELETE', `/api/crm/activities/${closing.activity.id}`);
  check('undoing that call works', undo.http === 200, undo);
  const reopened = await row(undoable);
  check('...the lead is open again with its retry date', reopened.status === 'attempting' && !!reopened.next_follow_up_at, reopened);
  const next = await ring(undoable, 'no_answer');
  check('...and the four earlier attempts still count: the next one closes it again',
    (await row(undoable)).status === 'unreachable' && next.lead.unanswered_streak === 5, next.lead);

  server.close();
  await pool.end();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
