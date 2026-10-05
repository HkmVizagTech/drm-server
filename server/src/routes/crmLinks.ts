// Saved links, and sending one to a donor on WhatsApp.
//
// WHAT THIS REPLACES
// "Shall I send you the link?" is said twenty times a day on the phone, and
// until now answering it meant leaving the call, finding the right seva page on
// the site, copying the URL, opening WhatsApp, finding the donor and typing a
// message. In practice callers said "search for our website" instead, and the
// donation did not happen.
//
// WHY CLICK-TO-CHAT AND NOT THE WHATSAPP BUSINESS API
// This opens the caller's OWN WhatsApp at that donor's chat with the message
// already written (https://wa.me/<number>?text=...). That means:
//   - no template to submit to Meta and wait on
//   - no per-message cost, and no Marketing category to worry about
//   - the caller sees the reply, because it lands in the app they are in
// The trade is that DRM cannot know whether the message was actually sent -
// the caller could close the window. So what is logged below is honestly
// recorded as "opened WhatsApp to send X", never as "sent".
//
// WHAT ACTUALLY COMES BACK, AND WHAT DOES NOT
// This header used to claim that a link carrying utm_content=<lead> "arrives
// back on the site tagged". It never did. Nothing was ever built to carry a
// lead id home, there is no utm_content column on donations, and HKMV drops
// its own utm.content before the snapshot reaches DRM. Anyone reading that
// sentence would have gone looking for per-lead attribution that does not
// exist, so it is written down here instead of quietly deleted.
//
// What DOES survive the round trip is utm_source, utm_medium and utm_campaign
// - both sites forward those three untouched, and donations store all three.
// So utm_source=call still does the one job it was put on the seeded links to
// do: a donation that a phone call produced stops looking identical to one
// that arrived on its own.
//
// CREDITING A CALLER rides on the same three fields. A link assigned to a
// caller gets a credit_token, the token is appended to the outgoing URL as
// utm_campaign (see send-link below), and services/hkmvSync.ts matches it back
// when the donation syncs. utm_campaign is used because it is the only field
// of the three that is per-link rather than per-channel, and because it needs
// no change to either website.

import { Router } from 'express';
import { randomBytes } from 'crypto';
import pool from '../db/pool';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();
router.use(authenticate);

const str = (v: unknown, max = 255): string | null => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};

/**
 * Fill {tokens} in a URL or a message.
 *
 * Unknown tokens are left exactly as they are rather than blanked. If someone
 * saves a link with {campaign} and DRM does not know that word, showing
 * "{campaign}" in the box tells the caller something is wrong; silently
 * sending a URL with a hole in it does not.
 */
function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : whole
  );
}

/* ------------------------------------------------------------------- links */

/**
 * GET /links - what this caller can send.
 *
 * Shared links plus their own. Ordered by sort_order and then by how often each
 * is actually used, so the two or three a caller sends all day rise to the top
 * instead of staying wherever they were first typed.
 */
router.get('/links', async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT l.*, u.name AS owner_name, cu.name AS credit_user_name
         FROM crm_links l
         LEFT JOIN users u ON l.owner_user_id = u.id
         -- Who the money goes to, which is a different person from the owner
         -- often enough to be worth naming: a link sits in the shared list for
         -- everyone to send and still credits one caller.
         LEFT JOIN users cu ON l.credit_user_id = cu.id
        WHERE l.active
          AND (l.owner_user_id IS NULL OR l.owner_user_id = $1::uuid)
        -- A caller's OWN presets first, then the temple's shared ones. They
        -- set theirs up for the campaign they are working, so those are the
        -- ones they reach for; burying them under nine shared links means
        -- scrolling past the temple's whole catalogue on every call.
        ORDER BY (l.owner_user_id IS NULL), l.sort_order, l.use_count DESC, lower(l.label)`,
      [req.user?.userId ?? null]
    );
    res.json({ links: rows.rows });
  } catch (err) {
    console.error('crm.listLinks error:', err);
    res.status(500).json({ error: 'Could not load the saved links' });
  }
});

// Everything, including other people's and retired ones - the settings screen.
router.get('/links/all', async (_req, res) => {
  try {
    const rows = await pool.query(
      `SELECT l.*, u.name AS owner_name, cu.name AS credit_user_name
         FROM crm_links l
         LEFT JOIN users u ON l.owner_user_id = u.id
         LEFT JOIN users cu ON l.credit_user_id = cu.id
        ORDER BY l.sort_order, lower(l.label)`
    );
    res.json({ links: rows.rows });
  } catch (err) {
    console.error('crm.listAllLinks error:', err);
    res.status(500).json({ error: 'Could not load the saved links' });
  }
});

router.post('/links', async (req, res) => {
  const b = req.body ?? {};
  const label = str(b.label, 80);
  const url = str(b.url, 2000);
  if (!label) return res.status(400).json({ error: 'Give the link a name' });
  if (!url) return res.status(400).json({ error: 'Paste the link' });
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Link must start with http:// or https://' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO crm_links (label, url, site, seva_name, message, owner_user_id, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5,$6::uuid,COALESCE($7::int, 500),$8::uuid)
       -- Null rather than absent, so every response that carries a link has the
       -- same shape and a screen reading credit_user_name does not have to tell
       -- "nobody is assigned" apart from "this endpoint forgot to say".
       RETURNING *, NULL::text AS credit_user_name`,
      [
        label,
        url,
        str(b.site, 20),
        str(b.seva_name, 120),
        str(b.message, 2000),
        // "Just for me" keeps one caller's experiment out of everyone's
        // dropdown; shared is the default because most links are the temple's,
        // not one person's.
        b.shared === false ? req.user?.userId ?? null : null,
        b.sort_order ?? null,
        req.user?.userId ?? null,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('crm.createLink error:', err);
    res.status(500).json({ error: 'Could not save that link' });
  }
});

router.put('/links/:id', async (req, res) => {
  const b = req.body ?? {};
  try {
    const refusal = await assertMayEdit(req.params.id, req.user?.userId ?? null);
    if (refusal) return res.status(refusal === 'Link not found' ? 404 : 403).json({ error: refusal });

    const result = await pool.query(
      `WITH upd AS (
         UPDATE crm_links SET
           label      = COALESCE($1, label),
           url        = COALESCE($2, url),
           site       = COALESCE($3, site),
           seva_name  = COALESCE($4, seva_name),
           message    = COALESCE($5, message),
           sort_order = COALESCE($6::int, sort_order),
           active     = COALESCE($7::boolean, active),
           updated_at = NOW()
         WHERE id = $8 RETURNING *
       )
       SELECT upd.*, cu.name AS credit_user_name
         FROM upd LEFT JOIN users cu ON cu.id = upd.credit_user_id`,
      [
        str(b.label, 80),
        str(b.url, 2000),
        str(b.site, 20),
        str(b.seva_name, 120),
        str(b.message, 2000),
        b.sort_order ?? null,
        typeof b.active === 'boolean' ? b.active : null,
        req.params.id,
      ]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Link not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('crm.updateLink error:', err);
    res.status(500).json({ error: 'Could not save that link' });
  }
});

router.delete('/links/:id', async (req, res) => {
  try {
    const refusal = await assertMayEdit(req.params.id, req.user?.userId ?? null);
    if (refusal) return res.status(refusal === 'Link not found' ? 404 : 403).json({ error: refusal });

    const result = await pool.query(`DELETE FROM crm_links WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Link not found' });
    res.json({ deleted: true });
  } catch (err) {
    console.error('crm.deleteLink error:', err);
    res.status(500).json({ error: 'Could not delete that link' });
  }
});

/**
 * Who may change a link.
 *
 * A personal preset belongs to one caller and nobody else may touch it - not
 * out of secrecy, but because a preset someone tuned for the campaign they are
 * working should not change under them mid-shift.
 *
 * Shared links stay editable by anyone, deliberately: this is a small temple
 * team where everyone is an admin, and a permission wall would mean waiting for
 * one person to add a festival page. The UI keeps the two clearly apart so
 * editing a shared link is a choice rather than an accident.
 */
async function assertMayEdit(id: string, userId: string | null): Promise<string | null> {
  const owned = await pool.query(`SELECT owner_user_id FROM crm_links WHERE id = $1`, [id]);
  if (!owned.rows.length) return 'Link not found';
  const owner = owned.rows[0].owner_user_id as string | null;
  if (owner && owner !== userId) return "That is someone else's own preset, so it can't be changed from here.";
  return null;
}

/* --------------------------------------------------------- crediting one */

/**
 * The token a donation comes home carrying.
 *
 * Short, because a caller reads it off a WhatsApp message and an admin has to
 * be able to say it down a phone line; a 32-character hex string invites
 * transcription errors in exactly the place a mistake is silent - the money
 * just lands unattributed.
 *
 * Prefixed "drm-" so it is obviously ours. This value is visible to the donor
 * as utm_campaign in the address bar, and without the prefix it is a short
 * nonsense word sitting where a campaign name belongs - which is how somebody
 * "tidying up" a link ends up deleting the only thing attributing the money.
 * The prefix also makes the token greppable in a server log and tells anybody
 * reading the site's analytics that this is not a campaign they should expect
 * to find in a report.
 *
 * The alphabet omits 0/1/i/l/o: those are the pairs that get misread when a
 * token is read aloud or retyped from a screenshot. Ten characters of 31 is
 * about 49 bits; against a table of a few hundred links a collision is not
 * something that happens, and if it somehow did the unique index turns it into
 * a failed assignment the admin can see and retry rather than two links
 * quietly sending one caller's money to another.
 */
const TOKEN_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

function mintCreditToken(): string {
  const bytes = randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  return `drm-${out}`;
}

/**
 * PUT /links/:id/credit - say whose money this link raises.
 *
 * Body { user_id } to assign, { user_id: null } to unassign.
 *
 * WHY THIS DOES NOT GO THROUGH assertMayEdit
 * That check exists so a preset one caller tuned for the campaign they are
 * working cannot change under them mid-shift, and it refuses everybody but the
 * owner - correctly, for editing a link's wording or its URL. Assigning credit
 * is the opposite kind of act: it decides who gets paid attention for the money
 * a link brings in, which is an admin's call about somebody else by definition.
 * Routing it through assertMayEdit would mean an admin could never assign a
 * caller's own preset to that caller, which is the common case.
 *
 * So the guard here is role, not ownership: admin only. Nothing else in this
 * file is admin-gated because nothing else in this file moves money.
 */
router.put('/links/:id/credit', authorize('admin'), async (req, res) => {
  const raw = req.body?.user_id;
  // Distinguish "unassign" from "you forgot the field". An absent user_id
  // silently clearing an assignment would quietly stop crediting a caller with
  // nothing on screen to show it had happened.
  if (raw === undefined) {
    return res.status(400).json({ error: 'Pick a caller.' });
  }
  const userId = raw === null || raw === '' ? null : String(raw);

  try {
    const existing = await pool.query(
      `SELECT id, credit_token FROM crm_links WHERE id = $1`,
      [req.params.id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Link not found' });

    if (userId) {
      const user = await pool.query(`SELECT id FROM users WHERE id = $1::uuid`, [userId]);
      if (!user.rows.length) return res.status(404).json({ error: 'Caller not found.' });
    }

    // THE TOKEN IS MINTED ONCE AND NEVER REISSUED.
    //
    // Every link already sent sits in some donor's WhatsApp history, and they
    // open those weeks later - that is most of what a saved link is for.
    // Changing the token would orphan all of them: the donation still arrives,
    // but its utm_campaign matches nothing and the money goes uncredited with
    // no error anywhere. So reassigning only moves credit_user_id, and a token
    // minted for the previous assignee keeps working for the new one.
    //
    // Unassigning leaves the token in place for the same reason: if the link is
    // assigned again later, the links already in the wild start crediting
    // again instead of being dead.
    const token = (existing.rows[0].credit_token as string | null) ?? (userId ? mintCreditToken() : null);

    const result = await pool.query(
      `WITH upd AS (
         UPDATE crm_links SET
           credit_user_id     = $2::uuid,
           credit_token       = COALESCE($3::varchar, credit_token),
           -- Only stamped when somebody is actually assigned, so these two
           -- keep answering "who assigned this, and when" rather than being
           -- overwritten by the unassignment that ended it.
           credit_assigned_at = CASE WHEN $2::uuid IS NULL THEN credit_assigned_at ELSE NOW() END,
           credit_assigned_by = CASE WHEN $2::uuid IS NULL THEN credit_assigned_by ELSE $4::uuid END,
           updated_at         = NOW()
         WHERE id = $1 RETURNING *
       )
       SELECT upd.*, cu.name AS credit_user_name
         FROM upd LEFT JOIN users cu ON cu.id = upd.credit_user_id`,
      [req.params.id, userId, token, req.user?.userId ?? null]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('crm.setLinkCredit error:', err);
    res.status(500).json({ error: 'Could not change the caller. Try again.' });
  }
});

/* ---------------------------------------------------------- sending one */

/**
 * Put the link's credit token on the outgoing URL, as utm_campaign.
 *
 * This is the whole mechanism by which a donation finds its way back to a
 * caller. utm_campaign is used because it is one of the three fields both
 * websites forward to DRM untouched, so this works today with no change to
 * either site - see the header of this file for what does NOT come back.
 *
 * Built with the URL API rather than by appending "&utm_campaign=...", because
 * the saved links are typed by hand in Calling settings and several of the
 * seeded ones already carry a query string. String concatenation gets the
 * first "?" versus "&" wrong on a link that has no params yet, and silently
 * buries the token inside the fragment on a link that ends in "#donate" - and
 * both failures look like a working link right up until nobody is credited.
 *
 * AN EXISTING utm_campaign IS OVERWRITTEN, deliberately. Every seeded link
 * carries utm_campaign=calling, which is a channel label the reports do not
 * read and nothing is attributed by. Keeping it would mean assigning a link to
 * a caller appears to work on screen and then credits nobody, which is the
 * worst of the available outcomes: the old value is a label, the token is the
 * money. The link's own campaign is still recoverable from utm_source and
 * utm_medium, which are left alone.
 *
 * A URL this cannot parse is returned exactly as it came in. POST /links
 * requires an http(s) scheme, but the url a caller can type into the send box
 * is only length-checked, and rows seeded or edited before that check existed
 * are not revalidated - so "harekrishnavizag.org/gau-seva" does reach here.
 * That send must still go out: losing the donation to save the bookkeeping is
 * the wrong way round.
 */
function withCreditToken(url: string, token: string | null): string {
  if (!token) return url;
  try {
    const u = new URL(url);
    u.searchParams.set('utm_campaign', token);
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * POST /leads/:id/send-link - work out the WhatsApp link, and record it.
 *
 * Returns the wa.me URL for the browser to open. Doing the substitution here
 * rather than in the browser is what keeps one donor's link identical whoever
 * sends it, and means the logged message is exactly the one that was opened.
 *
 * Recorded as "opened WhatsApp", not "sent". DRM hands the caller's own
 * WhatsApp a pre-filled message; whether they press send is not something this
 * can see, and a log that claims otherwise would make the follow-up reports
 * quietly wrong.
 */
router.post('/leads/:id/send-link', async (req, res) => {
  const b = req.body ?? {};

  try {
    const lead = await pool.query(
      `SELECT l.id, l.phone, l.name, l.expected_amount, u.name AS caller_name
         FROM leads l LEFT JOIN users u ON u.id = $2::uuid
        WHERE l.id = $1`,
      [req.params.id, req.user?.userId ?? null]
    );
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead not found' });
    const L = lead.rows[0];

    let link: Record<string, unknown> | null = null;
    if (b.link_id) {
      const found = await pool.query(`SELECT * FROM crm_links WHERE id = $1`, [b.link_id]);
      link = found.rows[0] ?? null;
      if (!link) return res.status(404).json({ error: 'Link not found.' });
    }

    const rawUrl = str(b.url, 2000) ?? (link?.url as string | undefined);
    if (!rawUrl) return res.status(400).json({ error: 'Pick a link to send' });

    const caller = String(L.caller_name ?? '').trim();
    const amount = b.amount ?? L.expected_amount ?? null;

    const url = withCreditToken(
      fill(rawUrl, {
        phone: L.phone,
        lead: String(L.id).slice(0, 8),
        caller: caller.replace(/\s+/g, '-').toLowerCase(),
      }),
      (link?.credit_token as string | null) ?? null
    );

    // A caller who edited the text in the box gets exactly what they typed.
    const rawMessage =
      str(b.message, 2000) ??
      (link?.message as string | undefined) ??
      'Hare Krishna {name}, here is the link: {link}';

    const message = fill(rawMessage, {
      name: (L.name as string | null)?.trim() || 'ji',
      link: url,
      seva: (link?.seva_name as string | undefined) ?? 'seva',
      amount: amount !== null && amount !== undefined ? `₹${Number(amount).toLocaleString('en-IN')}` : '',
      caller,
    });

    // Click-to-chat wants the country code, digits only. DRM stores the last
    // ten, the same identity rule everything else here uses.
    const waNumber = `91${String(L.phone).replace(/\D/g, '').slice(-10)}`;
    const mode = await pool.query(`SELECT value FROM crm_settings WHERE key = 'whatsapp_open_mode'`);
    const openMode = String(mode.rows[0]?.value ?? 'wa').replace(/"/g, '');

    const waUrl =
      openMode === 'desktop'
        ? `whatsapp://send?phone=${waNumber}&text=${encodeURIComponent(message)}`
        : `https://wa.me/${waNumber}?text=${encodeURIComponent(message)}`;

    // History, so the next caller can see this donor already has the link and
    // does not send it a second time.
    await pool.query(
      `INSERT INTO lead_activities (lead_id, user_id, kind, note, to_value)
       VALUES ($1,$2,'whatsapp',$3,$4)`,
      [req.params.id, req.user?.userId ?? null, message.slice(0, 2000), url.slice(0, 60)]
    );

    if (link) {
      await pool.query(
        `UPDATE crm_links SET use_count = use_count + 1, last_used_at = NOW() WHERE id = $1`,
        [link.id]
      );
    }

    res.json({ wa_url: waUrl, url, message, phone: waNumber });
  } catch (err) {
    console.error('crm.sendLink error:', err);
    res.status(500).json({ error: 'Could not make the WhatsApp message.' });
  }
});

/**
 * POST /links/:id/copy - take a shared link and make it mine.
 *
 * The common way a caller ends up with a preset: the temple's Gau Seva link is
 * nearly right, but they want their own wording or their own UTM on it. Copying
 * beats starting from a blank form, and it means adapting a link never risks
 * changing it for everybody - which is what would happen if the only option
 * were to edit the shared one.
 */
router.post('/links/:id/copy', async (req, res) => {
  try {
    const result = await pool.query(
      // The credit columns are deliberately not among the ones copied. A
      // credit_token is unique and identifies ONE link, so duplicating it would
      // be refused by the index anyway - but the assignment must not come along
      // either: copying a link assigned to Ana would otherwise hand her the
      // money from every link anybody made out of hers. A copy starts
      // unassigned, and an admin assigns it on purpose.
      `INSERT INTO crm_links (label, url, site, seva_name, message, owner_user_id, sort_order, created_by)
       SELECT COALESCE($2, label || ' (mine)'), url, site, seva_name, message, $3::uuid, 0, $3::uuid
         FROM crm_links WHERE id = $1
       RETURNING *, NULL::text AS credit_user_name`,
      [req.params.id, str(req.body?.label, 80), req.user?.userId ?? null]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Link not found' });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('crm.copyLink error:', err);
    res.status(500).json({ error: 'Could not copy that link' });
  }
});

/**
 * PUT /links/reorder - the order a caller sees their presets in.
 *
 * Sent as a whole list rather than one move at a time, so the order on screen
 * and the order stored can never disagree after a half-applied drag.
 */
router.put('/links-order', async (req, res) => {
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ error: 'Nothing to reorder' });

  try {
    await pool.query(
      `UPDATE crm_links SET sort_order = o.pos, updated_at = NOW()
         FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, pos)
        WHERE crm_links.id = o.id
          -- Only rows this caller may reorder: their own, or the shared ones.
          AND (crm_links.owner_user_id IS NULL OR crm_links.owner_user_id = $2::uuid)`,
      [ids, req.user?.userId ?? null]
    );
    res.json({ reordered: ids.length });
  } catch (err) {
    console.error('crm.reorderLinks error:', err);
    res.status(500).json({ error: 'Could not save that order' });
  }
});

export default router;
