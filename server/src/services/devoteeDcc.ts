// Receipts raised from the devotee portal, straight to DCC.
//
// DCC (the temple's donation system at vhkmsurabhi.com) numbers the receipt; DRM draws the PDF.
// This is the devotee portal's own path and nothing else uses it: the office's and callers'
// receipts still go through the HKM Vizag site exactly as before (routes/donations.ts).
//
// It follows the HKM site's own DCC client (hkmsite2.0-server/src/services/dcc.service.js) and
// receipt (receipt.service.js) - the same payload, the same payment-mode numbers, the same
// enrolled-by rule and the same receipt templates - so a devotee's receipt is the same document
// the site would have issued. No WhatsApp is sent from here: the devotee shares the receipt.
//
// Settings (the same names the HKM site reads):
//   DCC_API_KEY                         required; without it no receipt can be raised
//   DCC_API_URL                         default https://vhkmsurabhi.com/api/socialmedia/addDonation
//   DCC_MODE_CASH / _UPI / _CHEQUE / _BANK   payment-mode numbers (1, 3, 4, 3)
//   DCC_ENROLLED_BY_REST / _DEFAULT / DCC_ENROLLED_BY   the temple's default enrolled-by id (36)

import fs from 'fs';
import path from 'path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { toWords } from 'number-to-words';
import pool from '../db/pool';
import { APP_TIMEZONE } from '../bootTimezone';
import { toEnglish } from '../utils/toEnglish';

const DCC_API_URL = () => process.env.DCC_API_URL?.trim() || 'https://vhkmsurabhi.com/api/socialmedia/addDonation';

/**
 * DCC is the temple's live accounts: every call there is a real 80G receipt. So it is called only
 * from production (NODE_ENV=production). A laptop or a test with a copied key is refused, unless
 * DCC_ALLOW_OUTSIDE_PRODUCTION=true is set on purpose - for a DCC test server, say.
 */
const liveAllowed = () => process.env.NODE_ENV === 'production' || process.env.DCC_ALLOW_OUTSIDE_PRODUCTION === 'true';
export const isDccConfigured = () => !!process.env.DCC_API_KEY?.trim() && liveAllowed();

export type PayMode = 'cash' | 'upi' | 'cheque' | 'bank';
const MODE_NUMBER = (m: PayMode): number =>
  ({
    cash: Number(process.env.DCC_MODE_CASH || 1),
    upi: Number(process.env.DCC_MODE_UPI || 3),
    cheque: Number(process.env.DCC_MODE_CHEQUE || 4),
    bank: Number(process.env.DCC_MODE_BANK || 3),
  })[m];
const MODE_WORDS: Record<PayMode, string> = { cash: 'Cash', cheque: 'Cheque', upi: 'UPI', bank: 'Bank' };

/** DCC ID 25 prints as SMED; the temple default prints as MKGD (as on the HKM site's receipts). */
const SMED_ID = 25;
const DEFAULT_CODE = 'MKGD';

/** The receipt as DRM keeps it (devotee_receipts), with what DCC and the PDF need. */
export interface DevoteeReceiptRow {
  id: string;
  owner_id: string;
  account: 'HKMI' | 'TSC';
  seva_name: string | null;
  dcc_seva_category: number | null;
  dcc_seva_sub_category: number | null;
  dcc_seva_sub_category_code: string | null;
  donor_name: string;
  donor_mobile: string;
  donor_email: string | null;
  pan: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  on_name_of: string | null;
  amount: string | number;
  payment_mode: PayMode;
  transaction_id: string;
  paid_on: string | null;
  enrolled_by_id: number | null;
  enrolled_by_code: string | null;
  receipt_number: string | null;
  donor_number: string | null;
  created_at: string | Date;
}

/**
 * Who the receipt is enrolled under in DCC: the devotee's own DCC id from the devotee list, else
 * (for a devotee loaded before ids were) a preacher DRM knows by the same code, else the temple's
 * default - the HKM site's own fallback.
 */
export async function enrolledByFor(ownerId: string): Promise<{ id: number; code: string }> {
  const r = await pool.query(
    `SELECT d.dcc_id, split_part(d.code, ',', 1) AS code, p.id_number
       FROM devotees d
       LEFT JOIN preachers p ON upper(p.code) = upper(trim(split_part(d.code, ',', 1))) AND p.active
      WHERE d.user_id = $1
      LIMIT 1`,
    [ownerId]
  );
  const row = r.rows[0] as { dcc_id: number | null; code: string | null; id_number: string | null } | undefined;
  const code = String(row?.code ?? '').trim().toUpperCase();
  const own = Number(row?.dcc_id);
  if (Number.isInteger(own) && own > 0) return { id: own, code: code || DEFAULT_CODE };
  const viaPreacher = Number(row?.id_number);
  if (Number.isInteger(viaPreacher) && viaPreacher > 0) return { id: viaPreacher, code: code || DEFAULT_CODE };
  const fallback = Number(process.env.DCC_ENROLLED_BY_REST || process.env.DCC_ENROLLED_BY_DEFAULT || process.env.DCC_ENROLLED_BY || 36);
  return { id: fallback, code: fallback === SMED_ID ? 'SMED' : DEFAULT_CODE };
}

/** A phone as DCC takes it: the ten digits of an Indian mobile. */
const dccPhone = (v: string) => String(v ?? '').replace(/\D/g, '').slice(-10);

/** DD/MM/YYYY at the temple: the date on a legal document, never the server's own zone. */
const dccDate = (v: string | Date | null) => {
  const d = v ? new Date(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00+05:30` : v) : new Date();
  return d.toLocaleDateString('en-GB', { timeZone: APP_TIMEZONE, day: '2-digit', month: '2-digit', year: 'numeric' });
};

export function buildDccPayload(r: DevoteeReceiptRow): Record<string, unknown> {
  const codeText = r.dcc_seva_sub_category_code ?? '';
  return {
    donorName: toEnglish(r.donor_name),
    donorPhone: dccPhone(r.donor_mobile),
    donorEmail: r.donor_email || null,
    gender: null,
    address: {
      fullAddress: toEnglish(r.address) || null,
      state: toEnglish(r.state) || null,
      city: toEnglish(r.city) || null,
      pinCode: r.pincode || null,
    },
    PAN: r.pan || null,
    amount: String(Number(r.amount)),
    accountType: r.account === 'TSC' ? 5 : 4,
    sevaCategory: r.dcc_seva_category,
    sevaSubCategory: r.dcc_seva_sub_category,
    sevaSubCategoryCode: /^\d+$/.test(codeText) ? Number(codeText) : codeText,
    modeOfPayment: MODE_NUMBER(r.payment_mode),
    gatewayPaymentId: r.transaction_id,
    transactionDate: dccDate(r.paid_on ?? r.created_at),
    enrolledBy: r.enrolled_by_id,
  };
}

export interface DccAnswer {
  ReceiptNumber?: string;
  DonorNumber?: string;
  Message?: string;
  [k: string]: unknown;
}
type Poster = (payload: Record<string, unknown>) => Promise<DccAnswer>;

const realPoster: Poster = async (payload) => {
  // Checked again here, right before the request, so no path can reach DCC around it.
  if (!liveAllowed()) throw new Error('DCC is only called from production.');
  const res = await fetch(DCC_API_URL(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'DCC-Api-Key': process.env.DCC_API_KEY!.trim() },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await res.text();
  let parsed: DccAnswer;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = { raw } as DccAnswer;
  }
  // A repeat of a transaction DCC already has comes back with the receipt it issued then:
  // a receipt number is the answer wanted, whatever the status code.
  if (parsed?.ReceiptNumber) return parsed;
  if (!res.ok) {
    const msg = typeof parsed?.Message === 'string' ? parsed.Message : raw || `DCC answered ${res.status}`;
    if (/transaction details exist/i.test(msg)) {
      throw new Error('DCC already has this transaction but did not return its receipt number. Ask the office to look it up in DCC.');
    }
    throw new Error(msg);
  }
  return parsed;
};

let poster: Poster | null = null;
/** Tests stand in for DCC. Null restores the real one. */
export function setDccPoster(p: Poster | null) {
  poster = p;
}

/**
 * Send one receipt to DCC and keep what came back. Safe to call again for a receipt that failed:
 * DCC recognises the transaction id and answers with the receipt it already issued.
 */
export async function issueDevoteeReceipt(row: DevoteeReceiptRow): Promise<{ ok: true; receiptNumber: string } | { ok: false; error: string }> {
  if (!poster && !isDccConfigured()) {
    const why = process.env.DCC_API_KEY?.trim() ? 'DCC is only called from production.' : 'DCC is not set up on the server.';
    await pool.query(`UPDATE devotee_receipts SET status = 'failed', dcc_error = $2 WHERE id = $1`, [row.id, why]);
    return { ok: false, error: `Receipts cannot be raised here: ${why} Please tell the temple office.` };
  }
  const payload = buildDccPayload(row);
  try {
    const answer = await (poster ?? realPoster)(payload);
    const receiptNumber = answer?.ReceiptNumber ? String(answer.ReceiptNumber).slice(0, 80) : null;
    if (!receiptNumber) throw new Error(typeof answer?.Message === 'string' ? answer.Message : 'DCC did not return a receipt number.');
    await pool.query(
      `UPDATE devotee_receipts
          SET status = 'issued', receipt_number = $2, donor_number = $3, dcc_error = NULL,
              dcc_payload = $4::jsonb, dcc_response = $5::jsonb, issued_at = NOW()
        WHERE id = $1`,
      [row.id, receiptNumber, answer.DonorNumber ? String(answer.DonorNumber).slice(0, 40) : null, JSON.stringify(payload), JSON.stringify(answer)]
    );
    return { ok: true, receiptNumber };
  } catch (e) {
    const error = (e as Error).message || 'DCC did not answer.';
    await pool.query(
      `UPDATE devotee_receipts SET status = 'failed', dcc_error = $2, dcc_payload = $3::jsonb WHERE id = $1`,
      [row.id, error.slice(0, 500), JSON.stringify(payload)]
    );
    console.error('devoteeDcc.issue failed:', row.id, error);
    return { ok: false, error };
  }
}

/* ----------------------------------------------------------------- the PDF */

const TEMPLATES = path.resolve(__dirname, '..', '..', 'assets', 'receipts');
const templateCache: Partial<Record<'HKMI' | 'TSC', Buffer>> = {};
const template = (account: 'HKMI' | 'TSC') =>
  (templateCache[account] ??= fs.readFileSync(path.join(TEMPLATES, account === 'TSC' ? 'receipt-template-tsc.pdf' : 'receipt-template-hkmi.pdf')));

/** Printed in English, as DCC's receipts are; anything still outside plain ASCII is dropped. */
const printable = (v: unknown) =>
  (toEnglish(v == null ? '' : String(v)) ?? '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** The 80G receipt for an issued devotee receipt, on the HKM site's own template. */
export async function renderDevoteeReceipt(r: DevoteeReceiptRow): Promise<Buffer> {
  if (!r.receipt_number) throw Object.assign(new Error('This receipt has not been issued yet.'), { status: 409 });
  const amount = Number(r.amount);
  const date = new Date(r.paid_on ? `${r.paid_on}T12:00:00+05:30` : r.created_at).toLocaleDateString('en-IN', { timeZone: APP_TIMEZONE });
  const fields: Record<string, string> = {
    name: printable(r.donor_name).toUpperCase(),
    phoneNum: r.donor_mobile || '---',
    inWords: `${toWords(Math.round(amount)).toUpperCase()} RUPEES ONLY`,
    transactionDate: date,
    transaction_Date: date,
    address: printable(r.address) || '---',
    '80G': r.pan ? 'YES' : 'NO',
    towards: printable(r.seva_name) || 'General Seva',
    email: r.donor_email || '---',
    enrolledBy: r.enrolled_by_code || DEFAULT_CODE,
    pan: r.pan || '---',
    receiptNumber: r.receipt_number.split('|').join(' | '),
    amount: `${amount.toLocaleString('en-IN')}/-`,
    transactionNumber: r.transaction_id || '---',
    sevakName: printable(r.on_name_of) || '---',
    donorId: r.donor_number || '---',
  };
  const tsc = r.account === 'TSC';
  if (tsc) fields.paymentMode = MODE_WORDS[r.payment_mode] ?? 'Online';

  const pdf = await PDFDocument.load(template(r.account));
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const form = pdf.getForm();
  for (const [name, value] of Object.entries(fields)) {
    try {
      form.getTextField(name).setText(value);
    } catch {
      // A template without this field: the rest of the receipt still prints.
    }
  }
  form.updateFieldAppearances(font);
  try {
    form.flatten();
  } catch {
    // Flattening only stops the fields being edited; the receipt is complete either way.
  }
  const page = pdf.getPages()[0];
  const h = page.getHeight();
  // CDC beside "Enrolled by", as DCC's own receipt prints it, shrunk to fit before "Towards".
  const cdc = fields.enrolledBy;
  let size = 9.8;
  while (size > 6.5 && font.widthOfTextAtSize(cdc, size) > 37) size -= 0.3;
  page.drawText('CDC :', { x: 225, y: 370.4, size: 9.8, font, color: rgb(0, 0, 0) });
  page.drawText(cdc, { x: 256, y: 370.4, size, font, color: rgb(0, 0, 0), maxWidth: 37 });
  // The HKMI template prints "by Online"; a cash, UPI, cheque or bank receipt says how they paid.
  if (!tsc) {
    page.drawRectangle({ x: 50.5, y: h - 457.6, width: 36, height: 16, color: rgb(1, 1, 1) });
    page.drawText(MODE_WORDS[r.payment_mode], { x: 52, y: h - 452.8, size: 9.5, font, color: rgb(0, 0, 0) });
  }
  return Buffer.from(await pdf.save());
}
