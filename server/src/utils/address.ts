// Addresses, in one place.
//
// WHY THIS EXISTS
// Three systems hold a donor's address and all three hold it differently:
//
//   DRM (until now)              one free-text line
//   HKMV donor.savedAddress      street, city, state, pincode, country
//   HKMV donation.prasadamAddress doorNo, house, street, area,
//                                 city, state, pincode, country
//   annadan donation             address, city, state, pincode, flat on the row
//
// Every place that moved an address between two of those did its own
// flattening, which is why a DRM receipt printed a smear and annadan's receipt
// prints ", ,  - " when only the street is known. One shape in, one shape out,
// and the joining rules live here rather than in five templates.
//
// THE CANONICAL SHAPE IS HKMV'S EIGHT-FIELD PRASADAM ADDRESS
// Not because it is prettier but because the other two fit inside it without
// loss. Going the other way would mean choosing what to throw away, and an
// address is exactly the kind of data where the discarded part turns out to be
// the flat number.

export interface Address {
  door?: string | null;
  house?: string | null;
  street?: string | null;
  area?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  country?: string | null;
}

const clean = (v: unknown, max: number): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/\s+/g, ' ');
  return s ? s.slice(0, max) : null;
};

/** Trim and cap every part. The lengths match the column widths in schema.sql. */
export function normalizeAddress(a: Partial<Address> | null | undefined): Address {
  return {
    door: clean(a?.door, 60),
    house: clean(a?.house, 120),
    street: clean(a?.street, 200),
    area: clean(a?.area, 120),
    city: clean(a?.city, 80),
    state: clean(a?.state, 80),
    // Indian pincodes are six digits; anything else is kept as typed rather
    // than rejected, because a foreign donor with a postcode is a real case
    // and losing it would be worse than storing something unusual.
    pincode: clean(a?.pincode, 10),
    country: clean(a?.country, 60),
  };
}

export const isEmptyAddress = (a: Address): boolean =>
  !a.door && !a.house && !a.street && !a.area && !a.city && !a.state && !a.pincode;

/**
 * One line, for a table cell or a search result.
 *
 * Falsy parts are dropped BEFORE joining, which is the bug annadan's receipt
 * has: it builds `${addr}, ${city}, ${state} - ${pincode}` unconditionally, so
 * an address with only a street comes out as "123 Main St, ,  - ".
 */
export function formatAddressLine(a: Address, fallback?: string | null): string {
  const parts = [a.door, a.house, a.street, a.area, a.city, a.state].filter(Boolean) as string[];
  let line = parts.join(', ');
  if (a.pincode) line = line ? `${line} - ${a.pincode}` : a.pincode;
  // India is on nearly every row and adding it says nothing; anywhere else is
  // worth printing.
  if (a.country && a.country.toLowerCase() !== 'india') line = line ? `${line}, ${a.country}` : a.country;
  return line || (fallback ?? '').trim();
}

/**
 * Several lines, for a receipt or a courier label.
 *
 * Laid out the way an Indian postal address is read: the building, then the
 * locality, then the town and state with the pincode, then the country. The
 * sites print one long comma-joined line; this is what makes a DRM receipt
 * legible instead of a smear.
 */
export function formatAddressLines(a: Address, fallback?: string | null): string[] {
  const lines: string[] = [];

  const building = [a.door, a.house].filter(Boolean).join(', ');
  if (building) lines.push(building);
  if (a.street) lines.push(a.street);
  if (a.area) lines.push(a.area);

  const town = [a.city, a.state].filter(Boolean).join(', ');
  const withPin = a.pincode ? (town ? `${town} - ${a.pincode}` : a.pincode) : town;
  if (withPin) lines.push(withPin);

  if (a.country && a.country.toLowerCase() !== 'india') lines.push(a.country);

  if (lines.length) return lines;
  // Nothing structured. Fall back to whatever free text we hold, split on the
  // commas somebody typed, so an old single-line address still reads as an
  // address rather than one long run.
  const raw = (fallback ?? '').trim();
  return raw ? raw.split(/\s*,\s*/).filter(Boolean) : [];
}

/* ------------------------------------------------- reading the sites' shapes */

/** HKMV's donor.savedAddress - five fields, no building detail. */
export function fromHkmvSaved(v: Record<string, unknown> | null | undefined): Address {
  return normalizeAddress({
    street: v?.street as string,
    city: v?.city as string,
    state: v?.state as string,
    pincode: v?.pincode as string,
    country: v?.country as string,
  });
}

/** HKMV's donation.prasadamAddress - the full eight. */
export function fromHkmvPrasadam(v: Record<string, unknown> | null | undefined): Address {
  return normalizeAddress({
    door: v?.doorNo as string,
    house: v?.house as string,
    street: v?.street as string,
    area: v?.area as string,
    city: v?.city as string,
    state: v?.state as string,
    pincode: v?.pincode as string,
    country: v?.country as string,
  });
}

/**
 * annadan's flat donation fields.
 *
 * `address` there is free text that often contains the whole thing, commas and
 * all, so it goes into `street` rather than being split on guesswork - a
 * wrong split is harder to notice, and harder to undo, than a long street.
 */
export function fromAnnadan(v: {
  address?: unknown;
  city?: unknown;
  state?: unknown;
  pincode?: unknown;
}): Address {
  return normalizeAddress({
    street: v.address as string,
    city: v.city as string,
    state: v.state as string,
    pincode: v.pincode as string,
    country: 'India',
  });
}

/* ------------------------------------------------ writing the sites' shapes */

/** For PATCHing HKMV's donor.savedAddress. Its five fields, and no others. */
export function toHkmvSaved(a: Address): Record<string, string> {
  const out: Record<string, string> = {};
  // HKMV validates that street, city and state are all present together, so
  // the building parts are folded into street rather than dropped - a door
  // number is not worth losing to a shape mismatch.
  const street = [a.door, a.house, a.street, a.area].filter(Boolean).join(', ');
  if (street) out.street = street.slice(0, 200);
  if (a.city) out.city = a.city;
  if (a.state) out.state = a.state;
  if (a.pincode) out.pincode = a.pincode;
  out.country = a.country || 'India';
  return out;
}

/** For annadan, which keeps the address flat on the donation row. */
export function toAnnadan(a: Address): Record<string, string> {
  const out: Record<string, string> = {};
  const line = [a.door, a.house, a.street, a.area].filter(Boolean).join(', ');
  if (line) out.address = line;
  if (a.city) out.city = a.city;
  if (a.state) out.state = a.state;
  if (a.pincode) out.pincode = a.pincode;
  return out;
}

/* -------------------------------------------------------- database plumbing */

/** Read an address off a people row, given the column prefix. */
export function addressFromRow(
  row: Record<string, unknown>,
  prefix: 'address' | 'prasadam'
): Address {
  return {
    door: (row[`${prefix}_door`] as string) ?? null,
    house: (row[`${prefix}_house`] as string) ?? null,
    street: (row[`${prefix}_street`] as string) ?? null,
    area: (row[`${prefix}_area`] as string) ?? null,
    city: (row[`${prefix}_city`] as string) ?? null,
    state: (row[`${prefix}_state`] as string) ?? null,
    pincode: (row[`${prefix}_pincode`] as string) ?? null,
    country: (row[`${prefix}_country`] as string) ?? null,
  };
}

/** The eight values in column order, for an INSERT or UPDATE. */
export const addressValues = (a: Address): (string | null)[] => [
  a.door ?? null,
  a.house ?? null,
  a.street ?? null,
  a.area ?? null,
  a.city ?? null,
  a.state ?? null,
  a.pincode ?? null,
  a.country ?? null,
];
