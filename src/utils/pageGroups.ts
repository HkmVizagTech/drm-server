// How a donation page on the main site is classified.
//
// THE PROBLEM THIS SOLVES
// The source sites do not agree on how a page is spelled. Values seen in
// production include "donations" (no slash), "/gau-seva" (slash),
// "donations/janmashtami2" (nested), "/" (annadan's single page), and NULL.
// Every read must normalise before comparing, or a filter silently matches
// nothing - which is exactly how the dashboard once showed a confident zero
// while a million rupees sat in the table.
//
// THE TAXONOMY
// Three buckets, and every hkmv donation lands in exactly one of them:
//
//   donations  - the /donations page AND everything nested under it.
//                /donations/janmashtami2 belongs here, and so will any future
//                /donations/<festival> without anyone touching this file.
//                Prefix-matched for that reason.
//
//   donate     - the seva campaign pages reached from /donate. These share no
//                URL prefix with each other, so they are an explicit list.
//                A new seva page must be added here (see ADDING A PAGE below).
//
//   other      - every remaining single-segment page: /govardhan,
//                /janmashtami, /pitru-paksha and anything new. These are not
//                lumped together into one figure - each keeps its own row -
//                but they share a section so a page nobody has classified yet
//                is visible rather than silently missing.
//
// NOTHING IS EVER DROPPED. A page that matches no rule becomes "other", and a
// donation with no page at all becomes "unattributed". The dashboard checks
// that the buckets add back up to the site total, so a classification mistake
// surfaces as a visible discrepancy instead of quietly shrinking the numbers.
//
// ADDING A PAGE
// A new seva page under /donate: add its canonical path to DONATE_PAGES below.
// A new festival page under /donations/<name>: nothing to do, the prefix rule
// already covers it. Anything else lands in "other" and can stay there.

export type PageGroup = 'donations' | 'donate' | 'other' | 'unattributed';

// The seva campaign pages that belong to the /donate ask. Canonical form:
// lower-case, one leading slash, no trailing slash.
export const DONATE_PAGES = [
  '/gau-seva',
  '/sqft-seva-campaign',
  '/brick-seva-campaign',
  '/anna-daan-seva',
  '/gita-daan-seva',
  '/alankara-vastra-seva',
] as const;

// The parent of the nested donations family. Both the page itself and
// everything below it count towards the donations bucket.
export const DONATIONS_ROOT = '/donations';

export const GROUP_LABELS: Record<PageGroup, string> = {
  donations: 'Donations page',
  donate: 'Donate — seva campaigns',
  other: 'Other pages',
  unattributed: 'No page recorded',
};

// ---------------------------------------------------------------------------
// SQL fragments
//
// These are fixed strings with no interpolated user input - the only value
// that ever reaches the database as data is the parameter list. They take a
// column expression so they can be applied to an aliased table ("d.source_page")
// or a bare one.

/** Canonical page: lower-case, exactly one leading slash, no trailing slash.
 *  NULL and blank collapse to NULL. Annadan's "/" stays "/" - a real page. */
export function canonPageSql(col = 'source_page'): string {
  return `CASE WHEN ${col} IS NULL OR btrim(${col}) = '' THEN NULL
               ELSE '/' || btrim(lower(btrim(${col})), '/') END`;
}

/** Which bucket a row falls in. `siteCol` keeps the main site's taxonomy from
 *  being applied to annadan, whose pages are its own business. */
export function pageGroupSql(col = 'source_page', siteCol = 'source_site'): string {
  const canon = canonPageSql(col);
  return `CASE
            WHEN ${siteCol} IS DISTINCT FROM 'hkmv' THEN 'other'
            WHEN (${canon}) IS NULL THEN 'unattributed'
            WHEN (${canon}) = '${DONATIONS_ROOT}'
              OR (${canon}) LIKE '${DONATIONS_ROOT}/%' THEN 'donations'
            WHEN (${canon}) = ANY($DONATE_PAGES$) THEN 'donate'
            ELSE 'other'
          END`.replace(
    '$DONATE_PAGES$',
    `ARRAY[${DONATE_PAGES.map((p) => `'${p}'`).join(',')}]::text[]`
  );
}

/** WHERE predicate restricting rows to one bucket, for the donations list. */
export function groupPredicateSql(
  group: PageGroup,
  col = 'source_page',
  siteCol = 'source_site'
): string {
  const canon = canonPageSql(col);
  switch (group) {
    case 'donations':
      return `${siteCol} = 'hkmv' AND ((${canon}) = '${DONATIONS_ROOT}' OR (${canon}) LIKE '${DONATIONS_ROOT}/%')`;
    case 'donate':
      return `${siteCol} = 'hkmv' AND (${canon}) = ANY(ARRAY[${DONATE_PAGES.map((p) => `'${p}'`).join(',')}]::text[])`;
    case 'unattributed':
      return `${siteCol} = 'hkmv' AND (${canon}) IS NULL`;
    case 'other':
    default:
      return `NOT (${siteCol} = 'hkmv' AND (
                (${canon}) IS NULL
                OR (${canon}) = '${DONATIONS_ROOT}'
                OR (${canon}) LIKE '${DONATIONS_ROOT}/%'
                OR (${canon}) = ANY(ARRAY[${DONATE_PAGES.map((p) => `'${p}'`).join(',')}]::text[])
              ))`;
  }
}

export function isPageGroup(v: unknown): v is PageGroup {
  return v === 'donations' || v === 'donate' || v === 'other' || v === 'unattributed';
}

/** JS twin of canonPageSql, for normalising a value arriving as a query param
 *  so it compares equal to what the database produces. */
export function canonPage(input: string): string {
  const trimmed = String(input).trim().toLowerCase();
  if (!trimmed) return '';
  return '/' + trimmed.replace(/^\/+|\/+$/g, '');
}
