import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// A pooled client that's sitting idle can hit a background error (Railway's
// proxy dropping an idle connection, a brief network blip, etc.) - this is
// routine for hosted Postgres and NOT a reason to kill the whole server.
// `pg` automatically removes the broken client and opens a new one on the
// next query, so we just log it here instead of crashing the process.
pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client (pool will recover automatically):', err);
});

export default pool;
