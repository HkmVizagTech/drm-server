// Downloading what is on the screen.
//
// WHY THIS IS ONE MODULE AND NOT A HELPER PER SCREEN
//
// Before this existed there were two exports in the whole product, and they
// had each grown their own CSV escaper. The two had already drifted - one
// joined arrays with "; " and the other printed "[object Object]" - which is
// what always happens to a function that is copied instead of shared. There
// are now a dozen exports, so the escaping, the BOM, the IST formatting, the
// phone-number handling and the filename all live here, once.
//
// THE RULES AN EXPORT HAS TO FOLLOW, all of which have a reason:
//
//  1. It shows exactly what the filters on screen show. An export that
//     silently ignores the date picker is worse than no export, because the
//     person sends the file to somebody who acts on it.
//  2. It never shows more than the screen would. A caller who cannot see the
//     whole donor base on People must not be able to download it. Scope is
//     applied by the caller of this module, in the same query the list uses.
//  3. Phone numbers survive. Excel will turn 9876543210 into 9.87654E+09 and
//     eat the leading zero off anything else, and a phone list that cannot be
//     dialled is worthless to a calling team.
//  4. Money stays a number, so the office can total a column.
//  5. Dates read in IST, because every other date in this product does.

import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { APP_TIMEZONE, istDate } from '../bootTimezone';

export type ExportFormat = 'csv' | 'xlsx';

/** How a value should be written, which differs between CSV and a workbook. */
export type ColumnKind =
  | 'text'
  | 'number'
  | 'money'
  | 'date'
  | 'datetime'
  /** Kept as text in Excel so it is never reformatted into 9.87654E+09. */
  | 'phone';

export interface ExportColumn<T> {
  header: string;
  value: (row: T) => unknown;
  kind?: ColumnKind;
  /** Column width in a workbook, in characters. Sized from content if unset. */
  width?: number;
}

export interface ExportSpec<T> {
  /** Shown as the sheet name and used to build the filename. */
  name: string;
  columns: ExportColumn<T>[];
  rows: T[];
  /**
   * One line describing the filters that produced this file, written into the
   * workbook's description and as a comment row in the CSV. Six months later
   * nobody remembers whether "donations.csv" was all of them or one month of
   * them, and the file itself is the only place that can answer it.
   */
  filterSummary?: string;
  /** True when a row cap was hit, so the file can say so rather than lie. */
  truncated?: boolean;
}

/** How many rows any one export will produce. */
export const EXPORT_ROW_CAP = 50_000;

/* ----------------------------------------------------------------- values */

const IST_DATE: Intl.DateTimeFormatOptions = {
  timeZone: APP_TIMEZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
};

const IST_TIME: Intl.DateTimeFormatOptions = {
  timeZone: APP_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
};

function asDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  // A DATE column arrives as a bare YYYY-MM-DD string (see db/pool.ts). It has
  // no time and no zone, so it is anchored at IST midnight rather than being
  // handed to the Date parser, which would read it as UTC and show the day
  // before for anyone east of Greenwich.
  const raw = String(v);
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00+05:30` : raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The human-readable form, always in IST. Used by CSV and by text fallbacks. */
export function displayValue(v: unknown, kind: ColumnKind = 'text'): string {
  if (v === null || v === undefined) return '';
  switch (kind) {
    case 'date': {
      const d = asDate(v);
      return d ? d.toLocaleDateString('en-IN', IST_DATE) : '';
    }
    case 'datetime': {
      const d = asDate(v);
      if (!d) return '';
      return `${d.toLocaleDateString('en-IN', IST_DATE)}, ${d.toLocaleTimeString('en-IN', IST_TIME)}`;
    }
    case 'money':
    case 'number': {
      const n = Number(v);
      return Number.isFinite(n) ? String(n) : '';
    }
    default:
      if (Array.isArray(v)) return v.map((x) => displayValue(x)).join('; ');
      if (v instanceof Date) return displayValue(v, 'datetime');
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);
  }
}

/* -------------------------------------------------------------------- CSV */

/**
 * One cell, escaped.
 *
 * Quoting is driven by the content rather than applied to everything, because
 * a file where every field is quoted is unreadable in a text editor and that
 * is where people look when an import goes wrong.
 */
function csvCell(s: string): string {
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<T>(spec: ExportSpec<T>): string {
  const lines: string[] = [];
  if (spec.filterSummary) lines.push(csvCell(`# ${spec.filterSummary}`));
  if (spec.truncated) {
    lines.push(csvCell(`# Only the first ${EXPORT_ROW_CAP.toLocaleString('en-IN')} rows are included - narrow the filters for the rest.`));
  }
  lines.push(spec.columns.map((c) => csvCell(c.header)).join(','));
  for (const row of spec.rows) {
    lines.push(spec.columns.map((c) => csvCell(displayValue(c.value(row), c.kind))).join(','));
  }
  // CRLF because Excel on Windows is the usual destination, and a UTF-8 BOM so
  // it opens Indian names as text rather than mojibake. Without the BOM,
  // "Kṛṣṇa" arrives as "KrÌ£sÌ£nÌ£a" and somebody retypes the whole column.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------- XLSX */

/**
 * The IST shift, and why a workbook needs one.
 *
 * An .xlsx date is a plain number of days since 1900 with no timezone in it at
 * all. exceljs converts a JS Date using its UTC parts, so a donation received
 * at 00:30 IST would be written as 19:00 on the previous day and the office
 * would see a date that disagrees with the screen.
 *
 * Shifting the instant by the IST offset before writing makes the stored
 * number mean "this wall-clock time in India", which is what every other date
 * in this product means. The cell still sorts and filters as a real date,
 * which a formatted string would not.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function excelDate(d: Date): Date {
  // A fixed constant rather than a zone lookup, deliberately: exceljs turns a
  // Date into a serial from its epoch milliseconds, so what is needed here is
  // the offset from UTC, not from whatever zone this process is running in -
  // and with the process already on IST a zone-difference calculation would
  // come out as zero and silently do nothing. India has had no daylight saving
  // since 1945 and a single zone nationwide, so +05:30 is exact for every
  // instant this product will ever write.
  return new Date(d.getTime() + IST_OFFSET_MS);
}

export async function toXlsx<T>(spec: ExportSpec<T>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DRM';
  wb.created = new Date();
  if (spec.filterSummary) wb.description = spec.filterSummary;

  const ws = wb.addWorksheet(spec.name.slice(0, 31) || 'Export', {
    // The header row stays put while the office scrolls a thousand donations.
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  ws.addRow(spec.columns.map((c) => c.header));
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2B6E2F' } };
  header.alignment = { vertical: 'middle' };
  header.height = 20;

  for (const row of spec.rows) {
    ws.addRow(
      spec.columns.map((c) => {
        const raw = c.value(row);
        switch (c.kind) {
          case 'money':
          case 'number': {
            const n = Number(raw);
            return Number.isFinite(n) ? n : null;
          }
          case 'date':
          case 'datetime': {
            const d = asDate(raw);
            return d ? excelDate(d) : null;
          }
          // Written as text on purpose. Left as a number, Excel renders
          // 9876543210 as 9.87654E+09 and drops any leading zero, and the
          // column stops being a phone list.
          case 'phone':
            return raw === null || raw === undefined ? '' : String(raw);
          default:
            return displayValue(raw, c.kind);
        }
      })
    );
  }

  spec.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (c.kind === 'money') col.numFmt = '#,##0.00';
    else if (c.kind === 'number') col.numFmt = '#,##0';
    else if (c.kind === 'date') col.numFmt = 'dd mmm yyyy';
    else if (c.kind === 'datetime') col.numFmt = 'dd mmm yyyy  hh:mm am/pm';
    else if (c.kind === 'phone') col.numFmt = '@';

    if (c.width) {
      col.width = c.width;
      return;
    }
    // Sized from the content, capped: a remarks column with one 400-character
    // note in it should not push every other column off the screen.
    let longest = c.header.length;
    for (const row of spec.rows) {
      const len = displayValue(c.value(row), c.kind).length;
      if (len > longest) longest = len;
      if (longest >= 40) break;
    }
    col.width = Math.max(10, Math.min(40, longest + 3));
  });

  // Filter buttons on the header row. The office's first instinct with a
  // downloaded sheet is to narrow it further, and this saves them finding the
  // menu for it.
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: spec.columns.length } };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ------------------------------------------------------------------- send */

/** `?format=xlsx` wins; anything else is CSV. */
export function formatFrom(q: Record<string, unknown>): ExportFormat {
  return String(q.format ?? '').toLowerCase() === 'xlsx' ? 'xlsx' : 'csv';
}

/** Safe for a Content-Disposition header and for Windows, macOS and Linux. */
function safeFilename(s: string): string {
  return s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'export';
}

/**
 * Write the file to the response.
 *
 * The date in the filename is the Indian date. It used to be
 * `toISOString().slice(0, 10)`, so a file downloaded at 2am was stamped with
 * yesterday - which matters precisely because the filename is what the office
 * uses to tell two exports apart.
 */
export async function sendExport<T>(
  res: Response,
  format: ExportFormat,
  spec: ExportSpec<T>
): Promise<void> {
  const filename = safeFilename(`${spec.name}-${istDate()}`);
  if (format === 'xlsx') {
    const buffer = await toXlsx(spec);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    res.send(buffer);
    return;
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
  res.send(toCsv(spec));
}

/**
 * A readable account of the filters that produced a file.
 *
 * Takes the same query object the list endpoint parsed, so it cannot drift
 * away from what was actually applied.
 */
export function describeFilters(
  q: Record<string, unknown>,
  labels: Record<string, string>
): string {
  const parts: string[] = [];
  for (const [key, label] of Object.entries(labels)) {
    const v = q[key];
    if (v === undefined || v === null || v === '' || v === 'all') continue;
    parts.push(`${label}: ${Array.isArray(v) ? v.join(', ') : String(v)}`);
  }
  const when = `Downloaded ${new Date().toLocaleString('en-IN', { timeZone: APP_TIMEZONE })} IST`;
  return parts.length ? `${when} | ${parts.join(' | ')}` : `${when} | No filters applied`;
}
