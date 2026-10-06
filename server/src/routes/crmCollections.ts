// Money a caller collected that no system watched arrive.
//
// THE CASE THIS EXISTS FOR
// A caller rings a donor, the donor says "send me the number", and the caller
// sends the temple's PhonePe or UPI number. The donor pays. That money lands
// in the temple's bank account and touches nothing DRM can see: it is not a
// Razorpay QR, so there is no webhook; it is not a website donation, so
// neither site syncs it across. As far as every screen in DRM is concerned
// the call produced nothing, and at the end of the month the caller who
// raised it shows a figure that is missing the part they worked hardest for.
//
// So they write it down, and DRM counts it — with the fact that it is their
// own word attached to it, permanently and visibly.
//
// WHY IT IS MARKED UNVERIFIED AND WHY THAT IS NOT AN INSULT
// Every other credit in the ledger records something a machine observed: a
// Razorpay webhook, a donation synced from a site. This one records something
// a person reported. Those are different kinds of fact and a system that
// presents them identically is lying by omission — the first time a figure is
// questioned, nobody can tell which part of it was observed.
//
// So both are counted and both are shown, and the screens say which is which
// until somebody ticks it off against the bank statement. verified_at being
// NULL means "nobody has checked yet", not "we think this is wrong".
//
// WHY RECORDING THE MONEY AND RAISING THE RECEIPT ARE TWO STEPS
// A receipt is an 80G certificate with the temple's name and number on it. A
// mis-recorded credit can be reversed in one click; a duplicate or wrongly
// issued receipt cannot be withdrawn at all. So recording a collection writes
// nothing to either donation site. Raising the receipt is a separate,
// deliberate action — and it is the one that creates the real donation.

import { Router } from 'express';
import pool from '../db/pool';
import { authenticate, authorize } from '../middleware/auth';
import { recordCredit, reverseCredit, verifyCredit, type Credit } from '../services/credits';
import { leadForPayer, leadBefore, restoreLead, type LeadUndo } from '../services/leadMoney';
import { markLeadDonated } from './crmQr';
import { parseDate, istDate } from '../bootTimezone';
import { createOfflineDonation, type SiteKey } from '../services/hkmvClient';
import { sendExport, formatFrom, describeFilters, EXPORT_ROW_CAP, type ExportFormat } from '../utils/export';

const router = Router();
router.use(authenticate);

const str = (v: unknown, max: number): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const phone10 = (v: unknown): string | null => {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
};

const SELECT = `
  c.id, c.amount, c.occurred_at, c.note, c.verified_at, c.status,
  c.user_id, c.donation_id, c.person_id, c.lead_id,
  u.name  AS caller_name,
  vu.name AS verified_by_name,
  col.donor_name, col.donor_phone, col.method, col.reference,
  col.receipt_status, col.receipt_number, col.receipt_site, col.sevak_name,
  col.donor_email, col.donor_pan, col.donor_address, col.purpose, col.receipt_error,
  ld.name AS lead_name
`;
const JOINS = `
  FROM caller_credits c
  JOIN users u ON c.user_id = u.id
  LEFT JOIN users vu ON c.verified_by = vu.id
  LEFT JOIN collections col ON col.credit_id = c.id
  LEFT JOIN leads ld ON ld.id = c.lead_id
`;

/**
 * POST /collections - "I collected this."
 *
 * Open to any signed-in role. A caller records what they took; an admin or
 * accountant can record on somebody else's behalf by naming them, which is
 * what reconciling a shift after the fact actually looks like.
 */
router.post('/collections', async (req, res) => {
  const me = req.user?.userId;
  if (!me) return res.status(401).json({ error: 'Sign in again' });

  const amount = num(req.body?.amount);
  const donorName = str(req.body?.donor_name, 160);
  const donorPhone = phone10(req.body?.donor_phone);

  if (amount === null || amount <= 0) return res.status(400).json({ error: 'Enter the amount.' });
  if (!donorName) return res.status(400).json({ error: 'Enter the Donor Name.' });
  if (!donorPhone) return res.status(400).json({ error: 'Enter a 10-digit mobile number.' });

  // A caller may only record money as their own. Anything else would make a
  // leaderboard something a person could write entries into.
  const forUser =
    req.user?.role === 'caller' ? me : str(req.body?.user_id, 36) ?? me;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // When the money actually arrived, defaulting to now. A caller writing up
    // Friday on Monday must be able to say Friday, or Friday reads as an
    // empty day and Monday as an extraordinary one.
    const when = parseDate(req.body?.at) ?? new Date().toISOString();

    /* THE LEAD THIS MONEY IS FROM.
     *
     * Named by the screen, or found by the donor's number: a lead still being
     * chased, or one marked "Donated now" on the call that is waiting for
     * exactly this money. Either way the entry lands on the lead - the chase
     * stops, and an amount said on the call is REPLACED by this one, not added
     * to it (services/leadMoney.ts). Before, an entry touched no lead at all:
     * the lead kept its own figure, and when the site's receipt for this money
     * synced back, the lead was credited a second time for the same gift. */
    const personId = str(req.body?.person_id, 36);
    const askedLead = str(req.body?.lead_id, 36);
    const leadId =
      (askedLead && (await client.query(`SELECT id FROM leads WHERE id = $1`, [askedLead])).rows[0]?.id) ||
      (await leadForPayer(client, { personId, phone: donorPhone }, when));
    const note = str(req.body?.note, 300) ?? `${donorName}, collected by PhonePe`;

    let credit: Credit | null = null;
    let leadUndo: LeadUndo | null = null;
    let replacedSaid: number | null | undefined;
    let leadName: string | null = null;
    if (leadId) {
      leadUndo = await leadBefore(client, leadId);
      const ld = (await client.query(`SELECT name, person_id FROM leads WHERE id = $1`, [leadId])).rows[0];
      leadName = ld?.name ?? null;
      const marked = await markLeadDonated(leadId, amount, note, client, forUser, {
        kind: 'offline',
        verified: false,
        occurredAt: when,
        personId: personId ?? ld?.person_id ?? undefined,
        createdBy: me,
      });
      credit = marked.credit;
      leadUndo.restored_credit = marked.replaced?.creditId ?? null;
      replacedSaid = marked.replaced ? marked.replaced.said : undefined;
    } else {
      credit = await recordCredit(
        {
          userId: forUser,
          amount,
          kind: 'offline',
          occurredAt: when,
          personId,
          note,
          createdBy: me,
          // The one path that reports money rather than observing it.
          verified: false,
        },
        client
      );
    }

    if (!credit) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Already added.' });
    }

    await client.query(
      `INSERT INTO collections
         (credit_id, donor_name, donor_phone, donor_email, donor_pan, donor_address,
          purpose, method, reference, sevak_name, sevak_phone, recorded_by, lead_undo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
      [
        credit.id,
        donorName,
        donorPhone,
        str(req.body?.donor_email, 160),
        (str(req.body?.donor_pan, 12) ?? '')?.toUpperCase() || null,
        str(req.body?.donor_address, 400),
        str(req.body?.purpose, 120),
        // How it reached the temple. Kept as free-ish text rather than an
        // enum because the honest answer is sometimes "PhonePe to the office
        // number" and an enum would turn that into "other".
        str(req.body?.method, 40) ?? 'upi',
        // The UTR, the PhonePe reference, the cheque number. This is what
        // whoever reconciles the statement will search for, so it is the one
        // field worth nagging about on the screen.
        str(req.body?.reference, 80),
        str(req.body?.sevak_name, 160),
        phone10(req.body?.sevak_phone),
        me,
        leadUndo ? JSON.stringify(leadUndo) : null,
      ]
    );

    await client.query('COMMIT');
    res.status(201).json({
      credit_id: credit.id,
      amount,
      occurred_at: credit.occurred_at,
      // Which lead it landed on, and the amount said on the call it replaced.
      lead: leadId ? { id: leadId, name: leadName, replaced_said: replacedSaid } : null,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('crm.recordCollection error:', err);
    res.status(500).json({ error: 'Could not save. Try again.' });
  } finally {
    client.release();
  }
});

/** The filters the list and the download both run, so they cannot disagree. */
function collectionFilters(q: Record<string, unknown>, user: { userId?: string; role?: string } | undefined) {
  const where: string[] = [`c.kind = 'offline'`, `c.status = 'active'`];
  const values: unknown[] = [];
  let i = 1;

  // A caller sees their own and nobody else's; anyone senior sees everything
  // and may narrow to one person.
  if (user?.role === 'caller') {
    where.push(`c.user_id = $${i++}::uuid`);
    values.push(user.userId);
  } else if (q.user_id) {
    where.push(`c.user_id = $${i++}::uuid`);
    values.push(String(q.user_id));
  }

  if (q.verified === 'no') where.push(`c.verified_at IS NULL`);
  if (q.verified === 'yes') where.push(`c.verified_at IS NOT NULL`);

  if (q.from_date) { where.push(`c.occurred_at >= $${i++}::date`); values.push(String(q.from_date)); }
  if (q.to_date) { where.push(`c.occurred_at < ($${i++}::date + INTERVAL '1 day')`); values.push(String(q.to_date)); }

  if (q.search) {
    where.push(`(col.donor_name ILIKE $${i} OR col.donor_phone ILIKE $${i} OR col.reference ILIKE $${i})`);
    values.push(`%${String(q.search).trim()}%`);
    i++;
  }

  return { where: `WHERE ${where.join(' AND ')}`, values, next: i };
}

router.get('/collections', async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
  try {
    const f = collectionFilters(q, req.user);
    const [rows, totals] = await Promise.all([
      pool.query(
        `SELECT ${SELECT} ${JOINS} ${f.where} ORDER BY c.occurred_at DESC LIMIT $${f.next}`,
        [...f.values, limit]
      ),
      // Totals computed in SQL over the whole set, never summed in JS over
      // the page. A "value at stake" figure that silently meant "of the first
      // five hundred rows" has already cost this product its credibility once.
      pool.query(
        `SELECT COUNT(*)::int AS total,
                COALESCE(SUM(c.amount), 0)::numeric AS amount,
                COALESCE(SUM(c.amount) FILTER (WHERE c.verified_at IS NULL), 0)::numeric AS awaiting,
                COUNT(*) FILTER (WHERE c.verified_at IS NULL)::int AS awaiting_count
           ${JOINS} ${f.where}`,
        f.values
      ),
    ]);
    const t = totals.rows[0];
    res.json({
      collections: rows.rows,
      total: t.total,
      amount: Number(t.amount),
      awaiting: Number(t.awaiting),
      awaiting_count: t.awaiting_count,
      complete: rows.rows.length >= t.total,
    });
  } catch (err) {
    console.error('crm.collections error:', err);
    res.status(500).json({ error: 'Could not load collections.' });
  }
});

async function exportCollections(
  req: import('express').Request,
  res: import('express').Response,
  format: ExportFormat
) {
  try {
    const q = req.query as Record<string, unknown>;
    const f = collectionFilters(q, req.user);
    const rows = await pool.query(
      `SELECT ${SELECT} ${JOINS} ${f.where} ORDER BY c.occurred_at DESC LIMIT ${EXPORT_ROW_CAP + 1}`,
      f.values
    );
    const truncated = rows.rows.length > EXPORT_ROW_CAP;
    await sendExport(res, format, {
      name: 'collected-by-phonepe',
      truncated,
      rows: truncated ? rows.rows.slice(0, EXPORT_ROW_CAP) : rows.rows,
      filterSummary: describeFilters(q, {
        user_id: 'Caller', verified: 'Checked', from_date: 'From', to_date: 'To', search: 'Search',
      }),
      columns: [
        { header: 'When', value: (r) => r.occurred_at, kind: 'datetime' },
        { header: 'Caller', value: (r) => r.caller_name },
        { header: 'Donor', value: (r) => r.donor_name },
        { header: 'Phone', value: (r) => r.donor_phone, kind: 'phone' },
        { header: 'Amount', value: (r) => r.amount, kind: 'money' },
        { header: 'How', value: (r) => r.method },
        { header: 'Reference', value: (r) => r.reference },
        { header: 'On the name of', value: (r) => r.sevak_name },
        { header: 'Checked', value: (r) => (r.verified_at ? 'Yes' : 'Awaiting') },
        { header: 'Checked by', value: (r) => r.verified_by_name },
        { header: 'Receipt', value: (r) => r.receipt_number },
        { header: 'Note', value: (r) => r.note },
      ],
    });
  } catch (err) {
    console.error('crm.exportCollections error:', err);
    res.status(500).json({ error: 'Could not download. Try again.' });
  }
}

router.get('/collections/export.csv', (req, res) => exportCollections(req, res, 'csv'));
router.get('/collections/export.xlsx', (req, res) => exportCollections(req, res, 'xlsx'));

/**
 * POST /collections/:creditId/verify - ticked off against the statement.
 *
 * Only an admin or accountant, and deliberately not the person who recorded
 * it: the whole value of the mark is that a second pair of eyes found the
 * money in the bank. Letting the recorder verify their own entry would make
 * the flag decorative.
 */
router.post('/collections/:creditId/verify', authorize('admin', 'accountant'), async (req, res) => {
  try {
    const ok = await verifyCredit(String(req.params.creditId), req.user?.userId ?? '');
    if (!ok) return res.status(404).json({ error: 'Nothing to mark.' });
    res.json({ verified: true });
  } catch (err) {
    console.error('crm.verifyCollection error:', err);
    res.status(500).json({ error: 'Could not mark. Try again.' });
  }
});

/**
 * DELETE /collections/:creditId - the money never arrived.
 *
 * Reversal, not deletion. The row stays with the reason on it, because the
 * record of a claim that turned out to be wrong is worth more than no record
 * at all - and reversing frees the evidence so the right person can claim it.
 */
router.delete('/collections/:creditId', authorize('admin', 'accountant'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ok = await reverseCredit(
      String(req.params.creditId),
      req.user?.userId ?? '',
      str(req.body?.reason, 300) ?? 'Not in the bank statement',
      client
    );
    if (!ok) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Nothing to undo.' });
    }
    // The lead it landed on goes back to how it was - and the amount said on
    // the call, which this entry had replaced, is counted again.
    const col = await client.query(`SELECT lead_undo FROM collections WHERE credit_id = $1`, [req.params.creditId]);
    const undo = col.rows[0]?.lead_undo as LeadUndo | null;
    if (undo) {
      await restoreLead(client, undo, req.user?.userId ?? null, 'PhonePe entry removed: not in the bank statement');
      await client.query(`UPDATE collections SET lead_undo = NULL WHERE credit_id = $1`, [req.params.creditId]);
    }
    await client.query('COMMIT');
    res.json({ reversed: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('crm.reverseCollection error:', err);
    res.status(500).json({ error: 'Could not undo. Try again.' });
  } finally {
    client.release();
  }
});

/**
 * POST /collections/:creditId/receipt - give the donor their 80G certificate.
 *
 * THIS IS THE STEP THAT CREATES REAL MONEY ON A REAL SITE. Everything before
 * it was DRM's own bookkeeping; this posts an offline donation to HKMV or
 * annadan, which mints a receipt number, files it with DCC and sends the
 * donor their certificate. It cannot be undone from here.
 *
 * Which is why it is a second, deliberate action rather than part of
 * recording the collection, and why the reference number is required: that
 * string is the only thing tying the certificate to a line on a bank
 * statement, and it is also what makes a retry safe - both sites refuse a
 * duplicate reference, so pressing this twice cannot produce two receipts.
 */
router.post('/collections/:creditId/receipt', async (req, res) => {
  const me = req.user?.userId;
  if (!me) return res.status(401).json({ error: 'Sign in again' });

  try {
    const { rows } = await pool.query(
      `SELECT c.id AS credit_id, c.user_id, c.amount, c.occurred_at,
              col.*
         FROM caller_credits c
         JOIN collections col ON col.credit_id = c.id
        WHERE c.id = $1 AND c.status = 'active'
          AND ($2::uuid IS NULL OR c.user_id = $2::uuid)`,
      [req.params.creditId, req.user?.role === 'caller' ? me : null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Entry not found.' });
    const c = rows[0];

    if (c.receipt_status === 'issued') {
      return res.status(409).json({ error: 'Receipt already issued.', receipt_number: c.receipt_number });
    }

    /* WHAT THE RECEIPT DIALOG FILLED IN, saved before the receipt is raised.
     *
     * The UTR, PAN or address often only turns up when the receipt is asked
     * for. The dialog shows the entry's details already filled and lets them
     * be completed there, rather than sending the caller off to find another
     * screen to edit the entry first. Only what was sent is changed. */
    const b = req.body ?? {};
    const patch: Record<string, string | null> = {};
    if (b.reference !== undefined) patch.reference = str(b.reference, 80);
    if (b.donor_name !== undefined && str(b.donor_name, 160)) patch.donor_name = str(b.donor_name, 160);
    if (b.donor_phone !== undefined && phone10(b.donor_phone)) patch.donor_phone = phone10(b.donor_phone);
    if (b.donor_email !== undefined) patch.donor_email = str(b.donor_email, 160);
    if (b.donor_pan !== undefined) patch.donor_pan = (str(b.donor_pan, 12) ?? '').toUpperCase() || null;
    if (b.donor_address !== undefined) patch.donor_address = str(b.donor_address, 400);
    if (b.purpose !== undefined) patch.purpose = str(b.purpose, 120);
    if (b.sevak_name !== undefined) patch.sevak_name = str(b.sevak_name, 160);
    if (b.method !== undefined && str(b.method, 40)) patch.method = str(b.method, 40);
    const keys = Object.keys(patch);
    if (keys.length) {
      await pool.query(
        `UPDATE collections SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE credit_id = $1`,
        [c.credit_id, ...keys.map((k) => patch[k])]
      );
      Object.assign(c, patch);
    }
    // 80G is only sent with a PAN; "no 80G" sends the receipt without it.
    const want80G = b.want_80g === undefined ? !!c.donor_pan : b.want_80g === true;
    const wantPrasadam = b.want_prasadam === true;
    if (want80G && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(String(c.donor_pan ?? ''))) {
      return res.status(400).json({ error: 'Enter a valid PAN Number.' });
    }
    if ((want80G || wantPrasadam) && !c.donor_address) {
      return res.status(400).json({ error: 'Enter the Address.' });
    }
    if (!c.reference) {
      return res.status(400).json({
        error: 'Enter the Transaction ID (UTR) first.',
      });
    }

    const site = (str(req.body?.site, 20) ?? c.receipt_site) as SiteKey | null;
    if (!site) return res.status(400).json({ error: 'Pick the site for the receipt.' });

    await pool.query(
      `UPDATE collections SET receipt_status = 'pending', receipt_error = NULL, receipt_site = $2
        WHERE credit_id = $1`,
      [c.credit_id, site]
    );

    try {
      const result = await createOfflineDonation(site, {
        donorName: c.donor_name,
        donorMobile: c.donor_phone,
        donorEmail: c.donor_email || null,
        amount: Number(c.amount),
        paymentMode: ['cash', 'cheque', 'bank'].includes(String(c.method)) ? String(c.method) : 'upi',
        referenceNo: c.reference,
        paymentDate: new Date(c.occurred_at).toISOString(),
        sevaName: c.purpose || undefined,
        panNumber: want80G ? c.donor_pan || undefined : undefined,
        wantCertificate: want80G,
        wantPrasadam,
        prasadamAddress: c.donor_address || undefined,
        sevakName: c.sevak_name || undefined,
        sevakMobile: c.sevak_phone || undefined,
        enteredByName: `DRM · collected by PhonePe`,
        note: `Added in DRM. Transaction ID: ${c.reference}.`,
      });

      await pool.query(
        `UPDATE collections SET receipt_status = 'issued', receipt_number = $2,
           external_donation_id = $3, receipt_error = NULL, receipt_at = NOW(), receipt_by = $4
         WHERE credit_id = $1`,
        [c.credit_id, result.receiptNumber, result.externalId, me]
      );
      res.json({ receipt_status: 'issued', receipt_number: result.receiptNumber });
    } catch (e) {
      const err = e as Error & { status?: number };
      // A refused duplicate reference means the receipt already exists on the
      // site, which is a success for the donor even though the call failed.
      // HKMV answers 409 for that; annadan answers 400, so both are read as
      // a duplicate when the message says so.
      const duplicate = err.status === 409 || /duplicate|already/i.test(err.message);
      await pool.query(
        `UPDATE collections SET receipt_status = $2, receipt_error = $3 WHERE credit_id = $1`,
        [c.credit_id, duplicate ? 'issued' : 'failed', duplicate ? null : err.message]
      );
      if (duplicate) return res.json({ receipt_status: 'issued', duplicate: true });
      res.status(err.status && err.status < 500 ? err.status : 502).json({
        error: err.message || 'The site did not issue the receipt. Try again.',
      });
    }
  } catch (err) {
    console.error('crm.collectionReceipt error:', err);
    res.status(500).json({ error: 'Could not issue receipt. Try again.' });
  }
});

/** A short summary for the caller's own overview. */
router.get('/collections/summary', async (req, res) => {
  const me = req.user?.role === 'caller' ? req.user?.userId ?? null : null;
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(c.amount), 0)::numeric AS amount,
              COUNT(*)::int AS count,
              COALESCE(SUM(c.amount) FILTER (WHERE c.verified_at IS NULL), 0)::numeric AS awaiting
         FROM caller_credits c
        WHERE c.kind = 'offline' AND c.status = 'active'
          AND c.occurred_at >= date_trunc('month', NOW())
          AND ($1::uuid IS NULL OR c.user_id = $1)`,
      [me]
    );
    res.json({ month: istDate().slice(0, 7), ...rows[0], amount: Number(rows[0].amount) });
  } catch (err) {
    console.error('crm.collectionSummary error:', err);
    res.status(500).json({ error: 'Could not load that summary' });
  }
});

export default router;
