// The bell's feed - see services/notifications.ts.

import { Router } from 'express';
import pool from '../db/pool';
import { authenticate, authorize } from '../middleware/auth';
import { gaveSinceSql } from '../services/gaveSince';

const router = Router();
router.use(authenticate, authorize('admin', 'caller'));

/**
 * GET /notifications - the newest first, with how many are unread for this
 * person. A nearly-gave entry says whether they have donated since, so the
 * bell never sends somebody to ring a donor who already paid.
 */
router.get('/', async (req, res) => {
  const me = req.user?.userId ?? null;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
  try {
    const seen = (await pool.query(`SELECT seen_at FROM drm_notification_seen WHERE user_id = $1`, [me])).rows[0]?.seen_at ?? null;
    const [items, unread] = await Promise.all([
      pool.query(
        `SELECT n.id, n.kind, n.title, n.body, n.link, n.phone, n.created_at,
                -- The same rule as the Nearly gave screen: same mobile, a
                -- lead marked as donated, or the same name within a day.
                (a.id IS NOT NULL AND ${gaveSinceSql('a')}) AS paid_since,
                l.id AS lead_id,
                a.id AS attempt_id
           FROM drm_notifications n
           LEFT JOIN abandoned_attempts a
                  ON a.id = CASE WHEN n.ref_key ~ '^ng:[0-9a-f-]{36}$' THEN substring(n.ref_key FROM 4)::uuid END
           LEFT JOIN leads l ON l.phone = n.phone
          WHERE n.created_at > NOW() - INTERVAL '14 days'
          ORDER BY n.created_at DESC
          LIMIT ${limit}`
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM drm_notifications
          WHERE created_at > COALESCE($1::timestamptz, NOW() - INTERVAL '2 days')
            AND created_at > NOW() - INTERVAL '14 days'`,
        [seen]
      ),
    ]);
    res.json({ notifications: items.rows, unread: unread.rows[0].n, seen_at: seen });
  } catch (err) {
    console.error('notifications.list error:', err);
    res.json({ notifications: [], unread: 0 });
  }
});

/** POST /notifications/seen - everything up to now is read, for this person. */
router.post('/seen', async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO drm_notification_seen (user_id, seen_at) VALUES ($1, NOW())
       ON CONFLICT (user_id) DO UPDATE SET seen_at = NOW()`,
      [req.user?.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('notifications.seen error:', err);
    res.status(500).json({ error: 'Could not save.' });
  }
});

export default router;
