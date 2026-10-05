import { Router } from 'express';
import pool from '../db/pool';
import { authenticate, authorize } from '../middleware/auth';
import { fetchDonorSnapshot, fetchDonorPage, fetchTransactionPage, configuredSites, SITE_KEYS, SiteKey, isSiteConfigured, SITE_IMPORT_MODE } from '../services/hkmvClient';
import { upsertDonorSnapshot, upsertTransactionBatch } from '../services/hkmvSync';
import { groupPredicateSql, isPageGroup } from '../utils/pageGroups';
import { normalizeAddress, addressValues, type Address } from '../utils/address';
import { pushProfileToSites } from '../services/profileSync';
import {
  describeFilters,
  sendExport,
  EXPORT_ROW_CAP,
  type ExportFormat,
} from '../utils/export';

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

interface PeopleFilters {
  where: string;
  values: unknown[];
  /** The next free placeholder number, for LIMIT/OFFSET on top of the filters. */
  next: number;
  orderBy: string;
}

// The WHERE and the ORDER BY for the people list, built once.
//
// Shared with the export below rather than written out twice. An export that
// re-derives its own filters drifts away from the screen the moment somebody
// adds the next one, and the person who downloaded the file has no way of
// knowing that the rows in it are not the rows they were looking at.
function buildPeopleFilters(q: Record<string, unknown>): PeopleFilters {
  const { role, search, sort = 'recent', site, group } = q;
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

  // Which site the person has given through. source_sites is an array because a
  // donor can have used both, so this is containment, not equality - filtering
  // by "annadan" must still return someone who also gave on the main site.
  if (site) {
    conditions.push(`$${idx} = ANY(p.source_sites)`);
    values.push(site);
    idx++;
  }

  // People who gave through a particular family of pages. EXISTS rather than a
  // join so a donor with twenty donations still counts once and the row count
  // stays right.
  if (typeof group === 'string' && isPageGroup(group)) {
    conditions.push(
      `EXISTS (SELECT 1 FROM donations dn WHERE dn.person_id = p.id
                 AND ${groupPredicateSql(group, 'dn.source_page', 'dn.source_site')})`
    );
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    values,
    next: idx,
    orderBy: PEOPLE_SORTS[String(sort)] || PEOPLE_SORTS.recent,
  };
}

const PEOPLE_SELECT = `p.*,
              COALESCE(g.donation_count, 0)  AS donation_count,
              COALESCE(g.lifetime_total, 0)  AS lifetime_total,
              g.last_donation_at,
              COALESCE(s.active_subscriptions, 0) AS active_subscriptions`;

const PEOPLE_FROM = `FROM people p
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS donation_count,
                SUM(amount) AS lifetime_total,
                MAX(created_at) AS last_donation_at
         FROM donations WHERE person_id = p.id
       ) g ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS active_subscriptions
         FROM subscriptions WHERE person_id = p.id AND status = 'active'
       ) s ON TRUE`;

// List people with filters, giving aggregates and pagination.
//
// The aggregates are the answer to "one phone number, many donations": people
// are keyed by phone, so every donation that donor ever made rolls up to the single
// person row - this endpoint surfaces how many and how much, so the list can
// show it without N+1 follow-up requests.
router.get('/', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const offset = (page - 1) * limit;

  const f = buildPeopleFilters(req.query as Record<string, unknown>);

  const [data, count] = await Promise.all([
    pool.query(
      `SELECT ${PEOPLE_SELECT}
       ${PEOPLE_FROM}
       ${f.where}
       ORDER BY ${f.orderBy}
       LIMIT $${f.next} OFFSET $${f.next + 1}`,
      [...f.values, limit, offset]
    ),
    pool.query(`SELECT COUNT(*) FROM people p ${f.where}`, f.values),
  ]);

  const total = Number(count.rows[0].count);

  res.json({
    people: data.rows.map(({ pan: _pan, ...r }) => ({
      // PAN IS NOT IN THE LIST RESPONSE, and that is the point of destructuring
      // it out here rather than just leaving it off the screen.
      //
      // The query selects p.*, so every column on `people` was on the wire -
      // including the tax identifier - for anyone who could reach this
      // endpoint, which includes callers. Nothing rendered it, so it was
      // invisible in the product and perfectly visible in the network tab, and
      // a caller could page the list and harvest the lot.
      //
      // A PAN has exactly one job in DRM: putting a number on an 80G receipt
      // for one donor. That is a single-person act, so the single-person
      // endpoints still return it to whoever may see that person. A page of
      // twenty-five of them is a bulk disclosure with no use case behind it.
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

/**
 * The people on screen, as a file.
 *
 * NO PAN COLUMN, deliberately. A tax identifier is the one field here that is
 * worth stealing on its own, and a spreadsheet of several thousand of them
 * leaves DRM's access control behind the moment it is downloaded - it then
 * lives in a Downloads folder and whatever WhatsApp group it gets forwarded to.
 * The single-person screen still shows it to whoever may see that person.
 */
async function exportPeopleFile(
  req: import('express').Request,
  res: import('express').Response,
  format: ExportFormat
) {
  try {
    const f = buildPeopleFilters(req.query as Record<string, unknown>);
    const rows = await pool.query(
      `SELECT ${PEOPLE_SELECT}
       ${PEOPLE_FROM}
       ${f.where}
       ORDER BY ${f.orderBy}
       LIMIT ${EXPORT_ROW_CAP + 1}`,
      f.values
    );
    const truncated = rows.rows.length > EXPORT_ROW_CAP;

    await sendExport(res, format, {
      name: 'people',
      truncated,
      rows: truncated ? rows.rows.slice(0, EXPORT_ROW_CAP) : rows.rows,
      filterSummary: describeFilters(req.query as Record<string, unknown>, {
        search: 'Search',
        role: 'Role',
        site: 'Site',
        group: 'Page group',
        sort: 'Sorted by',
      }),
      columns: [
        { header: 'Name', value: (r) => r.name },
        { header: 'Phone', value: (r) => r.phone, kind: 'phone' },
        { header: 'Email', value: (r) => r.email },
        // The structured city where DRM has one, and the free-text line it was
        // imported with where it does not - a donor entered before the address
        // was split into parts has only the latter.
        { header: 'City/Address', value: (r) => r.address_city || r.address },
        { header: 'Roles', value: (r) => r.roles },
        { header: 'Total donated', value: (r) => r.lifetime_total, kind: 'money' },
        { header: 'Donations', value: (r) => r.donation_count, kind: 'number' },
        { header: 'Last donation', value: (r) => r.last_donation_at, kind: 'datetime' },
        { header: 'Added', value: (r) => r.created_at, kind: 'datetime' },
      ],
    });
  } catch (err) {
    console.error('people.export error:', err);
    res.status(500).json({ error: 'Could not download. Try again.' });
  }
}

// Registered BEFORE '/:id', for the same reason '/import-sites' is: Express
// matches in order, and "export.csv" is a perfectly good person id as far as
// the route pattern is concerned.
//
// WHY THESE TWO ARE GUARDED WHEN THE SCREEN IS NOT
// The router is mounted readOnlyFor('caller'), so a caller may read People -
// they need to look a donor up mid-call. Downloading the whole donor base is a
// different act from looking one person up, and it is the act that takes the
// temple's donor list out of DRM entirely. So the file is for admins and
// accountants, and the screen stays open to everyone who needs it.
router.get('/export.csv', authorize('admin', 'accountant'), (req, res) =>
  exportPeopleFile(req, res, 'csv')
);
router.get('/export.xlsx', authorize('admin', 'accountant'), (req, res) =>
  exportPeopleFile(req, res, 'xlsx')
);

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
  if (!note || !String(note).trim()) return res.status(400).json({ error: 'Write a note first.' });

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

/* --------------------------------------------------------- reading a person */

// THE BUG THIS REPLACES
// Both handlers below used to pass req.body straight into the query. An empty
// date field arrives from a browser form as "", Postgres cannot cast "" to
// DATE, and the whole save died with `invalid input syntax for type date: ""`.
// Since nearly every donor has no anniversary on file, that was most saves -
// and because the form had no error handling, the dialog simply sat there and
// nothing happened. "Save does nothing" was this, every time.
//
// So: one reader, used by both, that turns a browser form into database values
// and says plainly what is wrong rather than letting Postgres say it.

/** "" and "   " mean "not given", not "the empty string". */
const text = (v: unknown, max: number): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

/**
 * A date from a form, or null.
 *
 * Returns undefined for something that is neither empty nor a date, so the
 * caller can refuse it by name instead of storing a surprise.
 */
function formDate(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  // <input type="date"> always gives YYYY-MM-DD. Anything else has come from
  // an import or somebody's hand, and is checked rather than trusted.
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  return s.slice(0, 10);
}

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const ROLES = ['donor', 'volunteer', 'folk', 'congregation'];

interface PersonBody {
  values: unknown[];
  error?: string;
}

/**
 * Turn a request body into the values for people's columns, in a fixed order,
 * or explain what is wrong with it.
 *
 * The order here is the order of COLUMNS below; the two are written together
 * and must be changed together.
 */
function readPersonBody(b: Record<string, unknown>, partial: boolean): PersonBody {
  const name = text(b.name, 255);
  if (!partial && !name) return { values: [], error: 'Enter a name.' };

  const phoneRaw = text(b.phone, 20);
  const phone = phoneRaw ? phoneRaw.replace(/\D/g, '').slice(-10) : null;
  if (!partial && (!phone || phone.length !== 10)) {
    return { values: [], error: 'Enter a 10-digit mobile number.' };
  }

  const email = text(b.email, 255);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { values: [], error: 'Enter a valid E-mail ID.' };
  }

  const pan = text(b.pan, 10)?.toUpperCase() ?? null;
  if (pan && !PAN_RE.test(pan)) {
    return { values: [], error: 'Enter PAN like ABCDE1234F.' };
  }

  const dob = formDate(b.date_of_birth);
  if (dob === undefined) return { values: [], error: 'Enter a valid date of birth.' };
  const anniversary = formDate(b.anniversary_date);
  if (anniversary === undefined) return { values: [], error: 'Enter a valid anniversary date.' };

  const roles = Array.isArray(b.roles)
    ? [...new Set(b.roles.map(String).filter((r) => ROLES.includes(r)))]
    : [];

  // Structured address, with the free-text line kept alongside. Neither
  // replaces the other: the line holds whatever arrived before DRM had parts,
  // and display prefers the parts when they exist.
  const home = normalizeAddress(b.address_parts as Partial<Address>);
  const prasadam = normalizeAddress(b.prasadam_parts as Partial<Address>);

  return {
    values: [
      name,
      phone,
      email,
      text(b.address, 2000),
      pan,
      roles.length ? roles : ['donor'],
      dob,
      anniversary,
      text(b.prasadam_address, 2000),
      ...addressValues(home),
      ...addressValues(prasadam),
    ],
  };
}

const COLUMNS = `name, phone, email, address, pan, roles, date_of_birth, anniversary_date, prasadam_address,
  address_door, address_house, address_street, address_area,
  address_city, address_state, address_pincode, address_country,
  prasadam_door, prasadam_house, prasadam_street, prasadam_area,
  prasadam_city, prasadam_state, prasadam_pincode, prasadam_country`;

const COLUMN_LIST = COLUMNS.split(',').map((c) => c.trim()).filter(Boolean);

// Create person
router.post('/', async (req, res) => {
  const parsed = readPersonBody(req.body ?? {}, false);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const placeholders = parsed.values.map((_, i) => `$${i + 1}`).join(', ');
  try {
    const result = await pool.query(
      `INSERT INTO people (${COLUMNS}) VALUES (${placeholders}) RETURNING *`,
      parsed.values
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'This mobile number is already added.' });
    }
    console.error('people.create error:', err);
    res.status(500).json({ error: 'Could not save that person' });
  }
});

// Update person
router.put('/:id', async (req, res) => {
  const parsed = readPersonBody(req.body ?? {}, false);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const assignments = COLUMN_LIST.map((c, i) => `${c} = $${i + 1}`).join(', ');
  const idIdx = parsed.values.length + 1;

  try {
    // A name typed here is a human's decision, and the screen says so
    // afterwards even if a site later overwrites it - see name_edited_at in
    // schema.sql and the newest-wins rule in hkmvSync.
    const before = await pool.query('SELECT name FROM people WHERE id = $1', [req.params.id]);
    if (!before.rows.length) return res.status(404).json({ error: 'Person not found' });
    const renamed = text(req.body?.name, 255) !== before.rows[0].name;

    const result = await pool.query(
      `UPDATE people SET ${assignments},
         name_edited_at = CASE WHEN $${idIdx + 1}::boolean THEN NOW() ELSE name_edited_at END,
         profile_source = 'drm',
         updated_at = NOW()
       WHERE id = $${idIdx} RETURNING *`,
      [...parsed.values, req.params.id, renamed]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Person not found' });

    // Send the correction out to the sites. Deliberately not awaited: the
    // admin has finished and should not watch a spinner while two Mongo
    // servers are contacted, and a site being down must not fail the save that
    // has already happened here. Outcome lands in push_status.
    void pushProfileToSites(result.rows[0]).catch((e) =>
      console.error('people.push error:', e)
    );

    res.json(result.rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'This mobile number is already used.' });
    }
    console.error('people.update error:', err);
    res.status(500).json({ error: 'Could not save that person' });
  }
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
    return res.status(503).json({ error: 'No donation site is connected.' });
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
    return res.status(502).json({ error: 'Could not reach the donation sites. Try again.', errors });
  }
  if (!matched) {
    return res.status(404).json({ error: 'No donor found with this mobile number.', errors });
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
        ? `The ${requested} site is not connected.`
        : 'No donation site is connected.',
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
