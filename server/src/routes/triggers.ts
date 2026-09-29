import { Router } from 'express';
import pool from '../db/pool';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// List triggers (for monitoring)
router.get('/', async (req, res) => {
  const { status, type } = req.query;
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (status) { conditions.push(`t.status = $${idx}`); values.push(status); idx++; }
  if (type) { conditions.push(`t.trigger_type = $${idx}`); values.push(type); idx++; }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await pool.query(
    `SELECT t.*, p.name as person_name, p.phone as person_phone
     FROM triggers t JOIN people p ON t.person_id = p.id
     ${where} ORDER BY t.created_at DESC LIMIT 100`,
    values
  );
  res.json(result.rows);
});

// Mark trigger as sent (called by wapi connector)
router.post('/:id/sent', async (req, res) => {
  const { id } = req.params;
  const result = await pool.query(
    "UPDATE triggers SET status = 'sent' WHERE id = $1 AND status = 'pending' RETURNING *",
    [id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Trigger not found or already processed' });
  res.json(result.rows[0]);
});

// Mark trigger as failed
router.post('/:id/failed', async (req, res) => {
  const { id } = req.params;
  const result = await pool.query(
    "UPDATE triggers SET status = 'failed' WHERE id = $1 AND status = 'pending' RETURNING *",
    [id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Trigger not found or already processed' });
  res.json(result.rows[0]);
});

export default router;
