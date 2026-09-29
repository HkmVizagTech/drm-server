// What a donation is actually FOR, as a human would say it.
//
// THE PROBLEM
// The seva name that arrives from the source sites is whatever the donation
// form called the button. On the main site's /donations page the free-amount
// option is labelled "Donate any other Amount", and 584 donations carry that as
// their purpose. It is not a seva - it describes the input box, not the gift -
// so it tells staff nothing, and in the dashboard's purpose breakdown it forms
// one of the largest slices while meaning nothing at all.
//
// THE RULE
// When the stored purpose is one of these content-free placeholders, show the
// PAGE the donation came from instead ("/donations"), which is the most
// informative thing actually known about it. Every other purpose is left
// exactly as the donor's site recorded it.
//
// What this deliberately does NOT do: change the stored value. `purpose` stays
// whatever the site sent, so the filters, the exports and any reconciliation
// against the source site still see the original. This is presentation only.
//
// ADDING A PLACEHOLDER
// Add the lower-cased form to PLACEHOLDER_PURPOSES. Be conservative: a purpose
// only belongs here if it carries no information whatsoever. "General" is NOT
// one - a donor really can give to the general fund, and collapsing that into a
// page name would destroy a real distinction.

export const PLACEHOLDER_PURPOSES = [
  'donate any other amount',
  'any other amount',
  'other amount',
  'donate any other',
  'custom amount',
  'manual entry',
] as const;

const asSqlArray = (xs: readonly string[]) => `ARRAY[${xs.map((x) => `'${x}'`).join(',')}]::text[]`;

/** True when the purpose in `col` says nothing about what the gift was for. */
export function isPlaceholderPurposeSql(col = 'purpose'): string {
  return `(${col} IS NULL OR btrim(${col}) = '' OR lower(btrim(${col})) = ANY(${asSqlArray(PLACEHOLDER_PURPOSES)}))`;
}

/**
 * The label to show. Falls back through: the real purpose, then the page it
 * came from, then a plain "Unspecified" - never an empty cell, because a blank
 * reads as a rendering bug rather than as missing data.
 */
export function displayPurposeSql(purposeCol = 'purpose', pageCol = 'source_page'): string {
  const canonPage = `CASE WHEN ${pageCol} IS NULL OR btrim(${pageCol}) = '' THEN NULL
                          ELSE '/' || btrim(lower(btrim(${pageCol})), '/') END`;
  return `CASE WHEN ${isPlaceholderPurposeSql(purposeCol)}
               THEN COALESCE(${canonPage}, 'Unspecified')
               ELSE ${purposeCol} END`;
}

/** JS twin, for labelling rows the client already holds. */
export function displayPurpose(purpose?: string | null, sourcePage?: string | null): string {
  const p = String(purpose ?? '').trim();
  if (p && !PLACEHOLDER_PURPOSES.includes(p.toLowerCase() as (typeof PLACEHOLDER_PURPOSES)[number])) {
    return p;
  }
  const page = String(sourcePage ?? '').trim();
  if (page) return '/' + page.toLowerCase().replace(/^\/+|\/+$/g, '');
  return 'Unspecified';
}
