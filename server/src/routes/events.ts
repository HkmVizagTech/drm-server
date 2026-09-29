import { Router } from 'express';
import pool from '../db/pool';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// List events
router.get('/', async (req, res) => {
  const { upcoming } = req.query;
  let query = 'SELECT * FROM events';
  if (upcoming === 'true') query += " WHERE date_end >= NOW()";
  query += ' ORDER BY date_start ASC';
  const result = await pool.query(query);
  res.json(result.rows);
});

// Create event
router.post('/', async (req, res) => {
  const { name, date_start, date_end, description } = req.body;
  const result = await pool.query(
    `INSERT INTO events (name, date_start, date_end, description)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [name, date_start, date_end, description]
  );
  res.status(201).json(result.rows[0]);
});

// Get event with linked donations and bookings
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const [event, donations, bookings] = await Promise.all([
    pool.query('SELECT * FROM events WHERE id = $1', [id]),
    pool.query('SELECT SUM(amount) as total_donations, COUNT(*) as count FROM donations WHERE created_at::date BETWEEN (SELECT date_start::date FROM events WHERE id=$1) AND (SELECT date_end::date FROM events WHERE id=$1)', [id]),
    pool.query("SELECT COUNT(*) as total_bookings, SUM(slots_booked) as total_seats FROM seva_bookings WHERE event_id = $1 AND status = 'confirmed'", [id]),
  ]);

  if (!event.rows.length) return res.status(404).json({ error: 'Event not found' });
  res.json({
    event: event.rows[0],
    stats: {
      total_donations: Number(donations.rows[0].total_donations) || 0,
      donation_count: Number(donations.rows[0].count),
      total_bookings: Number(bookings.rows[0].total_bookings),
      total_seats: Number(bookings.rows[0].total_seats) || 0,
    },
  });
});

// Update event
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, date_start, date_end, description } = req.body;
  const result = await pool.query(
    `UPDATE events SET name=$1, date_start=$2, date_end=$3, description=$4 WHERE id=$5 RETURNING *`,
    [name, date_start, date_end, description, id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Event not found' });
  res.json(result.rows[0]);
});

// Delete event
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const result = await pool.query('DELETE FROM events WHERE id = $1 RETURNING id', [id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Event not found' });
  res.json({ deleted: true });
});

export default router;
