// Keeping a donor's own details straight across three systems.
//
// THE SITUATION
// A donor can change their address in three places and DRM is only one of them:
//
//   HKMV   they sign in to the donor portal and edit it themselves
//          (PATCH /donor/me - name, email, PAN, savedAddress)
//   annadan they type it into the form with each donation, so it is whatever
//          they typed most recently, and there is no profile to edit
//   DRM    an admin corrects it after a phone call
//
// None of those knew about the others. A donor who fixed their address on HKMV
// in March still had the old one on a DRM receipt in September.
//
// TWO DIRECTIONS, DIFFERENT RULES
//
// PULLING IN is newest-wins, per field, and the comparison is against when the
// SITE last changed it - not when DRM last ran a sync, which is a fact about
// the cron schedule rather than about the donor.
//
// PUSHING OUT happens when an admin saves in DRM. HKMV takes the whole profile.
// annadan has no donor record at all, so the address goes onto their most
// recent donation - the one a receipt reprint or a pending delivery will
// actually read - and older donations are left matching the receipts already
// issued against them.
//
// NAMES ARE THE AWKWARD ONE, and get their own rules below.

import pool from '../db/pool';
import {
  configuredSites,
  isSiteConfigured,
  updateDonorProfile,
  type SiteKey,
} from './hkmvClient';
import {
  addressFromRow,
  isEmptyAddress,
  toAnnadan,
  toHkmvSaved,
  type Address,
} from '../utils/address';

/* ----------------------------------------------------------------- names */

export interface NameDecision {
  name: string;
  alt: string | null;
  altSource: string | null;
  conflict: boolean;
}

/**
 * Which spelling of a donor's name to keep.
 *
 * THE BUG THIS FIXES
 * The people upsert never touched `name` on conflict, so whichever site synced
 * a donor first named them permanently. That is how DRM came to call somebody
 * "Myakal Srikanth" while annadan had "Myakala Srikanth" the whole time. It
 * was not a truncation or an encoding fault - it was a first write that
 * nothing could ever correct.
 *
 * Two things are NOT treated as changes at all, because calling them one would
 * put a warning on half the donor list:
 *
 *   - a placeholder. "Donor 9876543210" is what DRM invents when a site sends
 *     no name at all, and a real name must always beat it.
 *   - the same name spelled with different spacing or case.
 *
 * WHAT CHANGED, AND WHY IT IS NO LONGER "NEWEST WINS"
 * A second real name on one phone used to replace the first. The old comment
 * here called that a disagreement and guessed, correctly, that it was "usually
 * a shared family number" - but it still resolved it by overwriting, so the
 * donor's own name was lost the first time a daughter gave in her mother's
 * name. It is not a disagreement and there is nothing to resolve: a phone in
 * an Indian household belongs to a family, and both names are real.
 *
 * So the FIRST name stays. The incoming one is returned as `alt` and the
 * caller writes it to person_names, where the full list lives - see
 * services/personNames.ts. `alt` keeps feeding the Name differences screen,
 * which is now a place to notice a typo rather than a queue of errors.
 */
export function decideName(
  current: string | null,
  incoming: string | null,
  incomingSource: string
): NameDecision {
  const cur = (current ?? '').trim();
  const inc = (incoming ?? '').trim();

  if (!inc) return { name: cur, alt: null, altSource: null, conflict: false };
  if (!cur) return { name: inc, alt: null, altSource: null, conflict: false };

  const isPlaceholder = (n: string) => /^donor\s*\d{6,}$/i.test(n);
  if (isPlaceholder(cur)) return { name: inc, alt: null, altSource: null, conflict: false };
  if (isPlaceholder(inc)) return { name: cur, alt: null, altSource: null, conflict: false };

  // Same name, typed differently. "  RAVI  das " and "Ravi Das" are one person
  // with one name, and flagging that would be noise.
  const key = (n: string) => n.toLowerCase().replace(/\s+/g, ' ').trim();
  if (key(cur) === key(inc)) {
    // Keep the better-looking one: a name in ALL CAPS or all lower case is
    // nearly always the machine's version of a name somebody typed properly.
    const looksTyped = (n: string) => n !== n.toUpperCase() && n !== n.toLowerCase();
    return {
      name: looksTyped(cur) || !looksTyped(inc) ? cur : inc,
      alt: null,
      altSource: null,
      conflict: false,
    };
  }

  // A second real name on one phone. The donor's own name - the one already
  // here - stays primary; the new one is handed back for the names list.
  return { name: cur, alt: inc, altSource: incomingSource, conflict: true };
}

/* ------------------------------------------------------------- pushing out */

interface PersonRow {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  pan: string | null;
  source_sites: string[] | null;
  [key: string]: unknown;
}

/**
 * Send an admin's correction out to whichever sites know this donor.
 *
 * Never throws to the caller. The admin's save has already succeeded in DRM by
 * the time this runs, and a Mongo server being unreachable must not turn a
 * completed save into an error on their screen. What happened is recorded on
 * the row instead, and the person page shows it.
 */
export async function pushProfileToSites(person: PersonRow): Promise<void> {
  const phone = (person.phone ?? '').replace(/\D/g, '').slice(-10);
  if (!phone || phone.length !== 10) return;

  // Only the sites this donor is actually known to. Pushing a profile to a
  // site that has never heard of them would either do nothing or create a
  // donor record out of thin air, and neither is wanted.
  const known = new Set(person.source_sites ?? []);
  const targets = configuredSites().filter((s) => known.size === 0 || known.has(s.key));
  if (!targets.length) {
    await pool.query(
      `UPDATE people SET push_status = 'skipped', push_error = NULL, pushed_at = NOW() WHERE id = $1`,
      [person.id]
    );
    return;
  }

  const home = addressFromRow(person, 'address');
  const results: string[] = [];
  const failures: string[] = [];

  for (const site of targets) {
    try {
      const payload =
        site.key === 'annadan'
          ? { name: person.name, address: toAnnadan(home) }
          : { name: person.name, email: person.email, pan: person.pan, address: toHkmvSaved(home) };

      // Nothing to say. An address with no parts and no other change would ask
      // a site to overwrite a real address with emptiness.
      if (isEmptyAddress(home) && !person.name && !person.email && !person.pan) continue;

      const r = await updateDonorProfile(site.key as SiteKey, phone, payload);
      results.push(r.applied ? site.key : `${site.key} (not applied)`);
    } catch (e) {
      failures.push(`${site.label}: ${(e as Error).message}`);
    }
  }

  await pool.query(
    `UPDATE people SET
       push_status = $2,
       push_error  = $3,
       pushed_at   = NOW()
     WHERE id = $1`,
    [
      person.id,
      failures.length ? (results.length ? 'partial' : 'failed') : 'sent',
      failures.length ? failures.join(' · ') : null,
    ]
  );
}

/* -------------------------------------------------------------- pulling in */

export interface IncomingProfile {
  name?: string | null;
  email?: string | null;
  pan?: string | null;
  address?: Address | null;
  prasadamAddress?: Address | null;
  /** When the SITE last changed this, not when DRM fetched it. */
  updatedAt?: string | null;
}

/**
 * Merge what a site knows about a donor into DRM.
 *
 * Field by field, and the rules differ by field because the fields differ:
 *
 *   name     newest-wins with the loser kept - see decideName
 *   email,
 *   pan      fill a gap only. These are near enough to immutable that a change
 *            is more likely a typo on a donation form than a correction, and
 *            an admin can always set them by hand.
 *   address  newest-wins as a whole, never field by field. Half of March's
 *            address and half of September's is an address that has never
 *            existed and that a courier cannot find.
 */
export async function mergeIncomingProfile(
  personId: string,
  incoming: IncomingProfile,
  source: string
): Promise<{ nameChanged: boolean; addressChanged: boolean; conflict: boolean }> {
  const cur = await pool.query(`SELECT * FROM people WHERE id = $1`, [personId]);
  if (!cur.rows.length) return { nameChanged: false, addressChanged: false, conflict: false };
  const p = cur.rows[0];

  const decision = decideName(p.name, incoming.name ?? null, source);
  const nameChanged = decision.name !== p.name;

  const siteChangedAt = incoming.updatedAt ? new Date(incoming.updatedAt) : null;
  const drmKnownAt = p.profile_synced_at ? new Date(p.profile_synced_at) : null;
  // A site's address only wins if the site changed it since DRM last heard.
  // Without this every sync would overwrite an admin's correction with
  // whatever the site has had on file since 2023.
  const siteIsNewer = !drmKnownAt || (siteChangedAt !== null && siteChangedAt > drmKnownAt);

  const addr = incoming.address ?? null;
  const takeAddress = !!addr && !isEmptyAddress(addr) && (siteIsNewer || isEmptyAddress(addressFromRow(p, 'address')));

  await pool.query(
    `UPDATE people SET
       name             = $2,
       name_alt         = CASE WHEN $3::boolean THEN $4 ELSE name_alt END,
       name_alt_source  = CASE WHEN $3::boolean THEN $5 ELSE name_alt_source END,
       name_conflict_at = CASE WHEN $3::boolean THEN NOW() ELSE name_conflict_at END,
       email            = COALESCE(email, $6),
       pan              = COALESCE(pan, $7),
       address_door     = CASE WHEN $8::boolean THEN $9  ELSE address_door    END,
       address_house    = CASE WHEN $8::boolean THEN $10 ELSE address_house   END,
       address_street   = CASE WHEN $8::boolean THEN $11 ELSE address_street  END,
       address_area     = CASE WHEN $8::boolean THEN $12 ELSE address_area    END,
       address_city     = CASE WHEN $8::boolean THEN $13 ELSE address_city    END,
       address_state    = CASE WHEN $8::boolean THEN $14 ELSE address_state   END,
       address_pincode  = CASE WHEN $8::boolean THEN $15 ELSE address_pincode END,
       address_country  = CASE WHEN $8::boolean THEN $16 ELSE address_country END,
       profile_synced_at = NOW(),
       profile_source    = $17,
       updated_at        = NOW()
     WHERE id = $1`,
    [
      personId,
      decision.name,
      decision.conflict,
      decision.alt,
      decision.altSource,
      incoming.email ?? null,
      incoming.pan ?? null,
      takeAddress,
      addr?.door ?? null,
      addr?.house ?? null,
      addr?.street ?? null,
      addr?.area ?? null,
      addr?.city ?? null,
      addr?.state ?? null,
      addr?.pincode ?? null,
      addr?.country ?? null,
      source,
    ]
  );

  return { nameChanged, addressChanged: takeAddress, conflict: decision.conflict };
}

/** Whether any site is configured to sync profiles with. */
export const canSyncProfiles = (): boolean => configuredSites().length > 0;

export const siteConfigured = (key: SiteKey): boolean => isSiteConfigured(key);
