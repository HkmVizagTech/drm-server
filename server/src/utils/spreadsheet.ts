// Reading a spreadsheet, whatever the office happened to save it as.
//
// WHY THIS IS SHARED RATHER THAN PER-SCREEN
// DRM takes uploads in three places - the donor sheets, the courier's prasadam
// file, and a quick lead list - and every one of them was written to its own
// taste. The donor sheets read .xlsx on the server; the other two parsed CSV in
// the browser. So the same person could upload the same workbook in two places
// and have it work in one and fail in the other, which is indistinguishable
// from a broken feature.
//
// One parser, one shape of answer. Anything DRM accepts anywhere, it accepts
// everywhere.
//
// XLSX AND CSV ARE HANDLED SEPARATELY ON PURPOSE. exceljs can read both, but
// its CSV path wants a stream and a filesystem path, and it guesses at types in
// ways that turn a phone number into 9.87654e+9. A hand-written CSV reader is
// twenty lines, has no surprises, and keeps every value as the text it was.

import ExcelJS from 'exceljs';

export interface SheetData {
  name: string;
  headers: string[];
  /** One entry per row, in the sheet's own column order. */
  rows: unknown[][];
  /** The 1-based row number in the original file, for error messages. */
  rowNumbers: number[];
}

/**
 * A cell's value as a person would read it.
 *
 * Excel hands back rich text, hyperlinks, formulas and error objects as well as
 * plain values, and every one of them stringifies to "[object Object]" if you
 * are not looking for it.
 */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const o = v as {
      text?: unknown;
      result?: unknown;
      richText?: { text: string }[];
      hyperlink?: string;
      error?: string;
    };
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join('');
    if (o.text !== undefined) return String(o.text);
    if (o.result !== undefined) return String(o.result);
    if (o.error) return '';
    return '';
  }
  return String(v);
}

/**
 * Minimal CSV reader: quoted fields, embedded commas and newlines, doubled
 * quotes, and either line ending.
 *
 * Deliberately not a dependency. These files are contact lists and courier
 * manifests typed by volunteers, and a reader we can read beats one that
 * handles RFC corner cases nobody will ever produce.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  // A UTF-8 BOM would otherwise become part of the first heading, so "phone"
  // silently stops matching.
  const src = text.replace(/^﻿/, '');

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const isExcel = (filename: string) => /\.(xlsx|xlsm|xltx|xltm)$/i.test(filename);

/**
 * Read an uploaded file into sheets.
 *
 * A CSV has no tabs, so it comes back as a single sheet named after the file -
 * which keeps every caller of this function on one code path instead of
 * branching on the format all over again.
 */
export async function parseWorkbook(buffer: Buffer, filename: string): Promise<SheetData[]> {
  if (!isExcel(filename)) {
    const rows = parseCsv(buffer.toString('utf8'));
    // Fewer than two lines means a header and nothing under it, which is not a
    // sheet with no rows - it is a file with nothing in it. Returning none
    // rather than an empty sheet keeps this the same answer the Excel branch
    // below gives, where a tab with no data rows is simply not returned.
    if (rows.length < 2) return [];
    return [
      {
        name: filename.replace(/\.[^.]+$/, '') || 'Sheet1',
        headers: rows[0].map((h) => String(h ?? '').trim()),
        rows: rows.slice(1),
        // +2: one for the header row, one because spreadsheets count from 1.
        rowNumbers: rows.slice(1).map((_, i) => i + 2),
      },
    ];
  }

  const workbook = new ExcelJS.Workbook();
  // Cast through the library's own parameter type: exceljs still describes the
  // old Node Buffer, and @types/node now models Buffer as Buffer<ArrayBufferLike>,
  // so the two no longer line up even though the value is exactly right.
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  const sheets: SheetData[] = [];
  for (const ws of workbook.worksheets) {
    const headers: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col - 1] = cellText(cell.value).trim();
    });

    const rows: unknown[][] = [];
    const rowNumbers: number[] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const values: unknown[] = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        values[col - 1] = cell.value;
      });
      if (values.every((v) => v === null || v === undefined || cellText(v).trim() === '')) return;
      rows.push(values);
      rowNumbers.push(rowNumber);
    });

    if (rows.length) sheets.push({ name: ws.name, headers, rows, rowNumbers });
  }
  return sheets;
}

/**
 * Match column headings to fields by what people actually type.
 *
 * Substring matching rather than exact, because real headings carry years that
 * change every export - "Amount Donated from 1stApr2024 to 7thOct2025" has to
 * still be recognised next year - and punctuation nobody is consistent about.
 * `not` exists for the cases where one word appears in two headings: "Donor
 * Number" is not a phone number, however much "number" suggests it is.
 */
export interface FieldPattern {
  field: string;
  any: string[];
  not?: string[];
}

export function detectColumns(headers: string[], patterns: FieldPattern[]): Record<string, number> {
  const map: Record<string, number> = {};
  const norm = headers.map((h) =>
    String(h ?? '').toLowerCase().replace(/[._\-#()]+/g, ' ').replace(/\s+/g, ' ').trim()
  );

  for (const { field, any, not } of patterns) {
    if (map[field] !== undefined) continue;
    for (let i = 0; i < norm.length; i++) {
      // One heading feeds one field: without this a sheet with both "Name" and
      // "Donor Name" can map both to name and lose the other column.
      if (Object.values(map).includes(i)) continue;
      const h = norm[i];
      if (!h) continue;
      if (not?.some((n) => h.includes(n))) continue;
      if (any.some((a) => h.includes(a))) {
        map[field] = i;
        break;
      }
    }
  }
  return map;
}

/**
 * Build a small .xlsx, for the sample files offered beside each upload.
 *
 * Only ever used for a handful of example rows, so the whole thing is held in
 * memory and the formatting is one bold header row. Anything larger goes out as
 * CSV, which streams and which every spreadsheet program opens.
 */
export async function buildWorkbook(sheetName: string, rows: string[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet(sheetName.slice(0, 31) || 'Sheet1');
  rows.forEach((r) => ws.addRow(r));
  ws.getRow(1).font = { bold: true };
  // Wide enough to read the headings without dragging every column, which is
  // the first thing a person does otherwise and the reason samples get ignored.
  ws.columns.forEach((c, i) => {
    const longest = rows.reduce((n, r) => Math.max(n, (r[i] ?? '').length), 10);
    c.width = Math.min(34, longest + 4);
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Last ten digits — the identity rule every part of DRM uses. */
export function normalizePhone(raw: unknown): string {
  const digits = cellText(raw).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export const isDialable = (p: string) => /^[6-9]\d{9}$/.test(p);
