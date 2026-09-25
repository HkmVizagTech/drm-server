import { Router } from 'express';
import pool from '../db/pool';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// Fulfillment queue - list with filters
router.get('/', async (req, res) => {
  const { status, person_id } = req.query;
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (status) { conditions.push(`d.status = $${idx}`); values.push(status); idx++; }
  if (person_id) { conditions.push(`d.person_id = $${idx}`); values.push(person_id); idx++; }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await pool.query(
    `SELECT d.*, p.name as donor_name, p.phone as donor_phone
     FROM prasadam_deliveries d JOIN people p ON d.person_id = p.id
     ${where} ORDER BY d.created_at DESC`,
    values
  );
  res.json(result.rows);
});

// Queue a new delivery - defaults to the person's saved prasadam/home address
router.post('/', async (req, res) => {
  const { person_id, donation_id, address, notes } = req.body;

  let deliveryAddress = address;
  if (!deliveryAddress) {
    const person = await pool.query('SELECT prasadam_address, address FROM people WHERE id = $1', [person_id]);
    if (!person.rows.length) return res.status(404).json({ error: 'Person not found' });
    deliveryAddress = person.rows[0].prasadam_address || person.rows[0].address;
  }
  if (!deliveryAddress) {
    return res.status(400).json({ error: 'No delivery address on file for this person' });
  }

  const result = await pool.query(
    `INSERT INTO prasadam_deliveries (person_id, donation_id, address, notes)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [person_id, donation_id ?? null, deliveryAddress, notes ?? null]
  );
  res.status(201).json(result.rows[0]);
});

// Update status (pack / ship with tracking / deliver / return)
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { status, courier_name, tracking_number, notes } = req.body;

  const result = await pool.query(
    `UPDATE prasadam_deliveries SET
       status = COALESCE($1, status),
       courier_name = COALESCE($2, courier_name),
       tracking_number = COALESCE($3, tracking_number),
       notes = COALESCE($4, notes),
       dispatched_at = CASE WHEN $1 = 'shipped' THEN NOW() ELSE dispatched_at END,
       delivered_at = CASE WHEN $1 = 'delivered' THEN NOW() ELSE delivered_at END
     WHERE id = $5 RETURNING *`,
    [status ?? null, courier_name ?? null, tracking_number ?? null, notes ?? null, id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Delivery not found' });

  const delivery = result.rows[0];
  if (status === 'shipped' || status === 'delivered') {
    await pool.query(
      `INSERT INTO triggers (person_id, trigger_type, payload) VALUES ($1, $2, $3)`,
      [
        delivery.person_id,
        status === 'shipped' ? 'prasadam_shipped' : 'prasadam_delivered',
        JSON.stringify({ delivery_id: id, courier_name: delivery.courier_name, tracking_number: delivery.tracking_number }),
      ]
    );
  }
  res.json(delivery);
});

export default router;
