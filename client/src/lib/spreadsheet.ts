// Reading an uploaded spreadsheet, from the browser's side.
//
// Three screens take a file: the donor sheets, the courier's prasadam file, and
// the quick lead list. They used to disagree about what a file was - one read
// .xlsx, the other two only CSV - so the same workbook worked in one place and
// was rejected in another, which to the person uploading it is indistinguishable
// from a broken feature.
//
// This is the one path now. The file goes to the server, the server reads it
// with the same parser the donor-sheet import uses, and rows of text come back.
//
// WHY NOT PARSE IT HERE
// An .xlsx is a zip of XML. Reading one in the browser means shipping a library
// that is larger than the rest of this application, to every person who opens
// DRM, so that two dialogs can avoid one request. And two parsers means two sets
// of quirks and a bug report that begins "it imported fine on the other page".

import { apiClient } from "./api";

/** What a file turns into: one entry per tab, or one for a CSV. */
export interface ParsedSheet {
  name: string;
  headers: string[];
  /** Row-major, every value already text, aligned to `headers`. */
  rows: string[][];
  /** The 1-based row number in the original file, for "row 47 has no phone". */
  rowNumbers: number[];
  rows_total: number;
  truncated: boolean;
}

/** What the file pickers should accept, everywhere. */
export const SPREADSHEET_ACCEPT =
  ".xlsx,.xlsm,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const SPREADSHEET_HINT = "Excel or CSV";

const KNOWN = /\.(xlsx|xlsm|xltx|xltm|csv|txt)$/i;

/**
 * base64 for a JSON body.
 *
 * Chunked because String.fromCharCode(...bytes) on a whole multi-megabyte array
 * overflows the call stack - it passes every byte as a separate argument.
 */
export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Read a picked file into sheets.
 *
 * Throws with a sentence a person can act on, because every caller of this puts
 * the message straight on the screen.
 */
export async function readSpreadsheet(file: File): Promise<ParsedSheet[]> {
  if (!KNOWN.test(file.name)) {
    throw new Error(
      `“${file.name}” is not a spreadsheet. Save it as Excel (.xlsx) or CSV and try again.`
    );
  }
  // 25 MB is what the server's JSON body limit allows, and base64 inflates by a
  // third - so the real ceiling is about 18 MB of file. Caught here so a large
  // upload fails in a second with an explanation rather than after a long wait
  // with a 413.
  if (file.size > 18 * 1024 * 1024) {
    throw new Error("That file is over 18 MB. Split it into smaller sheets and upload them one at a time.");
  }

  const d = await apiClient.post<{ sheets: ParsedSheet[] }>("/api/files/parse", {
    filename: file.name,
    base64: toBase64(await file.arrayBuffer()),
  });
  if (!d.sheets?.length) throw new Error("That file has no rows in it.");
  return d.sheets;
}

/**
 * Save a file the API produced.
 *
 * Through fetch rather than a plain <a href> because every one of these routes
 * is behind the JWT, and a link element cannot carry an Authorization header.
 */
export async function downloadFromApi(path: string, filename: string) {
  const blob = await apiClient.getBlob(path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Guess which column holds a field, exact heading first and a substring second.
 *
 * Left in the browser rather than done on the server, because on these screens
 * the guess is only a starting point: the person sees which column was chosen
 * and changes it, and re-guessing without a round trip is what makes that feel
 * immediate.
 */
export function guessColumn(headers: string[], candidates: string[]): number {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const c of candidates) {
    const i = lower.findIndex((h) => h === c);
    if (i !== -1) return i;
  }
  for (const c of candidates) {
    const i = lower.findIndex((h) => h.includes(c));
    if (i !== -1) return i;
  }
  return -1;
}

/**
 * Offer a sample file as a download.
 *
 * CSV, even though Excel is now accepted: a CSV opens in Excel, LibreOffice and
 * Google Sheets alike, and the point of the sample is to show which columns are
 * expected, not to demonstrate a format.
 */
export function downloadSample(filename: string, rows: string[][]) {
  const csv = rows
    .map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","))
    .join("\n");
  // BOM so Excel opens it as UTF-8 rather than mangling Indian names.
  const blob = new Blob(["﻿" + csv + "\n"], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
