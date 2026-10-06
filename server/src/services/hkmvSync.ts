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
import { decideName } from './profileSync';
import { recordCredit } from './credits';
import { addressValues, fromHkmvSaved } from '../utils/address';

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
  if (!phone) throw new Error('Donor has no valid mobile number.');

  const formattedAddress = hkmvMappers.formatSavedAddress(donor.savedAddress ?? null);
  const structured = fromHkmvSaved((donor.savedAddress ?? null) as Record<string, unknown> | null);

  // THE NAME BUG THIS FIXES
  // This upsert used to leave `name` out of the DO UPDATE entirely. The
  // comment said existing DRM values win, but for a name it went further than
  // that: whichever site synced a donor FIRST named them, permanently, and no
  // later correction on either site could ever reach DRM. That is how a donor
  // annadan has always called "Myakala Srikanth" was "Myakal Srikanth" here.
  //
  // Newest now wins, decided in decideName() rather than in SQL, because the
  // interesting cases are not expressible as COALESCE: a placeholder must lose
  // to a real name, the same name in different case is not a disagreement, and
  // a genuine disagreement has to be recorded rather than resolved silently.
  const existing = await client.query(`SELECT name FROM people WHERE phone = $1`, [phone]);
  const decision = decideName(existing.rows[0]?.name ?? null, donor.name ?? null, site);
  const chosenName = decision.name || `Donor ${phone}`;

  // The rest keeps COALESCE(people.x, EXCLUDED.x): staff may have corrected an
  // email or a PAN here by hand, and a routine sync must not undo that.
  // Addresses are handled separately, by mergeIncomingProfile, which can see
  // WHEN the site last changed one.
  const result = await client.query(
    `INSERT INTO people (name, phone, email, pan, prasadam_address, roles, source_sites, created_at,
                         address_door, address_house, address_street, address_area,
                         address_city, address_state, address_pincode, address_country)
     VALUES ($1, $2, $3, $4, $5, ARRAY['donor']::TEXT[], ARRAY[$7]::TEXT[], COALESCE($6::timestamptz, NOW()),
             $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (phone) DO UPDATE SET
       name             = EXCLUDED.name,
       name_alt         = CASE WHEN $16::boolean THEN $17 ELSE people.name_alt END,
       name_alt_source  = CASE WHEN $16::boolean THEN $18 ELSE people.name_alt_source END,
       name_conflict_at = CASE WHEN $16::boolean THEN NOW() ELSE people.name_conflict_at END,
       email            = COALESCE(people.email, EXCLUDED.email),
       pan              = COALESCE(people.pan, EXCLUDED.pan),
       prasadam_address = COALESCE(people.prasadam_address, EXCLUDED.prasadam_address),
       -- Address parts fill gaps here and are only overwritten by
       -- mergeIncomingProfile, which knows when the site last changed them.
       address_door     = COALESCE(people.address_door,    EXCLUDED.address_door),
       address_house    = COALESCE(people.address_house,   EXCLUDED.address_house),
       address_street   = COALESCE(people.address_street,  EXCLUDED.address_street),
       address_area     = COALESCE(people.address_area,    EXCLUDED.address_area),
       address_city     = COALESCE(people.address_city,    EXCLUDED.address_city),
       address_state    = COALESCE(people.address_state,   EXCLUDED.address_state),
       address_pincode  = COALESCE(people.address_pincode, EXCLUDED.address_pincode),
       address_country  = COALESCE(people.address_country, EXCLUDED.address_country),
       roles            = CASE WHEN 'donor' = ANY(people.roles)
                               THEN people.roles
                               ELSE array_append(people.roles, 'donor') END,
       -- A donor can give through both sites; record every site they've used
       -- rather than letting the most recent sync overwrite the other.
       source_sites     = CASE WHEN $7 = ANY(people.source_sites)
                               THEN people.source_sites
                               ELSE array_append(people.source_sites, $7) END,
       profile_synced_at = NOW(),
       profile_source    = $7,
       updated_at       = NOW()
     RETURNING id, (xmax = 0) AS created`,
    [
      chosenName,
      phone,
      donor.email ?? null,
      donor.panNumber ?? null,
      formattedAddress,
      donor.donorSince ?? null,
      site,
      ...addressValues(structured),
      decision.conflict,
      decision.alt,
      decision.altSource,
    ]
  );

  return { id: result.rows[0].id, created: result.rows[0].created };
}

/**
 * Credit the caller whose link brought this donation in.
 *
 * THE ROUND TRIP, IN FULL
 * An admin assigns a link to a caller in Calling settings, which mints a
 * credit_token on that link. routes/crmLinks.ts appends the token to the
 * outgoing URL as utm_campaign - the only per-link field both websites forward
 * to DRM untouched. The donation arrives here still carrying it, and this
 * matches it back. Neither site knows a caller exists; this field is the whole
 * of the mechanism.
 *
 * WHY THE WHOLE THING IS WRAPPED
 * The donation is the money and the credit is bookkeeping, so nothing here may
 * cost the donation. A caller deleted mid-sync, a token matching a link whose
 * assignee is gone, a constraint nobody anticipated - any of those must end in
 * a logged line and a donation that still saved.
 *
 * A SAVEPOINT rather than a bare try/catch, because this runs inside the
 * donor's transaction: in Postgres a failed statement poisons the whole
 * transaction, so catching the error would not save anything - the very next
 * query in upsertDonorSnapshot would fail with "current transaction is
 * aborted" and the donor's entire snapshot would roll back. Rolling back to
 * the savepoint discards only the failed credit.
 */
async function creditAssignedLink(
  client: PoolClient,
  donation: {
    donationId: string;
    personId: string;
    amount: number | string;
    occurredAt: Date | string;
    utmCampaign: string | null;
  }
): Promise<void> {
  const token = String(donation.utmCampaign ?? '').trim();
  if (!token) return;

  try {
    await client.query('SAVEPOINT credit_link');

    // credit_user_id IS NOT NULL in the WHERE, not checked afterwards: a link
    // that has a token but nobody assigned is the normal state of a link that
    // was unassigned, and it must miss rather than credit anyone.
    const found = await client.query(
      `SELECT id, label, credit_user_id FROM crm_links
        WHERE credit_token = $1 AND credit_user_id IS NOT NULL`,
      [token]
    );
    // Most donations land here: every seeded link carries utm_campaign=calling
    // and donors arrive through campaigns DRM has never heard of. Not a match
    // is the ordinary case, not a problem, and says nothing worth logging.
    if (!found.rows.length) {
      await client.query('RELEASE SAVEPOINT credit_link');
      return;
    }
    const link = found.rows[0];

    await recordCredit(
      {
        kind: 'link',
        userId: link.credit_user_id,
        amount: donation.amount,
        // The day the money arrived, NOT now. A backfill that catches up a
        // week of donations on a Monday morning must credit each one on its
        // own day, or Monday's figure swallows the whole week and every daily
        // report for those days reads as zero.
        occurredAt: donation.occurredAt,
        donationId: donation.donationId,
        linkId: link.id,
        personId: donation.personId,
        note: `Donation through the link "${link.label}"`,
      },
      client
    );
    // recordCredit returns null when this donation is already credited, which
    // is what every re-sync of an already-imported donation does. Normal, and
    // deliberately not logged: a nightly backfill would otherwise fill the log
    // with thousands of lines that all mean "nothing to do".

    await client.query('RELEASE SAVEPOINT credit_link');
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT credit_link').catch(() => undefined);
    console.error(
      `[hkmvSync] donation ${donation.donationId} saved, but crediting its link failed:`,
      err
    );
  }
}

/**
 * A site's payment mode in DRM's words. Online payments stay "upi", which is
 * what every website donation has always been recorded as here, so reports
 * that split by mode do not suddenly grow an "online" row.
 */
function siteModeToDrm(mode: string | null | undefined): string | null {
  const m = String(mode ?? '').trim().toLowerCase();
  if (!m) return null;
  if (m === 'cash' || m === 'cheque') return m;
  if (m === 'bank' || m === 'bank_transfer' || m === 'neft' || m === 'imps' || m === 'rtgs') return 'bank';
  if (m === 'upi' || m === 'phonepe' || m === 'online' || m === 'qr') return 'upi';
  return 'other';
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
     VALUES ($1, $2, $3, $4, COALESCE($17, 'upi'), CASE WHEN $18::boolean THEN 'offline' ELSE 'website' END,
             $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (external_ref) DO UPDATE SET
       amount            = EXCLUDED.amount,
       -- Cash, cheque and bank donations entered on a site's own admin form
       -- came in here as "upi" from the "website", because the sites never
       -- said otherwise. They do now; a site that still does not say leaves
       -- what DRM already has.
       payment_mode      = COALESCE($17, donations.payment_mode),
       source            = CASE WHEN $18::boolean THEN 'offline' ELSE donations.source END,
       receipt_generated = EXCLUDED.receipt_generated,
       receipt_number    = EXCLUDED.receipt_number,
       receipt_issued_at = EXCLUDED.receipt_issued_at,
       source_site       = EXCLUDED.source_site,
       source_page       = EXCLUDED.source_page,
       campaign          = EXCLUDED.campaign,
       utm_source        = EXCLUDED.utm_source,
       utm_medium        = EXCLUDED.utm_medium,
       utm_campaign      = EXCLUDED.utm_campaign,
       -- COALESCE, not a plain overwrite: an offline donation carries a UTR
       -- or cheque number that DRM recorded at entry, and the source site has
       -- no payment reference of its own for a manual donation. A bare
       -- EXCLUDED.payment_ref would wipe that reference on the very next
       -- import, silently losing the only link back to the bank statement.
       payment_ref       = COALESCE(EXCLUDED.payment_ref, donations.payment_ref)
     -- amount, created_at and utm_campaign come back so the credit below is
     -- written from what the row actually says rather than from the snapshot
     -- in hand. They differ in the cases that matter: utm_campaign is
     -- truncated on the way in, and created_at is NOT in the DO UPDATE list,
     -- so on a re-sync it is still the moment the donation first arrived.
     RETURNING id, amount, created_at, utm_campaign`,
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
      siteModeToDrm(d.paymentMode),
      d.offline === true,
    ]
  );

  const donationId = donationResult.rows[0].id;
  let deliveryUpserted = false;

  await creditAssignedLink(client, {
    donationId,
    personId,
    amount: donationResult.rows[0].amount,
    occurredAt: donationResult.rows[0].created_at,
    utmCampaign: donationResult.rows[0].utm_campaign,
  });

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
         -- DRM wins once staff have touched the row.
         --
         -- The source sites have their own prasadam tracking, and nothing in
         -- DRM writes back to them, so the two will legitimately disagree: a
         -- delivery marked here stays "pending" on the site. A plain
         -- "status = EXCLUDED.status" would therefore let the very next import
         -- silently revert every delivery the temple staff marked - hundreds of
         -- rows of real work, undone by a background job, with no error.
         --
         -- marked_at is set by routes/prasadam.ts whenever a human (or a
         -- courier-file upload) sets a status in DRM. Once it is set, DRM is
         -- the authority on that row's status and timestamps; the site may
         -- still FILL IN blanks (a tracking number DRM never had) but may not
         -- overwrite or null out what is already there.
         --
         -- Until a row is marked here, the site remains the authority, and
         -- COALESCE stops a snapshot that omits a field from wiping it.
         ON CONFLICT (external_ref) DO UPDATE SET
           status = CASE WHEN prasadam_deliveries.marked_at IS NOT NULL
                         THEN prasadam_deliveries.status
                         ELSE EXCLUDED.status END,
           courier_name = CASE WHEN prasadam_deliveries.marked_at IS NOT NULL
                         THEN COALESCE(prasadam_deliveries.courier_name, EXCLUDED.courier_name)
                         ELSE COALESCE(EXCLUDED.courier_name, prasadam_deliveries.courier_name) END,
           tracking_number = CASE WHEN prasadam_deliveries.marked_at IS NOT NULL
                         THEN COALESCE(prasadam_deliveries.tracking_number, EXCLUDED.tracking_number)
                         ELSE COALESCE(EXCLUDED.tracking_number, prasadam_deliveries.tracking_number) END,
           dispatched_at = CASE WHEN prasadam_deliveries.marked_at IS NOT NULL
                         THEN COALESCE(prasadam_deliveries.dispatched_at, EXCLUDED.dispatched_at)
                         ELSE COALESCE(EXCLUDED.dispatched_at, prasadam_deliveries.dispatched_at) END,
           delivered_at = CASE WHEN prasadam_deliveries.marked_at IS NOT NULL
                         THEN COALESCE(prasadam_deliveries.delivered_at, EXCLUDED.delivered_at)
                         ELSE COALESCE(EXCLUDED.delivered_at, prasadam_deliveries.delivered_at) END`,
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
  if (!snapshot.donor) throw new Error('No donor found.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { id: personId, created } = await upsertPerson(client, snapshot.donor, site);

    // Address to fall back on when a prasadam record carries none of its own.
    // Reads the PERSON row rather than only this snapshot: with transaction
    // feeds the donor's address can arrive on a different page than the
    // prasadam donation, and prasadam_deliveries.address is NOT NULL - so relying
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
      // DRM's ledger tracks confirmed donations only - pending/failed/cancelled
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
      // donorSince is the EARLIEST donation, so it moves backwards only.
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
