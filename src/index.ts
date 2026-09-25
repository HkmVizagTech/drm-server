import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pool from './db/pool';
import authRoutes from './routes/auth';
import peopleRoutes from './routes/people';
import donationsRoutes from './routes/donations';
import sevaRoutes from './routes/seva';
import eventsRoutes from './routes/events';
import triggersRoutes from './routes/triggers';
import reportsRoutes from './routes/reports';
import subscriptionsRoutes from './routes/subscriptions';
import prasadamRoutes from './routes/prasadam';
import { scheduleBirthdayAnniversaryCheck } from './utils/cron';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/people', peopleRoutes);
app.use('/api/donations', donationsRoutes);
app.use('/api/seva', sevaRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/triggers', triggersRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/subscriptions', subscriptionsRoutes);
app.use('/api/prasadam', prasadamRoutes);

// Public donor lookup API (used by the live donation site - no auth, rate limited)
app.get('/api/people/lookup', async (req, res) => {
  const { phone } = req.query;
  if (!phone || typeof phone !== 'string') {
    return res.status(400).json({ error: 'Phone number required' });
  }

  const result = await pool.query(
    'SELECT id, name, phone, email, address, pan FROM people WHERE phone = $1',
    [phone.replace(/\s+/g, '').replace(/^\+91/, '')]
  );

  if (!result.rows.length) return res.json({ found: false });
  res.json({ found: true, person: result.rows[0] });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Start cron jobs
scheduleBirthdayAnniversaryCheck();

app.listen(PORT, () => {
  console.log(`DRM Server running on port ${PORT}`);
});
