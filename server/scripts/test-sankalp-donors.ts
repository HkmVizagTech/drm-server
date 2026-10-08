// Sankalpam from DRM's own donors, the details the sites' forms carry, and the
// calls made to ask a donor for their days.
//
//   DATABASE_URL=postgresql://localhost/drm_test npx tsx scripts/test-sankalp-donors.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import sankalpamRoutes from '../src/routes/sankalpam';
import { upsertDonorSnapshot } from '../src/services/hkmvSync';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use('/api/sankalpam', sankalpamRoutes);

let base = '';
const ADMIN = '11111111-1111-1111-1111-111111111111';
const ANA = '22222222-2222-2222-2222-222222222222';
const ana = { userId: ANA, role: 'caller' };

function req(method: string, path: string, as: { userId: string; role: string }, body?: unknown) {
  const raw = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const headers: Record<string, string | number> = {
    authorization: `Bearer ${generateToken({ userId: as.userId, email: 'x@t', role: as.role } as never)}`,
  };
  if (raw) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = raw.length;
  }
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const r = http.request(`${base}${path}`, { method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d ? JSON.parse(d) : {} }));
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
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 700));
  }
}

let ext = 0;
function snap(mobile: string, name: string, amount: number, extra: Record<string, unknown> = {}, donor: Record<string, unknown> = {}) {
  ext++;
  return {
    donor: { name, mobile, donorSince: '2025-01-01T00:00:00.000Z', ...donor },
    donations: [
      {
        externalId: `sk-${ext}`,
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

const daysOf = async (donorId: string) =>
  (await pool.query(`SELECT occasion, month, day, origin FROM sankalpam_dates WHERE donor_id = $1 ORDER BY month, day`, [donorId])).rows;

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;

  await pool.query(`TRUNCATE sankalpam_calls, sankalpam_sends, sankalpam_dates, sankalpam_donors RESTART IDENTITY CASCADE`);
  await pool.query(`TRUNCATE people, users RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO users (id, name, email, password_hash, role) VALUES ($1,'Admin','a@t','x','admin'), ($2,'Ana','ana@t','x','caller')`, [ADMIN, ANA]);

  console.log('\n1. what the site form carries reaches DRM');
  // As annadan sends it: a birthday booked on the form, for the donor's own birthday.
  await upsertDonorSnapshot(
    snap('9985983840', 'Peddi saisravan', 1251, { occasion: 'Birthday', sevaDate: '2026-10-15', dob: '2026-10-15' }, { dob: '2026-10-15', email: 'x@y.in' }),
    'annadan'
  );
  const p1 = (await pool.query(`SELECT id, to_char(date_of_birth,'YYYY-MM-DD') AS dob FROM people WHERE phone = '9985983840'`)).rows[0];
  check('the date of birth is kept on the person', p1?.dob === '2026-10-15', p1);
  const d1 = (await pool.query(`SELECT occasion, to_char(seva_date,'YYYY-MM-DD') AS sd FROM donations WHERE person_id = $1`, [p1.id])).rows[0];
  check('the occasion and its day are kept on the donation', d1?.occasion === 'Birthday' && d1.sd === '2026-10-15', d1);

  // A bigger donor: anniversary for someone else, own DOB on HKMV.
  await upsertDonorSnapshot(snap('9000000101', 'Ravi Kumar', 10000, { occasion: 'Anniversary', sevaDate: '2026-12-05', sevakName: 'Ravi & Sita' }, { dob: '15-08-1980' }), 'hkmv');
  // Two donations adding up to 6,000, none over 5,000 alone.
  await upsertDonorSnapshot(snap('9000000102', 'Meera', 3000), 'hkmv');
  await upsertDonorSnapshot(snap('9000000102', 'Meera', 3000), 'hkmv');
  // Gave 5,500 once - and is already on the sheet.
  await upsertDonorSnapshot(snap('9000000103', 'Sheet Person', 5500, {}, { dob: '1975-03-09' }), 'hkmv');
  const sheet = (
    await pool.query(
      `INSERT INTO sankalpam_donors (donor_name, phone, source) VALUES ('Sheet Person', '9000000103', 'sheet') RETURNING id`
    )
  ).rows[0].id;
  await pool.query(`INSERT INTO sankalpam_dates (donor_id, occasion, month, day, origin) VALUES ($1, 'Birthday', 3, 9, 'sheet')`, [sheet]);
  // Small donor.
  await upsertDonorSnapshot(snap('9000000104', 'Small Donor', 501), 'hkmv');

  console.log('\n2. who gave above ₹5,000');
  let r = await req('GET', '/api/sankalpam/candidates?min=5000&basis=total', ana);
  check('in total: three donors, one already on the list', r.body.qualifying === 3 && r.body.already === 1 && r.body.to_add === 2, r.body);
  r = await req('GET', '/api/sankalpam/candidates?min=5000&basis=single', ana);
  check('in one donation: two (Meera\'s 6,000 was two donations of 3,000)', r.body.qualifying === 2, r.body);
  check('one of the new ones has days DRM already knows', r.body.with_days === 1, r.body);

  r = await req('POST', '/api/sankalpam/add-donors', ana, { min: 5000, basis: 'total' });
  check('added two', r.status === 200 && r.body.added === 2, r.body);
  const ravi = (await pool.query(`SELECT * FROM sankalpam_donors WHERE phone = '9000000101'`)).rows[0];
  check('marked as from donations', ravi?.source === 'donors' && ravi.person_id, ravi);
  const rd = await daysOf(ravi.id);
  check(
    'with his birthday and the anniversary he booked a seva for',
    JSON.stringify(rd.map((x) => `${x.day}/${x.month} ${x.occasion} ${x.origin}`)) ===
      JSON.stringify(['15/8 Birthday site', '5/12 Ravi & Sita Anniversary site']),
    rd
  );
  const sd = await daysOf(sheet);
  check('the sheet donor keeps their own day, not a second birthday', sd.length === 1 && sd[0].origin === 'sheet', sd);
  const sheetRow = (await pool.query(`SELECT source, person_id FROM sankalpam_donors WHERE id = $1`, [sheet])).rows[0];
  check('and is linked, still marked as from the sheet', sheetRow.source === 'sheet' && !!sheetRow.person_id, sheetRow);
  r = await req('POST', '/api/sankalpam/add-donors', ana, { min: 5000, basis: 'total' });
  check('running it again adds nobody', r.body.added === 0, r.body);

  console.log('\n3. a donor with no days is on the list to ring');
  const meera = (await pool.query(`SELECT id FROM sankalpam_donors WHERE phone = '9000000102'`)).rows[0].id;
  r = await req('GET', '/api/sankalpam/donors?need=days', ana);
  check('Meera needs her days', r.body.donors?.some((d: any) => d.id === meera) && r.body.counts?.need_days >= 1, r.body.counts);
  r = await req('GET', '/api/sankalpam/donors?source=donors', ana);
  check('the "from donations" switch shows only those', r.body.donors?.length === 2 && r.body.counts.donors === 2 && r.body.counts.sheet === 1, r.body.counts);
  check('with what they have given', Number(r.body.donors.find((d: any) => d.id === meera)?.total_given) === 6000);

  console.log('\n4. calling to ask');
  r = await req('POST', `/api/sankalpam/donors/${meera}/calls`, ana, { outcome: 'no_answer' });
  check('logged, and a retry booked in two days', r.status === 201 && new Date(r.body.next_call_at).getTime() > Date.now() + 86400000, r.body);
  r = await req('POST', `/api/sankalpam/donors/${meera}/calls`, ana, { outcome: 'call_back', next_call_at: new Date(Date.now() - 60000).toISOString(), note: 'after 6pm' });
  r = await req('GET', '/api/sankalpam/donors?need=days', ana);
  const m = r.body.donors.find((d: any) => d.id === meera);
  check('the list says how many calls and what came of the last', m?.call_count === 2 && m.last_call_outcome === 'call_back' && m.last_call_note === 'after 6pm' && m.last_caller_name === 'Ana', m);
  check('a callback that is due comes first', r.body.donors[0]?.id === meera, r.body.donors.map((d: any) => d.donor_name));
  r = await req('GET', `/api/sankalpam/donors/${meera}/calls`, ana);
  check('every call is kept', r.body.calls?.length === 2, r.body);

  console.log('\n5. a day the donor fills in later arrives by itself');
  await upsertDonorSnapshot(snap('9000000102', 'Meera', 100, { occasion: 'Birthday', sevaDate: '2027-01-20', sevakName: 'Anu' }, { dob: '1990-06-02' }), 'annadan');
  const md = await daysOf(meera);
  check(
    'her birthday and her daughter\'s birthday are on Sankalpam now',
    JSON.stringify(md.map((x) => `${x.day}/${x.month} ${x.occasion}`)) === JSON.stringify(['20/1 Anu Birthday', '2/6 Birthday']),
    md
  );
  r = await req('GET', '/api/sankalpam/donors?need=days', ana);
  check('and she leaves the list to ring', !r.body.donors.some((d: any) => d.id === meera));
  await upsertDonorSnapshot(snap('9000000102', 'Meera', 100, { occasion: 'Birthday', sevaDate: '2027-01-20', sevakName: 'Anu' }, { dob: '1990-06-02' }), 'annadan');
  check('a second sync adds nothing twice', (await daysOf(meera)).length === 2);
  // An ordinary seva date (not a yearly day) is not added.
  await upsertDonorSnapshot(snap('9000000101', 'Ravi Kumar', 100, { occasion: 'Annadan Seva', sevaDate: '2026-11-11' }), 'hkmv');
  check('a one-off seva date is not made into a yearly day', (await daysOf(ravi.id)).length === 2);

  console.log('\n6. wrong number stops the reminders');
  const small = (await pool.query(`INSERT INTO sankalpam_donors (donor_name, phone) VALUES ('Typo', '9000000999') RETURNING id, source`)).rows[0];
  check('added by hand is marked so', small.source === 'manual', small);
  r = await req('POST', `/api/sankalpam/donors/${small.id}/calls`, ana, { outcome: 'wrong_number' });
  const off = (await pool.query(`SELECT active FROM sankalpam_donors WHERE id = $1`, [small.id])).rows[0];
  check('switched off', off.active === false, off);

  server.close();
  await pool.end();
  console.log(failures ? `\n${failures} FAILED` : '\nall green');
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
