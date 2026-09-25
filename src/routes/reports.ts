import { Router } from 'express';
import pool from '../db/pool';
import { authenticate } from '../middleware/auth';
import {
  GROUP_LABELS,
  canonPageSql,
  pageGroupSql,
  type PageGroup,
} from '../utils/pageGroups';

const router = Router();
router.use(authenticate);

// Page attribution lives in utils/pageGroups.ts so the dashboard, the page
// breakdown and the donations filter all classify a row the same way. See that
// file for the taxonomy and how to add a page.
const CANON_PAGE = canonPageSql('source_page');
const PAGE_GROUP = pageGroupSql('source_page', 'source_site');

// The order the buckets are presented in, everywhere.
const GROUP_ORDER: PageGroup[] = ['donations', 'donate', 'other', 'unattributed'];

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
    groupTotals,
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
             COALESCE(${CANON_PAGE}, '(not recorded)') AS source_page,
             COALESCE(SUM(amount), 0) AS total,
             COUNT(*) AS count,
             COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0) AS this_month
      FROM donations
      GROUP BY source_site, COALESCE(${CANON_PAGE}, '(not recorded)')
      ORDER BY total DESC
      LIMIT 40
    `),
    // Bucket totals for the main site: the donations family, the donate seva
    // campaigns, and everything else. Grouped in SQL rather than summed in JS
    // so the figure on the dashboard is the database's own answer.
    pool.query(`
      SELECT ${PAGE_GROUP} AS grp,
             COALESCE(SUM(amount), 0) AS total,
             COUNT(*) AS count,
             COUNT(DISTINCT ${CANON_PAGE}) AS page_count,
             COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0) AS this_month,
             COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('month', NOW()) - INTERVAL '1 month'
                                            AND created_at <  date_trunc('month', NOW())), 0) AS last_month,
             MAX(created_at) AS last_gift_at
      FROM donations
      WHERE source_site = 'hkmv'
      GROUP BY ${PAGE_GROUP}
    `),
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
    // Main-site giving split into its three buckets, always in the same order
    // and always all present - a bucket with nothing in it yet returns a zero
    // row rather than disappearing, so the dashboard never silently loses a
    // section. "unattributed" is included only when it actually has money in
    // it, because an empty "No page recorded" card is just noise.
    pageGroups: GROUP_ORDER.map((key) => {
      const row = groupTotals.rows.find((r) => r.grp === key);
      return {
        key,
        label: GROUP_LABELS[key],
        total: Number(row?.total ?? 0),
        count: Number(row?.count ?? 0),
        pageCount: Number(row?.page_count ?? 0),
        thisMonth: Number(row?.this_month ?? 0),
        lastMonth: Number(row?.last_month ?? 0),
        lastGiftAt: row?.last_gift_at ?? null,
      };
    }).filter((g) => g.key !== 'unattributed' || g.count > 0),
    bySourcePage: bySourcePage.rows.map((r) => ({
      site: r.source_site,
      sourcePage: r.source_page,
      total: Number(r.total),
      count: Number(r.count),
      thisMonth: Number(r.this_month),
    })),
  });
});

// Full page breakdown, one bucket at a time, for the "Donation pages" screen.
//
// Separate from /dashboard on purpose: the dashboard wants headline figures and
// should stay a single fast round trip, while this screen wants every page with
// its own numbers and is only loaded when someone asks for it.
//
// It also returns a reconciliation block. Classification bugs are the quiet
// kind - a page slips into the wrong bucket and every total still LOOKS
// plausible - so the endpoint states what the buckets add up to alongside what
// the site actually took, and the UI shows a warning if they ever disagree.
router.get('/pages', async (_req, res) => {
  const [pages, siteTotal] = await Promise.all([
    pool.query(`
      SELECT ${PAGE_GROUP} AS grp,
             COALESCE(${CANON_PAGE}, '(not recorded)') AS page,
             source_site,
             COALESCE(SUM(amount), 0) AS total,
             COUNT(*) AS count,
             COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0) AS this_month,
             COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('month', NOW()) - INTERVAL '1 month'
                                            AND created_at <  date_trunc('month', NOW())), 0) AS last_month,
             MIN(created_at) AS first_gift_at,
             MAX(created_at) AS last_gift_at
      FROM donations
      GROUP BY ${PAGE_GROUP}, COALESCE(${CANON_PAGE}, '(not recorded)'), source_site
      ORDER BY total DESC
    `),
    pool.query(`
      SELECT source_site, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
      FROM donations GROUP BY source_site
    `),
  ]);

  const rows = pages.rows.map((r) => ({
    group: r.grp as PageGroup,
    page: r.page as string,
    site: r.source_site as string,
    total: Number(r.total),
    count: Number(r.count),
    thisMonth: Number(r.this_month),
    lastMonth: Number(r.last_month),
    firstGiftAt: r.first_gift_at,
    lastGiftAt: r.last_gift_at,
  }));

  const hkmvRows = rows.filter((r) => r.site === 'hkmv');
  const hkmvSite = siteTotal.rows.find((r) => r.source_site === 'hkmv');
  const hkmvTotal = Number(hkmvSite?.total ?? 0);
  const bucketSum = hkmvRows.reduce((sum, r) => sum + r.total, 0);

  res.json({
    groups: GROUP_ORDER.map((key) => {
      const own = hkmvRows.filter((r) => r.group === key);
      return {
        key,
        label: GROUP_LABELS[key],
        total: own.reduce((s, r) => s + r.total, 0),
        count: own.reduce((s, r) => s + r.count, 0),
        thisMonth: own.reduce((s, r) => s + r.thisMonth, 0),
        lastMonth: own.reduce((s, r) => s + r.lastMonth, 0),
        pages: own,
      };
    }).filter((g) => g.key !== 'unattributed' || g.count > 0),
    otherSites: siteTotal.rows
      .filter((r) => r.source_site !== 'hkmv')
      .map((r) => ({
        site: r.source_site,
        total: Number(r.total),
        count: Number(r.count),
        pages: rows.filter((p) => p.site === r.source_site),
      })),
    reconciliation: {
      // These must be equal. If they are not, a row is being classified into a
      // bucket the UI does not render, and the page totals are understating.
      siteTotal: hkmvTotal,
      bucketSum,
      balanced: Math.abs(hkmvTotal - bucketSum) < 0.01,
    },
  });
});

export default router;
