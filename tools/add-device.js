// Registers a device and prints its token ONCE (only its SHA-256 hash is stored).
//   npm run device:add -- T05-D1            create
//   npm run device:add -- T05-D1 --rotate   replace the token
import crypto from 'node:crypto';
import { pool } from '../src/db.js';

const [deviceId, flag] = process.argv.slice(2);
if (!deviceId || !/^[A-Za-z0-9_-]{1,32}$/.test(deviceId)) {
  console.error('usage: npm run device:add -- <DEVICE_ID> [--rotate]');
  process.exit(1);
}
const token = crypto.randomBytes(24).toString('base64url');       // 32 chars
const hash = crypto.createHash('sha256').update(token).digest('hex');

const { rows } = await pool.query('SELECT 1 FROM devices WHERE device_id = $1', [deviceId]);
if (rows.length && flag !== '--rotate') {
  console.error(`${deviceId} already exists. Use --rotate to issue a new token.`);
  process.exit(1);
}
await pool.query(
  `INSERT INTO devices (device_id, token_hash) VALUES ($1, $2)
   ON CONFLICT (device_id) DO UPDATE SET token_hash = EXCLUDED.token_hash`,
  [deviceId, hash],
);
console.log(`device ${deviceId} ready.\nDEVICE TOKEN (shown once, type it on the setup page, never commit it):\n\n  ${token}\n`);
await pool.end();
