// Bulk upload of a devotee's own leads from an Excel or CSV file.
//
// The file is read with DRM's one spreadsheet reader (utils/spreadsheet.ts) and every row goes
// through the same check a lead typed into the form does (parseLead), so an uploaded lead can
// never be one the form would refuse. Only name and mobile are required. Columns are found by
// their heading, loosely ("Mobile", "Phone", "WhatsApp number" all work), so the office's own
// sheets usually upload as they are.
//
// Nothing is overwritten: a number already in the devotee's leads is reported and left alone,
// and a number that appears twice in the file is added once.

import { cellText, detectColumns, normalizePhone, parseWorkbook, type FieldPattern } from '../utils/spreadsheet';
import { APP_TIMEZONE } from '../bootTimezone';
import { INTERESTS, SOURCES, parseLead } from './devoteeLeads';

export const MAX_IMPORT_ROWS = 2000;

/** Headings, loosely. Order matters: "other number" must be claimed before "number". */
const PATTERNS: FieldPattern[] = [
  { field: 'alt_phone', any: ['alt', 'other number', 'other phone', 'second', 'landline'] },
  { field: 'phone', any: ['mobile', 'phone', 'whatsapp', 'contact', 'number', 'cell'] },
  { field: 'name', any: ['name', 'donor', 'devotee', 'person'] },
  { field: 'email', any: ['email', 'mail'] },
  { field: 'landmark', any: ['landmark'] },
  { field: 'area', any: ['area', 'locality', 'colony'] },
  { field: 'city', any: ['city', 'town', 'district'] },
  { field: 'pincode', any: ['pin', 'zip', 'postal'] },
  { field: 'address_line', any: ['address', 'house', 'street', 'door', 'flat'] },
  { field: 'interest', any: ['interest', 'seva'] },
  { field: 'source', any: ['source', 'how met', 'met at', 'met'] },
  { field: 'priority', any: ['priority', 'chance'] },
  { field: 'expected_amount', any: ['expected', 'amount', 'pledge'] },
  { field: 'date_of_birth', any: ['birthday', 'birth', 'dob'] },
  { field: 'anniversary_date', any: ['anniversary'] },
  { field: 'next_follow_up_at', any: ['follow', 'call back', 'callback', 'next call'] },
  { field: 'occupation', any: ['occupation', 'profession', 'job'] },
  { field: 'organisation', any: ['organisation', 'organization', 'company', 'office'] },
  { field: 'notes', any: ['note', 'remark', 'comment'] },
];

/** The columns of the sample file, in order - also what the screen lists as "columns you can use". */
export const SAMPLE_HEADERS = [
  'Name', 'Mobile', 'Other number', 'Email', 'Address', 'Area', 'Landmark', 'City', 'PIN code',
  'Interest', 'How met', 'Priority', 'Expected amount', 'Birthday', 'Anniversary', 'Next follow-up', 'Notes',
];

const squash = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');

/** A value from a fixed list, by its code or its words ("Temple construction" -> temple_construction). */
function choice(raw: string, list: readonly string[], labels: Record<string, string>): string | null {
  const v = squash(raw);
  if (!v) return null;
  const hit = list.find((x) => squash(x) === v || squash(labels[x] ?? '') === v);
  return hit ?? 'other';
}
const INTEREST_WORDS: Record<string, string> = {
  annadanam: 'Annadanam', temple_construction: 'Temple construction', gau_seva: 'Gau seva', festival_seva: 'Festival seva',
  nitya_seva: 'Nitya seva', general: 'General donation', volunteering: 'Volunteering', other: 'Other',
};
const SOURCE_WORDS: Record<string, string> = {
  personal: 'Personal contact', temple_visit: 'Temple visit', event: 'Event or festival', book_distribution: 'Book distribution',
  referral: 'Referral', social_media: 'Social media', other: 'Other',
};

/** "Hot / Warm / Cold" or the words the screen uses now ("High / Medium / Low"). */
function priority(raw: string): string | null {
  const v = squash(raw);
  if (!v) return null;
  if (['hot', 'high', 'h'].includes(v)) return 'hot';
  if (['cold', 'low', 'l'].includes(v)) return 'cold';
  return 'warm';
}

/** A date as YYYY-MM-DD from 2026-11-20, 20-11-2026, 20/11/2026 or 20.11.2026. Undefined: not a date. */
function day(raw: string): string | null | undefined {
  const v = raw.trim();
  if (!v) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(v);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return undefined;
}

/** A follow-up: a date, with a time if given ("20-11-2026 17:30", "2026-11-20 5:30 pm"), at the temple's clock. */
function followUp(raw: string): string | null | undefined {
  const d = day(raw);
  if (d === null || d === undefined) return d;
  const t = /(\d{1,2})[:.](\d{2})\s*(am|pm)?/i.exec(raw.trim().replace(/^\S+\s*/, ''));
  let h = 10;
  let min = 0;
  if (t) {
    h = Number(t[1]) % 24;
    min = Number(t[2]);
    if (t[3]?.toLowerCase() === 'pm' && h < 12) h += 12;
    if (t[3]?.toLowerCase() === 'am' && h === 12) h = 0;
  }
  return new Date(`${d}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00+05:30`).toISOString();
}

export interface ImportRow {
  row: number;
  fields: Record<string, unknown>;
}
export interface ImportReport {
  sheet: string;
  columns: Record<string, string>;
  total: number;
  ready: ImportRow[];
  problems: { row: number; name: string; reason: string }[];
  duplicates: { row: number; name: string; phone: string; reason: string }[];
}

/** Read a file and check every row. Writes nothing. */
export async function readLeadFile(buffer: Buffer, filename: string, existingPhones: Set<string>): Promise<ImportReport> {
  const sheets = await parseWorkbook(buffer, filename);
  const sheet = sheets.find((s) => s.rows.length) ?? sheets[0];
  if (!sheet || !sheet.rows.length) throw Object.assign(new Error('That file has no rows in it.'), { status: 400 });
  const cols = detectColumns(sheet.headers, PATTERNS);
  if (cols.name === undefined || cols.phone === undefined) {
    throw Object.assign(
      new Error(`The file needs a Name column and a Mobile column. Found: ${sheet.headers.filter(Boolean).join(', ') || 'no headings'}.`),
      { status: 400 }
    );
  }
  if (sheet.rows.length > MAX_IMPORT_ROWS) {
    throw Object.assign(new Error(`That is ${sheet.rows.length} rows; upload at most ${MAX_IMPORT_ROWS} at a time.`), { status: 400 });
  }

  const report: ImportReport = {
    sheet: sheet.name,
    columns: Object.fromEntries(Object.entries(cols).map(([f, i]) => [f, sheet.headers[i]])),
    total: 0,
    ready: [],
    problems: [],
    duplicates: [],
  };
  const seen = new Map<string, number>();
  const cell = (r: unknown[], f: string) => (cols[f] === undefined ? '' : cellText(r[cols[f]]).trim());

  sheet.rows.forEach((r, i) => {
    const rowNo = sheet.rowNumbers[i] ?? i + 2;
    if (!r.some((c) => cellText(c).trim())) return; // a blank line
    report.total++;
    const name = cell(r, 'name');
    const phone = normalizePhone(cell(r, 'phone'));
    const body: Record<string, unknown> = { name, phone };
    for (const f of ['alt_phone', 'email', 'landmark', 'area', 'city', 'address_line', 'occupation', 'organisation', 'notes']) {
      const v = cell(r, f);
      if (v) body[f] = f === 'alt_phone' ? normalizePhone(v) : v;
    }
    const pin = cell(r, 'pincode').replace(/\D/g, '');
    if (pin) body.pincode = pin;
    const interest = choice(cell(r, 'interest'), INTERESTS, INTEREST_WORDS);
    if (interest) body.interest = interest;
    const source = choice(cell(r, 'source'), SOURCES, SOURCE_WORDS);
    if (source) body.source = source;
    const p = priority(cell(r, 'priority'));
    if (p) body.priority = p;
    const amount = cell(r, 'expected_amount').replace(/[^\d.]/g, '');
    if (amount) body.expected_amount = amount;
    for (const f of ['date_of_birth', 'anniversary_date'] as const) {
      const raw = cell(r, f);
      const d = day(raw);
      if (d === undefined) return void report.problems.push({ row: rowNo, name: name || '(no name)', reason: `${f === 'date_of_birth' ? 'Birthday' : 'Anniversary'} "${raw}" is not a date (use DD-MM-YYYY).` });
      if (d) body[f] = d;
    }
    const fuRaw = cell(r, 'next_follow_up_at');
    const fu = followUp(fuRaw);
    if (fu === undefined) return void report.problems.push({ row: rowNo, name: name || '(no name)', reason: `Next follow-up "${fuRaw}" is not a date (use DD-MM-YYYY HH:MM).` });
    if (fu) body.next_follow_up_at = fu;

    const parsed = parseLead(body, 'create');
    if (parsed.error !== undefined) return void report.problems.push({ row: rowNo, name: name || '(no name)', reason: parsed.error });
    const ph = parsed.fields.phone as string;
    if (existingPhones.has(ph)) return void report.duplicates.push({ row: rowNo, name, phone: ph, reason: 'Already in your leads' });
    if (seen.has(ph)) return void report.duplicates.push({ row: rowNo, name, phone: ph, reason: `Same number as row ${seen.get(ph)}` });
    seen.set(ph, rowNo);
    report.ready.push({ row: rowNo, fields: parsed.fields });
  });
  return report;
}

/** For the screen: the follow-up time an uploaded row ended up with, in words. */
export const atTemple = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { timeZone: APP_TIMEZONE, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
