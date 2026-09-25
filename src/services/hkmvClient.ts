// Client for hkmsite2.0-server's internal service API (the main donation
// site / donor portal, a separate Mongo/Express app at D:\projects\HKMV).
// Lets DRM pull the real donor identity, donation/receipt history,
// recurring subscriptions, and prasadam delivery status for a phone number
// instead of maintaining a second copy of that logic here.
//
// Auth: shared-secret header (x-internal-secret), same convention
// hkmsite2.0-server already uses for its own /api/internal/* endpoints.
// HKMV_API_URL / HKMV_INTERNAL_SECRET must be set to matching values in
// both apps' env for this to work - see server/.env.

// Normalize whatever is in the env var into a usable absolute base URL.
// A value pasted without a scheme (e.g. "example.up.railway.app") makes
// fetch() throw "Failed to parse URL" rather than doing anything useful, and
// a trailing slash produces a double slash in every request path - so fix
// both here instead of depending on the env var being typed perfectly.
function normalizeBaseUrl(raw: string): string {
  const trimmed = (raw || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

const HKMV_API_URL = normalizeBaseUrl(process.env.HKMV_API_URL || '');
const HKMV_INTERNAL_SECRET = process.env.HKMV_INTERNAL_SECRET || '';

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
  status: 'pending' | 'active' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  isRecurring: boolean;
  subscriptionId?: string | null;
  receiptNumber?: string | null;
  receiptIssuedAt?: string | null;
  prasadam?: HkmvPrasadam | null;
}

export interface HkmvSubscription {
  subscriptionId: string;
  sevaName: string;
  amount: number;
  status: 'pending' | 'active' | 'completed' | 'cancelled' | 'failed';
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
  };
  donations?: HkmvDonation[];
  subscriptions?: HkmvSubscription[];
}

function assertConfigured() {
  if (!HKMV_API_URL || !HKMV_INTERNAL_SECRET) {
    throw new Error(
      'HKMV_API_URL / HKMV_INTERNAL_SECRET are not set - cannot reach hkmsite2.0-server. Set both in server/.env.'
    );
  }
}

// Same normalization donations.ts and index.ts already use for phone
// numbers, kept in sync with those so the same donor matches on both sides.
function normalizeMobile(phone: string): string {
  return phone.replace(/\s+/g, '').replace(/^\+?91/, '');
}

export async function fetchDonorSnapshot(phone: string): Promise<HkmvDonorSnapshot> {
  assertConfigured();
  const mobile = normalizeMobile(phone);
  const res = await fetch(`${HKMV_API_URL}/api/internal/donors/by-mobile/${encodeURIComponent(mobile)}`, {
    headers: { 'x-internal-secret': HKMV_INTERNAL_SECRET },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`hkmsite2.0 internal API returned ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<HkmvDonorSnapshot>;
}

// Streams the real 80G receipt PDF straight through from hkmsite2.0-server
// for a donation that was synced in from there (identified by its Mongo
// _id, stored as donations.external_ref). Returns the raw fetch Response
// so the caller can pipe headers/body without buffering the whole PDF.
export async function fetchReceiptPdf(externalDonationId: string): Promise<Response> {
  assertConfigured();
  const res = await fetch(`${HKMV_API_URL}/api/internal/donations/${externalDonationId}/receipt.pdf`, {
    headers: { 'x-internal-secret': HKMV_INTERNAL_SECRET },
  });
  return res;
}

function formatHkmvAddress(a?: NonNullable<HkmvPrasadam['address']> | null): string | null {
  if (!a) return null;
  const parts = [a.doorNo, a.house, a.street, a.area, a.city, a.state, a.pincode, a.country].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function formatSavedAddress(a?: { street?: string; city?: string; state?: string; pincode?: string; country?: string } | null): string | null {
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

// DRM's purpose/sevaName columns are VARCHAR(30) - hkmsite2.0's seva names
// are free text and can run longer, so truncate rather than risk an insert
// failing outright on a long festival/seva title.
function truncate30(s: string): string {
  return (s || 'general').slice(0, 30);
}

export const hkmvMappers = {
  formatHkmvAddress,
  formatSavedAddress,
  PRASADAM_STATUS_MAP,
  SUBSCRIPTION_STATUS_MAP,
  truncate30,
};
