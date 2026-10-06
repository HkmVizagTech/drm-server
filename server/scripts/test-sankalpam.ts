// Sankalpam: special days that repeat every year, and the daily list of
// videos to send.
//
//   DATABASE_URL=postgresql://localhost/drm_test npx tsx scripts/test-sankalpam.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import ExcelJS from 'exceljs';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import sankalpamRoutes, { parseDayMonth, tidyOccasion } from '../src/routes/sankalpam';

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
const ACC = '44444444-4444-4444-4444-444444444444';
const admin = { userId: ADMIN, role: 'admin' };
const ana = { userId: ANA, role: 'caller' };
const acc = { userId: ACC, role: 'accountant' };

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
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600));
  }
}

const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const plus = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const md = (day: string) => ({ month: Number(day.slice(5, 7)), day: Number(day.slice(8, 10)) });
const excelDate = (day: string, year = 1990) => new Date(Date.UTC(year, Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))));

async function sheet(rows: unknown[][], monthTab?: unknown[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Dump');
  ws.addRow(['PatronNumber', 'SevakName', 'DonorName', 'MobileNumber', 'AlternateMobileNumber', 'Preacher',
    'SpecialOcassionDate', 'Shortdate (dd-mon)', 'SpecialOccasion', 'Passport Size Photos', 'Patron Forms', 'Address']);
  rows.forEach((r) => ws.addRow(r));
  if (monthTab) {
    // Like the office's month tabs: no patron number, a Gotram column, the
    // same days with the occasion worded differently.
    const m = wb.addWorksheet('Oct');
    m.addRow(['DonorName', 'MobileNumber', 'Preacher', 'SpecialOcassionDate', 'SpecialOccasion', 'Gotram', 'Spouse', 'Remarks']);
    monthTab.forEach((r) => m.addRow(r));
  }
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

async function seed() {
  await pool.query(`TRUNCATE sankalpam_sends, sankalpam_dates, sankalpam_donors RESTART IDENTITY CASCADE`);
  await pool.query(`TRUNCATE users RESTART IDENTITY CASCADE`);
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role) VALUES
       ($1,'Admin','a@t','x','admin'), ($2,'Ana','ana@t','x','caller'), ($3,'Acc','acc@t','x','accountant')`,
    [ADMIN, ANA, ACC]
  );
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  await seed();
  const today = istToday();

  console.log('\n1. reading dates the way the office writes them');
  check('an Excel date', JSON.stringify(parseDayMonth(new Date(Date.UTC(1998, 0, 16)))) === '{"day":16,"month":1,"year":1998}');
  check('16-01-1998', parseDayMonth('16-01-1998')?.month === 1 && parseDayMonth('16-01-1998')?.day === 16);
  check('16/1 with no year', parseDayMonth('16/1')?.year === null);
  check('16-Jan', parseDayMonth('16-Jan')?.month === 1);
  check('January 16, 1998', parseDayMonth('January 16, 1998')?.day === 16);
  check('NULL and nonsense are no date', parseDayMonth('NULL') === null && parseDayMonth('Jul') === null && parseDayMonth('31-02') === null);
  check('capitals tidied', tidyOccasion('WIFE BIRTHDAY') === 'Wife Birthday' && tidyOccasion("SON'S BIRTHDAY") === "Son's Birthday");

  console.log('\n2. uploading the sheet');
  const rows = [
    // The details-only row the office puts first for each patron.
    ['VSI/000001', 'KOMAKULA MAHESH ', 'MAHESH KOMAKULA ', 9030549785, '9066278930', 'SYMD', 'NULL', '', 'NULL', null, null, 'Kancharapalem'],
    ['VSI/000001', 'KOMAKULA MAHESH ', 'MAHESH KOMAKULA ', 9030549785, '9066278930', 'SYMD', excelDate(today, 1998), '', 'WIFE BIRTHDAY', null, null, 'Kancharapalem'],
    ['VSI/000001', 'KOMAKULA MAHESH ', 'MAHESH KOMAKULA ', 9030549785, '9066278930', 'SYMD', excelDate(plus(today, 1), 1989), '', 'BIRTHDAY', null, null, 'Kancharapalem'],
    ['VSI/000002', 'STEEL CITY', 'STEEL CITY', 9848192422, 'NULL', 'YDRD', excelDate(plus(today, -2), 1950), '', 'BIRTHDAY', null, null, ''],
    ['VSI/000002', 'STEEL CITY', 'STEEL CITY', 9848192422, 'NULL', 'YDRD', excelDate(plus(today, 3), 2010), '', null, null, null, ''],
    ['VSI/000003', 'HUF', 'HUF', 'HUF  ', null, 'JTMD', new Date(Date.UTC(2000, 1, 29)), '', 'LEAP BIRTHDAY', null, null, ''],
    ['VSI/000003', 'HUF', 'HUF', 'HUF  ', null, 'JTMD', '31-12', '', 'YEAR END', null, null, ''],
    ['VSI/000003', 'HUF', 'HUF', 'HUF  ', null, 'JTMD', null, '', 'Jul', null, null, ''],
    // A patron with details and no days yet.
    ['VSI/000004', 'NEW PATRON', 'NEW PATRON', 9000000004, null, 'SYMD', 'NULL', '', 'NULL', null, null, ''],
    // No patron number and no mobile: known by name alone.
    [null, 'NAME ONLY', 'NAME ONLY', null, null, 'SYMD', '04-05-2001', '', 'PARENTS MARRIAGE DAY', null, null, ''],
  ];
  const short = (day: string) => `${day.slice(8, 10)}-${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(day.slice(5, 7)) - 1]}`;
  const tab = [
    // Today again, worded differently: the same day, not a second puja.
    ['MAHESH KOMAKULA', 9030549785, 'SYMD', short(today), 'Lakshmi Wife Birthday', 'Bharadwaja', 'Lakshmi', 'Call before 10'],
    // A day only this tab has.
    ['MAHESH KOMAKULA', 9030549785, 'SYMD', short(plus(today, 5)), 'SON BIRTHDAY', 'Bharadwaja', 'Lakshmi', null],
  ];
  const b64 = await sheet(rows, tab);
  let r = await req('POST', '/api/sankalpam/import', ana, { filename: 'Special Puja Dates.xlsx', base64: b64 });
  check('the check counts donors and dates', r.status === 200 && r.body.donors_new === 5 && r.body.dates_new === 8, r.body);
  check('both tabs read; only the unreadable day is listed', r.body.sheets === 2 && r.body.skipped === 1 && r.body.skipped_rows[0].text.includes('Jul'), r.body);
  check('a patron with no days yet is still counted', r.body.donors_without_dates === 1, r.body);
  check('and the check writes nothing', Number((await pool.query(`SELECT COUNT(*) FROM sankalpam_donors`)).rows[0].count) === 0);
  r = await req('POST', '/api/sankalpam/import', ana, { filename: 'Special Puja Dates.xlsx', base64: b64, apply: true });
  check('applied', r.status === 200 && r.body.applied && r.body.dates_new === 8, r.body);
  const mDays = (await pool.query(`SELECT occasion FROM sankalpam_dates d JOIN sankalpam_donors dn ON dn.id = d.donor_id
                                    WHERE dn.patron_number = 'VSI/000001' ORDER BY occasion`)).rows.map((x) => x.occasion);
  check('the month tab joins the patron by number: one puja per day, plus its new day', JSON.stringify(mDays) === JSON.stringify(['Birthday', 'Son Birthday', 'Wife Birthday']), mDays);
  const mahesh = (await pool.query(`SELECT * FROM sankalpam_donors WHERE patron_number = 'VSI/000001'`)).rows[0];
  check('names tidied, numbers kept', mahesh?.donor_name === 'Mahesh Komakula' && mahesh.phone === '9030549785' && mahesh.alt_phone === '9066278930', mahesh);
  check('gotram and spouse from the month tab', mahesh?.gotram === 'Bharadwaja' && mahesh.notes === 'Spouse: Lakshmi', mahesh);
  const huf = (await pool.query(`SELECT phone FROM sankalpam_donors WHERE patron_number = 'VSI/000003'`)).rows[0];
  check('a "number" that is not one is left empty', huf?.phone === null, huf);
  const unnamed = (await pool.query(`SELECT occasion FROM sankalpam_dates d JOIN sankalpam_donors dn ON dn.id = d.donor_id
                                      WHERE dn.patron_number = 'VSI/000002' AND d.month = $1 AND d.day = $2`, [md(plus(today, 3)).month, md(plus(today, 3)).day])).rows[0];
  check('a day with no occasion is a "Special Day"', unnamed?.occasion === 'Special Day', unnamed);
  r = await req('POST', '/api/sankalpam/import', ana, { filename: 'again.xlsx', base64: b64, apply: true });
  check('uploading the same sheet again adds nothing', r.body.dates_new === 0 && r.body.donors_new === 0 && r.body.dates_existing === 8, r.body);

  console.log('\n3. the day\'s list');
  r = await req('GET', '/api/sankalpam/summary', ana);
  check('a sheet uploaded today has not "missed" last week', r.body.missed === 0 && r.body.today === 1, r.body);
  // As though the sheet had been uploaded a month ago.
  await pool.query(`UPDATE sankalpam_dates SET created_at = NOW() - INTERVAL '30 days'`);
  r = await req('GET', '/api/sankalpam/board', ana);
  const b = r.body;
  check('today, tomorrow, missed and coming', b.counts?.today === 1 && b.counts.tomorrow === 1 && b.counts.missed === 1 && b.counts.later >= 1, b.counts);
  const todays = b.items.find((x: any) => x.due_on === today);
  check('today\'s carries the donor and the year on record', todays?.donor_name === 'Mahesh Komakula' && todays.orig_year === 1998 && todays.status === 'todo', todays);
  r = await req('GET', '/api/sankalpam/summary', ana);
  check('the badge numbers agree', r.body.today === 1 && r.body.missed === 1 && r.body.tomorrow === 1, r.body);

  console.log('\n4. sending, and next year');
  const year = Number(today.slice(0, 4));
  r = await req('PUT', `/api/sankalpam/dates/${todays.date_id}/${year}`, ana, { status: 'ready' });
  check('video ready', r.status === 200);
  r = await req('GET', '/api/sankalpam/summary', ana);
  check('ready is still to send', r.body.today === 1, r.body);
  r = await req('PUT', `/api/sankalpam/dates/${todays.date_id}/${year}`, ana, { status: 'sent' });
  r = await req('GET', '/api/sankalpam/summary', ana);
  check('sent: nothing left today', r.body.today === 0, r.body);
  r = await req('GET', '/api/sankalpam/board', ana);
  const sent = r.body.items.find((x: any) => x.date_id === todays.date_id && x.due_on === today);
  check('it shows as sent, by whom', sent?.status === 'sent' && sent.done_by_name === 'Ana', sent);
  const nextYear = plus(today, 365 + (year % 4 === 3 ? 1 : 0));
  r = await req('GET', `/api/sankalpam/occurrences?from=${plus(nextYear, -2)}&to=${plus(nextYear, 2)}`, ana);
  const again = r.body.items?.find((x: any) => x.date_id === todays.date_id);
  check('it comes round again next year, to do', again?.year === year + 1 && again.status === 'todo', r.body.items);
  r = await req('PUT', `/api/sankalpam/dates/${todays.date_id}/${year}`, ana, { status: 'todo' });
  r = await req('GET', '/api/sankalpam/summary', ana);
  check('undo puts it back', r.body.today === 1, r.body);
  const missed = b.items.find((x: any) => x.due_on < today);
  r = await req('POST', '/api/sankalpam/dates/status', ana, { items: [{ date_id: missed.date_id, year: missed.year }], status: 'skipped' });
  r = await req('GET', '/api/sankalpam/summary', ana);
  check('skipping clears it from missed', r.body.missed === 0, r.body);

  console.log('\n5. the calendar across the year end, and 29 February');
  r = await req('GET', `/api/sankalpam/occurrences?from=2026-12-30&to=2027-01-02`, ana);
  check('31 December found in a window over New Year', r.body.items?.some((x: any) => x.due_on === '2026-12-31' && x.occasion === 'Year End'), r.body.items);
  r = await req('GET', `/api/sankalpam/occurrences?from=2027-02-27&to=2027-03-01`, ana);
  check('29 February falls on the 28th in 2027', r.body.items?.some((x: any) => x.due_on === '2027-02-28' && x.occasion === 'Leap Birthday'), r.body.items);
  r = await req('GET', `/api/sankalpam/occurrences?from=2028-02-27&to=2028-03-01`, ana);
  check('and on the 29th in 2028', r.body.items?.some((x: any) => x.due_on === '2028-02-29'), r.body.items);

  console.log('\n6. adding and changing by hand');
  r = await req('POST', '/api/sankalpam/donors', ana, {
    donor_name: 'Ravi Teja', sevak_name: 'Sita', phone: '+91 98480 11111', preacher: 'symd',
    dates: [{ occasion: 'Birthday', day: 5, month: 8 }, { occasion: 'Anniversary', day: 9, month: 11, orig_year: 2012 }],
  });
  check('added', r.status === 201, r.body);
  const id = r.body.id;
  r = await req('GET', `/api/sankalpam/donors/${id}`, ana);
  check('with both dates, number cleaned, preacher upper-cased', r.body.donor?.dates.length === 2 && r.body.donor.phone === '9848011111' && r.body.donor.preacher === 'SYMD', r.body);
  const keep = r.body.donor.dates.find((d: any) => d.occasion === 'Birthday');
  r = await req('PUT', `/api/sankalpam/donors/${id}`, ana, { donor_name: 'Ravi Teja', phone: '9848011111', dates: [{ ...keep, day: 6 }] });
  r = await req('GET', `/api/sankalpam/donors/${id}`, ana);
  check('a date left out is removed, the other changed', r.body.donor?.dates.length === 1 && r.body.donor.dates[0].day === 6 && r.body.donor.dates[0].id === keep.id, r.body.donor?.dates);
  r = await req('POST', '/api/sankalpam/donors', ana, { donor_name: 'X', dates: [{ occasion: 'Bad', day: 31, month: 2 }] });
  check('an impossible date is refused', r.status === 400, r.body);
  r = await req('POST', '/api/sankalpam/donors', ana, { donor_name: 'Dup', patron_number: 'vsi/000001', dates: [{ occasion: 'B', day: 1, month: 1 }] });
  check('a patron number already here is refused, pointing at them', r.status === 409 && r.body.id === mahesh.id, r.body);
  r = await req('GET', '/api/sankalpam/donors?search=9848011111', ana);
  check('search finds by number', r.body.donors?.length === 1, r.body.donors?.length);
  r = await req('GET', `/api/sankalpam/donors?month=${md(today).month}`, ana);
  check('and by month', r.body.donors?.some((d: any) => d.id === mahesh.id), r.body.donors?.length);

  console.log('\n7. who can');
  r = await req('GET', '/api/sankalpam/board', acc);
  check('an accountant cannot', r.status === 403);
  r = await req('DELETE', `/api/sankalpam/donors/${id}`, ana);
  check('a caller cannot delete', r.status === 403);
  r = await req('PUT', `/api/sankalpam/donors/${id}`, ana, { donor_name: 'Ravi Teja', active: false });
  r = await req('GET', '/api/sankalpam/donors?search=Ravi', ana);
  check('but can switch one off', r.body.donors?.length === 0, r.body.donors);
  r = await req('DELETE', `/api/sankalpam/donors/${id}`, admin);
  check('an admin can delete', r.status === 200, r.body);

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
