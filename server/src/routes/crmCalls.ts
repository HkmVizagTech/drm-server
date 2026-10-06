// A caller's own record of the phone, and the two situations the call screen
// could not express.
//
//   GET  /calls                       - "what calls have I made, and to whom"
//   GET  /calls/export.(csv|xlsx)     - the same, as a file
//   GET  /leads/:id/donation-candidates
//   POST /leads/:id/link-donation     - "they gave, but from another number"
//   POST /link-donation/:activityId/undo
//
// THE OTHER NUMBER
// Somebody tries to give on the website, the payment fails, and they finish
// it on their son's phone - another number, another name. DRM matches money to
// leads on the phone number, so that donation lands on a stranger and the
// lead stays "nearly gave" for ever: rung again, chased again, and the caller
// who talked them through it credited with nothing. Only the caller knows the
// two are the same family. So the caller is shown the donations and QR
// payments that came in around then - closest amount and name first - and
// links the right one. The link is the conversion, the credit, and the end of
// the chase, in one step, and it can be undone for half an hour.

import { Router } from 'express';
import pool from '../db/pool';
import { authenticate } from '../middleware/auth';
import { recordCredit } from '../services/credits';
import { markLeadDonated } from './crmQr';
import { leadScopeFor } from './crm';
import { FROM_DONATIONS_PAGE } from './crmLists';
import { sendExport, describeFilters, EXPORT_ROW_CAP, type ExportFormat } from '../utils/export';

const router = Router();
router.use(authenticate);

const str = (v: unknown, max = 255): string | null => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------- call log */

/**
 * The filters for the call log, shared by the screen and the export so the
 * file is exactly what was on screen.
 *
 * Whose calls: a caller sees their own and nobody else's. An admin,
 * accountant or coordinator sees their own by default, anyone's with
 * user_id, and the whole team's with user_id=all.
 */
function buildCallFilters(q: Record<string, unknown>, user?: { userId?: string; role?: string }) {
  const conds: string[] = [`a.kind = 'call'`];
  const values: unknown[] = [];
  const p = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  const elevated = !!user?.role && user.role !== 'caller';
  const asked = str(q.user_id, 36);
  if (elevated && asked === 'all') {
    // the whole team
  } else if (elevated && asked && UUID_RE.test(asked)) {
    conds.push(`a.user_id = ${p(asked)}::uuid`);
  } else {
    conds.push(`a.user_id = ${p(user?.userId ?? null)}::uuid`);
  }

  // Indian calendar days; the session runs on IST, so ::date is IST midnight.
  const from = DATE_RE.test(String(q.from ?? '')) ? String(q.from) : null;
  const to = DATE_RE.test(String(q.to ?? '')) ? String(q.to) : null;
  if (from) conds.push(`a.occurred_at >= ${p(from)}::date`);
  if (to) conds.push(`a.occurred_at < ${p(to)}::date + INTERVAL '1 day'`);

  if (q.disposition) {
    conds.push(`a.disposition = ANY(${p(String(q.disposition).split(',').filter(Boolean))}::text[])`);
  }
  if (q.connected === 'true') conds.push(`a.connected = TRUE`);
  else if (q.connected === 'false') conds.push(`a.connected IS NOT TRUE`);
  if (q.direction === 'inbound' || q.direction === 'outbound') {
    conds.push(`COALESCE(a.direction, 'outbound') = ${p(q.direction)}`);
  }
  if (q.search) {
    const term = String(q.search).trim();
    const digits = term.replace(/\D/g, '');
    if (digits.length >= 4) conds.push(`(l.phone LIKE ${p(`%${digits.slice(-10)}%`)} OR l.alt_phone LIKE $${values.length})`);
    else conds.push(`(l.name ILIKE ${p(`%${term}%`)} OR a.note ILIKE $${values.length})`);
  }
  if (UUID_RE.test(String(q.lead_id ?? ''))) conds.push(`a.lead_id = ${p(q.lead_id)}::uuid`);
  return { where: `WHERE ${conds.join(' AND ')}`, values };
}

const CALL_SELECT = `
  SELECT a.id, a.occurred_at, a.created_at, a.disposition, d.label AS disposition_label,
         a.connected, a.duration_seconds, a.note, COALESCE(a.direction, 'outbound') AS direction,
         a.session_id, COALESCE(sess.source_label, cl.name) AS run_label,
         a.user_id, u.name AS caller_name,
         l.id AS lead_id, l.name AS lead_name, l.phone AS lead_phone, l.alt_phone AS lead_alt_phone,
         l.status AS lead_status, st.label AS lead_status_label, l.next_follow_up_at,
         l.converted_at, l.converted_amount, l.do_not_call,
         (a.undo_payload IS NOT NULL AND a.created_at > NOW() - INTERVAL '30 minutes') AS undoable
    FROM lead_activities a
    JOIN leads l ON l.id = a.lead_id
    LEFT JOIN crm_dispositions d ON d.slug = a.disposition
    LEFT JOIN crm_statuses st ON st.slug = l.status
    LEFT JOIN users u ON u.id = a.user_id
    LEFT JOIN calling_sessions sess ON sess.id = a.session_id
    LEFT JOIN calling_lists cl ON cl.id = sess.list_id`;

/**
 * GET /calls - every call this person logged, newest first, with what came
 * of each one since (the lead's stage now, a callback booked, money).
 */
router.get('/calls', async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const page = Math.max(1, Number(q.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
  try {
    const f = buildCallFilters(q, req.user);
    const n = f.values.length;
    const [rows, totals, outcomes] = await Promise.all([
      pool.query(`${CALL_SELECT} ${f.where} ORDER BY a.occurred_at DESC LIMIT $${n + 1} OFFSET $${n + 2}`, [
        ...f.values,
        limit,
        (page - 1) * limit,
      ]),
      pool.query(
        `SELECT COUNT(*)::int AS calls,
                COUNT(*) FILTER (WHERE a.connected)::int AS connected,
                COUNT(DISTINCT a.lead_id)::int AS people,
                COUNT(*) FILTER (WHERE COALESCE(a.direction,'outbound') = 'inbound')::int AS inbound,
                COUNT(DISTINCT a.lead_id) FILTER (WHERE l.converted_at >= a.occurred_at)::int AS gave_since,
                COALESCE(SUM(a.duration_seconds), 0)::int AS seconds
           FROM lead_activities a JOIN leads l ON l.id = a.lead_id ${f.where}`,
        f.values
      ),
      pool.query(
        `SELECT a.disposition, COALESCE(d.label, a.disposition) AS label, COUNT(*)::int AS n
           FROM lead_activities a JOIN leads l ON l.id = a.lead_id
           LEFT JOIN crm_dispositions d ON d.slug = a.disposition
           ${f.where}
          GROUP BY a.disposition, d.label ORDER BY n DESC`,
        f.values
      ),
    ]);
    res.json({ calls: rows.rows, totals: { ...totals.rows[0], by_outcome: outcomes.rows }, page, limit });
  } catch (err) {
    console.error('crm.callLog error:', err);
    res.status(500).json({ error: 'Could not load your calls' });
  }
});

async function exportCalls(req: import('express').Request, res: import('express').Response, format: ExportFormat) {
  const q = req.query as Record<string, unknown>;
  try {
    const f = buildCallFilters(q, req.user);
    const r = await pool.query(`${CALL_SELECT} ${f.where} ORDER BY a.occurred_at DESC LIMIT ${EXPORT_ROW_CAP + 1}`, f.values);
    const truncated = r.rows.length > EXPORT_ROW_CAP;
    await sendExport(res, format, {
      name: 'calls',
      truncated,
      rows: truncated ? r.rows.slice(0, EXPORT_ROW_CAP) : r.rows,
      filterSummary: describeFilters(q, {
        from: 'From',
        to: 'To',
        disposition: 'Outcome',
        connected: 'Got through',
        direction: 'Direction',
        search: 'Search',
        user_id: 'Caller',
      }),
      columns: [
        { header: 'When', value: (x) => x.occurred_at, kind: 'datetime' },
        { header: 'Caller', value: (x) => x.caller_name },
        { header: 'Name', value: (x) => x.lead_name },
        { header: 'Phone', value: (x) => x.lead_phone, kind: 'phone' },
        { header: 'Direction', value: (x) => (x.direction === 'inbound' ? 'They rang' : 'Rang them') },
        { header: 'Outcome', value: (x) => x.disposition_label ?? x.disposition },
        { header: 'Got through', value: (x) => (x.connected ? 'Yes' : 'No') },
        { header: 'Seconds', value: (x) => x.duration_seconds, kind: 'number' },
        { header: 'Note', value: (x) => x.note },
        { header: 'Run', value: (x) => x.run_label },
        { header: 'Stage now', value: (x) => x.lead_status_label ?? x.lead_status },
        { header: 'Callback', value: (x) => x.next_follow_up_at, kind: 'datetime' },
        { header: 'Donated', value: (x) => x.converted_amount, kind: 'money' },
      ],
    });
  } catch (err) {
    console.error('crm.exportCalls error:', err);
    res.status(500).json({ error: 'Could not download. Try again.' });
  }
}
router.get('/calls/export.csv', (req, res) => exportCalls(req, res, 'csv'));
router.get('/calls/export.xlsx', (req, res) => exportCalls(req, res, 'xlsx'));

/* ------------------------------------------------------ the other number */

async function loadLeadFor(id: string, user?: { userId?: string; role?: string }) {
  if (!UUID_RE.test(id)) return null;
  const scope = await leadScopeFor(user);
  const r = await pool.query(
    `SELECT l.*,
            (SELECT a.attempted_at FROM abandoned_attempts a WHERE a.phone = l.phone AND NOT ${FROM_DONATIONS_PAGE('a')} ORDER BY a.attempted_at DESC LIMIT 1) AS attempted_at,
            (SELECT a.amount FROM abandoned_attempts a WHERE a.phone = l.phone AND NOT ${FROM_DONATIONS_PAGE('a')} ORDER BY a.attempted_at DESC LIMIT 1) AS attempt_amount
       FROM leads l
      WHERE l.id = $1 AND ($2::uuid IS NULL OR l.assigned_to = $2::uuid OR l.assigned_to IS NULL OR l.assigned_to IN (SELECT id FROM users WHERE role <> 'caller'))`,
    [id, scope]
  );
  return r.rows[0] ?? null;
}

/**
 * GET /leads/:id/donation-candidates?q=&days=
 *
 * Donations and temple-QR payments that could be this person's under another
 * name or number. Ranked, not filtered: the same amount they tried to give,
 * a name that shares a word with theirs, and closeness in time each move a
 * row up. The caller decides; DRM only puts the likely ones first.
 *
 * Window: from a day before they first tried (or were added) up to now, at
 * most 90 days back, unless `days` says otherwise.
 */
router.get('/leads/:id/donation-candidates', async (req, res) => {
  try {
    const lead = await loadLeadFor(String(req.params.id), req.user);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const days = Number(req.query.days);
    const anchor = new Date(Math.min(
      +new Date(lead.attempted_at ?? lead.created_at),
      +new Date(lead.created_at)
    ) - 86_400_000);
    const floor = new Date(Date.now() - 90 * 86_400_000);
    const since = Number.isFinite(days) && days > 0
      ? new Date(Date.now() - Math.min(365, days) * 86_400_000)
      : anchor < floor ? floor : anchor;

    const term = String(req.query.q ?? '').trim().slice(0, 80);
    const digits = term.replace(/\D/g, '');
    const amountTerm = /^\d+(\.\d+)?$/.test(term) ? Number(term) : null;
    const want = Number(lead.attempt_amount ?? lead.expected_amount) || null;
    const firstName = String(lead.name ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    const nameWord = firstName.length >= 3 ? firstName : '';

    const [donations, payments] = await Promise.all([
      pool.query(
        `SELECT d.id, d.amount, d.created_at AS at, d.purpose, d.source_site, d.source_page,
                d.receipt_number, d.sevak_name, p.name AS donor_name, p.phone AS donor_phone,
                ll.id AS linked_lead_id, ll.name AS linked_lead_name,
                cu.name AS credited_to,
                ((CASE WHEN $3::numeric IS NOT NULL AND d.amount = $3::numeric THEN 3 ELSE 0 END)
                 + (CASE WHEN $4::text <> '' AND (lower(p.name) LIKE '%' || $4 || '%'
                                                OR lower(COALESCE(d.sevak_name,'')) LIKE '%' || $4 || '%') THEN 2 ELSE 0 END)
                 + (CASE WHEN d.created_at > NOW() - INTERVAL '3 days' THEN 1 ELSE 0 END)) AS score
           FROM donations d
           JOIN people p ON p.id = d.person_id
           LEFT JOIN leads ll ON ll.converted_donation_id = d.id
           LEFT JOIN caller_credits cc ON cc.donation_id = d.id AND cc.status = 'active'
           LEFT JOIN users cu ON cu.id = cc.user_id
          WHERE d.created_at >= $1::timestamptz
            AND ($2::text = ''
                 OR p.name ILIKE '%' || $2 || '%'
                 OR d.sevak_name ILIKE '%' || $2 || '%'
                 OR d.receipt_number ILIKE '%' || $2 || '%'
                 OR ($5::text <> '' AND regexp_replace(p.phone, '\\D', '', 'g') LIKE '%' || $5 || '%')
                 OR ($6::numeric IS NOT NULL AND d.amount = $6::numeric))
          ORDER BY score DESC, d.created_at DESC
          LIMIT 25`,
        [since.toISOString(), term, want, nameWord, digits.length >= 4 ? digits.slice(-10) : '', amountTerm]
      ),
      pool.query(
        `SELECT p.id, p.amount, p.received_at AS at, p.payer_name, p.payer_vpa, p.payer_phone,
                q.label AS qr_label, cu.name AS credited_to,
                ((CASE WHEN $3::numeric IS NOT NULL AND p.amount = $3::numeric THEN 3 ELSE 0 END)
                 + (CASE WHEN $4::text <> '' AND lower(COALESCE(p.payer_name,'') || ' ' || COALESCE(p.payer_vpa,'')) LIKE '%' || $4 || '%' THEN 2 ELSE 0 END)
                 + (CASE WHEN p.received_at > NOW() - INTERVAL '3 days' THEN 1 ELSE 0 END)) AS score
           FROM qr_payments p
           LEFT JOIN razorpay_qrs q ON q.qr_id = p.qr_id
           LEFT JOIN caller_credits cc ON cc.qr_payment_id = p.id AND cc.status = 'active'
           LEFT JOIN users cu ON cu.id = cc.user_id
          WHERE p.received_at >= $1::timestamptz
            AND p.share_id IS NULL AND p.lead_id IS NULL AND p.person_id IS NULL
            AND COALESCE(p.status, 'captured') IN ('captured', 'authorized')
            AND ($2::text = ''
                 OR p.payer_name ILIKE '%' || $2 || '%'
                 OR p.payer_vpa ILIKE '%' || $2 || '%'
                 OR ($5::text <> '' AND COALESCE(p.payer_phone,'') LIKE '%' || $5 || '%')
                 OR ($6::numeric IS NOT NULL AND p.amount = $6::numeric))
          ORDER BY score DESC, p.received_at DESC
          LIMIT 25`,
        [since.toISOString(), term, want, nameWord, digits.length >= 4 ? digits.slice(-10) : '', amountTerm]
      ),
    ]);

    res.json({
      lead: { id: lead.id, name: lead.name, phone: lead.phone, expected: want, since: since.toISOString() },
      donations: donations.rows.map((r) => ({ ...r, kind: 'donation', likely: r.score >= 3 })),
      qr_payments: payments.rows.map((r) => ({ ...r, kind: 'qr', likely: r.score >= 3 })),
    });
  } catch (err) {
    console.error('crm.donationCandidates error:', err);
    res.status(500).json({ error: 'Could not search donations. Try again.' });
  }
});

/**
 * POST /leads/:id/link-donation { donation_id | qr_payment_id, note?, user_id? }
 *
 * "This donation is theirs." Converts the lead with that donation's amount
 * and date, credits the caller (or, for an admin reconciling, the person
 * named, else the lead's caller), closes their open promises, and remembers
 * the other number on the lead so it is recognised next time.
 *
 * Refuses money already linked to another lead. Money already credited to a
 * colleague still converts the lead - it IS this person's donation - but the
 * credit stays where it is, and the answer says so.
 */
router.post('/leads/:id/link-donation', async (req, res) => {
  const b = req.body ?? {};
  const me = req.user?.userId ?? null;
  const donationId = str(b.donation_id, 36);
  const qrId = str(b.qr_payment_id, 36);
  if (!donationId && !qrId) return res.status(400).json({ error: 'Pick their donation.' });

  const elevated = req.user?.role && req.user.role !== 'caller';
  const client = await pool.connect();
  try {
    const lead = await loadLeadFor(String(req.params.id), req.user);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const creditTo = (elevated && UUID_RE.test(String(b.user_id ?? '')) ? String(b.user_id) : null)
      ?? (elevated ? lead.assigned_to ?? me : me);

    await client.query('BEGIN');
    const before = await client.query(
      `SELECT status, converted_at, converted_amount, converted_via, converted_note, converted_donation_id,
              conversion_seen_at, next_follow_up_at, follow_up_note, awaiting_qr_at, alt_phone, assigned_to
         FROM leads WHERE id = $1 FOR UPDATE`,
      [lead.id]
    );

    let amount = 0;
    let at: string;
    let label: string;
    let otherPhone: string | null = null;
    let credited: { ok: boolean; already?: string | null } = { ok: false };

    if (donationId) {
      const d = await client.query(
        `SELECT d.*, p.name AS donor_name, p.phone AS donor_phone,
                (SELECT id FROM leads WHERE converted_donation_id = d.id AND id <> $2) AS other_lead,
                (SELECT u.name FROM caller_credits c JOIN users u ON u.id = c.user_id
                  WHERE c.donation_id = d.id AND c.status = 'active' LIMIT 1) AS credited_to
           FROM donations d JOIN people p ON p.id = d.person_id WHERE d.id = $1 FOR UPDATE OF d`,
        [donationId, lead.id]
      );
      if (!d.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Donation not found.' });
      }
      const row = d.rows[0];
      if (row.other_lead) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'This donation is linked to another lead.' });
      }
      amount = Number(row.amount);
      at = row.created_at;
      otherPhone = String(row.donor_phone ?? '').replace(/\D/g, '').slice(-10) || null;
      label = `₹${amount.toLocaleString('en-IN')} by ${row.donor_name ?? 'someone'}${otherPhone ? ` (${otherPhone})` : ''}${row.receipt_number ? `, receipt ${row.receipt_number}` : ''}`;

      await client.query(
        `UPDATE leads SET
           status = 'converted', converted_donation_id = $2, converted_amount = $3::numeric,
           converted_at = $4::timestamptz, converted_via = 'linked',
           converted_note = $5, conversion_seen_at = NOW(),
           next_follow_up_at = NULL, follow_up_note = NULL, awaiting_qr_at = NULL,
           assigned_to = COALESCE(assigned_to, $6::uuid),
           assigned_at = CASE WHEN assigned_to IS NULL AND $6::uuid IS NOT NULL THEN NOW() ELSE assigned_at END,
           updated_at = NOW()
         WHERE id = $1`,
        [lead.id, donationId, amount, at, `Gave from another number: ${label}`, creditTo]
      );
      if (row.credited_to) credited = { ok: false, already: row.credited_to };
      else if (creditTo && amount > 0) {
        const c = await recordCredit(
          {
            userId: creditTo,
            amount,
            kind: 'lead',
            occurredAt: at,
            leadId: lead.id,
            donationId,
            personId: row.person_id,
            note: `Gave from another number: ${label}`,
            createdBy: me,
          },
          client
        );
        credited = c ? { ok: true } : { ok: false, already: 'somebody else' };
      }
    } else {
      const p = await client.query(
        `SELECT p.*, (SELECT u.name FROM caller_credits c JOIN users u ON u.id = c.user_id
                       WHERE c.qr_payment_id = p.id AND c.status = 'active' LIMIT 1) AS credited_to
           FROM qr_payments p WHERE p.id = $1 FOR UPDATE OF p`,
        [qrId]
      );
      if (!p.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Payment not found.' });
      }
      const row = p.rows[0];
      // Linked by any route - a QR send, a lead or a person - not only a send.
      if (row.share_id || row.lead_id || row.person_id) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'This payment is already linked.' });
      }
      amount = Number(row.amount);
      at = row.received_at;
      otherPhone = row.payer_phone ?? null;
      label = `₹${amount.toLocaleString('en-IN')} by QR from ${row.payer_name ?? row.payer_vpa ?? 'an unknown payer'}`;
      // The credit goes through markLeadDonated only when nobody has it yet.
      await markLeadDonated(lead.id, amount, `Gave from another number: ${label}`, client, row.credited_to ? null : creditTo, {
        qrPaymentId: row.id,
        personId: lead.person_id ?? undefined,
        occurredAt: at,
      });
      await client.query(`UPDATE leads SET converted_via = 'linked', converted_at = $2::timestamptz WHERE id = $1`, [lead.id, at]);
      // On the payment too, so the QR payments screen shows who it was and
      // stops listing it as "Not linked".
      await client.query(
        `UPDATE qr_payments SET lead_id = $2, person_id = COALESCE(person_id, $3::uuid),
           linked_by = $4::uuid, linked_at = NOW(), link_kind = 'lead'
         WHERE id = $1`,
        [row.id, lead.id, lead.person_id ?? null, me]
      );
      credited = row.credited_to ? { ok: false, already: row.credited_to } : { ok: !!creditTo };
    }

    // Remember the number they paid from, so their next donation from it is
    // recognised without anybody having to link it again.
    if (otherPhone && /^[6-9]\d{9}$/.test(otherPhone) && otherPhone !== lead.phone && !before.rows[0].alt_phone) {
      await client.query(`UPDATE leads SET alt_phone = $2 WHERE id = $1`, [lead.id, otherPhone]);
    }

    // Their promises are kept - closed, and remembered for Undo.
    const closed = await client.query(
      `UPDATE lead_reminders SET status = 'done', completed_at = NOW(), updated_at = NOW()
        WHERE lead_id = $1 AND status = 'open' RETURNING id`,
      [lead.id]
    );

    const act = await client.query(
      `INSERT INTO lead_activities (lead_id, user_id, kind, from_value, to_value, note, undo_payload)
       VALUES ($1, $2, 'link_donation', $3, 'converted', $4, $5::jsonb) RETURNING id`,
      [
        lead.id,
        me,
        before.rows[0].status,
        `Gave from another number: ${label}${str(b.note, 300) ? `. ${str(b.note, 300)}` : ''}`,
        JSON.stringify({
          before: before.rows[0],
          donation_id: donationId,
          qr_payment_id: qrId,
          closed_reminders: closed.rows.map((r) => r.id),
          set_alt_phone: !before.rows[0].alt_phone,
        }),
      ]
    );
    await client.query('COMMIT');

    res.json({
      linked: true,
      activity_id: act.rows[0].id,
      amount,
      credited: credited.ok,
      credited_to_other: credited.already ?? null,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('crm.linkDonation error:', err);
    res.status(500).json({ error: 'Could not link donation. Try again.' });
  } finally {
    client.release();
  }
});

/** POST /link-donation/:activityId/undo - within half an hour, by whoever did it (or an admin). */
router.post('/link-donation/:activityId/undo', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = await client.query(
      `SELECT * FROM lead_activities
        WHERE id = $1 AND kind = 'link_donation' AND undo_payload IS NOT NULL
          AND created_at > NOW() - INTERVAL '30 minutes'
          AND ($2::text = 'admin' OR user_id = $3::uuid)
        FOR UPDATE`,
      [req.params.activityId, req.user?.role ?? '', req.user?.userId ?? null]
    );
    if (!a.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "Can't undo this now." });
    }
    const act = a.rows[0];
    const u = act.undo_payload as {
      before: Record<string, unknown>;
      donation_id: string | null;
      qr_payment_id: string | null;
      closed_reminders: string[];
      set_alt_phone: boolean;
    };
    const bf = u.before;
    await client.query(
      `UPDATE leads SET status = $2, converted_at = $3::timestamptz, converted_amount = $4::numeric,
              converted_via = $5, converted_note = $6, converted_donation_id = $7::uuid,
              conversion_seen_at = $8::timestamptz, next_follow_up_at = $9::timestamptz,
              follow_up_note = $10, awaiting_qr_at = $11::timestamptz, assigned_to = $12::uuid,
              alt_phone = CASE WHEN $13::boolean THEN NULL ELSE alt_phone END,
              updated_at = NOW()
        WHERE id = $1`,
      [
        act.lead_id, bf.status, bf.converted_at, bf.converted_amount, bf.converted_via, bf.converted_note,
        bf.converted_donation_id, bf.conversion_seen_at, bf.next_follow_up_at, bf.follow_up_note,
        bf.awaiting_qr_at, bf.assigned_to, u.set_alt_phone,
      ]
    );
    const by = req.user?.userId ?? '';
    if (u.donation_id) {
      await client.query(
        `UPDATE caller_credits SET status = 'reversed', reversed_at = NOW(), reversed_by = $3::uuid,
                reversed_reason = 'Link undone'
          WHERE donation_id = $1 AND lead_id = $2 AND status = 'active'`,
        [u.donation_id, act.lead_id, by || null]
      );
    }
    if (u.qr_payment_id) {
      await client.query(
        `UPDATE caller_credits SET status = 'reversed', reversed_at = NOW(), reversed_by = $3::uuid,
                reversed_reason = 'Link undone'
          WHERE qr_payment_id = $1 AND lead_id = $2 AND status = 'active'`,
        [u.qr_payment_id, act.lead_id, by || null]
      );
      await client.query(
        `UPDATE qr_payments SET lead_id = NULL, person_id = NULL, linked_by = NULL, linked_at = NULL, link_kind = NULL
          WHERE id = $1 AND lead_id = $2`,
        [u.qr_payment_id, act.lead_id]
      );
    }
    if (u.closed_reminders?.length) {
      await client.query(
        `UPDATE lead_reminders SET status = 'open', completed_at = NULL, updated_at = NOW()
          WHERE id = ANY($1::uuid[]) AND status = 'done'`,
        [u.closed_reminders]
      );
    }
    // markLeadDonated writes its own status_change row; it goes with the link.
    await client.query(
      `DELETE FROM lead_activities WHERE lead_id = $1 AND kind = 'status_change'
          AND created_at = $2::timestamptz`,
      [act.lead_id, act.created_at]
    );
    await client.query(`DELETE FROM lead_activities WHERE id = $1`, [act.id]);
    await client.query('COMMIT');
    res.json({ undone: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('crm.undoLinkDonation error:', err);
    res.status(500).json({ error: 'Could not undo. Try again.' });
  } finally {
    client.release();
  }
});

export default router;
