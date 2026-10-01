// Two promises this product now makes, asked of the real code.
//
// ONE: every date is an Indian date.
// A UTC day runs 05:30 IST to 05:30 IST, so for the first five and a half
// hours of every morning a UTC-bucketed "today" is yesterday. That is not a
// bug you notice - the figure is plausible, it is just wrong, and it is wrong
// in the quiet hours when nobody is looking. So it is tested at the boundary
// rather than at noon, because at noon both answers agree and the test proves
// nothing.
//
// TWO: a download contains exactly what the screen shows, and never more.
// An export that ignores a filter sends somebody off to act on the wrong
// rows. An export that ignores a role hands a caller the whole donor base in
// a file. Both are asked here of the real routers with the real guards.
//
//   DATABASE_URL=postgresql://localhost/drm_test npx tsx scripts/test-time-and-exports.ts

import '../src/bootTimezone';
import { istDate, istMidnight, parseDate, APP_TIMEZONE } from '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool, { verifyTimezone } from '../src/db/pool';
import { generateToken, readOnlyFor, denyRole } from '../src/middleware/auth';
import peopleRoutes from '../src/routes/people';
import donationsRoutes from '../src/routes/donations';
import subscriptionsRoutes from '../src/routes/subscriptions';
import crmRoutes from '../src/routes/crm';
import crmQrRoutes from '../src/routes/crmQr';
import crmReportsRoutes from '../src/routes/crmReports';
import crmRemindersRoutes from '../src/routes/crmReminders';
import { toCsv, toXlsx, displayValue } from '../src/utils/export';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

const app = express();
app.use(express.json());
// Mirrors index.ts. If that file's mounting changes, this notices.
app.use('/api/people', readOnlyFor('caller'), peopleRoutes);
app.use('/api/donations', readOnlyFor('caller'), donationsRoutes);
app.use('/api/subscriptions', denyRole('caller'), subscriptionsRoutes);
app.use('/api/crm', crmRoutes);
app.use('/api/crm', crmQrRoutes);
app.use('/api/crm', crmReportsRoutes);
app.use('/api/crm', crmRemindersRoutes);

let base = '';
const ADMIN = '11111111-1111-1111-1111-111111111111';
const CALLER = '22222222-2222-2222-2222-222222222222';

function req(
  method: string,
  path: string,
  as: { userId: string; role: string } | null
): Promise<{ status: number; body: any; text: string; headers: http.IncomingHttpHeaders }> {
  const headers: Record<string, string> = {};
  if (as) {
    headers.authorization = `Bearer ${generateToken({ userId: as.userId, email: 'x@t', role: as.role } as never)}`;
  }
  return new Promise((resolve, reject) => {
    const r = http.request(`${base}${path}`, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let body: any = {};
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          body = text;
        }
        resolve({ status: res.statusCode ?? 0, body, text, headers: res.headers });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400));
  }
}

/** Rows of a CSV, ignoring the BOM and the leading comment lines. */
function csvRows(text: string): string[][] {
  return text
    .replace(/^﻿/, '')
    .split('\r\n')
    .filter((l) => l && !l.startsWith('"#') && !l.startsWith('#'))
    .map((l) => l.split(','));
}

async function seed() {
  await pool.query(
    `TRUNCATE qr_payments, qr_shares, razorpay_qrs, lead_activities, lead_reminders,
              leads, subscriptions, donations, people, users RESTART IDENTITY CASCADE`
  );
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role) VALUES
       ($1,'Admin','a@t','x','admin'), ($2,'Ana','ana@t','x','caller')`,
    [ADMIN, CALLER]
  );

  const today = istDate();
  const people: string[] = [];
  for (const [name, phone] of [
    ['Ramesh', '9848012345'],
    ['Sita', '9848012346'],
    ['Gopal', '9848012347'],
  ] as const) {
    const p = await pool.query(
      `INSERT INTO people (name, phone, email, pan) VALUES ($1,$2,$3,'ABCDE1234F') RETURNING id`,
      [name, phone, `${name.toLowerCase()}@t`]
    );
    people.push(p.rows[0].id);
  }

  // THE ROW THE WHOLE TIMEZONE QUESTION TURNS ON.
  // 00:30 IST today, which is 19:00 UTC yesterday. Counted as a UTC day it
  // belongs to yesterday; counted as an Indian day it is today's money.
  await pool.query(
    `INSERT INTO donations (person_id, amount, purpose, payment_mode, source_site, external_ref, created_at)
     VALUES ($1::uuid, 1100, 'general', 'upi', 'hkmv', 'ext_early', $2::timestamptz)`,
    [people[0], `${today}T00:30:00+05:30`]
  );
  // Mid-afternoon today: unambiguous in either zone, so it anchors the count.
  await pool.query(
    `INSERT INTO donations (person_id, amount, purpose, payment_mode, source_site, external_ref, created_at)
     VALUES ($1::uuid, 5000, 'general', 'upi', 'hkmv', 'ext_noon', $2::timestamptz)`,
    [people[1], `${today}T15:00:00+05:30`]
  );
  // 23:30 IST today = 18:00 UTC today. A UTC day would also hold this one, so
  // it is the control that stops a wrong fix looking right.
  await pool.query(
    `INSERT INTO donations (person_id, amount, purpose, payment_mode, source_site, external_ref, created_at)
     VALUES ($1::uuid, 300, 'general', 'upi', 'hkmv', 'ext_late', $2::timestamptz)`,
    [people[2], `${today}T23:30:00+05:30`]
  );

  await pool.query(
    `INSERT INTO people (name, phone, date_of_birth) VALUES ('Birthday Person','9848099999', DATE '1985-03-12')`
  );

  return people;
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  const people = await seed();

  const caller = { userId: CALLER, role: 'caller' };
  const admin = { userId: ADMIN, role: 'admin' };
  const today = istDate();

  /* ------------------------------------------------------------- the clock */

  console.log('\n1. the process and the database both run on Indian time');
  check('process TZ is Asia/Kolkata', process.env.TZ === APP_TIMEZONE, process.env.TZ);
  const tz = await verifyTimezone();
  check('the database session agrees', tz.ok, tz.actual);

  console.log('\n2. a day begins at midnight in India, not at 05:30');
  const trunc = await pool.query(
    `SELECT date_trunc('day', TIMESTAMPTZ '2026-10-01 02:00:00+05:30')::date::text AS d`
  );
  check('2am on the 1st truncates to the 1st', trunc.rows[0].d === '2026-10-01', trunc.rows[0]);
  const cur = await pool.query(`SELECT CURRENT_DATE::text AS d`);
  check("CURRENT_DATE is India's date", cur.rows[0].d === today, { got: cur.rows[0].d, want: today });

  console.log('\n3. a wall-clock hour is read in India, not in UTC');
  // The reports screen prints this straight to the user as "best around 4:00".
  // Read in UTC a 10am call reports as hour 4, and because the offset is
  // thirty minutes as well as five hours it also smears every real hour
  // across two buckets and flattens the peak the chart exists to find.
  const hr = await pool.query(
    `SELECT EXTRACT(HOUR FROM TIMESTAMPTZ '2026-10-01 10:00:00+05:30' AT TIME ZONE '${APP_TIMEZONE}')::int AS h`
  );
  check('10am IST is hour 10', hr.rows[0].h === 10, hr.rows[0]);

  console.log('\n4. a bare date from a date picker means midnight in India');
  check(
    'parseDate("2026-10-15") is 18:30Z the day before',
    parseDate('2026-10-15') === '2026-10-14T18:30:00.000Z',
    parseDate('2026-10-15')
  );
  check(
    'istMidnight(0) lands on 18:30Z',
    istMidnight(0).toISOString().endsWith('18:30:00.000Z'),
    istMidnight(0).toISOString()
  );

  console.log("\n5. a DATE column does not move when the clock does");
  // date_of_birth is a DATE: no time, no zone. node-pg parses one into a JS
  // Date at process-local midnight, so with the process on IST every birthday
  // in the product would render a day early unless the raw string is kept.
  const dob = await pool.query(`SELECT date_of_birth FROM people WHERE phone = '9848099999'`);
  check(
    '12 March 1985 comes back as 1985-03-12',
    dob.rows[0].date_of_birth === '1985-03-12',
    dob.rows[0].date_of_birth
  );

  console.log("\n6. money given at 00:30 IST counts as today's money");
  let r = await req('GET', '/api/crm/dashboard?preset=today', admin);
  check('the dashboard answers', r.status === 200, r.body);
  // The three donations are all today in IST. Under a UTC day the 00:30 one
  // would be missing and the total would read 5,300 instead of 6,400.
  r = await req(
    'GET',
    `/api/donations?from_date=${today}&to_date=${today}&limit=50`,
    admin
  );
  check('all three of today\'s donations are in range', (r.body.donations ?? []).length === 3, {
    count: (r.body.donations ?? []).length,
    refs: (r.body.donations ?? []).map((d: any) => d.external_ref),
  });

  console.log('\n7. picking one day as both ends includes that whole day');
  // `created_at <= '2026-10-01'` casts to midnight, so the end day was
  // excluded entirely and a one-day range came back empty - which reads as
  // "nothing was given that day" rather than as a bug, so it was believed.
  check(
    'a single-day range is not empty',
    (r.body.donations ?? []).length > 0,
    (r.body.donations ?? []).length
  );

  /* ----------------------------------------------------------- the exports */

  console.log('\n8. an export carries the filters the screen had');
  r = await req('GET', '/api/donations/export.csv?limit=50', admin);
  check('the unfiltered export is 200', r.status === 200, r.status);
  let rows = csvRows(r.text);
  check('and holds all three donations', rows.length === 4, rows.length); // header + 3
  r = await req('GET', `/api/donations/export.csv?search=Sita`, admin);
  rows = csvRows(r.text);
  check('a search narrows the file to one row', rows.length === 2, rows.length);
  check('and it is the right one', r.text.includes('Sita'), r.text.slice(0, 200));

  console.log('\n9. the file says which filters produced it');
  // Six months later nobody remembers whether "donations.csv" was all of them
  // or one month of them, and the file itself is the only place that can say.
  check('the filter line is in the file', r.text.includes('Search: Sita'), r.text.slice(0, 200));

  console.log('\n10. a caller cannot download the donor base');
  // The screens are readable by a caller on purpose - they look a donor up
  // mid-call. Taking the whole list away in a file is a different act.
  r = await req('GET', '/api/people/export.csv', caller);
  check('people export is refused for a caller', r.status === 403, r.status);
  r = await req('GET', '/api/donations/export.xlsx', caller);
  check('donations export is refused for a caller', r.status === 403, r.status);
  r = await req('GET', '/api/people/export.csv', admin);
  check('and allowed for an admin', r.status === 200, r.status);

  console.log('\n11. a tax identifier never leaves in bulk');
  // Every person row carries a PAN and the list used to SELECT p.*, so it was
  // on the wire for anybody who could reach the endpoint. Nothing rendered it,
  // which made it invisible in the product and perfectly visible in a network
  // tab.
  check('the people export has no PAN column', !r.text.includes('ABCDE1234F'), r.text.slice(0, 300));
  const list = await req('GET', '/api/people?page=1&limit=25', caller);
  check(
    'and the list response does not carry one either',
    !JSON.stringify(list.body).includes('ABCDE1234F'),
    Object.keys(list.body.people?.[0] ?? {})
  );

  console.log('\n12. both formats come out of one definition');
  const csv = await req('GET', '/api/donations/export.csv', admin);
  const xlsx = await req('GET', '/api/donations/export.xlsx', admin);
  check('csv is served as csv', String(csv.headers['content-type']).includes('text/csv'), csv.headers['content-type']);
  check(
    'xlsx is served as a workbook',
    String(xlsx.headers['content-type']).includes('spreadsheetml'),
    xlsx.headers['content-type']
  );
  check(
    'the workbook is a real zip (PK header)',
    xlsx.text.slice(0, 2) === 'PK',
    xlsx.text.slice(0, 8)
  );
  check(
    'the filename carries the Indian date',
    String(csv.headers['content-disposition']).includes(today),
    csv.headers['content-disposition']
  );

  console.log('\n13. a phone number survives the round trip');
  // Left as a number, Excel renders 9876543210 as 9.87654E+09 and eats any
  // leading zero - and a phone list that cannot be dialled is worthless to a
  // calling team.
  const sheet = await toXlsx({
    name: 't',
    rows: [{ phone: '09876543210', amount: 1100.5, when: '2026-09-30T19:00:00Z' }],
    columns: [
      { header: 'Phone', value: (x: any) => x.phone, kind: 'phone' },
      { header: 'Amount', value: (x: any) => x.amount, kind: 'money' },
      { header: 'When', value: (x: any) => x.when, kind: 'datetime' },
    ],
  });
  check('the workbook builds', sheet.length > 0);
  const text = toCsv({
    name: 't',
    rows: [{ phone: '09876543210', when: '2026-09-30T19:00:00Z' }],
    columns: [
      { header: 'Phone', value: (x: any) => x.phone, kind: 'phone' },
      { header: 'When', value: (x: any) => x.when, kind: 'datetime' },
    ],
  });
  check('the leading zero is still there in CSV', text.includes('09876543210'), text);

  console.log('\n14. a time in a file reads as the Indian time');
  // 19:00 UTC is 00:30 the next morning in India. A file that says the 30th
  // disagrees with the screen that says the 1st.
  check(
    '19:00Z on 30 Sep prints as 01 Oct, 12:30 am',
    displayValue('2026-09-30T19:00:00Z', 'datetime') === '01 Oct 2026, 12:30 am',
    displayValue('2026-09-30T19:00:00Z', 'datetime')
  );
  check(
    'and a bare DATE prints as itself',
    displayValue('1985-03-12', 'date') === '12 Mar 1985',
    displayValue('1985-03-12', 'date')
  );

  console.log('\n15. the calling exports are reachable by the people who call');
  for (const path of [
    '/api/crm/leads/export.csv',
    '/api/crm/leads/abandoned/export.csv',
    '/api/crm/qr/payments/export.csv',
    '/api/crm/reminders/export.csv',
  ]) {
    const res = await req('GET', path, caller);
    check(`${path} is 200 for a caller`, res.status === 200, res.status);
  }

  console.log('\n16. and the admin-only ones are not reachable by them');
  for (const path of ['/api/crm/reports/callers/export.csv', '/api/subscriptions/export.csv']) {
    const res = await req('GET', path, caller);
    check(`${path} is refused for a caller`, res.status === 403, res.status);
  }

  console.log('\n17. an upload sample tells the office about the preacher column');
  // The importer has understood "Preacher ID" for a while and the sample did
  // not mention it, so every sheet uploaded in that period lost the
  // attribution silently - and the receipt said "enrolled by" the default.
  const sample = await req('GET', '/api/crm/leads/sample.csv', admin);
  check('the sample is served', sample.status === 200, sample.status);
  check('and names the preacher id column', sample.text.includes('Preacher ID'), sample.text.split('\n')[0]);

  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall green\n');
  server.close();
  await pool.end();
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
