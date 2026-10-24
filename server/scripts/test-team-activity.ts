/**
 * Team activity: the numbers on the admin's per-caller page are what the call log says,
 * counted the way the page says they are, and only an admin can see them.
 *
 *   NODE_ENV=development DATABASE_URL=...drm_test npx tsx scripts/test-team-activity.ts
 */
import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import { runMigrations } from '../src/db/migrate';
import teamActivityRoutes from '../src/routes/crmTeamActivity';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use('/api/crm', teamActivityRoutes);
let base = '';
const ID = {
  admin: '11111111-1111-1111-1111-111111111111',
  asha: '33333333-3333-3333-3333-333333333333',
  bala: '44444444-4444-4444-4444-444444444444',
};
const tok = (id: string, role: string) => generateToken({ userId: id, email: `${id}@t`, role } as never);
const tokens = { admin: tok(ID.admin, 'admin'), caller: tok(ID.asha, 'caller'), accountant: tok(ID.bala, 'accountant') };

const call = (as: keyof typeof tokens | null, method: string, path: string, body?: unknown) =>
  new Promise<any>((resolve, reject) => {
    const u = new URL(`${base}${path}`);
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
        headers: { ...(as ? { authorization: `Bearer ${tokens[as]}` } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => { try { resolve({ http: res.statusCode, ...JSON.parse(d || '{}') }); } catch { resolve({ http: res.statusCode, raw: d }); } });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${label}`);
  failures++;
  console.error(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`);
};

const DAY = '2026-09-15';
const at = (hhmm: string, day = DAY) => `${day}T${hhmm}:00+05:30`;

async function main() {
  const m = await runMigrations();
  check('the migration applies', m.ok, true);
  await pool.query(`TRUNCATE leads, caller_credits, qr_shares, calling_sessions, users RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO users (id, name, email, password_hash, role) VALUES
    ($1,'Admin','a@t','x','admin'), ($2,'Asha','asha@t','x','caller'), ($3,'Bala','bala@t','x','caller')`, [ID.admin, ID.asha, ID.bala]);
  await pool.query(`UPDATE users SET role = 'caller' WHERE id = $1`, [ID.bala]);
  const lead = async (phone: string) => (await pool.query(`INSERT INTO leads (phone, name, status) VALUES ($1,$2,'new') RETURNING id`, [phone, `Donor ${phone.slice(-2)}`])).rows[0].id as string;
  const L1 = await lead('9000000011'), L2 = await lead('9000000022');

  const act = (user: string, lead_: string, when: string, o: { connected: boolean | null; dur?: number; source?: string; dispo?: string; dir?: string; note?: string }) =>
    pool.query(
      `INSERT INTO lead_activities (lead_id, user_id, kind, direction, disposition, connected, duration_seconds, source, note, occurred_at)
       VALUES ($1,$2,'call',$3,$4,$5,$6,$7,$8,$9)`,
      [lead_, user, o.dir ?? 'outbound', o.dispo ?? (o.connected ? 'interested' : 'no_answer'), o.connected, o.dur ?? null, o.source ?? 'manual', o.note ?? null, when]
    );
  // Asha, 15 Sep: 5 outbound calls and 1 answered inbound, a 52-minute gap, one Seva wall call
  await act(ID.asha, L1, at('10:00'), { connected: true, dur: 120, source: 'phone' });
  await act(ID.asha, L1, at('10:05'), { connected: false });
  await act(ID.asha, L1, at('10:08'), { connected: true, dur: 60, source: 'manual' });
  await act(ID.asha, L2, at('11:00'), { connected: false });
  await act(ID.asha, L2, at('11:02'), { connected: true, dispo: 'seva_wall_answered', note: 'Seva wall (Brick seva): wants another brick' });
  await act(ID.asha, L2, at('12:00'), { connected: true, dir: 'inbound' });
  // the day before, for the trend
  await act(ID.asha, L1, at('10:00', '2026-09-14'), { connected: true });
  await act(ID.asha, L1, at('10:03', '2026-09-14'), { connected: false });
  await pool.query(`INSERT INTO caller_credits (user_id, amount, kind, occurred_at) VALUES ($1, 500, 'manual', $2)`, [ID.asha, at('11:30')]);

  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;

  console.log('\n--- who can see it ---');
  check('an admin can', (await call('admin', 'GET', `/api/crm/team-activity?date=${DAY}`)).http, 200);
  check('a caller cannot see anyone\'s numbers, not even their own', (await call('caller', 'GET', `/api/crm/team-activity?date=${DAY}`)).http, 403);
  check('nor can an accountant', (await call('accountant', 'GET', `/api/crm/team-activity?date=${DAY}`)).http, 403);
  check('nor a drill-down', (await call('caller', 'GET', `/api/crm/team-activity/${ID.asha}?date=${DAY}`)).http, 403);
  check('or downloading', (await call('caller', 'GET', `/api/crm/team-activity/export.csv?date=${DAY}`)).http, 403);

  console.log('\n--- the scorecard counts what the call log says ---');
  const r = await call('admin', 'GET', `/api/crm/team-activity?date=${DAY}`);
  const asha = r.callers.find((c: any) => c.id === ID.asha);
  const bala = r.callers.find((c: any) => c.id === ID.bala);
  check('callers listed are the callers (not the admin)', r.callers.map((c: any) => c.name), ['Asha', 'Bala']);
  check('every talk counts: 5 she made + 1 a donor made to her', [asha.calls, asha.inbound_calls], [6, 1]);
  check('answered, unanswered and the percentage', [asha.connected, asha.unanswered, asha.answered_pct], [4, 2, 67]);
  check('talk time from the phone app is kept apart from time a caller typed', [asha.talk_real_seconds, asha.talk_logged_seconds], [120, 60]);
  check('first and last call', [new Date(asha.first_call_at).toISOString(), new Date(asha.last_call_at).toISOString()], ['2026-09-15T04:30:00.000Z', '2026-09-15T06:30:00.000Z']);
  check('active time counts each gap up to 10 minutes: 5 + 3 + 10 + 2 + 10 (the inbound one)', asha.active_minutes, 30);
  check('one break over 30 minutes, the longest 58 (the inbound call came after the 52)', [asha.idle_gaps, asha.longest_gap_minutes], [2, 58]);
  check('donors actually reached', asha.donors_reached, 2);
  check('Seva wall calls are counted among them', asha.seva_wall_calls, 1);
  check('money credited that day', [asha.raised, asha.credits], [500, 1]);
  check('the last 7 days, oldest first, ending on the day chosen', asha.trend_7d, [0, 0, 0, 0, 0, 2, 6]);
  check('a caller with no calls is shown with zeros, not left out', [bala.calls, bala.answered_pct, bala.first_call_at], [0, null, null]);
  check('status is only given for today, not for a past day', asha.status, null);
  check('the totals add up', [r.totals.calls, r.totals.connected, r.totals.raised], [6, 4, 500]);
  check('a made-up date falls back to today instead of failing', (await call('admin', 'GET', '/api/crm/team-activity?date=garbage')).today, true);

  console.log('\n--- one caller\'s day ---');
  const d = await call('admin', 'GET', `/api/crm/team-activity/${ID.asha}?date=${DAY}`);
  check('every call, newest first, with the outcome and the donor', [d.timeline.length, d.timeline[0].donor_name], [6, 'Donor 22']);
  check('the inbound call is shown but marked inbound', d.timeline.filter((x: any) => x.direction === 'inbound').length, 1);
  check('calls by hour (IST)', d.hourly.map((h: any) => [h.hour, h.calls]), [[10, 3], [11, 2], [12, 1]]);
  check('how the calls ended', d.outcomes.some((o: any) => o.outcome === 'Seva wall - answered') || d.outcomes.some((o: any) => o.outcome === 'seva_wall_answered'), true);
  check('a 14-day trend ending on the day', [d.trend_14d.length, d.trend_14d[13].calls, d.trend_14d[12].calls], [14, 6, 2]);
  check('a made-up caller is a 404', (await call('admin', 'GET', '/api/crm/team-activity/00000000-0000-0000-0000-000000000000')).http, 404);
  check('a malformed id is a 404 too', (await call('admin', 'GET', '/api/crm/team-activity/nope')).http, 404);

  console.log('\n--- there are no targets to set ---');
  check('the old targets address is gone', (await call('admin', 'GET', '/api/crm/team-activity/targets')).http, 404);
  check('and the page carries no targets', 'targets' in (await call('admin', 'GET', `/api/crm/team-activity?date=${DAY}`)), false);

  console.log('\n--- nothing is changed by looking ---');
  check('no call, lead or credit was written', (await pool.query(`SELECT (SELECT COUNT(*) FROM lead_activities)::int AS a, (SELECT COUNT(*) FROM caller_credits)::int AS c`)).rows[0], { a: 8 + 0, c: 1 });

  server.close();
  await pool.end();
  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nall passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
