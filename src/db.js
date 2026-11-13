import pg from 'pg';
import 'dotenv/config';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (see .env.example)');
  process.exit(1);
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => console.error('[db] idle client error:', err.message));
