// A devotee's own leads: the rules for what a lead holds and what logging a follow-up does to it.
//
// Kept apart from the router so the rules read in one place and the tests can exercise them
// without HTTP. Everything here is scoped by owner_id - the devotee's user id - and nothing reads
// or writes DRM's people, donations or leads. See the note on devotee_leads in db/schema.sql.

import type { PoolClient } from 'pg';
import { istDate } from '../bootTimezone';

export const STATUSES = ['new', 'interested', 'call_later', 'not_answered', 'invalid_number', 'not_interested', 'donated'] as const;
export type LeadStatus = (typeof STATUSES)[number];

/** Each status in words, for the phone's caller-ID notification. */
export const STATUS_LABEL: Record<LeadStatus, string> = {
  new: 'New lead',
  interested: 'Interested',
  call_later: 'Asked to call later',
  not_answered: 'Did not answer last time',
  invalid_number: 'Invalid number',
  not_interested: 'Not interested',
  donated: 'Donated',
};

/** What a follow-up can end in. Every one of these is also the status the lead moves to. */
export const OUTCOMES = ['interested', 'call_later', 'not_answered', 'invalid_number', 'not_interested', 'donated'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Outcomes after which there is nobody to ring again: any pending follow-up is dropped. */
export const CLOSED_OUTCOMES: readonly Outcome[] = ['invalid_number', 'not_interested'];
/** Outcomes where the person picked up: the run of unanswered calls starts again from zero. */
const ANSWERED_OUTCOMES: readonly Outcome[] = ['interested', 'call_later', 'not_interested', 'donated'];

export const CHANNELS = ['call', 'whatsapp', 'visit', 'other'] as const;
export const PRIORITIES = ['hot', 'warm', 'cold'] as const;
export const INTERESTS = [
  'annadanam', 'temple_construction', 'gau_seva', 'festival_seva', 'nitya_seva', 'general', 'volunteering', 'other',
] as const;
export const SOURCES = ['personal', 'temple_visit', 'event', 'book_distribution', 'referral', 'social_media', 'other'] as const;
export const PAYMENT_MODES = ['cash', 'upi', 'bank_transfer', 'cheque', 'card', 'online', 'other'] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const phone10 = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(-10);

type Fields = Record<string, unknown>;
type Parsed = { fields: Fields; error?: undefined } | { fields?: undefined; error: string };

/** Free-text columns and their widths. Empty clears the column. */
const TEXT: Record<string, number> = {
  name: 160,
  email: 160,
  occupation: 120,
  organisation: 160,
  referred_by: 160,
  address_line: 500,
  area: 160,
  city: 120,
  landmark: 160,
  notes: 4000,
};
/** Columns limited to a fixed list. Empty clears the column (except priority, which has a default). */
const CHOICES: Record<string, readonly string[]> = {
  interest: INTERESTS,
  source: SOURCES,
  priority: PRIORITIES,
};

const has = (b: Fields, k: string) => Object.prototype.hasOwnProperty.call(b, k);
const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === '';

/** A YYYY-MM-DD date, or null for blank. Undefined means "not a date". */
function dateOnly(v: unknown): string | null | undefined {
  if (blank(v)) return null;
  const s = String(v).trim();
  if (!DATE_RE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) return undefined;
  return s;
}

/** An instant, or null for blank. Undefined means "not a date and time". */
function instant(v: unknown): Date | null | undefined {
  if (blank(v)) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Check and tidy a lead from the form.
 *
 * On create, name and phone are required and everything else is optional. On update, only the
 * keys that were sent are touched, so the form can save one field without resending the rest;
 * name and phone may be changed but never cleared.
 */
export function parseLead(body: unknown, mode: 'create' | 'update'): Parsed {
  const b = (body && typeof body === 'object' ? body : {}) as Fields;
  const out: Fields = {};
  const wants = (k: string) => mode === 'create' || has(b, k);

  if (wants('name')) {
    const name = String(b.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name) return { error: 'Enter the name.' };
    out.name = name.slice(0, TEXT.name);
  }
  if (wants('phone')) {
    const p = phone10(b.phone);
    if (p.length !== 10 || !/^[6-9]/.test(p)) return { error: 'Enter a valid 10-digit mobile number.' };
    out.phone = p;
  }
  if (has(b, 'alt_phone')) {
    const p = String(b.alt_phone ?? '').replace(/\D/g, '');
    if (p && (p.length < 10 || p.length > 15)) return { error: 'The other number should be 10 to 15 digits.' };
    out.alt_phone = p || null;
  }
  for (const [k, max] of Object.entries(TEXT)) {
    if (k === 'name' || !has(b, k)) continue;
    const v = String(b[k] ?? '').trim();
    out[k] = v ? v.slice(0, max) : null;
  }
  if (typeof out.email === 'string' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) {
    return { error: 'That email address does not look right.' };
  }
  for (const [k, list] of Object.entries(CHOICES)) {
    if (!has(b, k)) continue;
    const v = String(b[k] ?? '').trim();
    if (!v) {
      if (k === 'priority') continue;
      out[k] = null;
    } else if (!list.includes(v)) {
      return { error: `Choose a ${k} from the list.` };
    } else {
      out[k] = v;
    }
  }
  if (has(b, 'pincode')) {
    const v = String(b.pincode ?? '').replace(/\D/g, '');
    if (v && v.length !== 6) return { error: 'The PIN code should be 6 digits.' };
    out.pincode = v || null;
  }
  if (has(b, 'expected_amount')) {
    if (blank(b.expected_amount)) out.expected_amount = null;
    else {
      const n = Number(b.expected_amount);
      if (!Number.isFinite(n) || n < 0 || n > 1e9) return { error: 'Enter the expected amount in rupees.' };
      out.expected_amount = Math.round(n * 100) / 100;
    }
  }
  for (const k of ['date_of_birth', 'anniversary_date']) {
    if (!has(b, k)) continue;
    const d = dateOnly(b[k]);
    if (d === undefined) return { error: `Enter the ${k === 'date_of_birth' ? 'birthday' : 'anniversary'} as a date.` };
    if (d && d > istDate()) return { error: `The ${k === 'date_of_birth' ? 'birthday' : 'anniversary'} cannot be in the future.` };
    out[k] = d;
  }
  // The map pin: both halves or neither.
  if (has(b, 'latitude') || has(b, 'longitude')) {
    if (blank(b.latitude) && blank(b.longitude)) {
      out.latitude = null;
      out.longitude = null;
    } else {
      const lat = Number(b.latitude);
      const lng = Number(b.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return { error: 'The map location is not valid. Pick it again.' };
      }
      out.latitude = lat;
      out.longitude = lng;
    }
  }
  if (has(b, 'next_follow_up_at')) {
    const at = instant(b.next_follow_up_at);
    if (at === undefined) return { error: 'Enter the follow-up date and time.' };
    out.next_follow_up_at = at;
  }
  return { fields: out };
}

export interface ActivityInput {
  outcome: Outcome | null;
  channel: (typeof CHANNELS)[number] | null;
  note: string | null;
  /** Undefined: leave the lead's follow-up as it is (a plain note). Null: no follow-up. */
  next_follow_up_at: Date | null | undefined;
  donation: { amount: number; donated_on: string; payment_mode: string | null; purpose: string | null; reference: string | null } | null;
}

/** Check a follow-up being logged. */
export function parseActivity(body: unknown, now = new Date()): { input: ActivityInput; error?: undefined } | { input?: undefined; error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Fields;
  const outcome = blank(b.outcome) ? null : String(b.outcome);
  if (outcome !== null && !(OUTCOMES as readonly string[]).includes(outcome)) return { error: 'Choose what happened.' };
  const channel = blank(b.channel) ? null : String(b.channel);
  if (channel !== null && !(CHANNELS as readonly string[]).includes(channel)) return { error: 'Choose how you reached them.' };
  const note = blank(b.note) ? null : String(b.note).trim().slice(0, 4000);
  if (!outcome && !note) return { error: 'Choose what happened, or write a note.' };

  let next: Date | null | undefined;
  if (has(b, 'next_follow_up_at')) {
    next = instant(b.next_follow_up_at);
    if (next === undefined) return { error: 'Enter the follow-up date and time.' };
  } else {
    // An outcome finishes the follow-up that was due; a note leaves it where it was.
    next = outcome ? null : undefined;
  }
  if (outcome && CLOSED_OUTCOMES.includes(outcome as Outcome)) next = null;
  if (outcome === 'call_later' && !next) return { error: 'Pick when to call them back.' };
  // A minute's grace, for a time picked "now" a moment before pressing Save.
  if (next && next.getTime() < now.getTime() - 60_000 && outcome) {
    return { error: 'The next follow-up should be in the future.' };
  }

  let donation: ActivityInput['donation'] = null;
  if (outcome === 'donated') {
    const d = (b.donation && typeof b.donation === 'object' ? b.donation : {}) as Fields;
    const amount = Number(d.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) return { error: 'Enter the amount donated.' };
    const on = dateOnly(d.donated_on);
    if (on === undefined) return { error: 'Enter the donation date.' };
    const today = istDate(now);
    if (on && on > today) return { error: 'The donation date cannot be in the future.' };
    const mode = blank(d.payment_mode) ? null : String(d.payment_mode);
    if (mode !== null && !(PAYMENT_MODES as readonly string[]).includes(mode)) return { error: 'Choose how they paid.' };
    donation = {
      amount: Math.round(amount * 100) / 100,
      donated_on: on ?? today,
      payment_mode: mode,
      purpose: blank(d.purpose) ? null : String(d.purpose).trim().slice(0, 120),
      reference: blank(d.reference) ? null : String(d.reference).trim().slice(0, 80),
    };
  }

  return {
    input: {
      outcome: outcome as Outcome | null,
      channel: channel as ActivityInput['channel'],
      note,
      next_follow_up_at: next,
      donation,
    },
  };
}

/**
 * Log a follow-up and move the lead along, in the caller's transaction.
 *
 * The lead row is locked first so two saves from two tabs cannot both add to the unanswered count
 * or the donated total from the same starting value. Returns null if the lead is not this owner's.
 */
export async function logActivity(client: PoolClient, ownerId: string, leadId: string, a: ActivityInput) {
  const lead = (
    await client.query(`SELECT id FROM devotee_leads WHERE id = $1 AND owner_id = $2 FOR UPDATE`, [leadId, ownerId])
  ).rows[0];
  if (!lead) return null;

  const activity = (
    await client.query(
      `INSERT INTO devotee_lead_activities
         (lead_id, owner_id, channel, outcome, note, next_follow_up_at, amount, donated_on, payment_mode, purpose, reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        leadId, ownerId, a.channel, a.outcome, a.note, a.next_follow_up_at ?? null,
        a.donation?.amount ?? null, a.donation?.donated_on ?? null, a.donation?.payment_mode ?? null,
        a.donation?.purpose ?? null, a.donation?.reference ?? null,
      ]
    )
  ).rows[0];

  const sets: string[] = ['updated_at = NOW()'];
  const vals: unknown[] = [leadId];
  const param = (v: unknown) => {
    vals.push(v);
    return `$${vals.length}`;
  };
  if (a.outcome) {
    sets.push(`status = ${param(a.outcome)}`, 'last_contacted_at = NOW()');
    if (a.outcome === 'not_answered') sets.push('unanswered_count = unanswered_count + 1');
    else if (ANSWERED_OUTCOMES.includes(a.outcome)) sets.push('unanswered_count = 0');
  }
  if (a.next_follow_up_at !== undefined) {
    // A new time is a new reminder: the one already sent was for the old time.
    sets.push(`next_follow_up_at = ${param(a.next_follow_up_at)}`, 'reminder_sent_at = NULL');
  }
  if (a.donation) {
    sets.push(
      `total_donated = total_donated + ${param(a.donation.amount)}`,
      `last_donated_on = GREATEST(last_donated_on, ${param(a.donation.donated_on)}::date)`
    );
  }
  const updated = (await client.query(`UPDATE devotee_leads SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals)).rows[0];
  return { lead: updated, activity };
}
