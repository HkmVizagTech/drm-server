import { Router } from 'express';
import pool from '../db/pool';
import { authenticate, authorize } from '../middleware/auth';
import { fetchDonorSnapshot, fetchDonorPage, fetchTransactionPage, configuredSites, SITE_KEYS, SiteKey, isSiteConfigured, SITE_IMPORT_MODE } from '../services/hkmvClient';
import { upsertDonorSnapshot, upsertTransactionBatch } from '../services/hkmvSync';

const router = Router();
router.use(authenticate);

// Sort options are whitelisted rather than interpolated from the query string -
// ORDER BY can't be parameterised, so accepting raw input here would be a SQL
// injection hole.
const PEOPLE_SORTS: Record<string, string> = {
  recent: 'p.created_at DESC',
  name: 'p.name ASC',
  lifetime: 'lifetime_total DESC NULLS LAST',
  donations: 'donation_count DESC',
  last_gift: 'last_donation_at DESC NULLS LAST',
};

// List people with filters, giving aggregates and pagination.
//
// The aggregates are the answer to "one phone number, many donations": people
// are keyed by phone, so every gift that donor ever made rolls up to the single
// person row - this endpoint surfaces how many and how much, so the list can
// show it without N+1 follow-up requests.
router.get('/', async (req, res) => {
  const { role, search, sort = 'recent' } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (role) {
    conditions.push(`$${idx} = ANY(p.roles)`);
    values.push(role);
    idx++;
  }
  if (search) {
    conditions.push(`(p.name ILIKE $${idx} OR p.phone ILIKE $${idx} OR p.email ILIKE $${idx})`);
    values.push(`%${search}%`);
    idx++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderBy = PEOPLE_SORTS[String(sort)] || PEOPLE_SORTS.recent;

  const [data, count] = await Promise.all([
    pool.query(
      `SELECT p.*,
              COALESCE(g.donation_count, 0)  AS donation_count,
              COALESCE(g.lifetime_total, 0)  AS lifetime_total,
              g.last_donation_at,
              COALESCE(s.active_subscriptions, 0) AS active_subscriptions
       FROM people p
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS donation_count,
                SUM(amount) AS lifetime_total,
                MAX(created_at) AS last_donation_at
         FROM donations WHERE person_id = p.id
       ) g ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS active_subscriptions
         FROM subscriptions WHERE person_id = p.id AND status = 'active'
       ) s ON TRUE
       ${where}
       ORDER BY ${orderBy}
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, limit, offset]
    ),
    pool.query(`SELECT COUNT(*) FROM people p ${where}`, values),
  ]);

  const total = Number(count.rows[0].count);

  res.json({
    people: data.rows.map((r) => ({
      ...r,
      donation_count: Number(r.donation_count),
      lifetime_total: Number(r.lifetime_total),
      active_subscriptions: Number(r.active_subscriptions),
    })),
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  });
});

// Which donation sites this server can import from.
//
// Registered BEFORE the '/:id' route below - Express matches in order, so
// '/import-sites' would otherwise be captured as a person id and 404 while
// looking like a database problem.
router.get('/import-sites', async (_req, res) => {
  res.json({
    sites: configuredSites().map((s) => ({ key: s.key, label: s.label, mode: SITE_IMPORT_MODE[s.key] })),
    unconfigured: SITE_KEYS.filter((k) => !isSiteConfigured(k)),
  });
});

// Get person by id (with donation history)
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const [person, donations] = await Promise.all([
    pool.query('SELECT * FROM people WHERE id = $1', [id]),
    pool.query('SELECT * FROM donations WHERE person_id = $1 ORDER BY created_at DESC', [id]),
  ]);

  if (!person.rows.length) return res.status(404).json({ error: 'Person not found' });
  res.json({ person: person.rows[0], donations: donations.rows });
});

// Full donor 360 profile - giving history, subscriptions, prasadam deliveries, staff notes
router.get('/:id/profile', async (req, res) => {
  const { id } = req.params;
  const [person, donations, subscriptions, deliveries, notes, yearly] = await Promise.all([
    pool.query('SELECT * FROM people WHERE id = $1', [id]),
    pool.query('SELECT * FROM donations WHERE person_id = $1 ORDER BY created_at DESC', [id]),
    pool.query('SELECT * FROM subscriptions WHERE person_id = $1 ORDER BY created_at DESC', [id]),
    pool.query('SELECT * FROM prasadam_deliveries WHERE person_id = $1 ORDER BY created_at DESC', [id]),
    pool.query(
      `SELECT n.*, u.name as author_name FROM person_notes n
       LEFT JOIN users u ON n.author_user_id = u.id
       WHERE n.person_id = $1 ORDER BY n.created_at DESC`,
      [id]
    ),
    pool.query(
      `SELECT date_trunc('year', created_at) as year, SUM(amount) as total, COUNT(*) as count
       FROM donations WHERE person_id = $1 GROUP BY year ORDER BY year DESC`,
      [id]
    ),
  ]);

  if (!person.rows.length) return res.status(404).json({ error: 'Person not found' });

  const lifetimeTotal = donations.rows.reduce((sum, d) => sum + Number(d.amount), 0);

  res.json({
    person: person.rows[0],
    donations: donations.rows,
    subscriptions: subscriptions.rows,
    prasadam_deliveries: deliveries.rows,
    notes: notes.rows,
    lifetime: { total: lifetimeTotal, by_year: yearly.rows },
  });
});

// Staff notes on a person (lightweight CRM log, not a full audit trail)
router.get('/:id/notes', async (req, res) => {
  const { id } = req.params;
  const result = await pool.query(
    `SELECT n.*, u.name as author_name FROM person_notes n
     LEFT JOIN users u ON n.author_user_id = u.id
     WHERE n.person_id = $1 ORDER BY n.created_at DESC`,
    [id]
  );
  res.json(result.rows);
});

router.post('/:id/notes', async (req, res) => {
  const { id } = req.params;
  const { note } = req.body;
  if (!note || !String(note).trim()) return res.status(400).json({ error: 'Note text is required' });

  const result = await pool.query(
    `INSERT INTO person_notes (person_id, author_user_id, note) VALUES ($1, $2, $3) RETURNING *`,
    [id, req.user!.userId, String(note).trim()]
  );

  const withAuthor = await pool.query(
    `SELECT n.*, u.name as author_name FROM person_notes n
     LEFT JOIN users u ON n.author_user_id = u.id WHERE n.id = $1`,
    [result.rows[0].id]
  );
  res.status(201).json(withAuthor.rows[0]);
});

// Create person
router.post('/', async (req, res) => {
  const { name, phone, email, address, pan, roles, date_of_birth, anniversary_date, prasadam_address } = req.body;
  const result = await pool.query(
    `INSERT INTO people (name, phone, email, address, pan, roles, date_of_birth, anniversary_date, prasadam_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [name, phone, email, address, pan, roles || [], date_of_birth, anniversary_date, prasadam_address ?? null]
  );
  res.status(201).json(result.rows[0]);
});

// Update person
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, phone, email, address, pan, roles, date_of_birth, anniversary_date, prasadam_address } = req.body;
  const result = await pool.query(
    `UPDATE people SET name=$1, phone=$2, email=$3, address=$4, pan=$5, roles=$6,
     date_of_birth=$7, anniversary_date=$8, prasadam_address=$9, updated_at=NOW() WHERE id=$10 RETURNING *`,
    [name, phone, email, address, pan, roles, date_of_birth, anniversary_date, prasadam_address ?? null, id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Person not found' });
  res.json(result.rows[0]);
});

// Delete person
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const result = await pool.query('DELETE FROM people WHERE id = $1 RETURNING id', [id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Person not found' });
  res.json({ deleted: true });
});

// Pull the latest donor identity, donations, subscriptions and prasadam
// status in from hkmsite2.0 (the live donor portal) and upsert them here.
// Matched by external_ref, so re-running this is always safe - nothing
// duplicates, it just refreshes what changed since the last sync.
router.post('/:id/sync-hkmv', async (req, res) => {
  const { id } = req.params;
  const personResult = await pool.query('SELECT phone FROM people WHERE id = $1', [id]);
  if (!personResult.rows.length) return res.status(404).json({ error: 'Person not found' });
  const person = personResult.rows[0];

  const sites = configuredSites();
  if (!sites.length) {
    return res.status(503).json({ error: 'No donation site is configured to sync from.' });
  }

  // The same phone number can exist on BOTH sites, so sync every configured
  // one rather than stopping at the first hit. A site being down must not
  // block the site that is up, so failures are collected and reported.
  const results: Record<string, unknown> = {};
  const errors: { site: string; error: string }[] = [];
  let matched = 0;

  for (const site of sites) {
    try {
      const snapshot = await fetchDonorSnapshot(site.key, person.phone);
      if (!snapshot.found || !snapshot.donor) {
        results[site.key] = { found: false };
        continue;
      }
      const counts = await upsertDonorSnapshot(snapshot, site.key);
      results[site.key] = { found: true, ...counts };
      matched++;
    } catch (err) {
      errors.push({ site: site.key, error: (err as Error).message });
    }
  }

  if (!matched && errors.length === sites.length) {
    return res.status(502).json({ error: `Could not reach any donation site: ${errors[0].error}`, errors });
  }
  if (!matched) {
    return res.status(404).json({ error: 'No matching donor found on any site for this phone number', errors });
  }

  res.json({ synced: true, sites: results, errors });
});

// Bulk backfill: pull EVERY donor from hkmsite2.0 into DRM. This is what
// populates an empty DRM database, and it's safe to re-run at any time -
// the same external_ref upserts make it a catch-up, not a duplicate import.
//
// Runs synchronously and reports totals when finished. Pages are fetched
// sequentially rather than in parallel so a large import doesn't hammer the
// live donation site while real donors are using it.
//
// One donor failing (bad data, missing mobile) is recorded and skipped rather
// than aborting the whole import - a single malformed record shouldn't cost
// you the other several thousand.
router.post('/import-hkmv', authorize('admin'), async (req, res) => {
  const pageSize = Math.min(500, Math.max(1, Number(req.body?.pageSize) || 100));
  const maxPages = Number(req.body?.maxPages) || Infinity;

  const requested = req.body?.site as SiteKey | undefined;
  const sites = requested
    ? (isSiteConfigured(requested) ? [requested] : [])
    : configuredSites().map((s) => s.key);

  if (!sites.length) {
    return res.status(503).json({
      error: requested
        ? `Site "${requested}" is not configured on this server.`
        : 'No donation site is configured to import from.',
      configured: SITE_KEYS.filter(isSiteConfigured),
    });
  }

  const totals = {
    donorsProcessed: 0,
    peopleCreated: 0,
    donationsSynced: 0,
    subscriptionsSynced: 0,
    deliveriesSynced: 0,
  };
  const perSite: Record<string, { mode: string; totalRecords: number; donorsProcessed: number; failureCount: number; error?: string }> = {};
  // Distinct people across the whole import. A donor whose transactions span a
  // page boundary is upserted once per page, so counting upserts would report
  // more donors than exist.
  const uniqueDonors = new Set<string>();
  const failures: Array<{ site: string; mobile?: string; name?: string; error: string }> = [];

  for (const siteKey of sites) {
    const mode = SITE_IMPORT_MODE[siteKey];
    const siteTotals = { mode, totalRecords: 0, donorsProcessed: 0, failureCount: 0 };

    try {
      if (mode === 'transactions') {
        // Sites that store transactions hand over flat rows; DRM groups them
        // by normalised phone. Cursor-paged so the source database only ever
        // does an indexed range scan, never an aggregation over everything.
        let cursor: string | null = null;
        let pages = 0;

        for (;;) {
          const feed = await fetchTransactionPage(siteKey, cursor, pageSize);
          siteTotals.totalRecords = feed.total;

          const batch = await upsertTransactionBatch(feed.transactions, siteKey);
          for (const m of batch.mobiles || []) uniqueDonors.add(`${siteKey}:${m}`);
          siteTotals.donorsProcessed = uniqueDonors.size;
          totals.peopleCreated += batch.peopleCreated;
          totals.donationsSynced += batch.donationsSynced;
          totals.subscriptionsSynced += batch.subscriptionsSynced;
          totals.deliveriesSynced += batch.deliveriesSynced;
          siteTotals.failureCount += batch.failures.length;
          for (const f of batch.failures) failures.push({ site: siteKey, ...f });

          pages++;
          if (!feed.hasMore || !feed.nextCursor || pages >= maxPages) break;
          cursor = feed.nextCursor;
        }
      } else {
        // Sites with a real donor collection page by donor directly.
        let page = 1;
        let hasMore = true;

        while (hasMore && page <= maxPages) {
          const result = await fetchDonorPage(siteKey, page, Math.min(200, pageSize));
          siteTotals.totalRecords = result.total;

          for (const snapshot of result.donors) {
            try {
              const counts = await upsertDonorSnapshot(snapshot, siteKey);
              uniqueDonors.add(`${siteKey}:${snapshot.donor?.mobile}`);
              siteTotals.donorsProcessed++;
              if (counts.created) totals.peopleCreated++;
              totals.donationsSynced += counts.donationsSynced;
              totals.subscriptionsSynced += counts.subscriptionsSynced;
              totals.deliveriesSynced += counts.deliveriesSynced;
            } catch (err) {
              siteTotals.failureCount++;
              failures.push({
                site: siteKey,
                mobile: snapshot.donor?.mobile,
                name: snapshot.donor?.name,
                error: (err as Error).message,
              });
            }
          }

          hasMore = result.hasMore;
          page++;
        }
      }

      perSite[siteKey] = siteTotals;
    } catch (err) {
      // A site being unreachable stops THAT site only; whatever already
      // imported stays put, since each donor commits its own transaction.
      perSite[siteKey] = { ...siteTotals, error: (err as Error).message };
    }
  }

  totals.donorsProcessed = uniqueDonors.size;

  res.json({
    imported: true,
    sites: perSite,
    totalDonorsOnHkmv: Object.values(perSite).reduce((sum, s) => sum + s.totalRecords, 0),
    ...totals,
    failureCount: failures.length,
    failures: failures.slice(0, 50),
  });
});


// Public donor lookup API (used by donation site) - rate-limited, no auth required
// This endpoint is mounted separately in index.ts without auth middleware

export default router;
