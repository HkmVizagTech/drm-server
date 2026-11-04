/**
 * Load the devotee list (the office's sheet) into DRM's devotees table.
 *
 * Report first: with no flag this writes NOTHING and says what it would do.
 *   --apply   makes the changes. Safe to run twice: a number already on the list is updated
 *             (name, code, email), never duplicated, and nobody is removed.
 *
 * One login per WhatsApp number, so:
 *   - a row with no usable 10-digit mobile is skipped (nothing to send a code to);
 *   - two rows with the same number become ONE devotee: the first name is kept and the other
 *     codes are added to its code ("ADKD, TEM"). They are listed so somebody can check them;
 *   - a row with no name is named by its code, unless another row for the same number has a name.
 *
 *   npx tsx scripts/import-devotees.ts path/to/DevoteeList.csv           (report)
 *   npx tsx scripts/import-devotees.ts path/to/DevoteeList.csv --apply
 */
import fs from 'fs';
import '../src/bootTimezone';
import pool from '../src/db/pool';
import { runMigrations } from '../src/db/migrate';

const file = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!file) {
  console.error('Usage: tsx scripts/import-devotees.ts <csv> [--apply]');
  process.exit(1);
}

const nullish = (v: string | undefined) => {
  const t = (v ?? '').trim();
  return !t || t.toUpperCase() === 'NULL' ? '' : t;
};

async function main() {
  const u = new URL(process.env.DATABASE_URL!);
  console.log(`database: ${u.hostname}/${u.pathname.slice(1)}   mode: ${APPLY ? 'APPLY' : 'report only (nothing is written)'}`);

  const lines = fs.readFileSync(file, 'utf8').replace(/\r/g, '').split('\n').filter((l) => l.trim());
  const head = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const col = (name: string) => head.indexOf(name);
  const ci = { name: col('name'), code: col('code'), phone: col('mobilenumber'), email: col('email') };
  if (Object.values(ci).some((i) => i < 0)) throw new Error('The file needs Name, Code, MobileNumber and Email columns.');

  const byPhone = new Map<string, { name: string; named: boolean; codes: string[]; email: string; rows: number[] }>();
  const skipped: string[] = [];
  lines.slice(1).forEach((line, i) => {
    const c = line.split(',');
    const phone = nullish(c[ci.phone]).replace(/\D/g, '').slice(-10);
    const code = nullish(c[ci.code]);
    const realName = nullish(c[ci.name]);
    const name = realName || code;
    if (phone.length !== 10) {
      skipped.push(`row ${i + 2}: ${name || '(no name)'} - no mobile number`);
      return;
    }
    const had = byPhone.get(phone);
    if (!had) {
      byPhone.set(phone, { name, named: !!realName, codes: code ? [code] : [], email: nullish(c[ci.email]), rows: [i + 2] });
    } else {
      // A real name beats a code standing in for a missing one.
      if (!had.named && realName) {
        had.name = realName;
        had.named = true;
      }
      if (code && !had.codes.includes(code)) had.codes.push(code);
      if (!had.email) had.email = nullish(c[ci.email]);
      had.rows.push(i + 2);
    }
  });

  console.log(`\n${byPhone.size} devotees with a number; ${skipped.length} rows skipped for no number:`);
  skipped.forEach((s) => console.log('  skipped', s));
  const shared = [...byPhone.entries()].filter(([, d]) => d.rows.length > 1);
  console.log(`\n${shared.length} numbers appear on more than one row (kept as ONE devotee):`);
  shared.forEach(([p, d]) => console.log(`  ${p}: name "${d.name}", codes ${d.codes.join(', ')} (rows ${d.rows.join(', ')})`));

  if (!APPLY) {
    await pool.end();
    return;
  }
  const m = await runMigrations();
  if (!m.ok) throw new Error('the schema could not be applied - nothing was changed');
  let added = 0, updated = 0;
  for (const [phone, d] of byPhone) {
    const r = await pool.query(
      `INSERT INTO devotees (name, code, phone, email) VALUES ($1, $2, $3, NULLIF($4, ''))
       ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, code = EXCLUDED.code,
         email = COALESCE(EXCLUDED.email, devotees.email), updated_at = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [d.name.slice(0, 160), d.codes.join(', ').slice(0, 40), phone, d.email.slice(0, 160)]
    );
    if (r.rows[0].inserted) added++; else updated++;
  }
  console.log(`\nadded ${added}, updated ${updated}`);
  await pool.end();
}
main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
