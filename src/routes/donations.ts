import { Router } from 'express';
import pool from '../db/pool';
import { authenticate, authorize } from '../middleware/auth';
import { fetchReceiptPdf } from '../services/hkmvClient';

const router = Router();
router.use(authenticate);

// List donations with filters
router.get('/', async (req, res) => {
  const { purpose, source, from_date, to_date, receipt_generated, search } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  // lower() on both sides so the filter matches regardless of how the seva name
  // was cased upstream - the dropdown is populated from lowered values.
  if (purpose) { conditions.push(`lower(d.purpose) = lower($${idx})`); values.push(purpose); idx++; }
  if (source) { conditions.push(`d.source = $${idx}`); values.push(source); idx++; }
  if (from_date) { conditions.push(`d.created_at >= $${idx}`); values.push(from_date); idx++; }
  if (to_date) { conditions.push(`d.created_at <= $${idx}`); values.push(to_date); idx++; }
  if (receipt_generated !== undefined && receipt_generated !== '') {
    conditions.push(`d.receipt_generated = $${idx}`);
    values.push(receipt_generated === 'true');
    idx++;
  }
  if (search) {
    conditions.push(`(p.name ILIKE $${idx} OR p.phone ILIKE $${idx} OR d.receipt_number ILIKE $${idx})`);
    values.push(`%${search}%`);
    idx++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // The filtered total is returned alongside the page so the UI can show
  // "showing 1-25 of 4,004" and render real pagination instead of silently
  // truncating at the page limit.
  const [data, count, sum] = await Promise.all([
    pool.query(
      `SELECT d.*, p.name as donor_name, p.phone as donor_phone
       FROM donations d JOIN people p ON d.person_id = p.id
       ${where} ORDER BY d.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, limit, offset]
    ),
    pool.query(`SELECT COUNT(*) FROM donations d JOIN people p ON d.person_id = p.id ${where}`, values),
    pool.query(`SELECT COALESCE(SUM(d.amount), 0) AS total FROM donations d JOIN people p ON d.person_id = p.id ${where}`, values),
  ]);

  const total = Number(count.rows[0].count);

  res.json({
    donations: data.rows.map((r) => ({ ...r, amount: Number(r.amount) })),
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    filteredAmount: Number(sum.rows[0].total),
  });
});

// Distinct purposes actually present in the data, for the filter dropdown.
//
// A hardcoded list of four purposes was fine when every donation was entered
// here by hand, but purposes synced from hkmsite2.0 are free-text seva names -
// so a fixed dropdown can't filter most of the real data. Matching is
// case-insensitive for the same reason the dashboard groups that way.
router.get('/purposes', async (_req, res) => {
  const result = await pool.query(`
    SELECT lower(purpose) AS purpose, COUNT(*) AS count
    FROM donations
    GROUP BY lower(purpose)
    ORDER BY count DESC
  `);
  res.json(result.rows.map((r) => ({ purpose: r.purpose, count: Number(r.count) })));
});

// Summary stats
router.get('/summary', async (_req, res) => {
  const result = await pool.query(`
    SELECT
      purpose,
      SUM(amount) as total,
      COUNT(*) as count
    FROM donations
    WHERE receipt_generated = false
    GROUP BY purpose
  `);
  res.json(result.rows);
});

// Record a donation
router.post('/', async (req, res) => {
  const { person_id, amount, type, purpose, payment_mode, source } = req.body;
  const result = await pool.query(
    `INSERT INTO donations (person_id, amount, type, purpose, payment_mode, source)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [person_id, amount, type, purpose, payment_mode, source]
  );
  res.status(201).json(result.rows[0]);
});

// Bulk sync donations (from live site)
router.post('/sync', async (req, res) => {
  const { donations } = req.body;
  const results = [];

  for (const d of donations) {
    // Upsert person by phone, then insert donation
    const person = await pool.query(
      `INSERT INTO people (name, phone, email)
       VALUES ($1, $2, $3)
       ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, email = COALESCE(EXCLUDED.email, people.email)
       RETURNING id`,
      [d.name, d.phone, d.email]
    );
    const donation = await pool.query(
      `INSERT INTO donations (person_id, amount, type, purpose, payment_mode, source)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [person.rows[0].id, d.amount, d.type || 'one-time', d.purpose, d.payment_mode, d.source]
    );
    results.push(donation.rows[0]);
  }

  res.json({ synced: results.length, donations: results });
});

// Mark a donation's 80G receipt as issued -> fires a receipt_ready trigger for WhatsApp delivery
router.patch('/:id/receipt', async (req, res) => {
  const { id } = req.params;
  const { receipt_number, receipt_url } = req.body;

  const result = await pool.query(
    `UPDATE donations SET
       receipt_generated = TRUE,
       receipt_number = COALESCE($1, receipt_number),
       receipt_url = COALESCE($2, receipt_url),
       receipt_issued_at = NOW()
     WHERE id = $3 RETURNING *`,
    [receipt_number ?? null, receipt_url ?? null, id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Donation not found' });

  const donation = result.rows[0];
  await pool.query(
    `INSERT INTO triggers (person_id, trigger_type, payload) VALUES ($1, 'receipt_ready', $2)`,
    [
      donation.person_id,
      JSON.stringify({
        donation_id: id,
        amount: donation.amount,
        receipt_number: donation.receipt_number,
        receipt_url: donation.receipt_url,
      }),
    ]
  );
  res.json(donation);
});

// Streams the real 80G receipt PDF from hkmsite2.0 for a donation that was
// synced in from there (external_ref = its Mongo _id). A donation created
// natively in DRM has no external_ref and no receipt file to proxy - use
// PATCH /:id/receipt for those instead.
router.get('/:id/receipt-file', async (req, res) => {
  const { id } = req.params;
  const result = await pool.query('SELECT external_ref, receipt_number FROM donations WHERE id = $1', [id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Donation not found' });

  const { external_ref, receipt_number } = result.rows[0];
  if (!external_ref) {
    return res.status(400).json({ error: 'This donation has no linked hkmsite2.0 record to fetch a receipt file from.' });
  }

  try {
    const upstream = await fetchReceiptPdf(external_ref);
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return res.status(upstream.status).json({ error: text || 'Could not fetch the receipt from hkmsite2.0' });
    }
    const arrayBuffer = await upstream.arrayBuffer();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="receipt-${(receipt_number || id).replace(/[^a-zA-Z0-9-]/g, '-')}.pdf"`
    );
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

export default router;
