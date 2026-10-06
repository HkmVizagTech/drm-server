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

// FIRST, AND IT HAS TO STAY FIRST. Sets the process timezone to IST before any
// other module is evaluated - see bootTimezone.ts for why the position matters.
import './bootTimezone';
import { istDate } from './bootTimezone';

import path from 'path';
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pool, { verifyTimezone } from './db/pool';
import authRoutes from './routes/auth';
import peopleRoutes from './routes/people';
import donationsRoutes from './routes/donations';
import sevaRoutes from './routes/seva';
import eventsRoutes from './routes/events';
import triggersRoutes from './routes/triggers';
import reportsRoutes from './routes/reports';
import subscriptionsRoutes from './routes/subscriptions';
import prasadamRoutes from './routes/prasadam';
import webhooksRoutes, { siteAuth } from './routes/webhooks';
import crmRoutes from './routes/crm';
import crmReportsRoutes from './routes/crmReports';
import crmRemindersRoutes from './routes/crmReminders';
import crmLinksRoutes from './routes/crmLinks';
import crmPreachersRoutes from './routes/crmPreachers';
import crmImportRoutes from './routes/crmImport';
import crmListsRoutes from './routes/crmLists';
import crmSessionsRoutes from './routes/crmSessions';
import crmCallsRoutes from './routes/crmCalls';
import crmCollectionsRoutes from './routes/crmCollections';
import sankalpamRoutes from './routes/sankalpam';
import crmQrRoutes, { webhookRouter as razorpayWebhook } from './routes/crmQr';
import profilesRoutes from './routes/profiles';
import filesRoutes from './routes/files';
import { denyRole, readOnlyFor } from './middleware/auth';
import { scheduleBirthdayAnniversaryCheck } from './utils/cron';
import { runMigrations, setMigrationResult, getMigrationResult } from './db/migrate';

dotenv.config();

/** Filled at boot by verifyTimezone(); surfaced on /health. */
let timezoneCheck: { ok: boolean; actual: string } | null = null;

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
app.use(
  express.json({
    limit: '25mb',
    // Keep the bytes exactly as they arrived, for the Razorpay webhook.
    // Its signature is an HMAC over the raw body, and verifying against
    // re-serialised JSON fails on key order and number formatting alone -
    // which looks like a wrong secret and is very hard to diagnose.
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = buf;
    },
  })
);

// Health check
app.get('/health', (_req, res) => {
  // The migration outcome is here on purpose. A deploy whose schema did not
  // apply looks perfectly healthy from the outside and then fails on the first
  // request that needs a new column - which is how a sign-in page started
  // answering 500 with nothing obviously wrong. This makes it visible without
  // having to reproduce it.
  const schema = getMigrationResult();
  const timeOk = timezoneCheck?.ok !== false;
  res.json({
    status: (schema && !schema.ok) || !timeOk ? 'degraded' : 'ok',
    schema: schema
      ? { applied: schema.ok, ms: schema.ms, ...(schema.error ? { error: schema.error } : {}) }
      : { applied: null },
    // Both halves, because they are set in different places and either one
    // being wrong puts every date in the product out by hours.
    time: {
      process: process.env.TZ ?? '(unset)',
      database: timezoneCheck?.actual ?? '(not checked yet)',
      ok: timeOk,
      now: istDate(),
    },
    timestamp: new Date().toISOString(),
  });
});

// Routes
app.use('/api/auth', authRoutes);
// A caller may open People and Donations to look a donor up, and may not
// change anything there. Enforced here, ahead of the routers, rather than on
// each handler: a guard you have to remember to add to the next endpoint is a
// guard that will be missing from it.
// A donor lookup for the two donation sites, so their forms can recognise a
// returning donor by phone.
//
// WHAT THIS REPLACED, AND WHY IT HAD TO GO
// There used to be an `app.get('/api/people/lookup')` further down this file,
// commented "no auth, rate limited". It had neither. It returned name, email,
// address and PAN for any phone number to anyone who asked, and the only thing
// standing between that and the open internet was an accident of ordering:
// registered AFTER the people router, so `/api/people/:id` matched "lookup"
// first and swallowed it. Moving one line would have published donors' PAN
// numbers - and meanwhile the sites' lookups were simply broken, because they
// were hitting `/:id` with an id of "lookup".
//
// So it is mounted ahead of the router where it actually works, authenticated
// with the same per-site shared secret the webhooks use, and it no longer
// returns PAN: a donation form needs to greet somebody by name and prefill an
// address, not read their tax identifier.
app.get('/api/people/lookup', siteAuth, async (req, res) => {
  const phone = String(req.query.phone ?? '').replace(/\D/g, '').slice(-10);
  if (phone.length !== 10) return res.status(400).json({ error: 'A 10-digit phone number is required' });

  try {
    const result = await pool.query(
      `SELECT id, name, phone, email, address, address_door, address_house, address_street,
              address_area, address_city, address_state, address_pincode, address_country
         FROM people
        WHERE right(regexp_replace(phone, '\\D', '', 'g'), 10) = $1
        LIMIT 1`,
      [phone]
    );
    if (!result.rows.length) return res.json({ found: false });
    res.json({ found: true, person: result.rows[0] });
  } catch (err) {
    console.error('people.lookup error:', err);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

app.use('/api/people', readOnlyFor('caller'), peopleRoutes);
// Reconciling who a donor is across DRM, HKMV and annadan. Its own prefix
// rather than another /api/people route, because it acts on the sites as much
// as on DRM and a caller has no business running a sweep.
app.use('/api/profiles', denyRole('caller'), profilesRoutes);
app.use('/api/donations', readOnlyFor('caller'), donationsRoutes);
app.use('/api/seva', denyRole('caller'), sevaRoutes);
app.use('/api/events', denyRole('caller'), eventsRoutes);
app.use('/api/triggers', denyRole('caller'), triggersRoutes);
app.use('/api/reports', denyRole('caller'), reportsRoutes);
app.use('/api/subscriptions', denyRole('caller'), subscriptionsRoutes);
app.use('/api/prasadam', denyRole('caller'), prasadamRoutes);

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
app.use('/api/crm', crmListsRoutes);
app.use('/api/crm', crmSessionsRoutes);
app.use('/api/crm', crmCallsRoutes);
app.use('/api/crm', crmQrRoutes);
// Money a caller collected on a UPI number that no system watched arrive.
app.use('/api/crm', crmCollectionsRoutes);
// Sankalpam: the puja on a donor's special day, every year, and the video sent to them.
app.use('/api/sankalpam', sankalpamRoutes);

// Razorpay's QR payment webhook. Mounted here, ahead of the JWT-protected
// groups and outside /api/crm, because Razorpay has no token and because a
// router-level authenticate() inside crmRoutes would refuse it before it ever
// reached its handler. It verifies its own HMAC signature instead.
// Its own prefix rather than a path under /api/webhooks: a router mounted
// on a parent prefix runs its middleware for every path beneath it, so
// sharing a prefix with another router is how this endpoint quietly starts
// answering 401 or 503 to Razorpay instead of accepting a payment.
app.use('/api/razorpay', razorpayWebhook);

// Inbound webhooks from hkmsite2.0-server. Mounted outside the JWT-protected
// groups above on purpose - these are server-to-server calls with no logged-in
// user, and the router enforces its own shared-secret check.
app.use('/api/webhooks', webhooksRoutes);



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
  // BEFORE anything is served.
  //
  // The alternative - deploy the code, remember to run schema.sql - failed
  // exactly once and took every sign-in with it: the new code wrote a column
  // the live database did not have, so nobody could log in, including the
  // people who would have run the migration. An instruction is not a
  // mechanism. schema.sql is additive and idempotent, so applying it on every
  // boot is a no-op when there is nothing to do.
  //
  // A failure here does not stop the app. A database that is briefly
  // unreachable at boot must not turn into a site that refuses to start at
  // all - and whatever is wrong, serving the parts that still work beats
  // serving nothing. It is logged loudly and shows on /health.
  setMigrationResult(await runMigrations());

  // Checked, not assumed. The failure mode is reports that are five and a half
  // hours out and look entirely plausible, so it has to be loud at boot rather
  // than discovered in a month-end figure that nobody can reconcile.
  timezoneCheck = await verifyTimezone().catch((e) => ({
    ok: false,
    actual: `(could not read: ${(e as Error).message})`,
  }));

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
