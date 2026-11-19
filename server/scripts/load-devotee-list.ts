/**
 * Load the devotee list (Excel: Id, Code, Name, Mobile Number) into DRM's devotees, with each
 * devotee's DCC id - the "Enrolled by" on receipts they raise in the devotee portal.
 *
 * A devotee signs in with a WhatsApp code sent to their number, so only rows with a 10-digit
 * mobile are loaded; a number not on the list gets no code. Report first: with no flag this
 * writes NOTHING and says what it would do.
 *
 *   --apply                 make the changes. Safe to run twice: a number already there is
 *                           updated (name, code, DCC id), never duplicated; nobody is removed,
 *                           switched off, or has their sign-in account touched.
 *   --exclude 9xxxxxxxxx    leave these numbers out (comma-separated)
 *   --prefer CODE,CODE      where two rows share a number, the row with this code wins
 *
 * Two rows on one number: one login, so one devotee. The winner is the --prefer code, else the
 * first row with a person's name; its Id is the DCC id. The other codes are kept after its own.
 *
 *   npx tsx scripts/load-devotee-list.ts path/to/devotees.xlsx --exclude 6302787849
 *   npx tsx scripts/load-devotee-list.ts path/to/devotees.xlsx --exclude 6302787849 --apply
 */
import '../src/bootTimezone';
import ExcelJS from 'exceljs';
import pool from '../src/db/pool';

const file = process.argv[2];
const APPLY = process.argv.includes('--apply');
const listArg = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1].split(',').map((x) => x.trim()).filter(Boolean) : [];
};
const EXCLUDE = new Set(listArg('--exclude').map((p) => p.replace(/\D/g, '').slice(-10)));
const PREFER = listArg('--prefer').map((c) => c.toUpperCase());
if (!file) {
  console.error('Usage: tsx scripts/load-devotee-list.ts <devotees.xlsx> [--exclude phones] [--prefer CODES] [--apply]');
  process.exit(1);
}

interface Row {
  line: number;
  id: number | null;
  code: string;
  name: string;
  phone: string;
}

const cell = (v: ExcelJS.CellValue): string => {
  if (v == null) return '';
  if (typeof v === 'object') {
    const o = v as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (o.richText) return o.richText.map((t) => t.text).join('');
    return String(o.text ?? o.result ?? '');
  }
  return String(v);
};
/** A person's name, not a placeholder for a desk or a channel. */
const personal = (r: Row) => !!r.name && r.name.toUpperCase() !== r.code && !/social media|donations|temple|admin/i.test(r.name);

async function main() {
  const u = new URL(process.env.DATABASE_URL!);
  console.log(`database: ${u.hostname}/${u.pathname.slice(1)}   mode: ${APPLY ? 'APPLY' : 'report only (nothing is written)'}\n`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  const head = (ws.getRow(1).values as ExcelJS.CellValue[]).map((v) => cell(v).trim().toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const ci = { id: col('id', 'dcc id'), code: col('code'), name: col('name'), phone: col('mobile number', 'mobilenumber', 'mobile', 'phone') };
  if (Object.values(ci).some((i) => i < 0)) throw new Error('The sheet needs Id, Code, Name and Mobile Number columns.');

  const rows: Row[] = [];
  const skipped: string[] = [];
  ws.eachRow((r, line) => {
    if (line === 1) return;
    const v = r.values as ExcelJS.CellValue[];
    const code = cell(v[ci.code]).trim().toUpperCase();
    const name = cell(v[ci.name]).trim().replace(/\s+/g, ' ');
    const phone = cell(v[ci.phone]).replace(/\D/g, '').slice(-10);
    const id = Number(cell(v[ci.id]).trim());
    const label = `${code || '?'} ${name || '(no name)'}`;
    if (phone.length !== 10) return void skipped.push(`row ${line}: ${label} - no mobile number`);
    if (EXCLUDE.has(phone)) return void skipped.push(`row ${line}: ${label} - excluded (${phone})`);
    rows.push({ line, id: Number.isInteger(id) && id > 0 ? id : null, code, name, phone });
  });

  const byPhone = new Map<string, Row[]>();
  for (const r of rows) byPhone.set(r.phone, [...(byPhone.get(r.phone) ?? []), r]);

  const plan: { phone: string; name: string; code: string; dccId: number | null; note?: string }[] = [];
  for (const [phone, group] of byPhone) {
    const winner =
      group.find((r) => PREFER.includes(r.code)) ?? group.find(personal) ?? group.find((r) => !!r.name) ?? group[0];
    const others = group.filter((r) => r !== winner);
    plan.push({
      phone,
      name: winner.name || winner.code,
      code: [winner.code, ...others.map((r) => r.code)].filter(Boolean).join(', '),
      dccId: winner.id,
      note: others.length ? `shares the number with ${others.map((r) => `${r.code} ${r.name || ''}(id ${r.id})`.trim()).join(', ')}` : undefined,
    });
  }

  // Only the one column this needs - not the whole schema - so the list can be loaded into a
  // database whose server has not been updated yet. A nullable column nothing else reads.
  if (APPLY) await pool.query(`ALTER TABLE devotees ADD COLUMN IF NOT EXISTS dcc_id INTEGER`);
  const existing = new Map<string, { name: string; code: string | null }>(
    (await pool.query(`SELECT phone, name, code FROM devotees`).catch(() => ({ rows: [] }))).rows.map((r: any) => [r.phone, r])
  );

  let added = 0;
  let updated = 0;
  for (const p of plan) {
    const had = existing.get(p.phone);
    const what = had ? 'update' : 'add   ';
    console.log(`${what} ${p.phone}  ${p.code.padEnd(12)} DCC id ${String(p.dccId ?? '-').padEnd(4)} ${p.name}${p.note ? `   <- ${p.note}` : ''}`);
    if (!APPLY) continue;
    await pool.query(
      `INSERT INTO devotees (name, code, phone, dcc_id, active)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, code = EXCLUDED.code, dcc_id = EXCLUDED.dcc_id, updated_at = NOW()`,
      [p.name.slice(0, 160), p.code.slice(0, 40), p.phone, p.dccId]
    );
    if (had) updated++;
    else added++;
  }
  console.log(`\nskipped ${skipped.length}:`);
  for (const s of skipped) console.log(`  ${s}`);
  const listed = new Set(plan.map((p) => p.phone));
  const notOnList = [...existing.keys()].filter((ph) => !listed.has(ph));
  if (notOnList.length) {
    console.log(`\nalready in DRM but not on this list (left exactly as they are): ${notOnList.length}`);
    for (const ph of notOnList) console.log(`  ${ph}  ${existing.get(ph)!.name}`);
  }
  console.log(APPLY ? `\ndone: ${added} added, ${updated} updated.` : `\nwould load ${plan.length} devotees. Run again with --apply to write.`);
  await pool.end();
}
main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
