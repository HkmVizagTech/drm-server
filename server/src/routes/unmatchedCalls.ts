// Unmatched calls: a call from a number DRM did not know, added from its recording.
//
// THE PROBLEM
// A donor rings back from a spouse's phone, or the caller rings a number that is
// not in DRM, and they talk for five minutes. The phone app reports only calls
// to and from numbers DRM knows, so DRM never heard of the call: no call in
// Team activity, no talk time, nothing on the donor.
//
// THE FIX
// The caller adds it here: the number, which donor it is (an existing one - the
// number then becomes that donor's other number, so the next call matches by
// itself - or a new one), when it was, and the recording from the phone.
//
// THE RULE THAT KEEPS IT HONEST
// Talk time is the length of the recording, read from the file. There is no
// field to type a time into, and a file whose length cannot be read is refused.
// The recording is also what an admin can play to see the call happened. The
// call is stored like a phone-app call (phone_calls, with no device) and gets a
// call in the donor's history, so every report that counts calls counts it.
//
//   GET  /api/unmatched-calls           the calls added by hand (a caller sees their own)
//   POST /api/unmatched-calls?phone=&started_at=&lead_id=|person_id=|name=
//        body = the recording file. See the handler for the other parameters.

import { Router } from 'express';
import express from 'express';
import crypto from 'crypto';
import pool from '../db/pool';
import { authenticate, authorize } from '../middleware/auth';
import * as storage from '../services/storage';
import { recordingSeconds } from '../services/audioLength';
import { playbackType, recordingExt, recordingKey } from '../services/phoneCalls';
import { logCallForLead, upsertLead, leadScopeFor } from './crm';
import { CALL_FROM, CALL_ROW, REVIEWERS } from './phoneApp';

const router = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_AGE_DAYS = 45;
const isUuid = (s: unknown) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const digits10 = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(-10);
const text = (v: unknown, max: number) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.slice(0, max) : null;
};

router.get('/', authenticate, authorize('admin', 'volunteer_coordinator', 'caller'), async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const reviewer = REVIEWERS.includes(req.user!.role);
  const values: unknown[] = [];
  const p = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  const conds = ['pc.added_by_hand'];
  if (!reviewer) conds.push(`pc.user_id = ${p(req.user!.userId)}::uuid`);
  else if (isUuid(q.user_id)) conds.push(`pc.user_id = ${p(q.user_id)}::uuid`);
  if (q.from && DATE_RE.test(q.from)) conds.push(`pc.started_at >= ${p(q.from)}::date`);
  if (q.to && DATE_RE.test(q.to)) conds.push(`pc.started_at < ${p(q.to)}::date + INTERVAL '1 day'`);
  const where = `WHERE ${conds.join(' AND ')}`;
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 50));
  const page = Math.max(1, Number(q.page) || 1);
  try {
    const [rows, totals] = await Promise.all([
      pool.query(
        `SELECT ${CALL_ROW}, TRUE AS can_listen
           ${CALL_FROM} ${where}
          ORDER BY pc.started_at DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        values
      ),
      pool.query(
        `SELECT COUNT(*)::int AS calls, COALESCE(SUM(pc.duration_seconds), 0)::int AS talk_seconds ${CALL_FROM} ${where}`,
        values
      ),
    ]);
    res.json({ calls: rows.rows, totals: totals.rows[0], page, limit });
  } catch (err) {
    console.error('unmatchedCalls.list error:', (err as Error).message);
    res.status(500).json({ error: 'Could not load the calls.' });
  }
});

/**
 * Add a call.
 *
 * Query: phone (the number the call was on), started_at (when, an ISO time),
 *   direction (inbound | outbound, default inbound), note,
 *   and who it was - one of: lead_id, person_id (an existing donor), or name
 *   (a new one).
 *   replace_alt=1 : the donor already has another number saved, replace it.
 *   force=1       : add it although the donor has a call at nearly this time.
 * Headers: Content-Type and X-File-Name of the recording. Body: the file.
 *
 * Answers 409 with a `code` when the caller has to decide something:
 *   number_belongs - the number is already some other donor's
 *   alt_taken      - the donor already has a different other number
 *   duplicate      - the donor has a call at nearly this time already
 */
router.post(
  '/',
  authenticate,
  authorize('admin', 'caller'),
  express.raw({ type: () => true, limit: '60mb' }),
  async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const user = { userId: req.user!.userId, role: req.user!.role };
    const body = req.body as Buffer;
    try {
      const phone = digits10(q.phone);
      if (phone.length !== 10) return res.status(400).json({ error: 'Enter the 10-digit number the call was on.' });

      const started = new Date(String(q.started_at ?? ''));
      if (Number.isNaN(started.getTime())) return res.status(400).json({ error: 'Say when the call was.' });
      if (started.getTime() > Date.now() + 5 * 60_000) return res.status(400).json({ error: 'That time has not happened yet.' });
      if (started.getTime() < Date.now() - MAX_AGE_DAYS * 86_400_000) {
        return res.status(400).json({ error: `Only calls from the last ${MAX_AGE_DAYS} days can be added.` });
      }
      const direction = q.direction === 'outbound' ? 'outbound' : 'inbound';

      if (!Buffer.isBuffer(body) || body.length < 512) return res.status(400).json({ error: 'Add the recording of the call.' });
      if (!storage.isConfigured()) return res.status(503).json({ error: 'Recording storage is not set up yet.' });

      // The length of the call is the length of the recording - nothing typed.
      const seconds = await recordingSeconds(body);
      if (!seconds) {
        return res.status(400).json({
          error: 'DRM could not read how long this recording is. Add the original call recording (mp3, m4a, wav, amr or 3gp).',
        });
      }

      const who = await resolveDonor(q, phone, user);
      if ('stop' in who) return res.status(who.status).json(who.stop);
      const { leadId, leadName, saveNumber } = who;

      // Nearly the same time on the same donor is most likely the app's own
      // record of this call, or this one added twice.
      if (q.force !== '1') {
        const near = await pool.query(
          `SELECT pc.started_at, pc.duration_seconds, u.name AS caller_name
             FROM phone_calls pc LEFT JOIN users u ON u.id = pc.user_id
            WHERE pc.lead_id = $1 AND pc.started_at BETWEEN $2::timestamptz - INTERVAL '3 minutes' AND $2::timestamptz + INTERVAL '3 minutes'
            LIMIT 1`,
          [leadId, started.toISOString()]
        );
        if (near.rows.length) {
          return res.status(409).json({
            code: 'duplicate',
            error: `${leadName ?? 'This donor'} already has a call at almost this time (${near.rows[0].caller_name ?? 'a caller'}). Add this one anyway?`,
          });
        }
      }
      if (saveNumber && who.altTaken && q.replace_alt !== '1') {
        return res.status(409).json({
          code: 'alt_taken',
          alt_phone: who.altTaken,
          error: `${leadName ?? 'This donor'} already has another number saved (${who.altTaken}). Replace it with ${phone}?`,
        });
      }

      const id = crypto.randomUUID();
      const name = text(decodeURIComponent(String(req.headers['x-file-name'] ?? '')), 200);
      const type = text(String(req.headers['content-type'] ?? ''), 80);
      const ext = recordingExt(name, type);
      const key = recordingKey(id, started, ext);
      const stored = playbackType(ext, type);
      const put = await storage.putObject(key, body, stored);
      if (!put.ok) return res.status(503).json({ error: 'Could not store the recording. Try again.' });

      await pool.query(
        `INSERT INTO phone_calls
           (id, device_id, user_id, call_key, direction, phone, lead_id, started_at, duration_seconds, from_app,
            recording_status, recording_key, recording_type, recording_bytes, recording_name, recording_at, added_by_hand)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, FALSE, 'uploaded', $9, $10, $11, $12, NOW(), TRUE)`,
        [id, user.userId, `hand:${id}`, direction, phone, leadId, started.toISOString(), seconds, key, stored, body.length, name]
      );

      try {
        const note = text(q.note, 1500);
        const { activity } = await logCallForLead(
          leadId,
          {
            disposition: 'recorded_call',
            direction,
            duration_seconds: seconds,
            source: 'recording',
            occurred_at: started.toISOString(),
            recording_url: `/api/app/calls/${id}/recording`,
            note: note ? `Added from a recording: ${note}` : 'Added from a recording',
          },
          user
        );
        await pool.query(`UPDATE phone_calls SET activity_id = $2 WHERE id = $1`, [id, String(activity.id)]);
      } catch (e) {
        await pool.query(`DELETE FROM phone_calls WHERE id = $1`, [id]);
        await storage.deleteObject(key).catch(() => undefined);
        throw e;
      }

      // Last, so a call that could not be added does not leave the number behind.
      if (saveNumber) await pool.query(`UPDATE leads SET alt_phone = $2, updated_at = NOW() WHERE id = $1`, [leadId, phone]);

      res.status(201).json({
        id,
        lead_id: leadId,
        donor: leadName,
        duration_seconds: seconds,
        number_saved: !!saveNumber,
        message: saveNumber
          ? `Added. ${seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`} counted for you, and ${phone} is saved as ${leadName ?? 'the donor'}'s other number.`
          : `Added. ${seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`} counted for you.`,
      });
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message });
      console.error('unmatchedCalls.add error:', e.message);
      res.status(500).json({ error: 'Could not add the call. Try again.' });
    }
  }
);

type Resolved =
  | { leadId: string; leadName: string | null; saveNumber: boolean; altTaken: string | null }
  | { stop: Record<string, unknown>; status: number };

/**
 * Which donor this call belongs to, and whether its number should be saved on them.
 * Nothing is written here except a new donor, when the caller said it is one.
 */
async function resolveDonor(
  q: Record<string, string | undefined>,
  phone: string,
  user: { userId: string; role: string }
): Promise<Resolved> {
  const known = (
    await pool.query(
      `SELECT id, name FROM leads
        WHERE phone = $1 OR right(regexp_replace(COALESCE(alt_phone,''), '\\D', '', 'g'), 10) = $1
        LIMIT 1`,
      [phone]
    )
  ).rows[0];

  let chosen: { id: string; name: string | null; phone: string; alt_phone: string | null } | null = null;
  if (isUuid(q.lead_id)) {
    const scope = await leadScopeFor(user);
    const r = await pool.query(
      `SELECT id, name, phone, alt_phone FROM leads l
        WHERE id = $1
          AND ($2::uuid IS NULL OR l.assigned_to = $2::uuid OR l.assigned_to IS NULL
               OR l.assigned_to IN (SELECT id FROM users WHERE role <> 'caller'))`,
      [q.lead_id, scope]
    );
    chosen = r.rows[0] ?? null;
    if (!chosen) return { status: 404, stop: { error: 'That donor was not found.' } };
  } else if (isUuid(q.person_id)) {
    const p = await pool.query(`SELECT name, phone FROM people WHERE id = $1`, [q.person_id]);
    const phoneOf = digits10(p.rows[0]?.phone);
    if (!p.rows.length || phoneOf.length !== 10) return { status: 404, stop: { error: 'That donor was not found.' } };
    const { lead } = await upsertLead(
      {
        phone: phoneOf,
        name: p.rows[0].name,
        source_detail: 'Unmatched call',
        assigned_to: user.role === 'caller' ? user.userId : null,
      },
      user.userId
    );
    chosen = { id: String(lead.id), name: (lead.name as string) ?? null, phone: phoneOf, alt_phone: (lead.alt_phone as string) ?? null };
  }

  if (chosen) {
    if (known && known.id !== chosen.id) {
      return {
        status: 409,
        stop: { code: 'number_belongs', error: `${phone} already belongs to ${known.name ?? 'another donor'} in DRM. Pick them instead.` },
      };
    }
    if (known) return { leadId: chosen.id, leadName: chosen.name, saveNumber: false, altTaken: null };
    const alt = digits10(chosen.alt_phone);
    return { leadId: chosen.id, leadName: chosen.name, saveNumber: true, altTaken: alt.length === 10 && alt !== phone ? alt : null };
  }

  // Nobody chosen. A number DRM already has needs no choosing.
  if (known) return { leadId: String(known.id), leadName: known.name ?? null, saveNumber: false, altTaken: null };

  const name = text(q.name, 120);
  if (!name || name.length < 2) {
    return { status: 400, stop: { error: 'Pick the donor this call was with, or enter the name of a new one.' } };
  }
  const { lead } = await upsertLead(
    {
      phone,
      name,
      source_detail: 'Unmatched call',
      assigned_to: user.role === 'caller' ? user.userId : null,
    },
    user.userId
  );
  return { leadId: String(lead.id), leadName: name, saveNumber: false, altTaken: null };
}

export default router;
