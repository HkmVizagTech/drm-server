import { Router } from 'express';
import pool from '../db/pool';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// Pages singled out on the dashboard with their own figures.
//
// /donate and /donations are DIFFERENT pages on the main site and must never
// be added together - they are separate asks with separate performance. They
// are matched exactly (not by prefix) for that reason: a prefix match on
// "/donate" would swallow "/donations" and silently merge the two.
const SPOTLIGHT_PAGES = ['/donations', '/donate'];

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

// Dashboard overview.
//
// One endpoint, many small aggregates, all issued in parallel - the dashboard
// is the first screen staff see, so it should be one round trip rather than a
// waterfall of a dozen requests.
//
// Postgres returns NUMERIC as a string to avoid float precision loss, so every
// money/count value is explicitly Number()-ed on the way out. Skipping that is
// how you end up with "₹12" + "₹5" rendering as "₹125" in the UI.
router.get('/dashboard', async (_req, res) => {
  const [
    people,
    giving,
    thisMonth,
    lastMonth,
    recurring,
    operations,
    monthlyTrend,
    byPurpose,
    topDonors,
    recentDonations,
    bySite,
    bySourcePage,
    pageSpotlight,
  ] = await Promise.all([
    pool.query(`
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE 'donor' = ANY(roles)) AS donors,
             COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW())) AS new_this_month
      FROM people
    `),
    pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS total,
             COUNT(*) AS count,
             COALESCE(AVG(amount), 0) AS avg_gift
      FROM donations
    `),
    pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
      FROM donations WHERE created_at >= date_trunc('month', NOW())
    `),
    pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
      FROM donations
      WHERE created_at >= date_trunc('month', NOW()) - INTERVAL '1 month'
        AND created_at <  date_trunc('month', NOW())
    `),
    pool.query(`
      SELECT COUNT(*) FILTER (WHERE status = 'active') AS active_count,
             COALESCE(SUM(amount) FILTER (WHERE status = 'active' AND frequency = 'monthly'), 0) AS monthly_value,
             COUNT(*) FILTER (WHERE status = 'paused') AS paused_count
      FROM subscriptions
    `),
    pool.query(`
      SELECT
        (SELECT COUNT(*) FROM prasadam_deliveries WHERE status IN ('pending', 'packed')) AS prasadam_pending,
        (SELECT COUNT(*) FROM donations WHERE receipt_generated = false) AS receipts_pending,
        (SELECT COUNT(*) FROM events WHERE date_end >= NOW()) AS upcoming_events,
        (SELECT COUNT(*) FROM triggers WHERE status = 'pending') AS pending_triggers
    `),
    // generate_series so months with no giving still appear as zero - a trend
    // chart that silently drops empty months misreads as "no gap".
    pool.query(`
      SELECT to_char(m.month, 'YYYY-MM') AS month,
             COALESCE(SUM(d.amount), 0) AS total,
             COUNT(d.id) AS count
      FROM generate_series(
             date_trunc('month', NOW()) - INTERVAL '11 months',
             date_trunc('month', NOW()),
             INTERVAL '1 month'
           ) AS m(month)
      LEFT JOIN donations d ON date_trunc('month', d.created_at) = m.month
      GROUP BY m.month
      ORDER BY m.month
    `),
    // Grouped case-insensitively: purposes synced from hkmsite2.0 are free-text
    // seva names, so "General" and "general" both occur and would otherwise
    // render as two identical-looking rows that don't add up. The UI title-cases
    // the lowered value back for display.
    pool.query(`
      SELECT lower(purpose) AS purpose, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
      FROM donations GROUP BY lower(purpose) ORDER BY total DESC LIMIT 8
    `),
    pool.query(`
      SELECT p.id, p.name, p.phone,
             SUM(d.amount) AS total, COUNT(d.id) AS count
      FROM people p JOIN donations d ON d.person_id = p.id
      GROUP BY p.id ORDER BY total DESC LIMIT 8
    `),
    pool.query(`
      SELECT d.id, d.amount, d.purpose, d.created_at, d.receipt_number,
             d.source_site, d.source_page, d.campaign,
             p.id AS person_id, p.name AS donor_name, p.phone AS donor_phone
      FROM donations d JOIN people p ON d.person_id = p.id
      ORDER BY d.created_at DESC LIMIT 8
    `),
    // Totals per donation site - the main site and the annadan site are
    // reported separately because they're run and budgeted separately.
    pool.query(`
      SELECT source_site,
             COALESCE(SUM(amount), 0) AS total,
             COUNT(*) AS count,
             COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0) AS this_month
      FROM donations
      GROUP BY source_site
      ORDER BY total DESC
    `),
    // Which page on which site produced the giving (/donate, /janmashtami,
    // /govardhan, ...). NULL means a gift recorded directly in DRM or synced
    // before attribution existed, so it's labelled rather than dropped.
    pool.query(`
      SELECT source_site,
             COALESCE(source_page, '(not recorded)') AS source_page,
             COALESCE(SUM(amount), 0) AS total,
             COUNT(*) AS count
      FROM donations
      GROUP BY source_site, COALESCE(source_page, '(not recorded)')
      ORDER BY total DESC
      LIMIT 12
    `),
    // Exact-match figures for the spotlight pages. A LEFT JOIN from the page
    // list means a page with no giving yet still returns a zero row rather
    // than vanishing from the dashboard.
    pool.query(
      `SELECT pages.page AS source_page,
              COALESCE(SUM(d.amount), 0) AS total,
              COUNT(d.id) AS count,
              COALESCE(SUM(d.amount) FILTER (WHERE d.created_at >= date_trunc('month', NOW())), 0) AS this_month,
              COALESCE(SUM(d.amount) FILTER (WHERE d.created_at >= date_trunc('month', NOW()) - INTERVAL '1 month'
                                               AND d.created_at <  date_trunc('month', NOW())), 0) AS last_month,
              MAX(d.created_at) AS last_gift_at
       FROM unnest($1::text[]) AS pages(page)
       LEFT JOIN donations d ON d.source_page = pages.page
       GROUP BY pages.page`,
      [SPOTLIGHT_PAGES]
    ),
  ]);

  const pr = people.rows[0];
  const gr = giving.rows[0];
  const rr = recurring.rows[0];
  const or = operations.rows[0];

  res.json({
    people: {
      total: Number(pr.total),
      donors: Number(pr.donors),
      newThisMonth: Number(pr.new_this_month),
    },
    giving: {
      lifetimeTotal: Number(gr.total),
      lifetimeCount: Number(gr.count),
      avgGift: Number(gr.avg_gift),
      thisMonth: Number(thisMonth.rows[0].total),
      thisMonthCount: Number(thisMonth.rows[0].count),
      lastMonth: Number(lastMonth.rows[0].total),
    },
    recurring: {
      activeCount: Number(rr.active_count),
      monthlyValue: Number(rr.monthly_value),
      pausedCount: Number(rr.paused_count),
    },
    operations: {
      prasadamPending: Number(or.prasadam_pending),
      receiptsPending: Number(or.receipts_pending),
      upcomingEvents: Number(or.upcoming_events),
      pendingTriggers: Number(or.pending_triggers),
    },
    monthlyTrend: monthlyTrend.rows.map((r) => ({
      month: r.month,
      total: Number(r.total),
      count: Number(r.count),
    })),
    byPurpose: byPurpose.rows.map((r) => ({
      purpose: r.purpose,
      total: Number(r.total),
      count: Number(r.count),
    })),
    topDonors: topDonors.rows.map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      total: Number(r.total),
      count: Number(r.count),
    })),
    recentDonations: recentDonations.rows.map((r) => ({
      id: r.id,
      personId: r.person_id,
      donorName: r.donor_name,
      donorPhone: r.donor_phone,
      amount: Number(r.amount),
      purpose: r.purpose,
      createdAt: r.created_at,
      receiptNumber: r.receipt_number,
      sourceSite: r.source_site,
      sourcePage: r.source_page,
      campaign: r.campaign,
    })),
    bySite: bySite.rows.map((r) => ({
      site: r.source_site,
      total: Number(r.total),
      count: Number(r.count),
      thisMonth: Number(r.this_month),
    })),
    pageSpotlight: SPOTLIGHT_PAGES.map((page) => {
      const row = pageSpotlight.rows.find((r) => r.source_page === page);
      return {
        page,
        total: Number(row?.total ?? 0),
        count: Number(row?.count ?? 0),
        thisMonth: Number(row?.this_month ?? 0),
        lastMonth: Number(row?.last_month ?? 0),
        lastGiftAt: row?.last_gift_at ?? null,
      };
    }),
    bySourcePage: bySourcePage.rows.map((r) => ({
      site: r.source_site,
      sourcePage: r.source_page,
      total: Number(r.total),
      count: Number(r.count),
    })),
  });
});

export default router;
