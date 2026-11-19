// A donor's receipt, opened from the link a devotee shares with them on WhatsApp.
//
//   GET /api/receipt-link/:token   the receipt PDF
//
// No login: the donor has none. Protected by the token alone - 64 hex characters from two random
// UUIDs, made when the devotee raised the receipt (devotee_receipts.share_token) - so a link can
// be opened only by someone it was sent to, and no other receipt can be reached by changing it.
// It serves that one receipt and nothing else about the donor or the devotee.

import { Router } from 'express';
import pool from '../db/pool';
import { renderDevoteeReceipt } from '../services/devoteeDcc';

const router = Router();

const TOKEN_RE = /^[0-9a-f]{64}$/;

/** A short page for a person on a phone, rather than JSON they cannot read. */
function page(res: import('express').Response, status: number, message: string) {
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>Receipt - HKM Vizag</title>` +
        `<body style="font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#1f2937">` +
        `<h1 style="font-size:1.25rem;color:#2b6e2f">Hare Krishna Movement, Visakhapatnam</h1><p>${message}</p></body>`
    );
}

router.get('/api/receipt-link/:token', async (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const token = String(req.params.token).toLowerCase();
  if (!TOKEN_RE.test(token)) return page(res, 404, 'This receipt link is not valid.');
  try {
    const row = (await pool.query(`SELECT * FROM devotee_receipts WHERE share_token = $1`, [token])).rows[0];
    if (!row) return page(res, 404, 'This receipt link is not valid.');
    if (row.status !== 'issued') {
      return page(res, 409, 'Your receipt is still being prepared. Please open this link again in a little while.');
    }
    const pdf = await renderDevoteeReceipt(row);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="receipt-${String(row.receipt_number).replace(/[^a-zA-Z0-9-]/g, '-')}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf);
  } catch (err) {
    console.error('receiptLink error:', (err as Error).message);
    page(res, 502, 'The receipt could not be opened right now. Please try again in a few minutes.');
  }
});

export default router;
