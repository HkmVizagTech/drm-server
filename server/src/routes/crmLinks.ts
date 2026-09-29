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
// THE PLACEHOLDERS EARN THEIR KEEP
// A link carrying utm_source=call&utm_content=<lead> arrives back on the site
// tagged, and donations already store utm_source/medium/campaign - so a
// donation that a phone call produced stops looking identical to one that
// arrived on its own. That is the difference between the conversion report
// being evidence and being a guess.

import { Router } from 'express';
import pool from '../db/pool';
import { authenticate } from '../middleware/auth';

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
      `SELECT l.*, u.name AS owner_name
         FROM crm_links l
         LEFT JOIN users u ON l.owner_user_id = u.id
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
      `SELECT l.*, u.name AS owner_name
         FROM crm_links l LEFT JOIN users u ON l.owner_user_id = u.id
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
    return res.status(400).json({ error: 'The link needs to start with http:// or https://' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO crm_links (label, url, site, seva_name, message, owner_user_id, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5,$6::uuid,COALESCE($7::int, 500),$8::uuid)
       RETURNING *`,
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
      `UPDATE crm_links SET
         label      = COALESCE($1, label),
         url        = COALESCE($2, url),
         site       = COALESCE($3, site),
         seva_name  = COALESCE($4, seva_name),
         message    = COALESCE($5, message),
         sort_order = COALESCE($6::int, sort_order),
         active     = COALESCE($7::boolean, active),
         updated_at = NOW()
       WHERE id = $8 RETURNING *`,
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

/* ---------------------------------------------------------- sending one */

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
      if (!link) return res.status(404).json({ error: 'That link no longer exists' });
    }

    const rawUrl = str(b.url, 2000) ?? (link?.url as string | undefined);
    if (!rawUrl) return res.status(400).json({ error: 'Pick a link to send' });

    const caller = String(L.caller_name ?? '').trim();
    const amount = b.amount ?? L.expected_amount ?? null;

    const url = fill(rawUrl, {
      phone: L.phone,
      lead: String(L.id).slice(0, 8),
      caller: caller.replace(/\s+/g, '-').toLowerCase(),
    });

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
    res.status(500).json({ error: 'Could not build that WhatsApp message' });
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
      `INSERT INTO crm_links (label, url, site, seva_name, message, owner_user_id, sort_order, created_by)
       SELECT COALESCE($2, label || ' (mine)'), url, site, seva_name, message, $3::uuid, 0, $3::uuid
         FROM crm_links WHERE id = $1
       RETURNING *`,
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
