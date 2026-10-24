// Unmatched calls: a call from a number DRM did not know, added from its recording.
//
// The cases are what a caller or an admin would notice:
//   - "he rang from his wife's phone and DRM never knew" (the call is added, the number is saved)
//   - "the five minutes I spent on it are in Team activity" (talk time is the recording's length)
//   - "I cannot type a longer time to look busier" (no time is taken from anywhere but the file)
//   - "the next call from that number matches by itself"
//   - "I picked the wrong donor / the number is somebody else's" (asked, not silently overwritten)
//   - "the same call twice" (asked before it is added again)
//   - "only I and the admin can hear it"
//
//   DATABASE_URL=postgresql://localhost/drm_sevawall_test npx tsx scripts/test-unmatched-calls.ts

import './test-unmatched-calls.env';
import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import crmRoutes from '../src/routes/crm';
import crmTeamActivityRoutes from '../src/routes/crmTeamActivity';
import phoneAppRoutes from '../src/routes/phoneApp';
import unmatchedCallsRoutes from '../src/routes/unmatchedCalls';
import { recordCalls } from '../src/services/phoneCalls';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

const objects = new Map<string, Buffer>();
const s3 = http.createServer((rq, rs) => {
  const chunks: Buffer[] = [];
  rq.on('data', (c) => chunks.push(c));
  rq.on('end', () => {
    const path = decodeURIComponent((rq.url ?? '').split('?')[0]);
    if (rq.method === 'PUT') {
      objects.set(path, Buffer.concat(chunks));
      rs.writeHead(200, { ETag: '"x"' }).end();
    } else if (rq.method === 'DELETE') {
      objects.delete(path);
      rs.writeHead(204).end();
    } else if (rq.method === 'GET' && objects.has(path)) {
      const b = objects.get(path)!;
      rs.writeHead(200, { 'Content-Length': b.length, 'Content-Type': 'application/octet-stream' }).end(b);
    } else {
      rs.writeHead(404, { 'Content-Type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code></Error>');
    }
  });
});

const app = express();
app.use(express.json());
app.use('/api/crm', crmRoutes);
app.use('/api/crm', crmTeamActivityRoutes);
app.use('/api/app', phoneAppRoutes);
app.use('/api/unmatched-calls', unmatchedCallsRoutes);

let base = '';
const ADMIN = '11111111-1111-1111-1111-111111111111';
const ANA = '22222222-2222-2222-2222-222222222222';
const BHAVIN = '33333333-3333-3333-3333-333333333333';
const admin = { userId: ADMIN, role: 'admin' };
const ana = { userId: ANA, role: 'caller' };
const bhavin = { userId: BHAVIN, role: 'caller' };

function req(method: string, path: string, as: { userId: string; role: string } | null, body?: Buffer | unknown, extra: Record<string, string> = {}) {
  const raw = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const headers: Record<string, string | number> = { ...extra };
  if (as) headers.authorization = `Bearer ${generateToken({ userId: as.userId, role: as.role } as never)}`;
  if (raw) {
    if (!headers['content-type']) headers['content-type'] = 'application/json';
    headers['content-length'] = raw.length;
  }
  return new Promise<{ status: number; body: any; raw: Buffer }>((resolve, reject) => {
    const r = http.request(`${base}${path}`, { method, headers }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(parts);
        let parsed: any = {};
        try {
          parsed = buf.length ? JSON.parse(buf.toString()) : {};
        } catch {
          parsed = buf.toString();
        }
        resolve({ status: res.statusCode ?? 0, body: parsed, raw: buf });
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
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600));
  }
}

/** A real WAV file of silence: 8 kHz, 16-bit, mono. */
function wav(seconds: number): Buffer {
  const data = Buffer.alloc(seconds * 16000);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24);
  h.writeUInt32LE(16000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const WAV = { 'content-type': 'audio/wav', 'x-file-name': 'call.wav' };

function add(as: typeof ana | typeof admin | null, params: Record<string, string>, file: Buffer = wav(90)) {
  const qs = new URLSearchParams(params).toString();
  return req('POST', `/api/unmatched-calls?${qs}`, as, file, WAV);
}

async function main() {
  await new Promise<void>((r) => s3.listen(4598, '127.0.0.1', () => r()));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;

  await pool.query(
    `TRUNCATE recording_listens, phone_calls, app_devices, calling_session_items, calling_sessions,
              lead_activities, lead_reminders, leads, donations, people, users
     RESTART IDENTITY CASCADE`
  );
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role) VALUES
       ($1,'Admin','a@t','x','admin'), ($2,'Ana','ana@t','x','caller'), ($3,'Bhavin','bh@t','x','caller')`,
    [ADMIN, ANA, BHAVIN]
  );
  const asha = (await pool.query(`INSERT INTO leads (phone, name, assigned_to) VALUES ('9811111101','Asha Rao',$1) RETURNING id`, [ANA])).rows[0].id;
  const bala = (await pool.query(`INSERT INTO leads (phone, name, alt_phone, assigned_to) VALUES ('9811111102','Bala','9811199999',$1) RETURNING id`, [ANA])).rows[0].id;
  const esha = (await pool.query(`INSERT INTO leads (phone, name, assigned_to) VALUES ('9811111105','Esha',$1) RETURNING id`, [ANA])).rows[0].id;
  const chitra = (await pool.query(`INSERT INTO leads (phone, name, assigned_to) VALUES ('9811111103','Chitra',$1) RETURNING id`, [BHAVIN])).rows[0].id;
  await pool.query(`INSERT INTO people (name, phone) VALUES ('Deepa Donor', '9811111104')`);
  const deepa = (await pool.query(`SELECT id FROM people WHERE phone = '9811111104'`)).rows[0].id;

  console.log('\n1. a donor rang from a number DRM did not know');
  let r = await add(ana, { phone: '9000000001', started_at: ago(20), lead_id: asha, note: 'from his wife\'s phone' });
  check('the call is added', r.status === 201, r.body);
  check('its talk time is the length of the recording, 90 seconds', r.body.duration_seconds === 90, r.body);
  const call1 = r.body.id as string;
  const row = (await pool.query(`SELECT * FROM phone_calls WHERE id = $1`, [call1])).rows[0];
  check('kept like a phone call, with no phone behind it', row.added_by_hand === true && row.device_id === null && row.recording_status === 'uploaded' && row.user_id === ANA, row);
  const act = (await pool.query(`SELECT * FROM lead_activities WHERE id = $1`, [row.activity_id])).rows[0];
  check('it is in the donor\'s history as Ana\'s answered call', act?.kind === 'call' && act.user_id === ANA && act.connected === true && act.direction === 'inbound', act);
  check('measured, not typed: the source says recording', act?.source === 'recording' && act.duration_seconds === 90, act);
  check('the note and the recording are on it', /wife/.test(act?.note ?? '') && act?.recording_url === `/api/app/calls/${call1}/recording`, act);
  const lead = (await pool.query(`SELECT alt_phone FROM leads WHERE id = $1`, [asha])).rows[0];
  check('the number is saved as the donor\'s other number', lead.alt_phone === '9000000001', lead);
  check('the saying tells her so', /other number/.test(r.body.message ?? ''), r.body);

  console.log('\n2. it counts in Team activity');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const ta = await req('GET', `/api/crm/team-activity?date=${today}`, admin);
  const anaRow = ta.body.callers?.find((x: any) => x.id === ANA);
  check('one call and its 90 seconds are real talk time', anaRow?.calls === 1 && anaRow?.talk_real_seconds === 90 && anaRow?.talk_logged_seconds === 0, anaRow);
  check('and it is a call from a donor', anaRow?.inbound_calls === 1, anaRow);

  console.log('\n3. the next call from that number matches by itself');
  const dev = (await pool.query(`INSERT INTO app_devices (install_id, user_id, key_hash) VALUES ('ana-phone', $1, 'k') RETURNING id`, [ANA])).rows[0].id;
  const rc = await recordCalls({ id: dev, user_id: ANA }, [{ key: 'z-1', type: 1, phone: '9000000001', started_at: ago(2), duration_seconds: 40 }]);
  check('the phone app now keeps it, on Asha', !!rc[0]?.id && (await pool.query(`SELECT lead_id FROM phone_calls WHERE id = $1`, [rc[0].id])).rows[0].lead_id === asha, rc);
  r = await add(ana, { phone: '9000000001', started_at: ago(60) });
  check('adding it again with nobody chosen finds Asha', r.status === 201 && r.body.donor === 'Asha Rao' && r.body.number_saved === false, r.body);

  console.log('\n4. only the recording gives the time');
  r = await add(ana, { phone: '9000000002', started_at: ago(30), lead_id: asha, replace_alt: '1', duration_seconds: '3000', seconds: '3000' } as never, wav(5));
  check('a typed time is ignored: 5 seconds', r.status === 201 && r.body.duration_seconds === 5, r.body);
  r = await add(ana, { phone: '9000000003', started_at: ago(30), lead_id: asha }, Buffer.alloc(4000, 7));
  check('a file whose length cannot be read is refused', r.status === 400 && /how long/.test(r.body.error), r.body);
  const junk = await pool.query(`SELECT COUNT(*)::int AS n FROM phone_calls WHERE phone = '9000000003'`);
  check('and nothing of it is stored', junk.rows[0].n === 0, junk.rows[0]);
  r = await add(ana, { phone: '9000000003', started_at: ago(30), lead_id: asha }, Buffer.alloc(0));
  check('no file is refused', r.status === 400, r.body);

  console.log('\n5. the details are checked');
  r = await add(ana, { phone: '12345', started_at: ago(30), lead_id: asha });
  check('a short number is refused', r.status === 400, r.body);
  r = await add(ana, { phone: '9000000004', started_at: new Date(Date.now() + 3_600_000).toISOString(), lead_id: asha });
  check('a time that has not happened is refused', r.status === 400, r.body);
  r = await add(ana, { phone: '9000000004', started_at: ago(60 * 24 * 60), lead_id: asha });
  check('a call from two months ago is refused', r.status === 400, r.body);
  r = await add(ana, { phone: '9000000004', started_at: ago(30) });
  check('nobody chosen and no name is refused', r.status === 400, r.body);
  r = await add(null, { phone: '9000000004', started_at: ago(30), lead_id: asha });
  check('it needs a login', r.status === 401, r.status);

  console.log('\n6. the number is somebody else\'s, or the donor has another');
  r = await add(ana, { phone: '9811111102', started_at: ago(45), lead_id: asha });
  check('a number that is already Bala\'s is not given to Asha', r.status === 409 && r.body.code === 'number_belongs', r.body);
  r = await add(ana, { phone: '9000000005', started_at: ago(90), lead_id: asha });
  check('Asha already has another number: asked first', r.status === 409 && r.body.code === 'alt_taken' && r.body.alt_phone === '9000000002', r.body);
  const same = (await pool.query(`SELECT alt_phone FROM leads WHERE id = $1`, [asha])).rows[0];
  check('and nothing was changed meanwhile', same.alt_phone === '9000000002', same);
  r = await add(ana, { phone: '9000000005', started_at: ago(90), lead_id: asha, replace_alt: '1' });
  check('with her say-so it is replaced', r.status === 201 && r.body.number_saved === true, r.body);
  check('the new number is Asha\'s now', (await pool.query(`SELECT alt_phone FROM leads WHERE id = $1`, [asha])).rows[0].alt_phone === '9000000005');

  console.log('\n7. the same call twice');
  r = await add(ana, { phone: '9000000006', started_at: ago(120), lead_id: esha });
  check('first time it is added', r.status === 201 || r.status === 409, r.body);
  r = await add(ana, { phone: '9000000006', started_at: ago(119), lead_id: esha });
  check('a second at almost the same time is asked about', r.status === 409 && r.body.code === 'duplicate', r.body);
  r = await add(ana, { phone: '9000000006', started_at: ago(119), lead_id: esha, force: '1' });
  check('and added when she says so', r.status === 201, r.body);

  console.log('\n8. a new donor, and a donor who is not a lead yet');
  r = await add(ana, { phone: '9000000007', started_at: ago(10), name: 'Ganesh New' });
  const g = (await pool.query(`SELECT phone, name, assigned_to FROM leads WHERE name = 'Ganesh New'`)).rows[0];
  check('a new donor is made, on this number, and is Ana\'s', r.status === 201 && g?.phone === '9000000007' && g.assigned_to === ANA, { r: r.body, g });
  r = await add(ana, { phone: '9000000008', started_at: ago(11), person_id: deepa });
  const d = (await pool.query(`SELECT phone, alt_phone FROM leads WHERE phone = '9811111104'`)).rows[0];
  check('an existing donor with no lead gets one, and the number is hers', r.status === 201 && d?.alt_phone === '9000000008', { r: r.body, d });

  console.log('\n9. who can see what');
  r = await add(ana, { phone: '9000000009', started_at: ago(10), lead_id: chitra });
  check('a colleague\'s donor is not Ana\'s to attach to', r.status === 404, r.body);
  const mine = await req('GET', '/api/unmatched-calls', ana);
  const his = await req('GET', '/api/unmatched-calls', bhavin);
  const all = await req('GET', '/api/unmatched-calls', admin);
  check('Ana sees her calls', mine.body.calls?.length >= 5 && mine.body.calls.every((c: any) => c.user_id === ANA && c.added_by_hand), mine.body.totals);
  check('Bhavin sees none of them', his.body.calls?.length === 0, his.body);
  check('the admin sees all, with the total talk time', all.body.calls?.length === mine.body.calls.length && all.body.totals.talk_seconds > 90, all.body.totals);
  const own = await req('GET', `/api/app/calls/${call1}/recording`, ana);
  check('Ana can play her recording', own.status === 200 && own.raw.length > 1000, own.status);
  check('the admin can play it', (await req('GET', `/api/app/calls/${call1}/recording`, admin)).status === 200);
  check('Bhavin cannot', (await req('GET', `/api/app/calls/${call1}/recording`, bhavin)).status === 403);
  check('each listen is logged', (await pool.query(`SELECT COUNT(*)::int AS n FROM recording_listens WHERE call_id = $1`, [call1])).rows[0].n === 2);

  console.log(failures ? `\n${failures} FAILED` : '\nall green');
  server.close();
  s3.close();
  await pool.end();
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
