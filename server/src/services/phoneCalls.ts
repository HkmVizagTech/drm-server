// Calls reported by the phone app (routes/phoneApp.ts).
//
// WHAT HAPPENS TO EACH CALL
//   - It is kept only when the number belongs to a DRM lead. The app already
//     filters on the phone; this is the second check.
//   - A call the caller made (outbound) is tied to the outcome they logged on
//     the call screen, so that row shows the measured talk time and the
//     recording. The outcome is often saved after the phone has synced, so the
//     tie is retried by linkPhoneCalls() until it is made.
//   - A donor who rang the caller back (inbound) or rang and was not answered
//     (missed) gets a call row in the lead's history of its own, so call-backs
//     are counted wherever calls are counted. A missed call-back also puts a
//     "ring them back" reminder on the caller's list, which closes itself once
//     the two of them have spoken.

import type { PoolClient } from 'pg';
import pool from '../db/pool';
import { APP_TIMEZONE } from '../bootTimezone';

type Db = Pick<PoolClient, 'query'>;

/** Android's CallLog.Calls.TYPE values. */
const OUTGOING = 2;
const INCOMING = 1;
const MISSED = 3;
const VOICEMAIL = 4;
const REJECTED = 5;
const BLOCKED = 6;
const ANSWERED_EXTERNALLY = 7;

export interface ReportedCall {
  /** The phone's call-log id + time. */
  key: string;
  /** CallLog.Calls.TYPE */
  type: number;
  phone: string;
  /** ISO time the call started. */
  started_at: string;
  duration_seconds: number;
  sim?: string | null;
  /** Dialled with DRM's Call button. */
  from_app?: boolean;
  /** The lead the Call button was pressed on, when it was. */
  lead_id?: string | null;
}

export interface CallResult {
  key: string;
  /** null when the call was not kept (not a DRM number, or not a call). */
  id: string | null;
  want_recording: boolean;
  direction?: string;
}

export const phone10 = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(-10);

/** outbound | inbound | missed, or null for a call-log entry that is not a call to keep. */
export function directionOf(type: number, seconds: number): 'outbound' | 'inbound' | 'missed' | null {
  if (type === OUTGOING) return 'outbound';
  if (type === INCOMING || type === ANSWERED_EXTERNALLY) return seconds > 0 ? 'inbound' : 'missed';
  if (type === MISSED || type === REJECTED) return 'missed';
  if (type === VOICEMAIL || type === BLOCKED) return null;
  return null;
}

/** The lead a number belongs to: the main number first, then the other number. */
async function leadFor(db: Db, phone: string, hint?: string | null): Promise<string | null> {
  if (hint && /^[0-9a-f-]{36}$/i.test(hint)) {
    const h = await db.query(
      `SELECT id FROM leads WHERE id = $1 AND (phone = $2 OR right(regexp_replace(COALESCE(alt_phone,''), '\\D', '', 'g'), 10) = $2)`,
      [hint, phone]
    );
    if (h.rows.length) return h.rows[0].id;
  }
  const r = await db.query(
    `SELECT id FROM leads
      WHERE phone = $1 OR right(regexp_replace(COALESCE(alt_phone,''), '\\D', '', 'g'), 10) = $1
      ORDER BY (phone = $1) DESC, updated_at DESC NULLS LAST
      LIMIT 1`,
    [phone]
  );
  return r.rows[0]?.id ?? null;
}

/** "14 Oct, 6:05 pm" in the temple's time. */
const atTime = (d: Date) =>
  d.toLocaleString('en-IN', { timeZone: APP_TIMEZONE, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

const fmtTalk = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);

/** Save what one phone reported. Safe to call twice with the same calls. */
export async function recordCalls(
  device: { id: string; user_id: string },
  calls: ReportedCall[]
): Promise<CallResult[]> {
  const out: CallResult[] = [];
  const touched = new Set<string>();
  for (const c of calls) {
    const key = String(c.key ?? '').slice(0, 80);
    const phone = phone10(c.phone);
    const seconds = Math.max(0, Math.round(Number(c.duration_seconds) || 0));
    const started = new Date(c.started_at);
    const direction = directionOf(Number(c.type), seconds);
    if (!key || phone.length !== 10 || !direction || Number.isNaN(started.getTime())) {
      out.push({ key, id: null, want_recording: false });
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT id, recording_status, direction FROM phone_calls WHERE device_id = $1 AND call_key = $2`,
        [device.id, key]
      );
      if (existing.rows.length) {
        await client.query('COMMIT');
        const e = existing.rows[0];
        out.push({ key, id: e.id, want_recording: e.recording_status === 'waiting', direction: e.direction });
        continue;
      }
      const leadId = await leadFor(client, phone, c.lead_id ?? null);
      if (!leadId) {
        await client.query('COMMIT');
        out.push({ key, id: null, want_recording: false });
        continue;
      }
      const ins = await client.query(
        `INSERT INTO phone_calls
           (device_id, user_id, call_key, direction, phone, lead_id, started_at, duration_seconds, sim, from_app, recording_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id`,
        [
          device.id,
          device.user_id,
          key,
          direction,
          phone,
          leadId,
          started.toISOString(),
          seconds,
          c.sim ? String(c.sim).slice(0, 60) : null,
          c.from_app === true,
          seconds > 0 ? 'waiting' : 'not_needed',
        ]
      );
      const id = ins.rows[0].id as string;

      if (direction !== 'outbound') await logCallBack(client, { id, leadId, userId: device.user_id, direction, started, seconds });

      await client.query('COMMIT');
      touched.add(leadId);
      out.push({ key, id, want_recording: seconds > 0, direction });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
  await linkPhoneCalls();
  return out;
}

/**
 * A call-back into the lead's history: tie it to one the caller logged by hand
 * ("They rang" on the call screen) if there is one, otherwise a row of its own.
 */
async function logCallBack(
  db: Db,
  c: { id: string; leadId: string; userId: string; direction: 'inbound' | 'missed'; started: Date; seconds: number }
) {
  const manual = await db.query(
    `SELECT a.id FROM lead_activities a
      WHERE a.lead_id = $1 AND a.kind = 'call' AND a.direction IN ('inbound', 'missed')
        AND a.occurred_at BETWEEN $2::timestamptz - INTERVAL '30 minutes' AND $2::timestamptz + INTERVAL '30 minutes'
        AND NOT EXISTS (SELECT 1 FROM phone_calls pc WHERE pc.activity_id = a.id)
      ORDER BY abs(extract(epoch FROM a.occurred_at - $2::timestamptz))
      LIMIT 1`,
    [c.leadId, c.started.toISOString()]
  );
  let activityId: string;
  if (manual.rows.length) {
    activityId = manual.rows[0].id;
    await db.query(
      `UPDATE lead_activities SET duration_seconds = $2, source = 'phone' WHERE id = $1`,
      [activityId, c.seconds]
    );
  } else {
    const note =
      c.direction === 'inbound'
        ? `They rang back. Answered - ${fmtTalk(c.seconds)}.`
        : 'They rang back. The call was missed.';
    const a = await db.query(
      `INSERT INTO lead_activities
         (lead_id, user_id, kind, direction, connected, duration_seconds, source, provider_call_id, note, occurred_at)
       VALUES ($1,$2,'call',$3,$4,$5,'phone',$6,$7,$8)
       ON CONFLICT (provider_call_id) WHERE provider_call_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [c.leadId, c.userId, c.direction, c.direction === 'inbound', c.seconds, `phone:${c.id}`, note, c.started.toISOString()]
    );
    activityId = a.rows[0]?.id;
  }
  if (activityId) await db.query(`UPDATE phone_calls SET activity_id = $2 WHERE id = $1`, [c.id, activityId]);

  if (c.direction === 'missed') {
    await db.query(
      `INSERT INTO lead_reminders (lead_id, title, note, occasion, due_at, lead_times, assigned_to, created_by)
       SELECT $1, 'Missed call from them - ring them back', $3, 'Missed call', $2, '{0}', $4, $4
        WHERE NOT EXISTS (
          SELECT 1 FROM lead_reminders r
           WHERE r.lead_id = $1 AND r.occasion = 'Missed call' AND r.status = 'open')`,
      [c.leadId, c.started.toISOString(), `They rang at ${atTime(c.started)} and nobody answered.`, c.userId]
    );
  }
}

/**
 * Tie the caller's own calls to the outcomes they logged, and close
 * "ring them back" reminders once the two have spoken. Run after every sync
 * and every few minutes by cron, because the outcome is often logged after
 * the phone has already reported the call.
 */
export async function linkPhoneCalls(db: Db = pool): Promise<number> {
  // Each unlinked outbound call of the last two days, to the nearest logged
  // outbound call on that lead by the same caller, from just before the call
  // started to an hour after it ended. Nearest first, each row used once.
  const r = await db.query(
    `WITH pairs AS (
       SELECT pc.id AS call_id, a.id AS activity_id,
              abs(extract(epoch FROM a.occurred_at - pc.started_at)) AS gap
         FROM phone_calls pc
         JOIN lead_activities a
           ON a.lead_id = pc.lead_id AND a.kind = 'call' AND COALESCE(a.direction, 'outbound') = 'outbound'
          AND (a.user_id = pc.user_id OR a.user_id IS NULL)
          AND a.occurred_at BETWEEN pc.started_at - INTERVAL '10 minutes'
                                AND pc.started_at + make_interval(secs => pc.duration_seconds) + INTERVAL '60 minutes'
        WHERE pc.activity_id IS NULL AND pc.direction = 'outbound'
          AND pc.started_at > NOW() - INTERVAL '2 days'
          AND NOT EXISTS (SELECT 1 FROM phone_calls x WHERE x.activity_id = a.id)
     ),
     best AS (
       SELECT DISTINCT ON (activity_id) call_id, activity_id, gap FROM pairs ORDER BY activity_id, gap
     ),
     one AS (
       SELECT DISTINCT ON (call_id) call_id, activity_id FROM best ORDER BY call_id, gap
     ),
     linked AS (
       UPDATE phone_calls pc SET activity_id = one.activity_id
         FROM one WHERE pc.id = one.call_id AND pc.activity_id IS NULL
       RETURNING pc.id, pc.activity_id, pc.duration_seconds, pc.recording_status
     )
     UPDATE lead_activities a SET
            duration_seconds = linked.duration_seconds,
            source = 'phone',
            recording_url = CASE WHEN linked.recording_status = 'uploaded'
                                 THEN '/api/app/calls/' || linked.id || '/recording' ELSE a.recording_url END
       FROM linked WHERE a.id = linked.activity_id
     RETURNING a.id`
  );

  // A "ring them back" reminder is done once they have spoken since: an
  // answered call either way, from the phone or logged on the call screen.
  await db.query(
    `UPDATE lead_reminders r SET status = 'done', completed_at = NOW(), updated_at = NOW()
      WHERE r.status = 'open' AND r.occasion = 'Missed call'
        AND (EXISTS (SELECT 1 FROM phone_calls pc
                      WHERE pc.lead_id = r.lead_id AND pc.duration_seconds > 0 AND pc.started_at > r.due_at)
          OR EXISTS (SELECT 1 FROM lead_activities a
                      WHERE a.lead_id = r.lead_id AND a.kind = 'call' AND a.connected = TRUE
                        AND a.occurred_at > r.due_at))`
  );
  return r.rowCount ?? 0;
}

/** The numbers this caller's phone should report: theirs to call, and anyone they have called. */
export async function numbersFor(userId: string): Promise<string[]> {
  const r = await pool.query(
    `WITH mine AS (
       SELECT l.phone, l.alt_phone FROM leads l WHERE l.assigned_to = $1
       UNION
       SELECT l.phone, l.alt_phone FROM leads l
        WHERE EXISTS (SELECT 1 FROM lead_activities a
                       WHERE a.lead_id = l.id AND a.user_id = $1 AND a.kind = 'call'
                         AND a.occurred_at > NOW() - INTERVAL '180 days')
       UNION
       SELECT l.phone, l.alt_phone FROM leads l
        WHERE EXISTS (SELECT 1 FROM phone_calls pc WHERE pc.lead_id = l.id AND pc.user_id = $1)
     )
     SELECT DISTINCT n FROM (
       SELECT phone AS n FROM mine
       UNION ALL
       SELECT right(regexp_replace(COALESCE(alt_phone,''), '\\D', '', 'g'), 10) FROM mine
     ) x WHERE length(n) = 10
     LIMIT 50000`,
    [userId]
  );
  return r.rows.map((x) => x.n as string);
}

/** Where a recording is kept: by year and month, so the bucket stays browsable. */
export function recordingKey(callId: string, startedAt: Date, ext: string): string {
  const y = startedAt.getUTCFullYear();
  const m = String(startedAt.getUTCMonth() + 1).padStart(2, '0');
  return `recordings/${y}/${m}/${callId}.${ext}`;
}

const EXT_BY_TYPE: Record<string, string> = {
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/amr': 'amr',
  'audio/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
};

/** A file extension for a recording: from its name when it has a sensible one, else from its type. */
export function recordingExt(name: string | null, type: string | null): string {
  const fromName = /\.([a-z0-9]{2,4})$/i.exec(name ?? '')?.[1]?.toLowerCase();
  if (fromName && ['m4a', 'mp3', 'amr', 'aac', '3gp', 'ogg', 'opus', 'wav', 'awb', 'webm', 'mp4'].includes(fromName)) return fromName;
  return EXT_BY_TYPE[String(type ?? '').toLowerCase()] ?? 'audio';
}

/** The type to play a recording back with. Browsers do not play AMR; the caller's phone does. */
export function playbackType(ext: string, stored: string | null): string {
  if (stored && stored.startsWith('audio/')) return stored;
  return (
    { m4a: 'audio/mp4', mp4: 'audio/mp4', mp3: 'audio/mpeg', amr: 'audio/amr', aac: 'audio/aac', '3gp': 'audio/3gpp', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', webm: 'audio/webm' } as Record<string, string>
  )[ext] ?? 'application/octet-stream';
}
