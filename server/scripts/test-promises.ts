// Recording a promise made over the phone, and narrowing a board by sheet.
//
// WHAT THESE TWO HAVE IN COMMON
// Both are about a donor who is already in DRM being found rather than
// duplicated. A promise from a number DRM already knows must land on that
// lead, not beside it - a second lead for the same person is how one donor
// ends up rung twice and thanked for a donation somebody else's column shows.
//
// HOW TO RUN IT
//   DATABASE_URL=postgresql://localhost/drm_test npm run test:promises

import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import crmRoutes from '../src/routes/crm';
// Mounted the same way index.ts does it: several routers on one prefix, so a
// path this test calls resolves exactly as it would in production.
import crmRemindersRoutes from '../src/routes/crmReminders';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(
    `Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}".\n` +
      'This script empties tables. Point it at a database whose name ends in _test.'
  );
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use('/api/crm', crmRoutes);
app.use('/api/crm', crmRemindersRoutes);

let base = '';
const ADMIN = '11111111-1111-1111-1111-111111111111';
const ANA = '22222222-2222-2222-2222-222222222222';

function call(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  as = { userId: ADMIN, role: 'admin' }
): Promise<{ status: number; body: any }> {
  const token = generateToken({ userId: as.userId, email: 'x@test', role: as.role } as never);
  const raw = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(raw ? { 'content-type': 'application/json', 'content-length': raw.length } : {}),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d ? JSON.parse(d) : {} }));
      }
    );
    req.on('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

const inDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(10, 0, 0, 0);
  return d.toISOString();
};

async function reset() {
  await pool.query(
    `TRUNCATE lead_reminders, lead_activities, lead_import_rows, lead_import_batches,
              leads, users, crm_settings RESTART IDENTITY CASCADE`
  );
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role) VALUES
       ($1,'Admin','a@test','x','admin'), ($2,'Ana','ana@test','x','caller')`,
    [ADMIN, ANA]
  );
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;

  console.log('\n1. a donor DRM has never heard of rings up');
  await reset();
  let r = await call('POST', '/api/crm/promises', {
    phone: '+91 98480 12345',
    name: 'Ramesh',
    due_at: inDays(21),
    expected_amount: 10000,
    occasion: 'Govardhan Puja',
    note: 'Said to ring that morning',
    lead_times: [10080, 2880, 1440],
  });
  check('201', r.status === 201, r.body);
  check('a lead was created', r.body.created === true, r.body);
  check('on the last ten digits of the number', r.body.lead.phone === '9848012345', r.body.lead.phone);
  check('with a reminder', !!r.body.reminder, r.body);
  check('carrying the alerts chosen', String(r.body.reminder.lead_times) === '10080,2880,1440', r.body.reminder.lead_times);
  check('the amount they said', Number(r.body.reminder.expected_amount) === 10000, r.body.reminder.expected_amount);
  check('and the occasion', r.body.reminder.occasion === 'Govardhan Puja', r.body.reminder.occasion);

  const lead = await pool.query(`SELECT * FROM leads WHERE phone = '9848012345'`);
  check('the callback is booked on the lead', !!lead.rows[0].next_follow_up_at, lead.rows[0].next_follow_up_at);
  check('the expected amount is on the lead too', Number(lead.rows[0].expected_amount) === 10000, lead.rows[0].expected_amount);
  const acts = await pool.query(`SELECT * FROM lead_activities WHERE lead_id = $1`, [lead.rows[0].id]);
  check('and it shows in the lead history', acts.rows.some((a) => a.kind === 'reminder'), acts.rows.map((a) => a.kind));

  console.log('\n2. the same donor rings again');
  r = await call('POST', '/api/crm/promises', {
    phone: '9848012345',
    due_at: inDays(3),
    expected_amount: 2500,
  });
  check('no second lead', r.body.created === false, r.body);
  check(
    'still exactly one lead for that number',
    (await pool.query(`SELECT COUNT(*)::int c FROM leads WHERE phone = '9848012345'`)).rows[0].c === 1
  );
  check(
    'two reminders, both kept',
    (await pool.query(`SELECT COUNT(*)::int c FROM lead_reminders`)).rows[0].c === 2
  );
  const after = await pool.query(`SELECT next_follow_up_at FROM leads WHERE phone = '9848012345'`);
  const days = (new Date(after.rows[0].next_follow_up_at).getTime() - Date.now()) / 86_400_000;
  check('the callback moved to the sooner of the two, not the later', days < 5, days);

  console.log('\n3. what it refuses');
  r = await call('POST', '/api/crm/promises', { phone: '9848012345' });
  check('no date → 400', r.status === 400, r.body);
  r = await call('POST', '/api/crm/promises', { due_at: inDays(2) });
  check('no number → 400', r.status === 400, r.body);
  r = await call('POST', '/api/crm/promises', { phone: '9848012345', due_at: 'not a date' });
  check('a date that is not one → 400', r.status === 400, r.body);

  console.log('\n4. narrowing a board to one sheet');
  await reset();
  const batches = [];
  for (const [file, tab] of [
    ['Janmashtami 2026.xlsx', 'HKMI'],
    ['General donations.xlsx', null],
  ] as const) {
    const b = await pool.query(
      `INSERT INTO lead_import_batches (filename, sheet_name, rows_total, leads_added)
       VALUES ($1,$2,10,10) RETURNING id`,
      [file, tab]
    );
    batches.push(b.rows[0].id);
  }
  // Three on the first sheet, two on the second, one from no sheet at all.
  for (let i = 0; i < 3; i++) {
    await pool.query(
      `INSERT INTO leads (phone, name, import_batch_id, next_follow_up_at)
       VALUES ($1,$2,$3::uuid, NOW() - INTERVAL '1 day')`,
      [`91110000${i}0`, `Janmashtami ${i}`, batches[0]]
    );
  }
  for (let i = 0; i < 2; i++) {
    await pool.query(
      `INSERT INTO leads (phone, name, import_batch_id, next_follow_up_at)
       VALUES ($1,$2,$3::uuid, NOW() - INTERVAL '1 day')`,
      [`92220000${i}0`, `General ${i}`, batches[1]]
    );
  }
  await pool.query(
    `INSERT INTO leads (phone, name, next_follow_up_at) VALUES ('9333000000','Walk-in', NOW() - INTERVAL '1 day')`
  );

  r = await call('GET', '/api/crm/leads?due=overdue&sort=due&limit=100');
  check('all six are overdue', r.body.leads.length === 6, r.body.leads.length);
  r = await call('GET', `/api/crm/leads?due=overdue&sort=due&limit=100&batch=${batches[0]}`);
  check('the Janmashtami sheet gives three', r.body.leads.length === 3, r.body.leads.map((l: any) => l.name));
  r = await call('GET', `/api/crm/leads?due=overdue&sort=due&limit=100&batch=${batches[1]}`);
  check('the other sheet gives two', r.body.leads.length === 2, r.body.leads.map((l: any) => l.name));
  r = await call('GET', '/api/crm/leads?due=overdue&sort=due&limit=100&batch=none');
  check('and "not from a sheet" gives the one', r.body.leads.length === 1, r.body.leads.map((l: any) => l.name));
  r = await call('GET', `/api/crm/leads?due=overdue&limit=100&batch=${batches[0]},${batches[1]}`);
  check('two sheets at once gives five', r.body.leads.length === 5, r.body.leads.length);

  console.log('\n5. the sheets show up in config for the dropdown');
  r = await call('GET', '/api/crm/config');
  check('both are listed', r.body.batches.length === 2, r.body.batches);
  check('newest first', r.body.batches[0].filename === 'General donations.xlsx', r.body.batches[0]);
  await pool.query(
    `INSERT INTO lead_import_batches (filename, rows_total, leads_added) VALUES ('Draft.xlsx', 5, 0)`
  );
  r = await call('GET', '/api/crm/config');
  check('a sheet that produced no leads is left out', r.body.batches.length === 2, r.body.batches.length);

  console.log('\n6. the temple default for alerts is used when nobody picks');
  await reset();
  await pool.query(
    `INSERT INTO crm_settings (key, value) VALUES ('reminder_lead_times','[4320,1440]'::jsonb)`
  );
  const l = await pool.query(
    `INSERT INTO leads (phone, name) VALUES ('9444000000','Mid-call') RETURNING id`
  );
  await pool.query(`INSERT INTO crm_dispositions (slug, label, sort_order, active) VALUES ('promised','Promised',1,TRUE)
                    ON CONFLICT (slug) DO NOTHING`);
  r = await call('POST', `/api/crm/leads/${l.rows[0].id}/call`, {
    disposition: 'promised',
    reminder: { due_at: inDays(30), occasion: 'Kartik' },
  });
  check('the call was logged', r.status === 201, r.body);
  check('and the reminder took the temple default', String(r.body.reminder?.lead_times) === '4320,1440', r.body.reminder?.lead_times);

  console.log("\n7. a reminder raised from the lead's own page");
  await reset();
  const lp = await pool.query(
    `INSERT INTO leads (phone, name, assigned_to) VALUES ('9555000000','Sita',$1::uuid) RETURNING id`,
    [ANA]
  );
  r = await call('POST', `/api/crm/leads/${lp.rows[0].id}/reminders`, {
    title: 'Said she would give at Kartik',
    occasion: 'Kartik',
    due_at: inDays(40),
    expected_amount: 5100,
    lead_times: [10080, 1440],
  });
  check('201', r.status === 201, r.body);
  check('the alerts chosen are kept', String(r.body.lead_times) === '10080,1440', r.body.lead_times);
  check(
    'it falls to whoever the lead belongs to when nobody is named',
    r.body.assigned_to === ANA,
    r.body.assigned_to
  );

  r = await call('GET', `/api/crm/leads/${lp.rows[0].id}`);
  check('and the lead page is sent it with the lead', r.body.reminders?.length === 1, r.body.reminders);
  check('with the caller name resolved', r.body.reminders[0].assigned_to_name === 'Ana', r.body.reminders[0]);

  // Settled ones sort below open ones, which is what keeps the card readable.
  await pool.query(
    `INSERT INTO lead_reminders (lead_id, title, due_at, status)
     VALUES ($1::uuid,'An old one', NOW() - INTERVAL '30 days', 'done')`,
    [lp.rows[0].id]
  );
  r = await call('GET', `/api/crm/leads/${lp.rows[0].id}`);
  check('open first, settled after', r.body.reminders[0].status === 'open', r.body.reminders.map((x: any) => x.status));

  console.log('\n8. removing a lead');
  await reset();
  const del = await pool.query(
    `INSERT INTO leads (phone, name) VALUES ('9666000000','Test Me') RETURNING id`
  );
  await pool.query(
    `INSERT INTO lead_activities (lead_id, kind, note) VALUES ($1::uuid,'note','a note')`,
    [del.rows[0].id]
  );
  await pool.query(
    `INSERT INTO lead_reminders (lead_id, title, due_at) VALUES ($1::uuid,'a promise', NOW() + INTERVAL '2 days')`,
    [del.rows[0].id]
  );
  await pool.query(
    `INSERT INTO razorpay_qrs (id, qr_id, label, active)
     VALUES ('55555555-5555-5555-5555-555555555555','qr_DELTEST001','Test QR',TRUE)`
  );
  await pool.query(
    `INSERT INTO qr_shares (qr_id, lead_id, shared_by, phone, channel, matched_payment_id, matched_amount, matched_at)
     VALUES ('55555555-5555-5555-5555-555555555555',$1::uuid,NULL,'9666000000','whatsapp','pay_DEL1',1000,NOW())`,
    [del.rows[0].id]
  );

  r = await call('GET', `/api/crm/leads/${del.rows[0].id}/removal`);
  check('the preview counts what goes', r.body.activities === 1 && r.body.reminders === 1, r.body);
  check('and what was shared', r.body.qr_shares === 1 && r.body.qr_paid === 1, r.body);

  r = await call('DELETE', `/api/crm/leads/${del.rows[0].id}`, undefined, { userId: ANA, role: 'caller' });
  check('a caller may not remove a lead', r.status === 403, r.status);

  r = await call('DELETE', `/api/crm/leads/${del.rows[0].id}`);
  check('an admin may', r.status === 200, r.body);
  check('the lead is gone', (await pool.query(`SELECT COUNT(*)::int c FROM leads`)).rows[0].c === 0);
  check(
    'its calls and notes went with it',
    (await pool.query(`SELECT COUNT(*)::int c FROM lead_activities`)).rows[0].c === 0
  );
  check(
    'and its reminders',
    (await pool.query(`SELECT COUNT(*)::int c FROM lead_reminders`)).rows[0].c === 0
  );
  const share = await pool.query(`SELECT * FROM qr_shares`);
  check('but the paid QR share survives', share.rows.length === 1, share.rows.length);
  check('with its lead link cleared, not its money', share.rows[0].lead_id === null && Number(share.rows[0].matched_amount) === 1000, share.rows[0]);

  r = await call('DELETE', `/api/crm/leads/${del.rows[0].id}`);
  check('removing it twice is a 404, not a crash', r.status === 404, r.status);

  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall green\n');
  server.close();
  await pool.end();
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
