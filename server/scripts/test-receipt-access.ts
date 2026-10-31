// Who may download a donor's receipt: admins and accountants any; a caller only receipts of money
// that is theirs (raised by them, or credited to them); nobody else.
//
// Never reaches a donation site: it refuses to run unless the site addresses are blank, and only
// reads the status code (403 = refused; anything else = let through to the lookup).
//
//   NODE_ENV=development DATABASE_URL=...drm_test HKMV_API_URL= ANNADAN_API_URL= npx tsx scripts/test-receipt-access.ts

import '../src/bootTimezone';
import express from 'express';
import http from 'http';
import pool from '../src/db/pool';
import { runMigrations } from '../src/db/migrate';
import { generateToken } from '../src/middleware/auth';
import donationsRoutes from '../src/routes/donations';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}
if (process.env.HKMV_API_URL || process.env.ANNADAN_API_URL) {
  console.error('Refusing to run with a donation site address set.');
  process.exit(1);
}

let failures = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}`, ok ? '' : JSON.stringify(d)?.slice(0, 300));
  if (!ok) failures++;
};

async function main() {
  await runMigrations();
  await pool.query(`TRUNCATE donations, people, caller_credits, users RESTART IDENTITY CASCADE`);
  const U = { admin: '11111111-1111-1111-1111-111111111111', acct: '12121212-1212-1212-1212-121212121212', ana: '22222222-2222-2222-2222-222222222222', bhavin: '33333333-3333-3333-3333-333333333333', coord: '44444444-4444-4444-4444-444444444444' };
  const rows: [string, string, string][] = [[U.admin, 'Admin', 'admin'], [U.acct, 'Acct', 'accountant'], [U.ana, 'Ana', 'caller'], [U.bhavin, 'Bhavin', 'caller'], [U.coord, 'Coord', 'volunteer_coordinator']];
  for (const [id, name, role] of rows) await pool.query(`INSERT INTO users (id, name, email, password_hash, role) VALUES ($1,$2,$3,'x',$4)`, [id, name, `${name}@t`, role]);
  const person = (await pool.query(`INSERT INTO people (name, phone) VALUES ('Donor','9000000001') RETURNING id`)).rows[0].id;
  const don = async (enteredBy: string | null, ref: string) =>
    (await pool.query(`INSERT INTO donations (person_id, amount, type, payment_mode, entered_by, external_ref, source) VALUES ($1, 100, 'one-time', 'upi', $2, $3, 'offline') RETURNING id`, [person, enteredBy, ref])).rows[0].id as string;
  const raisedByAna = await don(U.ana, 'x1');
  const creditedToBhavin = await don(null, 'x2');
  await pool.query(`INSERT INTO caller_credits (user_id, amount, kind, occurred_at, donation_id, created_by) VALUES ($1, 100, 'link', NOW(), $2, $1)`, [U.bhavin, creditedToBhavin]);
  const nobodys = await don(null, 'x3');

  const app = express();
  app.use(express.json());
  app.use('/api/donations', donationsRoutes);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const status = (id: string, who: string, role: string) =>
    new Promise<number>((resolve, reject) => {
      http.get({ port, path: `/api/donations/${id}/receipt-file`, headers: { authorization: `Bearer ${generateToken({ userId: who, role } as never)}` } }, (res) => {
        res.resume(); res.on('end', () => resolve(res.statusCode ?? 0));
      }).on('error', reject);
    });

  check('an admin is let through', (await status(nobodys, U.admin, 'admin')) !== 403);
  check('an accountant is let through', (await status(nobodys, U.acct, 'accountant')) !== 403);
  check('a caller may download a receipt they raised', (await status(raisedByAna, U.ana, 'caller')) !== 403);
  check('a caller may download one credited to them', (await status(creditedToBhavin, U.bhavin, 'caller')) !== 403);
  check("a caller may not download a colleague's", (await status(raisedByAna, U.bhavin, 'caller')) === 403);
  check('nor one that is nobody\'s', (await status(nobodys, U.ana, 'caller')) === 403);
  check('a coordinator is still refused', (await status(raisedByAna, U.coord, 'volunteer_coordinator')) === 403);

  server.close();
  await pool.end();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await pool.end().catch(() => undefined); process.exit(1); });
