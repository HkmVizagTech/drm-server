// Who raised what.
//
// EVERY PATH THAT ATTRIBUTES MONEY TO A CALLER GOES THROUGH THIS FILE, and
// every figure that reports it reads from here. That is the whole point.
//
// Before this existed, three screens answered "how much has Ana raised" from
// three different tables and gave three different numbers - all of them
// defensible, none of them the same. And because the dashboard's answer was a
// live join on leads.assigned_to, reassigning a lead rewrote months of
// history for two people with nothing recording that it had happened.
//
// So attribution is now an event: written once, at the moment it is decided,
// with the evidence that earned it. See the long header above caller_credits
// in schema.sql for why rows are reversed rather than deleted, and why the
// amount is copied rather than joined.
//
// THE ONE RULE FOR ANYONE ADDING A CHANNEL
// If you are about to write `SUM(something) GROUP BY some_user_column` in a
// report, stop - that is the mistake this file exists to prevent. Write a
// credit when the money is attributed, and let the report read credits.

import type { PoolClient } from 'pg';
import pool from '../db/pool';

export type CreditKind = 'qr' | 'link' | 'lead' | 'offline' | 'manual';

export interface CreditInput {
  userId: string;
  amount: number | string;
  kind: CreditKind;
  /** When the money landed - NOT when this row is written. See below. */
  occurredAt: Date | string;
  qrPaymentId?: string | null;
  donationId?: string | null;
  leadId?: string | null;
  shareId?: string | null;
  linkId?: string | null;
  personId?: string | null;
  note?: string | null;
  createdBy?: string | null;
  /**
   * Money the system watched arrive is verified by construction; money a
   * person says arrived is not, until somebody reconciles it. Only the
   * offline path leaves this false.
   */
  verified?: boolean;
}

export interface Credit {
  id: string;
  user_id: string;
  amount: string;
  kind: CreditKind;
  occurred_at: string;
  note: string | null;
  verified_at: string | null;
  status: string;
}

/**
 * Record a credit.
 *
 * Returns the row, or null when one already exists for that evidence - which
 * is a normal outcome, not an error. Two people can press "claim" on the same
 * payment within the same second; the partial unique indexes decide, and the
 * loser is told the money is already attributed rather than shown a failure.
 *
 * ON CONFLICT DO NOTHING rather than a SELECT-then-INSERT: the check-then-act
 * form loses that race by construction, and the symptom - the same ₹5,000
 * counted under two callers - is the exact thing this table exists to stop.
 *
 * Takes an optional client so a caller already inside a transaction (claiming
 * a payment, say, which also updates qr_shares and qr_payments) commits the
 * credit atomically with the rest of it.
 */
export async function recordCredit(
  input: CreditInput,
  client?: PoolClient
): Promise<Credit | null> {
  const q = client ?? pool;
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`Refusing to credit a non-amount: ${input.amount}`);
  }

  const { rows } = await q.query<Credit>(
    `INSERT INTO caller_credits
       (user_id, amount, kind, occurred_at, qr_payment_id, donation_id, lead_id,
        share_id, link_id, person_id, note, created_by, verified_at, verified_by)
     -- EVERY PARAMETER IS CAST EXPLICITLY, and $12 is why.
     -- It is used twice: once as created_by, and once inside a CASE for
     -- verified_by. Postgres tried to deduce one type from both positions and
     -- refused with "inconsistent types deduced for parameter $12" - which,
     -- because this INSERT often runs inside somebody else's transaction,
     -- aborted that whole transaction and silently rolled back the conversion
     -- it was supposed to be recording.
     VALUES ($1::uuid, $2::numeric, $3::varchar, $4::timestamptz,
             $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9::uuid, $10::uuid,
             $11::text, $12::uuid,
             CASE WHEN $13::boolean THEN NOW() ELSE NULL END,
             CASE WHEN $13::boolean THEN $12::uuid ELSE NULL END)
     ON CONFLICT DO NOTHING
     RETURNING id, user_id, amount, kind, occurred_at, note, verified_at, status`,
    [
      input.userId,
      amount,
      input.kind,
      input.occurredAt instanceof Date ? input.occurredAt.toISOString() : input.occurredAt,
      input.qrPaymentId ?? null,
      input.donationId ?? null,
      input.leadId ?? null,
      input.shareId ?? null,
      input.linkId ?? null,
      input.personId ?? null,
      input.note ?? null,
      input.createdBy ?? input.userId,
      input.verified ?? input.kind !== 'offline',
    ]
  );
  return rows[0] ?? null;
}

/**
 * Withdraw a credit without erasing it.
 *
 * A credit is a claim about money, and deleting one leaves no trace that
 * anybody ever made the claim - which is precisely the record you want when
 * two people disagree about a figure. The row stays, the totals stop counting
 * it, and the reason is on it.
 *
 * Reversing also frees the evidence: the unique indexes only cover active
 * rows, so a payment credited to the wrong caller can be reversed and then
 * claimed by the right one.
 */
export async function reverseCredit(
  id: string,
  by: string,
  reason: string,
  client?: PoolClient
): Promise<boolean> {
  const q = client ?? pool;
  const { rowCount } = await q.query(
    `UPDATE caller_credits
        SET status = 'reversed', reversed_at = NOW(), reversed_by = $2, reversed_reason = $3
      WHERE id = $1 AND status = 'active'`,
    [id, by, reason]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Reverse whatever credit a piece of evidence carries.
 *
 * Used when the thing underneath changes its mind - a QR payment re-matched
 * to a different share, a lead's conversion undone. Named by evidence rather
 * than by id because the caller of this usually knows the payment, not the
 * credit.
 */
export async function reverseCreditFor(
  evidence: { qrPaymentId?: string; donationId?: string; leadId?: string },
  by: string,
  reason: string,
  client?: PoolClient
): Promise<number> {
  const q = client ?? pool;
  const column = evidence.qrPaymentId
    ? 'qr_payment_id'
    : evidence.donationId
    ? 'donation_id'
    : evidence.leadId
    ? 'lead_id'
    : null;
  if (!column) return 0;
  const value = evidence.qrPaymentId ?? evidence.donationId ?? evidence.leadId;
  const { rowCount } = await q.query(
    `UPDATE caller_credits
        SET status = 'reversed', reversed_at = NOW(), reversed_by = $2, reversed_reason = $3
      WHERE ${column} = $1 AND status = 'active'`,
    [value, by, reason]
  );
  return rowCount ?? 0;
}

/** Confirm offline money against the statement. */
export async function verifyCredit(id: string, by: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE caller_credits SET verified_at = NOW(), verified_by = $2
      WHERE id = $1 AND status = 'active' AND verified_at IS NULL`,
    [id, by]
  );
  return (rowCount ?? 0) > 0;
}

/* ------------------------------------------------------------- reading it */

/**
 * The SQL fragment every report uses for a window of credits.
 *
 * One definition, so the dashboard tile, the caller leaderboard and a
 * caller's own list cannot drift apart - which is the condition this whole
 * table was built to end. $a and $b are inclusive date bounds, resolved on
 * the Indian calendar because the database session runs on IST.
 */
export const CREDIT_WINDOW = (a: number, b: number) =>
  `c.status = 'active' AND c.occurred_at >= $${a}::date AND c.occurred_at < ($${b}::date + INTERVAL '1 day')`;

export interface CreditTotals {
  raised: number;
  credits: number;
  /** Money the system watched arrive, as opposed to money somebody reported. */
  verified: number;
  awaiting_verification: number;
  by_kind: Record<CreditKind, number>;
}

/** What one caller raised in a window, or the whole team when userId is null. */
export async function totalsFor(
  userId: string | null,
  from: string,
  to: string
): Promise<CreditTotals> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(c.amount), 0)::numeric            AS raised,
            COUNT(*)::int                                   AS credits,
            COALESCE(SUM(c.amount) FILTER (WHERE c.verified_at IS NOT NULL), 0)::numeric
                                                            AS verified,
            COALESCE(SUM(c.amount) FILTER (WHERE c.verified_at IS NULL), 0)::numeric
                                                            AS awaiting_verification,
            COALESCE(SUM(c.amount) FILTER (WHERE c.kind = 'qr'), 0)::numeric      AS qr,
            COALESCE(SUM(c.amount) FILTER (WHERE c.kind = 'link'), 0)::numeric    AS link,
            COALESCE(SUM(c.amount) FILTER (WHERE c.kind = 'lead'), 0)::numeric    AS lead,
            COALESCE(SUM(c.amount) FILTER (WHERE c.kind = 'offline'), 0)::numeric AS offline,
            COALESCE(SUM(c.amount) FILTER (WHERE c.kind = 'manual'), 0)::numeric  AS manual
       FROM caller_credits c
      WHERE ${CREDIT_WINDOW(2, 3)}
        AND ($1::uuid IS NULL OR c.user_id = $1)`,
    [userId, from, to]
  );
  const r = rows[0];
  return {
    raised: Number(r.raised),
    credits: r.credits,
    verified: Number(r.verified),
    awaiting_verification: Number(r.awaiting_verification),
    by_kind: {
      qr: Number(r.qr),
      link: Number(r.link),
      lead: Number(r.lead),
      offline: Number(r.offline),
      manual: Number(r.manual),
    },
  };
}
