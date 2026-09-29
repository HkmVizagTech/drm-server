import { Router } from 'express';
import pool from '../db/pool';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// List subscriptions with filters
router.get('/', async (req, res) => {
  const { status, person_id, page = '1', limit = '50' } = req.query;
  const offset = (Number(page) - 1) * Number(limit);
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (status) { conditions.push(`s.status = $${idx}`); values.push(status); idx++; }
  if (person_id) { conditions.push(`s.person_id = $${idx}`); values.push(person_id); idx++; }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(Number(limit), offset);

  const [data, count] = await Promise.all([
    pool.query(
      `SELECT s.*, p.name as donor_name, p.phone as donor_phone
       FROM subscriptions s JOIN people p ON s.person_id = p.id
       ${where} ORDER BY s.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      values
    ),
    pool.query(`SELECT COUNT(*) FROM subscriptions s ${where}`, values.slice(0, -2)),
  ]);

  res.json({ subscriptions: data.rows, total: Number(count.rows[0].count) });
});

// Create a subscription
router.post('/', async (req, res) => {
  const { person_id, amount, frequency, purpose, start_date, next_charge_date, gateway_subscription_id } = req.body;
  const result = await pool.query(
    `INSERT INTO subscriptions (person_id, amount, frequency, purpose, start_date, next_charge_date, gateway_subscription_id)
     VALUES ($1, $2, $3, $4, COALESCE($5, CURRENT_DATE), $6, $7) RETURNING *`,
    [
      person_id,
      amount,
      frequency || 'monthly',
      purpose || 'general',
      start_date ?? null,
      next_charge_date ?? null,
      gateway_subscription_id ?? null,
    ]
  );
  res.status(201).json(result.rows[0]);
});

// Get one subscription with its full charge history
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const [sub, donations] = await Promise.all([
    pool.query(
      `SELECT s.*, p.name as donor_name, p.phone as donor_phone
       FROM subscriptions s JOIN people p ON s.person_id = p.id WHERE s.id = $1`,
      [id]
    ),
    pool.query('SELECT * FROM donations WHERE subscription_id = $1 ORDER BY created_at DESC', [id]),
  ]);
  if (!sub.rows.length) return res.status(404).json({ error: 'Subscription not found' });
  res.json({ subscription: sub.rows[0], charges: donations.rows });
});

// Update status (pause/resume/cancel) and/or schedule
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { status, amount, frequency, next_charge_date } = req.body;
  const result = await pool.query(
    `UPDATE subscriptions SET
       status = COALESCE($1, status),
       amount = COALESCE($2, amount),
       frequency = COALESCE($3, frequency),
       next_charge_date = COALESCE($4, next_charge_date),
       updated_at = NOW()
     WHERE id = $5 RETURNING *`,
    [status ?? null, amount ?? null, frequency ?? null, next_charge_date ?? null, id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Subscription not found' });
  res.json(result.rows[0]);
});

// Record a successful charge for this cycle -> creates a linked donation row
router.post('/:id/charge', async (req, res) => {
  const { id } = req.params;
  const { payment_mode, source, next_charge_date } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sub = await client.query('SELECT * FROM subscriptions WHERE id = $1', [id]);
    if (!sub.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Subscription not found' });
    }
    const s = sub.rows[0];
    const donation = await client.query(
      `INSERT INTO donations (person_id, amount, type, purpose, payment_mode, source, subscription_id)
       VALUES ($1, $2, 'recurring', $3, $4, $5, $6) RETURNING *`,
      [s.person_id, s.amount, s.purpose, payment_mode || 'upi', source || 'website', id]
    );
    await client.query(
      `UPDATE subscriptions SET next_charge_date = $1, updated_at = NOW() WHERE id = $2`,
      [next_charge_date ?? null, id]
    );
    await client.query('COMMIT');
    res.status(201).json(donation.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Record a failed charge -> writes a trigger so WhatsApp can nudge the donor
router.post('/:id/failed', async (req, res) => {
  const { id } = req.params;
  const sub = await pool.query('SELECT * FROM subscriptions WHERE id = $1', [id]);
  if (!sub.rows.length) return res.status(404).json({ error: 'Subscription not found' });
  const s = sub.rows[0];
  await pool.query(
    `INSERT INTO triggers (person_id, trigger_type, payload) VALUES ($1, 'subscription_payment_failed', $2)`,
    [s.person_id, JSON.stringify({ subscription_id: id, amount: s.amount, purpose: s.purpose })]
  );
  res.json({ recorded: true });
});

export default router;
