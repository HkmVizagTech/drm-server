// Uploading the office's spreadsheets.
//
// HOW THE TEMPLE ACTUALLY WORKS
// The office keeps donor data in Excel: "Last 4 year General Donation Data",
// a festival register, a stall list. A workbook arrives with several tabs, the
// team calls through it, and weeks later a fresher export of the same data
// turns up. That second upload is where a naive importer destroys everything:
// replace the rows and every call, note, reminder and outcome goes with them.
//
// So an upload NEVER replaces. It adds the people who are new, fills gaps on
// the people already here, and leaves everything a caller recorded untouched.
//
// TWO PHASES, AND THE FILE IS STORED BETWEEN THEM
// Uploading parses the workbook and parks every row in lead_import_rows against
// a draft batch. Nothing reaches the leads table yet. The office looks at what
// it would do - how many new, how many already donors, how many bad numbers -
// and only then applies it. Because the rows are stored rather than held in a
// browser tab, the file survives the decision, and months later "what did the
// March sheet say about this donor" is a question with an answer.
//
// MATCHING, IN ORDER
//   1. the office's own donor code (D2, D18) - the best key there is, because
//      people change phone numbers and families share them, but a donor code
//      stays put across every export
//   2. the phone, last ten digits, the same rule the rest of DRM uses
// Only if neither matches is a lead created.

import { Router } from 'express';
import pool from '../db/pool';
import { authenticate } from '../middleware/auth';
import * as storage from '../services/storage';
import { preacherIdForCode, normalizeCode } from './crmPreachers';
import {
  parseWorkbook,
  detectColumns,
  cellText,
  normalizePhone,
  isDialable,
  type SheetData,
  type FieldPattern,
} from '../utils/spreadsheet';

const router = Router();
router.use(authenticate);

/* ---------------------------------------------------------------- helpers */

const str = (v: unknown, max = 255): string | null => {
  const s = cellText(v).trim();
  return s ? s.slice(0, max) : null;
};

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  // cellText, not String: a formula cell arrives as { formula, result } and
  // stringifies to "[object Object]", which would silently read as no money.
  const text = cellText(v).replace(/[^\d.-]/g, '');
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function asDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const text = cellText(v).trim();
  if (!text) return null;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Match a column heading to a field by what the office actually types.
 *
 * Written against the real sheets: "Donor Number", "Mobile Number", "Enrolled
 * By", "Total Amount Donated", "Amount Donated in Last 4 Years", "Last donation
 * date in 4 years". Substring matching rather than exact, because those
 * headings carry years in them that change every export - "Amount Donated from
 * 1stApr2024 to 7thOct2025" must still be recognised next year.
 */
const FIELD_PATTERNS: FieldPattern[] = [
  { field: 'donor_code', any: ['donor number', 'donor no', 'donor code', 'donor id'] },
  { field: 'phone', any: ['mobile', 'phone', 'contact', 'whatsapp', 'number'], not: ['donor'] },
  { field: 'name', any: ['donor name', 'name'], not: ['preacher', 'enrolled'] },
  { field: 'preacher_code', any: ['enrolled by', 'preacher', 'counsellor', 'counselor', 'sevak', 'referred by'] },
  { field: 'account_type', any: ['account type', 'account'] },
  { field: 'last_donation_at', any: ['last donation', 'last date', 'last gave'] },
  // Order matters below: "total amount donated" must win before the looser
  // "amount donated" patterns claim it.
  { field: 'amount_total', any: ['total amount', 'lifetime', 'total donated'] },
  { field: 'amount_recent', any: ['amount donated in', 'amount donated from', 'last 4 year', 'recent amount'] },
  { field: 'remarks', any: ['remark', 'note', 'comment'] },
];

interface ParsedRow {
  row_number: number;
  donor_code: string | null;
  phone: string;
  name: string | null;
  preacher_code: string | null;
  amount_total: number | null;
  amount_recent: number | null;
  last_donation_at: Date | null;
  account_type: string | null;
  remarks: string | null;
  raw: Record<string, unknown>;
}

function parseSheet(sheet: SheetData): { headers: string[]; mapping: Record<string, number>; rows: ParsedRow[] } {
  const headers = sheet.headers.map((h) => (str(h, 120) ?? ''));
  const mapping = detectColumns(headers, FIELD_PATTERNS);
  const at = (values: unknown[], field: string) =>
    mapping[field] === undefined ? null : values[mapping[field]];

  const rows: ParsedRow[] = sheet.rows.map((values, i) => {
    const raw: Record<string, unknown> = {};
    headers.forEach((h, k) => {
      if (h) raw[h] = str(values[k], 300);
    });

    return {
      row_number: sheet.rowNumbers[i],
      donor_code: str(at(values, 'donor_code'), 40),
      phone: normalizePhone(at(values, 'phone')),
      name: str(at(values, 'name'), 255),
      preacher_code: normalizeCode(at(values, 'preacher_code')),
      amount_total: num(at(values, 'amount_total')),
      amount_recent: num(at(values, 'amount_recent')),
      last_donation_at: asDate(at(values, 'last_donation_at')),
      account_type: str(at(values, 'account_type'), 40),
      remarks: str(at(values, 'remarks'), 2000),
      raw,
    };
  });

  return { headers, mapping, rows };
}

/* ------------------------------------------------------------ phase one */

/**
 * POST /import/sheet - read the file and park it, without touching a lead.
 *
 * Returns one draft batch per sheet, each with what it would do. The file is
 * sent as base64 rather than multipart: DRM has exactly one upload in the whole
 * product and adding a multipart parser and its temp-file handling for it would
 * be more moving parts than the feature is worth. express.json's limit is
 * raised in index.ts to carry it.
 */
router.post('/import/sheet', async (req, res) => {
  const filename = str(req.body?.filename, 255) ?? 'upload.xlsx';
  const base64 = String(req.body?.base64 ?? '');
  if (!base64) return res.status(400).json({ error: 'No file received' });

  let sheets: SheetData[];
  try {
    // One parser for .xlsx and .csv alike. A CSV comes back as a single sheet
    // named after the file, so everything below this line is unaware of which
    // one the office happened to save.
    sheets = await parseWorkbook(Buffer.from(base64, 'base64'), filename);
  } catch {
    return res.status(400).json({ error: "That file couldn't be read as a spreadsheet." });
  }
  if (!sheets.length) return res.status(400).json({ error: 'That file has no rows in it.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const batches: Record<string, unknown>[] = [];
    let storedFileKey: string | null = null;
    let storedFileSize: number | null = null;

    for (const ws of sheets) {
      const { headers, mapping, rows } = parseSheet(ws);
      if (!rows.length) continue;

      // Without a phone there is nobody to ring, so a sheet with no phone
      // column is refused loudly rather than imported into a list of names
      // nobody can call.
      if (mapping.phone === undefined) {
        batches.push({
          sheet_name: ws.name,
          error: 'No phone column found',
          headers,
          rows_total: rows.length,
        });
        continue;
      }

      // Same NUMBER twice in one sheet is one call, not two.
      //
      // Keyed on the phone, not the donor code, and that distinction matters
      // here: a lead IS a phone number (leads.phone is unique), and the real
      // sheet carries 6,348 unique donor codes across only 5,452 distinct
      // numbers - families and businesses sharing a line. Keying on the code
      // would report 6,286 new leads and then quietly create 5,452, because
      // the upsert would fold the rest together. The preview has to be honest
      // about that up front, since deciding whether to apply an import is the
      // entire reason it exists.
      //
      // The LAST occurrence wins: later rows in these exports are the fresher
      // ones, so the earlier duplicate is the one marked.
      const seen = new Map<string, number>();
      const outcomes: ParsedRow[] = [];
      for (const r of rows) {
        const key = isDialable(r.phone) ? `p:${r.phone}` : r.donor_code ? `c:${r.donor_code}` : `r:${r.row_number}`;
        const prev = seen.get(key);
        if (prev !== undefined) {
          outcomes[prev] = { ...outcomes[prev], outcome: 'duplicate_in_file' } as ParsedRow;
        }
        seen.set(key, outcomes.length);
        outcomes.push(r);
      }

      const dialable = rows.filter((r) => isDialable(r.phone));
      const phones = [...new Set(dialable.map((r) => r.phone))];
      const codes = [...new Set(rows.map((r) => r.donor_code).filter(Boolean))] as string[];

      const [existingLeads, existingPeople] = await Promise.all([
        client.query(
          `SELECT phone, donor_code FROM leads WHERE phone = ANY($1::text[]) OR donor_code = ANY($2::text[])`,
          [phones, codes]
        ),
        client.query(
          `SELECT right(regexp_replace(phone,'\\D','','g'), 10) AS p, donor_code
             FROM people
            WHERE right(regexp_replace(phone,'\\D','','g'), 10) = ANY($1::text[]) OR donor_code = ANY($2::text[])`,
          [phones, codes]
        ),
      ]);
      const leadPhones = new Set(existingLeads.rows.map((r) => r.phone));
      const leadCodes = new Set(existingLeads.rows.map((r) => r.donor_code).filter(Boolean));
      const donorPhones = new Set(existingPeople.rows.map((r) => r.p));
      const donorCodes = new Set(existingPeople.rows.map((r) => r.donor_code).filter(Boolean));

      const counts = { new: 0, updated: 0, duplicate_in_file: 0, invalid_phone: 0, no_phone: 0, already_donors: 0 };

      const classified = outcomes.map((r) => {
        let outcome: string;
        if ((r as ParsedRow & { outcome?: string }).outcome === 'duplicate_in_file') outcome = 'duplicate_in_file';
        else if (!r.phone) outcome = 'no_phone';
        else if (!isDialable(r.phone)) outcome = 'invalid_phone';
        else if ((r.donor_code && leadCodes.has(r.donor_code)) || leadPhones.has(r.phone)) outcome = 'updated';
        else outcome = 'new';

        counts[outcome as keyof typeof counts]++;
        if (outcome === 'new' && ((r.donor_code && donorCodes.has(r.donor_code)) || donorPhones.has(r.phone))) {
          counts.already_donors++;
        }
        return { ...r, outcome };
      });

      const preacherCodes = [...new Set(rows.map((r) => r.preacher_code).filter(Boolean))] as string[];
      const externalTotal = rows.reduce((s, r) => s + (r.amount_total ?? 0), 0);

      // Lifetime giving on rows nobody can ring, because the number is missing
      // or malformed. On the real workbook that is 55.5 lakh across 34 rows -
      // worth naming in the preview, because the fix is in the source sheet and
      // nobody will go looking unless they are told the figure.
      const unreachableAmount = classified
        .filter((r) => r.outcome === 'invalid_phone' || r.outcome === 'no_phone')
        .reduce((sum, r) => sum + (r.amount_total ?? 0), 0);
      // And giving that sits on a second account behind a number already in the
      // sheet. Not lost - it is added onto that lead - but the office should
      // know the figure is a household's, not one donor's.
      const sharedAmount = classified
        .filter((r) => r.outcome === 'duplicate_in_file')
        .reduce((sum, r) => sum + (r.amount_total ?? 0), 0);

      const batch = await client.query(
        `INSERT INTO lead_import_batches
           (filename, sheet_name, uploaded_by, rows_total, matched_existing_donors, detail, status)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,'draft') RETURNING *`,
        [
          filename,
          ws.name,
          req.user?.userId ?? null,
          rows.length,
          counts.already_donors,
          JSON.stringify({
            headers, mapping, counts,
            preacher_codes: preacherCodes,
            external_total: externalTotal,
            unreachable_amount: unreachableAmount,
            shared_amount: sharedAmount,
          }),
        ]
      );
      const batchId = batch.rows[0].id;

      // Parked in chunks: one INSERT per row would be 8,500 round trips on a
      // real sheet, and a single statement with 8,500 parameter sets exceeds
      // Postgres's 65,535 parameter limit.
      const CHUNK = 500;
      for (let i = 0; i < classified.length; i += CHUNK) {
        const slice = classified.slice(i, i + CHUNK);
        const values: unknown[] = [];
        const tuples = slice.map((r, k) => {
          const b = k * 12;
          values.push(
            batchId, r.row_number, r.donor_code, r.phone || null, r.name, r.preacher_code,
            r.amount_total, r.amount_recent, r.last_donation_at, r.account_type, r.remarks,
            JSON.stringify(r.raw)
          );
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12}::jsonb)`;
        });
        await client.query(
          `INSERT INTO lead_import_rows
             (batch_id, row_number, donor_code, phone, name, preacher_code,
              amount_total, amount_recent, last_donation_at, account_type, remarks, raw)
           VALUES ${tuples.join(',')}`,
          values
        );
      }
      // The outcome column is set separately so the bulk insert above stays one
      // shape; a CASE over 8,500 rows is a single cheap statement.
      for (const outcome of ['new', 'updated', 'duplicate_in_file', 'invalid_phone', 'no_phone']) {
        const nums = classified.filter((r) => r.outcome === outcome).map((r) => r.row_number);
        if (!nums.length) continue;
        await client.query(
          `UPDATE lead_import_rows SET outcome = $1 WHERE batch_id = $2 AND row_number = ANY($3::int[])`,
          [outcome, batchId, nums]
        );
      }

      // The original file, kept beside the rows parsed out of it.
      //
      // lead_import_rows already answers "what did the March sheet say about
      // this donor". What it cannot answer is "send me the file" - and
      // somebody asking that wants the workbook, with its formatting and its
      // other tabs, not a reconstruction of it.
      //
      // Stored ONCE per upload, and pointed at by EVERY batch it produced.
      //
      // A workbook with three tabs makes three batches. Storing three copies
      // of one file would be three times the bytes for no extra answer - but
      // setting file_key on only the first batch is worse: the other two would
      // show a Download button that 404s, because the object exists and their
      // row does not know about it. One object, three references.
      if (storage.isConfigured() && !storedFileKey) {
        const key = storage.keys.importFile(batchId, filename);
        const put = await storage.putObject(
          key,
          Buffer.from(base64, 'base64'),
          filename.toLowerCase().endsWith('.csv')
            ? 'text/csv'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        if (put.ok) {
          storedFileKey = key;
          storedFileSize = Buffer.byteLength(base64, 'base64');
        }
        // A failed store is not a failed import. The rows are in; the file
        // being unkept is a smaller loss than refusing an upload the office
        // has already done.
      }

      batches.push({
        ...batch.rows[0],
        headers,
        mapping,
        counts,
        preacher_codes: preacherCodes,
        external_total: externalTotal,
        unreachable_amount: unreachableAmount,
        shared_amount: sharedAmount,
        samples: {
          new: classified.filter((r) => r.outcome === 'new').slice(0, 6),
          updated: classified.filter((r) => r.outcome === 'updated').slice(0, 6),
          invalid: classified.filter((r) => r.outcome === 'invalid_phone' || r.outcome === 'no_phone').slice(0, 6),
        },
      });
    }

    // Every batch from this upload points at the one stored object, so a
    // workbook's second and third tabs offer the same file rather than a
    // button that fails.
    if (storedFileKey && batches.length) {
      await client.query(
        `UPDATE lead_import_batches SET file_key = $2, file_size = $3, file_type = $4
          WHERE id = ANY($1::uuid[])`,
        [
          batches.map((b) => b.id).filter(Boolean),
          storedFileKey,
          storedFileSize,
          filename.split('.').pop()?.toLowerCase() ?? null,
        ]
      );
      for (const b of batches) b.file_key = storedFileKey;
    }

    await client.query('COMMIT');
    if (!batches.length) return res.status(400).json({ error: 'That file has no rows in it.' });
    res.json({ filename, batches });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('crm.importSheet error:', err);
    res.status(500).json({ error: 'Could not read that file' });
  } finally {
    client.release();
  }
});

/* ------------------------------------------------------------ phase two */

/**
 * POST /import/batches/:id/apply - write the parked rows into leads.
 *
 * Every field is filled with COALESCE so an import can only ever fill a gap,
 * never overwrite something a caller learned on the phone. The one exception is
 * the giving figures from the office's accounts, which the sheet is by
 * definition more current about than DRM is.
 */
router.post('/import/batches/:id/apply', async (req, res) => {
  const b = req.body ?? {};
  const assignedTo = str(b.assigned_to, 36);
  const extraTags: string[] = Array.isArray(b.tags) ? b.tags.map((t: unknown) => String(t).slice(0, 40)) : [];
  const skipExisting = b.skip_existing === true;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const batchRow = await client.query(`SELECT * FROM lead_import_batches WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!batchRow.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That upload no longer exists' });
    }
    if (batchRow.rows[0].status === 'applied') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'That upload has already been applied.' });
    }

    const batch = batchRow.rows[0];
    const listName = str(b.list_name, 160) ?? `${batch.filename}${batch.sheet_name ? ` — ${batch.sheet_name}` : ''}`;

    // ONE ROW PER PHONE, with the money added up.
    //
    // A lead is a phone number, but the sheet is a list of donor ACCOUNTS, and
    // the real workbook has 6,348 codes across 5,452 numbers. Taking one row
    // per number and ignoring the rest would drop 2.12 crore of lifetime giving
    // off the calling screen - the second account of a family or a business
    // that shares a line. So every row for a number contributes its totals, and
    // the count of accounts travels with them so the screen can say "across 2
    // accounts" instead of passing a sum off as one donor's.
    //
    // DISTINCT ON picks the last row for the identity fields, because later
    // rows in these exports are the fresher ones.
    const rows = await client.query(
      `SELECT DISTINCT ON (agg.phone)
              agg.phone,
              agg.total_amount        AS amount_total,
              agg.recent_amount       AS amount_recent,
              agg.last_at             AS last_donation_at,
              agg.account_count,
              r.id, r.name, r.preacher_code, r.donor_code, r.account_type, r.remarks, r.row_number
         FROM lead_import_rows r
         JOIN (
           SELECT phone,
                  SUM(amount_total)  AS total_amount,
                  SUM(amount_recent) AS recent_amount,
                  MAX(last_donation_at) AS last_at,
                  COUNT(*)::int      AS account_count
             FROM lead_import_rows
            WHERE batch_id = $1 AND outcome IN ('new','updated','duplicate_in_file')
              AND phone IS NOT NULL
            GROUP BY phone
         ) agg ON agg.phone = r.phone
        WHERE r.batch_id = $1 AND r.outcome IN ('new','updated','duplicate_in_file')
        ORDER BY agg.phone, r.row_number DESC`,
      [req.params.id]
    );

    // Resolve every preacher code once rather than per row; a sheet of 8,500
    // rows carries about 27 distinct codes.
    const codes = [...new Set(rows.rows.map((r) => r.preacher_code).filter(Boolean))] as string[];
    const preacherByCode = new Map<string, string>();
    for (const code of codes) {
      const id = await preacherIdForCode(code, client);
      if (id) preacherByCode.set(code, id);
    }

    let added = 0;
    let updated = 0;
    let skipped = 0;

    for (const r of rows.rows) {
      if (skipExisting && r.was_existing) { skipped++; continue; }

      // The person this donor already is in DRM, if they are one. Matching on
      // the donor code first and the phone second, the same order the preview
      // reported.
      const person = await client.query(
        `SELECT id, name, email FROM people
          WHERE ($1::text IS NOT NULL AND donor_code = $1::text)
             OR right(regexp_replace(phone,'\\D','','g'), 10) = $2
          LIMIT 1`,
        [r.donor_code, r.phone]
      );
      const personId = person.rows[0]?.id ?? null;
      const preacherId = r.preacher_code ? preacherByCode.get(r.preacher_code) ?? null : null;

      const result = await client.query(
        `INSERT INTO leads
           (phone, name, person_id, source, source_detail, status, assigned_to, assigned_at,
            tags, remarks, created_by, preacher_id, donor_code, import_batch_id,
            external_total_donated, external_recent_donated, external_last_donation_at,
            external_source, external_account_type, external_account_count)
         VALUES ($1::text, $2::text, $3::uuid, 'csv', $4::text, 'new', $5::uuid,
                 CASE WHEN $5::uuid IS NULL THEN NULL ELSE NOW() END,
                 $6::text[], $7::text, $8::uuid, $9::uuid, $10::text, $11::uuid,
                 $12::numeric, $13::numeric, $14::timestamptz, $15::text, $16::text, $17::int)
         ON CONFLICT (phone) DO UPDATE SET
           -- Gaps only. A caller's work outranks a spreadsheet on everything
           -- they could have learned on the phone.
           name              = COALESCE(leads.name, EXCLUDED.name),
           person_id         = COALESCE(EXCLUDED.person_id, leads.person_id),
           preacher_id       = COALESCE(leads.preacher_id, EXCLUDED.preacher_id),
           donor_code        = COALESCE(leads.donor_code, EXCLUDED.donor_code),
           source_detail     = COALESCE(leads.source_detail, EXCLUDED.source_detail),
           tags              = ARRAY(SELECT DISTINCT unnest(leads.tags || EXCLUDED.tags)),
           -- The accounts ARE more current than DRM on lifetime giving, so
           -- these are the one group of fields a re-upload refreshes outright.
           external_total_donated    = COALESCE(EXCLUDED.external_total_donated, leads.external_total_donated),
           external_recent_donated   = COALESCE(EXCLUDED.external_recent_donated, leads.external_recent_donated),
           external_last_donation_at = COALESCE(EXCLUDED.external_last_donation_at, leads.external_last_donation_at),
           external_account_type     = COALESCE(EXCLUDED.external_account_type, leads.external_account_type),
           external_account_count    = COALESCE(EXCLUDED.external_account_count, leads.external_account_count),
           updated_at        = NOW()
         RETURNING id, (xmax = 0) AS was_inserted`,
        [
          r.phone,
          r.name,
          personId,
          listName,
          assignedTo,
          [...(r.account_type ? [String(r.account_type).toLowerCase()] : []), ...extraTags],
          r.remarks,
          req.user?.userId ?? null,
          preacherId,
          r.donor_code,
          req.params.id,
          r.amount_total,
          r.amount_recent,
          r.last_donation_at,
          `${batch.filename}${batch.sheet_name ? ` (${batch.sheet_name})` : ''}`,
          r.account_type,
          r.account_count,
        ]
      );

      const lead = result.rows[0];
      if (lead.was_inserted) added++; else updated++;

      await client.query(`UPDATE lead_import_rows SET lead_id = $1 WHERE id = $2`, [lead.id, r.id]);

      // Carry the preacher and the donor code onto the donor record too, so
      // the donation screens can filter by preacher without going through a
      // lead that may never exist.
      if (personId) {
        await client.query(
          `UPDATE people SET
             preacher_id = COALESCE(preacher_id, $1::uuid),
             donor_code  = COALESCE(donor_code, $2::text)
           WHERE id = $3`,
          [preacherId, r.donor_code, personId]
        );
      }
    }

    await client.query(
      `UPDATE lead_import_batches SET
         leads_added = $1, leads_updated = $2, rows_skipped = $3,
         label = COALESCE($4, label), status = 'applied', applied_at = NOW(), applied_by = $5
       WHERE id = $6`,
      [added, updated, skipped, listName, req.user?.userId ?? null, req.params.id]
    );

    // Every applied sheet becomes a calling list of its own.
    //
    // Without this, uploading a sheet and then calling it would be two
    // unrelated chores - upload here, go build a matching list there - and the
    // second one would be skipped, leaving the sheet sitting in the global
    // queue mixed in with everything else. The list is just the filter
    // "leads from this batch", so it stays correct as leads convert or go
    // do-not-call, and it can be retired without touching a single lead.
    const listRow = await client.query(
      `INSERT INTO calling_lists (name, import_batch_id, origin, created_by)
       VALUES ($1, $2::uuid, 'import', $3::uuid)
       RETURNING id`,
      [listName.slice(0, 160), req.params.id, req.user?.userId ?? null]
    );

    await client.query('COMMIT');
    res.json({ added, updated, skipped, list_name: listName, list_id: listRow.rows[0]?.id ?? null });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('crm.applyImport error:', err);
    res.status(500).json({ error: 'Could not apply that upload' });
  } finally {
    client.release();
  }
});

/* --------------------------------------------------------------- history */

router.get('/import/batches', async (_req, res) => {
  try {
    const rows = await pool.query(
      `SELECT b.*, u.name AS uploaded_by_name,
              (SELECT COUNT(*)::int FROM lead_import_rows r WHERE r.batch_id = b.id) AS stored_rows
         FROM lead_import_batches b
         LEFT JOIN users u ON b.uploaded_by = u.id
        ORDER BY b.created_at DESC LIMIT 100`
    );
    res.json({ batches: rows.rows });
  } catch (err) {
    console.error('crm.listBatches error:', err);
    res.status(500).json({ error: 'Could not load the upload history' });
  }
});

router.get('/import/batches/:id', async (req, res) => {
  const outcome = String(req.query.outcome ?? '');
  try {
    const [batch, rows] = await Promise.all([
      pool.query(
        `SELECT b.*, u.name AS uploaded_by_name FROM lead_import_batches b
           LEFT JOIN users u ON b.uploaded_by = u.id WHERE b.id = $1`,
        [req.params.id]
      ),
      pool.query(
        `SELECT r.*, l.name AS lead_name, l.status AS lead_status
           FROM lead_import_rows r
           LEFT JOIN leads l ON r.lead_id = l.id
          WHERE r.batch_id = $1 ${outcome ? 'AND r.outcome = $2' : ''}
          ORDER BY r.row_number LIMIT 500`,
        outcome ? [req.params.id, outcome] : [req.params.id]
      ),
    ]);
    if (!batch.rows.length) return res.status(404).json({ error: 'That upload no longer exists' });
    res.json({ batch: batch.rows[0], rows: rows.rows });
  } catch (err) {
    console.error('crm.getBatch error:', err);
    res.status(500).json({ error: 'Could not load that upload' });
  }
});

/**
 * GET /import/batches/:id/file - the workbook the office actually sent.
 *
 * Streamed through DRM rather than handed out as a bucket link: this is the
 * donor list, and a public URL to it would outlive anybody's access to DRM.
 */
router.get('/import/batches/:id/file', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT file_key, filename, file_type FROM lead_import_batches WHERE id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'That upload no longer exists' });
    const b = r.rows[0];
    if (!b.file_key) {
      return res.status(404).json({
        error: storage.isConfigured()
          ? 'The original file was not kept for this upload. Its rows are all still here.'
          : 'File storage is not set up, so original uploads are not kept. The rows are all still here.',
      });
    }

    const buf = await storage.getObject(b.file_key);
    if (!buf) return res.status(404).json({ error: 'That file is no longer in storage.' });

    res.setHeader(
      'Content-Type',
      b.file_type === 'csv'
        ? 'text/csv; charset=utf-8'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${storage.safeName(b.filename)}"`);
    res.send(buf);
  } catch (err) {
    console.error('crm.batchFile error:', err);
    res.status(500).json({ error: 'Could not fetch that file' });
  }
});

// Throwing away a draft that was never applied. An applied batch is history and
// stays: leads point at it, and "where did this person come from" must keep
// working.
router.delete('/import/batches/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM lead_import_batches WHERE id = $1 AND status = 'draft' RETURNING id`,
      [req.params.id]
    );
    if (!result.rows.length) {
      return res.status(409).json({ error: 'Only an upload that was never applied can be discarded.' });
    }
    res.json({ discarded: true });
  } catch (err) {
    console.error('crm.discardBatch error:', err);
    res.status(500).json({ error: 'Could not discard that upload' });
  }
});

export default router;
