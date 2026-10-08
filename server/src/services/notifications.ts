// The bell's feed: things that happened that somebody should act on.
//
// Written once per event - ref_key is unique, so a job that runs every minute
// can call notify() every minute and the bell still shows the event once.

import type { PoolClient } from 'pg';
import pool from '../db/pool';

type Db = Pick<PoolClient, 'query'>;

export type NotificationKind = 'nearly_gave' | 'sankalpam';

export interface NewNotification {
  kind: NotificationKind;
  title: string;
  body?: string | null;
  link?: string | null;
  phone?: string | null;
  /** What this is about, uniquely - the same key never raises twice. */
  refKey: string;
}

export async function notify(n: NewNotification, db: Db = pool): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO drm_notifications (kind, title, body, link, phone, ref_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (ref_key) DO NOTHING`,
    [n.kind, n.title.slice(0, 200), n.body ?? null, n.link ?? null, n.phone ?? null, n.refKey.slice(0, 120)]
  );
  return (r.rowCount ?? 0) > 0;
}
