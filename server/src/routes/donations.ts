import { Router } from 'express';
import pool from '../db/pool';
import { istDate } from '../bootTimezone';
import { normalizeAddress, type Address } from '../utils/address';
import { getReceipt, receiptSourceForDonation } from '../services/receipts';
import { authenticate, authorize } from '../middleware/auth';
import {
  createOfflineDonation,
  fetchDonorSnapshot,
  fetchReceiptPdf,
  isSiteConfigured,
  resendReceipt,
  SiteKey,
} from '../services/hkmvClient';
import { upsertDonorSnapshot } from '../services/hkmvSync';
import { canonPage, canonPageSql, groupPredicateSql, isPageGroup } from '../utils/pageGroups';
import { displayPurposeSql } from '../utils/donationLabel';
import { registerName } from '../services/personNames';
import {
  describeFilters,
  sendExport,
  EXPORT_ROW_CAP,
  type ExportFormat,
} from '../utils/export';

const router = Router();
router.use(authenticate);

interface DonationFilters {
  where: string;
  values: unknown[];
  /** The next free placeholder number, for LIMIT/OFFSET on top of the filters. */
  next: number;
}

/** Inclusive YYYY-MM-DD bounds. A null is an open end, not "today". */
interface DateWindow {
  from: string | null;
  to: string | null;
}

export type DonationPeriod =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_7'
  | 'this_month'
  | 'last_month'
  | 'this_quarter'
  | 'this_fy'
  | 'last_fy'
  | 'this_year'
  | 'all';

/** Calendar arithmetic on a YYYY-MM-DD string, with no timezone in play.
 *
 * toISOString is safe here and only here: the probe is built with Date.UTC
 * from parts that are already the Indian calendar date, so rendering it back
 * in UTC returns exactly those parts. That is a different thing from
 * `new Date().toISOString()`, which asks a clock what day it is and gets the
 * answer in UTC - the mistake bootTimezone exists to stop. */
function shiftDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/** The first of a month, with the month number allowed to run out of range:
 *  month 0 is December of the year before, month 13 January of the next. That
 *  is what makes "last month" on the 1st of January land in the right year. */
function monthStart(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
}

/**
 * Turn a named period into a date window.
 *
 * RESOLVED ON THE INDIAN CALENDAR, by way of istDate(). The idiom this avoids
 * is `new Date().toISOString().slice(0, 10)`, which renders UTC however the
 * process is configured: between midnight and 05:30 IST it names yesterday, so
 * "Today" would list yesterday's donations for the first five and a half hours
 * of every day and "This month" would start on the wrong day every 1st.
 *
 * THE FINANCIAL YEAR HERE IS THE INDIAN ONE, 1 April to 31 March. This temple
 * issues 80G certificates, and the only year its accountants, its auditors and
 * its donors ever mean is that one. Resolving this_fy as a calendar year would
 * hand somebody reconciling 80G totals a figure that looks plausible and is
 * three months wrong in both directions.
 *
 * An unrecognised value yields an open window rather than an error, so a stale
 * bookmark or a typo shows the unfiltered list instead of a 400. Nothing from
 * `period` ever reaches SQL - it only chooses which computed dates get bound.
 */
function resolvePeriod(period: string, today: string = istDate()): DateWindow {
  const [year, month] = today.split('-').map(Number);

  // The financial year is named by the April it opened in, so anything from
  // January to March still belongs to the year before.
  const fyYear = month >= 4 ? year : year - 1;
  // 1, 4, 7 or 10 - the first month of the calendar quarter today sits in.
  const quarterStartMonth = month - ((month - 1) % 3);
  // getUTCDay is Sunday-based, and this week starts on Monday, so Sunday has
  // to count as six days into the week rather than none.
  const dayOfWeek = new Date(Date.UTC(year, month - 1, Number(today.slice(8)))).getUTCDay();
  const mondayOffset = (dayOfWeek + 6) % 7;

  // The ongoing periods end today rather than at the period's own end date: a
  // window running to 31 March in October would read as a range the office had
  // chosen, and an export stamped with it would look like it covered months
  // that have not happened.
  switch (period) {
    case 'today':        return { from: today, to: today };
    case 'yesterday':    return { from: shiftDays(today, -1), to: shiftDays(today, -1) };
    case 'this_week':    return { from: shiftDays(today, -mondayOffset), to: today };
    case 'last_7':       return { from: shiftDays(today, -6), to: today };
    case 'this_month':   return { from: monthStart(year, month), to: today };
    case 'last_month':   return { from: monthStart(year, month - 1), to: shiftDays(monthStart(year, month), -1) };
    case 'this_quarter': return { from: monthStart(year, quarterStartMonth), to: today };
    case 'this_fy':      return { from: monthStart(fyYear, 4), to: today };
    case 'last_fy':      return { from: monthStart(fyYear - 1, 4), to: shiftDays(monthStart(fyYear, 4), -1) };
    case 'this_year':    return { from: monthStart(year, 1), to: today };
    case 'all':          return { from: null, to: null };
    default:             return { from: null, to: null };
  }
}

/**
 * The date window the list and the export both run on.
 *
 * AN EXPLICIT from_date/to_date WINS OVER period. Someone who saved or shared
 * a link with a range in it picked those two dates deliberately, and a `period`
 * riding along in the same URL - left over from the preset they clicked before
 * typing the range, or added later as a default - must not quietly replace
 * them. Either bound on its own is enough to count as a choice; the preset is
 * then ignored entirely rather than half-applied, so the open end stays open
 * instead of being clamped to a date the person never named.
 */
function resolveDateWindow(q: Record<string, unknown>): DateWindow {
  const from = q.from_date ? String(q.from_date) : null;
  const to = q.to_date ? String(q.to_date) : null;
  if (from || to) return { from, to };
  return resolvePeriod(String(q.period ?? ''));
}

// The WHERE for the donations list, built once.
//
// Shared with the export below rather than written out twice. The office sends
// these files to auditors and to the trustees, so a file whose date range is
// not the one the person picked on screen is not merely wrong, it is wrong in
// somebody else's hands - and that is exactly what happens to a second copy of
// this code the next time a filter is added to only one of them.
function buildDonationFilters(q: Record<string, unknown>): DonationFilters {
  const { purpose, source, receipt_generated, search, source_site, source_page, campaign, group } = q;

  // One window for both ends of this. The list and the export resolve the
  // dates through the same call, so a download cannot cover a different period
  // than the screen it was taken from - which is precisely what a second copy
  // of this resolution would produce the first time one of them was corrected.
  const { from: from_date, to: to_date } = resolveDateWindow(q);

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  // lower() on both sides so the filter matches regardless of how the seva name
  // was cased upstream - the dropdown is populated from lowered values.
  // Matched against the SAME expression /purposes offers, or picking
  // "/donations" from the dropdown would filter on a value no row stores and
  // silently return nothing.
  if (purpose) {
    conditions.push(`lower(${displayPurposeSql('d.purpose', 'd.source_page')}) = lower($${idx})`);
    values.push(purpose);
    idx++;
  }
  if (source) { conditions.push(`d.source = $${idx}`); values.push(source); idx++; }
  // THE END DATE IS INCLUSIVE, and until this was fixed it was not.
  //
  // `created_at <= '2026-10-01'` casts that string to midnight, so picking
  // 1 October as the end date excluded every donation made on 1 October -
  // the whole day the user had just asked for. On a one-day range (from and
  // to the same date) the screen came back empty, which reads as "no
  // donations that day" rather than as a bug, so it was believed.
  //
  // Every other range filter in this codebase adds the day. This one is now
  // the same shape as the rest. Both boundaries resolve in IST because the
  // database session does (db/pool.ts), so "1 October" means midnight to
  // midnight in India, not 05:30 to 05:30.
  if (from_date) { conditions.push(`d.created_at >= $${idx}::date`); values.push(from_date); idx++; }
  if (to_date) { conditions.push(`d.created_at < ($${idx}::date + INTERVAL '1 day')`); values.push(to_date); idx++; }
  if (receipt_generated !== undefined && receipt_generated !== '') {
    conditions.push(`d.receipt_generated = $${idx}`);
    values.push(receipt_generated === 'true');
    idx++;
  }
  if (search) {
    // Searching a name has to find the gift made under it, not only the donor
    // whose record carries it. Before person_names, typing a mother's name
    // returned nothing at all - her daughter's phone was filed under the
    // daughter, and the mother existed only as an overwritten string.
    //
    // Three places a name can live, so all three are matched: the donor
    // record, the name written on the donation, and the roster of every name
    // this phone has given under.
    conditions.push(`(
      p.name ILIKE $${idx}
      OR p.phone ILIKE $${idx}
      OR d.receipt_number ILIKE $${idx}
      OR d.given_name ILIKE $${idx}
      OR d.sevak_name ILIKE $${idx}
      OR EXISTS (SELECT 1 FROM person_names pn
                  WHERE pn.person_id = p.id AND pn.name ILIKE $${idx})
    )`);
    values.push(`%${search}%`);
    idx++;
  }
  if (source_site) { conditions.push(`d.source_site = $${idx}`); values.push(source_site); idx++; }
  // Compared in the same canonical shape the dashboard groups by (lower-case,
  // one leading slash, no trailing slash) - the sites spell the same page as
  // "donations", "/donations" and "/Donations/", so a raw equality check here
  // would send the dashboard's own links to an empty list.
  if (source_page) {
    conditions.push(`(${canonPageSql('d.source_page')}) = $${idx}`);
    values.push(canonPage(String(source_page)));
    idx++;
  }
  // Whole bucket rather than one page: ?group=donations returns /donations AND
  // everything nested under it, ?group=donate the seva campaign pages. The
  // predicate comes from utils/pageGroups so this list and the dashboard can
  // never disagree about what belongs where. Not parameterised because it is a
  // fixed fragment chosen by an allowlist - `group` itself never reaches SQL.
  if (isPageGroup(group)) {
    conditions.push(groupPredicateSql(group, 'd.source_page', 'd.source_site'));
  }
  if (campaign)    { conditions.push(`d.campaign = $${idx}`);    values.push(campaign);    idx++; }

  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    values,
    next: idx,
  };
}

// display_purpose alongside the raw purpose, never instead of it: the table
// shows the readable label while the filters, the exports and anything
// reconciled against the source site keep the value that site sent.
/* ADDITIVE ONLY. `donor_name` STILL MEANS WHAT IT ALWAYS MEANT.

   Other applications read this endpoint, so the existing fields keep their
   existing meaning exactly: donor_name is the donor record's name, as it has
   always been, and a caller that knows nothing about any of this sees no
   change at all.

   The new fact goes in a NEW field. `given_name` is the name the gift was
   actually given under, and it is NULL on every donation taken before the
   column existed - which is most of them, and honestly so: there is no record
   of what was typed then, and inventing one would be worse than admitting it.

   A screen that wants the richer answer reads `given_name ?? donor_name`. A
   consumer that does not care carries on reading donor_name and is unaffected.

   An earlier version of this changed donor_name itself to COALESCE over the
   two. That was wrong for an API somebody else depends on: it is a silent
   change of meaning in a field that already had one, and the consumer finds
   out from a mismatched report rather than from an error. */
const DONATION_SELECT = `d.*, p.name AS donor_name, p.phone as donor_phone,
              ${displayPurposeSql('d.purpose', 'd.source_page')} AS display_purpose`;

const DONATION_FROM = `FROM donations d JOIN people p ON d.person_id = p.id`;

// List donations with filters
router.get('/', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const offset = (page - 1) * limit;

  const { where, values, next: idx } = buildDonationFilters(req.query as Record<string, unknown>);

  // The filtered total is returned alongside the page so the UI can show
  // "showing 1-25 of 4,004" and render real pagination instead of silently
  // truncating at the page limit.
  const [data, count, sum] = await Promise.all([
    pool.query(
      `SELECT ${DONATION_SELECT}
       ${DONATION_FROM}
       ${where} ORDER BY d.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, limit, offset]
    ),
    pool.query(`SELECT COUNT(*) ${DONATION_FROM} ${where}`, values),
    pool.query(`SELECT COALESCE(SUM(d.amount), 0) AS total ${DONATION_FROM} ${where}`, values),
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
    SELECT lower(${displayPurposeSql('purpose', 'source_page')}) AS purpose, COUNT(*) AS count
    FROM donations
    GROUP BY lower(${displayPurposeSql('purpose', 'source_page')})
    ORDER BY count DESC
  `);
  res.json(result.rows.map((r) => ({ purpose: r.purpose, count: Number(r.count) })));
});

// Distinct source sites and pages present in the data, for the filters.
// Derived from the rows rather than hardcoded, because each site adds campaign
// pages (/janmashtami, /govardhan, ...) without DRM knowing in advance.
router.get('/sources', async (_req, res) => {
  const [sites, pages] = await Promise.all([
    pool.query(`
      SELECT source_site, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
      FROM donations GROUP BY source_site ORDER BY total DESC
    `),
    // Canonicalised, so the dropdown offers "/donations" once rather than
    // "donations" and "/donations" as two entries that each show half the rows.
    pool.query(`
      SELECT source_site,
             '/' || btrim(lower(btrim(source_page)), '/') AS source_page,
             COUNT(*) AS count,
             COALESCE(SUM(amount), 0) AS total
      FROM donations
      WHERE source_page IS NOT NULL AND btrim(source_page) <> ''
      GROUP BY source_site, '/' || btrim(lower(btrim(source_page)), '/')
      ORDER BY count DESC
      LIMIT 60
    `),
  ]);
  res.json({
    sites: sites.rows.map((r) => ({ site: r.source_site, count: Number(r.count), total: Number(r.total) })),
    pages: pages.rows.map((r) => ({
      site: r.source_site,
      page: r.source_page,
      count: Number(r.count),
      total: Number(r.total),
    })),
  });
});

/**
 * The donations on screen, as a file.
 *
 * Runs buildDonationFilters - the same builder GET / runs - so the rows in the
 * file are the rows that were on the screen when the button was pressed. This
 * is the export the office reconciles a bank statement against, and a window
 * that is a day out either end is a discrepancy somebody then spends an
 * afternoon hunting for in the bank's figures rather than in ours.
 */
async function exportDonationsFile(
  req: import('express').Request,
  res: import('express').Response,
  format: ExportFormat
) {
  try {
    const f = buildDonationFilters(req.query as Record<string, unknown>);
    const rows = await pool.query(
      `SELECT ${DONATION_SELECT}
       ${DONATION_FROM}
       ${f.where} ORDER BY d.created_at DESC LIMIT ${EXPORT_ROW_CAP + 1}`,
      f.values
    );
    const truncated = rows.rows.length > EXPORT_ROW_CAP;

    await sendExport(res, format, {
      name: 'donations',
      truncated,
      rows: truncated ? rows.rows.slice(0, EXPORT_ROW_CAP) : rows.rows,
      filterSummary: describeFilters(req.query as Record<string, unknown>, {
        search: 'Search',
        purpose: 'Purpose',
        receipt_generated: 'Receipt issued',
        // The preset is recorded alongside the dates because the file outlives
        // the screen: an auditor holding a spreadsheet headed "Period: this_fy"
        // can tell what was asked for, where bare dates leave them guessing
        // whether a range stopping in October was deliberate or a mistake.
        period: 'Period',
        from_date: 'From',
        to_date: 'To',
        source_site: 'Site',
        source_page: 'Page',
        group: 'Page group',
      }),
      columns: [
        { header: 'Receipt no', value: (r) => r.receipt_number },
        { header: 'Date', value: (r) => r.created_at, kind: 'datetime' },
        { header: 'Donor name', value: (r) => r.donor_name },
        { header: 'Phone', value: (r) => r.donor_phone, kind: 'phone' },
        { header: 'Amount', value: (r) => r.amount, kind: 'money' },
        { header: 'Purpose', value: (r) => r.display_purpose },
        { header: 'Payment mode', value: (r) => r.payment_mode },
        { header: 'Source site', value: (r) => r.source_site },
        { header: 'Source page', value: (r) => r.source_page },
        { header: 'Receipt issued', value: (r) => (r.receipt_generated ? 'Yes' : 'No') },
        { header: 'Receipt issued at', value: (r) => r.receipt_issued_at, kind: 'datetime' },
      ],
    });
  } catch (err) {
    console.error('donations.export error:', err);
    res.status(500).json({ error: 'Could not download. Try again.' });
  }
}

// Guarded even though the router is only readOnlyFor('caller'): a caller may
// read the donations screen to answer "did my donor's money arrive", but the
// whole giving history of the temple as one spreadsheet is a finance document,
// and it leaves DRM's access control behind as soon as it is downloaded.
router.get('/export.csv', authorize('admin', 'accountant'), (req, res) =>
  exportDonationsFile(req, res, 'csv')
);
router.get('/export.xlsx', authorize('admin', 'accountant'), (req, res) =>
  exportDonationsFile(req, res, 'xlsx')
);

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
// ---------------------------------------------------------------------------
// POST /offline - record a donation taken in cash, cheque, UPI or bank transfer.
//
// DRM does not issue receipts. The admin picks which site the receipt should
// come from, and that site's existing offline path runs: DCC is called, the
// 80G receipt number is allocated from that site's own series, the PDF is
// generated and WhatsApp goes out. Exactly what happens when staff use that
// site's own admin form.
//
// Then DRM pulls the donor's fresh snapshot back and upserts it, so the donation
// appears here immediately with its real receipt number instead of waiting for
// the next import.
router.post('/offline', async (req, res) => {
  const {
    site,
    donor_name,
    donor_mobile,
    donor_email,
    amount,
    payment_mode,
    reference_no,
    payment_date,
    seva_name,
    pan_number,
    want_certificate,
    want_prasadam,
    prasadam_address,
    sevak_name,
    sevak_phone,
    note,
  } = req.body ?? {};

  // Validate here as well as on the site. Not redundant: a clear message from
  // DRM beats a round trip that comes back with another system's wording, and
  // it keeps an obviously bad entry off a live donation database entirely.
  const errors: string[] = [];
  if (site !== 'hkmv' && site !== 'annadan') errors.push('Pick the site for the receipt.');
  else if (!isSiteConfigured(site)) errors.push(`The ${site} site is not connected.`);

  const amt = Number(amount);
  if (!String(donor_name || '').trim()) errors.push('Enter the Donor Name.');
  if (!String(donor_mobile || '').replace(/\D/g, '')) errors.push('Enter the Mobile Number.');
  if (!Number.isFinite(amt) || amt <= 0) errors.push('Enter a valid amount.');
  // The reference ties the receipt to the money: the UTR (the 12-digit UPI or
  // bank transaction number), the cheque number, or for cash the number on
  // the paper receipt handed over. Cash often comes with no paper receipt at
  // all, so for cash DRM makes one up rather than refusing - it only has to be
  // unique, because both sites refuse a second entry against the same one.
  const ref =
    String(reference_no || '').trim() ||
    (payment_mode === 'cash'
      ? `CASH-${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).replace(/-/g, '')}-${Math.random()
          .toString(36)
          .slice(2, 8)
          .toUpperCase()}`
      : '');
  if (!ref) {
    errors.push(
      payment_mode === 'cheque'
        ? 'Enter the Cheque No.'
        : 'Enter the Transaction ID (UTR).'
    );
  }
  if (!['cash', 'cheque', 'upi', 'bank'].includes(String(payment_mode))) {
    errors.push('Pick Cash, UPI, Cheque or Bank Transfer.');
  }
  if (want_prasadam && !String(prasadam_address || '').trim()) {
    errors.push('Enter the address for Maha Prasadam.');
  }
  if (want_certificate && !String(pan_number || '').trim()) {
    errors.push('Enter the PAN Number for 80G Tax Exemption.');
  }
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  const siteKey = site as SiteKey;

  // "On the name of" - who the donation is offered for, which is what both
  // sites' receipts print and what annadan's birthday wish is addressed to.
  //
  // Cut to the width of the columns that hold them (sevak_name VARCHAR(160),
  // sevak_phone VARCHAR(15)) rather than sent whole: a Telugu honorific run
  // long, or a number pasted with spaces and a country code, would otherwise
  // fail the UPDATE below and lose the whole sync-back for a field nobody
  // would think to blame.
  const sevakName = String(sevak_name || '').trim().slice(0, 160) || null;
  const sevakMobile = String(sevak_phone || '').trim().slice(0, 15) || null;

  /* The 80G certificate goes out in the Donor Name, as it always has.

     That is already the right answer, because the form asks for the two names
     separately and has done since it was written:

       Donor Name        -> who the gift is from, and whose 80G it is
       "On the name of"  -> who it is offered for

     A daughter giving in her mother's name fills in both, and the certificate
     is hers while the paper still says it was offered for her mother. Nothing
     here needs to guess, and an earlier version of this comment described code
     that did - it compared the PAN given against the PAN on file and quietly
     substituted the donor on record. That overruled the one person who had
     actually asked the donor whose certificate it is. It is gone. */
  const typedName = String(donor_name).trim();

  // Who is recording this, for the audit trail and for the note that shows on
  // the source site's own record.
  let enteredByName: string | null = null;
  if (req.user?.userId) {
    const u = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.userId]);
    enteredByName = u.rows[0]?.name ?? null;
  }

  let issued;
  try {
    issued = await createOfflineDonation(siteKey, {
      donorName: typedName,
      donorMobile: String(donor_mobile).trim(),
      donorEmail: donor_email ? String(donor_email).trim() : null,
      amount: amt,
      paymentMode: String(payment_mode),
      referenceNo: ref,
      paymentDate: payment_date || null,
      sevaName: seva_name ? String(seva_name).trim() : null,
      panNumber: pan_number ? String(pan_number).trim() : null,
      wantCertificate: !!want_certificate,
      wantPrasadam: !!want_prasadam,
      prasadamAddress: prasadam_address ? String(prasadam_address).trim() : null,
      // The parts, so the site's receipt renders a laid-out address instead of
      // one line. Sent as given, or taken from the donor's saved address when
      // the form did not supply them.
      prasadamParts: normalizeAddress(req.body?.prasadam_parts as Partial<Address>),
      billingParts: normalizeAddress(req.body?.address_parts as Partial<Address>),
      sevakName,
      sevakMobile,
      note: note ? String(note).trim() : null,
      enteredByName,
    });
  } catch (err) {
    const e = err as Error & { status?: number };
    console.error('donations.offline error:', e.message);
    // 409 (duplicate reference) is passed through as 409 so the UI can say
    // "already recorded" rather than "something went wrong". Anything else the
    // site refused is a 502: DRM is fine, the upstream declined.
    const status = e.status === 409 || e.status === 400 ? e.status : 502;
    return res.status(status).json({ error: e.message });
  }

  // The receipt exists on the source site now. Pulling the donor's snapshot
  // back is a convenience, so a failure here must not read as a failed
  // donation - it just means this row appears on the next import instead.
  // "synced" means THIS donation is now visible in DRM - not merely that the
  // donor lookup answered. The site can return a snapshot that does not yet
  // include the new donation (DCC still working, or the read lagging the write),
  // and reporting success then would have the UI claim a row that isn't there.
  let synced = false;
  try {
    const snapshot = await fetchDonorSnapshot(siteKey, String(donor_mobile));
    if (snapshot?.found) {
      const result = await upsertDonorSnapshot(snapshot, siteKey);

      // What was typed on this receipt, kept on the donor where DRM has
      // nothing yet. Neither site saves the PAN or the address on its donor
      // record from a hand-raised receipt, so the snapshot above never brings
      // them back, and the next 80G receipt for the same donor started blank.
      // Only fills gaps: a value already on the donor is never replaced.
      const pan = String(pan_number || '').trim().toUpperCase();
      await pool
        .query(
          `UPDATE people SET
             pan      = COALESCE(NULLIF(pan, ''), $2),
             address  = COALESCE(NULLIF(address, ''), $3),
             email    = COALESCE(NULLIF(email, ''), $4)
           WHERE id = $1`,
          [
            result.personId,
            want_certificate && /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan) ? pan : null,
            String(prasadam_address || '').trim() || null,
            String(donor_email || '').trim().toLowerCase() || null,
          ]
        )
        .catch((e) => console.error('donations.offline donor fill failed (non-fatal):', (e as Error).message));

      /* The name this gift came under joins the donor's list of names.

         Without this the roster only ever learns from the websites, and a
         family that gives at the counter - which is most of this route's
         traffic - would never appear on it. registerName gives the primary
         slot to whichever real name arrived first and never takes it back, so
         calling it here cannot rename anybody. */
      /* Both names join this number's list.

         The donor's own name takes the primary slot if nothing holds it yet.
         The "on the name of" name - the mother, the father, the child the seva
         was offered for - joins as one of the family names, which is exactly
         what the list is for. registerName never moves a primary that is
         already set, so neither call can rename anybody. */
      await Promise.all([
        registerName(pool, result.personId, typedName, 'drm'),
        sevakName ? registerName(pool, result.personId, sevakName, 'drm') : Promise.resolve(null),
      ]).catch((e) =>
        console.error('donations.offline could not record the donor names:', (e as Error).message)
      );

      if (issued.externalId) {
        // Also correct what the sync path cannot know. upsertDonation writes a
        // fixed payment_mode of 'upi' because that is what the overwhelming
        // majority of website donations are - but this one was taken in cash,
        // by cheque or over a bank transfer, and staff need to see that. The
        // reference number goes into payment_ref for the same reason: it is
        // how this donation is traced back to the bank statement or receipt book.
        //
        // The sevak goes on the row here for the same reason it goes on the
        // site: the import that refreshes this donation later knows nothing
        // about it, so without this write the name shows on the receipt and
        // nowhere in DRM, and the first person asked who a receipt was raised
        // for has to open the other system to find out. COALESCE so a re-entry
        // that omits it cannot blank a name already recorded.
        const marked = await pool.query(
          `UPDATE donations SET
             entered_by   = $1,
             source       = 'offline',
             payment_mode = $4,
             payment_ref  = COALESCE(payment_ref, $5),
             sevak_name   = COALESCE($6, sevak_name),
             sevak_phone  = COALESCE($7, sevak_phone),
             -- The name this gift was given under, which is NOT necessarily
             -- the name on the certificate - see the block above.
             given_name   = COALESCE(given_name, $8)
           WHERE external_ref = $2 AND person_id = $3
           RETURNING id`,
          [
            req.user?.userId ?? null,
            issued.externalId,
            result.personId,
            String(payment_mode),
            ref,
            sevakName,
            sevakMobile,
            typedName || null,
          ]
        );
        synced = (marked.rowCount ?? 0) > 0;
      }
    }
  } catch (err) {
    console.error('donations.offline sync-back failed (non-fatal):', (err as Error).message);
  }

  res.status(201).json({
    site: siteKey,
    receiptNumber: issued.receiptNumber,
    externalId: issued.externalId,
    donorName: issued.donorName,
    amount: issued.amount,
    synced,
    message: issued.receiptNumber
      ? `Receipt ${issued.receiptNumber} issued by the ${siteKey === 'annadan' ? 'annadan' : 'main'} site.` +
        (synced ? '' : ' It will show here soon.')
      : 'Donation saved. Receipt No. will show soon.',
  });
});

router.post('/sync', async (req, res) => {
  const { donations } = req.body;
  const results = [];

  for (const d of donations) {
    // Upsert person by phone, then insert donation
    /* THE NAME IS NOT OVERWRITTEN HERE ANY MORE.

       This used to be `DO UPDATE SET name = EXCLUDED.name`, which meant the
       second gift from a phone renamed the donor - silently, with nothing
       kept. A family giving in three names ended up as whoever gave last.

       Now the donor record keeps the name it has, the gift records the name it
       was given under, and person_names holds the list. */
    const person = await pool.query(
      `INSERT INTO people (name, phone, email)
       VALUES ($1, $2, $3)
       ON CONFLICT (phone) DO UPDATE SET email = COALESCE(EXCLUDED.email, people.email)
       RETURNING id`,
      [d.name, d.phone, d.email]
    );
    const personId = person.rows[0].id;
    await registerName(pool, personId, d.name, 'drm');
    const donation = await pool.query(
      `INSERT INTO donations (person_id, amount, type, purpose, payment_mode, source, given_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [personId, d.amount, d.type || 'one-time', d.purpose, d.payment_mode, d.source,
       String(d.name ?? '').trim() || null]
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
// Ask the originating site to re-send its WhatsApp receipt for this donation.
//
// DRM deliberately does not compose or send the receipt itself: the template,
// the receipt numbering and the PDF all live on the site that issued it, and
// duplicating any of that here would produce receipts that differ from the
// originals a donor already has.
router.post('/:id/resend-receipt', async (req, res) => {
  const result = await pool.query(
    'SELECT external_ref, source_site, receipt_number, receipt_generated FROM donations WHERE id = $1',
    [req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Donation not found' });

  const { external_ref, source_site, receipt_generated } = result.rows[0];

  if (!external_ref) {
    return res.status(400).json({
      error: 'This donation has no website receipt to resend.',
    });
  }
  if (!receipt_generated) {
    return res.status(400).json({ error: 'No receipt yet for this donation.' });
  }

  try {
    const outcome = await resendReceipt((source_site || 'hkmv') as SiteKey, external_ref);
    res.json({
      resent: true,
      sentTo: outcome.sentTo ?? null,
      receiptNumber: outcome.receiptNumber ?? result.rows[0].receipt_number ?? null,
      site: source_site || 'hkmv',
    });
  } catch (err) {
    // Preserve the site's own status. 409 (no receipt issued yet) and 429
    // (just sent) are deliberate refusals, not outages - reporting them as 502
    // makes a correct safety guard look like a broken server.
    const e = err as Error & { status?: number; alreadySent?: boolean };
    const status = e.status === 409 || e.status === 429 ? e.status : 502;
    res.status(status).json({ error: e.message, alreadySent: Boolean(e.alreadySent) });
  }
});

/**
 * GET /:id/receipt-file - the donor's 80G receipt.
 *
 * TWO FIXES LIVE HERE
 *
 * The query used to select external_ref and receipt_number, then destructure
 * source_site out of the same row - a column it never asked for. So
 * source_site was always undefined and every receipt was fetched from HKMV,
 * which meant an annadan receipt could not be downloaded at all. It is
 * selected now.
 *
 * And the PDF is cached, in a way that cannot serve a stale one: see
 * receiptFingerprint. The key carries a hash of what the receipt prints, so a
 * corrected receipt is a different object and the old one is never asked for
 * again. ?refresh=true skips the cache for the rare case where somebody
 * believes the site has changed something DRM cannot see.
 */
// An 80G receipt carries the donor's full name, address, PAN and amount.
//
// readOnlyFor('caller') on this router lets every GET through, and the guard's
// own comment says a download is a GET and cannot be told apart from reading a
// page by method alone - "that is a separate check on those handlers". This is
// that check. A caller has no reason to pull another donor's tax certificate.
router.get('/:id/receipt-file', authorize('admin', 'accountant'), async (req, res) => {
  const id = String(req.params.id);
  try {
    const src = await receiptSourceForDonation(id);
    if (!src) {
      const exists = await pool.query('SELECT 1 FROM donations WHERE id = $1', [id]);
      if (!exists.rows.length) return res.status(404).json({ error: 'Donation not found' });
      return res.status(400).json({
        error: 'No receipt file for this donation.',
      });
    }

    const out = await getReceipt(src, req.query.refresh === 'true');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="receipt-${(out.receiptNumber || id).replace(/[^a-zA-Z0-9-]/g, '-')}.pdf"`
    );
    // Says where it came from, so a slow download and a cached one are
    // distinguishable when somebody asks why a reprint was instant.
    res.setHeader('X-Receipt-Source', out.from);
    res.send(out.buffer);
  } catch (err) {
    const e = err as Error & { status?: number };
    res.status(e.status && e.status < 500 ? e.status : 502).json({ error: e.message });
  }
});

export default router;
