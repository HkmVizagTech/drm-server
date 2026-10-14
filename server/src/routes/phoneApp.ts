// The Android app's side of DRM: linking a phone, reporting its calls,
// uploading recordings, and playing them back.
//
// TWO KINDS OF SIGN-IN
//   - Linking a phone (POST /devices) uses the caller's ordinary login, from
//     DRM opened inside the app. It returns a key for that phone.
//   - Everything the app does in the background - reporting calls, uploading
//     recordings - is signed with that key (X-Device-Key), because the login
//     token lasts a day and a donor's call-back at 9 pm must still be saved.
//     The key is stored hashed; an admin can sign a phone out on the Phones page.
//
// PRIVACY
// The app only reports calls to and from the numbers GET /numbers gives it -
// the caller's leads and the people they have called. Their personal calls
// stay on the phone. Recordings are served only through DRM, to admins,
// coordinators and the caller who made the call, and every listen is logged.

import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import crypto from 'crypto';
import pool from '../db/pool';
import { authenticate, authorize, generateToken } from '../middleware/auth';
import * as storage from '../services/storage';
import {
  linkPhoneCalls,
  numbersFor,
  playbackType,
  recordCalls,
  recordingExt,
  recordingKey,
  type ReportedCall,
} from '../services/phoneCalls';

const router = Router();

/** Who may hear any recording. Everybody else hears only their own calls. */
const REVIEWERS = ['admin', 'volunteer_coordinator'];

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const str = (v: unknown, max: number) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.slice(0, max) : null;
};
const isUuid = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

interface DeviceReq extends Request {
  device?: { id: string; user_id: string };
}

/** The app's background calls: signed with the phone's own key. */
async function deviceAuth(req: DeviceReq, res: Response, next: NextFunction) {
  const key = String(req.headers['x-device-key'] ?? '');
  if (key.length < 32) return res.status(401).json({ error: 'This phone is not linked.' });
  try {
    const r = await pool.query(
      `SELECT d.id, d.user_id FROM app_devices d JOIN users u ON u.id = d.user_id
        WHERE d.key_hash = $1 AND d.revoked_at IS NULL AND u.active`,
      [sha256(key)]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'This phone is signed out. Open DRM in the app to link it again.' });
    req.device = r.rows[0];
    next();
  } catch (err) {
    console.error('phoneApp.deviceAuth error:', err);
    res.status(500).json({ error: 'Could not check this phone.' });
  }
}

/* ------------------------------------------------------------- linking */

/** POST /api/app/devices - link this phone to the signed-in caller. Returns its key. */
router.post('/devices', authenticate, async (req, res) => {
  const b = req.body ?? {};
  const installId = str(b.install_id, 64);
  if (!installId || installId.length < 8) return res.status(400).json({ error: 'Missing install id.' });
  const key = crypto.randomBytes(32).toString('hex');
  try {
    const r = await pool.query(
      `INSERT INTO app_devices (install_id, user_id, key_hash, manufacturer, model, android_version, app_version, dialer)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (install_id) DO UPDATE SET
         user_id = EXCLUDED.user_id, key_hash = EXCLUDED.key_hash,
         manufacturer = EXCLUDED.manufacturer, model = EXCLUDED.model,
         android_version = EXCLUDED.android_version, app_version = EXCLUDED.app_version,
         dialer = EXCLUDED.dialer, revoked_at = NULL, updated_at = NOW()
       RETURNING id`,
      [
        installId,
        req.user!.userId,
        sha256(key),
        str(b.manufacturer, 60),
        str(b.model, 80),
        str(b.android_version, 20),
        str(b.app_version, 20),
        str(b.dialer, 120),
      ]
    );
    res.json({ device_id: r.rows[0].id, device_key: key, user_id: req.user!.userId });
  } catch (err) {
    console.error('phoneApp.link error:', err);
    res.status(500).json({ error: 'Could not link this phone.' });
  }
});

/**
 * POST /api/app/session - a fresh login for whoever this phone is linked to.
 *
 * WHY: the login lives in the WebView's storage, and Android does not always
 * write that to disk before the app is closed - so callers were asked to sign
 * in again every time they opened the app. The phone's own key is kept safely
 * by the app, so the app asks for a login with it instead. An admin signing
 * the phone out on the Phones page, or the caller being deactivated, ends this.
 */
router.post('/session', deviceAuth, async (req: DeviceReq, res) => {
  try {
    const u = await pool.query(`SELECT id, name, email, role FROM users WHERE id = $1 AND active`, [req.device!.user_id]);
    if (!u.rows.length) return res.status(401).json({ error: 'This phone is signed out.' });
    const user = u.rows[0];
    await pool.query(`UPDATE app_devices SET last_sync_at = NOW() WHERE id = $1`, [req.device!.id]);
    res.json({ token: generateToken({ userId: user.id, role: user.role }), user });
  } catch (err) {
    console.error('phoneApp.session error:', err);
    res.status(500).json({ error: 'Could not sign in.' });
  }
});

/** POST /api/app/sign-out - the caller signed out in the app: this phone's key stops working. */
router.post('/sign-out', deviceAuth, async (req: DeviceReq, res) => {
  try {
    await pool.query(`UPDATE app_devices SET revoked_at = NOW(), updated_at = NOW() WHERE id = $1`, [req.device!.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('phoneApp.signOut error:', err);
    res.status(500).json({ error: 'Could not sign out.' });
  }
});

/* -------------------------------------------------- the app, in background */

/** GET /api/app/numbers - the numbers this phone should report calls for. */
router.get('/numbers', deviceAuth, async (req: DeviceReq, res) => {
  try {
    const numbers = await numbersFor(req.device!.user_id);
    res.json({ numbers });
  } catch (err) {
    console.error('phoneApp.numbers error:', err);
    res.status(500).json({ error: 'Could not load numbers.' });
  }
});

/** POST /api/app/status - what the phone may do, and how its last sync went. */
router.post('/status', deviceAuth, async (req: DeviceReq, res) => {
  const b = req.body ?? {};
  const status = typeof b.status === 'object' && b.status ? b.status : {};
  try {
    await pool.query(
      `UPDATE app_devices SET status = $2::jsonb, last_sync_at = NOW(), last_error = $3,
              app_version = COALESCE($4, app_version), dialer = COALESCE($5, dialer),
              recordings_folder = COALESCE($6, recordings_folder), updated_at = NOW()
        WHERE id = $1`,
      [
        req.device!.id,
        JSON.stringify(status).slice(0, 4000),
        str(b.last_error, 1000),
        str(b.app_version, 20),
        str(b.dialer, 120),
        str(b.recordings_folder, 200),
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('phoneApp.status error:', err);
    res.status(500).json({ error: 'Could not save.' });
  }
});

/** POST /api/app/calls { calls: [...] } - the calls the phone saw since its last sync. */
router.post('/calls', deviceAuth, async (req: DeviceReq, res) => {
  const calls = Array.isArray(req.body?.calls) ? (req.body.calls as ReportedCall[]).slice(0, 200) : [];
  try {
    const results = await recordCalls(req.device!, calls);
    await pool.query(`UPDATE app_devices SET last_sync_at = NOW() WHERE id = $1`, [req.device!.id]);
    res.json({ results });
  } catch (err) {
    console.error('phoneApp.calls error:', err);
    res.status(500).json({ error: 'Could not save the calls.' });
  }
});

/**
 * POST /api/app/calls/:id/recording - the recording file itself, as the body.
 * Headers: Content-Type, X-File-Name. Up to 60 MB (about an hour of audio).
 */
router.post(
  '/calls/:id/recording',
  deviceAuth,
  express.raw({ type: () => true, limit: '60mb' }),
  async (req: DeviceReq, res) => {
    if (!isUuid(String(req.params.id))) return res.status(404).json({ error: 'Not found.' });
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length < 512) return res.status(400).json({ error: 'The file is empty.' });
    if (!storage.isConfigured()) return res.status(503).json({ error: 'Recording storage is not set up yet.' });
    try {
      const c = await pool.query(
        `SELECT id, started_at, recording_status, activity_id FROM phone_calls WHERE id = $1 AND device_id = $2`,
        [String(req.params.id), req.device!.id]
      );
      if (!c.rows.length) return res.status(404).json({ error: 'Not found.' });
      if (c.rows[0].recording_status === 'uploaded') return res.json({ ok: true, already: true });

      const name = str(decodeURIComponent(String(req.headers['x-file-name'] ?? '')), 200);
      const type = str(String(req.headers['content-type'] ?? ''), 80);
      const ext = recordingExt(name, type);
      const key = recordingKey(c.rows[0].id, new Date(c.rows[0].started_at), ext);
      const put = await storage.putObject(key, body, playbackType(ext, type));
      if (!put.ok) return res.status(503).json({ error: 'Could not store the recording. It will be tried again.' });

      await pool.query(
        `UPDATE phone_calls SET recording_status = 'uploaded', recording_key = $2, recording_type = $3,
                recording_bytes = $4, recording_name = $5, recording_at = NOW()
          WHERE id = $1`,
        [c.rows[0].id, key, playbackType(ext, type), body.length, name]
      );
      if (c.rows[0].activity_id) {
        await pool.query(`UPDATE lead_activities SET recording_url = $2 WHERE id = $1`, [
          c.rows[0].activity_id,
          `/api/app/calls/${c.rows[0].id}/recording`,
        ]);
      }
      // Where this phone keeps its recordings, for the Phones page.
      const folder = str(req.headers['x-file-folder'] as string | undefined, 200);
      if (folder) await pool.query(`UPDATE app_devices SET recordings_folder = $2 WHERE id = $1`, [req.device!.id, folder]);
      res.json({ ok: true });
    } catch (err) {
      console.error('phoneApp.upload error:', err);
      res.status(500).json({ error: 'Could not save the recording.' });
    }
  }
);

/** POST /api/app/calls/:id/no-recording - the phone looked and there was none. */
router.post('/calls/:id/no-recording', deviceAuth, async (req: DeviceReq, res) => {
  if (!isUuid(String(req.params.id))) return res.status(404).json({ error: 'Not found.' });
  try {
    await pool.query(
      `UPDATE phone_calls SET recording_status = 'none' WHERE id = $1 AND device_id = $2 AND recording_status = 'waiting'`,
      [String(req.params.id), req.device!.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('phoneApp.noRecording error:', err);
    res.status(500).json({ error: 'Could not save.' });
  }
});

/* ------------------------------------------------------- for the screens */

/* --------------------------------------------- the recordings list and a call */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Who may open the calls list at all. A caller sees only their own calls. */
const LIST_ROLES = ['admin', 'volunteer_coordinator', 'caller'] as const;

const CALL_ROW = `
  pc.id, pc.direction, pc.phone, pc.started_at, pc.duration_seconds, pc.from_app,
  pc.recording_status, pc.recording_bytes, pc.user_id, u.name AS caller_name,
  pc.lead_id, l.name AS lead_name, l.phone AS lead_phone,
  a.disposition, d.label AS disposition_label, a.note AS outcome_note,
  dv.model AS phone_model, dv.manufacturer AS phone_maker`;
const CALL_FROM = `
  FROM phone_calls pc
  LEFT JOIN users u ON u.id = pc.user_id
  LEFT JOIN leads l ON l.id = pc.lead_id
  LEFT JOIN lead_activities a ON a.id = pc.activity_id
  LEFT JOIN crm_dispositions d ON d.slug = a.disposition
  LEFT JOIN app_devices dv ON dv.id = pc.device_id`;

/**
 * GET /api/app/calls - every call the phones saw, newest first, with totals.
 * ?from=&to= (Indian days) &user_id= (admins; "all" or one caller)
 * &direction=outbound|inbound|missed &recording=uploaded|none|waiting
 * &search= (name or number) &page= &limit=
 */
router.get('/calls', authenticate, authorize(...LIST_ROLES), async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const reviewer = REVIEWERS.includes(req.user!.role);
  const values: unknown[] = [];
  const p = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  const conds: string[] = [];
  if (!reviewer) conds.push(`pc.user_id = ${p(req.user!.userId)}::uuid`);
  else if (q.user_id && q.user_id !== 'all' && isUuid(q.user_id)) conds.push(`pc.user_id = ${p(q.user_id)}::uuid`);
  if (q.from && DATE_RE.test(q.from)) conds.push(`pc.started_at >= ${p(q.from)}::date`);
  if (q.to && DATE_RE.test(q.to)) conds.push(`pc.started_at < ${p(q.to)}::date + INTERVAL '1 day'`);
  if (q.direction && ['outbound', 'inbound', 'missed'].includes(q.direction)) conds.push(`pc.direction = ${p(q.direction)}`);
  if (q.recording === 'uploaded' || q.recording === 'none' || q.recording === 'waiting') {
    conds.push(`pc.recording_status = ${p(q.recording)}`);
  }
  if (q.answered === 'true') conds.push(`pc.duration_seconds > 0`);
  const term = String(q.search ?? '').trim().slice(0, 80);
  if (term) {
    const digits = term.replace(/\D/g, '');
    if (digits.length >= 4) conds.push(`pc.phone LIKE ${p(`%${digits.slice(-10)}%`)}`);
    else conds.push(`l.name ILIKE ${p(`%${term}%`)}`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 50));
  const page = Math.max(1, Number(q.page) || 1);
  try {
    const [rows, totals] = await Promise.all([
      pool.query(
        `SELECT ${CALL_ROW},
                (pc.recording_status = 'uploaded' AND (${p(reviewer)}::boolean OR pc.user_id = ${p(req.user!.userId)}::uuid)) AS can_listen
           ${CALL_FROM} ${where}
          ORDER BY pc.started_at DESC
          LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        values
      ),
      pool.query(
        `SELECT COUNT(*)::int AS calls,
                COUNT(*) FILTER (WHERE pc.direction = 'outbound')::int AS outbound,
                COUNT(*) FILTER (WHERE pc.direction = 'outbound' AND pc.duration_seconds > 0)::int AS answered_out,
                COUNT(*) FILTER (WHERE pc.direction = 'inbound')::int AS inbound,
                COUNT(*) FILTER (WHERE pc.direction = 'missed')::int AS missed,
                COALESCE(SUM(pc.duration_seconds), 0)::int AS talk_seconds,
                COUNT(*) FILTER (WHERE pc.duration_seconds > 0)::int AS spoke,
                COUNT(*) FILTER (WHERE pc.recording_status = 'uploaded')::int AS recorded,
                COUNT(*) FILTER (WHERE pc.recording_status = 'waiting')::int AS waiting,
                COUNT(*) FILTER (WHERE pc.recording_status = 'none')::int AS no_recording
           ${CALL_FROM} ${where}`,
        values.slice(0, values.length - 2)
      ),
    ]);
    res.json({ calls: rows.rows, totals: totals.rows[0], page, limit });
  } catch (err) {
    console.error('phoneApp.list error:', err);
    res.status(500).json({ error: 'Could not load calls.' });
  }
});

/** GET /api/app/calls/:id - one call: who, when, what was said, the recording, who listened. */
router.get('/calls/:id', authenticate, authorize(...LIST_ROLES), async (req, res) => {
  const id = String(req.params.id);
  if (!isUuid(id)) return res.status(404).json({ error: 'Not found.' });
  const reviewer = REVIEWERS.includes(req.user!.role);
  try {
    const r = await pool.query(
      `SELECT ${CALL_ROW},
              pc.recording_type, pc.recording_name, pc.recording_at, pc.sim, pc.activity_id,
              a.connected AS outcome_connected, a.occurred_at AS outcome_at,
              l.status AS lead_status, st.label AS lead_status_label, l.alt_phone AS lead_alt_phone,
              l.converted_at, l.converted_amount, owner.name AS lead_owner_name
         ${CALL_FROM}
         LEFT JOIN crm_statuses st ON st.slug = l.status
         LEFT JOIN users owner ON owner.id = l.assigned_to
        WHERE pc.id = $1`,
      [id]
    );
    const call = r.rows[0];
    if (!call || (!reviewer && call.user_id !== req.user!.userId)) return res.status(404).json({ error: 'Not found.' });
    const [listens, others] = await Promise.all([
      reviewer
        ? pool.query(
            `SELECT rl.listened_at, u.name FROM recording_listens rl LEFT JOIN users u ON u.id = rl.user_id
              WHERE rl.call_id = $1 ORDER BY rl.listened_at DESC LIMIT 20`,
            [id]
          )
        : Promise.resolve({ rows: [] }),
      call.lead_id
        ? pool.query(
            `SELECT pc.id, pc.direction, pc.started_at, pc.duration_seconds, pc.recording_status, u.name AS caller_name
               FROM phone_calls pc LEFT JOIN users u ON u.id = pc.user_id
              WHERE pc.lead_id = $1 AND pc.id <> $2 AND ($3::boolean OR pc.user_id = $4::uuid)
              ORDER BY pc.started_at DESC LIMIT 10`,
            [call.lead_id, id, reviewer, req.user!.userId]
          )
        : Promise.resolve({ rows: [] }),
    ]);
    res.json({
      call: { ...call, can_listen: call.recording_status === 'uploaded' },
      listens: listens.rows,
      other_calls: others.rows,
    });
  } catch (err) {
    console.error('phoneApp.detail error:', err);
    res.status(500).json({ error: 'Could not load the call.' });
  }
});

/** GET /api/app/calls/:id/recording - play a recording (logged). */
router.get('/calls/:id/recording', authenticate, async (req, res) => {
  if (!isUuid(String(req.params.id))) return res.status(404).json({ error: 'Not found.' });
  try {
    const c = await pool.query(
      `SELECT id, user_id, recording_key, recording_type FROM phone_calls WHERE id = $1 AND recording_status = 'uploaded'`,
      [String(req.params.id)]
    );
    const call = c.rows[0];
    if (!call) return res.status(404).json({ error: 'No recording for this call.' });
    if (!REVIEWERS.includes(req.user!.role) && call.user_id !== req.user!.userId) {
      return res.status(403).json({ error: 'Only the caller who made this call, or an admin, can listen to it.' });
    }
    const file = await storage.getObject(call.recording_key);
    if (!file) return res.status(404).json({ error: 'The recording could not be fetched. Try again.' });

    // Logged once per listen, not once per seek.
    const range = String(req.headers.range ?? '');
    if (!range || /^bytes=0-/.test(range)) {
      await pool.query(`INSERT INTO recording_listens (call_id, user_id) VALUES ($1, $2)`, [call.id, req.user!.userId]);
    }

    res.setHeader('Content-Type', call.recording_type || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, no-store');
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] || m[2])) {
      const size = file.length;
      let start = m[1] ? Number(m[1]) : size - Number(m[2]);
      let end = m[1] && m[2] ? Number(m[2]) : size - 1;
      start = Math.max(0, start);
      end = Math.min(size - 1, end);
      if (start > end) return res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
      res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      return res.end(file.subarray(start, end + 1));
    }
    res.setHeader('Content-Length', String(file.length));
    res.end(file);
  } catch (err) {
    console.error('phoneApp.play error:', err);
    res.status(500).json({ error: 'Could not play.' });
  }
});

/** GET /api/app/leads/:id/calls - this lead's calls as the phones saw them. */
router.get('/leads/:id/calls', authenticate, async (req, res) => {
  if (!isUuid(String(req.params.id))) return res.status(404).json({ error: 'Not found.' });
  try {
    await linkPhoneCalls();
    const r = await pool.query(
      `SELECT ${CALL_ROW},
              (pc.recording_status = 'uploaded' AND ($2 OR pc.user_id = $3)) AS can_listen
         ${CALL_FROM}
        WHERE pc.lead_id = $1
        ORDER BY pc.started_at DESC
        LIMIT 100`,
      [String(req.params.id), REVIEWERS.includes(req.user!.role), req.user!.userId]
    );
    res.json({ calls: r.rows });
  } catch (err) {
    console.error('phoneApp.leadCalls error:', err);
    res.status(500).json({ error: 'Could not load calls.' });
  }
});

/** GET /api/app/devices - every linked phone, how it is doing, and its last 7 days. */
router.get('/devices', authenticate, authorize('admin', 'volunteer_coordinator'), async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT d.id, d.user_id, u.name AS user_name, d.manufacturer, d.model, d.android_version, d.app_version,
              d.dialer, d.status, d.recordings_folder, d.last_sync_at, d.last_error, d.revoked_at, d.created_at,
              COALESCE(s.outbound, 0) AS outbound, COALESCE(s.answered_out, 0) AS answered_out,
              COALESCE(s.inbound, 0) AS inbound, COALESCE(s.missed, 0) AS missed,
              COALESCE(s.talk_seconds, 0) AS talk_seconds,
              COALESCE(s.recorded, 0) AS recorded, COALESCE(s.needs_recording, 0) AS needs_recording,
              COALESCE(s.no_recording, 0) AS no_recording, COALESCE(s.waiting, 0) AS waiting,
              COALESCE(s.no_outcome, 0) AS no_outcome
         FROM app_devices d
         JOIN users u ON u.id = d.user_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE pc.direction = 'outbound')::int AS outbound,
                  COUNT(*) FILTER (WHERE pc.direction = 'outbound' AND pc.duration_seconds > 0)::int AS answered_out,
                  COUNT(*) FILTER (WHERE pc.direction = 'inbound')::int AS inbound,
                  COUNT(*) FILTER (WHERE pc.direction = 'missed')::int AS missed,
                  COALESCE(SUM(pc.duration_seconds), 0)::int AS talk_seconds,
                  COUNT(*) FILTER (WHERE pc.recording_status = 'uploaded')::int AS recorded,
                  COUNT(*) FILTER (WHERE pc.duration_seconds > 0)::int AS needs_recording,
                  COUNT(*) FILTER (WHERE pc.recording_status = 'none')::int AS no_recording,
                  COUNT(*) FILTER (WHERE pc.recording_status = 'waiting')::int AS waiting,
                  COUNT(*) FILTER (WHERE pc.direction = 'outbound' AND pc.activity_id IS NULL
                                     AND pc.started_at < NOW() - INTERVAL '1 hour')::int AS no_outcome
             FROM phone_calls pc
            WHERE pc.device_id = d.id AND pc.started_at > NOW() - INTERVAL '7 days'
         ) s ON TRUE
        ORDER BY d.revoked_at IS NOT NULL, d.last_sync_at DESC NULLS LAST`
    );
    res.json({ devices: r.rows, storage_ready: storage.isConfigured() });
  } catch (err) {
    console.error('phoneApp.devices error:', err);
    res.status(500).json({ error: 'Could not load phones.' });
  }
});

/** DELETE /api/app/devices/:id - sign a phone out. Its key stops working at once. */
router.delete('/devices/:id', authenticate, authorize('admin'), async (req, res) => {
  if (!isUuid(String(req.params.id))) return res.status(404).json({ error: 'Not found.' });
  try {
    const r = await pool.query(
      `UPDATE app_devices SET revoked_at = NOW(), updated_at = NOW() WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
      [String(req.params.id)]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('phoneApp.revoke error:', err);
    res.status(500).json({ error: 'Could not sign the phone out.' });
  }
});

export default router;
