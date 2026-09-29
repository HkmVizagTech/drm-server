// Page attribution - ONE definition, shared by every route that reads it.
//
// This lives in its own module because the two halves (how a page is spelled,
// and which bucket it falls in) have to agree across the dashboard, the
// donation list filter and the filter dropdown. When they were written out
// separately per route they drifted, and the dashboard spent a day showing
// zero against pages that had lakhs of rupees in them.

// ---------------------------------------------------------------------------
// Canonical spelling
//
// The source sites do not agree on how a page is written. Real values in
// production include "donations" (no slash), "/gau-seva" (slash),
// "donations/janmashtami2" (nested) and "/" (annadan's single page). Every
// read normalises to one shape: lower-case, exactly one leading slash, no
// trailing slash.
//
//   donations              -> /donations
//   /Donations/            -> /donations
//   donations/janmashtami2 -> /donations/janmashtami2
//   /gau-seva              -> /gau-seva
//   /                      -> /            (a real page, not a missing value)
//   NULL, "", "   "        -> NULL         (labelled, never counted as a page)
export const CANON_PAGE = `
  CASE WHEN source_page IS NULL OR btrim(source_page) = '' THEN NULL
       ELSE '/' || btrim(lower(btrim(source_page)), '/') END`;

// The same rule in JS, for normalising a value that arrives as a query
// parameter before it is compared against the SQL above.
export function canonicalizePage(raw: string): string {
  return '/' + String(raw).trim().toLowerCase().replace(/^\/+|\/+$/g, '');
}

// Qualifies the expression for a specific table alias, e.g. canon('d') for a
// query that joins donations AS d. Doing this with a replace keeps one source
// of truth rather than a second hand-written copy per alias.
export function canon(alias?: string): string {
  return alias ? CANON_PAGE.replace(/source_page/g, `${alias}.source_page`) : CANON_PAGE;
}

// ---------------------------------------------------------------------------
// Buckets
//
//   donations  - the donations section: "/donations" itself AND everything
//                beneath it. A festival page launched later at
//                /donations/<whatever> lands here automatically with no code
//                change. That is the point of matching on the prefix rather
//                than on a list of known page names - the list would go stale
//                the first time someone ships a new festival page.
//   donate     - every other page that asks for a donation directly: /gau-seva,
//                /squarefoot, /janmashtami, /donate itself, and so on.
//   unattributed - a donation with no page recorded. Deliberately in NEITHER
//                bucket: folding it into "donate" would quietly inflate that
//                figure, so it is reported on its own instead.
//
// The buckets are disjoint and together account for every row, so the two
// cards plus the unattributed remainder can never exceed the site total.
//
// Scoped by the caller to the main site. This split is a fact about hkmv's
// page structure, not a universal rule - applying it to annadan would invent a
// distinction that does not exist there.
export const PAGE_BUCKET = `
  CASE WHEN source_page IS NULL OR btrim(source_page) = '' THEN 'unattributed'
       WHEN '/' || btrim(lower(btrim(source_page)), '/') = '/donations'
         OR '/' || btrim(lower(btrim(source_page)), '/') LIKE '/donations/%' THEN 'donations'
       ELSE 'donate' END`;

export function bucket(alias?: string): string {
  return alias ? PAGE_BUCKET.replace(/source_page/g, `${alias}.source_page`) : PAGE_BUCKET;
}

export const BUCKET_LABELS: Record<string, { label: string; blurb: string }> = {
  donations: {
    label: '/donations',
    blurb: 'the donations section, including every page under it',
  },
  donate: {
    label: '/donate',
    blurb: 'gau-seva, squarefoot and the other direct pages',
  },
};

export const BUCKET_KEYS = Object.keys(BUCKET_LABELS);
