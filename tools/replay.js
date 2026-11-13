// Replay test from a laptop: re-sends the newest stored telemetry record with
// the SAME seq. Expected: HTTP 409 and the record count does not change.
//   DEVICE_TOKEN=xxxx SERVER_BASE=https://... npm run replay
import { pool } from '../src/db.js';

const token = process.env.DEVICE_TOKEN;
const base = process.env.SERVER_BASE;
if (!token || !base) { console.error('set DEVICE_TOKEN and SERVER_BASE in your shell'); process.exit(1); }

const { rows } = await pool.query(
  `SELECT device_id, room_id, seq, extract(epoch FROM ts)::bigint AS ts, uptime_s, temp_c, rh, heat_index_c,
          flame, door, status, heat_trend, rssi, heap_kb, chip_temp_c, fw, quality
     FROM telemetry ORDER BY seq DESC LIMIT 1`);
if (!rows.length) { console.error('no telemetry stored yet'); process.exit(1); }
const r = rows[0];
const body = { ...r, seq: Number(r.seq), ts: Number(r.ts) };
// count rows for THIS device+seq (the device keeps sending new records meanwhile)
const count = async () => Number((await pool.query(
  'SELECT count(*) FROM telemetry WHERE device_id = $1 AND seq = $2', [r.device_id, body.seq])).rows[0].count);

const before = await count();
const res = await fetch(`${base}/api/v1/telemetry`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});
const after = await count();
console.log(`resent seq=${body.seq}: HTTP ${res.status} ${await res.text()}`);
console.log(`rows with seq=${body.seq}: before=${before} after=${after} -> ${res.status === 409 && after === before ? 'REPLAY REJECTED' : 'CHECK!'}`);
await pool.end();
