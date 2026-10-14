// The phone app: linking a phone, its calls, call-backs and recordings.
//
// The cases are what a caller or an admin would notice:
//   - "my phone stopped saving calls overnight" (the phone's own key, not the 24h login)
//   - "a donor rang me back and DRM never knew" (call-backs counted in history)
//   - "I missed her call and forgot to ring back" (a reminder, which closes itself)
//   - "the call shows 0 minutes though we spoke for ten" (measured talk time on the outcome)
//   - "my personal calls must not go to the office" (only DRM numbers are kept)
//   - "anyone can listen to anyone's calls" (only the caller and admins; every listen logged)
//
//   DATABASE_URL=postgresql://localhost/drm_test npx tsx scripts/test-phone-app.ts

import './test-phone-app.env';
import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import crmRoutes from '../src/routes/crm';
import crmCallsRoutes from '../src/routes/crmCalls';
import phoneAppRoutes from '../src/routes/phoneApp';
import { linkPhoneCalls } from '../src/services/phoneCalls';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

// A stand-in for R2: keeps PUT bodies in memory and hands them back on GET.
const objects = new Map<string, Buffer>();
const s3 = http.createServer((rq, rs) => {
  const chunks: Buffer[] = [];
  rq.on('data', (c) => chunks.push(c));
  rq.on('end', () => {
    const path = decodeURIComponent((rq.url ?? '').split('?')[0]);
    if (rq.method === 'PUT') {
      objects.set(path, Buffer.concat(chunks));
      rs.writeHead(200, { ETag: '"x"' }).end();
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
app.use('/api/crm', crmCallsRoutes);
app.use('/api/app', phoneAppRoutes);

let base = '';
const ADMIN = '11111111-1111-1111-1111-111111111111';
const ANA = '22222222-2222-2222-2222-222222222222';
const BHAVIN = '33333333-3333-3333-3333-333333333333';
type As = { userId: string; role: string } | { key: string } | null;
const admin = { userId: ADMIN, role: 'admin' };
const ana = { userId: ANA, role: 'caller' };
const bhavin = { userId: BHAVIN, role: 'caller' };

function req(method: string, path: string, as: As, body?: unknown, extra: Record<string, string> = {}) {
  const raw = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const headers: Record<string, string | number> = { ...extra };
  if (as && 'userId' in as) headers.authorization = `Bearer ${generateToken({ userId: as.userId, role: as.role } as never)}`;
  if (as && 'key' in as) headers['x-device-key'] = as.key;
  if (raw) {
    if (!headers['content-type']) headers['content-type'] = 'application/json';
    headers['content-length'] = raw.length;
  }
  return new Promise<{ status: number; body: any; raw: Buffer; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
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
        resolve({ status: res.statusCode ?? 0, body: parsed, raw: buf, headers: res.headers });
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

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

async function seed() {
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
}

async function main() {
  await new Promise<void>((r) => s3.listen(Number(process.env.FAKE_S3_PORT ?? 4599), '127.0.0.1', () => r()));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  await seed();

  const asha = (await pool.query(`INSERT INTO leads (phone, name, assigned_to) VALUES ('9811111101','Asha Rao',$1) RETURNING id`, [ANA])).rows[0].id;
  const bala = (await pool.query(`INSERT INTO leads (phone, name, alt_phone) VALUES ('9811111102','Bala','+91 98111 99999') RETURNING id`)).rows[0].id;
  const chitra = (await pool.query(`INSERT INTO leads (phone, name, assigned_to) VALUES ('9811111103','Chitra',$1) RETURNING id`, [BHAVIN])).rows[0].id;

  console.log('\n1. linking a phone');
  const link = await req('POST', '/api/app/devices', ana, { install_id: 'ana-phone-1', manufacturer: 'samsung', model: 'SM-A146B', android_version: '15', app_version: '1.0.0', dialer: 'com.samsung.android.dialer' });
  check('the phone gets a key', link.status === 200 && typeof link.body.device_key === 'string' && link.body.device_key.length === 64, link.body);
  const phone = { key: link.body.device_key as string };
  const stranger = await req('GET', '/api/app/numbers', { key: 'f'.repeat(64) });
  check('a made-up key is refused', stranger.status === 401, stranger.body);
  const noLogin = await req('POST', '/api/app/devices', null, { install_id: 'x-phone-123' });
  check('linking needs a login', noLogin.status === 401, noLogin.status);

  console.log('\n2. which numbers the phone reports');
  await req('POST', `/api/crm/leads/${bala}/call`, ana, { disposition: 'busy' });
  const nums = await req('GET', '/api/app/numbers', phone);
  const set = new Set<string>(nums.body.numbers ?? []);
  check("her own lead's number", set.has('9811111101'), nums.body);
  check('someone she has called, and their other number', set.has('9811111102') && set.has('9811199999'), nums.body);
  check("not a colleague's lead she never rang", !set.has('9811111103'), nums.body);

  console.log('\n3. a call she made: phone first, outcome after');
  const r1 = await req('POST', '/api/app/calls', phone, {
    calls: [
      { key: '101-a', type: 2, phone: '+91 98111 11101', started_at: ago(12), duration_seconds: 245, from_app: true, lead_id: asha },
      { key: '102-a', type: 2, phone: '9000000001', started_at: ago(11), duration_seconds: 30 },
      { key: '103-a', type: 4, phone: '9811111101', started_at: ago(10), duration_seconds: 0 },
    ],
  });
  const [made, personal, voicemail] = r1.body.results ?? [];
  check('the call to her lead is kept and wants its recording', made?.id && made.want_recording === true, r1.body);
  check('a personal number is not kept', personal?.id === null, personal);
  check('a voicemail entry is not a call', voicemail?.id === null, voicemail);
  const notKept = await pool.query(`SELECT COUNT(*)::int AS n FROM phone_calls WHERE phone = '9000000001'`);
  check('nothing about the personal call is stored', notKept.rows[0].n === 0, notKept.rows[0]);
  await req('POST', `/api/crm/leads/${asha}/call`, ana, { disposition: 'interested', duration_seconds: 60 });
  await linkPhoneCalls();
  const tied = await pool.query(
    `SELECT a.duration_seconds, a.source, pc.activity_id IS NOT NULL AS linked
       FROM phone_calls pc JOIN lead_activities a ON a.id = pc.activity_id WHERE pc.id = $1`,
    [made.id]
  );
  check('the outcome is tied to the phone call', tied.rows[0]?.linked === true, tied.rows);
  check('it shows the measured talk time, not the typed one', tied.rows[0]?.duration_seconds === 245 && tied.rows[0]?.source === 'phone', tied.rows[0]);

  console.log('\n4. reported twice, saved once');
  const again = await req('POST', '/api/app/calls', phone, {
    calls: [{ key: '101-a', type: 2, phone: '9811111101', started_at: ago(12), duration_seconds: 245 }],
  });
  const n101 = await pool.query(`SELECT COUNT(*)::int AS n FROM phone_calls WHERE call_key = '101-a'`);
  check('one row, same id', n101.rows[0].n === 1 && again.body.results?.[0]?.id === made.id, again.body);

  console.log('\n5. outcome first, phone after');
  await req('POST', `/api/crm/leads/${bala}/call`, ana, { disposition: 'no_answer' });
  const r2 = await req('POST', '/api/app/calls', phone, {
    calls: [{ key: '104-a', type: 2, phone: '9811111102', started_at: ago(1), duration_seconds: 0 }],
  });
  const b2 = await pool.query(`SELECT recording_status, activity_id FROM phone_calls WHERE id = $1`, [r2.body.results[0].id]);
  check('linked during the sync itself', !!b2.rows[0].activity_id, b2.rows[0]);
  check('nobody spoke, so no recording is asked for', b2.rows[0].recording_status === 'not_needed' && r2.body.results[0].want_recording === false, b2.rows[0]);

  console.log('\n6. the donor rang back');
  const r3 = await req('POST', '/api/app/calls', phone, {
    calls: [{ key: '105-a', type: 1, phone: '9811111101', started_at: ago(5), duration_seconds: 380 }],
  });
  const back = await pool.query(
    `SELECT a.direction, a.connected, a.duration_seconds, a.source, a.user_id FROM phone_calls pc
       JOIN lead_activities a ON a.id = pc.activity_id WHERE pc.id = $1`,
    [r3.body.results[0].id]
  );
  check('it is in her history as "they rang", answered', back.rows[0]?.direction === 'inbound' && back.rows[0]?.connected === true && back.rows[0]?.duration_seconds === 380, back.rows[0]);
  check('it counts as Ana\'s call', back.rows[0]?.user_id === ANA, back.rows[0]);
  const log = await req('GET', '/api/crm/calls?direction=inbound', ana);
  check('it shows in My calls under "They rang"', log.body.calls?.some((c: any) => c.lead_id === asha && c.direction === 'inbound'), log.body);

  console.log('\n7. a call-back that was missed');
  const r4 = await req('POST', '/api/app/calls', phone, {
    calls: [{ key: '106-a', type: 3, phone: '9811199999', started_at: ago(3), duration_seconds: 0 }],
  });
  const missed = await pool.query(
    `SELECT a.direction, a.connected FROM phone_calls pc JOIN lead_activities a ON a.id = pc.activity_id WHERE pc.id = $1`,
    [r4.body.results[0].id]
  );
  check('missed, on the lead whose other number rang', missed.rows[0]?.direction === 'missed' && missed.rows[0]?.connected === false, missed.rows);
  const rem = await pool.query(`SELECT status, assigned_to, title FROM lead_reminders WHERE lead_id = $1 AND occasion = 'Missed call'`, [bala]);
  check('a ring-back reminder for Ana', rem.rows.length === 1 && rem.rows[0].status === 'open' && rem.rows[0].assigned_to === ANA, rem.rows);
  await req('POST', '/api/app/calls', phone, {
    calls: [{ key: '107-a', type: 3, phone: '9811111102', started_at: ago(2), duration_seconds: 0 }],
  });
  const rem2 = await pool.query(`SELECT COUNT(*)::int AS n FROM lead_reminders WHERE lead_id = $1 AND occasion = 'Missed call'`, [bala]);
  check('a second missed call does not pile on another reminder', rem2.rows[0].n === 1, rem2.rows[0]);
  await req('POST', '/api/app/calls', phone, {
    calls: [{ key: '108-a', type: 2, phone: '9811111102', started_at: ago(0.5), duration_seconds: 90 }],
  });
  const rem3 = await pool.query(`SELECT status FROM lead_reminders WHERE lead_id = $1 AND occasion = 'Missed call'`, [bala]);
  check('once they have spoken, the reminder closes itself', rem3.rows[0]?.status === 'done', rem3.rows);

  console.log('\n8. "they rang" logged by hand, then reported by the phone');
  const hand = await req('POST', `/api/crm/leads/${asha}/call`, ana, { disposition: 'interested', direction: 'inbound' });
  check('logged by hand', hand.status === 201 || hand.status === 200, hand.body);
  const before = await pool.query(`SELECT COUNT(*)::int AS n FROM lead_activities WHERE lead_id = $1 AND direction = 'inbound'`, [asha]);
  await req('POST', '/api/app/calls', phone, {
    calls: [{ key: '109-a', type: 1, phone: '9811111101', started_at: ago(0.2), duration_seconds: 75 }],
  });
  const after = await pool.query(`SELECT COUNT(*)::int AS n FROM lead_activities WHERE lead_id = $1 AND direction = 'inbound'`, [asha]);
  check('the same call is not counted twice', after.rows[0].n === before.rows[0].n, [before.rows[0], after.rows[0]]);

  console.log('\n9. recordings');
  const audio = Buffer.concat([Buffer.from('ftypM4A '), Buffer.alloc(4000, 7)]);
  const up = await req('POST', `/api/app/calls/${made.id}/recording`, phone, audio, {
    'content-type': 'audio/mp4',
    'x-file-name': encodeURIComponent('Asha Rao_98111 11101.m4a'),
    'x-file-folder': 'Recordings/Call',
  });
  check('uploaded', up.status === 200 && up.body.ok === true, up.body);
  const rec = await pool.query(
    `SELECT pc.recording_status, pc.recording_key, a.recording_url FROM phone_calls pc
       JOIN lead_activities a ON a.id = pc.activity_id WHERE pc.id = $1`,
    [made.id]
  );
  check('kept by month, and the outcome links to it', rec.rows[0]?.recording_status === 'uploaded' && /^recordings\/\d{4}\/\d{2}\/.+\.m4a$/.test(rec.rows[0]?.recording_key) && rec.rows[0]?.recording_url === `/api/app/calls/${made.id}/recording`, rec.rows[0]);
  const otherPhone = await req('POST', '/api/app/devices', bhavin, { install_id: 'bhavin-phone-1', model: 'Redmi' });
  const wrongPhone = await req('POST', `/api/app/calls/${made.id}/recording`, { key: otherPhone.body.device_key }, audio, { 'content-type': 'audio/mp4' });
  check("another phone cannot upload over Ana's call", wrongPhone.status === 404, wrongPhone.body);
  const play = await req('GET', `/api/app/calls/${made.id}/recording`, ana);
  check('Ana can play her call', play.status === 200 && play.raw.equals(audio) && play.headers['content-type'] === 'audio/mp4', [play.status, play.headers['content-type'], play.raw.length]);
  const seek = await req('GET', `/api/app/calls/${made.id}/recording`, admin, undefined, { range: 'bytes=100-199' });
  check('seeking works (part of the file)', seek.status === 206 && seek.raw.length === 100 && seek.raw.equals(audio.subarray(100, 200)), [seek.status, seek.raw.length]);
  const peek = await req('GET', `/api/app/calls/${made.id}/recording`, bhavin);
  check("Bhavin cannot play Ana's call", peek.status === 403, peek.body);
  const listens = await pool.query(`SELECT user_id FROM recording_listens WHERE call_id = $1`, [made.id]);
  check('each listen is logged (a seek is not a new listen)', listens.rows.length === 1 && listens.rows[0].user_id === ANA, listens.rows);
  await req('GET', `/api/app/calls/${made.id}/recording`, admin);
  const listens2 = await pool.query(`SELECT COUNT(*)::int AS n FROM recording_listens WHERE call_id = $1`, [made.id]);
  check("the admin's listen is logged too", listens2.rows[0].n === 2, listens2.rows[0]);
  const none = await req('POST', `/api/app/calls/${r3.body.results[0].id}/no-recording`, phone);
  const noneRow = await pool.query(`SELECT recording_status FROM phone_calls WHERE id = $1`, [r3.body.results[0].id]);
  check('"looked, none found" is saved', none.status === 200 && noneRow.rows[0].recording_status === 'none', noneRow.rows[0]);
  const late = await pool.query(`SELECT recording_url FROM lead_activities a JOIN phone_calls pc ON pc.activity_id = a.id WHERE pc.id = $1`, [made.id]);
  check('the play link survives a later relink pass', late.rows[0]?.recording_url === `/api/app/calls/${made.id}/recording`, late.rows);

  console.log('\n10. the lead page and the Phones page');
  const leadCalls = await req('GET', `/api/app/leads/${asha}/calls`, ana);
  check("the lead lists the phone's calls, with who may listen", leadCalls.body.calls?.length >= 3 && leadCalls.body.calls.some((c: any) => c.id === made.id && c.can_listen === true), leadCalls.body);
  const leadCallsB = await req('GET', `/api/app/leads/${asha}/calls`, bhavin);
  check("but a colleague sees no play button on Ana's calls", leadCallsB.body.calls?.every((c: any) => c.can_listen === false), leadCallsB.body);
  await req('POST', '/api/app/status', phone, { status: { call_log: true, recordings: true, all_files: false }, app_version: '1.0.1' });
  const devs = await req('GET', '/api/app/devices', admin);
  const d = devs.body.devices?.find((x: any) => x.user_id === ANA);
  check('the Phones page shows her phone and its week', d && d.model === 'SM-A146B' && d.outbound >= 3 && d.inbound >= 2 && d.missed >= 2 && d.recorded === 1 && d.recordings_folder === 'Recordings/Call' && d.app_version === '1.0.1', d);
  const callerDevs = await req('GET', '/api/app/devices', ana);
  check('a caller cannot open the Phones page', callerDevs.status === 403, callerDevs.status);

  console.log('\n11. signing a phone out');
  const off = await req('DELETE', `/api/app/devices/${link.body.device_id}`, admin);
  const dead = await req('GET', '/api/app/numbers', phone);
  check('its key stops working at once', off.status === 200 && dead.status === 401, [off.status, dead.status]);
  const relink = await req('POST', '/api/app/devices', ana, { install_id: 'ana-phone-1', model: 'SM-A146B' });
  const alive = await req('GET', '/api/app/numbers', { key: relink.body.device_key });
  check('opening DRM in the app links it again, same phone', relink.body.device_id === link.body.device_id && alive.status === 200, [relink.body, alive.status]);
  await pool.query(`UPDATE users SET active = FALSE WHERE id = $1`, [ANA]);
  const gone = await req('GET', '/api/app/numbers', { key: relink.body.device_key });
  check("a deactivated caller's phone stops syncing", gone.status === 401, gone.status);

  server.close();
  s3.close();
  await pool.end();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
