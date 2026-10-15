// "Call from the laptop, ring from the phone."
//
// A caller at a desk works DRM on the laptop - the big screen, the keyboard,
// the outcome buttons - but the call has to go out from their own phone's SIM,
// because that is the number donors know and where the call is recorded. So
// the phone sits beside the laptop with DRM open on its Laptop dialer screen,
// and a Call click on the laptop rings from the phone.
//
// HOW THE CLICK REACHES THE PHONE
// The phone asks "anything to dial?" and the server holds the question open
// for up to 25 seconds (a long poll), answering the moment a request arrives.
// No outside service is involved, and the phone's question is also how the
// laptop knows it is there: a phone that asked in the last half minute is
// "ready". A phone with the app closed, locked, or on a call asks nothing, and
// the laptop falls back to its ordinary call link rather than sending a
// request into the void.
//
// ONLY EVER YOUR OWN PHONE
// A request is for the signed-in person and is picked up only by a phone
// linked to that same person. Nobody can make anybody else's phone ring.
//
// Everything else - the call log, the talk time, the recording - is what the
// app already does for any call it places.

import { Router } from 'express';
import { EventEmitter } from 'events';
import pool from '../db/pool';
import { authenticate } from '../middleware/auth';

const router = Router();

/** A phone that asked within this long is ready to dial. */
const READY_SECONDS = 35;
/** A request nobody picked up within this long is given up on. */
const EXPIRE_SECONDS = 20;
/** The longest the phone's question is held open. */
const MAX_WAIT_SECONDS = 25;

const isUuid = (s: unknown) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
/** The last ten digits of an Indian mobile, or null. */
const tenDigits = (v: unknown) => {
  const d = String(v ?? '').replace(/\D/g, '').slice(-10);
  return d.length === 10 ? d : null;
};

/**
 * Wakes a waiting phone the moment its person clicks Call. Within one server
 * that is instant; with several, the once-a-second check below picks it up.
 */
const wake = new EventEmitter();
wake.setMaxListeners(0);

/** The person's phone that asked most recently, if it is still ready. */
async function readyPhone(userId: string) {
  const r = await pool.query(
    `SELECT id, manufacturer, model, dialer_seen_at
       FROM app_devices
      WHERE user_id = $1 AND revoked_at IS NULL
        AND dialer_seen_at > NOW() - ($2 || ' seconds')::interval
      ORDER BY dialer_seen_at DESC LIMIT 1`,
    [userId, String(READY_SECONDS)]
  );
  return r.rows[0] ?? null;
}

const phoneName = (d: { manufacturer?: string | null; model?: string | null } | null) =>
  d ? [d.manufacturer, d.model].filter(Boolean).join(' ') || 'your phone' : null;

/**
 * GET /api/app/dialer - is my phone ready to dial for this laptop?
 * Also says whether there is a linked phone at all, so the laptop shows nothing
 * to people who have never installed the app.
 */
router.get('/dialer', authenticate, async (req, res) => {
  const me = req.user!.userId;
  try {
    const [phones, ready] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM app_devices WHERE user_id = $1 AND revoked_at IS NULL`, [me]),
      readyPhone(me),
    ]);
    res.json({
      has_phone: phones.rows[0].n > 0,
      ready: !!ready,
      phone: phoneName(ready),
      seen_at: ready?.dialer_seen_at ?? null,
    });
  } catch (err) {
    console.error('dialer.status error:', err);
    res.status(500).json({ error: 'Could not check your phone.' });
  }
});

/**
 * POST /api/app/dial { phone, lead_id? } - ring this number from my phone.
 * 409 with not_ready when no phone is on the Laptop dialer screen, so the
 * laptop can fall back to its own call link.
 */
router.post('/dial', authenticate, async (req, res) => {
  const me = req.user!.userId;
  const phone = tenDigits(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'That is not a 10-digit mobile number.' });
  const leadId = isUuid(req.body?.lead_id) ? String(req.body.lead_id) : null;
  try {
    const device = await readyPhone(me);
    if (!device) {
      return res.status(409).json({
        error: 'Your phone is not ready. Open DRM on your phone and go to Laptop dialer.',
        not_ready: true,
      });
    }
    // One at a time: a newer click replaces one the phone has not picked up.
    await pool.query(
      `UPDATE dial_requests SET done_at = NOW(), result = 'replaced'
        WHERE user_id = $1 AND picked_at IS NULL AND done_at IS NULL`,
      [me]
    );
    // Who it is, for the phone's screen ("Calling Ramesh").
    const who = await pool.query(
      `SELECT id, name FROM leads
        WHERE ($1::uuid IS NOT NULL AND id = $1::uuid)
           OR ($1::uuid IS NULL AND (right(regexp_replace(phone, '\\D', '', 'g'), 10) = $2
                                     OR right(regexp_replace(COALESCE(alt_phone, ''), '\\D', '', 'g'), 10) = $2))
        ORDER BY (id = $1::uuid) DESC NULLS LAST, updated_at DESC
        LIMIT 1`,
      [leadId, phone]
    );
    const r = await pool.query(
      `INSERT INTO dial_requests (user_id, phone, lead_id, name)
       VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [me, phone, who.rows[0]?.id ?? null, who.rows[0]?.name ?? null]
    );
    // Tidy as we go: a week of these is plenty.
    void pool
      .query(`DELETE FROM dial_requests WHERE user_id = $1 AND created_at < NOW() - INTERVAL '7 days'`, [me])
      .catch(() => undefined);
    wake.emit(me);
    res.status(201).json({ id: r.rows[0].id, phone: phoneName(device) });
  } catch (err) {
    console.error('dialer.dial error:', err);
    res.status(500).json({ error: 'Could not send the call to your phone.' });
  }
});

/** Where a request has got to, in words the laptop shows. */
function stateOf(r: {
  picked_at: Date | null;
  done_at: Date | null;
  result: string | null;
  created_at: Date;
}): 'waiting' | 'ringing' | 'placed' | 'failed' | 'expired' | 'replaced' {
  if (r.result === 'placed') return 'placed';
  if (r.result === 'failed') return 'failed';
  if (r.result === 'replaced') return 'replaced';
  if (r.picked_at) {
    // Picked up but never reported back: treat as placed once it is old - the
    // phone may have gone straight into the call.
    return Date.now() - new Date(r.picked_at).getTime() > 15_000 ? 'placed' : 'ringing';
  }
  if (Date.now() - new Date(r.created_at).getTime() > EXPIRE_SECONDS * 1000) return 'expired';
  return 'waiting';
}

/** GET /api/app/dial/:id - how the laptop follows its click. */
router.get('/dial/:id', authenticate, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Not found.' });
  try {
    const r = await pool.query(
      `SELECT id, phone, name, created_at, picked_at, done_at, result, error
         FROM dial_requests WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user!.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found.' });
    const row = r.rows[0];
    res.json({ id: row.id, state: stateOf(row), error: row.error ?? null });
  } catch (err) {
    console.error('dialer.state error:', err);
    res.status(500).json({ error: 'Could not check the call.' });
  }
});

/**
 * GET /api/app/dial-next?device_id=&wait=25 - the phone asks for its next call.
 *
 * Held open until a request arrives or `wait` seconds pass. Every ask also
 * marks the phone as ready, which is what the laptop's "Phone ready" reads.
 */
router.get('/dial-next', authenticate, async (req, res) => {
  const me = req.user!.userId;
  const deviceId = String(req.query.device_id ?? '');
  if (!isUuid(deviceId)) return res.status(400).json({ error: 'This phone is not linked yet.' });
  const wait = Math.max(0, Math.min(MAX_WAIT_SECONDS, Number(req.query.wait) || 0)) * 1000;

  try {
    const own = await pool.query(
      `UPDATE app_devices SET dialer_seen_at = NOW()
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
      [deviceId, me]
    );
    if (!own.rows.length) return res.status(403).json({ error: 'This phone is linked to somebody else. Sign in again.' });
  } catch (err) {
    console.error('dialer.next error:', err);
    return res.status(500).json({ error: 'Could not reach DRM.' });
  }

  let closed = false;
  req.on('close', () => {
    closed = true;
  });
  const until = Date.now() + wait;
  let lastSeen = Date.now();

  const take = async () => {
    const r = await pool.query(
      `UPDATE dial_requests SET picked_at = NOW(), device_id = $2
        WHERE id = (SELECT id FROM dial_requests
                     WHERE user_id = $1 AND picked_at IS NULL AND done_at IS NULL
                       AND created_at > NOW() - ($3 || ' seconds')::interval
                     ORDER BY created_at DESC LIMIT 1
                     FOR UPDATE SKIP LOCKED)
        RETURNING id, phone, lead_id, name`,
      [me, deviceId, String(EXPIRE_SECONDS)]
    );
    return r.rows[0] ?? null;
  };

  try {
    for (;;) {
      const got = await take();
      if (got) return res.json({ request: got });
      if (closed || Date.now() >= until) return closed ? undefined : res.json({ request: null });
      // Still here: keep "ready" fresh while the question is held open.
      if (Date.now() - lastSeen > 10_000) {
        lastSeen = Date.now();
        await pool.query(`UPDATE app_devices SET dialer_seen_at = NOW() WHERE id = $1`, [deviceId]);
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t);
          wake.off(me, done);
          resolve();
        };
        const t = setTimeout(done, Math.min(1000, Math.max(0, until - Date.now())));
        wake.on(me, done);
      });
    }
  } catch (err) {
    console.error('dialer.next error:', err);
    if (!closed && !res.headersSent) res.status(500).json({ error: 'Could not reach DRM.' });
  }
});

/** POST /api/app/dial/:id/result { placed, error? } - the phone says how it went. */
router.post('/dial/:id/result', authenticate, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Not found.' });
  const placed = req.body?.placed === true;
  const error = placed ? null : String(req.body?.error ?? 'The phone could not place the call.').slice(0, 300);
  try {
    const r = await pool.query(
      `UPDATE dial_requests SET done_at = NOW(), result = $3, error = $4
        WHERE id = $1 AND user_id = $2 AND done_at IS NULL RETURNING id`,
      [req.params.id, req.user!.userId, placed ? 'placed' : 'failed', error]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('dialer.result error:', err);
    res.status(500).json({ error: 'Could not save that.' });
  }
});

export default router;
