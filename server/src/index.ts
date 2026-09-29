// DRM — the single deployable service.
//
// THIS FILE STARTS BOTH HALVES OF DRM. The Express API and the Next.js admin UI
// used to be two Railway services on two domains; commit 5f143fa merged them so
// Next runs inside this process (see mountClient below). Anything under /api or
// /health is answered here, everything else is handed to Next.
//
// So an "API only" version of this file is not a simplification, it is a
// regression: root package.json runs `node server/dist/index.js` and there is no
// `next start` anywhere, so dropping mountClient() deploys an API that serves no
// UI at all, and every screen 404s. If you are adding a route, add it to the
// route block below and leave the client wiring alone.

import path from 'path';
import fs from 'fs';
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
import webhooksRoutes from './routes/webhooks';
import crmRoutes from './routes/crm';
import crmReportsRoutes from './routes/crmReports';
import crmRemindersRoutes from './routes/crmReminders';
import crmLinksRoutes from './routes/crmLinks';
import crmPreachersRoutes from './routes/crmPreachers';
import crmImportRoutes from './routes/crmImport';
import filesRoutes from './routes/files';
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
const PORT = process.env.PORT || 4000;

// Where the Next.js admin UI lives, relative to the COMPILED file at
// server/dist/index.js - so server/dist/../../client = <repo root>/client.
const CLIENT_DIR = path.resolve(__dirname, '..', '..', 'client');

// Serve the admin UI from this process too?
//
// Production: yes - that is the whole point of the single service.
// Development: no - `next dev` runs on its own port with hot reload, and
// serving a stale production build alongside it just causes confusion.
// Set SERVE_CLIENT explicitly to override either way.
const SERVE_CLIENT = process.env.SERVE_CLIENT
  ? process.env.SERVE_CLIENT !== 'false'
  : process.env.NODE_ENV === 'production';

app.use(cors());
// 25mb, not the 100kb default. The office uploads its donor workbooks through
// this API - the real one is 8,569 rows across two sheets - and the default
// limit would reject them with a bare 413 that reads like the server is broken.
app.use(express.json({ limit: '25mb' }));

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

// Reading an uploaded spreadsheet, for the screens that map its columns in the
// browser. Not tied to one feature, because the point of it is that every
// upload in DRM reads a file the same way - Excel or CSV, whichever the office
// happened to save.
app.use('/api/files', filesRoutes);

// Calling (TeleCRM). Four routers on one prefix, split by how they are read
// rather than by entity: leads and the call log in crm.ts, the dashboard and
// reports in crmReports.ts, the reminder board and its alerts in
// crmReminders.ts, and the saved WhatsApp links in crmLinks.ts. The reports are
// all aggregates over the same tables, and keeping them together is what stops
// two tiles disagreeing about a definition.
//
// All of these are registered BEFORE mountClient() runs, which matters: Next is
// a catch-all, so any route added after it would never be reached.
app.use('/api/crm', crmRoutes);
app.use('/api/crm', crmReportsRoutes);
app.use('/api/crm', crmRemindersRoutes);
app.use('/api/crm', crmLinksRoutes);
app.use('/api/crm', crmPreachersRoutes);
app.use('/api/crm', crmImportRoutes);

// Inbound webhooks from hkmsite2.0-server. Mounted outside the JWT-protected
// groups above on purpose - these are server-to-server calls with no logged-in
// user, and the router enforces its own shared-secret check.
app.use('/api/webhooks', webhooksRoutes);

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

// ---------------------------------------------------------------------------
// The admin UI, served from this same process.
//
// The UI and the API used to be two Railway services on two domains. That meant
// CORS, a NEXT_PUBLIC_API_URL baked into the client at BUILD time (get it wrong
// and every request goes to the wrong host), and two deploys to keep in step.
// Now Next runs inside this Express process: anything under /api or /health is
// answered here, everything else is handed to Next.
//
// One port, one service, one origin - so the browser calls "/api/..."
// relatively and there is no cross-origin request left to misconfigure.
//
// Registration order matters. This is a catch-all: it must come AFTER every API
// route (or it would swallow them) and BEFORE the error handler (Express only
// treats a 4-argument middleware as an error handler if it is registered last).
async function mountClient(): Promise<void> {
  if (!SERVE_CLIENT) {
    console.log('[client] Not serving the admin UI from this process (SERVE_CLIENT is off).');
    return;
  }

  const buildDir = path.join(CLIENT_DIR, '.next');
  if (!fs.existsSync(buildDir)) {
    // Deliberately not fatal. A missing UI build is a deploy problem, but the
    // API and the live webhooks from the donation sites matter more than the
    // admin screens - better to keep accepting donation data and show a clear
    // message on the UI routes than to have the whole service refuse to start.
    console.error(
      `[client] No Next.js build found at ${buildDir}. The API will run, but the ` +
      `admin UI will not be served. Run "npm run build" (which builds the client ` +
      `before the server) and redeploy.`
    );
    app.use((_req, res) => {
      res
        .status(503)
        .type('text/plain')
        .send('The admin interface has not been built for this deployment. The API is running normally.');
    });
    return;
  }

  // Loaded lazily so a process started with SERVE_CLIENT=false (a dev API, or a
  // worker) never pays the cost of loading Next at all.
  const nextImport = await import('next');
  const createNextServer = (nextImport as unknown as { default: typeof import('next').default }).default;

  const nextApp = createNextServer({ dev: false, dir: CLIENT_DIR });
  await nextApp.prepare();
  const handle = nextApp.getRequestHandler();

  app.use((req, res) => {
    handle(req, res);
  });
  console.log(`[client] Serving the admin UI from ${CLIENT_DIR}`);
}

async function start(): Promise<void> {
  await mountClient();

  // Error handler - last, so it sees errors thrown by everything above.
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  });

  // Start cron jobs
  scheduleBirthdayAnniversaryCheck();

  // Bind explicitly to 0.0.0.0 - Railway's proxy connects to the container over
  // its own network interface, not loopback, so binding to the default host can
  // leave the app unreachable from the edge even though it started fine.
  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`DRM listening on 0.0.0.0:${PORT} (client ${SERVE_CLIENT ? 'served here' : 'not served'})`);
  });
}

start().catch((err) => {
  console.error('[FATAL] Failed to start:', err);
  process.exit(1);
});
