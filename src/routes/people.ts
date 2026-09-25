import { Router } from 'express';
import pool from '../db/pool';
import { authenticate, authorize } from '../middleware/auth';
import { fetchDonorSnapshot, hkmvMappers } from '../services/hkmvClient';

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
  const personResult = await pool.query('SELECT * FROM people WHERE id = $1', [id]);
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

  const donor = snapshot.donor;
  const formattedAddress = hkmvMappers.formatSavedAddress(donor.savedAddress ?? null);

  await pool.query(
    `UPDATE people SET
       email = COALESCE(email, $1),
       pan = COALESCE(pan, $2),
       prasadam_address = COALESCE(prasadam_address, $3),
       updated_at = NOW()
     WHERE id = $4`,
    [donor.email ?? null, donor.panNumber ?? null, formattedAddress, id]
  );

  let donationsSynced = 0;
  let subscriptionsSynced = 0;
  let deliveriesSynced = 0;

  for (const d of snapshot.donations || []) {
    // DRM's donations ledger only tracks confirmed gifts - pending/failed/
    // cancelled attempts on the live site aren't real contributions here.
    if (d.status !== 'completed') continue;

    const donationResult = await pool.query(
      `INSERT INTO donations (person_id, amount, type, purpose, payment_mode, source, receipt_generated, receipt_number, receipt_issued_at, external_ref, created_at)
       VALUES ($1, $2, 'one-time', $3, 'upi', 'website', $4, $5, $6, $7, $8)
       ON CONFLICT (external_ref) DO UPDATE SET
         receipt_generated = EXCLUDED.receipt_generated,
         receipt_number = EXCLUDED.receipt_number,
         receipt_issued_at = EXCLUDED.receipt_issued_at
       RETURNING id`,
      [
        id,
        d.amount,
        hkmvMappers.truncate30(d.type),
        !!d.receiptNumber,
        d.receiptNumber ?? null,
        d.receiptIssuedAt ?? null,
        d.externalId,
        d.createdAt,
      ]
    );
    donationsSynced++;
    const drmDonationId = donationResult.rows[0].id;

    if (d.prasadam) {
      const status = hkmvMappers.PRASADAM_STATUS_MAP[d.prasadam.status] || 'pending';
      const address = hkmvMappers.formatHkmvAddress(d.prasadam.address) || formattedAddress || person.address;
      if (address) {
        await pool.query(
          `INSERT INTO prasadam_deliveries (person_id, donation_id, address, status, courier_name, tracking_number, dispatched_at, delivered_at, external_ref)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (external_ref) DO UPDATE SET
             status = EXCLUDED.status,
             courier_name = EXCLUDED.courier_name,
             tracking_number = EXCLUDED.tracking_number,
             dispatched_at = EXCLUDED.dispatched_at,
             delivered_at = EXCLUDED.delivered_at`,
          [
            id,
            drmDonationId,
            address,
            status,
            d.prasadam.courierName ?? null,
            d.prasadam.trackingNumber ?? null,
            d.prasadam.dispatchedAt ?? null,
            d.prasadam.deliveredAt ?? null,
            d.externalId,
          ]
        );
        deliveriesSynced++;
      }
    }
  }

  for (const s of snapshot.subscriptions || []) {
    const status = hkmvMappers.SUBSCRIPTION_STATUS_MAP[s.status] || 'active';
    await pool.query(
      `INSERT INTO subscriptions (person_id, amount, frequency, purpose, status, gateway_subscription_id, start_date, external_ref)
       VALUES ($1, $2, 'monthly', $3, $4, $5, $6, $7)
       ON CONFLICT (external_ref) DO UPDATE SET
         amount = EXCLUDED.amount,
         status = EXCLUDED.status,
         updated_at = NOW()`,
      [id, s.amount, hkmvMappers.truncate30(s.sevaName), status, s.subscriptionId, s.startedAt, s.subscriptionId]
    );
    subscriptionsSynced++;
  }

  res.json({ synced: true, donationsSynced, subscriptionsSynced, deliveriesSynced });
});

// Public donor lookup API (used by donation site) - rate-limited, no auth required
// This endpoint is mounted separately in index.ts without auth middleware

export default router;
