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
import { hkmvMappers, HkmvDonation, HkmvSubscription } from './hkmvClient';

export interface HkmvDonorPayload {
  externalId?: string;
  donorId?: string;
  name?: string;
  mobile?: string;
  email?: string | null;
  panNumber?: string | null;
  savedAddress?: { street?: string; city?: string; state?: string; pincode?: string; country?: string } | null;
  donorSince?: string;
}

export interface DonorSnapshotInput {
  donor?: HkmvDonorPayload;
  donations?: HkmvDonation[];
  subscriptions?: HkmvSubscription[];
}

export interface SyncCounts {
  personId: string;
  created: boolean;
  donationsSynced: number;
  subscriptionsSynced: number;
  deliveriesSynced: number;
}

// Must match the normalization used in hkmvClient.ts and the public lookup
// route, or the same donor ends up as two different people rows.
export function normalizePhone(phone: string): string {
  return String(phone || '').replace(/\s+/g, '').replace(/^\+?91/, '');
}

async function upsertPerson(client: PoolClient, donor: HkmvDonorPayload): Promise<{ id: string; created: boolean }> {
  const phone = normalizePhone(donor.mobile || '');
  if (!phone) throw new Error('Donor snapshot has no usable mobile number');

  const formattedAddress = hkmvMappers.formatSavedAddress(donor.savedAddress ?? null);

  // COALESCE(people.x, EXCLUDED.x) - existing DRM values win. Staff may have
  // corrected a name or address here by hand; a routine sync from the website
  // must not silently overwrite that work. Blank DRM fields get filled in.
  const result = await client.query(
    `INSERT INTO people (name, phone, email, pan, prasadam_address, roles, created_at)
     VALUES ($1, $2, $3, $4, $5, ARRAY['donor']::TEXT[], COALESCE($6::timestamptz, NOW()))
     ON CONFLICT (phone) DO UPDATE SET
       email            = COALESCE(people.email, EXCLUDED.email),
       pan              = COALESCE(people.pan, EXCLUDED.pan),
       prasadam_address = COALESCE(people.prasadam_address, EXCLUDED.prasadam_address),
       roles            = CASE WHEN 'donor' = ANY(people.roles)
                               THEN people.roles
                               ELSE array_append(people.roles, 'donor') END,
       updated_at       = NOW()
     RETURNING id, (xmax = 0) AS created`,
    [
      donor.name || `Donor ${phone}`,
      phone,
      donor.email ?? null,
      donor.panNumber ?? null,
      formattedAddress,
      donor.donorSince ?? null,
    ]
  );

  return { id: result.rows[0].id, created: result.rows[0].created };
}

async function upsertDonation(
  client: PoolClient,
  personId: string,
  d: HkmvDonation,
  fallbackAddress: string | null
): Promise<{ donationId: string; deliveryUpserted: boolean }> {
  const donationResult = await client.query(
    `INSERT INTO donations (person_id, amount, type, purpose, payment_mode, source, receipt_generated, receipt_number, receipt_issued_at, external_ref, created_at)
     VALUES ($1, $2, $3, $4, 'upi', 'website', $5, $6, $7, $8, $9)
     ON CONFLICT (external_ref) DO UPDATE SET
       amount            = EXCLUDED.amount,
       receipt_generated = EXCLUDED.receipt_generated,
       receipt_number    = EXCLUDED.receipt_number,
       receipt_issued_at = EXCLUDED.receipt_issued_at
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
        `INSERT INTO prasadam_deliveries (person_id, donation_id, address, status, courier_name, tracking_number, dispatched_at, delivered_at, external_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
        ]
      );
      deliveryUpserted = true;
    }
  }

  return { donationId, deliveryUpserted };
}

async function upsertSubscription(client: PoolClient, personId: string, s: HkmvSubscription): Promise<void> {
  const status = hkmvMappers.SUBSCRIPTION_STATUS_MAP[s.status] || 'active';
  await client.query(
    `INSERT INTO subscriptions (person_id, amount, frequency, purpose, status, gateway_subscription_id, start_date, external_ref)
     VALUES ($1, $2, 'monthly', $3, $4, $5, $6, $7)
     ON CONFLICT (external_ref) DO UPDATE SET
       amount     = EXCLUDED.amount,
       status     = EXCLUDED.status,
       updated_at = NOW()`,
    [personId, s.amount, hkmvMappers.truncate30(s.sevaName), status, s.subscriptionId, s.startedAt, s.subscriptionId]
  );
}

// Upserts one donor's entire snapshot in a single transaction, so a failure
// part-way through can't leave a donor half-imported.
export async function upsertDonorSnapshot(snapshot: DonorSnapshotInput): Promise<SyncCounts> {
  if (!snapshot.donor) throw new Error('Snapshot has no donor');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { id: personId, created } = await upsertPerson(client, snapshot.donor);
    const fallbackAddress = hkmvMappers.formatSavedAddress(snapshot.donor.savedAddress ?? null);

    let donationsSynced = 0;
    let deliveriesSynced = 0;

    for (const d of snapshot.donations || []) {
      // DRM's ledger tracks confirmed gifts only - pending/failed/cancelled
      // attempts on the live site aren't real contributions here.
      if (d.status !== 'completed') continue;
      const { deliveryUpserted } = await upsertDonation(client, personId, d, fallbackAddress);
      donationsSynced++;
      if (deliveryUpserted) deliveriesSynced++;
    }

    let subscriptionsSynced = 0;
    for (const s of snapshot.subscriptions || []) {
      await upsertSubscription(client, personId, s);
      subscriptionsSynced++;
    }

    await client.query('COMMIT');
    return { personId, created, donationsSynced, subscriptionsSynced, deliveriesSynced };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
