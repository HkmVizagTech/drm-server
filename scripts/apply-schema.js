// One-time helper: applies src/db/schema.sql to whatever Postgres database
// DATABASE_URL points at. Safe to re-run - the schema uses CREATE TABLE IF
// NOT EXISTS / ADD COLUMN IF NOT EXISTS throughout.
//
// Usage (from the `server` folder):
//   PowerShell:
//     $env:DATABASE_URL="postgresql://postgres:...@....proxy.rlwy.net:PORT/railway"
//     node scripts/apply-schema.js
//   cmd.exe:
//     set DATABASE_URL=postgresql://postgres:...@....proxy.rlwy.net:PORT/railway
//     node scripts/apply-schema.js

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error(
    'DATABASE_URL is not set.\n' +
    'PowerShell:  $env:DATABASE_URL="postgresql://...your Railway public connection string..."\n' +
    'cmd.exe:     set DATABASE_URL=postgresql://...your Railway public connection string...'
  );
  process.exit(1);
}

// Railway's public Postgres proxy presents a certificate that Node's default
// TLS validation rejects, so we relax verification for this one-off script.
const client = new Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  const schemaPath = path.join(__dirname, '..', 'src', 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  console.log(`Applying ${schemaPath} to the database...`);
  await client.connect();
  await client.query(sql);
  console.log('Schema applied successfully.');
  await client.end();
}

run().catch((err) => {
  console.error('Failed to apply schema:', err);
  process.exit(1);
});
