import { Router } from 'express';
import pool from '../db/pool';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// Donation summary by period
router.get('/donations/period', async (req, res) => {
  const { period = 'month', purpose } = req.query;
  let groupBy: string;
  switch (period) {
    case 'day': groupBy = "date_trunc('day', created_at)"; break;
    case 'year': groupBy = "date_trunc('year', created_at)"; break;
    default: groupBy = "date_trunc('month', created_at)";
  }

  let query = `SELECT ${groupBy} as period, purpose, SUM(amount) as total, COUNT(*) as count
               FROM donations`;
  const values: unknown[] = [];
  if (purpose) {
    query += ' WHERE purpose = $1';
    values.push(purpose);
  }
  query += ` GROUP BY ${groupBy}, purpose ORDER BY period DESC`;
  const result = await pool.query(query, values);
  res.json(result.rows);
});

// Top donors
router.get('/donors/top', async (req, res) => {
  const { limit = '10', period } = req.query;
  let query = `SELECT p.id, p.name, p.phone, SUM(d.amount) as total_donated, COUNT(d.id) as donation_count
               FROM people p JOIN donations d ON p.id = d.person_id`;
  const values: unknown[] = [];
  if (period) {
    query += ` WHERE d.created_at >= NOW() - INTERVAL '${period} months'`;
  }
  query += ' GROUP BY p.id ORDER BY total_donated DESC LIMIT $1';
  values.push(Number(limit));
  const result = await pool.query(query, values);
  res.json(result.rows);
});

// People count by role
router.get('/people/roles', async (_req, res) => {
  const result = await pool.query(`
    SELECT unnest(roles) as role, COUNT(*) as count
    FROM people
    GROUP BY role
    ORDER BY count DESC
  `);
  res.json(result.rows);
});

// Seva booking stats
router.get('/seva/summary', async (_req, res) => {
  const result = await pool.query(`
    SELECT seva_type,
           SUM(CASE WHEN status = 'confirmed' THEN slots_booked ELSE 0 END) as booked,
           COUNT(CASE WHEN status = 'confirmed' THEN 1 END) as booking_count,
           COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled_count
    FROM seva_bookings
    GROUP BY seva_type
  `);
  res.json(result.rows);
});

// Dashboard overview
router.get('/dashboard', async (_req, res) => {
  const [totalPeople, totalDonations, upcomingEvents, pendingTriggers] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM people'),
    pool.query('SELECT SUM(amount) as total, COUNT(*) as count FROM donations'),
    pool.query("SELECT COUNT(*) FROM events WHERE date_end >= NOW()"),
    pool.query("SELECT COUNT(*) FROM triggers WHERE status = 'pending'"),
  ]);

  res.json({
    totalPeople: Number(totalPeople.rows[0].count),
    totalDonations: { total: Number(totalDonations.rows[0].total) || 0, count: Number(totalDonations.rows[0].count) },
    upcomingEvents: Number(upcomingEvents.rows[0].count),
    pendingTriggers: Number(pendingTriggers.rows[0].count),
  });
});

export default router;
