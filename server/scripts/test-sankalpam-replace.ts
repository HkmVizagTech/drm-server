// "The office sent a corrected Sankalpam sheet. Delete the old data and put
// the correct one in." - Upload, Replace with this sheet.
//
//   DATABASE_URL=postgresql://localhost/drm_test npx tsx scripts/test-sankalpam-replace.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import ExcelJS from 'exceljs';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import sankalpamRoutes from '../src/routes/sankalpam';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api/sankalpam', sankalpamRoutes);
let base = '';
const ADMIN = '11111111-1111-1111-1111-111111111111';
const CALLER = '22222222-2222-2222-2222-222222222222';
const tok = (id: string, role: string) => generateToken({ userId: id, email: 'x@t', role } as never);

function post(path: string, body: unknown, role = 'admin'): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(`${base}${path}`);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { authorization: `Bearer ${tok(role === 'admin' ? ADMIN : CALLER, role)}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(d || '{}') }));
      }
    );
    r.on('error', reject);
    r.end(data);
  });
}

let failures = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}`, ok ? '' : JSON.stringify(d)?.slice(0, 500));
  if (!ok) failures++;
};

const HEAD = ['PatronNumber', 'DonorName', 'MobileNumber', 'SpecialOcassionDate', 'SpecialOccasion', 'Address'];
async function sheet(rows: (string | null)[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Dump');
  ws.addRow(HEAD);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

const days = async (patron: string) =>
  (
    await pool.query(
      `SELECT d.month, d.day, d.occasion, d.origin FROM sankalpam_dates d JOIN sankalpam_donors s ON s.id = d.donor_id
        WHERE upper(s.patron_number) = $1 ORDER BY d.month, d.day, d.occasion`,
      [patron]
    )
  ).rows.map((r) => `${r.day}/${r.month} ${r.occasion}${r.origin === 'sheet' ? '' : ' (' + r.origin + ')'}`);

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  await pool.query(`TRUNCATE sankalpam_calls, sankalpam_sends, sankalpam_dates, sankalpam_donors, users RESTART IDENTITY CASCADE`);
  await pool.query(`INSERT INTO users (id, name, email, password_hash, role) VALUES ($1,'Admin','a@t','x','admin'), ($2,'Caller','c@t','x','caller')`, [ADMIN, CALLER]);

  console.log('\n1. the old sheet, with mistakes, as it was uploaded months ago');
  const old = await sheet([
    ['VSI/001', 'Ramesh Kumar', '9848000001', '05-03-1980', 'Birthday', 'Old address'],
    ['VSI/001', 'Ramesh Kumar', '9848000001', '12-07-2005', 'Anniversary', null], // wrong: should be 21-07
    ['VSI/002', 'Lakshmi Devi', '9848000002', '01-01-1990', 'BIRTHDAY', null], // same day, reworded later
    ['VSI/003', 'Suresh Rao', '9848000003', '10-10-1970', 'Birthday', null], // not in the new sheet
    ['VSI/004', 'Anitha', '9848000004', '02-02-1995', 'Birthday', null],
  ]);
  const a = await post('/api/sankalpam/import', { filename: 'old.xlsx', base64: old, apply: true });
  check('old sheet in', a.status === 200 && a.donors_new === 4 && a.dates_new === 5, a);
  // A caller added a day by hand, and a puja was already marked sent on a correct day.
  const d1 = (await pool.query(`SELECT id FROM sankalpam_donors WHERE patron_number = 'VSI/001'`)).rows[0].id;
  await pool.query(`INSERT INTO sankalpam_dates (donor_id, occasion, month, day, origin) VALUES ($1, 'Grandson Birthday', 9, 9, 'manual')`, [d1]);
  const bday = (await pool.query(`SELECT id FROM sankalpam_dates WHERE donor_id = $1 AND month = 3 AND day = 5`, [d1])).rows[0].id;
  await pool.query(`INSERT INTO sankalpam_sends (date_id, year, status) VALUES ($1, 2026, 'sent')`, [bday]);
  const hand = (await pool.query(
    `INSERT INTO sankalpam_donors (donor_name, phone, source) VALUES ('Walk-in Donor', '9848000099', 'manual') RETURNING id`
  )).rows[0].id;
  await pool.query(`INSERT INTO sankalpam_dates (donor_id, occasion, month, day, origin) VALUES ($1, 'Birthday', 4, 4, 'manual')`, [hand]);

  console.log('\n2. the corrected sheet: preview first');
  const fixed = await sheet([
    ['VSI/001', 'Ramesh Kumar', '9848000001', '05-03-1980', 'Birthday', 'New address, MVP Colony'],
    ['VSI/001', 'Ramesh Kumar', '9848000001', '21-07-2005', 'Anniversary', null],
    ['VSI/002', 'Lakshmi Devi', '9848000002', '01-01-1990', 'Birthday', null],
    ['VSI/002', 'Lakshmi Devi', '9848000002', '01-01-2015', 'Son Birthday', null], // two on one day
    ['VSI/004', 'Anitha', '9848000004', '20-02-1995', 'Birthday', null], // date corrected
    ['VSI/005', 'New Patron', '9848000005', '15-08-1960', 'Birthday', null],
  ]);
  check('a caller cannot replace', (await post('/api/sankalpam/import', { filename: 'fixed.xlsx', base64: fixed, mode: 'replace' }, 'caller')).status === 403);
  const pv = await post('/api/sankalpam/import', { filename: 'fixed.xlsx', base64: fixed, mode: 'replace' });
  check('preview: 4 days added (21/7, Son Birthday, 20/2, the new patron), 2 removed (12/7, 2/2)', pv.dates_new === 4 && pv.dates_removed === 2, pv);
  check('preview: 1 new donor, 1 switched off (Suresh)', pv.donors_new === 1 && pv.donors_switched_off === 1 && pv.switched_off[0] === 'Suresh Rao', pv);
  check('preview lists what goes', pv.removed_dates.some((r: any) => r.month === 7 && r.day === 12) && pv.removed_dates.some((r: any) => r.month === 2 && r.day === 2), pv.removed_dates);
  check('preview changes nothing', (await days('VSI/001')).includes('12/7 Anniversary'));

  console.log('\n3. replace');
  const r = await post('/api/sankalpam/import', { filename: 'fixed.xlsx', base64: fixed, mode: 'replace', apply: true });
  check('done', r.status === 200 && r.applied === true, r);
  const ramesh = await days('VSI/001');
  check('the wrong anniversary is gone, the right one is in', !ramesh.includes('12/7 Anniversary') && ramesh.includes('21/7 Anniversary'), ramesh);
  check("the day a caller added by hand stays", ramesh.includes('9/9 Grandson Birthday (manual)'), ramesh);
  const sent = (await pool.query(`SELECT COUNT(*)::int AS n FROM sankalpam_sends WHERE date_id = $1`, [bday])).rows[0].n;
  check('a correct day keeps its "sent" tick', sent === 1, { sent });
  const addr = (await pool.query(`SELECT address FROM sankalpam_donors WHERE patron_number = 'VSI/001'`)).rows[0].address;
  check("the donor's details come from the new sheet", addr === 'New address, MVP Colony', addr);
  const lakshmi = await days('VSI/002');
  check('a reworded day is kept once, in the new wording, and the second occasion added', lakshmi.length === 2 && lakshmi.includes('1/1 Birthday') && lakshmi.includes('1/1 Son Birthday'), lakshmi);
  check('a corrected date replaces the wrong one', JSON.stringify(await days('VSI/004')) === JSON.stringify(['20/2 Birthday']), await days('VSI/004'));
  const suresh = (await pool.query(`SELECT active FROM sankalpam_donors WHERE patron_number = 'VSI/003'`)).rows[0];
  check('a donor not in the new sheet is switched off, not deleted', suresh && suresh.active === false, suresh);
  check('their days are still there if switched back on', (await days('VSI/003')).length === 1);
  const walk = (await pool.query(`SELECT active FROM sankalpam_donors WHERE id = $1`, [hand])).rows[0];
  check('a donor added by hand is left alone', walk.active === true);
  check('the new patron is in', (await days('VSI/005')).includes('15/8 Birthday'));

  console.log('\n4. the same sheet again changes nothing');
  const again = await post('/api/sankalpam/import', { filename: 'fixed.xlsx', base64: fixed, mode: 'replace' });
  check('nothing to add, remove or switch off', again.dates_new === 0 && again.dates_removed === 0 && again.donors_switched_off === 0 && again.donors_new === 0, again);

  console.log('\n5. a switched-off donor who comes back in a later sheet is switched on');
  const back = await sheet([...[
    ['VSI/001', 'Ramesh Kumar', '9848000001', '05-03-1980', 'Birthday', null],
    ['VSI/001', 'Ramesh Kumar', '9848000001', '21-07-2005', 'Anniversary', null],
    ['VSI/002', 'Lakshmi Devi', '9848000002', '01-01-1990', 'Birthday', null],
    ['VSI/002', 'Lakshmi Devi', '9848000002', '01-01-2015', 'Son Birthday', null],
    ['VSI/003', 'Suresh Rao', '9848000003', '10-10-1970', 'Birthday', null],
    ['VSI/004', 'Anitha', '9848000004', '20-02-1995', 'Birthday', null],
    ['VSI/005', 'New Patron', '9848000005', '15-08-1960', 'Birthday', null],
  ]]);
  const b2 = await post('/api/sankalpam/import', { filename: 'back.xlsx', base64: back, mode: 'replace', apply: true });
  check('switched back on', b2.donors_switched_on === 1 && (await pool.query(`SELECT active FROM sankalpam_donors WHERE patron_number = 'VSI/003'`)).rows[0].active === true, b2);

  console.log('\n6. guard rails');
  const empty = await sheet([]);
  const e = await post('/api/sankalpam/import', { filename: 'empty.xlsx', base64: empty, mode: 'replace', apply: true });
  check('an empty sheet replaces nothing', e.status === 400, e);
  const add = await post('/api/sankalpam/import', { filename: 'old.xlsx', base64: old });
  check('plain Add still only adds', add.mode === 'add' && add.dates_removed === 0 && add.donors_switched_off === 0, add);

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
