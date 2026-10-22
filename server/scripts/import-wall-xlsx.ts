/**
 * Load the Seva wall spreadsheet (exported from production) into a LOCAL test
 * database, so the page can be looked at with the real rows.
 *
 * Reads only the .xlsx file; it does not connect to production. Refuses any
 * target that is not a local database whose name ends in _test. Re-running adds
 * only rows that are not already there.
 *
 *   NODE_ENV=development DATABASE_URL=postgresql://...@localhost:5432/drm_test \
 *     npm run import:wall -- ~/Desktop/mandir-seva-sep-2026-to-date.xlsx
 */
import '../src/bootTimezone';
import ExcelJS from 'exceljs';
import pool from '../src/db/pool';
import { runMigrations } from '../src/db/migrate';

const target = process.env.DATABASE_URL ?? '';
const dbName = target.split('/').pop()?.split('?')[0] ?? '';
if (!/_test$/.test(dbName) || !/(localhost|127\.0\.0\.1)/.test(target)) {
  console.error(`Refusing to run: the target must be a LOCAL database ending in _test (got "${dbName || '(unset)'}").`);
  process.exit(1);
}
const file = process.argv[2]?.replace(/^~/, process.env.HOME ?? '~');
if (!file) {
  console.error('Give the path of the .xlsx file.');
  process.exit(1);
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// "Sept" as well as "Sep": the export's date formatting spells September with four letters.
const day = (s: string): string | null => {
  const m = /^(\d{1,2}) ([A-Za-z]{3,4}) (\d{4})$/.exec(s.trim());
  const mon = m ? MONTHS[m[2].slice(0, 3).toLowerCase()] : undefined;
  if (!m || mon === undefined) return null;
  return `${m[3]}-${String(mon + 1).padStart(2, '0')}-${m[1].padStart(2, '0')} 12:00:00+05:30`;
};
const text = (v: ExcelJS.CellValue): string => String(v ?? '').trim();

async function main() {
  const m = await runMigrations();
  if (!m.ok) throw new Error('migration failed on the target');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet('Donations') ?? wb.worksheets[0];

  let added = 0, skipped = 0, donors = 0;
  for (let i = 2; i <= ws.rowCount; i++) {
    const r = ws.getRow(i);
    const [date, donor, honoree, phone, amount, seva, mode, receipt, , primary, page] =
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((c) => text(r.getCell(c).value));
    if (!phone || !amount) continue;
    const when = day(date);
    if (!when) { skipped++; continue; }

    const p = await pool.query(
      `INSERT INTO people (name, phone) VALUES ($1, $2)
       ON CONFLICT (phone) DO UPDATE SET name = people.name RETURNING id, (xmax = 0) AS inserted`,
      [primary || donor, phone]
    );
    if (p.rows[0].inserted) donors++;

    const dup = await pool.query(
      `SELECT 1 FROM donations WHERE person_id = $1 AND amount = $2 AND purpose = $3 AND created_at::date = $4::date`,
      [p.rows[0].id, Number(amount), seva, when]
    );
    if (dup.rowCount) { skipped++; continue; }

    await pool.query(
      `INSERT INTO donations (person_id, amount, payment_mode, purpose, source, source_site, source_page,
                              created_at, receipt_number, given_name, sevak_name)
       VALUES ($1,$2,$3,$4,'website','hkmv',$5,$6,$7,$8,$9)`,
      [p.rows[0].id, Number(amount), mode || 'upi', seva, page || null, when, receipt || null,
       donor && donor !== (primary || donor) ? donor : null, honoree || null]
    );
    added++;
  }
  console.log(`database: ${dbName}\nfile: ${file}\nadded: ${added} donations, ${donors} new donors\nalready there / skipped: ${skipped}`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
