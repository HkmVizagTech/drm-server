// Calling: the dashboard and the reports.
//
// WHAT EVERY NUMBER ON THIS SCREEN MEANS - and the reason this comment exists.
//
// A calling dashboard is read by the person whose work it measures, so a number
// that quietly means something other than what its label says is worse than no
// number. Each tile below therefore states its definition, and the definitions
// were chosen to be the unflattering ones:
//
//   Leads received      leads CREATED in the period, whatever has happened to
//                       them since. Not "leads worked".
//   Calls made          call rows LOGGED in the period. A call nobody logs
//                       does not exist here, and the reports say so rather
//                       than inferring activity from status changes.
//   Connected           calls whose outcome is one the temple has marked as
//                       counting as connected (crm_dispositions). Self-
//                       reported - see the note on `source` below.
//   Conversions         leads whose linked person actually gave AFTER the lead
//                       was created, matched to the donation. Not a caller
//                       ticking "donated"; money that arrived.
//   Amount raised       the sum of this caller's CREDITS in the period - one
//                       immutable row per amount attributed to them, written
//                       when the attribution was decided. Not a live sum over
//                       whoever a lead happens to be assigned to today, which
//                       is what it used to be and which meant reassigning a
//                       lead rewrote two people's past months. Never the
//                       pipeline.
//   Verified / awaiting money the system watched arrive, versus money a caller
//                       reported collecting offline and nobody has yet checked
//                       against the statement. Both are counted; the screen
//                       says which is which, because "awaiting" means not
//                       checked yet, not wrong.
//   Pipeline            expected_amount on open leads. A hope, labelled as one,
//                       and never added to amount raised.
//   Overdue             a follow-up date in the past. Yesterday's promise.
//
// THE HONESTY FLAG
// Calls are logged by hand here (nobody is running a telephony switch), so
// duration and connected/unanswered are what a caller reported, not what a
// system measured. Every calls figure comes back with `measured` alongside it -
// how many of those rows came from a provider rather than a person. Today that
// is zero, and the UI says "self-reported" because of it. The day a provider is
// wired in, the same figure starts rising and the caveat retires itself.

import { Router } from 'express';
import pool from '../db/pool';
import { authenticate, authorize } from '../middleware/auth';
import { reconcileConversions } from './crm';
import { istDate, APP_TIMEZONE } from '../bootTimezone';
import {
  describeFilters,
  sendExport,
  EXPORT_ROW_CAP,
  type ExportFormat,
} from '../utils/export';
// Every "raised" figure below reads caller_credits through this one window
// fragment. Three screens here used to each sum a different table - leads,
// qr_shares, qr_payments - and gave three different answers to one question.
// See the header of services/credits.ts and of caller_credits in schema.sql.
import { CREDIT_WINDOW, totalsFor } from '../services/credits';

const router = Router();
router.use(authenticate);

// Date window shared by every endpoint here. Defaults to the last 30 days
// because that is the span a temple's calling campaign actually runs over, and
// an unbounded default would scan the whole activity table on every page load.
//
// EVERY DATE HERE IS AN INDIAN CALENDAR DATE.
//
// This used to be `new Date().toISOString().slice(0, 10)`, which is the UTC
// date however the process is configured. Between midnight and 05:30 IST that
// is yesterday - so "Today" on the reports screen showed yesterday's calls for
// the first five and a half hours of every day, and "This month" started on
// the wrong day for the same window on the 1st.
//
// istDate() formats in Asia/Kolkata explicitly, so this is right regardless of
// what zone the process happens to be running in.
function range(q: Record<string, unknown>): { from: string; to: string; label: string } {
  const preset = String(q.preset ?? '');
  const today = istDate();

  if (q.start_date || q.end_date) {
    return {
      from: String(q.start_date ?? '1970-01-01'),
      to: String(q.end_date ?? today),
      label: 'Custom',
    };
  }

  // Day arithmetic done on the IST calendar date rather than by subtracting
  // milliseconds from "now": a 24-hour step from an instant lands at an
  // arbitrary clock time, and across a month boundary that is a different day
  // than the one a person counting back on a calendar would name.
  const back = (n: number) => shiftDays(today, -n);
  const [year, month] = today.split('-');
  switch (preset) {
    case 'today': return { from: today, to: today, label: 'Today' };
    case 'yesterday': return { from: back(1), to: back(1), label: 'Yesterday' };
    case 'week': return { from: back(6), to: today, label: 'Last 7 days' };
    case 'month': return { from: `${year}-${month}-01`, to: today, label: 'This month' };
    case 'quarter': return { from: back(89), to: today, label: 'Last 90 days' };
    case 'year': return { from: `${year}-01-01`, to: today, label: 'This year' };
    case 'all': return { from: '1970-01-01', to: today, label: 'All time' };
    default: return { from: back(29), to: today, label: 'Last 30 days' };
  }
}

/** Calendar arithmetic on a YYYY-MM-DD string, with no timezone in play. */
function shiftDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

// Inclusive of the end date. Written once because getting this wrong by a day
// in one query and not another is how two tiles on the same screen disagree.
const WINDOW = (col: string, a: number, b: number) => `${col} >= $${a}::date AND ${col} < ($${b}::date + INTERVAL '1 day')`;

/* --------------------------------------------------------------- dashboard */

/**
 * WHOSE NUMBERS THESE ARE
 *
 * This endpoint used to answer the same thing to everybody, and the only
 * protection was that the nav link was hidden from callers - so a caller who
 * typed the URL saw the whole team's figures and today's leaderboard. That is
 * not a security boundary, it is a decoration.
 *
 * Now the scope comes from the role, server-side: an admin sees the temple,
 * and a caller sees their own work and nothing else. Every query below takes
 * the same `me` parameter and narrows on it - leads assigned to them, calls
 * they logged, follow-ups they owe - so there is no query left that could
 * leak the team's totals through a tile nobody remembered to scope. The
 * leaderboard is not narrowed; it is simply not sent.
 *
 * A caller's page is not a lesser copy of the admin's. It is the same figures
 * about a smaller thing, which is what makes it worth reading on a shift.
 */
function scopeOf(req: { user?: { role?: string; userId?: string } }): string | null {
  return req.user?.role === 'caller' ? req.user?.userId ?? null : null;
}

router.get('/dashboard', async (req, res) => {
  const { from, to, label } = range(req.query as Record<string, unknown>);
  // NULL means "no narrowing" - every predicate below is written to pass
  // everything when it is NULL, so one parameter serves both audiences.
  const me = scopeOf(req);

  try {
    // Link any donations that have landed since a lead was created, so the
    // conversion figures below are current rather than a day behind.
    await reconcileConversions();

    const [leads, conv, credits, calls, pipeline, followUps, byStatus, bySource, callers, qr, byQr] = await Promise.all([
      pool.query(
        // WHAT COUNTS AS A CONVERSION, AND WHY THIS CHANGED
        //
        // This used to count only leads carrying converted_donation_id - a
        // link to a donation row synced from one of the sites. Everything else
        // read as zero. So a QR payment Razorpay had confirmed showed nothing,
        // and cash a caller recorded at the counter showed nothing, and the
        // screen told a caller who had raised real money that they had raised
        // none. The user who reported this had watched their own test donation
        // arrive, be matched, and be receipted - and still show as zero.
        //
        // A conversion is now any lead that converted. What differs between
        // them is not whether they happened but how well DRM can evidence
        // them, so that is reported alongside rather than by silently
        // discarding two thirds of the money: 'auto' is a donation the site
        // receipted and DRM matched, 'manual' is a QR payment or a caller's
        // word. Both are real; only one is independently verifiable, and the
        // screen says which is which.
        // The COHORT: leads created in this window, and how many of them have
        // since given. This is the question "how well did the list we started
        // in March do", and it must stay keyed on when the lead arrived.
        `SELECT COUNT(*)::int AS received,
                COUNT(*) FILTER (WHERE converted_at IS NOT NULL)::int AS converted
           FROM leads
          WHERE ${WINDOW('created_at', 1, 2)}
            AND ($3::uuid IS NULL OR assigned_to = $3::uuid)`,
        [from, to, me]
      ),
      pool.query(
        // THE CONVERSION COUNTS, on the day the money actually arrived.
        //
        // This used to be part of the cohort query above, which meant "Raised"
        // answered a question nobody asks: the money given by people who were
        // ADDED in this window. A caller working a sheet uploaded in March
        // took a QR payment today and saw today's raised figure read zero -
        // and so did the admin looking at the same screen. The donation was
        // recorded correctly all along; the tile was measuring the wrong date.
        //
        // COUNTS ONLY NOW. The rupee figures that used to live in this query
        // moved to caller_credits below. They stayed here as long as they did
        // because leads.converted_amount was the only record of them; it is
        // not any more, and a sum grouped by leads.assigned_to is a statement
        // about who owns the lead today rather than about who raised the money.
        // The counts are a different question - how many leads converted in
        // this window - and that question is still correctly asked of leads.
        `SELECT COUNT(*)::int AS converted,
                COUNT(*) FILTER (WHERE converted_donation_id IS NULL)::int AS converted_unreceipted
           FROM leads
          WHERE converted_at IS NOT NULL
            AND ${WINDOW('converted_at', 1, 2)}
            AND ($3::uuid IS NULL OR assigned_to = $3::uuid)`,
        [from, to, me]
      ),
      // THE MONEY. Every rupee on this screen - the headline, the QR tile and
      // the per-kind breakdown - comes out of this one call, rather than from
      // three queries that could disagree with each other by a day or a join.
      //
      // totalsFor() rather than a query written here, because the aggregate
      // itself is part of what has to stay identical between screens: the
      // verified/awaiting split and the per-kind split are decisions about
      // what the words mean, and a second copy of them here is how the next
      // divergence starts. The service owns them; this file asks for them.
      //
      // Broken down by kind because "you raised ₹40,000" is not actionable and
      // "₹31,000 of it came through your QR, ₹9,000 was cash you banked" is.
      // The old model could not express this at all: it had one column on
      // leads and no record of where the money had come from.
      totalsFor(me, from, to),
      pool.query(
        `SELECT COUNT(*)::int AS made,
                COUNT(*) FILTER (WHERE connected)::int AS connected,
                COUNT(DISTINCT lead_id)::int AS leads_touched,
                -- How many of these came from a telephony provider rather than
                -- a person typing them in. Drives the "self-reported" caveat.
                COUNT(*) FILTER (WHERE source <> 'manual')::int AS measured,
                COALESCE(SUM(duration_seconds), 0)::int AS total_seconds,
                COUNT(*) FILTER (WHERE duration_seconds IS NOT NULL)::int AS with_duration
           FROM lead_activities
          WHERE kind = 'call' AND ${WINDOW('occurred_at', 1, 2)}
            AND ($3::uuid IS NULL OR user_id = $3::uuid)`,
        [from, to, me]
      ),
      pool.query(
        `SELECT COALESCE(SUM(l.expected_amount), 0)::numeric AS pipeline,
                COUNT(*)::int AS open_leads
           FROM leads l LEFT JOIN crm_statuses s ON l.status = s.slug
          WHERE COALESCE(s.is_open, TRUE) AND l.do_not_call = FALSE
            AND ($1::uuid IS NULL OR l.assigned_to = $1::uuid)`,
        [me]
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE next_follow_up_at < date_trunc('day', NOW()))::int AS overdue,
           COUNT(*) FILTER (WHERE next_follow_up_at >= date_trunc('day', NOW())
                              AND next_follow_up_at <  date_trunc('day', NOW()) + INTERVAL '1 day')::int AS today,
           COUNT(*) FILTER (WHERE next_follow_up_at >= date_trunc('day', NOW()) + INTERVAL '1 day'
                              AND next_follow_up_at <  date_trunc('day', NOW()) + INTERVAL '8 days')::int AS next_7_days,
           COUNT(*) FILTER (WHERE next_follow_up_at IS NULL)::int AS unscheduled
         FROM leads l LEFT JOIN crm_statuses s ON l.status = s.slug
        WHERE COALESCE(s.is_open, TRUE) AND l.do_not_call = FALSE
          AND ($1::uuid IS NULL OR l.assigned_to = $1::uuid)`,
        [me]
      ),
      pool.query(
        `SELECT l.status, COALESCE(s.label, l.status) AS label, COALESCE(s.tone,'slate') AS tone,
                COUNT(*)::int AS n, COALESCE(SUM(l.expected_amount),0)::numeric AS value
           FROM leads l LEFT JOIN crm_statuses s ON l.status = s.slug
          WHERE ($1::uuid IS NULL OR l.assigned_to = $1::uuid)
          GROUP BY l.status, s.label, s.tone, s.sort_order
          ORDER BY MIN(COALESCE(s.sort_order, 999))`,
        [me]
      ),
      pool.query(
        `SELECT source, COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE converted_at IS NOT NULL)::int AS converted
           FROM leads
          WHERE ${WINDOW('created_at', 1, 2)}
            AND ($3::uuid IS NULL OR assigned_to = $3::uuid)
          GROUP BY source ORDER BY n DESC`,
        [from, to, me]
      ),
      // Today's leaderboard - who has actually been on the phone. Not narrowed
      // to one caller, because a leaderboard of one is not a leaderboard: it is
      // withheld from callers entirely below.
      me
        ? Promise.resolve({ rows: [] })
        : pool.query(
            `SELECT u.id, u.name,
                    COUNT(*)::int AS calls,
                    COUNT(*) FILTER (WHERE a.connected)::int AS connected
               FROM lead_activities a JOIN users u ON a.user_id = u.id
              WHERE a.kind = 'call' AND a.occurred_at >= date_trunc('day', NOW())
              GROUP BY u.id, u.name ORDER BY calls DESC LIMIT 10`
          ),
      // QR codes shared and what came back. On a caller's own screen this is
      // the answer to "did that QR I sent this morning ever get paid", which
      // was previously only findable by scrolling the payments list.
      //
      // COUNTS ONLY. This query used to also report SUM(s.matched_amount) as
      // the QR tile's "raised", which is the second of the three rival
      // definitions this change exists to end: it summed a different column,
      // of a different table, over a different window (when the QR was SHARED,
      // not when the money arrived), and so disagreed with the headline figure
      // on the very same screen. The tile's rupee figure now comes from the
      // credits row above, like every other rupee here. These three counts are
      // genuinely about shares, so they stay keyed on when the share was sent.
      pool.query(
        `SELECT COUNT(*)::int AS shared,
                COUNT(*) FILTER (WHERE s.matched_at IS NOT NULL)::int AS paid,
                COUNT(*) FILTER (
                  WHERE s.matched_at IS NULL AND s.created_at > NOW() - INTERVAL '7 days'
                )::int AS awaiting
           FROM qr_shares s
          WHERE ${WINDOW('s.created_at', 1, 2)}
            AND ($3::uuid IS NULL OR s.shared_by = $3::uuid)`,
        [from, to, me]
      ),
      // MONEY THROUGH EACH QR, which is money raised by calling.
      //
      // These QRs are used for nothing but calls, so every payment that
      // arrives through one was raised on the phone - whether or not anybody
      // has yet worked out which call. That makes a per-QR total the truest
      // picture of what the calling actually brought in, and the one figure
      // that does not wait on somebody doing attribution first.
      //
      // Windowed on when the money arrived, like every other money figure
      // here, and narrowed for a caller to the QRs that are theirs to use.
      pool.query(
        `SELECT q.id, q.qr_id, q.label, q.purpose, u.name AS owner_name, q.owner_id,
                COALESCE(SUM(p.amount), 0)::numeric AS raised,
                COUNT(p.id)::int AS payments,
                COUNT(p.id) FILTER (WHERE p.share_id IS NULL AND p.lead_id IS NULL AND p.person_id IS NULL)::int AS unattributed
           FROM razorpay_qrs q
           LEFT JOIN users u ON q.owner_id = u.id
           LEFT JOIN qr_payments p
             ON p.qr_id = q.qr_id
            AND COALESCE(p.status, 'captured') IN ('captured', 'authorized')
            AND ${WINDOW('p.received_at', 1, 2)}
          WHERE ($3::uuid IS NULL OR q.owner_id = $3::uuid OR q.owner_id IS NULL)
          GROUP BY q.id, q.qr_id, q.label, q.purpose, u.name, q.owner_id
         HAVING COUNT(p.id) > 0 OR q.active
          ORDER BY raised DESC, q.label`,
        [from, to, me]
      ),
    ]);

    const c = calls.rows[0];
    const l = leads.rows[0];
    const v = conv.rows[0];
    // Every rupee on this screen, from the one call above. Named here so the
    // headline tile, the QR tile and the breakdown are literally the same
    // numbers and cannot be edited apart by somebody touching one of them.
    const money = credits;

    // Money through QRs, attributed or not. See the query's own comment: this
    // is deliberately a wider set than the credits, and the two overlap, so
    // the difference is named rather than left for a reader to work out.
    const throughQrs = byQr.rows.reduce((t, r) => t + Number(r.raised), 0);

    res.json({
      range: { from, to, label },
      // The screen says whose figures these are rather than leaving the reader
      // to assume. A caller reading temple-wide totals as their own, or the
      // reverse, is the failure this one field prevents.
      scope: me ? 'mine' : 'team',
      // THE MONEY, as its own block rather than a field on `leads`.
      //
      // It sits apart because it is no longer a fact about leads: a caller's
      // QR payment, a link donation and cash they banked are all credits and
      // none of them need a lead to exist. Leaving "raised" inside the leads
      // block is what let the old code reach for leads.converted_amount every
      // time somebody added a tile.
      money,
      leads: {
        received: l.received,
        converted: l.converted,
        // Of the leads created in this window. A campaign's own conversion
        // rate, not diluted by every lead the temple has ever had.
        conversion_rate: l.received ? Math.round((l.converted / l.received) * 1000) / 10 : 0,
        // Literally money.raised, not a second query that could come to a
        // different answer. Kept here only so the existing dashboard keeps
        // rendering while the client moves onto `money`; delete it once it has.
        raised: money.raised,
        // Counts, unchanged, and still correctly asked of leads: how many
        // leads converted in this window and how many of those have no
        // donation row to point at yet.
        converted_unreceipted: v.converted_unreceipted,
        donors_paid: v.converted,
      },
      calls: {
        made: c.made,
        connected: c.connected,
        unanswered: c.made - c.connected,
        connect_rate: c.made ? Math.round((c.connected / c.made) * 1000) / 10 : 0,
        leads_touched: c.leads_touched,
        // Only over the calls that actually carry a duration - averaging over
        // the ones left blank would drag it towards zero and look like a
        // collapse in call quality that never happened.
        avg_duration_seconds: c.with_duration ? Math.round(c.total_seconds / c.with_duration) : null,
        with_duration: c.with_duration,
        measured: c.measured,
        self_reported: c.made - c.measured,
      },
      pipeline: { value: Number(pipeline.rows[0].pipeline), open_leads: pipeline.rows[0].open_leads },
      follow_ups: followUps.rows[0],
      by_status: byStatus.rows,
      by_source: bySource.rows,
      callers_today: callers.rows,
      qr: {
        shared: qr.rows[0].shared,
        paid: qr.rows[0].paid,
        awaiting: qr.rows[0].awaiting,
        // QR money that has actually been credited to a caller - the same
        // figure as money.by_kind.qr, and part of money.raised.
        credited: money.by_kind.qr,
        // Every rupee through a QR in this window, attributed or not. Larger
        // than `credited` whenever payments are waiting to be attributed, and
        // that difference is the point of showing both.
        //
        // THIS IS A SUPERSET OF `credited`, NOT A SEPARATE PILE OF MONEY.
        // Adding through_qrs to money.raised counts the credited QR payments
        // twice. The two figures answer different questions - "what did
        // calling bring in, whoever ends up credited" and "what has been
        // attributed to a named caller" - and both belong on the screen, so
        // the gap between them is given a name of its own below rather than
        // being left for whoever reads the tile to subtract in their head.
        through_qrs: throughQrs,
        // The gap: money through the QRs that no caller has been credited
        // with yet. This is the work queue, and it is the honest reason the
        // two totals on this screen are not the same number.
        not_credited: Math.round((throughQrs - money.by_kind.qr) * 100) / 100,
        unattributed: byQr.rows.reduce((t, r) => t + Number(r.unattributed), 0),
      },
      by_qr: byQr.rows.map((r) => ({
        id: r.id,
        qr_id: r.qr_id,
        label: r.label,
        purpose: r.purpose,
        owner_name: r.owner_name,
        raised: Number(r.raised),
        payments: r.payments,
        unattributed: r.unattributed,
      })),
    });
  } catch (err) {
    console.error('crm.dashboard error:', err);
    res.status(500).json({ error: 'Could not load the calling dashboard' });
  }
});

/* --------------------------------------------------------------- credits */

/**
 * A CALLER'S OWN LEDGER, AND WHY IT IS REGISTERED HERE AND NOT BELOW.
 *
 * These two routes sit at /reports/credits but are deliberately declared
 * ABOVE router.use('/reports', authorize('admin','accountant')) a few lines
 * down, so that blanket refusal never reaches them.
 *
 * The blanket guard exists to stop a caller seeing a caller-versus-caller
 * table - see its own comment. That reason does not apply to this list: it is
 * one person's own credits, narrowed server-side by scopeOf before the query
 * runs, which is exactly the thing a caller most needs to check ("the ₹5,000
 * I took this morning - is it on my name?"). Sending them to an admin to find
 * out is how a team stops believing the figure on their dashboard.
 *
 * It is NOT left unguarded. A guard of its own names the roles that may in -
 * including caller, which the blanket one refuses - so volunteer_coordinator,
 * who the blanket guard would also have refused, is still refused here. This
 * is a narrower guard, not a redundant one, and without it a role nobody
 * thought about would read the whole temple's attribution.
 */
const CREDIT_READERS = authorize('admin', 'accountant', 'caller');

const CREDIT_KINDS = ['qr', 'link', 'lead', 'offline', 'manual'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The filters, resolved once and shared by the list, its totals and the file.
 *
 * Built in one place so the three cannot drift: an export whose filters differ
 * from the screen it was downloaded from is worse than no export, because the
 * person sends the file to somebody who then acts on it.
 */
function creditFilters(
  req: { user?: { role?: string; userId?: string }; query: Record<string, unknown> },
  from: string,
  to: string
) {
  const me = scopeOf(req);
  const asked = String(req.query.user_id ?? '');
  // A caller's own id WINS over anything in the query string. Honouring
  // ?user_id= for a caller would turn a personal ledger into a way of reading
  // a colleague's month by editing the URL, which is the same hole the
  // dashboard had before scopeOf existed.
  const who = me ?? (UUID_RE.test(asked) ? asked : null);

  const values: unknown[] = [from, to, who];
  const where = [CREDIT_WINDOW(1, 2), `($3::uuid IS NULL OR c.user_id = $3::uuid)`];

  const kind = String(req.query.kind ?? '');
  if (CREDIT_KINDS.includes(kind)) {
    values.push(kind);
    where.push(`c.kind = $${values.length}`);
  }

  // Not a boolean: "verified" and "awaiting" are both real answers and the
  // absence of the filter means both, so a tri-state string says what a
  // missing-or-false boolean could not.
  const verified = String(req.query.verified ?? '');
  if (verified === 'yes') where.push('c.verified_at IS NOT NULL');
  else if (verified === 'no') where.push('c.verified_at IS NULL');

  return { me, who, kind: CREDIT_KINDS.includes(kind) ? kind : null, verified, where: where.join(' AND '), values };
}

/**
 * The rows, with their evidence.
 *
 * Every credit carries at least one evidence id; which one depends on kind. A
 * figure nobody can trace back to a payment is a figure nobody will believe,
 * so the thing a human would quote on the phone - the Razorpay reference, the
 * 80G receipt number, the donor's name, the link that was sent - is joined in
 * rather than leaving the reader with a UUID.
 *
 * Ordered by occurred_at with the id as a tiebreak: two credits written in the
 * same second would otherwise come back in an arbitrary order that changes
 * between calls, which makes page 2 of a paged list drop and repeat rows.
 */
const CREDIT_ROWS_SQL = (where: string) => `
  SELECT c.id, c.amount, c.kind, c.occurred_at, c.note,
         c.verified_at, c.user_id,
         u.name AS caller_name,
         p.payment_id    AS payment_reference,
         d.receipt_number,
         l.name          AS lead_name,
         k.label         AS link_label
    FROM caller_credits c
    JOIN users u ON u.id = c.user_id
    LEFT JOIN qr_payments p ON p.id = c.qr_payment_id
    LEFT JOIN donations   d ON d.id = c.donation_id
    LEFT JOIN leads       l ON l.id = c.lead_id
    LEFT JOIN crm_links   k ON k.id = c.link_id
   WHERE ${where}
   ORDER BY c.occurred_at DESC, c.id DESC`;

/**
 * The totals, computed in SQL over the WHOLE filtered set.
 *
 * Never by adding up the page above. That bug is already written up at length
 * in crm.ts over the abandoned-attempts list: the totals were summed in
 * JavaScript over a capped query, so "value at stake" quietly reported the
 * first five hundred rows and nothing else, and a twelve-lakh figure read as
 * seven with the money still exactly where it had always been. A total and a
 * page are different questions, and only one of them is allowed a LIMIT.
 *
 * Needs none of the evidence joins - every predicate is on c - so it is a
 * cheap index scan rather than a second copy of the list query.
 */
const CREDIT_TOTALS_SQL = (where: string) => `
  SELECT COUNT(*)::int                                AS credits,
         COALESCE(SUM(c.amount), 0)::numeric          AS raised,
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
   WHERE ${where}`;

/** One credit as the screen and the file both see it. */
function creditRow(r: Record<string, unknown>) {
  return {
    id: r.id,
    amount: Number(r.amount),
    kind: r.kind,
    occurred_at: r.occurred_at,
    note: r.note,
    verified_at: r.verified_at,
    // The screen asks "is this checked yet" far more often than it asks when,
    // and a null timestamp is an awkward thing to render a tick from.
    verified: r.verified_at !== null,
    user_id: r.user_id,
    caller_name: r.caller_name,
    // Whichever of these is set is the evidence for this credit; the rest are
    // null because this kind of money does not have one.
    payment_reference: r.payment_reference ?? null,
    receipt_number: r.receipt_number ?? null,
    lead_name: r.lead_name ?? null,
    link_label: r.link_label ?? null,
  };
}

/**
 * Shaped field-for-field like the CreditTotals the dashboard sends, so the two
 * screens can share one component and one reading of the words. The aggregate
 * is written out here rather than delegated to totalsFor() only because this
 * list carries filters - kind, verified, a chosen caller - that the service's
 * fixed signature does not take.
 */
function creditTotals(r: Record<string, unknown>) {
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

router.get('/reports/credits', CREDIT_READERS, async (req, res) => {
  const { from, to, label } = range(req.query as Record<string, unknown>);
  const f = creditFilters(req, from, to);
  // Capped because nobody scrolls two hundred credit rows, and an uncapped
  // list over "All time" is the whole table. The totals beside it are not
  // capped, which is the only reason capping this is safe.
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const page = Math.max(1, Number(req.query.page) || 1);

  try {
    // Same reason the dashboard and the caller export do it: a caller opening
    // this list straight after a payment lands is the commonest way it gets
    // read, and without this their newest money is missing from the one screen
    // that exists to tell them it arrived.
    await reconcileConversions();

    const [rows, totals] = await Promise.all([
      pool.query(
        `${CREDIT_ROWS_SQL(f.where)} LIMIT $${f.values.length + 1} OFFSET $${f.values.length + 2}`,
        [...f.values, limit, (page - 1) * limit]
      ),
      pool.query(CREDIT_TOTALS_SQL(f.where), f.values),
    ]);
    const t = creditTotals(totals.rows[0]);

    res.json({
      range: { from, to, label },
      // Says whose ledger this is, for the same reason the dashboard does: a
      // caller reading the temple's credits as their own, or the reverse, is
      // the misunderstanding this one field prevents.
      scope: f.me ? 'mine' : 'team',
      filters: { user_id: f.who, kind: f.kind, verified: f.verified || null },
      totals: t,
      credits: rows.rows.map(creditRow),
      // The pager's row count is the totals' own COUNT(*), not a third query
      // over the same predicate. Two counts of one set is two things that can
      // disagree, and a pager that promises more pages than the totals admit
      // rows is the kind of small contradiction that makes somebody doubt the
      // money beside it.
      total: t.credits,
      page,
      limit,
    });
  } catch (err) {
    console.error('crm.reportCredits error:', err);
    res.status(500).json({ error: 'Could not load the list.' });
  }
});

/**
 * The same rows as a file.
 *
 * Same filters and the same scope as the list above, by construction - both
 * call creditFilters - so a caller cannot download what the screen would not
 * show them, and an admin's file matches the screen it was taken from.
 */
async function exportCreditsFile(
  req: import('express').Request,
  res: import('express').Response,
  format: ExportFormat
) {
  try {
    const { from, to, label } = range(req.query as Record<string, unknown>);
    const f = creditFilters(req, from, to);
    // Reconciled first, exactly as the screen does, so the file and the screen
    // it was downloaded from cannot show different money.
    await reconcileConversions();
    const rows = await pool.query(
      `${CREDIT_ROWS_SQL(f.where)} LIMIT ${EXPORT_ROW_CAP + 1}`,
      f.values
    );
    const truncated = rows.rows.length > EXPORT_ROW_CAP;

    await sendExport(res, format, {
      name: 'caller-credits',
      truncated,
      rows: (truncated ? rows.rows.slice(0, EXPORT_ROW_CAP) : rows.rows).map(creditRow),
      // Spelled out rather than left to describeFilters alone: the default
      // preset sends no query string at all, and "No filters applied" on a
      // file that silently covers the last 30 days - of one caller's credits -
      // is a lie the file tells to whoever opens it next.
      filterSummary:
        `${describeFilters(req.query as Record<string, unknown>, {
          kind: 'Kind',
          verified: 'Verification',
        })} | ${label} (${from} to ${to}) | ${f.me ? 'My total only' : f.who ? 'One caller' : 'All callers'}`,
      columns: [
        { header: 'Date', value: (r) => r.occurred_at, kind: 'datetime' },
        { header: 'Caller', value: (r) => r.caller_name },
        { header: 'Amount', value: (r) => r.amount, kind: 'money' },
        { header: 'Kind', value: (r) => r.kind },
        // Verified as its own column rather than folded into the amount: a
        // file that totals one "raised" column lets the office book a
        // caller's unreconciled cash claim as settled.
        { header: 'Verified', value: (r) => (r.verified ? 'Yes' : 'Awaiting') },
        { header: 'Verified at', value: (r) => r.verified_at, kind: 'datetime' },
        { header: 'Payment reference', value: (r) => r.payment_reference },
        { header: 'Receipt number', value: (r) => r.receipt_number },
        { header: 'Lead', value: (r) => r.lead_name },
        { header: 'Link', value: (r) => r.link_label },
        { header: 'Note', value: (r) => r.note },
      ],
    });
  } catch (err) {
    console.error('crm.exportCredits error:', err);
    res.status(500).json({ error: 'Could not download. Try again.' });
  }
}

router.get('/reports/credits/export.csv', CREDIT_READERS, (req, res) =>
  exportCreditsFile(req, res, 'csv')
);
router.get('/reports/credits/export.xlsx', CREDIT_READERS, (req, res) =>
  exportCreditsFile(req, res, 'xlsx')
);

/* ----------------------------------------------------------------- reports */

/**
 * Everything under /reports is supervisory and stays that way.
 *
 * These five compare callers against each other - calls made, connect rates,
 * whose follow-ups are late - which is a supervisor's job and nobody else's.
 * The dashboard above could be narrowed to one caller and still mean
 * something; a caller-versus-caller table cannot. So this is a refusal rather
 * than a scope, and it sits here, in front of all of them, rather than being
 * remembered separately on each new report somebody adds later.
 *
 * ONE EXCEPTION, AND IT IS ABOVE THIS LINE, NOT BELOW IT. /reports/credits and
 * its two exports are declared before this guard on purpose, because they are
 * a caller's own ledger rather than a comparison, and they carry their own
 * narrower guard. Anything added BELOW this line is covered and needs no guard
 * of its own; if you ever need another exception, put it above here with the
 * others so that "declared below the guard" keeps meaning "guarded".
 */
router.use('/reports', authorize('admin', 'accountant'));

// Employee/caller-wise activity. The columns a temple supervisor actually asks
// for: how many calls, how many got through, how long on the phone, how many
// moved forward, and how much money followed.
//
// Written once and run by both the screen and the export below. A supervisor
// who downloads this uses it in a review conversation, so a file whose figures
// differ from the screen they were quoted from is worse than no file.
const CALLER_REPORT_SQL = `WITH calls AS (
         SELECT a.user_id,
                COUNT(*)::int AS calls,
                COUNT(*) FILTER (WHERE a.connected)::int AS connected,
                COUNT(DISTINCT a.lead_id)::int AS leads_touched,
                COALESCE(SUM(a.duration_seconds),0)::int AS total_seconds,
                COUNT(*) FILTER (WHERE a.duration_seconds IS NOT NULL)::int AS with_duration,
                COUNT(*) FILTER (WHERE a.source <> 'manual')::int AS measured,
                COUNT(DISTINCT date_trunc('day', a.occurred_at))::int AS active_days
           FROM lead_activities a
          WHERE a.kind = 'call' AND ${WINDOW('a.occurred_at', 1, 2)}
          GROUP BY a.user_id
       ),
       conversions AS (
         -- THE COUNT of leads that converted, attributed to whoever the lead
         -- was ASSIGNED to when it converted. Imperfect where a lead changed
         -- hands, and deliberately not split between callers: a made-up share
         -- is worse than a simple rule everybody understands.
         SELECT l.assigned_to AS user_id,
                COUNT(*)::int AS conversions
           FROM leads l
          -- converted_at, not converted_donation_id. See the dashboard's own
          -- note: a QR payment and a cash donation recorded by hand both
          -- convert a lead without ever producing a donation row here, so
          -- keying on the link counted a caller's QR work as zero conversions
          -- and zero rupees on the very report a supervisor judges them by.
          WHERE l.converted_at IS NOT NULL AND ${WINDOW('l.converted_at', 1, 2)}
          GROUP BY l.assigned_to
       ),
       wins AS (
         -- THE MONEY, from caller_credits and nowhere else.
         --
         -- This used to be SUM(leads.converted_amount) GROUP BY assigned_to,
         -- in the same CTE as the count above. That is a live join, so this
         -- report was never a record of what a caller raised in March - it
         -- was a statement about who owns those leads at the moment the page
         -- is loaded. A bulk reassignment moved money out of one caller's
         -- past months and into another's, retroactively, with nothing
         -- recording that it had happened, and a supervisor comparing this
         -- report against a printout from last quarter found two different
         -- numbers and no explanation. A credit is written once and does not
         -- move.
         --
         -- It also only ever saw lead conversions. A caller whose whole month
         -- was QR payments and banked cash scored zero rupees here.
         SELECT c.user_id,
                COUNT(*)::int AS credits,
                COALESCE(SUM(c.amount),0)::numeric AS raised,
                -- Split out rather than merged: an offline credit is the
                -- caller's own word until somebody reconciles it, and a
                -- supervisor running a review needs to see which part of a
                -- total that is before quoting it at somebody.
                COALESCE(SUM(c.amount) FILTER (WHERE c.verified_at IS NOT NULL),0)::numeric
                  AS raised_verified,
                COALESCE(SUM(c.amount) FILTER (WHERE c.verified_at IS NULL),0)::numeric
                  AS raised_awaiting
           FROM caller_credits c
          WHERE ${CREDIT_WINDOW(1, 2)}
          GROUP BY c.user_id
       )
       SELECT u.id, u.name, u.email,
              COALESCE(c.calls,0) AS calls,
              COALESCE(c.connected,0) AS connected,
              COALESCE(c.calls,0) - COALESCE(c.connected,0) AS unanswered,
              COALESCE(c.leads_touched,0) AS leads_touched,
              COALESCE(c.total_seconds,0) AS total_seconds,
              COALESCE(c.with_duration,0) AS with_duration,
              COALESCE(c.measured,0) AS measured,
              COALESCE(c.active_days,0) AS active_days,
              COALESCE(v.conversions,0) AS conversions,
              COALESCE(w.credits,0) AS credits,
              COALESCE(w.raised,0) AS raised,
              COALESCE(w.raised_verified,0) AS raised_verified,
              COALESCE(w.raised_awaiting,0) AS raised_awaiting
         FROM users u
         LEFT JOIN calls c ON c.user_id = u.id
         LEFT JOIN conversions v ON v.user_id = u.id
         LEFT JOIN wins  w ON w.user_id = u.id
        -- credits > 0 is in this test deliberately. Money no longer has to
        -- arrive through a lead, so a caller whose month was offline cash and
        -- claimed QR payments has conversions of zero and would have dropped
        -- off the report entirely - showing a supervisor nothing at all for
        -- somebody who raised real money.
        WHERE COALESCE(c.calls,0) > 0
           OR COALESCE(v.conversions,0) > 0
           OR COALESCE(w.credits,0) > 0

        UNION ALL

       -- Work that belongs to nobody: calls logged by a deleted user, and
       -- conversions on leads that were never assigned. Shown as its own row
       -- rather than dropped, because a report whose column total is quietly
       -- smaller than the dashboard's is how people stop trusting both.
       --
       -- Its raised columns are structurally zero and that is not a bug:
       -- caller_credits.user_id is NOT NULL, so money with no caller has no
       -- credit row to find. Unattributed money is not hidden, it is just
       -- counted somewhere honest about what it is - qr.not_credited and the
       -- per-QR breakdown on the dashboard.
       SELECT NULL::uuid, 'Unassigned', NULL,
              COALESCE(c.calls,0), COALESCE(c.connected,0),
              COALESCE(c.calls,0) - COALESCE(c.connected,0),
              COALESCE(c.leads_touched,0), COALESCE(c.total_seconds,0),
              COALESCE(c.with_duration,0), COALESCE(c.measured,0),
              COALESCE(c.active_days,0), COALESCE(v.conversions,0),
              0, 0, 0, 0
         FROM (SELECT 1) one
         LEFT JOIN calls c ON c.user_id IS NULL
         LEFT JOIN conversions v ON v.user_id IS NULL

        WHERE COALESCE(c.calls,0) > 0 OR COALESCE(v.conversions,0) > 0

        ORDER BY calls DESC, raised DESC`;

router.get('/reports/callers', async (req, res) => {
  const { from, to, label } = range(req.query as Record<string, unknown>);
  try {
    await reconcileConversions();
    const rows = await pool.query(CALLER_REPORT_SQL, [from, to]);
    res.json({ range: { from, to, label }, callers: rows.rows });
  } catch (err) {
    console.error('crm.reportCallers error:', err);
    res.status(500).json({ error: 'Could not load the caller report.' });
  }
});

/**
 * The caller report, as a file.
 *
 * Resolves the window through range() exactly as the screen does, so `preset`
 * means the same thing in both - and reconciles conversions first for the same
 * reason the screen does, or the file would report a caller's QR work as zero
 * rupees purely because nothing had run since their last payment came in.
 *
 * No role guard of its own: router.use('/reports', ...) above already refuses
 * anyone but an admin or accountant, and that is deliberately one guard in
 * front of every report rather than one remembered per route.
 */
async function exportCallerReportFile(
  req: import('express').Request,
  res: import('express').Response,
  format: ExportFormat
) {
  try {
    const { from, to, label } = range(req.query as Record<string, unknown>);
    await reconcileConversions();
    const rows = await pool.query(
      `${CALLER_REPORT_SQL} LIMIT ${EXPORT_ROW_CAP + 1}`,
      [from, to]
    );
    const truncated = rows.rows.length > EXPORT_ROW_CAP;

    await sendExport(res, format, {
      name: 'caller-report',
      truncated,
      rows: truncated ? rows.rows.slice(0, EXPORT_ROW_CAP) : rows.rows,
      // The window is spelled out rather than left to describeFilters: the
      // default preset sends no query string at all, and "No filters applied"
      // on a report that silently covers the last 30 days is a lie the file
      // tells to whoever reads it next.
      filterSummary: `${describeFilters(req.query as Record<string, unknown>, {})} | ${label} (${from} to ${to})`,
      columns: [
        { header: 'Caller', value: (r) => r.name },
        { header: 'Calls made', value: (r) => r.calls, kind: 'number' },
        { header: 'Connected', value: (r) => r.connected, kind: 'number' },
        { header: 'Active days', value: (r) => r.active_days, kind: 'number' },
        { header: 'Leads converted', value: (r) => r.conversions, kind: 'number' },
        { header: 'Amount raised', value: (r) => r.raised, kind: 'money' },
        // Both halves of the total, because this file is quoted at people in
        // review conversations. A single "raised" column invites a supervisor
        // to treat a caller's unreconciled cash claim as settled fact.
        { header: 'Verified', value: (r) => r.raised_verified, kind: 'money' },
        { header: 'Awaiting verification', value: (r) => r.raised_awaiting, kind: 'money' },
      ],
    });
  } catch (err) {
    console.error('crm.exportCallerReport error:', err);
    res.status(500).json({ error: 'Could not download. Try again.' });
  }
}

router.get('/reports/callers/export.csv', (req, res) => exportCallerReportFile(req, res, 'csv'));
router.get('/reports/callers/export.xlsx', (req, res) => exportCallerReportFile(req, res, 'xlsx'));

// Day-by-day (or month-by-month) activity - the shape of a campaign over time,
// and what the chart on the reports page is drawn from.
router.get('/reports/timeline', async (req, res) => {
  const { from, to, label } = range(req.query as Record<string, unknown>);
  const grain = String(req.query.grain ?? 'day') === 'month' ? 'month' : 'day';
  try {
    const rows = await pool.query(
      `WITH days AS (
         SELECT generate_series($1::date, $2::date, ('1 ' || $3)::interval) AS bucket
       )
       SELECT d.bucket,
              COALESCE(c.calls,0)      AS calls,
              COALESCE(c.connected,0)  AS connected,
              COALESCE(n.new_leads,0)  AS new_leads,
              COALESCE(v.conversions,0) AS conversions,
              COALESCE(cr.raised,0)    AS raised,
              COALESCE(cr.raised_verified,0) AS raised_verified,
              COALESCE(cr.raised_awaiting,0) AS raised_awaiting
         FROM days d
         LEFT JOIN (
           SELECT date_trunc($3, occurred_at) AS b,
                  COUNT(*)::int AS calls,
                  COUNT(*) FILTER (WHERE connected)::int AS connected
             FROM lead_activities WHERE kind='call' AND ${WINDOW('occurred_at', 1, 2)}
            GROUP BY 1
         ) c ON c.b = d.bucket
         LEFT JOIN (
           SELECT date_trunc($3, created_at) AS b, COUNT(*)::int AS new_leads
             FROM leads WHERE ${WINDOW('created_at', 1, 2)} GROUP BY 1
         ) n ON n.b = d.bucket
         LEFT JOIN (
           SELECT date_trunc($3, converted_at) AS b,
                  COUNT(*)::int AS conversions
             -- Same rule as everywhere else: a conversion is a conversion,
             -- whether or not a receipt row exists for it yet.
             FROM leads WHERE converted_at IS NOT NULL AND ${WINDOW('converted_at', 1, 2)}
            GROUP BY 1
         ) v ON v.b = d.bucket
         -- The money line, from credits, bucketed on the day the money landed.
         -- It was SUM(leads.converted_amount) in the join above, which put the
         -- chart on a different source from the caller table printed directly
         -- beneath it on the same page: the chart's area and the table's
         -- "Amount raised" column added up to two different totals for the
         -- same week, and neither screen admitted it.
         LEFT JOIN (
           SELECT date_trunc($3, c.occurred_at) AS b,
                  COALESCE(SUM(c.amount),0)::numeric AS raised,
                  COALESCE(SUM(c.amount) FILTER (WHERE c.verified_at IS NOT NULL),0)::numeric
                    AS raised_verified,
                  COALESCE(SUM(c.amount) FILTER (WHERE c.verified_at IS NULL),0)::numeric
                    AS raised_awaiting
             FROM caller_credits c
            WHERE ${CREDIT_WINDOW(1, 2)}
            GROUP BY 1
         ) cr ON cr.b = d.bucket
        ORDER BY d.bucket`,
      [from, to, grain]
    );
    res.json({ range: { from, to, label }, grain, buckets: rows.rows });
  } catch (err) {
    console.error('crm.reportTimeline error:', err);
    res.status(500).json({ error: 'Could not load the timeline.' });
  }
});

// Call report: the outcome breakdown. What is actually happening on the phone,
// which is usually the first thing that explains a low conversion rate - a
// third of the list being switched off is a list problem, not a caller problem.
router.get('/reports/calls', async (req, res) => {
  const { from, to, label } = range(req.query as Record<string, unknown>);
  try {
    const [byDisposition, byHour, totals] = await Promise.all([
      pool.query(
        `SELECT a.disposition, COALESCE(d.label, a.disposition) AS label,
                COALESCE(d.counts_connected, FALSE) AS counts_connected,
                COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE a.duration_seconds IS NOT NULL)::int AS with_duration,
                COALESCE(AVG(a.duration_seconds) FILTER (WHERE a.duration_seconds IS NOT NULL), 0)::int AS avg_seconds
           FROM lead_activities a
           LEFT JOIN crm_dispositions d ON a.disposition = d.slug
          WHERE a.kind='call' AND ${WINDOW('a.occurred_at', 1, 2)}
          GROUP BY a.disposition, d.label, d.counts_connected, d.sort_order
          ORDER BY MIN(COALESCE(d.sort_order, 999))`,
        [from, to]
      ),
      // When calls actually connect. Worth knowing before deciding the calling
      // hours - and it is a real finding, not a vanity chart.
      pool.query(
        // AT TIME ZONE IS NOT OPTIONAL HERE, even with the session on IST.
        //
        // This number is printed to the user as a clock time ("best around
        // 4:00"). Read in UTC, a 10am call reports as hour 4 - and because IST
        // is offset by thirty minutes as well as five hours, every real
        // calling hour smeared across two buckets and flattened the very peak
        // this chart exists to find. Stated explicitly so the one query whose
        // output IS a wall-clock time can never quietly follow a session
        // setting somewhere else.
        `SELECT EXTRACT(HOUR FROM occurred_at AT TIME ZONE '${APP_TIMEZONE}')::int AS hour,
                COUNT(*)::int AS calls,
                COUNT(*) FILTER (WHERE connected)::int AS connected
           FROM lead_activities
          WHERE kind='call' AND ${WINDOW('occurred_at', 1, 2)}
          GROUP BY 1 ORDER BY 1`,
        [from, to]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS made,
                COUNT(*) FILTER (WHERE connected)::int AS connected,
                COUNT(*) FILTER (WHERE direction='inbound')::int AS inbound,
                COUNT(*) FILTER (WHERE direction='missed')::int AS missed,
                COUNT(*) FILTER (WHERE source <> 'manual')::int AS measured,
                COUNT(*) FILTER (WHERE recording_url IS NOT NULL)::int AS recorded
           FROM lead_activities WHERE kind='call' AND ${WINDOW('occurred_at', 1, 2)}`,
        [from, to]
      ),
    ]);
    res.json({ range: { from, to, label }, totals: totals.rows[0], by_disposition: byDisposition.rows, by_hour: byHour.rows });
  } catch (err) {
    console.error('crm.reportCalls error:', err);
    res.status(500).json({ error: 'Could not load the call report.' });
  }
});

// Conversion report: which lists are worth the temple's time. Grouped by where
// the lead came from and by the list it was uploaded as, because "the
// Janmashtami list converted at 11% and the event list at 0.4%" is the finding
// that changes what gets called next year.
router.get('/reports/conversion', async (req, res) => {
  const { from, to, label } = range(req.query as Record<string, unknown>);
  const by = ['source', 'source_detail', 'assigned_to', 'status'].includes(String(req.query.by))
    ? String(req.query.by)
    : 'source';

  try {
    await reconcileConversions();
    const rows = await pool.query(
      `SELECT COALESCE(l.${by}::text, 'Unspecified') AS bucket,
              COUNT(*)::int AS leads,
              -- These three disagreed with each other: the raised sum counted
              -- every conversion while the conversion count took only the
              -- receipted ones, so a row could show money raised, a conversion
              -- count of zero and a rate of 0% at once - and still carry the
              -- converted lead's expectation in pipeline as if outstanding.
              COUNT(*) FILTER (WHERE l.converted_at IS NOT NULL)::int AS conversions,
              -- STILL leads.converted_amount, and knowingly so. This report
              -- groups by an attribute of the lead - which list it came from,
              -- which status it reached - and a credit does not carry one: QR,
              -- link and offline credits often have no lead at all, so reading
              -- this from caller_credits would silently drop them and make the
              -- "Unspecified" bucket the biggest one on the page. It therefore
              -- answers a narrower question than the dashboard's "raised" and
              -- will not tie out against it. Do not reconcile the two by
              -- changing this; the honest fix is to decide what a
              -- source-attributed figure should mean when the money arrived
              -- without a lead. by=assigned_to is the worst of it: that is
              -- SUM(money) GROUP BY a user column, the exact live-join shape
              -- caller_credits exists to retire.
              COALESCE(SUM(l.converted_amount),0)::numeric AS raised,
              COALESCE(SUM(l.expected_amount) FILTER (WHERE l.converted_at IS NULL),0)::numeric AS pipeline,
              COALESCE(AVG(l.call_attempts),0)::numeric(10,1) AS avg_attempts
         FROM leads l
        WHERE ${WINDOW('l.created_at', 1, 2)}
        GROUP BY 1
        ORDER BY raised DESC, leads DESC`,
      [from, to]
    );

    res.json({
      range: { from, to, label },
      by,
      rows: rows.rows.map((r) => ({
        ...r,
        rate: r.leads ? Math.round((r.conversions / r.leads) * 1000) / 10 : 0,
        // What an average call is worth on this list. The number that decides
        // whether a list is worth ringing at all.
        value_per_lead: r.leads ? Math.round((Number(r.raised) / r.leads) * 100) / 100 : 0,
      })),
    });
  } catch (err) {
    console.error('crm.reportConversion error:', err);
    res.status(500).json({ error: 'Could not load the report.' });
  }
});

// Follow-up report: is the temple keeping its promises? Overdue leads broken
// down by who owes the call, and by how late they are.
router.get('/reports/follow-ups', async (_req, res) => {
  try {
    const rows = await pool.query(
      `SELECT COALESCE(u.name, 'Unassigned') AS caller, l.assigned_to,
              COUNT(*) FILTER (WHERE l.next_follow_up_at < date_trunc('day', NOW()) - INTERVAL '7 days')::int AS over_a_week,
              COUNT(*) FILTER (WHERE l.next_follow_up_at < date_trunc('day', NOW())
                                 AND l.next_follow_up_at >= date_trunc('day', NOW()) - INTERVAL '7 days')::int AS this_week,
              COUNT(*) FILTER (WHERE l.next_follow_up_at >= date_trunc('day', NOW())
                                 AND l.next_follow_up_at <  date_trunc('day', NOW()) + INTERVAL '1 day')::int AS due_today,
              COUNT(*) FILTER (WHERE l.next_follow_up_at >= date_trunc('day', NOW()) + INTERVAL '1 day')::int AS upcoming,
              COUNT(*) FILTER (WHERE l.next_follow_up_at IS NULL)::int AS unscheduled,
              MIN(l.next_follow_up_at) AS oldest_due
         FROM leads l
         LEFT JOIN users u ON l.assigned_to = u.id
         LEFT JOIN crm_statuses s ON l.status = s.slug
        WHERE COALESCE(s.is_open, TRUE) AND l.do_not_call = FALSE
        GROUP BY u.name, l.assigned_to
        ORDER BY over_a_week DESC, this_week DESC`
    );
    res.json({ rows: rows.rows });
  } catch (err) {
    console.error('crm.reportFollowUps error:', err);
    res.status(500).json({ error: 'Could not load the follow-up report.' });
  }
});

export default router;
