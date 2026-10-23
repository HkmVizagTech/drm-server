/**
 * Put the Seva wall calls made BEFORE call tracking existed into the ordinary call
 * log, so they count in My calls and the reports like every other call.
 *
 * Report first: with no flag this writes NOTHING and says what it would do.
 *   --apply   makes the changes (first applying the schema, which only ADDS the
 *             two Seva wall dispositions and the neutral "Seva wall donor" status).
 *
 * Each call keeps its real time and its caller. It is written straight to the call
 * log, NOT through the call screen's logging, because that stamps "last contacted
 * = now" and would make every old call look like it happened today. The lead's
 * counters are moved with the call's own time instead. Safe to run twice: each
 * call is stamped with the id of the event it came from and is added once.
 *
 *   npm run backfill:sevawallcalls            (report)
 *   npm run backfill:sevawallcalls -- --apply
 */
import '../src/bootTimezone';
import pool from '../src/db/pool';
import { runMigrations } from '../src/db/migrate';
import { upsertLead } from '../src/routes/crm';
import { wallSql } from '../src/routes/sevaWall';

const APPLY = process.argv.includes('--apply');
const NAME: Record<string, string> = { brick: 'Brick seva', square: 'Square foot seva', mandir: 'Mandir nirmana seva' };

async function main() {
  const u = new URL(process.env.DATABASE_URL!);
  console.log(`database: ${u.hostname}/${u.pathname.slice(1)}   mode: ${APPLY ? 'APPLY' : 'report only (nothing is written)'}`);

  if (APPLY) {
    const m = await runMigrations();
    if (!m.ok) throw new Error('the schema could not be applied - nothing was changed');
  }

  const events = await pool.query(
    `SELECT e.id, e.action, e.note, e.by_user, e.at, u.role AS by_role,
            COALESCE(i.donation_id, i.id) AS ref
       FROM seva_wall_events e
       JOIN seva_wall_items i ON i.id = e.item_id
       LEFT JOIN users u ON u.id = e.by_user
      WHERE e.action IN ('called', 'no_answer')
      ORDER BY e.at, e.id`
  );

  const tally = { events: events.rowCount ?? 0, alreadyLogged: 0, noPhone: 0, toAdd: 0, newLeads: 0, existingLeads: 0, added: 0 };
  const seenLead = new Set<string>();

  for (const e of events.rows) {
    const marker = `seva-wall-event-${e.id}`;
    if ((await pool.query(`SELECT 1 FROM lead_activities WHERE provider_call_id = $1`, [marker])).rowCount) {
      tally.alreadyLogged++;
      continue;
    }
    const w = (await pool.query(`SELECT w.donor_name, w.phone, w.kind FROM ${wallSql(false)} WHERE w.ref = $1`, [e.ref])).rows[0];
    const phone = String(w?.phone ?? '').replace(/\D/g, '').slice(-10);
    if (!w || phone.length !== 10) {
      tally.noPhone++;
      continue;
    }
    tally.toAdd++;
    const lead = await pool.query(`SELECT id FROM leads WHERE phone = $1`, [phone]);
    if (!seenLead.has(phone)) {
      seenLead.add(phone);
      if (lead.rowCount) tally.existingLeads++;
      else tally.newLeads++;
    }
    if (!APPLY) continue;

    const label = NAME[w.kind] ?? 'Seva';
    const answered = e.action === 'called';
    const { lead: l } = await upsertLead(
      {
        phone,
        name: w.donor_name,
        source_detail: `Seva wall - ${label}`,
        status: 'seva_wall',
        assigned_to: e.by_role === 'caller' ? e.by_user : null,
        tags: ['seva_wall'],
      },
      e.by_user ?? null
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const disposition = answered ? 'seva_wall_answered' : 'seva_wall_no_answer';
      await client.query(
        `INSERT INTO lead_activities
           (lead_id, user_id, kind, direction, disposition, connected, source, provider_call_id, note, occurred_at)
         VALUES ($1, $2, 'call', 'outbound', $3, $4, 'manual', $5, $6, $7)`,
        [l.id, e.by_user, disposition, answered, marker, e.note ? `Seva wall (${label}): ${e.note}` : `Seva wall (${label})`, e.at]
      );
      // The counters move with the call's OWN time, never "now".
      await client.query(
        `UPDATE leads
            SET call_attempts = call_attempts + 1,
                last_contacted_at = GREATEST(COALESCE(last_contacted_at, '-infinity'::timestamptz), $2::timestamptz),
                last_outcome = CASE WHEN last_contacted_at IS NULL OR last_contacted_at <= $2::timestamptz THEN $3 ELSE last_outcome END
          WHERE id = $1`,
        [l.id, e.at, disposition]
      );
      await client.query('COMMIT');
      tally.added++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  console.table([tally]);
  if (!APPLY) console.log('Nothing was written. Run again with --apply to add them.');
  await pool.end();
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
