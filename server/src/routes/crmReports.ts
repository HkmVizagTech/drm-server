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
//   Amount raised       the sum of those donations. Never the pipeline.
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

const router = Router();
router.use(authenticate);

// Date window shared by every endpoint here. Defaults to the last 30 days
// because that is the span a temple's calling campaign actually runs over, and
// an unbounded default would scan the whole activity table on every page load.
function range(q: Record<string, unknown>): { from: string; to: string; label: string } {
  const preset = String(q.preset ?? '');
  const now = new Date();
  const day = (d: Date) => d.toISOString().slice(0, 10);

  if (q.start_date || q.end_date) {
    return {
      from: String(q.start_date ?? '1970-01-01'),
      to: String(q.end_date ?? day(now)),
      label: 'Custom',
    };
  }

  const back = (n: number) => day(new Date(now.getTime() - n * 86_400_000));
  switch (preset) {
    case 'today': return { from: day(now), to: day(now), label: 'Today' };
    case 'yesterday': return { from: back(1), to: back(1), label: 'Yesterday' };
    case 'week': return { from: back(6), to: day(now), label: 'Last 7 days' };
    case 'month': return { from: day(new Date(now.getFullYear(), now.getMonth(), 1)), to: day(now), label: 'This month' };
    case 'quarter': return { from: back(89), to: day(now), label: 'Last 90 days' };
    case 'year': return { from: `${now.getFullYear()}-01-01`, to: day(now), label: 'This year' };
    case 'all': return { from: '1970-01-01', to: day(now), label: 'All time' };
    default: return { from: back(29), to: day(now), label: 'Last 30 days' };
  }
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

    const [leads, calls, pipeline, followUps, byStatus, bySource, callers, qr] = await Promise.all([
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
        `SELECT COUNT(*)::int AS received,
                COUNT(*) FILTER (WHERE converted_at IS NOT NULL)::int AS converted,
                COALESCE(SUM(converted_amount) FILTER (WHERE converted_at IS NOT NULL), 0)::numeric AS raised,
                COALESCE(SUM(converted_amount) FILTER (
                  WHERE converted_at IS NOT NULL AND converted_donation_id IS NOT NULL
                ), 0)::numeric AS raised_receipted,
                COUNT(*) FILTER (
                  WHERE converted_at IS NOT NULL AND converted_donation_id IS NULL
                )::int AS converted_unreceipted
           FROM leads
          WHERE ${WINDOW('created_at', 1, 2)}
            AND ($3::uuid IS NULL OR assigned_to = $3::uuid)`,
        [from, to, me]
      ),
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
      pool.query(
        `SELECT COUNT(*)::int AS shared,
                COUNT(*) FILTER (WHERE s.matched_at IS NOT NULL)::int AS paid,
                COALESCE(SUM(s.matched_amount), 0)::numeric AS raised,
                COUNT(*) FILTER (
                  WHERE s.matched_at IS NULL AND s.created_at > NOW() - INTERVAL '7 days'
                )::int AS awaiting
           FROM qr_shares s
          WHERE ${WINDOW('s.created_at', 1, 2)}
            AND ($3::uuid IS NULL OR s.shared_by = $3::uuid)`,
        [from, to, me]
      ),
    ]);

    const c = calls.rows[0];
    const l = leads.rows[0];

    res.json({
      range: { from, to, label },
      // The screen says whose figures these are rather than leaving the reader
      // to assume. A caller reading temple-wide totals as their own, or the
      // reverse, is the failure this one field prevents.
      scope: me ? 'mine' : 'team',
      leads: {
        received: l.received,
        converted: l.converted,
        // Of the leads created in this window. A campaign's own conversion
        // rate, not diluted by every lead the temple has ever had.
        conversion_rate: l.received ? Math.round((l.converted / l.received) * 1000) / 10 : 0,
        raised: Number(l.raised),
        // Of that total, how much has a receipt behind it from one of the
        // sites. The gap is QR payments and cash - real money, not yet tied to
        // a receipt row - and naming it stops the total looking either
        // overstated or mysteriously small.
        raised_receipted: Number(l.raised_receipted),
        converted_unreceipted: l.converted_unreceipted,
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
        raised: Number(qr.rows[0].raised),
        awaiting: qr.rows[0].awaiting,
      },
    });
  } catch (err) {
    console.error('crm.dashboard error:', err);
    res.status(500).json({ error: 'Could not load the calling dashboard' });
  }
});

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
 */
router.use('/reports', authorize('admin', 'accountant'));

// Employee/caller-wise activity. The columns a temple supervisor actually asks
// for: how many calls, how many got through, how long on the phone, how many
// moved forward, and how much money followed.
router.get('/reports/callers', async (req, res) => {
  const { from, to, label } = range(req.query as Record<string, unknown>);
  try {
    await reconcileConversions();
    const rows = await pool.query(
      `WITH calls AS (
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
       wins AS (
         -- Attributed to whoever the lead was ASSIGNED to when it converted.
         -- Imperfect where a lead changed hands, and deliberately not split
         -- between callers: a made-up share is worse than a simple rule
         -- everybody understands.
         SELECT l.assigned_to AS user_id,
                COUNT(*)::int AS conversions,
                COALESCE(SUM(l.converted_amount),0)::numeric AS raised
           FROM leads l
          -- converted_at, not converted_donation_id. See the dashboard's own
          -- note: a QR payment and a cash donation recorded by hand both
          -- convert a lead without ever producing a donation row here, so
          -- keying on the link counted a caller's QR work as zero conversions
          -- and zero rupees on the very report a supervisor judges them by.
          WHERE l.converted_at IS NOT NULL AND ${WINDOW('l.converted_at', 1, 2)}
          GROUP BY l.assigned_to
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
              COALESCE(w.conversions,0) AS conversions,
              COALESCE(w.raised,0) AS raised
         FROM users u
         LEFT JOIN calls c ON c.user_id = u.id
         LEFT JOIN wins  w ON w.user_id = u.id
        WHERE COALESCE(c.calls,0) > 0 OR COALESCE(w.conversions,0) > 0

        UNION ALL

       -- Work that belongs to nobody: calls logged by a deleted user, and
       -- conversions on leads that were never assigned. Shown as its own row
       -- rather than dropped, because a report whose column total is quietly
       -- smaller than the dashboard's is how people stop trusting both.
       SELECT NULL::uuid, 'Unassigned', NULL,
              COALESCE(c.calls,0), COALESCE(c.connected,0),
              COALESCE(c.calls,0) - COALESCE(c.connected,0),
              COALESCE(c.leads_touched,0), COALESCE(c.total_seconds,0),
              COALESCE(c.with_duration,0), COALESCE(c.measured,0),
              COALESCE(c.active_days,0), COALESCE(w.conversions,0), COALESCE(w.raised,0)
         FROM (SELECT 1) one
         LEFT JOIN calls c ON c.user_id IS NULL
         LEFT JOIN wins  w ON w.user_id IS NULL
        WHERE COALESCE(c.calls,0) > 0 OR COALESCE(w.conversions,0) > 0

        ORDER BY calls DESC, raised DESC`,
      [from, to]
    );
    res.json({ range: { from, to, label }, callers: rows.rows });
  } catch (err) {
    console.error('crm.reportCallers error:', err);
    res.status(500).json({ error: 'Could not build the caller report' });
  }
});

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
              COALESCE(v.raised,0)     AS raised
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
                  COUNT(*)::int AS conversions,
                  COALESCE(SUM(converted_amount),0)::numeric AS raised
             -- Same rule as everywhere else: a conversion is a conversion,
             -- whether or not a receipt row exists for it yet.
             FROM leads WHERE converted_at IS NOT NULL AND ${WINDOW('converted_at', 1, 2)}
            GROUP BY 1
         ) v ON v.b = d.bucket
        ORDER BY d.bucket`,
      [from, to, grain]
    );
    res.json({ range: { from, to, label }, grain, buckets: rows.rows });
  } catch (err) {
    console.error('crm.reportTimeline error:', err);
    res.status(500).json({ error: 'Could not build the timeline' });
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
        `SELECT EXTRACT(HOUR FROM occurred_at)::int AS hour,
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
    res.status(500).json({ error: 'Could not build the call report' });
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
    res.status(500).json({ error: 'Could not build the conversion report' });
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
    res.status(500).json({ error: 'Could not build the follow-up report' });
  }
});

export default router;
