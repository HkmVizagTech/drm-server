// Shared upsert path for donor data coming from hkmsite2.0.
//
// Three different things feed donor data into DRM:
//   1. the per-donor "Sync from HKMV" button   (pull, one donor)
//   2. the bulk backfill import                (pull, every donor)
//   3. the live webhook from hkmsite2.0        (push, one donor, on donation)
//
// All three hand the SAME snapshot shape to upsertDonorSnapshot() below, so
// there is exactly one place where HKMV data becomes DRM rows. Keeping this
// unified is what makes the push and pull paths agree - three hand-written
// copies of this mapping would inevitably drift.
//
// Everything here is idempotent: people are keyed by phone, and donations /
// subscriptions / prasadam deliveries are keyed by external_ref (the Mongo
// _id or Razorpay subscription id from hkmsite2.0). Re-running an import, or
// receiving the same webhook twice, updates rows in place instead of
// creating duplicates.

import type { PoolClient } from 'pg';
import pool from '../db/pool';
import { hkmvMappers, HkmvDonation, HkmvSubscription, HkmvTransaction, SiteKey } from './hkmvClient';

export interface HkmvDonorPayload {
  externalId?: string;
  donorId?: string;
  name?: string;
  mobile?: string;
  email?: string | null;
  panNumber?: string | null;
  savedAddress?: { street?: string; city?: string; state?: string; pincode?: string; country?: string } | null;
  donorSince?: string;
  sourceSite?: SiteKey | null;
}

export interface DonorSnapshotInput {
  donor?: HkmvDonorPayload;
  donations?: HkmvDonation[];
  subscriptions?: HkmvSubscription[];
}

export interface SyncCounts {
  personId: string;
  site: SiteKey;
  created: boolean;
  donationsSynced: number;
  subscriptionsSynced: number;
  deliveriesSynced: number;
}

// The single definition of "same donor".
//
// The source sites store the same number several ways - +919951141915,
// 919951141915, 9951141915, sometimes with spaces - and DRM keys people by
// phone. So every one of those spellings has to collapse to the same 10-digit
// key, or one donor becomes three people rows with their giving split between
// them. The country code is only stripped when what remains is exactly 10
// digits, so a genuinely different number that happens to start with 91 is
// left alone.
export function normalizePhone(phone: string): string {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  if (digits.length > 10 && digits.startsWith('91') && digits.length - 2 === 10) {
    return digits.slice(2);
  }
  // Anything longer still (an international number, or junk) keeps its last 10
  // digits, which is what the source sites' own lookups match on.
  return digits.length > 10 ? digits.slice(-10) : digits;
}

async function upsertPerson(
  client: PoolClient,
  donor: HkmvDonorPayload,
  site: SiteKey
): Promise<{ id: string; created: boolean }> {
  const phone = normalizePhone(donor.mobile || '');
  if (!phone) throw new Error('Donor snapshot has no usable mobile number');

  const formattedAddress = hkmvMappers.formatSavedAddress(donor.savedAddress ?? null);

  // COALESCE(people.x, EXCLUDED.x) - existing DRM values win. Staff may have
  // corrected a name or address here by hand; a routine sync from the website
  // must not silently overwrite that work. Blank DRM fields get filled in.
  const result = await client.query(
    `INSERT INTO people (name, phone, email, pan, prasadam_address, roles, source_sites, created_at)
     VALUES ($1, $2, $3, $4, $5, ARRAY['donor']::TEXT[], ARRAY[$7]::TEXT[], COALESCE($6::timestamptz, NOW()))
     ON CONFLICT (phone) DO UPDATE SET
       email            = COALESCE(people.email, EXCLUDED.email),
       pan              = COALESCE(people.pan, EXCLUDED.pan),
       prasadam_address = COALESCE(people.prasadam_address, EXCLUDED.prasadam_address),
       roles            = CASE WHEN 'donor' = ANY(people.roles)
                               THEN people.roles
                               ELSE array_append(people.roles, 'donor') END,
       -- A donor can give through both sites; record every site they've used
       -- rather than letting the most recent sync overwrite the other.
       source_sites     = CASE WHEN $7 = ANY(people.source_sites)
                               THEN people.source_sites
                               ELSE array_append(people.source_sites, $7) END,
       updated_at       = NOW()
     RETURNING id, (xmax = 0) AS created`,
    [
      donor.name || `Donor ${phone}`,
      phone,
      donor.email ?? null,
      donor.panNumber ?? null,
      formattedAddress,
      donor.donorSince ?? null,
      site,
    ]
  );

  return { id: result.rows[0].id, created: result.rows[0].created };
}

async function upsertDonation(
  client: PoolClient,
  personId: string,
  d: HkmvDonation,
  fallbackAddress: string | null,
  site: SiteKey
): Promise<{ donationId: string; deliveryUpserted: boolean }> {
  const donationResult = await client.query(
    `INSERT INTO donations (
       person_id, amount, type, purpose, payment_mode, source, receipt_generated,
       receipt_number, receipt_issued_at, external_ref, created_at,
       source_site, source_page, campaign, utm_source, utm_medium, utm_campaign, payment_ref)
     VALUES ($1, $2, $3, $4, 'upi', 'website', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (external_ref) DO UPDATE SET
       amount            = EXCLUDED.amount,
       receipt_generated = EXCLUDED.receipt_generated,
       receipt_number    = EXCLUDED.receipt_number,
       receipt_issued_at = EXCLUDED.receipt_issued_at,
       source_site       = EXCLUDED.source_site,
       source_page       = EXCLUDED.source_page,
       campaign          = EXCLUDED.campaign,
       utm_source        = EXCLUDED.utm_source,
       utm_medium        = EXCLUDED.utm_medium,
       utm_campaign      = EXCLUDED.utm_campaign,
       payment_ref       = EXCLUDED.payment_ref
     RETURNING id`,
    [
      personId,
      d.amount,
      d.isRecurring ? 'recurring' : 'one-time',
      hkmvMappers.truncate30(d.type),
      !!d.receiptNumber,
      d.receiptNumber ?? null,
      d.receiptIssuedAt ?? null,
      d.externalId,
      d.createdAt,
      d.sourceSite || site,
      hkmvMappers.truncate(d.sourcePage, 120),
      hkmvMappers.truncate(d.campaign, 120),
      hkmvMappers.truncate(d.utm?.source, 80),
      hkmvMappers.truncate(d.utm?.medium, 80),
      hkmvMappers.truncate(d.utm?.campaign, 120),
      hkmvMappers.truncate(d.paymentRef, 80),
    ]
  );

  const donationId = donationResult.rows[0].id;
  let deliveryUpserted = false;

  if (d.prasadam) {
    const status = hkmvMappers.PRASADAM_STATUS_MAP[d.prasadam.status] || 'pending';
    const address = hkmvMappers.formatHkmvAddress(d.prasadam.address) || fallbackAddress;
    // prasadam_deliveries.address is NOT NULL - a prasadam request with no
    // address anywhere can't be represented, so skip it rather than fail the
    // whole donor's sync over one incomplete record.
    if (address) {
      await client.query(
        `INSERT INTO prasadam_deliveries (person_id, donation_id, address, status, courier_name, tracking_number, dispatched_at, delivered_at, external_ref, source_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (external_ref) DO UPDATE SET
           status          = EXCLUDED.status,
           courier_name    = EXCLUDED.courier_name,
           tracking_number = EXCLUDED.tracking_number,
           dispatched_at   = EXCLUDED.dispatched_at,
           delivered_at    = EXCLUDED.delivered_at`,
        [
          personId,
          donationId,
          address,
          status,
          d.prasadam.courierName ?? null,
          d.prasadam.trackingNumber ?? null,
          d.prasadam.dispatchedAt ?? null,
          d.prasadam.deliveredAt ?? null,
          d.externalId,
          site,
        ]
      );
      deliveryUpserted = true;
    }
  }

  return { donationId, deliveryUpserted };
}

async function upsertSubscription(
  client: PoolClient,
  personId: string,
  s: HkmvSubscription,
  site: SiteKey
): Promise<void> {
  const status = hkmvMappers.SUBSCRIPTION_STATUS_MAP[s.status] || 'active';
  await client.query(
    `INSERT INTO subscriptions (person_id, amount, frequency, purpose, status, gateway_subscription_id, start_date, external_ref, source_site)
     VALUES ($1, $2, 'monthly', $3, $4, $5, $6, $7, $8)
     ON CONFLICT (external_ref) DO UPDATE SET
       amount      = EXCLUDED.amount,
       status      = EXCLUDED.status,
       source_site = EXCLUDED.source_site,
       updated_at  = NOW()`,
    [personId, s.amount, hkmvMappers.truncate30(s.sevaName), status, s.subscriptionId, s.startedAt, s.subscriptionId, site]
  );
}

// Upserts one donor's entire snapshot in a single transaction, so a failure
// part-way through can't leave a donor half-imported.
export async function upsertDonorSnapshot(
  snapshot: DonorSnapshotInput,
  site: SiteKey = 'hkmv'
): Promise<SyncCounts> {
  if (!snapshot.donor) throw new Error('Snapshot has no donor');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { id: personId, created } = await upsertPerson(client, snapshot.donor, site);

    // Address to fall back on when a prasadam record carries none of its own.
    // Reads the PERSON row rather than only this snapshot: with transaction
    // feeds the donor's address can arrive on a different page than the
    // prasadam gift, and prasadam_deliveries.address is NOT NULL - so relying
    // on the batch alone silently drops deliveries depending on page
    // boundaries. The person row has already been upserted above, so it
    // carries whatever address any earlier page supplied.
    const personRow = await client.query(
      'SELECT COALESCE(prasadam_address, address) AS addr FROM people WHERE id = $1',
      [personId]
    );
    const fallbackAddress =
      hkmvMappers.formatSavedAddress(snapshot.donor.savedAddress ?? null) ||
      personRow.rows[0]?.addr ||
      null;

    let donationsSynced = 0;
    let deliveriesSynced = 0;

    for (const d of snapshot.donations || []) {
      // DRM's ledger tracks confirmed gifts only - pending/failed/cancelled
      // attempts on the live site aren't real contributions here.
      if (d.status !== 'completed') continue;
      const { deliveryUpserted } = await upsertDonation(client, personId, d, fallbackAddress, site);
      donationsSynced++;
      if (deliveryUpserted) deliveriesSynced++;
    }

    let subscriptionsSynced = 0;
    for (const s of snapshot.subscriptions || []) {
      await upsertSubscription(client, personId, s, site);
      subscriptionsSynced++;
    }

    await client.query('COMMIT');
    return { personId, site, created, donationsSynced, subscriptionsSynced, deliveriesSynced };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface BatchCounts {
  // Unique people upserted in this batch. Note the caller accumulates this
  // across pages, so the same donor appearing on two pages counts twice at the
  // import level - the import route de-duplicates with a Set for its total.
  donorsTouched: number;
  peopleCreated: number;
  donationsSynced: number;
  subscriptionsSynced: number;
  deliveriesSynced: number;
  failures: { mobile?: string; name?: string; error: string }[];
  // The normalised numbers touched, so the caller can count distinct donors
  // across pages instead of double-counting one who spans a page boundary.
  mobiles?: string[];
}

// Upserts a page of raw transactions.
//
// This is the counterpart to a source site that stores transactions rather
// than donors: instead of asking that site to group its whole collection into
// donors (an expensive aggregation on a live donation database), it hands over
// flat rows and the grouping happens here, on data DRM already has in memory.
//
// Grouping key is the NORMALISED phone number, so +919951141915 and
// 9951141915 land on the same person - the same rule the people table is keyed
// by, so a donor who gives through both sites ends up as one record with one
// combined giving history.
//
// Ordering matters for subscriptions: the feed arrives oldest-first, so when
// several charges of one subscription appear, the newest one is written last
// and its status and amount win.
export async function upsertTransactionBatch(
  transactions: HkmvTransaction[],
  site: SiteKey
): Promise<BatchCounts> {
  const counts: BatchCounts = {
    donorsTouched: 0,
    peopleCreated: 0,
    donationsSynced: 0,
    subscriptionsSynced: 0,
    deliveriesSynced: 0,
    failures: [],
  };

  const byPerson = new Map<string, DonorSnapshotInput>();

  for (const txn of transactions) {
    if (!txn?.donor?.mobile) continue;
    const key = normalizePhone(txn.donor.mobile);
    if (!key) continue;

    let group = byPerson.get(key);
    if (!group) {
      group = { donor: { ...txn.donor, mobile: key }, donations: [], subscriptions: [] };
      byPerson.set(key, group);
    } else {
      // Later rows are newer, so they win for contact details - but only where
      // they actually carry a value. A transaction with a blank PAN must not
      // erase one an earlier transaction supplied.
      const d = group.donor!;
      d.name = txn.donor.name || d.name;
      d.email = txn.donor.email || d.email;
      d.panNumber = txn.donor.panNumber || d.panNumber;
      d.savedAddress = txn.donor.savedAddress || d.savedAddress;
      // donorSince is the EARLIEST gift, so it moves backwards only.
      if (txn.donor.donorSince && (!d.donorSince || txn.donor.donorSince < d.donorSince)) {
        d.donorSince = txn.donor.donorSince;
      }
    }

    group.donations!.push(txn.donation);
    if (txn.subscription) {
      // One row per subscription id within the batch; the last (newest) wins.
      const subs = group.subscriptions!;
      const idx = subs.findIndex((s) => s.subscriptionId === txn.subscription!.subscriptionId);
      if (idx === -1) subs.push(txn.subscription);
      else subs[idx] = txn.subscription;
    }
  }

  for (const [mobile, snapshot] of byPerson) {
    try {
      const result = await upsertDonorSnapshot(snapshot, site);
      counts.donorsTouched++;
      if (result.created) counts.peopleCreated++;
      counts.donationsSynced += result.donationsSynced;
      counts.subscriptionsSynced += result.subscriptionsSynced;
      counts.deliveriesSynced += result.deliveriesSynced;
    } catch (err) {
      // One bad donor must not cost the rest of the batch.
      counts.failures.push({ mobile, name: snapshot.donor?.name, error: (err as Error).message });
    }
  }

  counts.mobiles = Array.from(byPerson.keys());
  return counts;
}
