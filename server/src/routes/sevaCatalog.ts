// The seva catalog: the list of sevas a receipt can be raised for, and the Seva
// Code DCC expects with each. Managed here; offered as a dropdown wherever DRM
// raises a receipt for the main site.
//
// Nothing is deleted. A seva is switched off (is_active) to stop it being offered.

import { Router } from 'express';
import pool from '../db/pool';
import { authenticate, authorize } from '../middleware/auth';
import { rowToSeva } from '../services/sevaCatalog';

const router = Router();
router.use(authenticate);

const text = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max);
const nullish = (v: unknown): string => {
  const t = String(v ?? '').trim();
  return /^null$/i.test(t) ? '' : t;
};
const int = (v: unknown): number | null => {
  const t = nullish(v);
  return /^\d+$/.test(t) ? Number(t) : null;
};
const flag = (v: unknown): boolean | null => {
  const t = nullish(v).toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(t)) return true;
  if (['0', 'false', 'no', 'n'].includes(t)) return false;
  return null;
};

// Everybody who raises receipts reads the list; only an admin changes it.
router.get('/', async (req, res) => {
  const onlyActive = String(req.query.active ?? '') === 'true';
  try {
    const r = await pool.query(
      `SELECT * FROM seva_catalog ${onlyActive ? 'WHERE is_active' : ''}
        ORDER BY category_id, category, sub_category, sub_code NULLS FIRST, sub_code_id`
    );
    res.json({ sevas: r.rows.map(rowToSeva), total: r.rowCount });
  } catch (err) {
    console.error('seva-catalog list error:', (err as Error).message);
    res.status(500).json({ error: 'Could not load the seva list.' });
  }
});

interface Fields {
  category: string; categoryId: number; code: string; subCategory: string; subCategoryId: number;
  subCode: string | null; subCodeId: number | null; taxExempted: boolean | null; active: boolean;
}

/** Check one seva's fields. Returns the clean fields or a sentence saying what is wrong. */
function clean(b: Record<string, unknown>): { fields?: Fields; error?: string } {
  const category = text(b.category, 160);
  const code = text(b.code, 60);
  const subCategory = text(b.sub_category, 200);
  const subCode = nullish(b.sub_code).slice(0, 200) || null;
  const categoryId = int(b.category_id);
  const subCategoryId = int(b.sub_category_id);
  const subCodeId = int(b.sub_code_id);
  const problems: string[] = [];
  if (!category) problems.push('Seva category is missing');
  if (categoryId === null) problems.push('Seva category ID must be a number');
  if (!code) problems.push('Seva code is missing');
  if (!subCategory) problems.push('Seva sub category is missing');
  if (subCategoryId === null) problems.push('Seva sub category ID must be a number');
  if (subCode && subCodeId === null) problems.push('A seva sub code needs its ID (a number)');
  if (!subCode && nullish(b.sub_code_id)) problems.push('A sub code ID needs the sub code name');
  if (problems.length) return { error: problems.join('. ') + '.' };
  return {
    fields: {
      category, categoryId: categoryId!, code, subCategory, subCategoryId: subCategoryId!,
      subCode, subCodeId: subCode ? subCodeId : null,
      taxExempted: flag(b.is_tax_exempted),
      active: b.is_active === undefined ? true : flag(b.is_active) !== false,
    },
  };
}

/**
 * A sub category id names ONE sub category: the same id with a different name,
 * code or category is a mistake that would send DCC the wrong code.
 */
async function conflictingSubCategory(f: Fields, ignoreId?: string): Promise<string | null> {
  const r = await pool.query(
    `SELECT category, category_id, code, sub_category FROM seva_catalog
      WHERE sub_category_id = $1 ${ignoreId ? 'AND id <> $2' : ''} LIMIT 1`,
    ignoreId ? [f.subCategoryId, ignoreId] : [f.subCategoryId]
  );
  const o = r.rows[0];
  if (!o) return null;
  if (o.category === f.category && o.category_id === f.categoryId && o.code === f.code && o.sub_category === f.subCategory) return null;
  return `Sub category ID ${f.subCategoryId} already belongs to "${o.sub_category}" (${o.code}) under ${o.category}.`;
}

router.post('/', authorize('admin'), async (req, res) => {
  const { fields: f, error } = clean(req.body ?? {});
  if (!f) return res.status(400).json({ error });
  try {
    const clash = await conflictingSubCategory(f);
    if (clash) return res.status(409).json({ error: clash });
    const r = await pool.query(
      `INSERT INTO seva_catalog
         (category, category_id, code, sub_category, sub_category_id, sub_code, sub_code_id, is_tax_exempted, is_active, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual')
       RETURNING *`,
      [f.category, f.categoryId, f.code, f.subCategory, f.subCategoryId, f.subCode, f.subCodeId, f.taxExempted, f.active]
    );
    res.status(201).json({ seva: rowToSeva(r.rows[0]) });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'That seva is already in the list (same sub category and sub code ID).' });
    }
    console.error('seva-catalog add error:', (err as Error).message);
    res.status(500).json({ error: 'Could not add the seva.' });
  }
});

// Edit a seva. The IDs are its identity and stay as they are; everything else, and
// switching it off, can change.
router.patch('/:id', authorize('admin'), async (req, res) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(404).json({ error: 'Seva not found.' });
  try {
    const cur = await pool.query('SELECT * FROM seva_catalog WHERE id = $1', [id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'Seva not found.' });
    const o = cur.rows[0];
    const b = req.body ?? {};
    const merged = {
      category: b.category ?? o.category, category_id: o.category_id, code: b.code ?? o.code,
      sub_category: b.sub_category ?? o.sub_category, sub_category_id: o.sub_category_id,
      sub_code: b.sub_code !== undefined ? b.sub_code : o.sub_code, sub_code_id: o.sub_code_id,
      is_tax_exempted: b.is_tax_exempted !== undefined ? b.is_tax_exempted : o.is_tax_exempted,
      is_active: b.is_active !== undefined ? b.is_active : o.is_active,
    };
    const { fields: f, error } = clean(merged);
    if (!f) return res.status(400).json({ error });
    const clash = await conflictingSubCategory(f, id);
    if (clash) return res.status(409).json({ error: clash });
    const r = await pool.query(
      `UPDATE seva_catalog
          SET category = $2, code = $3, sub_category = $4, sub_code = $5, is_tax_exempted = $6, is_active = $7, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [id, f.category, f.code, f.subCategory, f.subCode, f.taxExempted, f.active]
    );
    res.json({ seva: rowToSeva(r.rows[0]) });
  } catch (err) {
    console.error('seva-catalog edit error:', (err as Error).message);
    res.status(500).json({ error: 'Could not save the seva.' });
  }
});

/* ------------------------------------------------------------------ import */

// Column headings in the temple's sheet, lower-cased with punctuation dropped.
// "IsTaxEempted" is how the sheet spells it, so both spellings are accepted.
const HEADINGS: Record<string, string[]> = {
  category: ['sevacategory'],
  code: ['sevacode'],
  sub_category: ['sevasubcategory'],
  sub_code: ['sevasubcode'],
  category_id: ['sevacategoryid'],
  sub_category_id: ['sevasubcategoryid'],
  sub_code_id: ['sevasubcategorycodeid', 'sevasubcodeid'],
  is_active: ['isactive'],
  is_tax_exempted: ['istaxeempted', 'istaxexempted'],
  account_type: ['accounttype'],
};
const squash = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Upload the temple's sheet. Existing sevas are compared with the sheet, not
// replaced blindly: the result says which are new, which differ (and how), and
// which already match, so a misread value in the list is found rather than sent
// to DCC. Whether a seva is switched on is DRM's own decision and an import does not
// flip it for an existing row. With dry_run nothing is written.
router.post('/import', authorize('admin'), async (req, res) => {
  const headers: string[] = Array.isArray(req.body?.headers) ? req.body.headers.map(String) : [];
  const rows: unknown[][] = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const numbers: number[] = Array.isArray(req.body?.row_numbers) ? req.body.row_numbers.map(Number) : [];
  const dryRun = req.body?.dry_run !== false;
  if (!headers.length || !rows.length) return res.status(400).json({ error: 'The file has no rows.' });
  if (rows.length > 3000) return res.status(400).json({ error: 'Upload 3,000 rows or fewer at a time.' });

  const col: Record<string, number> = {};
  headers.forEach((h, i) => {
    for (const [field, names] of Object.entries(HEADINGS)) {
      if (col[field] === undefined && names.includes(squash(h))) col[field] = i;
    }
  });
  const need = ['category', 'code', 'sub_category', 'category_id', 'sub_category_id'];
  const missing = need.filter((f) => col[f] === undefined);
  if (missing.length) {
    return res.status(400).json({ error: `The file needs these columns: ${missing.join(', ')}.`, missing });
  }

  type Issue = { row: number; status: 'problem' | 'repeated'; message: string };
  type Change = { row: number; seva: string; fields: { field: string; from: unknown; to: unknown }[] };
  const issues: Issue[] = [];
  const changes: Change[] = [];
  const toAdd: { f: Fields; at: number }[] = [];
  const toUpdate: { id: string; f: Fields }[] = [];
  const seen = new Map<string, number>();
  let same = 0;

  try {
    const existing = await pool.query('SELECT * FROM seva_catalog');
    const byKey = new Map(existing.rows.map((r) => [`${r.sub_category_id}:${r.sub_code_id ?? 0}`, r]));
    const subCats = new Map<number, string>();
    for (const r of existing.rows) subCats.set(r.sub_category_id, `${r.category}|${r.category_id}|${r.code}|${r.sub_category}`);

    for (let i = 0; i < rows.length; i++) {
      const at = numbers[i] ?? i + 2;
      const raw: Record<string, unknown> = {};
      for (const [f, ix] of Object.entries(col)) raw[f] = rows[i][ix];
      if (Object.values(raw).every((v) => !nullish(v))) continue; // a blank line
      const { fields: f, error } = clean({ ...raw, is_active: nullish(raw.is_active) === '' ? undefined : raw.is_active });
      if (!f) {
        issues.push({ row: at, status: 'problem', message: error! });
        continue;
      }
      const key = `${f.subCategoryId}:${f.subCodeId ?? 0}`;
      if (seen.has(key)) {
        issues.push({ row: at, status: 'repeated', message: `repeated in this file (same as row ${seen.get(key)})` });
        continue;
      }
      seen.set(key, at);

      const sig = `${f.category}|${f.categoryId}|${f.code}|${f.subCategory}`;
      const known = subCats.get(f.subCategoryId);
      if (known && known !== sig) {
        issues.push({ row: at, status: 'problem', message: `sub category ID ${f.subCategoryId} is "${known.split('|')[3]}" in DRM but "${f.subCategory}" here` });
        continue;
      }
      subCats.set(f.subCategoryId, sig);

      const cur = byKey.get(key);
      if (!cur) {
        toAdd.push({ f, at });
        continue;
      }
      const diff: Change['fields'] = [];
      const cmp = (field: string, from: unknown, to: unknown) => {
        if ((from ?? null) !== (to ?? null)) diff.push({ field, from: from ?? null, to: to ?? null });
      };
      cmp('Seva category', cur.category, f.category);
      cmp('Seva code', cur.code, f.code);
      cmp('Seva sub category', cur.sub_category, f.subCategory);
      cmp('Seva sub code', cur.sub_code, f.subCode);
      cmp('Tax exempted', cur.is_tax_exempted, f.taxExempted);
      if (diff.length) {
        changes.push({ row: at, seva: `${f.subCategory}${f.subCode ? ' - ' + f.subCode : ''}`, fields: diff });
        toUpdate.push({ id: cur.id, f });
      } else {
        same++;
      }
    }

    // Sevas in DRM that this file does not mention: reported, never touched.
    const notInFile = existing.rows.filter((r) => !seen.has(`${r.sub_category_id}:${r.sub_code_id ?? 0}`)).length;

    if (!dryRun) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const { f } of toAdd) {
          await client.query(
            `INSERT INTO seva_catalog
               (category, category_id, code, sub_category, sub_category_id, sub_code, sub_code_id, is_tax_exempted, is_active, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'import')`,
            [f.category, f.categoryId, f.code, f.subCategory, f.subCategoryId, f.subCode, f.subCodeId, f.taxExempted, f.active]
          );
        }
        for (const { id, f } of toUpdate) {
          await client.query(
            `UPDATE seva_catalog SET category = $2, code = $3, sub_category = $4, sub_code = $5, is_tax_exempted = $6,
                    source = 'import', updated_at = NOW() WHERE id = $1`,
            [id, f.category, f.code, f.subCategory, f.subCode, f.taxExempted]
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    }

    res.json({
      dry_run: dryRun,
      new: toAdd.length,
      changed: toUpdate.length,
      same,
      problems: issues.filter((x) => x.status === 'problem').length,
      repeated: issues.filter((x) => x.status === 'repeated').length,
      not_in_file: notInFile,
      issues: issues.slice(0, 200),
      changes: changes.slice(0, 200),
    });
  } catch (err) {
    console.error('seva-catalog import error:', (err as Error).message);
    res.status(500).json({ error: 'Could not import the sheet. Nothing was changed.' });
  }
});

export default router;
