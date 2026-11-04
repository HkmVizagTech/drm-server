// Devotee sign-in: a WhatsApp number on the devotee list, a 6-digit code sent to it on WhatsApp,
// and the code typed back. No password. Public - there is no token yet.
//
//   POST /otp     { phone }        -> sends the code (404 with a clear message if the number is not listed)
//   POST /verify  { phone, otp }   -> { token, user } for a 'devotee' account that can reach Add record only
//
// Guards, because this is the one place that sends a WhatsApp to a number someone typed: the
// number must be on the list (nothing is sent to anybody else), one code a minute per number, a
// code lasts 10 minutes and dies after 5 wrong tries, and requests are limited per IP address.

import crypto from 'crypto';
import { Router, type Request } from 'express';
import bcrypt from 'bcryptjs';
import pool from '../db/pool';
import { generateToken } from '../middleware/auth';
import { sendOtp } from '../services/whatsappOtp';

const router = Router();

const OTP_MINUTES = 10;
const COOLDOWN_SECONDS = 60;
const MAX_ATTEMPTS = 5;

const phone10 = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(-10);

// Requests per IP, in memory: enough to stop somebody typing numbers all day. A restart clears it.
const hits = new Map<string, number[]>();
function limited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > max;
}
const ipOf = (req: Request) =>
  String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

router.post('/otp', async (req, res) => {
  const phone = phone10(req.body?.phone);
  if (phone.length !== 10) return res.status(400).json({ error: 'Enter your 10-digit WhatsApp number.' });
  if (limited(`otp:${ipOf(req)}`, 10, 15 * 60_000)) {
    return res.status(429).json({ error: 'Too many requests. Please try again in a few minutes.' });
  }
  try {
    const listed = await pool.query(`SELECT id FROM devotees WHERE phone = $1 AND active`, [phone]);
    if (!listed.rows.length) {
      return res.status(404).json({
        error: 'This number is not on the devotee list. Please contact the temple office to be added.',
        not_listed: true,
      });
    }
    const last = (await pool.query(`SELECT last_sent_at FROM devotee_otps WHERE phone = $1`, [phone])).rows[0];
    if (last) {
      const wait = COOLDOWN_SECONDS - Math.floor((Date.now() - new Date(last.last_sent_at).getTime()) / 1000);
      if (wait > 0) return res.status(429).json({ error: `Please wait ${wait}s before asking for another code.` });
    }
    const code = crypto.randomInt(100000, 1000000).toString();
    await pool.query(
      `INSERT INTO devotee_otps (phone, code_hash, expires_at, attempts, last_sent_at)
       VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval, 0, NOW())
       ON CONFLICT (phone) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at,
                                         attempts = 0, last_sent_at = NOW()`,
      [phone, await bcrypt.hash(code, 8), String(OTP_MINUTES)]
    );
    try {
      await sendOtp(phone, code);
    } catch (e) {
      // Nothing was delivered, so there is no code to keep and no minute to wait.
      await pool.query(`DELETE FROM devotee_otps WHERE phone = $1`, [phone]);
      console.error('devoteeAuth.sendOtp failed:', (e as Error).message);
      return res.status(502).json({ error: 'Could not send the code on WhatsApp right now. Please try again shortly.' });
    }
    res.json({ ok: true, message: `A code has been sent to your WhatsApp. It is valid for ${OTP_MINUTES} minutes.` });
  } catch (err) {
    console.error('devoteeAuth.otp error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/verify', async (req, res) => {
  const phone = phone10(req.body?.phone);
  const code = String(req.body?.otp ?? '').trim();
  if (phone.length !== 10 || !code) return res.status(400).json({ error: 'Enter your number and the code.' });
  if (limited(`verify:${ipOf(req)}`, 30, 15 * 60_000)) {
    return res.status(429).json({ error: 'Too many tries. Please try again in a few minutes.' });
  }
  try {
    const row = (await pool.query(`SELECT * FROM devotee_otps WHERE phone = $1`, [phone])).rows[0];
    if (!row) return res.status(400).json({ error: 'No code was asked for. Please request a new one.' });
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await pool.query(`DELETE FROM devotee_otps WHERE phone = $1`, [phone]);
      return res.status(400).json({ error: 'The code has expired. Please request a new one.' });
    }
    if (!(await bcrypt.compare(code, row.code_hash))) {
      const attempts = row.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await pool.query(`DELETE FROM devotee_otps WHERE phone = $1`, [phone]);
        return res.status(400).json({ error: 'Too many wrong codes. Please request a new one.' });
      }
      await pool.query(`UPDATE devotee_otps SET attempts = $2 WHERE phone = $1`, [phone, attempts]);
      return res.status(400).json({ error: 'That code is not right.' });
    }
    await pool.query(`DELETE FROM devotee_otps WHERE phone = $1`, [phone]);

    const dev = (await pool.query(`SELECT * FROM devotees WHERE phone = $1 AND active`, [phone])).rows[0];
    if (!dev) return res.status(403).json({ error: 'This number is not on the devotee list.' });

    // The sign-in account, made the first time and reused after. It has no usable password.
    let userId: string | null = dev.user_id;
    if (!userId) {
      const u = await pool.query(
        `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'devotee') RETURNING id`,
        [dev.name, `devotee-${phone}@devotee.drm.local`, await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 8)]
      );
      userId = u.rows[0].id as string;
      await pool.query(`UPDATE devotees SET user_id = $2, updated_at = NOW() WHERE id = $1`, [dev.id, userId]);
    }
    res.json({ token: generateToken({ userId: userId!, role: 'devotee' }), user: { id: userId, name: dev.name, role: 'devotee' } });
  } catch (err) {
    console.error('devoteeAuth.verify error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

export default router;
