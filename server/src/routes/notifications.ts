// The bell's feed - see services/notifications.ts.

import { Router } from 'express';
import pool from '../db/pool';
import { authenticate, authorize } from '../middleware/auth';
import { gaveSinceSql } from '../services/gaveSince';
import { FROM_DONATIONS_PAGE } from './crmLists';
import { abandonedRowsFor, adoptAbandonedRows } from './crm';

/** The attempt behind a nearly-gave notification, joined as `a`. */
const ATTEMPT_JOIN = `LEFT JOIN abandoned_attempts a
                  ON a.id = CASE WHEN n.ref_key ~ '^ng:[0-9a-f-]{36}$' THEN substring(n.ref_key FROM 4)::uuid END`;
/** Never the main site's /donations page - not this team's to chase, even if raised before that rule. */
const NOT_DONATIONS_PAGE = `NOT (a.id IS NOT NULL AND ${FROM_DONATIONS_PAGE('a')})`;

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
           ${ATTEMPT_JOIN}
           LEFT JOIN leads l ON l.phone = n.phone
          WHERE n.created_at > NOW() - INTERVAL '14 days'
            AND ${NOT_DONATIONS_PAGE}
          ORDER BY n.created_at DESC
          LIMIT ${limit}`
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM drm_notifications n
           ${ATTEMPT_JOIN}
          WHERE n.created_at > COALESCE($1::timestamptz, NOW() - INTERVAL '2 days')
            AND n.created_at > NOW() - INTERVAL '14 days'
            AND ${NOT_DONATIONS_PAGE}`,
        [seen]
      ),
    ]);
    res.json({ notifications: items.rows, unread: unread.rows[0].n, seen_at: seen });
  } catch (err) {
    console.error('notifications.list error:', err);
    res.json({ notifications: [], unread: 0 });
  }
});

/**
 * POST /notifications/:id/lead - the lead behind a Nearly gave notification,
 * for its Call and Open buttons. Their lead if they have one; otherwise they
 * are made a lead from the unfinished donation (the caller's own, as when
 * Call is pressed on Nearly gave). { paid: true } when they have donated since.
 */
router.post('/:id/lead', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: 'Not found.' });
  try {
    const n = (
      await pool.query(
        `SELECT n.kind, n.phone, a.id AS attempt_id
           FROM drm_notifications n
           ${ATTEMPT_JOIN}
          WHERE n.id = $1`,
        [req.params.id]
      )
    ).rows[0];
    if (!n || n.kind !== 'nearly_gave' || !n.phone) return res.status(404).json({ error: 'Not found.' });

    const existing = (await pool.query(`SELECT id FROM leads WHERE phone = $1`, [n.phone])).rows[0];
    if (existing) return res.json({ lead_id: existing.id });

    // Not a lead yet. Their latest unfinished donation, if the notification
    // predates the link to it.
    const attemptId =
      n.attempt_id ??
      (await pool.query(`SELECT id FROM abandoned_attempts WHERE phone = $1 ORDER BY attempted_at DESC LIMIT 1`, [n.phone]))
        .rows[0]?.id;
    if (!attemptId) return res.status(404).json({ error: 'That donation is no longer on Nearly gave.' });
    const rows = await abandonedRowsFor({ days: '365' }, [attemptId]);
    if (!rows.length) return res.status(404).json({ error: 'That donation is no longer on Nearly gave.' });
    if (rows[0].gave_anyway) return res.json({ paid: true });
    const me = req.user?.userId ?? null;
    const out = await adoptAbandonedRows(rows, {
      // A caller takes them on; an admin opening one leaves it free for the callers.
      assignTo: req.user?.role === 'caller' ? me : null,
      userId: me,
      takeParked: req.user?.role === 'caller',
    });
    if (!out.lead_ids[0]) return res.status(409).json({ error: 'They cannot be called - marked do not call.' });
    res.json({ lead_id: out.lead_ids[0], created: out.created > 0 });
  } catch (err) {
    console.error('notifications.lead error:', err);
    res.status(500).json({ error: 'Could not open them. Try again.' });
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
