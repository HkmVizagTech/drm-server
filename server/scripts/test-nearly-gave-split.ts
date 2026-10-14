// The calling overview, split into Nearly gave and every other call - what an
// admin reads to see how many Nearly gave calls each caller made and what
// they brought in, against their other calls.
//
//   DATABASE_URL=postgresql://localhost/drm_test npx tsx scripts/test-nearly-gave-split.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { generateToken } from '../src/middleware/auth';
import crmRoutes from '../src/routes/crm';
import crmReportsRoutes from '../src/routes/crmReports';
import crmCallsRoutes from '../src/routes/crmCalls';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use('/api/crm', crmRoutes);
app.use('/api/crm', crmReportsRoutes);
app.use('/api/crm', crmCallsRoutes);

let base = '';
const ADMIN = '11111111-1111-1111-1111-111111111111';
const ANA = '22222222-2222-2222-2222-222222222222';
const BHAVIN = '33333333-3333-3333-3333-333333333333';
const admin = { userId: ADMIN, role: 'admin' };
const ana = { userId: ANA, role: 'caller' };

function req(method: string, path: string, as: { userId: string; role: string }, body?: unknown) {
  const raw = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const headers: Record<string, string | number> = {
    authorization: `Bearer ${generateToken({ userId: as.userId, role: as.role } as never)}`,
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

async function lead(phone: string, name: string, assignedTo: string, alt?: string) {
  return (
    await pool.query(`INSERT INTO leads (phone, name, assigned_to, alt_phone) VALUES ($1,$2,$3,$4) RETURNING id`, [phone, name, assignedTo, alt ?? null])
  ).rows[0].id as string;
}
async function attempt(phone: string, hoursAgo: number, page = '/annadan', purpose = 'Annadan') {
  await pool.query(
    `INSERT INTO abandoned_attempts (source_site, external_id, phone, name, amount, purpose, source_page, attempted_at, status)
     VALUES ('hkmv', $1, $2, 'x', 1100, $3, $4, NOW() - make_interval(hours => $5), 'failed')`,
    [`a-${phone}-${hoursAgo}`, phone, purpose, page, hoursAgo]
  );
}
async function call(leadId: string, as: { userId: string; role: string }, disposition: string) {
  const r = await req('POST', `/api/crm/leads/${leadId}/call`, as, { disposition });
  if (r.status >= 300) throw new Error(`call failed: ${JSON.stringify(r.body)}`);
}
async function credit(userId: string, leadId: string | null, amount: number, minutesAgo = 0) {
  await pool.query(
    `INSERT INTO caller_credits (user_id, amount, kind, occurred_at, lead_id)
     VALUES ($1, $2, $3, NOW() - make_interval(mins => $5), $4)`,
    [userId, amount, leadId ? 'lead' : 'manual', leadId, minutesAgo]
  );
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  await pool.query(
    `TRUNCATE caller_credits, qr_payments, qr_shares, calling_session_items, calling_sessions,
              abandoned_attempts, lead_activities, lead_reminders, leads, donations, people, users
     RESTART IDENTITY CASCADE`
  );
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role) VALUES
       ($1,'Admin','a@t','x','admin'), ($2,'Ana','ana@t','x','caller'), ($3,'Bhavin','bh@t','x','caller')`,
    [ADMIN, ANA, BHAVIN]
  );

  // Ana: two Nearly gave people (one on the other number), one ordinary lead,
  // one who tried on /donations (never Nearly gave), one whose try was too long ago.
  const asha = await lead('9811111101', 'Asha', ANA);
  const bala = await lead('9811111102', 'Bala', ANA, '9811199999');
  const chitra = await lead('9811111103', 'Chitra', ANA);
  const dev = await lead('9811111104', 'Dev', ANA);
  const esha = await lead('9811111105', 'Esha', ANA);
  // Bhavin: one Nearly gave person, one ordinary.
  const farah = await lead('9811111106', 'Farah', BHAVIN);
  const gopal = await lead('9811111107', 'Gopal', BHAVIN);

  await attempt('9811111101', 2);
  await attempt('9811199999', 30);
  await attempt('9811111104', 1, '/donations', 'Donation');
  await attempt('9811111105', 24 * 45);
  await attempt('9811111106', 5);

  await call(asha, ana, 'interested');
  await call(asha, ana, 'no_answer');
  await call(bala, ana, 'interested');
  await call(chitra, ana, 'interested');
  await call(dev, ana, 'interested');
  await call(esha, ana, 'no_answer');
  await call(farah, { userId: BHAVIN, role: 'caller' }, 'interested');
  await call(gopal, { userId: BHAVIN, role: 'caller' }, 'no_answer');

  await credit(ANA, asha, 2500);
  await credit(ANA, chitra, 1000);
  await credit(ANA, null, 500);
  await credit(BHAVIN, farah, 5000);
  // Money from a Nearly gave person (found through the donor's number) - but
  // Ana never called her, Bhavin did: not Ana's Nearly gave money.
  const farahPerson = (await pool.query(`INSERT INTO people (name, phone) VALUES ('Farah', '+91 98111 11106') RETURNING id`)).rows[0].id;
  await pool.query(
    `INSERT INTO caller_credits (user_id, amount, kind, occurred_at, person_id) VALUES ($1, 300, 'manual', NOW(), $2)`,
    [ANA, farahPerson]
  );
  // And the same through the donor's number, for Bhavin who did ring her: Nearly gave.
  await pool.query(
    `INSERT INTO caller_credits (user_id, amount, kind, occurred_at, person_id) VALUES ($1, 700, 'manual', NOW(), $2)`,
    [BHAVIN, farahPerson]
  );

  console.log('\n1. the admin sees both halves');
  const d = (await req('GET', '/api/crm/dashboard?preset=today', admin)).body;
  const ng = d.split?.nearly_gave;
  const other = d.split?.other;
  check('Nearly gave calls: Asha twice, Bala once (other number), Farah once', ng?.calls.made === 4, ng);
  check('of which answered', ng?.calls.connected === 3, ng);
  check('three people', ng?.calls.leads_touched === 3, ng);
  check('other calls: Chitra, Dev (/donations), Esha (too long ago), Gopal', other?.calls.made === 4, other);
  check('the halves add up to the tile', ng.calls.made + other.calls.made === d.calls.made, [ng, other, d.calls]);
  check('Nearly gave money: Asha 2500 + Farah 5000 + 700 found by her number', ng?.money.raised === 8200, ng?.money);
  check('other money: the rest', other?.money.raised === 1800 && ng.money.raised + other.money.raised === d.money.raised, [other?.money, d.money.raised]);

  console.log('\n2. per caller');
  const a = d.by_caller?.find((x: any) => x.id === ANA);
  const b = d.by_caller?.find((x: any) => x.id === BHAVIN);
  check("Ana: 3 Nearly gave calls, 2 answered, ₹2,500", a?.nearly_gave.calls === 3 && a.nearly_gave.connected === 2 && a.nearly_gave.raised === 2500, a);
  check('Ana: 3 other calls, ₹1,800 (incl. money from a person she never rang as Nearly gave)', a?.other.calls === 3 && a.other.raised === 1800, a);
  check('Bhavin: 1 and ₹5,700 Nearly gave; 1 other, nothing raised', b?.nearly_gave.calls === 1 && b.nearly_gave.raised === 5700 && b.other.calls === 1 && b.other.raised === 0, b);
  check('sorted by money raised', d.by_caller?.[0]?.id === BHAVIN, d.by_caller?.map((x: any) => x.name));

  console.log('\n3. a caller sees their own split, and no one else');
  const mine = (await req('GET', '/api/crm/dashboard?preset=today', ana)).body;
  check("Ana's own halves", mine.split?.nearly_gave.calls.made === 3 && mine.split.other.calls.made === 3 && mine.split.nearly_gave.money.raised === 2500, mine.split);
  check('no per-caller table for a caller', Array.isArray(mine.by_caller) && mine.by_caller.length === 0, mine.by_caller);

  console.log('\n4. My calls opens each half');
  const ngList = (await req('GET', '/api/crm/calls?kind=nearly_gave&user_id=all', admin)).body;
  const otherList = (await req('GET', '/api/crm/calls?kind=other&user_id=all', admin)).body;
  check('Nearly gave calls list', ngList.totals?.calls === 4 && ngList.calls.every((c: any) => [asha, bala, farah].includes(c.lead_id)), ngList.totals);
  check('other calls list', otherList.totals?.calls === 4 && otherList.calls.every((c: any) => [chitra, dev, esha, gopal].includes(c.lead_id)), otherList.totals);

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
