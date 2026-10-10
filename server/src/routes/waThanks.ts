// WhatsApp thanks - the admin screen behind services/waThanks.ts.

import { Router } from 'express';
import pool from '../db/pool';
import { authenticate, authorize } from '../middleware/auth';
import { APP_TIMEZONE } from '../bootTimezone';
import {
  campaignKey,
  cleanThanksSettings,
  gupshupConfigured,
  pagePattern,
  readThanksSettings,
  saveThanksSettings,
  sendThanks,
  thanksTick,
} from '../services/waThanks';

const router = Router();
router.use(authenticate, authorize('admin'));

/** GET /wa-thanks - settings, counts and everyone on the list. */
router.get('/', async (_req, res) => {
  try {
    const s = await readThanksSettings();
    const key = campaignKey(s);
    const [counts, rows, matching] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'waiting')::int AS waiting,
                COUNT(*) FILTER (WHERE status = 'sending')::int AS sending,
                COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
                COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
                COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
                MIN(send_at) FILTER (WHERE status = 'waiting') AS next_at
           FROM wa_thanks_sends WHERE campaign = $1`,
        [key]
      ),
      pool.query(
        `SELECT id, phone, name, amount, donated_at, seva, seva_text, send_at, status, error, sent_at, attempts
           FROM wa_thanks_sends WHERE campaign = $1
          ORDER BY CASE status WHEN 'failed' THEN 0 WHEN 'sending' THEN 1 WHEN 'waiting' THEN 2 WHEN 'sent' THEN 3 ELSE 4 END,
                   send_at NULLS LAST, donated_at
          LIMIT 1000`,
        [key]
      ),
      // How many campaign donations DRM holds for the day, queued or not -
      // so "nothing is happening" can be told apart from "nobody donated yet".
      pool.query(
        `SELECT COUNT(*)::int AS donations, COUNT(DISTINCT p.phone)::int AS people, COALESCE(SUM(d.amount), 0)::numeric AS amount
           FROM donations d JOIN people p ON p.id = d.person_id
          WHERE d.source_site = 'hkmv' AND COALESCE(d.source_page, '') ~* $1
            AND (d.created_at AT TIME ZONE '${APP_TIMEZONE}')::date = $2::date`,
        [pagePattern(s.page), s.day]
      ),
    ]);
    // The day's donations on the page by seva - so a seva the page offers that
    // is missing from the list (a name changed on the site) shows up at once.
    const bySeva = await pool.query(
      `SELECT COALESCE(NULLIF(btrim(d.occasion), ''), d.purpose, 'none recorded') AS seva,
              COUNT(DISTINCT p.phone)::int AS people
         FROM donations d JOIN people p ON p.id = d.person_id
        WHERE d.source_site = 'hkmv' AND COALESCE(d.source_page, '') ~* $1
          AND (d.created_at AT TIME ZONE '${APP_TIMEZONE}')::date = $2::date
        GROUP BY 1 ORDER BY 2 DESC`,
      [pagePattern(s.page), s.day]
    );
    res.json({
      settings: s,
      gupshup_ready: gupshupConfigured(),
      counts: counts.rows[0],
      today: { ...matching.rows[0], amount: Number(matching.rows[0].amount) },
      by_seva: bySeva.rows,
      rows: rows.rows,
    });
  } catch (err) {
    console.error('waThanks.get error:', err);
    res.status(500).json({ error: 'Could not load.' });
  }
});

/** PUT /wa-thanks - change the settings (or just switch on/off). */
router.put('/', async (req, res) => {
  try {
    const current = await readThanksSettings();
    const next = cleanThanksSettings(req.body ?? {}, current);
    if (typeof next === 'string') return res.status(400).json({ error: next });
    await saveThanksSettings(next, req.user?.userId ?? null);
    // Switched on: queue straight away rather than in two minutes.
    if (next.enabled) void thanksTick().catch((e) => console.error('[wa-thanks] tick:', (e as Error).message));
    res.json({ settings: next });
  } catch (err) {
    console.error('waThanks.put error:', err);
    res.status(500).json({ error: 'Could not save.' });
  }
});

/** POST /wa-thanks/test { phone, name? } - the real message, to one number, now. */
router.post('/test', async (req, res) => {
  const phone = String(req.body?.phone ?? '').replace(/\D/g, '').slice(-10);
  if (!/^[6-9]\d{9}$/.test(phone)) return res.status(400).json({ error: 'Enter a 10-digit mobile number.' });
  try {
    const s = await readThanksSettings();
    if (!s.template_id) return res.status(400).json({ error: 'Add the Gupshup template id first.' });
    // The words for the seva asked for, else the first seva being thanked.
    const asked = String(req.body?.seva ?? '').toLowerCase();
    const choice = s.sevas.find((x) => x.name.toLowerCase() === asked) ?? s.sevas.find((x) => x.on) ?? s.sevas[0];
    if (!choice) return res.status(400).json({ error: 'Add a seva first.' });
    const r = await sendThanks(s, {
      phone,
      name: String(req.body?.name ?? '').trim() || 'Devotee',
      amount: Number(req.body?.amount) > 0 ? Number(req.body.amount) : 1100,
      sevaText: choice.text,
      sevaName: choice.name,
    });
    if (!r.ok) return res.status(502).json({ error: r.error });
    res.json({ ok: true, message_id: r.messageId, seva: choice.name });
  } catch (err) {
    console.error('waThanks.test error:', err);
    res.status(500).json({ error: 'Could not send.' });
  }
});

/** POST /wa-thanks/:id/retry - put a failed one back in the queue, due now. */
router.post('/:id/retry', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: 'Not found.' });
  try {
    const r = await pool.query(
      `UPDATE wa_thanks_sends SET status = 'waiting', send_at = NOW(), error = NULL
        WHERE id = $1 AND status IN ('failed', 'skipped') AND seva_text IS NOT NULL RETURNING id`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found.' });
    void thanksTick().catch(() => undefined);
    res.json({ ok: true });
  } catch (err) {
    console.error('waThanks.retry error:', err);
    res.status(500).json({ error: 'Could not retry.' });
  }
});

export default router;
