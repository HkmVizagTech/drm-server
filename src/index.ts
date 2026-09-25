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

// Diagnostic safety net: if the process is about to die, log WHY before it
// goes, so the next crash (if there is one) shows up in Railway's logs
// instead of a bare "SIGTERM" with no context.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
});
process.on('SIGTERM', () => {
  const mem = process.memoryUsage();
  console.error(
    `[SIGTERM] Received shutdown signal. Memory at time of signal: ` +
    `rss=${Math.round(mem.rss / 1024 / 1024)}MB heapUsed=${Math.round(mem.heapUsed / 1024 / 1024)}MB heapTotal=${Math.round(mem.heapTotal / 1024 / 1024)}MB`
  );
  process.exit(0);
});

const app = express();
const PORT = Number(process.env.PORT) || 4000;

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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`DRM Server running on port ${PORT}`);
});
