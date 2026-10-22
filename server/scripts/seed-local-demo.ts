/**
 * Local demo data: one admin login and a few made-up Brick / Square foot /
 * Mandir donations, so the Seva wall has something to show.
 *
 * Refuses to run on anything but a database whose name ends in _test, and the
 * login it creates is a throwaway for that local database only.
 *
 *   NODE_ENV=development DATABASE_URL=...drm_test npm run seed:local
 */
import '../src/bootTimezone';
import bcrypt from 'bcryptjs';
import pool from '../src/db/pool';
import { runMigrations } from '../src/db/migrate';

const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbName || '(unset)'}". Use a _test database.`);
  process.exit(1);
}

const EMAIL = 'admin@local.test';
const PASSWORD = 'admin123';

const DEMO: [string, string, number, string, string | null, string | null][] = [
  // name, phone, amount, purpose, given_name, sevak_name
  ['Asha Rao', '9100000001', 1500, 'Brick Seva', 'Meena Rao', 'Late Sri Rao'],
  ['Bala Krishna', '9100000002', 5000, 'Square foot seva', null, null],
  ['Chitra Devi', '9100000003', 2001, 'Mandir nirmana seva', null, 'Sri Venkat'],
  ['Dinesh Kumar', '9100000004', 3000, 'Brick Seva', null, null],
  ['Esha Reddy', '9100000005', 10800, 'Square foot seva', 'Esha Reddy', 'Her parents'],
  ['Farid Khan', '9100000006', 1000, 'Brick Seva', null, null], // under 1,500: not listed
];

async function main() {
  const m = await runMigrations();
  if (!m.ok) throw new Error('migration failed');

  const hash = await bcrypt.hash(PASSWORD, 10);
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ('Local Admin', $1, $2, 'admin')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin'`,
    [EMAIL, hash]
  );

  let added = 0;
  for (const [name, phone, amount, purpose, given, sevak] of DEMO) {
    const p = await pool.query(
      `INSERT INTO people (name, phone) VALUES ($1, $2)
       ON CONFLICT (phone) DO UPDATE SET name = people.name RETURNING id`,
      [name, phone]
    );
    const exists = await pool.query(`SELECT 1 FROM donations WHERE person_id = $1 AND purpose = $2 AND amount = $3`, [p.rows[0].id, purpose, amount]);
    if (exists.rowCount) continue;
    await pool.query(
      `INSERT INTO donations (person_id, amount, payment_mode, purpose, source_site, given_name, sevak_name)
       VALUES ($1, $2, 'upi', $3, 'hkmv', $4, $5)`,
      [p.rows[0].id, amount, purpose, given, sevak]
    );
    added++;
  }
  console.log(`database: ${dbName}\nadmin login: ${EMAIL} / ${PASSWORD}\ndemo donations added: ${added}`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
