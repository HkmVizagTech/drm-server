// EVERY CALL, ONCE.
//
// "Calls made" used to be the calls saved on the call screen (and the
// incoming and missed calls the phone app turns into such entries). Two kinds
// of real work never reached it:
//
//   - a call dialled on the phone that nobody saved an outcome for - the DRM
//     app saw it (phone_calls) but there was no entry on the call screen;
//   - a Sankalpam call, which has its own log (sankalpam_calls).
//
// CALL_EVENTS is all of them as one list, with the same columns everywhere
// (user_id, lead_id, occurred_at, direction, connected, duration_seconds,
// source, disposition, label, recording_url, via), so every total in DRM - the
// overview, the leaderboard, the caller report, the timeline, the call report,
// the team page - counts the same calls.
//
// NOTHING TWICE
//   - A phone call is left out once it is linked to a saved call
//     (phone_calls.activity_id), and also BEFORE the link is made, if a saved
//     call on that lead by that caller sits in the window the linker uses
//     (services/phoneCalls.ts linkPhoneCalls) and has not been taken by
//     another phone call. So the total does not jump while the link catches up.
//   - A phone call to a Sankalpam donor's number that the caller also logged
//     as a Sankalpam call, in the same window, is counted once (as Sankalpam).
//
// `via` says where a row came from: 'drm' (saved in DRM), 'phone' (seen only
// by the phone app), 'sankalpam'.

/** The phone_calls window a saved call must fall in to be the same call. */
const SAME_CALL = (pc: string, at: string) => `${at} BETWEEN ${pc}.started_at - INTERVAL '10 minutes'
  AND ${pc}.started_at + make_interval(secs => ${pc}.duration_seconds) + INTERVAL '60 minutes'`;

export const CALL_EVENTS = `(
  SELECT a.user_id, a.lead_id, a.occurred_at,
         COALESCE(a.direction, 'outbound')::text AS direction,
         COALESCE(a.connected, FALSE) AS connected,
         a.duration_seconds, a.source::text AS source, a.disposition::text AS disposition,
         NULL::text AS label, a.recording_url::text AS recording_url, 'drm'::text AS via
    FROM lead_activities a
   WHERE a.kind = 'call'

  UNION ALL

  SELECT pc.user_id, pc.lead_id, pc.started_at,
         pc.direction::text, pc.duration_seconds > 0,
         pc.duration_seconds, 'phone'::text, NULL::text,
         'Not saved in DRM'::text,
         CASE WHEN pc.recording_status = 'uploaded' THEN 'phone' END,
         'phone'::text
    FROM phone_calls pc
   WHERE pc.activity_id IS NULL
     AND NOT (pc.direction = 'outbound' AND pc.lead_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM lead_activities x
            WHERE x.lead_id = pc.lead_id AND x.kind = 'call'
              AND COALESCE(x.direction, 'outbound') = 'outbound'
              AND (x.user_id = pc.user_id OR x.user_id IS NULL)
              AND ${SAME_CALL('pc', 'x.occurred_at')}
              AND NOT EXISTS (SELECT 1 FROM phone_calls y WHERE y.activity_id = x.id)))
     AND NOT (pc.direction = 'outbound' AND EXISTS (
           SELECT 1 FROM sankalpam_calls sx JOIN sankalpam_donors sd ON sd.id = sx.donor_id
            WHERE sx.called_by = pc.user_id
              AND (sd.phone = pc.phone OR sd.alt_phone = pc.phone)
              AND ${SAME_CALL('pc', 'sx.called_at')}))

  UNION ALL

  SELECT sc.called_by, NULL::uuid, sc.called_at,
         'outbound'::text, sc.outcome NOT IN ('no_answer', 'busy'),
         NULL::int, 'manual'::text, NULL::text,
         'Sankalpam call'::text, NULL::text, 'sankalpam'::text
    FROM sankalpam_calls sc
)`;

/**
 * The breakdown that goes beside a total, over CALL_EVENTS rows aliased `a`:
 * how many were incoming, missed, Sankalpam, and dialled but not saved.
 */
export const CALL_BREAKDOWN = (a: string) => `
  COUNT(*) FILTER (WHERE ${a}.direction = 'outbound' AND ${a}.via <> 'sankalpam')::int AS outgoing,
  COUNT(*) FILTER (WHERE ${a}.direction = 'inbound')::int AS incoming,
  COUNT(*) FILTER (WHERE ${a}.direction = 'missed')::int AS missed,
  COUNT(*) FILTER (WHERE ${a}.via = 'sankalpam')::int AS sankalpam,
  COUNT(*) FILTER (WHERE ${a}.via = 'phone')::int AS not_saved`;
