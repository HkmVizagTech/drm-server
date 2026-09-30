// Reconciling donor identities across DRM, HKMV and annadan.
//
// WHY THIS IS A ROUTE AND NOT PART OF THE ORDINARY SYNC
// The ordinary sync fixes a donor when something about them changes. It cannot
// fix the donors who are ALREADY wrong, because nothing about them is going to
// change - they have been sitting with the wrong spelling since whichever site
// reached them first, and no future donation will correct it.
//
// So this is a sweep. It walks both sites, compares every name and address
// against what DRM holds, and applies the same rules the live sync now uses.
// Run once it repairs the backlog; run again it finds nothing, which is how a
// reconciliation should behave.
//
// IT REPORTS BEFORE IT WRITES. A dry run is the default, because "347 donors
// will be renamed" is a sentence somebody should read before it happens rather
// than after.

import { Router } from 'express';
import pool from '../db/pool';
import { authenticate, authorize } from '../middleware/auth';
import { configuredSites, fetchDonorPage, fetchTransactionPage, type SiteKey } from '../services/hkmvClient';
import { decideName, mergeIncomingProfile, pushProfileToSites } from '../services/profileSync';
import { fromAnnadan, fromHkmvSaved, isEmptyAddress } from '../utils/address';

const router = Router();
router.use(authenticate);

const norm = (p: string) => String(p ?? '').replace(/\D/g, '').slice(-10);

interface Candidate {
  phone: string;
  name: string | null;
  site: SiteKey;
  address: ReturnType<typeof fromHkmvSaved> | null;
  updatedAt: string | null;
}

/**
 * Everything both sites currently believe about who these donors are.
 *
 * Paged rather than fetched whole: the real donor list runs to tens of
 * thousands, and a sweep that needs all of it in memory is a sweep that falls
 * over on the day it matters.
 */
async function collectCandidates(maxPages: number): Promise<Map<string, Candidate[]>> {
  const by = new Map<string, Candidate[]>();
  const add = (c: Candidate) => {
    if (!c.phone || c.phone.length !== 10) return;
    const list = by.get(c.phone) ?? [];
    list.push(c);
    by.set(c.phone, list);
  };

  for (const site of configuredSites()) {
    try {
      if (site.key === 'hkmv') {
        for (let page = 1; page <= maxPages; page++) {
          const r = await fetchDonorPage('hkmv', page, 200);
          // Each entry wraps the donor alongside their donations, so the
          // identity is one level in.
          for (const entry of r.donors ?? []) {
            const d = entry.donor;
            if (!d) continue;
            add({
              phone: norm(d.mobile ?? ''),
              name: d.name ?? null,
              site: 'hkmv',
              address: fromHkmvSaved((d.savedAddress ?? null) as Record<string, unknown> | null),
              updatedAt: (d as unknown as { updatedAt?: string }).updatedAt ?? null,
            });
          }
          if (!r.donors?.length || r.donors.length < 200) break;
        }
      } else {
        // annadan has no donor collection, so identity comes from the
        // donations themselves - the same grouping-by-phone its own internal
        // API does. The LAST donation for a number is the freshest thing that
        // number ever said about itself.
        let cursor: string | null = null;
        for (let page = 0; page < maxPages; page++) {
          const r = await fetchTransactionPage('annadan', cursor, 200);
          for (const t of r.transactions ?? []) {
            const d = t.donation as unknown as Record<string, unknown>;
            add({
              phone: norm(t.donor?.mobile ?? ''),
              name: t.donor?.name ?? null,
              site: 'annadan',
              address: fromAnnadan({
                address: d.address,
                city: d.city,
                state: d.state,
                pincode: d.pincode,
              }),
              updatedAt: (d.createdAt as string) ?? null,
            });
          }
          cursor = r.nextCursor ?? null;
          if (!cursor) break;
        }
      }
    } catch (e) {
      // One site being unreachable must not abandon the other's corrections.
      console.error(`profiles.collect ${site.key} error:`, (e as Error).message);
    }
  }

  return by;
}

/**
 * POST /reconcile - find and optionally fix donors the sites disagree about.
 *
 * Defaults to a dry run. Pass { apply: true } to write.
 */
router.post('/reconcile', authorize('admin'), async (req, res) => {
  const apply = req.body?.apply === true;
  const maxPages = Math.min(200, Number(req.body?.max_pages) || 50);

  try {
    const candidates = await collectCandidates(maxPages);
    if (!candidates.size) {
      return res.status(503).json({ error: 'No donation site answered. Check the site settings and try again.' });
    }

    const phones = [...candidates.keys()];
    const known = await pool.query(
      `SELECT id, name, phone, name_edited_at, profile_synced_at,
              address_door, address_house, address_street, address_area,
              address_city, address_state, address_pincode, address_country
         FROM people
        WHERE right(regexp_replace(phone,'\\D','','g'), 10) = ANY($1::text[])`,
      [phones]
    );

    const changes: {
      id: string;
      phone: string;
      from: string | null;
      to: string;
      site: string;
      other: string | null;
      edited_here: boolean;
    }[] = [];
    let addressesFilled = 0;

    for (const p of known.rows) {
      const phone = norm(p.phone);
      const list = (candidates.get(phone) ?? []).slice();
      if (!list.length) continue;

      // Newest first, so decideName folds them in oldest-to-newest and the
      // freshest spelling is the one standing at the end.
      list.sort((a, b) => {
        const at = a.updatedAt ? Date.parse(a.updatedAt) : 0;
        const bt = b.updatedAt ? Date.parse(b.updatedAt) : 0;
        return at - bt;
      });

      let name: string | null = p.name;
      let alt: string | null = null;
      let altSource: string | null = null;
      let conflict = false;
      for (const c of list) {
        const d = decideName(name, c.name, c.site);
        if (d.conflict) {
          conflict = true;
          alt = d.alt;
          altSource = d.altSource;
        }
        name = d.name;
      }

      const freshest = list[list.length - 1];
      const drmHasAddress = !isEmptyAddress({
        door: p.address_door, house: p.address_house, street: p.address_street, area: p.address_area,
        city: p.address_city, state: p.address_state, pincode: p.address_pincode, country: p.address_country,
      });
      const canFillAddress = !drmHasAddress && freshest.address && !isEmptyAddress(freshest.address);

      if (name && name !== p.name) {
        changes.push({
          id: p.id,
          phone,
          from: p.name,
          to: name,
          site: freshest.site,
          other: alt,
          // Worth surfacing separately: a name somebody typed in DRM being
          // replaced by a site is the one case where this sweep might be doing
          // the wrong thing, and the person running it should see the count.
          edited_here: !!p.name_edited_at,
        });
      }
      if (canFillAddress) addressesFilled++;

      if (apply) {
        await mergeIncomingProfile(
          p.id,
          {
            name,
            address: canFillAddress ? freshest.address : null,
            updatedAt: freshest.updatedAt,
          },
          freshest.site
        );
        if (conflict && alt) {
          await pool.query(
            `UPDATE people SET name_alt = $2, name_alt_source = $3, name_conflict_at = NOW() WHERE id = $1`,
            [p.id, alt, altSource]
          );
        }
      }
    }

    res.json({
      applied: apply,
      checked: known.rows.length,
      sites_seen: [...new Set([...candidates.values()].flat().map((c) => c.site))],
      names_to_fix: changes.length,
      addresses_to_fill: addressesFilled,
      edited_here_count: changes.filter((c) => c.edited_here).length,
      // Capped: this is a preview for a person to read, not a data export.
      examples: changes.slice(0, 50),
    });
  } catch (err) {
    console.error('profiles.reconcile error:', err);
    res.status(500).json({ error: 'Could not reconcile the donor names' });
  }
});

/** GET /conflicts - donors the sites still disagree about. */
router.get('/conflicts', async (_req, res) => {
  try {
    const rows = await pool.query(
      `SELECT id, name, name_alt, name_alt_source, name_conflict_at, phone,
              name_edited_at, profile_source
         FROM people
        WHERE name_alt IS NOT NULL
        ORDER BY name_conflict_at DESC NULLS LAST
        LIMIT 200`
    );
    res.json({ conflicts: rows.rows });
  } catch (err) {
    console.error('profiles.conflicts error:', err);
    res.status(500).json({ error: 'Could not load the name conflicts' });
  }
});

/**
 * POST /:id/keep-name - settle one conflict by choosing a spelling.
 *
 * `which` is "current" or "alt". Whichever is chosen becomes the name, the
 * conflict is cleared, and the decision is pushed out so the sites stop
 * disagreeing rather than re-raising it on the next sync.
 */
router.post('/:id/keep-name', async (req, res) => {
  const which = String(req.body?.which ?? 'current');
  try {
    const r = await pool.query(
      `UPDATE people SET
         name = CASE WHEN $2 = 'alt' THEN COALESCE(name_alt, name) ELSE name END,
         name_alt = NULL, name_alt_source = NULL, name_conflict_at = NULL,
         name_edited_at = NOW(),
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, which]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Person not found' });

    void pushProfileToSites(r.rows[0]).catch((e) => console.error('profiles.push error:', e));
    res.json(r.rows[0]);
  } catch (err) {
    console.error('profiles.keepName error:', err);
    res.status(500).json({ error: 'Could not save that' });
  }
});

/** POST /:id/push - send this donor's details to the sites again, by hand. */
router.post('/:id/push', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM people WHERE id = $1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Person not found' });
    await pushProfileToSites(r.rows[0]);
    const after = await pool.query(
      `SELECT push_status, push_error, pushed_at FROM people WHERE id = $1`,
      [req.params.id]
    );
    res.json(after.rows[0]);
  } catch (err) {
    console.error('profiles.push error:', err);
    res.status(500).json({ error: 'Could not send that to the sites' });
  }
});

export default router;
