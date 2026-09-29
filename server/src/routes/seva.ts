import { Router } from 'express';
import pool from '../db/pool';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// List seva types
router.get('/types', async (_req, res) => {
  const result = await pool.query('SELECT * FROM seva_types WHERE is_active = true ORDER BY name');
  res.json(result.rows);
});

// Create seva type
router.post('/types', async (req, res) => {
  const { name, description, default_max_slots } = req.body;
  const result = await pool.query(
    `INSERT INTO seva_types (name, description, default_max_slots)
     VALUES ($1, $2, $3) RETURNING *`,
    [name, description, default_max_slots || 50]
  );
  res.status(201).json(result.rows[0]);
});

// Get available slots for a seva type
router.get('/types/:id/slots', async (req, res) => {
  const { id } = req.params;
  const { date } = req.query;
  let query = 'SELECT * FROM seva_bookings WHERE seva_type = (SELECT name FROM seva_types WHERE id = $1) AND status = $2';
  const values: unknown[] = [id, 'confirmed'];

  if (date) {
    query += ` AND slot_datetime::date = $3`;
    values.push(date);
  }

  query += ' ORDER BY slot_datetime ASC';
  const result = await pool.query(query, values);
  res.json(result.rows);
});

// Book a seva slot (with overbooking prevention)
router.post('/book', async (req, res) => {
  const { person_id, seva_type, event_id, slot_datetime, slots_booked } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check capacity using a lock
    const existing = await client.query(
      `SELECT COALESCE(SUM(slots_booked), 0) as booked, max_slots
       FROM seva_bookings
       WHERE seva_type = $1 AND slot_datetime = $2 AND status = 'confirmed'
       GROUP BY max_slots`,
      [seva_type, slot_datetime]
    );

    if (existing.rows.length) {
      const { booked, max_slots } = existing.rows[0];
      if (Number(booked) + (slots_booked || 1) > Number(max_slots)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Slot is full', available: Number(max_slots) - Number(booked) });
      }
    }

    // Get default max_slots from seva_types if not provided
    const sevaType = await client.query('SELECT default_max_slots FROM seva_types WHERE name = $1', [seva_type]);
    const maxSlots = sevaType.rows.length ? sevaType.rows[0].default_max_slots : 50;

    const result = await client.query(
      `INSERT INTO seva_bookings (person_id, seva_type, event_id, slot_datetime, slots_booked, max_slots)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [person_id, seva_type, event_id, slot_datetime, slots_booked || 1, maxSlots]
    );

    // Create trigger for WhatsApp confirmation
    await client.query(
      `INSERT INTO triggers (person_id, trigger_type, payload)
       VALUES ($1, 'seva_confirmed', $2)`,
      [person_id, JSON.stringify({ seva_type, slot_datetime, slots_booked: slots_booked || 1 })]
    );

    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Cancel a booking
router.post('/cancel/:id', async (req, res) => {
  const { id } = req.params;
  const result = await pool.query(
    "UPDATE seva_bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING *",
    [id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Booking not found or already cancelled' });
  res.json(result.rows[0]);
});

export default router;
