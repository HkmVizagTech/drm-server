// The temple's WhatsApp contacts (Flaxxa), searchable from the chat screen.
//
// Flaxxa will not list its contacts on demand (159,000 of them, 100 to a page), so they are copied
// into wa_contacts by a background sync - safe to run again, one at a time, gentle on Flaxxa (a short
// pause between pages) and visible: the screen shows how far it has got. Searching then happens in
// DRM, joined with the donors DRM already knows.

import pool from '../db/pool';
import { isValidKey, phoneKey } from './whatsappChat';

const PAGE_SIZE = 100;
const PAUSE_MS = 120;
let running = false;

export interface ContactPage {
  total: number;
  contacts: { id?: number; name?: string; phone?: string }[];
}
export type ContactPager = (page: number) => Promise<ContactPage>;

/** One page from Flaxxa, tried three times. */
export const flaxxaPager: ContactPager = async (page) => {
  const token = process.env.FLAXXA_TOKEN;
  if (!token) throw new Error('FLAXXA_TOKEN is not set');
  let last = 'unknown error';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`https://wapi.flaxxa.com/api/v1/getContacts?token=${encodeURIComponent(token)}&page=${page}&limit=${PAGE_SIZE}`, { signal: AbortSignal.timeout(30000) });
      const body = (await res.json()) as { status?: string; total?: number; contacts?: ContactPage['contacts'] };
      if (body.status !== 'success' || !Array.isArray(body.contacts)) throw new Error(`Flaxxa answered "${body.status ?? res.status}"`);
      return { total: Number(body.total) || 0, contacts: body.contacts };
    } catch (e) {
      last = (e as Error).message;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw new Error(last);
};

export async function syncStatus() {
  const r = await pool.query(`SELECT status, page, pages, total, imported, error, started_at, finished_at FROM wa_contact_sync WHERE id = 1`);
  const n = await pool.query(`SELECT COUNT(*)::int AS n FROM wa_contacts`);
  return { ...r.rows[0], stored: n.rows[0].n };
}

/** Copy every contact. Returns false if one is already running. Never throws. */
export async function syncContacts(pager: ContactPager = flaxxaPager, pause = PAUSE_MS): Promise<boolean> {
  if (running) return false;
  running = true;
  try {
    await pool.query(`UPDATE wa_contact_sync SET status = 'running', page = 0, pages = 0, total = 0, imported = 0, error = NULL, started_at = NOW(), finished_at = NULL WHERE id = 1`);
    let page = 1;
    let pages = 1;
    let imported = 0;
    while (page <= pages) {
      const got = await pager(page);
      pages = Math.max(1, Math.ceil(got.total / PAGE_SIZE));
      const byKey = new Map<string, { name: string; id: number | null }>();
      for (const c of got.contacts) {
        const key = phoneKey(c.phone);
        if (!isValidKey(key)) continue;
        const name = String(c.name ?? '').trim().slice(0, 200);
        byKey.set(key, { name: name === key ? '' : name, id: Number.isFinite(Number(c.id)) ? Number(c.id) : null });
      }
      if (byKey.size) {
        const keys = [...byKey.keys()];
        await pool.query(
          `INSERT INTO wa_contacts (phone, name, flaxxa_id)
           SELECT * FROM UNNEST($1::varchar[], $2::varchar[], $3::bigint[])
           ON CONFLICT (phone) DO UPDATE SET name = COALESCE(NULLIF(EXCLUDED.name, ''), wa_contacts.name), flaxxa_id = EXCLUDED.flaxxa_id, synced_at = NOW()`,
          [keys, keys.map((k) => byKey.get(k)!.name), keys.map((k) => byKey.get(k)!.id)]
        );
        imported += keys.length;
      }
      await pool.query(`UPDATE wa_contact_sync SET page = $1, pages = $2, total = $3, imported = $4 WHERE id = 1`, [page, pages, got.total, imported]);
      page++;
      if (page <= pages && pause) await new Promise((r) => setTimeout(r, pause));
    }
    await pool.query(`UPDATE wa_contact_sync SET status = 'done', finished_at = NOW() WHERE id = 1`);
  } catch (e) {
    console.error('wa contact sync failed:', (e as Error).message);
    await pool.query(`UPDATE wa_contact_sync SET status = 'failed', error = $1, finished_at = NOW() WHERE id = 1`, [(e as Error).message.slice(0, 300)]).catch(() => undefined);
  } finally {
    running = false;
  }
  return true;
}

export interface FoundContact {
  phone: string;
  name: string | null;
  in_drm: boolean;
  person_id: string | null;
}

/** Donors in DRM first, then the temple's WhatsApp contacts; one row per number. */
export async function searchContacts(q: string, limit = 20): Promise<FoundContact[]> {
  const text = q.trim();
  if (text.length < 2) return [];
  const digits = text.replace(/\D/g, '');
  const byDigits = digits.length >= 4 && digits.length >= text.replace(/\s/g, '').length - 2; // "98765 4" is a number, "ravi 99" is a name
  const like = `%${text.replace(/[%_\\]/g, '\\$&')}%`;
  const people = await pool.query(
    byDigits
      ? `SELECT id, name, RIGHT(regexp_replace(phone, '\\D', '', 'g'), 10) AS key FROM people WHERE hidden_at IS NULL AND regexp_replace(phone, '\\D', '', 'g') LIKE $1 ORDER BY name LIMIT $2`
      : `SELECT id, name, RIGHT(regexp_replace(phone, '\\D', '', 'g'), 10) AS key FROM people WHERE hidden_at IS NULL AND name ILIKE $1 ORDER BY name LIMIT $2`,
    [byDigits ? `%${digits}%` : like, limit]
  );
  const wa = await pool.query(
    byDigits
      ? `SELECT phone, name FROM wa_contacts WHERE phone LIKE $1 ORDER BY name NULLS LAST LIMIT $2`
      : `SELECT phone, name FROM wa_contacts WHERE name ILIKE $1 ORDER BY name LIMIT $2`,
    [byDigits ? `%${digits}%` : like, limit]
  );
  const out = new Map<string, FoundContact>();
  for (const p of people.rows as { id: string; name: string; key: string }[]) {
    if (isValidKey(p.key) && !out.has(p.key)) out.set(p.key, { phone: p.key, name: p.name, in_drm: true, person_id: p.id });
  }
  for (const c of wa.rows as { phone: string; name: string | null }[]) {
    if (!out.has(c.phone)) out.set(c.phone, { phone: c.phone, name: c.name || null, in_drm: false, person_id: null });
  }
  return [...out.values()].slice(0, limit);
}
