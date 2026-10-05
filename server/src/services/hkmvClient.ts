// Client for the internal service APIs of the donation sites DRM pulls from.
//
// There are two, and they expose the SAME endpoints on purpose:
//   hkmv     - harekrishnavizag.org        (hkmsite2.0-server, Mongo, has a
//                                           real donor collection)
//   annadan  - annadan.harekrishnavizag.org (separate app, donor details
//                                           denormalised onto each donation)
//
// Because both speak the same snapshot shape, everything downstream - sync,
// bulk import, the live webhook, receipt proxying - is site-agnostic and takes
// a SiteKey rather than having two parallel code paths.
//
// Auth: shared-secret header (x-internal-secret), matching the convention both
// sites already use for their own /api/internal/* endpoints.

export type SiteKey = 'hkmv' | 'annadan';

import { toAnnadan, type Address } from '../utils/address';

export interface SiteConfig {
  key: SiteKey;
  label: string;
  baseUrl: string;
  secret: string;
}

// Accepts a bare host or a full URL and tolerates a trailing slash. A value
// pasted without a scheme makes fetch() throw "Failed to parse URL" rather
// than doing anything useful, and a trailing slash produces a double slash in
// every request path.
function normalizeBaseUrl(raw: string): string {
  const trimmed = (raw || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // A bare local host means a dev server, which won't be serving TLS.
  const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i.test(trimmed);
  return `${isLocal ? 'http' : 'https'}://${trimmed}`;
}

const SITE_ENV: Record<SiteKey, { label: string; url: string; secret: string }> = {
  hkmv: { label: 'HKMV site', url: 'HKMV_API_URL', secret: 'HKMV_INTERNAL_SECRET' },
  annadan: { label: 'Annadan site', url: 'ANNADAN_API_URL', secret: 'ANNADAN_INTERNAL_SECRET' },
};

export const SITE_KEYS: SiteKey[] = ['hkmv', 'annadan'];

export function getSite(key: SiteKey): SiteConfig {
  const env = SITE_ENV[key];
  if (!env) throw new Error(`Unknown site "${key}"`);
  return {
    key,
    label: env.label,
    baseUrl: normalizeBaseUrl(process.env[env.url] || ''),
    secret: process.env[env.secret] || '',
  };
}

export function isSiteConfigured(key: SiteKey): boolean {
  const site = getSite(key);
  return Boolean(site.baseUrl && site.secret);
}

// Only the sites that actually have credentials set. A temple running just the
// main site should not see import errors for a second site it doesn't use.
export function configuredSites(): SiteConfig[] {
  return SITE_KEYS.filter(isSiteConfigured).map(getSite);
}

function assertConfigured(site: SiteConfig) {
  if (!site.baseUrl || !site.secret) {
    const env = SITE_ENV[site.key];
    throw new Error(
      `${site.label} is not connected.`
    );
  }
}

async function siteFetch(site: SiteConfig, path: string, init: RequestInit = {}): Promise<Response> {
  assertConfigured(site);
  return fetch(`${site.baseUrl}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), 'x-internal-secret': site.secret },
  });
}

/* ------------------------------------------------------------------- types */

export interface HkmvPrasadam {
  status: 'pending' | 'dispatched' | 'delivered' | 'cancelled';
  courierName?: string | null;
  trackingNumber?: string | null;
  dispatchedAt?: string | null;
  deliveredAt?: string | null;
  address?: {
    doorNo?: string; house?: string; street?: string; area?: string;
    country?: string; state?: string; city?: string; pincode?: string;
  } | null;
}

export interface HkmvDonation {
  externalId: string;
  amount: number;
  type: string;
  status: 'pending' | 'active' | 'completed' | 'failed' | 'cancelled' | string;
  createdAt: string;
  isRecurring: boolean;
  subscriptionId?: string | null;
  receiptNumber?: string | null;
  receiptIssuedAt?: string | null;
  // Attribution - which site, page and campaign produced the donation.
  sourceSite?: SiteKey | null;
  sourcePage?: string | null;
  campaign?: string | null;
  utm?: { source?: string | null; medium?: string | null; campaign?: string | null } | null;
  paymentRef?: string | null;
  prasadam?: HkmvPrasadam | null;
}

export interface HkmvSubscription {
  subscriptionId: string;
  sevaName: string;
  amount: number;
  status: 'pending' | 'active' | 'completed' | 'cancelled' | 'failed' | string;
  startedAt: string;
  lastChargedAt?: string | null;
  chargeCount: number;
}

export interface HkmvDonorSnapshot {
  success: true;
  found: boolean;
  donor?: {
    externalId: string;
    donorId?: string;
    name: string;
    mobile: string;
    email?: string | null;
    panNumber?: string | null;
    savedAddress?: { street?: string; city?: string; state?: string; pincode?: string; country?: string } | null;
    donorSince: string;
    sourceSite?: SiteKey | null;
  };
  donations?: HkmvDonation[];
  subscriptions?: HkmvSubscription[];
}

export interface HkmvDonorPage {
  success: true;
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
  donors: Array<{
    donor: NonNullable<HkmvDonorSnapshot['donor']>;
    donations: HkmvDonation[];
    subscriptions: HkmvSubscription[];
  }>;
}

/* ----------------------------------------------------------------- fetches */

// Must match the normalization used in hkmvSync and the public lookup route,
// or the same donor matches differently on each side.
function normalizeMobile(phone: string): string {
  return String(phone || '').replace(/\s+/g, '').replace(/^\+?91/, '');
}

export async function fetchDonorSnapshot(siteKey: SiteKey, phone: string): Promise<HkmvDonorSnapshot> {
  const site = getSite(siteKey);
  const mobile = normalizeMobile(phone);
  const res = await siteFetch(site, `/api/internal/drm/donors/by-mobile/${encodeURIComponent(mobile)}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`${site.label} internal API returned ${res.status}: ${body.slice(0, 200)}`);
    throw new Error(`${site.label} did not respond (${res.status}). Try again.`);
  }
  return res.json() as Promise<HkmvDonorSnapshot>;
}

// One page of the full donor firehose, used by the bulk backfill import. Paged
// rather than all-at-once so a site with thousands of donors doesn't have to
// hold the entire history in memory on either side.
export async function fetchDonorPage(siteKey: SiteKey, page: number, limit: number): Promise<HkmvDonorPage> {
  const site = getSite(siteKey);
  const res = await siteFetch(site, `/api/internal/drm/donors?page=${page}&limit=${limit}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`${site.label} internal API returned ${res.status}: ${body.slice(0, 200)}`);
    throw new Error(`${site.label} did not respond (${res.status}). Try again.`);
  }
  return res.json() as Promise<HkmvDonorPage>;
}

export interface HkmvTransaction {
  donor: NonNullable<HkmvDonorSnapshot['donor']>;
  donation: HkmvDonation;
  subscription: HkmvSubscription | null;
}

export interface HkmvTransactionPage {
  success: true;
  limit: number;
  total: number;
  returned: number;
  hasMore: boolean;
  nextCursor: string | null;
  transactions: HkmvTransaction[];
}

// Cursor-paged feed of raw transactions.
//
// Used for sites that store transactions rather than donors (annadan). Those
// sites hand over flat rows and DRM does the grouping, so the source site
// never has to run an aggregation over its whole collection just so we can
// import - it's an indexed range scan on its side and ordinary work on ours.
//
// Cursor rather than page number: skip() walks and discards every preceding
// document, so deep pages get progressively more expensive on a large
// collection, whereas `_id > cursor` stays constant-cost.
export async function fetchTransactionPage(
  siteKey: SiteKey,
  cursor: string | null,
  limit: number
): Promise<HkmvTransactionPage> {
  const site = getSite(siteKey);
  const qs = new URLSearchParams({ limit: String(limit) });
  if (cursor) qs.set('after', cursor);
  const res = await siteFetch(site, `/api/internal/drm/transactions?${qs}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`${site.label} internal API returned ${res.status}: ${body.slice(0, 200)}`);
    throw new Error(`${site.label} did not respond (${res.status}). Try again.`);
  }
  return res.json() as Promise<HkmvTransactionPage>;
}

// Which import style a site supports. hkmsite2.0 has a real donor collection
// and can group cheaply itself; annadan stores transactions, so DRM pulls the
// flat feed and groups here.
export const SITE_IMPORT_MODE: Record<SiteKey, 'donors' | 'transactions'> = {
  hkmv: 'donors',
  annadan: 'transactions',
};

// Streams the real 80G receipt PDF straight through, so DRM shows the genuine
// receipt rather than duplicating PDF generation. Returns the raw Response so
// the caller can pipe it without buffering the whole file.
export async function fetchReceiptPdf(siteKey: SiteKey, externalDonationId: string): Promise<Response> {
  const site = getSite(siteKey);
  return siteFetch(site, `/api/internal/drm/donations/${externalDonationId}/receipt.pdf`);
}

export interface ResendResult {
  success: boolean;
  sentTo?: string;
  receiptNumber?: string | null;
  message?: string;
  // Set when the site refused because the receipt already went out moments
  // ago. Not a failure - the donor has it - so the caller reports it as
  // information rather than an error.
  alreadySent?: boolean;
  status?: number;
}

// Asks the source site to re-send its WhatsApp receipt for one donation. DRM
// deliberately does not send it itself: the receipt template, numbering and
// PDF all live on the site that issued it, and duplicating any of that here
// would produce receipts that differ from the originals.
export async function resendReceipt(siteKey: SiteKey, externalDonationId: string): Promise<ResendResult> {
  const site = getSite(siteKey);
  const res = await siteFetch(site, `/api/internal/drm/donations/${externalDonationId}/resend-receipt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  const body = (await res.json().catch(() => ({}))) as ResendResult;
  if (!res.ok || body.success === false) {
    const err = new Error(body.message || `Could not resend receipt (${res.status}). Try again.`) as Error & {
      status?: number;
      alreadySent?: boolean;
    };
    // Carry the upstream status so the route can distinguish "refused on
    // purpose" (409 not ready, 429 just sent) from a genuine failure.
    err.status = res.status;
    err.alreadySent = Boolean(body.alreadySent);
    throw err;
  }
  return body;
}

/* ----------------------------------------------------------------- mappers */

function formatHkmvAddress(a?: NonNullable<HkmvPrasadam['address']> | null): string | null {
  if (!a) return null;
  const parts = [a.doorNo, a.house, a.street, a.area, a.city, a.state, a.pincode, a.country].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function formatSavedAddress(
  a?: { street?: string; city?: string; state?: string; pincode?: string; country?: string } | null
): string | null {
  if (!a) return null;
  const parts = [a.street, a.city, a.state, a.pincode, a.country].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

const PRASADAM_STATUS_MAP: Record<string, string> = {
  pending: 'pending',
  dispatched: 'shipped',
  delivered: 'delivered',
  cancelled: 'returned',
};

const SUBSCRIPTION_STATUS_MAP: Record<string, string> = {
  active: 'active',
  pending: 'active',
  completed: 'cancelled',
  cancelled: 'cancelled',
  failed: 'cancelled',
};

// DRM's purpose/sevaName columns are VARCHAR(30) - the sites' seva names are
// free text and can run longer, so truncate rather than risk an insert failing
// outright on a long festival or seva title.
function truncate30(s: string): string {
  return (s || 'general').slice(0, 30);
}

function truncate(s: string | null | undefined, n: number): string | null {
  if (!s) return null;
  return String(s).slice(0, n);
}

export const hkmvMappers = {
  formatHkmvAddress,
  formatSavedAddress,
  PRASADAM_STATUS_MAP,
  SUBSCRIPTION_STATUS_MAP,
  truncate30,
  truncate,
};

// ---------------------------------------------------------------------------
// Recording an offline donation on a source site.
//
// DRM collects ONE simple form and each site is handed the field names it
// already expects. Neither site's validation, DCC call, receipt numbering or
// WhatsApp send is reimplemented here - this only translates.
//
// The two sites genuinely disagree about names and vocabulary, which is the
// whole reason this mapping exists in one place rather than in the route:
//   donor name      donorName            vs  name
//   reference       utrNumber            vs  offlineRefNo
//   payment mode    manualPaymentMode    vs  offlinePaymentMode
//   seva            sevaName             vs  occasion
//   prasadam        wantPrasadam/address vs  mahaprasadam/prasadamAddress
// and HKMV accepts only upi|bank|cash|cheque where annadan also allows
// phonepe|bank_transfer|other.

export interface OfflineDonationInput {
  donorName: string;
  donorMobile: string;
  donorEmail?: string | null;
  amount: number;
  /** cash | cheque | upi | bank */
  paymentMode: string;
  /** UTR, cheque number or receipt-book reference. Required by both sites. */
  referenceNo: string;
  /** When the money was actually received, not when it was typed in. */
  paymentDate?: string | null;
  sevaName?: string | null;
  panNumber?: string | null;
  wantCertificate?: boolean;
  wantPrasadam?: boolean;
  prasadamAddress?: string | null;
  /**
   * The address in parts, which is what the sites' receipts actually render.
   *
   * HKMV's donation.prasadamAddress is an OBJECT of eight fields, and DRM was
   * sending a plain string into it - so every part its receipt template reads
   * (doorNo, house, street, area, city, state, pincode) came back undefined
   * and the address printed as one smear, or as "---". annadan is the same
   * story with its flat address/city/state/pincode columns.
   */
  prasadamParts?: Address | null;
  billingParts?: Address | null;
  /**
   * The payment gateway's own id (Razorpay "pay_..."), for a QR payment.
   * Kept apart from referenceNo, which is the UTR the donor can read off
   * their phone: the sites show and search the gateway id in its own column,
   * and the receipt prints whichever of the two it has.
   */
  gatewayPaymentId?: string | null;
  note?: string | null;
  /** Shown on the source site's record so staff there know where it came from. */
  enteredByName?: string | null;
  /**
   * The preacher's DCC id number, so the receipt is enrolled under them.
   *
   * A plain number, the one the temple's own system knows them by. Without one
   * DCC falls back to a generic default (36 on both sites), which is how a
   * donation brought in by a named preacher ends up credited to nobody.
   *
   * NEITHER SITE READS THIS TODAY. DRM sends it on both branches and both
   * discard it: HKMV's createManual never destructures dccEnrolledById from
   * the body - it derives the value itself by looking up a `devoteeId`
   * (donation.controller.js:451-456) - and annadan's offline controller does
   * not destructure it at all. So every offline receipt DRM raises is still
   * enrolled under the default, and the preacher a caller named here reaches
   * DCC nowhere.
   *
   * It is sent anyway, deliberately: the value is correct, the wire name is
   * the one both sites would use if they accepted it, and the fix belongs on
   * their side. This note exists so the next person reading the payload does
   * not conclude from its presence that attribution is working - it is not,
   * and a figure built on the assumption that it is would be wrong about who
   * raised what.
   */
  dccEnrolledById?: number | null;

  /**
   * "On the name of" - the person the donation is offered for, and their
   * phone.
   *
   * Both sites' receipt templates have rendered this field since the
   * beginning and both their donation models store it, and DRM has never once
   * sent it: every receipt DRM raised printed "---" where the donor expected
   * the name of the person they were giving for. On annadan it is load-bearing
   * past the paper too - sendBirthdayWishToSevak messages this person on their
   * birthday, and a name that was never captured means that message is never
   * sent.
   */
  sevakName?: string | null;
  sevakMobile?: string | null;
}

export interface OfflineDonationResult {
  externalId: string | null;
  receiptNumber: string | null;
  donorName: string | null;
  amount: number | null;
  raw: unknown;
}

// HKMV's schema restricts the mode to these four. Anything else would be
// silently coerced to "bank" by its controller, so map explicitly instead of
// letting a cheque quietly become a bank transfer.
const HKMV_MODES: Record<string, string> = {
  cash: 'cash',
  cheque: 'cheque',
  upi: 'upi',
  bank: 'bank',
};

const ANNADAN_MODES: Record<string, string> = {
  cash: 'cash',
  cheque: 'cheque',
  upi: 'upi',
  bank: 'bank_transfer',
};

/**
 * A typed one-line address, made into parts the sites can print.
 *
 * Staff type "12-3, Beach Road, MVP Colony, Visakhapatnam 530017". Sent as a
 * single string it lands in `street` and the receipt and DCC get no city and
 * no PIN code. The PIN is unambiguous (six digits), and the words just before
 * it are the city in the way everybody writes an Indian address, so those two
 * are lifted out and the rest is kept as written.
 */
function partsFromText(text: string | null | undefined): Address | null {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const pin = t.match(/\b(\d{6})\b/);
  const withoutPin = pin ? t.replace(pin[0], '').replace(/[\s,.-]+$/, '').trim() : t;
  const pieces = withoutPin.split(',').map((x) => x.trim()).filter(Boolean);
  const city = pieces.length > 1 ? pieces.pop()! : null;
  return {
    street: pieces.join(', ') || withoutPin,
    city,
    pincode: pin ? pin[1] : null,
    country: 'India',
  };
}

export function buildOfflineBody(site: SiteKey, input: OfflineDonationInput): Record<string, unknown> {
  // Parsed once, used by whichever branch runs. A typed address with no
  // parts is split into parts here, so both the prasadam label and the 80G
  // certificate get a city and PIN.
  const typed = input.prasadamParts ? null : partsFromText(input.prasadamAddress);
  const parts = input.prasadamParts ?? typed;
  const billing = input.billingParts && Object.values(input.billingParts).some(Boolean) ? input.billingParts : parts;
  // The address goes to the site whenever the receipt needs one - for the
  // prasadam box OR for the 80G certificate. It used to go only with
  // prasadam, so an 80G receipt for a donor who wanted no prasadam reached
  // HKMV (whose only address field is prasadamAddress) and DCC with none.
  const sendAddress = !!input.wantPrasadam || !!input.wantCertificate;

  const prasadamFlat = parts ? toAnnadan(parts) : ({} as Record<string, string>);
  const billingFlat = billing ? toAnnadan(billing) : ({} as Record<string, string>);
  const hkmvPrasadamObject = parts
    ? {
        doorNo: parts.door ?? undefined,
        house: parts.house ?? undefined,
        street: parts.street ?? undefined,
        area: parts.area ?? undefined,
        city: parts.city ?? undefined,
        state: parts.state ?? undefined,
        pincode: parts.pincode ?? undefined,
        country: parts.country ?? 'India',
      }
    : input.prasadamAddress
    ? // Nothing structured to send, so the whole string goes in street. That
      // still prints an address, where every-part-undefined prints "---".
      { street: input.prasadamAddress, country: 'India' }
    : undefined;
  // The donor's saved address, when nothing was typed on the form.
  const hkmvBillingObject =
    billing && Object.values(billing).some(Boolean)
      ? {
          doorNo: billing.door ?? undefined,
          house: billing.house ?? undefined,
          street: billing.street ?? undefined,
          area: billing.area ?? undefined,
          city: billing.city ?? undefined,
          state: billing.state ?? undefined,
          pincode: billing.pincode ?? undefined,
          country: billing.country ?? 'India',
        }
      : undefined;

  if (site === 'annadan') {
    return {
      name: input.donorName,
      mobile: input.donorMobile,
      email: input.donorEmail || '',
      amount: input.amount,
      offlineRefNo: input.referenceNo,
      offlinePaymentMode: ANNADAN_MODES[input.paymentMode] || 'other',
      paymentDate: input.paymentDate || undefined,
      certificate: !!input.wantCertificate,
      panNumber: input.panNumber || '',
      occasion: input.sevaName || '',
      mahaprasadam: !!input.wantPrasadam,
      // Who the box is for. annadan's Prasadam tab lists these columns, and
      // they were blank on everything DRM sent.
      ...(input.wantPrasadam ? { prasadamName: input.donorName, prasadamMobile: input.donorMobile } : {}),
      ...(input.gatewayPaymentId ? { razorpayPaymentId: input.gatewayPaymentId } : {}),
      // annadan keeps the address flat on the donation and its receipt reads
      // address/city/state/pincode separately, so sending only a blob is what
      // makes that receipt print ", ,  - ".
      prasadamAddress: input.wantPrasadam ? input.prasadamAddress || '' : '',
      ...(input.wantPrasadam && prasadamFlat.city ? { prasadamCity: prasadamFlat.city } : {}),
      ...(input.wantPrasadam && prasadamFlat.state ? { prasadamState: prasadamFlat.state } : {}),
      ...(input.wantPrasadam && prasadamFlat.pincode ? { prasadamPincode: prasadamFlat.pincode } : {}),
      address: billingFlat.address ?? input.prasadamAddress ?? '',
      ...(billingFlat.city ? { city: billingFlat.city } : {}),
      ...(billingFlat.state ? { state: billingFlat.state } : {}),
      ...(billingFlat.pincode ? { pincode: billingFlat.pincode } : {}),
      // annadan's offline controller destructures both of these by exactly
      // these names (offline.donation.controller.js:19) and stores them on the
      // donation, where the receipt and the birthday wish both read them. The
      // mobile decides who the wish goes to: with it the honoree is messaged
      // directly, without it the donor is messaged about them.
      sevakName: input.sevakName || undefined,
      sevakMobile: input.sevakMobile || undefined,
      enteredByName: input.enteredByName || undefined,
      dccEnrolledById: input.dccEnrolledById ?? undefined,
    };
  }

  return {
    donorName: input.donorName,
    donorMobile: input.donorMobile,
    donorEmail: input.donorEmail || undefined,
    amount: input.amount,
    utrNumber: input.referenceNo,
    manualPaymentMode: HKMV_MODES[input.paymentMode] || 'bank',
    paymentDate: input.paymentDate || undefined,
    sevaName: input.sevaName || undefined,
    type: input.sevaName || 'Manual Entry',
    panNumber: input.panNumber || undefined,
    certificate: !!input.wantCertificate,
    wantPrasadam: !!input.wantPrasadam,
    // The object shape HKMV's schema and receipt template expect. HKMV has no
    // separate billing address - the receipt and DCC both read this one - so
    // it is sent for 80G as well as for prasadam. wantPrasadam alone decides
    // whether a box is sent; an address without it is just the address.
    prasadamAddress: sendAddress ? hkmvPrasadamObject ?? hkmvBillingObject : undefined,
    prasadamAddressText: sendAddress ? input.prasadamAddress || undefined : undefined,
    ...(input.gatewayPaymentId ? { razorpayPaymentId: input.gatewayPaymentId } : {}),
    // createManual destructures `sevakName` (donation.controller.js:433) and
    // writes it onto the donation, which is what receipt.service.js prints in
    // place of the "---" it has been printing until now.
    //
    // The honoree's PHONE is deliberately not sent. HKMV has no field for it -
    // neither createManual's destructure nor the donation schema mentions
    // sevakMobile - so Mongoose would drop it on the way in, and a reader of
    // this payload would reasonably conclude the number had reached the site.
    // That is the same false impression dccEnrolledById above has been giving,
    // and once was enough. HKMV also has no birthday wish to feed, so nothing
    // is lost by leaving it out; if a field is added there, add it here.
    sevakName: input.sevakName || undefined,
    manualEntryNote: input.note || undefined,
    enteredByName: input.enteredByName || undefined,
    dccEnrolledById: input.dccEnrolledById ?? undefined,
  };
}

export async function createOfflineDonation(
  site: SiteKey,
  input: OfflineDonationInput
): Promise<OfflineDonationResult> {
  const res = await siteFetch(getSite(site), '/api/internal/drm/donations/offline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildOfflineBody(site, input)),
  });

  // Typed loosely on purpose: the two sites answer with different shapes and
  // an error body is different again, so every field is read defensively below.
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (!res.ok) {
    // The sites' own refusals are the useful ones - a duplicate reference
    // number, a missing field, a DCC failure. Pass the site's wording through
    // rather than flattening it to "request failed", and carry the status so a
    // duplicate (409) stays a duplicate to the caller.
    const message =
      (typeof body?.message === 'string' && body.message) ||
      (typeof body?.error === 'string' && body.error) ||
      `${siteLabelFor(site)} did not accept this (${res.status}).`;
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }

  // The two sites return different shapes. annadan answers with the receipt
  // number at the top level; HKMV returns the whole donation document.
  const donation = (body?.donation ?? {}) as Record<string, unknown>;
  const pick = (a: unknown, b: unknown): string | null => {
    if (typeof a === 'string' && a) return a;
    if (typeof b === 'string' && b) return b;
    return null;
  };

  return {
    externalId: pick(body?.donationId ? String(body.donationId) : null, donation?._id ? String(donation._id) : null),
    receiptNumber: pick(body?.receiptNumber, donation?.receiptNumber),
    donorName: pick(body?.donorName, donation?.donorName) ?? input.donorName,
    amount:
      typeof body?.amount === 'number'
        ? body.amount
        : typeof donation?.amount === 'number'
        ? donation.amount
        : input.amount,
    raw: body,
  };
}

function siteLabelFor(site: SiteKey): string {
  return site === 'annadan' ? 'The annadan site' : 'The main site';
}

/* --------------------------------------------------- abandoned donations */

export interface AbandonedDonation {
  externalId: string;
  name: string | null;
  mobile: string | null;
  email: string | null;
  amount: number | null;
  purpose: string | null;
  sourcePage: string | null;
  status: string;
  attemptedAt: string;
  sourceSite: SiteKey;
}

export interface AbandonedPage {
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  donations: AbandonedDonation[];
}

/**
 * Donations someone started on a site and never finished.
 *
 * These are the best leads the temple has: the person had already decided to
 * give and got as far as the payment screen. Most abandonments are a failed UPI
 * app or a distracted moment rather than a change of mind, so a call recovers a
 * real share of them.
 *
 * `minMinutes` guards against calling someone who is still on the payment page:
 * a record is only "abandoned" once it has sat incomplete for that long. An
 * hour is the default on both sites.
 */
export async function fetchAbandonedPage(
  siteKey: SiteKey,
  opts: { page?: number; limit?: number; since?: string | null; minMinutes?: number } = {}
): Promise<AbandonedPage> {
  const site = getSite(siteKey);
  const q = new URLSearchParams({
    page: String(opts.page ?? 1),
    limit: String(opts.limit ?? 200),
    minMinutes: String(opts.minMinutes ?? 60),
  });
  if (opts.since) q.set('since', opts.since);

  const res = await siteFetch(site, `/api/internal/drm/abandoned?${q.toString()}`);
  if (!res.ok) {
    throw new Error(`${site.label} did not respond (${res.status}). Try again.`);
  }
  const body = (await res.json()) as AbandonedPage;
  return { ...body, donations: body.donations ?? [] };
}

/* ----------------------------------------------------- prasadam write-back */

export interface PrasadamWriteBack {
  status: 'pending' | 'shipped' | 'delivered' | 'cancelled';
  courierName?: string | null;
  trackingNumber?: string | null;
  deliveredAt?: string | null;
  markedByName?: string | null;
  /** Ask the site to WhatsApp the donor. Off unless a human chose it. */
  notify?: boolean;
}

export interface PrasadamWriteBackResult {
  /** The site accepted and stored the status. */
  applied: boolean;
  /** The site sent the donor a message as part of this call. */
  notified: boolean;
  /** The site's own wording, worth showing when applied is false. */
  message: string | null;
}

/**
 * Pushes a prasadam status set in DRM back to the site the donation came from.
 *
 * Why this exists: the sites have their own prasadam screens, and until now the
 * sync ran one way only. Staff marking a box delivered here left it showing as
 * pending there, so anyone working from the site's own list would courier it a
 * second time.
 *
 * The two sites can't record the same things. HKMV has the full
 * pending/dispatched/delivered/cancelled lifecycle; annadan has only
 * pending/delivered, so it stores a shipped box as pending-with-tracking and
 * refuses "cancelled" outright. Both answer with `applied`, and a false there
 * is NOT an error - it is the site saying, accurately, that it cannot represent
 * this state. The caller records that and moves on.
 */
export async function updatePrasadamStatus(
  site: SiteKey,
  externalDonationId: string,
  input: PrasadamWriteBack
): Promise<PrasadamWriteBackResult> {
  const cfg = getSite(site);
  const res = await siteFetch(cfg, `/api/internal/drm/donations/${externalDonationId}/prasadam-status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: input.status,
      courierName: input.courierName ?? undefined,
      trackingNumber: input.trackingNumber ?? undefined,
      deliveredAt: input.deliveredAt ?? undefined,
      markedByName: input.markedByName ?? undefined,
      // Explicitly false rather than omitted: the sites treat a missing value
      // as "don't send", and being explicit means a future default change on
      // their side can't start messaging donors behind DRM's back.
      notify: input.notify === true,
    }),
  });

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (!res.ok || body?.success === false) {
    const message =
      (typeof body?.message === 'string' && body.message) ||
      `${siteLabelFor(site)} did not update the prasadam status (${res.status}).`;
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }

  return {
    // HKMV's handler predates the `applied` flag and just returns success, so
    // a missing field means "yes, stored" rather than "no".
    applied: body?.applied === undefined ? true : body.applied === true,
    notified: body?.notified === true,
    message: typeof body?.message === 'string' ? body.message : null,
  };
}

/* ------------------------------------------------------- profile write-back */

export interface ProfileWriteBack {
  name?: string | null;
  email?: string | null;
  pan?: string | null;
  address?: Record<string, string>;
}

export interface ProfileWriteBackResult {
  /** Whether the site actually stored it. False is a real answer, not an error. */
  applied: boolean;
  message: string | null;
  /** annadan only: which donation the address was written onto. */
  donationId?: string | null;
}

/**
 * Push a corrected profile out to a site.
 *
 * WHAT EACH SITE CAN ACTUALLY ACCEPT
 * HKMV has a donor collection, so a profile edit is a profile edit: name,
 * email, PAN and savedAddress all land on the donor record and every future
 * receipt and prasadam label picks them up.
 *
 * annadan has NO donor collection. A donor there is a phone number that
 * several donations happen to share, and an address lives on each donation
 * row. So there is nothing to write a profile to, and the honest thing is to
 * update the most recent donation - which is what the next receipt reprint and
 * any pending delivery will read - and to leave older donations exactly as the
 * receipts that were already issued describe them.
 *
 * That difference is why this returns `applied` rather than throwing on a
 * partial write: "annadan took the address but has nowhere to put a PAN" is
 * information the screen should show, not a failure.
 */
export async function updateDonorProfile(
  site: SiteKey,
  phone: string,
  input: ProfileWriteBack
): Promise<ProfileWriteBackResult> {
  const cfg = getSite(site);
  const res = await siteFetch(cfg, `/api/internal/drm/donors/by-mobile/${encodeURIComponent(phone)}/profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: input.name ?? undefined,
      email: input.email ?? undefined,
      panNumber: input.pan ?? undefined,
      address: input.address && Object.keys(input.address).length ? input.address : undefined,
    }),
  });

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (!res.ok || body?.success === false) {
    const message =
      (typeof body?.message === 'string' && body.message) ||
      `${siteLabelFor(site)} did not update the donor details (${res.status}).`;
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }

  return {
    applied: body?.applied === undefined ? true : body.applied === true,
    message: typeof body?.message === 'string' ? body.message : null,
    donationId: typeof body?.donationId === 'string' ? body.donationId : null,
  };
}
