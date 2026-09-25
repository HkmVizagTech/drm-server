import { Router } from 'express';
import pool from '../db/pool';
import { authenticate, authorize } from '../middleware/auth';
import { fetchDonorSnapshot, fetchDonorPage } from '../services/hkmvClient';
import { upsertDonorSnapshot } from '../services/hkmvSync';

const router = Router();
router.use(authenticate);

// List people with filters
router.get('/', async (req, res) => {
  const { role, search, page = '1', limit = '20' } = req.query;
  const offset = (Number(page) - 1) * Number(limit);
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (role) {
    conditions.push(`$${idx} = ANY(roles)`);
    values.push(role);
    idx++;
  }
  if (search) {
    conditions.push(`(name ILIKE $${idx} OR phone ILIKE $${idx})`);
    values.push(`%${search}%`);
    idx++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(Number(limit), offset);

  const [data, count] = await Promise.all([
    pool.query(`SELECT * FROM people ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`, values),
    pool.query(`SELECT COUNT(*) FROM people ${where}`, values.slice(0, -2)),
  ]);

  res.json({ people: data.rows, total: Number(count.rows[0].count) });
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

  let snapshot;
  try {
    snapshot = await fetchDonorSnapshot(person.phone);
  } catch (err) {
    return res.status(502).json({ error: `Could not reach hkmsite2.0: ${(err as Error).message}` });
  }

  if (!snapshot.found || !snapshot.donor) {
    return res.status(404).json({ error: 'No matching donor found on hkmsite2.0 for this phone number' });
  }

  try {
    const counts = await upsertDonorSnapshot(snapshot);
    return res.json({ synced: true, ...counts });
  } catch (err) {
    return res.status(500).json({ error: `Sync failed: ${(err as Error).message}` });
  }
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
  const pageSize = Math.min(200, Math.max(1, Number(req.body?.pageSize) || 50));
  const maxPages = Number(req.body?.maxPages) || Infinity;

  const totals = {
    donorsProcessed: 0,
    peopleCreated: 0,
    donationsSynced: 0,
    subscriptionsSynced: 0,
    deliveriesSynced: 0,
  };
  const failures: Array<{ mobile?: string; name?: string; error: string }> = [];

  try {
    let page = 1;
    let hasMore = true;
    let totalDonors = 0;

    while (hasMore && page <= maxPages) {
      const result = await fetchDonorPage(page, pageSize);
      totalDonors = result.total;

      for (const snapshot of result.donors) {
        try {
          const counts = await upsertDonorSnapshot(snapshot);
          totals.donorsProcessed++;
          if (counts.created) totals.peopleCreated++;
          totals.donationsSynced += counts.donationsSynced;
          totals.subscriptionsSynced += counts.subscriptionsSynced;
          totals.deliveriesSynced += counts.deliveriesSynced;
        } catch (err) {
          failures.push({
            mobile: snapshot.donor?.mobile,
            name: snapshot.donor?.name,
            error: (err as Error).message,
          });
        }
      }

      hasMore = result.hasMore;
      page++;
    }

    res.json({
      imported: true,
      totalDonorsOnHkmv: totalDonors,
      ...totals,
      failureCount: failures.length,
      // Cap the detail list so one systemic problem can't produce a
      // multi-megabyte response.
      failures: failures.slice(0, 50),
    });
  } catch (err) {
    // A transport-level failure part-way through still leaves everything
    // already imported in place (each donor commits its own transaction),
    // so report progress rather than pretending nothing happened.
    res.status(502).json({
      error: `Import stopped: ${(err as Error).message}`,
      ...totals,
      failureCount: failures.length,
    });
  }
});


// Public donor lookup API (used by donation site) - rate-limited, no auth required
// This endpoint is mounted separately in index.ts without auth middleware

export default router;
