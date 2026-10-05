// Calling runs: who to ring, in what order, and that two callers never ring
// the same person a minute apart.
//
// Every case here is a complaint a caller made, or would have:
//   - "I skipped her, refreshed, and she came straight back"
//   - "there is no way back to the last person"
//   - "the card said 40 and I got 12"
//   - "Arjun and I rang the same man within a minute"
//   - "I said I'd ring tomorrow and she was back in an hour"
//   - "no answer on an overdue callback, and it stayed first in the queue"
//   - "I undid Donated now and her Diwali promise had vanished"
//   - "she promised for Govardhan Puja and Bhavin rang her that afternoon"
//
//   DATABASE_URL=postgresql://localhost/drm_test npx tsx scripts/test-sessions.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import crmRoutes from '../src/routes/crm';
import crmListsRoutes from '../src/routes/crmLists';
import crmSessionsRoutes from '../src/routes/crmSessions';
import crmRemindersRoutes from '../src/routes/crmReminders';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use('/api/crm', crmRoutes);
app.use('/api/crm', crmRemindersRoutes);
app.use('/api/crm', crmListsRoutes);
app.use('/api/crm', crmSessionsRoutes);

let base = '';
const ADMIN = '11111111-1111-1111-1111-111111111111';
const ANA = '22222222-2222-2222-2222-222222222222';
const BHAVIN = '33333333-3333-3333-3333-333333333333';
const admin = { userId: ADMIN, role: 'admin' };
const ana = { userId: ANA, role: 'caller' };
const bhavin = { userId: BHAVIN, role: 'caller' };

function req(method: string, path: string, as: { userId: string; role: string } | null, body?: unknown) {
  const raw = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const headers: Record<string, string | number> = {};
  if (as) headers.authorization = `Bearer ${generateToken({ userId: as.userId, email: 'x@t', role: as.role } as never)}`;
  if (raw) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = raw.length;
  }
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const r = http.request(`${base}${path}`, { method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: d ? JSON.parse(d) : {} });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: d });
        }
      });
    });
    r.on('error', reject);
    if (raw) r.write(raw);
    r.end();
  });
}

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500));
  }
}

async function seed() {
  await pool.query(
    `TRUNCATE calling_session_items, calling_sessions, calling_list_members, calling_list_assignments,
              calling_lists, abandoned_attempts, lead_activities, lead_reminders, leads, donations, people, users
     RESTART IDENTITY CASCADE`
  );
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role) VALUES
       ($1,'Admin','a@t','x','admin'), ($2,'Ana','ana@t','x','caller'), ($3,'Bhavin','bh@t','x','caller')`,
    [ADMIN, ANA, BHAVIN]
  );
}

async function lead(phone: string, name: string, extra: Record<string, unknown> = {}) {
  const cols = ['phone', 'name', ...Object.keys(extra)];
  const vals = [phone, name, ...Object.values(extra)];
  const r = await pool.query(
    `INSERT INTO leads (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
    vals
  );
  return r.rows[0].id as string;
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  await seed();

  console.log('\n1. the count on the start screen is what the run hands over');
  const ids: string[] = [];
  for (let n = 0; n < 6; n++) ids.push(await lead(`98000000${10 + n}`, `Sheet person ${n}`, { tags: ['diwali'] }));
  // Somebody else's, somebody asked-not-to-call, and one booked for tomorrow.
  await lead('9800000090', 'Bhavin owns', { tags: ['diwali'], assigned_to: BHAVIN });
  await lead('9800000091', 'Do not call', { tags: ['diwali'], do_not_call: true });
  const tomorrow = await lead('9800000092', 'Tomorrow 10am', {
    tags: ['diwali'],
    next_follow_up_at: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) + 'T10:00:00+05:30',
  });
  const list = await req('POST', '/api/crm/lists', admin, { name: 'Diwali', tag: 'diwali' });
  check('admin makes a list', list.status === 201, list.body);
  const listId = list.body.id;

  const sources = await req('GET', '/api/crm/sessions/sources', ana);
  const diwali = sources.body.lists?.find((l: any) => l.list_id === listId);
  check('the list card counts only what Ana would be handed (6)', diwali?.count === 6, diwali);
  const lists = await req('GET', '/api/crm/lists', ana);
  check('the lists screen agrees (to_call = 6)', lists.body.lists?.[0]?.to_call === 6, lists.body.lists?.[0]);
  check(
    '"tomorrow 10am" is not due today',
    !(await pool.query(`SELECT 1 FROM leads l WHERE id = $1 AND (l.next_follow_up_at < date_trunc('day', NOW()) + INTERVAL '1 day')`, [tomorrow])).rows.length
  );

  const start = await req('POST', '/api/crm/sessions', ana, { source: { kind: 'list', list_id: listId } });
  check('Ana starts the list', start.status === 201, start.body);
  check('the run holds the same 6', start.body.counts?.total === 6, start.body.counts);
  check('she is on the first person', start.body.counts?.index === 1 && !!start.body.lead, start.body.counts);
  const sid = start.body.session.id;
  const first = start.body.lead.id;

  console.log('\n2. two callers on the same list never get the same person');
  const bStart = await req('POST', '/api/crm/sessions', bhavin, { source: { kind: 'list', list_id: listId } });
  check('Bhavin starts the same list', bStart.status === 201, bStart.body);
  check('and is handed somebody else', bStart.body.lead && bStart.body.lead.id !== first, {
    ana: first,
    bhavin: bStart.body.lead?.id,
  });
  const claimed = await pool.query(`SELECT claimed_by FROM leads WHERE id = $1`, [first]);
  check("Ana's person is claimed by Ana", claimed.rows[0].claimed_by === ANA);

  console.log('\n3. skip survives a refresh; previous goes back');
  const skip = await req('POST', `/api/crm/sessions/${sid}/move`, ana, { action: 'skip' });
  const second = skip.body.lead?.id;
  check('skip moves on', second && second !== first, skip.body);
  const again = await req('GET', `/api/crm/sessions/${sid}`, ana);
  check('a refresh stays on the same person', again.body.lead?.id === second, again.body.lead?.id);
  check('the skipped one is recorded as skipped', again.body.counts?.skipped === 1, again.body.counts);
  check('her claim on the first person was let go', !(await pool.query(`SELECT 1 FROM leads WHERE id=$1 AND claimed_by IS NOT NULL`, [first])).rows.length);

  // Log a call on the second person through the session, then move on and back.
  const call = await req('POST', `/api/crm/leads/${second}/call`, ana, { disposition: 'interested', session_id: sid });
  check('the call is logged', call.status === 201, call.body);
  const item = await pool.query(`SELECT state, outcome FROM calling_session_items WHERE session_id = $1 AND lead_id = $2`, [sid, second]);
  check('and marked done in the run', item.rows[0]?.state === 'done' && item.rows[0]?.outcome === 'interested', item.rows[0]);
  const next = await req('POST', `/api/crm/sessions/${sid}/move`, ana, { action: 'next' });
  check('next goes forward', next.body.lead && next.body.lead.id !== second, next.body.lead?.id);
  const prev = await req('POST', `/api/crm/sessions/${sid}/move`, ana, { action: 'prev' });
  check('previous comes back to the one she rang', prev.body.lead?.id === second, prev.body.lead?.id);
  check('showing what she logged', prev.body.item?.state === 'done' && prev.body.item?.outcome === 'interested', prev.body.item);

  console.log('\n4. somebody rung by a colleague since the snapshot is stepped past');
  const items = await req('GET', `/api/crm/sessions/${sid}/items`, ana);
  const pendingLater = items.body.items.filter((i: any) => i.state === 'pending').map((i: any) => i.lead_id);
  const victim = pendingLater[pendingLater.length - 1];
  await pool.query(
    `INSERT INTO lead_activities (lead_id, user_id, kind, disposition, connected, created_at)
     VALUES ($1, $2, 'call', 'call_back', true, NOW() + INTERVAL '1 second')`,
    [victim, BHAVIN]
  );
  let seen = new Set<string>();
  let state = await req('POST', `/api/crm/sessions/${sid}/move`, ana, { action: 'jump', position: prev.body.item.position });
  for (let g = 0; g < 10 && !state.body.finished; g++) {
    seen.add(state.body.lead.id);
    state = await req('POST', `/api/crm/sessions/${sid}/move`, ana, { action: 'next' });
  }
  check('Ana is never handed the person Bhavin rang', !seen.has(victim), [...seen]);
  check('Ana is never handed the person Bhavin is on now', !seen.has(bStart.body.lead.id));
  const taken = await pool.query(`SELECT note FROM calling_session_items WHERE session_id = $1 AND lead_id = $2`, [sid, victim]);
  check('and the run says why', /Called by Bhavin/.test(taken.rows[0]?.note ?? ''), taken.rows[0]);
  check('the run reaches its end', state.body.finished === true, state.body.counts);

  console.log('\n5. go back to the skipped ones');
  const revisit = await req('POST', `/api/crm/sessions/${sid}/move`, ana, { action: 'revisit' });
  check('revisit lands on somebody skipped', !!revisit.body.lead && revisit.body.finished === false, revisit.body);
  const backAtStart = await req('POST', `/api/crm/sessions/${sid}/move`, ana, { action: 'prev' });
  check('prev from there still works', backAtStart.status === 200, backAtStart.body);

  console.log('\n6. pressing Start again resumes rather than restarting');
  const resume = await req('POST', '/api/crm/sessions', ana, { source: { kind: 'list', list_id: listId } });
  check('same run', resume.body.session?.id === sid && resume.body.resumed === true, resume.body.session);
  const ended = await req('POST', `/api/crm/sessions/${sid}/end`, ana);
  check('ending gives a summary', ended.status === 200 && ended.body.summary?.calls === 1, ended.body.summary);
  check('and lets go of everybody', !(await pool.query(`SELECT 1 FROM leads WHERE claimed_by = $1`, [ANA])).rows.length);
  await req('POST', `/api/crm/sessions/${bStart.body.session.id}/end`, bhavin);

  console.log('\n7. no answer on an overdue callback books a fresh retry');
  const overdue = await lead('9800000100', 'Overdue', { next_follow_up_at: new Date(Date.now() - 3 * 86_400_000).toISOString() });
  await req('POST', `/api/crm/leads/${overdue}/call`, ana, { disposition: 'no_answer' });
  const od = await pool.query(`SELECT next_follow_up_at > NOW() + INTERVAL '1 day' AS ahead FROM leads WHERE id = $1`, [overdue]);
  check('the retry is in the future', od.rows[0].ahead === true, od.rows[0]);
  const future = await lead('9800000101', 'Booked Friday', { next_follow_up_at: new Date(Date.now() + 5 * 86_400_000).toISOString() });
  const before = await pool.query(`SELECT next_follow_up_at FROM leads WHERE id = $1`, [future]);
  await req('POST', `/api/crm/leads/${future}/call`, ana, { disposition: 'no_answer' });
  const after = await pool.query(`SELECT next_follow_up_at FROM leads WHERE id = $1`, [future]);
  check('a callback still ahead is kept', +after.rows[0].next_follow_up_at === +before.rows[0].next_follow_up_at);

  console.log('\n8. a promise holds the lead; undoing Donated now reopens it');
  const promiser = await lead('9800000102', 'Promiser', { assigned_to: ANA });
  const due = new Date(Date.now() + 10 * 86_400_000).toISOString();
  await req('POST', `/api/crm/leads/${promiser}/call`, ana, {
    disposition: 'promised',
    reminder: { due_at: due, occasion: 'Govardhan Puja', expected_amount: 5000 },
  });
  const held = await pool.query(`SELECT next_follow_up_at FROM leads WHERE id = $1`, [promiser]);
  check('the lead waits for the promise', +new Date(held.rows[0].next_follow_up_at) >= +new Date(due) - 1000, held.rows[0]);
  const bSources = await req('GET', '/api/crm/sessions/sources', bhavin);
  const everything = bSources.body.sources.find((s: any) => s.kind === 'everything');
  const bRun = await req('POST', '/api/crm/sessions', bhavin, { source: { kind: 'everything' } });
  const bItems = bRun.body.session ? await req('GET', `/api/crm/sessions/${bRun.body.session.id}/items`, bhavin) : { body: { items: [] } };
  check('Bhavin is not handed the promiser', !bItems.body.items.some((i: any) => i.lead_id === promiser));
  check("Bhavin's Everyone due count matches his run", everything.count === (bRun.body.counts?.total ?? 0), {
    card: everything.count,
    run: bRun.body.counts?.total,
  });

  const donated = await req('POST', `/api/crm/leads/${promiser}/call`, ana, { disposition: 'donated', donated_amount: 5000 });
  const closed = await pool.query(`SELECT status FROM lead_reminders WHERE lead_id = $1`, [promiser]);
  check('Donated now closes the promise', closed.rows[0]?.status === 'done', closed.rows);
  const undo = await req('DELETE', `/api/crm/activities/${donated.body.activity.id}`, ana);
  check('undo succeeds', undo.status === 200, undo.body);
  const reopened = await pool.query(`SELECT status FROM lead_reminders WHERE lead_id = $1`, [promiser]);
  check('and the promise is open again', reopened.rows[0]?.status === 'open', reopened.rows);
  const unconv = await pool.query(`SELECT converted_at, converted_note FROM leads WHERE id = $1`, [promiser]);
  check('the conversion is gone, note included', !unconv.rows[0].converted_at && !unconv.rows[0].converted_note, unconv.rows[0]);

  console.log('\n9. nearly gave: many at once, set aside, and a run');
  await pool.query(
    `INSERT INTO abandoned_attempts (source_site, external_id, phone, name, amount, purpose, attempted_at, status) VALUES
       ('hkmv','a1','9811111101','Asha',2000,'Annadan',NOW() - INTERVAL '2 hours','failed'),
       ('hkmv','a2','9811111102','Bala',5000,'Gau seva',NOW() - INTERVAL '3 hours','failed'),
       ('annadan','a3','9811111103','Chitra',1000,'Annadan',NOW() - INTERVAL '4 hours','created'),
       ('hkmv','a4','9800000091','Do not call',800,'Annadan',NOW() - INTERVAL '5 hours','failed'),
       ('hkmv','a5','9811111105','Set aside',300,'Annadan',NOW() - INTERVAL '20 days','failed')`
  );
  const aside = await pool.query(`SELECT id FROM abandoned_attempts WHERE external_id = 'a5'`);
  await req('POST', `/api/crm/leads/abandoned/${aside.rows[0].id}/dismiss`, ana);
  // Set aside ten days ago...
  await pool.query(`UPDATE abandoned_attempts SET dismissed_at = NOW() - INTERVAL '10 days' WHERE external_id = 'a5'`);
  // They try again after being set aside - a new, warm attempt.
  await pool.query(
    `INSERT INTO abandoned_attempts (source_site, external_id, phone, name, amount, purpose, attempted_at, status)
     VALUES ('hkmv','a6','9811111105','Set aside',300,'Annadan',NOW() - INTERVAL '1 hour','failed')`
  );
  const list9 = await pool.query(`SELECT phone FROM abandoned_attempts WHERE dismissed_at IS NULL`);
  check('setup', list9.rows.length === 5);
  const adopt = await req('POST', '/api/crm/leads/abandoned/adopt-bulk', ana, { all: true, filters: { days: 30 }, assign: 'me' });
  check('adopting all of them answers with counts', adopt.status === 200, adopt.body);
  check('4 new leads (incl. the one who tried again after Set aside)', adopt.body.created === 4, adopt.body);
  check('the do-not-call one is refused', adopt.body.do_not_call === 1, adopt.body);
  const aRun = await req('POST', '/api/crm/sessions', ana, { source: { kind: 'selection', lead_ids: adopt.body.lead_ids, label: 'Nearly gave today' } });
  check('"Add and start calling" opens a run of exactly them', aRun.body.counts?.total === 4, aRun.body.counts);
  check('in the order they were picked', aRun.body.lead?.id === adopt.body.lead_ids[0]);
  check('the call screen knows what they tried to give', Number(aRun.body.lead?.nearly_gave?.amount) > 0, aRun.body.lead?.nearly_gave);
  await req('POST', `/api/crm/sessions/${aRun.body.session.id}/end`, ana);
  const single = await req('GET', `/api/crm/leads/${adopt.body.lead_ids[0]}`, ana);
  check('a single lead also says what they tried to give', Number(single.body.nearly_gave?.amount) > 0, single.body.nearly_gave);
  // A colleague's lead stays theirs even when an admin adopts "unassigned".
  await pool.query(
    `INSERT INTO abandoned_attempts (source_site, external_id, phone, name, amount, attempted_at, status)
     VALUES ('hkmv','a7','9800000090','Bhavin owns',700,NOW() - INTERVAL '1 hour','failed')`
  );
  const row = await pool.query(`SELECT id FROM abandoned_attempts WHERE external_id = 'a7'`);
  const adm = await req('POST', '/api/crm/leads/abandoned/adopt-bulk', admin, { ids: [row.rows[0].id], filters: { days: 30 }, assign: 'none' });
  check("a colleague's lead is counted as theirs and left out", adm.body.already_others === 1 && adm.body.lead_ids.length === 0, adm.body);

  console.log('\n10. hand-picked list members, and sharing a list out');
  const handList = await req('POST', '/api/crm/lists', admin, { name: 'Hand picked', members_only: true, lead_ids: [ids[0], ids[1]] });
  const hs = await req('GET', '/api/crm/sessions/sources', admin);
  check('a hand-built list holds exactly its people', hs.body.lists.find((l: any) => l.list_id === handList.body.id)?.count === 2);
  await req('POST', `/api/crm/lists/${listId}/members`, admin, { lead_ids: [ids[5]], action: 'exclude' });
  const seeThem = await req('GET', `/api/crm/leads?list=${listId}&limit=100`, admin);
  check('"See them" leaves out the excluded one', !seeThem.body.leads.some((l: any) => l.id === ids[5]), seeThem.body.total);
  const cards = await req('GET', '/api/crm/lists', ana);
  const card = cards.body.lists.find((l: any) => l.id === listId);
  const dueNow = await req("GET", `/api/crm/leads?list=${listId}&callable=true&limit=100`, ana);
  check('"See them" shows what the card counts', dueNow.body.total === card.to_call, { card: card.to_call, list: dueNow.body.total });
  const split = await req('POST', `/api/crm/lists/${listId}/split`, admin, { user_ids: [ANA, BHAVIN] });
  check('the list is dealt between two callers', split.status === 200 && split.body.shares.every((s: any) => s.count >= 1), split.body);
  const counts = split.body.shares.map((s: any) => s.count);
  check('evenly', Math.abs(counts[0] - counts[1]) <= 1, counts);

  console.log('\n11. correcting a number');
  const fix = await req('PUT', `/api/crm/leads/${ids[0]}`, admin, { phone: '+91 98765 43210' });
  check('a new number is saved normalised', fix.status === 200 && fix.body.phone === '9876543210', fix.body);
  const clash = await req('PUT', `/api/crm/leads/${ids[1]}`, admin, { phone: '9876543210' });
  check('a number another lead has is refused with 409', clash.status === 409, clash.body);
  const bad = await req('PUT', `/api/crm/leads/${ids[1]}`, admin, { phone: '12345' });
  check('a non-mobile is refused', bad.status === 400);

  console.log('\n12. search from the top bar');
  const s1 = await req('GET', '/api/crm/search?q=98765%2043210', admin);
  check('finds a lead by a spaced-out number', s1.body.leads?.[0]?.id === ids[0], s1.body);
  const s2 = await req('GET', '/api/crm/search?q=Bhavin%20owns', ana);
  check("a caller does not find a colleague's lead", s2.body.leads?.length === 0, s2.body);

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
