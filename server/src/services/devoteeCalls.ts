// A devotee's phone calls with their own leads, as the DRM Android app reports them, and the
// phone's recording of each.
//
// The app is the same one callers use and talks to the same /api/app endpoints; routes/phoneApp.ts
// sends a phone linked to a devotee here instead of to DRM's call log. Everything here is scoped
// by the devotee (owner_id): the phone is given only their leads' numbers, a call is kept only
// when it matches one of their leads, and a recording is stored under their own prefix. Nothing
// is written to phone_calls, lead_activities or incoming_rings, so none of it reaches a DRM
// screen. The only way to hear a recording is GET /api/devotee/calls/:id/recording, which serves
// the devotee who made the call and nobody else.

import pool from '../db/pool';
import * as storage from './storage';
import { STATUS_LABEL } from './devoteeLeads';
import { directionOf, phone10, playbackType, recordingExt, type CallResult, type ReportedCall } from './phoneCalls';

export interface Device {
  id: string;
  user_id: string;
}

/** The ten digits of a lead's other number, when it has one. */
const ALT10 = `right(regexp_replace(COALESCE(alt_phone, ''), '\\D', '', 'g'), 10)`;

/** The numbers the devotee's phone should report: their leads' main and other numbers. */
export async function devoteeNumbers(ownerId: string): Promise<string[]> {
  const r = await pool.query(
    `SELECT DISTINCT n FROM (
       SELECT phone AS n FROM devotee_leads WHERE owner_id = $1
       UNION ALL
       SELECT ${ALT10} FROM devotee_leads WHERE owner_id = $1
     ) x WHERE length(n) = 10
     LIMIT 50000`,
    [ownerId]
  );
  return r.rows.map((x) => x.n as string);
}

/** The devotee's lead for a number: the one the Call button was pressed on, else by number. */
async function leadFor(ownerId: string, phone: string, hint?: string | null): Promise<string | null> {
  const r = await pool.query(
    `SELECT id FROM devotee_leads
      WHERE owner_id = $1 AND (phone = $2 OR ${ALT10} = $2)
      ORDER BY (id::text = $3) DESC, (phone = $2) DESC, updated_at DESC
      LIMIT 1`,
    [ownerId, phone, hint && /^[0-9a-f-]{36}$/i.test(hint) ? hint : '']
  );
  return (r.rows[0]?.id as string | undefined) ?? null;
}

/** Save what the devotee's phone reported. Safe to send the same calls twice. */
export async function recordDevoteeCalls(device: Device, calls: ReportedCall[]): Promise<CallResult[]> {
  const out: CallResult[] = [];
  for (const c of calls) {
    const key = String(c.key ?? '').slice(0, 80);
    const phone = phone10(c.phone);
    const seconds = Math.max(0, Math.round(Number(c.duration_seconds) || 0));
    const started = new Date(c.started_at);
    const direction = directionOf(Number(c.type), seconds);
    if (!key || phone.length !== 10 || !direction || Number.isNaN(started.getTime())) {
      out.push({ key, id: null, want_recording: false });
      continue;
    }
    const existing = (
      await pool.query(`SELECT id, recording_status, direction FROM devotee_calls WHERE device_id = $1 AND call_key = $2`, [device.id, key])
    ).rows[0];
    if (existing) {
      out.push({ key, id: existing.id, want_recording: existing.recording_status === 'waiting', direction: existing.direction });
      continue;
    }
    const leadId = await leadFor(device.user_id, phone, c.lead_id ?? null);
    if (!leadId) {
      // Not one of this devotee's leads: a personal call. Not kept.
      out.push({ key, id: null, want_recording: false });
      continue;
    }
    const ins = await pool.query(
      `INSERT INTO devotee_calls
         (owner_id, device_id, call_key, lead_id, direction, phone, started_at, duration_seconds, sim, from_app, recording_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (device_id, call_key) DO NOTHING
       RETURNING id`,
      [
        device.user_id, device.id, key, leadId, direction, phone, started.toISOString(), seconds,
        c.sim ? String(c.sim).slice(0, 60) : null, c.from_app === true, seconds > 0 ? 'waiting' : 'not_needed',
      ]
    );
    const id = ins.rows[0]?.id as string | undefined;
    if (!id) {
      out.push({ key, id: null, want_recording: false });
      continue;
    }
    // A call where they spoke is contact with the lead. The status stays the devotee's to set.
    if (seconds > 0) {
      await pool.query(
        `UPDATE devotee_leads SET last_contacted_at = GREATEST(last_contacted_at, $2::timestamptz), updated_at = NOW()
          WHERE id = $1`,
        [leadId, started.toISOString()]
      );
    }
    out.push({ key, id, want_recording: seconds > 0, direction });
  }
  return out;
}

/** Where a devotee's recording is kept: under their own prefix, by year and month. */
function devoteeRecordingKey(ownerId: string, callId: string, startedAt: Date, ext: string): string {
  const y = startedAt.getUTCFullYear();
  const m = String(startedAt.getUTCMonth() + 1).padStart(2, '0');
  return `devotee-recordings/${ownerId}/${y}/${m}/${callId}.${ext}`;
}

/** Store the phone's recording of one of this devotee's calls. */
export async function saveDevoteeRecording(
  device: Device,
  callId: string,
  body: Buffer,
  name: string | null,
  type: string | null
): Promise<{ status: number; body: Record<string, unknown> }> {
  const c = (
    await pool.query(`SELECT id, owner_id, started_at, recording_status FROM devotee_calls WHERE id = $1 AND device_id = $2`, [callId, device.id])
  ).rows[0];
  if (!c) return { status: 404, body: { error: 'Not found.' } };
  if (c.recording_status === 'uploaded') return { status: 200, body: { ok: true, already: true } };
  const ext = recordingExt(name, type);
  const key = devoteeRecordingKey(c.owner_id, c.id, new Date(c.started_at), ext);
  const contentType = playbackType(ext, type);
  const put = await storage.putObject(key, body, contentType);
  if (!put.ok) return { status: 503, body: { error: 'Could not store the recording. It will be tried again.' } };
  await pool.query(
    `UPDATE devotee_calls SET recording_status = 'uploaded', recording_key = $2, recording_type = $3,
            recording_bytes = $4, recording_name = $5, recording_at = NOW()
      WHERE id = $1`,
    [c.id, key, contentType, body.length, name]
  );
  return { status: 200, body: { ok: true } };
}

/** The phone looked for a recording of this call and found none. */
export async function markNoDevoteeRecording(device: Device, callId: string): Promise<void> {
  await pool.query(
    `UPDATE devotee_calls SET recording_status = 'none' WHERE id = $1 AND device_id = $2 AND recording_status = 'waiting'`,
    [callId, device.id]
  );
}

/**
 * Caller ID for a devotee's phone: which of their own leads is ringing, and where it stands.
 * Answers from their leads only - never DRM's - and writes nothing.
 */
export async function devoteeRinging(ownerId: string, phone: string) {
  const r = await pool.query(
    `SELECT id, name, status, total_donated::float8 AS total_donated
       FROM devotee_leads
      WHERE owner_id = $1 AND (phone = $2 OR ${ALT10} = $2)
      ORDER BY (phone = $2) DESC, updated_at DESC
      LIMIT 1`,
    [ownerId, phone]
  );
  const l = r.rows[0];
  if (!l) return { ok: true, known: false };
  const note =
    l.total_donated > 0
      ? `Gave ₹${Math.round(l.total_donated).toLocaleString('en-IN')}`
      : STATUS_LABEL[l.status as keyof typeof STATUS_LABEL] ?? String(l.status);
  return { ok: true, known: true, lead_id: l.id, name: l.name, note };
}

/** A lead is being deleted: remove its recordings from storage too, not just the rows. */
export async function deleteRecordingsForLead(ownerId: string, leadId: string): Promise<void> {
  const r = await pool.query(
    `SELECT recording_key FROM devotee_calls WHERE owner_id = $1 AND lead_id = $2 AND recording_key IS NOT NULL`,
    [ownerId, leadId]
  );
  for (const row of r.rows) {
    await storage.deleteObject(row.recording_key).catch(() => false);
  }
}
