// Team activity: what each telecaller actually did, day by day. Admin only.
//
// EVERYTHING HERE COMES FROM WHAT DRM ALREADY RECORDS - no new tracking:
//   calls          lead_activities rows of kind 'call' (the one call log: the calling
//                  screen, Nearly gave, the Seva wall, the phone app all write here)
//   talk time      the call's duration_seconds. Only REAL when it came from the phone
//                  app (source other than 'manual'); a duration a caller typed is
//                  reported separately and labelled as logged, never added to the real
//                  figure - the same honesty rule as the Reports page.
//   money          caller_credits (the one immutable record of what a caller raised)
//   links sent     qr_shares
//   follow-ups     leads.next_follow_up_at, counted with the Follow-ups page's own rule
//
// WHAT A NUMBER MEANS, stated plainly because it is used to judge a person's work:
//   Calls made          outbound calls LOGGED that day. A call nobody logs is not here.
//   Answered            calls whose outcome counted as connected (the caller's word, or
//                       the phone's when it came from the app).
//   Active time         the time between a caller's consecutive calls, each gap counted
//                       up to 10 minutes. A longer gap is a break, not work.
//   Idle gaps           gaps between consecutive calls of more than 30 minutes.
//   Overdue / untouched a snapshot of RIGHT NOW (not of the day chosen): follow-up dates
//                       already past, and open assigned leads never called.
//
// Nothing here changes any data.

import { Router } from 'express';
import pool from '../db/pool';
import { authenticate, authorize } from '../middleware/auth';
import { FOLLOW_UP_LISTED } from './crmLists';
import { istDate } from '../bootTimezone';
import { sendExport, type ExportFormat } from '../utils/export';

const router = Router();
router.use('/team-activity', authenticate, authorize('admin'));

/* ------------------------------------------------------------- working day */

// There are no targets: callers are only asked to make calls. The one fixed thing is when the
// working day begins, so that "Not started" is not shown at six in the morning.
const WORK_START = '10:00';

/* ---------------------------------------------------------------- scorecard */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (q: unknown): string => (typeof q === 'string' && DAY.test(q) ? q : istDate());

/** A calendar date shifted by whole days, as YYYY-MM-DD (pure date arithmetic, no time zones involved). */
function shift(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const IN_DAY = `a.occurred_at >= $1::date AND a.occurred_at < $1::date + 1`;
// Every talk counts: calls the caller made and calls a donor made to them that
// were picked up. A missed call is nobody's work, so it is left out.
const OUTBOUND_CALL = `a.kind = 'call' AND COALESCE(a.direction, 'outbound') IN ('outbound', 'inbound') AND a.user_id IS NOT NULL`;

export interface Scorecard {
  id: string;
  name: string;
  role: string;
  last_login_at: string | null;
  calls: number;
  connected: number;
  unanswered: number;
  answered_pct: number | null;
  talk_real_seconds: number;
  talk_logged_seconds: number;
  first_call_at: string | null;
  last_call_at: string | null;
  active_minutes: number;
  idle_gaps: number;
  longest_gap_minutes: number;
  seva_wall_calls: number;
  inbound_calls: number;
  donors_reached: number;
  overdue_followups: number;
  due_today_followups: number;
  untouched_leads: number;
  raised: number;
  credits: number;
  links_sent: number;
  trend_7d: number[];
  status: 'live' | 'idle' | 'not_started' | 'before_hours' | null;
  minutes_since_last_call: number | null;
}

async function scorecards(day: string): Promise<{ rows: Scorecard[] }> {
  const isToday = day === istDate();

  const [people, stats, follow, untouched, credits, links, trend, clock] = await Promise.all([
    pool.query(
      `SELECT u.id, u.name, u.role, u.last_login_at
         FROM users u
        WHERE (u.role = 'caller' AND u.active)
           OR u.id IN (SELECT a.user_id FROM lead_activities a WHERE ${OUTBOUND_CALL} AND ${IN_DAY})
        ORDER BY u.name`,
      [day]
    ),
    pool.query(
      `WITH c AS (
         SELECT a.user_id, a.occurred_at, a.connected, a.duration_seconds, a.source, a.disposition, a.lead_id, a.direction,
                a.occurred_at - lag(a.occurred_at) OVER (PARTITION BY a.user_id ORDER BY a.occurred_at) AS gap
           FROM lead_activities a
          WHERE ${OUTBOUND_CALL} AND ${IN_DAY}
       )
       SELECT user_id,
              COUNT(*)::int                                                              AS calls,
              COUNT(*) FILTER (WHERE connected IS TRUE)::int                             AS connected,
              COUNT(*) FILTER (WHERE direction = 'inbound')::int                         AS inbound_calls,
              COALESCE(SUM(duration_seconds) FILTER (WHERE source <> 'manual'), 0)::int  AS talk_real_seconds,
              COALESCE(SUM(duration_seconds) FILTER (WHERE source = 'manual'), 0)::int   AS talk_logged_seconds,
              MIN(occurred_at)                                                           AS first_call_at,
              MAX(occurred_at)                                                           AS last_call_at,
              COALESCE(SUM(LEAST(EXTRACT(EPOCH FROM gap), 600)) FILTER (WHERE gap IS NOT NULL), 0)::int AS active_seconds,
              COUNT(*) FILTER (WHERE gap > INTERVAL '30 minutes')::int                   AS idle_gaps,
              COALESCE(MAX(EXTRACT(EPOCH FROM gap)), 0)::int                             AS longest_gap_seconds,
              COUNT(*) FILTER (WHERE disposition LIKE 'seva_wall%')::int                 AS seva_wall_calls,
              COUNT(DISTINCT lead_id) FILTER (WHERE connected IS TRUE)::int              AS donors_reached
         FROM c GROUP BY user_id`,
      [day]
    ),
    pool.query(
      `SELECT l.assigned_to AS user_id,
              COUNT(*) FILTER (WHERE l.next_follow_up_at <  $1::date)::int AS overdue,
              COUNT(*) FILTER (WHERE l.next_follow_up_at >= $1::date AND l.next_follow_up_at < $1::date + 1)::int AS due_today
         FROM leads l JOIN crm_statuses s ON s.slug = l.status AND s.is_open
        WHERE l.assigned_to IS NOT NULL AND l.next_follow_up_at IS NOT NULL AND NOT l.do_not_call
          AND ${FOLLOW_UP_LISTED}
        GROUP BY 1`,
      [day]
    ),
    pool.query(
      `SELECT l.assigned_to AS user_id, COUNT(*)::int AS n
         FROM leads l JOIN crm_statuses s ON s.slug = l.status AND s.is_open
        WHERE l.assigned_to IS NOT NULL AND l.call_attempts = 0 AND NOT l.do_not_call
        GROUP BY 1`
    ),
    pool.query(
      `SELECT c.user_id, COALESCE(SUM(c.amount), 0)::float8 AS raised, COUNT(*)::int AS n
         FROM caller_credits c
        WHERE c.status = 'active' AND c.occurred_at >= $1::date AND c.occurred_at < $1::date + 1
        GROUP BY 1`,
      [day]
    ),
    pool.query(
      `SELECT shared_by AS user_id, COUNT(*)::int AS n FROM qr_shares
        WHERE shared_by IS NOT NULL AND created_at >= $1::date AND created_at < $1::date + 1 GROUP BY 1`,
      [day]
    ),
    pool.query(
      `SELECT a.user_id, (a.occurred_at AT TIME ZONE 'Asia/Kolkata')::date AS d, COUNT(*)::int AS n
         FROM lead_activities a
        WHERE ${OUTBOUND_CALL} AND a.occurred_at >= $1::date - 6 AND a.occurred_at < $1::date + 1
        GROUP BY 1, 2`,
      [day]
    ),
    pool.query(`SELECT to_char(NOW() AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS hhmm`),
  ]);

  const by = <T extends { user_id: string }>(r: { rows: T[] }) => new Map(r.rows.map((x) => [x.user_id, x]));
  const S = by(stats as { rows: any[] }), F = by(follow as { rows: any[] }), U = by(untouched as { rows: any[] });
  const C = by(credits as { rows: any[] }), L = by(links as { rows: any[] });
  const days = Array.from({ length: 7 }, (_, i) => shift(day, i - 6));
  const T = new Map<string, Map<string, number>>();
  for (const r of trend.rows) {
    if (!T.has(r.user_id)) T.set(r.user_id, new Map());
    T.get(r.user_id)!.set(r.d, r.n);
  }
  const nowHHMM = clock.rows[0].hhmm as string;

  const rows: Scorecard[] = people.rows.map((p) => {
    const s = S.get(p.id) ?? {};
    const f = F.get(p.id) ?? {};
    const calls = s.calls ?? 0;
    const connected = s.connected ?? 0;
    const last = s.last_call_at ? new Date(s.last_call_at) : null;
    const since = last ? Math.round((Date.now() - last.getTime()) / 60000) : null;
    let status: Scorecard['status'] = null;
    if (isToday) {
      if (calls > 0) status = since !== null && since <= 15 ? 'live' : 'idle';
      else status = nowHHMM >= WORK_START ? 'not_started' : 'before_hours';
    }
    return {
      id: p.id,
      name: p.name,
      role: p.role,
      last_login_at: p.last_login_at,
      calls,
      connected,
      unanswered: calls - connected,
      answered_pct: calls ? Math.round((connected / calls) * 100) : null,
      talk_real_seconds: s.talk_real_seconds ?? 0,
      talk_logged_seconds: s.talk_logged_seconds ?? 0,
      first_call_at: s.first_call_at ?? null,
      last_call_at: s.last_call_at ?? null,
      active_minutes: Math.round((s.active_seconds ?? 0) / 60),
      idle_gaps: s.idle_gaps ?? 0,
      longest_gap_minutes: Math.round((s.longest_gap_seconds ?? 0) / 60),
      seva_wall_calls: s.seva_wall_calls ?? 0,
      inbound_calls: s.inbound_calls ?? 0,
      donors_reached: s.donors_reached ?? 0,
      overdue_followups: f.overdue ?? 0,
      due_today_followups: f.due_today ?? 0,
      untouched_leads: U.get(p.id)?.n ?? 0,
      raised: C.get(p.id)?.raised ?? 0,
      credits: C.get(p.id)?.n ?? 0,
      links_sent: L.get(p.id)?.n ?? 0,
      trend_7d: days.map((d) => T.get(p.id)?.get(d) ?? 0),
      status,
      minutes_since_last_call: isToday ? since : null,
    };
  });
  return { rows };
}

router.get('/team-activity', async (req, res) => {
  const day = dayOf(req.query.date);
  try {
    const { rows } = await scorecards(day);
    const sum = (f: (r: Scorecard) => number) => rows.reduce((n, r) => n + f(r), 0);
    res.json({
      date: day,
      today: day === istDate(),
      callers: rows,
      totals: {
        callers: rows.length,
        working_now: rows.filter((r) => r.status === 'live').length,
        not_started: rows.filter((r) => r.status === 'not_started').length,
        calls: sum((r) => r.calls),
        connected: sum((r) => r.connected),
        talk_real_seconds: sum((r) => r.talk_real_seconds),
        talk_logged_seconds: sum((r) => r.talk_logged_seconds),
        raised: sum((r) => r.raised),
        overdue_followups: sum((r) => r.overdue_followups),
        untouched_leads: sum((r) => r.untouched_leads),
      },
    });
  } catch (err) {
    console.error('team-activity error:', (err as Error).message);
    res.status(500).json({ error: 'Could not load the team activity.' });
  }
});

/* ------------------------------------------------------------------- export */

async function exportDay(req: import('express').Request, res: import('express').Response, format: ExportFormat) {
  const day = dayOf(req.query.date);
  try {
    const { rows } = await scorecards(day);
    const mins = (s: number) => Math.round(s / 60);
    await sendExport(res, format, {
      name: 'team-activity',
      rows,
      filterSummary: `Team activity for ${day}. Follow-ups overdue and untouched leads are as of the moment of download.`,
      columns: [
        { header: 'Caller', value: (r) => r.name },
        { header: 'Calls made', value: (r) => r.calls, kind: 'number' },
        { header: 'Answered', value: (r) => r.connected, kind: 'number' },
        { header: 'Answered %', value: (r) => r.answered_pct ?? '', kind: 'number' },
        { header: 'Talk time, from the phone app (min)', value: (r) => mins(r.talk_real_seconds), kind: 'number' },
        { header: 'Talk time, typed by the caller (min)', value: (r) => mins(r.talk_logged_seconds), kind: 'number' },
        { header: 'First call', value: (r) => r.first_call_at, kind: 'datetime' },
        { header: 'Last call', value: (r) => r.last_call_at, kind: 'datetime' },
        { header: 'Active time (min)', value: (r) => r.active_minutes, kind: 'number' },
        { header: 'Breaks over 30 min', value: (r) => r.idle_gaps, kind: 'number' },
        { header: 'Longest gap (min)', value: (r) => r.longest_gap_minutes, kind: 'number' },
        { header: 'Calls from donors', value: (r) => r.inbound_calls, kind: 'number' },
        { header: 'Donors reached', value: (r) => r.donors_reached, kind: 'number' },
        { header: 'Seva wall calls', value: (r) => r.seva_wall_calls, kind: 'number' },
        { header: 'Follow-ups overdue (now)', value: (r) => r.overdue_followups, kind: 'number' },
        { header: 'Untouched leads (now)', value: (r) => r.untouched_leads, kind: 'number' },
        { header: 'Money credited', value: (r) => r.raised, kind: 'money' },
        { header: 'Links sent', value: (r) => r.links_sent, kind: 'number' },
      ],
    });
  } catch (err) {
    console.error('team-activity export error:', (err as Error).message);
    res.status(500).json({ error: 'Could not download. Try again.' });
  }
}
router.get('/team-activity/export.csv', (req, res) => exportDay(req, res, 'csv'));
router.get('/team-activity/export.xlsx', (req, res) => exportDay(req, res, 'xlsx'));

/* ---------------------------------------------------------------- drill-down */

// One caller's day: every call in order, the hours they worked, how their calls ended, how
// the last two weeks went, and their calling sessions.
router.get('/team-activity/:userId', async (req, res) => {
  const id = String(req.params.userId);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(404).json({ error: 'Caller not found.' });
  const day = dayOf(req.query.date);
  try {
    const who = await pool.query(`SELECT id, name, role, last_login_at FROM users WHERE id = $1`, [id]);
    if (!who.rowCount) return res.status(404).json({ error: 'Caller not found.' });

    const mine = `a.user_id = $2 AND a.kind = 'call' AND ${IN_DAY}`;
    const [timeline, hourly, outcomes, trend, sessions] = await Promise.all([
      pool.query(
        `SELECT a.id, a.occurred_at, a.direction, a.disposition, d.label AS outcome, a.connected, a.duration_seconds,
                a.source, a.note, a.recording_url, l.id AS lead_id, l.name AS donor_name, l.phone
           FROM lead_activities a
           LEFT JOIN crm_dispositions d ON d.slug = a.disposition
           LEFT JOIN leads l ON l.id = a.lead_id
          WHERE ${mine}
          ORDER BY a.occurred_at DESC LIMIT 500`,
        [day, id]
      ),
      pool.query(
        `SELECT EXTRACT(HOUR FROM a.occurred_at AT TIME ZONE 'Asia/Kolkata')::int AS hour,
                COUNT(*)::int AS calls, COUNT(*) FILTER (WHERE a.connected IS TRUE)::int AS connected
           FROM lead_activities a WHERE ${mine} GROUP BY 1 ORDER BY 1`,
        [day, id]
      ),
      pool.query(
        `SELECT COALESCE(d.label, a.disposition, 'Unknown') AS outcome, COUNT(*)::int AS n
           FROM lead_activities a LEFT JOIN crm_dispositions d ON d.slug = a.disposition
          WHERE ${mine} GROUP BY 1 ORDER BY 2 DESC`,
        [day, id]
      ),
      pool.query(
        `SELECT (a.occurred_at AT TIME ZONE 'Asia/Kolkata')::date AS d, COUNT(*)::int AS calls,
                COUNT(*) FILTER (WHERE a.connected IS TRUE)::int AS connected
           FROM lead_activities a
          WHERE a.user_id = $2 AND a.kind = 'call' AND a.occurred_at >= $1::date - 13 AND a.occurred_at < $1::date + 1
          GROUP BY 1 ORDER BY 1`,
        [day, id]
      ),
      pool.query(
        `SELECT s.id, s.started_at, s.ended_at, s.last_active_at, s.calls_logged, s.connected
           FROM calling_sessions s
          WHERE s.user_id = $2 AND s.started_at >= $1::date AND s.started_at < $1::date + 1
          ORDER BY s.started_at`,
        [day, id]
      ),
    ]);

    const days = Array.from({ length: 14 }, (_, i) => shift(day, i - 13));
    const byDay = new Map(trend.rows.map((r) => [r.d, r]));
    res.json({
      caller: who.rows[0],
      date: day,
      timeline: timeline.rows,
      hourly: hourly.rows,
      outcomes: outcomes.rows,
      trend_14d: days.map((d) => ({ date: d, calls: byDay.get(d)?.calls ?? 0, connected: byDay.get(d)?.connected ?? 0 })),
      sessions: sessions.rows,
    });
  } catch (err) {
    console.error('team-activity drill-down error:', (err as Error).message);
    res.status(500).json({ error: 'Could not load that caller.' });
  }
});

export default router;
