// The seva catalog: what a receipt can be raised for, and the code DCC wants.

import pool from '../db/pool';
import { seedRows } from '../db/sevaCatalogSeed';

export interface Seva {
  id: string;
  accountType: string;
  category: string;
  categoryId: number;
  code: string;
  subCategory: string;
  subCategoryId: number;
  subCode: string | null;
  subCodeId: number | null;
  isActive: boolean;
  taxExempted: boolean | null;
  /** What goes on the receipt as the seva's name. */
  name: string;
}

type Db = { query: (sql: string, values?: unknown[]) => Promise<{ rowCount: number | null; rows: any[] }> };

/**
 * The three values DCC's addDonation call takes for a seva - the same three the main
 * site posts to DCC: the Seva Category ID, the Seva Sub Category ID, and the sub code
 * ID where the seva has sub sevas (otherwise the Seva Code text, e.g. "BSC").
 */
export interface DccSeva {
  category: number;
  subCategory: number;
  subCategoryCode: number | string;
}

/**
 * The account type DCC is told for a seva: 5 for a TSC seva, 4 for everything else
 * (HKMI). Decided here from the catalog row, so a browser cannot choose it.
 */
export function dccAccountTypeOf(s: Seva | null | undefined): number {
  return s?.accountType === 'TSC' ? 5 : 4;
}

export function dccSevaOf(s: Seva): DccSeva {
  return { category: s.categoryId, subCategory: s.subCategoryId, subCategoryCode: s.subCodeId ?? s.code };
}

/** "Deepotsava - Annadana Seva", or just "Brick Seva" when there is no sub code. */
export function sevaName(subCategory: string, subCode: string | null): string {
  return subCode ? `${subCategory} - ${subCode}` : subCategory;
}

export function rowToSeva(r: any): Seva {
  return {
    id: r.id,
    accountType: r.account_type,
    category: r.category,
    categoryId: r.category_id,
    code: r.code,
    subCategory: r.sub_category,
    subCategoryId: r.sub_category_id,
    subCode: r.sub_code,
    subCodeId: r.sub_code_id,
    isActive: r.is_active,
    taxExempted: r.is_tax_exempted,
    name: sevaName(r.sub_category, r.sub_code),
  };
}

/**
 * The seva behind a catalog id, only if it is still on offer. Receipts resolve it
 * here on the server instead of trusting the name and code a browser sends, so the
 * code that reaches DCC is always one that is in the catalog.
 */
export async function resolveSeva(id: unknown, db: Db = pool, opts: { allowInactive?: boolean } = {}): Promise<Seva | null> {
  const s = String(id ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(s)) return null;
  // allowInactive: for a seva ALREADY chosen on a payment or entry. If it was
  // switched off after that, a retry must still send what the first attempt said.
  const r = await db.query(`SELECT * FROM seva_catalog WHERE id = $1 ${opts.allowInactive ? '' : 'AND is_active'}`, [s]);
  return r.rows[0] ? rowToSeva(r.rows[0]) : null;
}

/**
 * Put the temple's seva list in on first start, when the catalog is empty. It
 * never touches a catalog that already has rows, so nothing an admin added, edited
 * or switched off is undone by a restart.
 */
export async function seedSevaCatalog(db: Db = pool): Promise<number> {
  // The HKMI list only: the TSC sevas are put in by the schema, so a catalog with just those is still empty here.
  const have = await db.query("SELECT 1 FROM seva_catalog WHERE account_type = 'HKMI' LIMIT 1");
  if (have.rowCount) return 0;
  let added = 0;
  for (const r of seedRows()) {
    const res = await db.query(
      `INSERT INTO seva_catalog
         (category, category_id, code, sub_category, sub_category_id, sub_code, sub_code_id, is_tax_exempted, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'seed')
       ON CONFLICT (account_type, sub_category_id, COALESCE(sub_code_id, 0)) DO NOTHING`,
      [r.category, r.categoryId, r.code, r.subCategory, r.subCategoryId, r.subCode, r.subCodeId, r.taxExempted]
    );
    added += res.rowCount ?? 0;
  }
  return added;
}
