// One gift, counted once.
//
// THE CASE THIS FILE EXISTS FOR
// On a call the donor says "I'm paying now", the caller presses Donated now
// and types ₹1,000. A minute later ₹1,000 lands on the temple QR (or PhonePe),
// and somebody links that payment to the same person. That is ONE gift seen
// twice: once as the caller's word, once as the money itself.
//
// Before this, the second sighting was added to the first. The lead read
// ₹2,000, and when the word had its own credit (the lead page's "Donated"
// button writes one) the caller's total could carry both.
//
// THE RULE
// A lead converted only on somebody's word - no QR payment, PhonePe entry or
// site donation behind it - is waiting for its money. When real money for that
// lead arrives within SAME_GIFT_DAYS of the word, the money REPLACES the word:
//   - the lead's amount becomes the real amount (not word + real);
//   - the word's credit, if it had one, is reversed (kept, with the reason),
//     and the real payment's credit stands in its place, for the same caller.
// Real money arriving for a lead that already has real money behind it, or
// long after the word, is a new gift and is added as before.
//
// Replacing rather than adding is the safe side: it can never show more money
// than actually arrived.

import type { PoolClient } from 'pg';

export const SAME_GIFT_DAYS = 30;

type Db = { query: PoolClient['query'] };

export interface WordCredit {
  id: string;
  user_id: string;
  amount: string;
}

export interface LeadMoneyState {
  converted: boolean;
  /** Converted on somebody's word alone - nothing real behind it yet. */
  wordOnly: boolean;
  /** wordOnly, and close enough in time to this money to be the same gift. */
  sameGift: boolean;
  /** Converted within SAME_GIFT_DAYS of the moment asked about. */
  near: boolean;
  saidAmount: number | null;
  wordCredit: WordCredit | null;
}

/**
 * Where a lead's money stands, seen from a payment about to land on it.
 * `except` names that payment (and its QR send), which may already be
 * half-written by the caller's transaction and must not count as evidence
 * that the lead was already paid.
 */
export async function leadMoneyState(
  db: Db,
  leadId: string,
  except: { qrPaymentId?: string | null; shareId?: string | null; at?: string | Date | null } = {}
): Promise<LeadMoneyState | null> {
  const at = except.at instanceof Date ? except.at.toISOString() : except.at ?? null;
  const { rows } = await db.query(
    `SELECT l.converted_at IS NOT NULL AS converted,
            l.converted_amount,
            (l.converted_at IS NOT NULL
             AND l.converted_donation_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM qr_payments p
                              WHERE p.lead_id = l.id AND p.id IS DISTINCT FROM $2::uuid)
             AND NOT EXISTS (SELECT 1 FROM qr_shares s
                              WHERE s.lead_id = l.id AND s.matched_at IS NOT NULL
                                AND s.id IS DISTINCT FROM $3::uuid
                                AND s.matched_payment_id IS DISTINCT FROM
                                    (SELECT payment_id FROM qr_payments WHERE id = $2::uuid))
             AND NOT EXISTS (SELECT 1 FROM caller_credits c
                              WHERE c.lead_id = l.id AND c.status = 'active'
                                AND (c.qr_payment_id IS NOT NULL OR c.donation_id IS NOT NULL
                                     OR c.kind IN ('qr', 'offline', 'link')))
            ) AS word_only,
            (l.converted_at IS NOT NULL
             AND ABS(EXTRACT(EPOCH FROM (COALESCE($4::timestamptz, NOW()) - l.converted_at)))
                 <= $5::int * 86400) AS near,
            (SELECT json_build_object('id', c.id, 'user_id', c.user_id, 'amount', c.amount)
               FROM caller_credits c
              WHERE c.lead_id = l.id AND c.status = 'active' AND c.kind = 'lead'
                AND c.qr_payment_id IS NULL AND c.donation_id IS NULL
              ORDER BY c.created_at DESC LIMIT 1) AS word_credit
       FROM leads l WHERE l.id = $1`,
    [leadId, except.qrPaymentId ?? null, except.shareId ?? null, at, SAME_GIFT_DAYS]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    converted: r.converted,
    wordOnly: r.word_only,
    sameGift: !!(r.word_only && r.near),
    near: !!r.near,
    saidAmount: r.converted_amount === null ? null : Number(r.converted_amount),
    wordCredit: r.word_credit ?? null,
  };
}

/** True when some active credit already carries this lead (the per-lead index would refuse another). */
export async function leadHasCredit(db: Db, leadId: string): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM caller_credits WHERE lead_id = $1 AND status = 'active' LIMIT 1`,
    [leadId]
  );
  return r.rows.length > 0;
}

/** Bring back a word credit that a payment replaced, when that payment is unlinked or removed. */
export async function restoreWordCredit(db: Db, creditId: string | null | undefined): Promise<boolean> {
  if (!creditId) return false;
  const r = await db.query(
    `UPDATE caller_credits c
        SET status = 'active', reversed_at = NULL, reversed_by = NULL, reversed_reason = NULL
      WHERE c.id = $1 AND c.status = 'reversed'
        AND NOT EXISTS (SELECT 1 FROM caller_credits o
                         WHERE o.status = 'active' AND o.lead_id = c.lead_id AND o.id <> c.id)`,
    [creditId]
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * The lead a payment from this donor most likely belongs to: one still being
 * chased, or one converted on somebody's word recently enough to be this gift.
 * A lead converted long ago with real money behind it is history, and a new
 * payment from that donor is not news to it.
 */
export async function leadForPayer(
  db: Db,
  who: { personId?: string | null; phone?: string | null },
  at?: string | Date | null
): Promise<string | null> {
  const phone = String(who.phone ?? '').replace(/\D/g, '').slice(-10);
  if (!who.personId && phone.length !== 10) return null;
  const { rows } = await db.query(
    `SELECT l.id, l.converted_at IS NOT NULL AS converted
       FROM leads l
       LEFT JOIN crm_statuses s ON s.slug = l.status
      WHERE (l.person_id = $1::uuid OR ($2::text <> '' AND (l.phone = $2 OR l.alt_phone = $2)))
        AND ((l.converted_at IS NULL AND COALESCE(s.is_open, TRUE))
             OR l.converted_at > NOW() - ($3::int * INTERVAL '1 day'))
      ORDER BY (l.converted_at IS NOT NULL) DESC, l.updated_at DESC NULLS LAST
      LIMIT 5`,
    [who.personId ?? null, phone.length === 10 ? phone : '', SAME_GIFT_DAYS]
  );
  for (const r of rows) {
    if (!r.converted) return r.id;
    const st = await leadMoneyState(db, r.id, { at });
    if (st?.sameGift) return r.id;
  }
  return null;
}

/** A lead's state before a payment changes it, for undo. */
export async function leadBefore(db: Db, leadId: string) {
  const b = await db.query(
    `SELECT status, converted_at, converted_amount, converted_via, converted_note, converted_donation_id,
            conversion_seen_at, next_follow_up_at, follow_up_note, awaiting_qr_at, alt_phone,
            assigned_to, assigned_at
       FROM leads WHERE id = $1 FOR UPDATE`,
    [leadId]
  );
  const open = await db.query(`SELECT id FROM lead_reminders WHERE lead_id = $1 AND status = 'open'`, [leadId]);
  return { lead_id: leadId, before: b.rows[0] ?? null, open_reminders: open.rows.map((r) => r.id as string) };
}

export interface LeadUndo {
  lead_id: string;
  before: Record<string, any> | null;
  open_reminders: string[];
  set_alt_phone?: boolean;
  /** The word credit this payment replaced, brought back on undo. */
  restored_credit?: string | null;
}

/** Put a lead back as it was before a payment landed on it. Returns whether it was put back. */
export async function restoreLead(db: Db, undo: LeadUndo, by: string | null, why: string): Promise<boolean> {
  if (!undo?.before) return false;
  const bf = undo.before;
  const r = await db.query(
    `UPDATE leads SET status = $2, converted_at = $3::timestamptz, converted_amount = $4::numeric,
            converted_via = $5, converted_note = $6, converted_donation_id = $7::uuid,
            conversion_seen_at = $8::timestamptz, next_follow_up_at = $9::timestamptz,
            follow_up_note = $10, awaiting_qr_at = $11::timestamptz, assigned_to = $12::uuid,
            assigned_at = $13::timestamptz,
            alt_phone = CASE WHEN $14::boolean THEN $15 ELSE alt_phone END,
            updated_at = NOW()
      WHERE id = $1 AND status = 'converted'`,
    [
      undo.lead_id, bf.status, bf.converted_at, bf.converted_amount, bf.converted_via, bf.converted_note,
      bf.converted_donation_id, bf.conversion_seen_at, bf.next_follow_up_at, bf.follow_up_note,
      bf.awaiting_qr_at, bf.assigned_to, bf.assigned_at, !!undo.set_alt_phone, bf.alt_phone ?? null,
    ]
  );
  const restored = (r.rowCount ?? 0) > 0;
  if (!restored) return false;
  if (undo.open_reminders?.length) {
    await db.query(
      `UPDATE lead_reminders SET status = 'open', completed_at = NULL, updated_at = NOW()
        WHERE id = ANY($1::uuid[]) AND status = 'done'`,
      [undo.open_reminders]
    );
  }
  await restoreWordCredit(db, undo.restored_credit);
  await db.query(
    `INSERT INTO lead_activities (lead_id, user_id, kind, from_value, to_value, note)
     VALUES ($1::uuid, $2::uuid, 'status_change', 'converted', $3, $4)`,
    [undo.lead_id, by || null, bf.status, why]
  );
  return true;
}

export const rupees = (n: number | null | undefined) =>
  n === null || n === undefined ? '' : `₹${Number(n).toLocaleString('en-IN')}`;

