// FastRobox 1.0 SmartClass platform - Level 2
// HTTPS ingest API for device telemetry and events.
//  - device authenticated by its token (Bearer), stored only as a SHA-256 hash
//  - every (device_id, seq) stored exactly once; a replay gets 409 and nothing is written
//  - device marked OFFLINE after OFFLINE_AFTER_S seconds of silence, ONLINE again on data
// HTTPS itself is provided by the host (Render/Railway/Fly terminate TLS with a
// publicly trusted certificate, which the device verifies).

import express from 'express';
import crypto from 'node:crypto';
import { pool } from './db.js';

const PORT = Number(process.env.PORT || 3000);
const OFFLINE_AFTER_S = Math.min(Number(process.env.OFFLINE_AFTER_S || 20), 25);
const SWEEP_MS = 5000;

const DEVICE_EVENT_TYPES = new Set([
  'BOOT', 'STATUS', 'FIRE', 'FIRE_CLEARED', 'SILENCED', 'PANIC', 'CARD_TAP',
  'ENTRY_GRANTED', 'ENTRY_DENIED', 'NO_FACE', 'OFFLINE_ENTRY', 'SENSOR_ERROR',
  'SETTINGS_APPLIED', 'OTA_DONE', 'OTA_REJECTED', 'OTA_ROLLBACK',
]);

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

// ---------------------------------------------------------------- helpers ---
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isInt = (v) => Number.isInteger(v);
const isNumOrNull = (v) => v === null || (typeof v === 'number' && Number.isFinite(v));
const ID_RE = /^[A-Za-z0-9_-]{1,16}$/;

function tsError(ts) {
  if (!isInt(ts)) return 'ts must be an integer (Unix seconds, UTC)';
  const now = Math.floor(Date.now() / 1000);
  if (ts < 1700000000) return 'ts is before 2023 - device clock not synced';
  if (ts > now + 300) return 'ts is in the future';
  return null;
}

function validateTelemetry(b) {
  if (typeof b !== 'object' || b === null) return 'body must be a JSON object';
  if (typeof b.room_id !== 'string' || !ID_RE.test(b.room_id)) return 'room_id invalid';
  if (!isInt(b.seq) || b.seq < 1) return 'seq must be a positive integer';
  const tErr = tsError(b.ts); if (tErr) return tErr;
  if (!isInt(b.uptime_s) || b.uptime_s < 0) return 'uptime_s invalid';
  for (const k of ['temp_c', 'rh', 'heat_index_c', 'chip_temp_c']) if (!isNumOrNull(b[k])) return `${k} must be a number or null`;
  if (typeof b.flame !== 'boolean') return 'flame must be true/false';
  if (!['LOCKED', 'UNLOCKED'].includes(b.door)) return 'door must be LOCKED or UNLOCKED';
  if (!['SAFE', 'WARNING', 'DANGER', 'FIRE'].includes(b.status)) return 'status invalid';
  if (!['RISING', 'STABLE', 'FALLING'].includes(b.heat_trend)) return 'heat_trend invalid';
  if (!(b.rssi === null || isInt(b.rssi))) return 'rssi must be an integer or null';
  if (!isInt(b.heap_kb) || b.heap_kb < 0) return 'heap_kb invalid';
  if (typeof b.fw !== 'string' || b.fw.length < 1 || b.fw.length > 32) return 'fw invalid';
  if (!['good', 'bad'].includes(b.quality)) return 'quality must be good or bad';
  return null;
}

function validateEvent(b) {
  if (typeof b !== 'object' || b === null) return 'body must be a JSON object';
  if (typeof b.room_id !== 'string' || !(b.room_id === '' || ID_RE.test(b.room_id))) return 'room_id invalid';
  if (!isInt(b.seq) || b.seq < 1) return 'seq must be a positive integer';
  const tErr = tsError(b.ts); if (tErr) return tErr;
  if (!DEVICE_EVENT_TYPES.has(b.type)) return `unknown device event type ${b.type}`;
  if (typeof b.detail !== 'string' || b.detail.length > 200) return 'detail must be a string (max 200)';
  return null;
}

// Device token -> device_id (cached briefly so each message is one DB round trip less)
const tokenCache = new Map(); // hash -> { deviceId, until }
async function authDevice(req, res, next) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{16,64})$/.exec(req.get('authorization') || '');
  if (!m) return res.status(401).json({ error: 'missing or malformed device token' });
  const hash = sha256(m[1]);
  let hit = tokenCache.get(hash);
  if (!hit || hit.until < Date.now()) {
    try {
      const { rows } = await pool.query('SELECT device_id FROM devices WHERE token_hash = $1', [hash]);
      if (!rows.length) return res.status(401).json({ error: 'unknown device token' });
      hit = { deviceId: rows[0].device_id, until: Date.now() + 60000 };
      tokenCache.set(hash, hit);
    } catch (e) { return next(e); }
  }
  if (req.body?.device_id !== hit.deviceId) {
    return res.status(403).json({ error: 'device_id does not match the token' });
  }
  req.deviceId = hit.deviceId;
  next();
}

// Mark the device as seen; log ONLINE if it was offline.
async function markSeen(client, deviceId, extra = {}) {
  const { rows } = await client.query(
    `WITH prev AS (SELECT online FROM devices WHERE device_id = $1)
     UPDATE devices SET last_seen = now(), online = true,
            fw = COALESCE($2, fw), room_id = COALESCE($3, room_id),
            last_reset_reason = COALESCE($4, last_reset_reason)
      WHERE device_id = $1
     RETURNING (SELECT online FROM prev) AS was_online`,
    [deviceId, extra.fw ?? null, extra.roomId || null, extra.resetReason ?? null],
  );
  if (rows.length && rows[0].was_online === false) {
    await client.query(`INSERT INTO device_status_log (device_id, state) VALUES ($1, 'ONLINE')`, [deviceId]);
    console.log(`[presence] ${deviceId} ONLINE`);
  }
}

// Store one message atomically, or reject it as a replay.
async function storeOnce(deviceId, seq, kind, insertFn, seenExtra) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fresh = await client.query(
      `INSERT INTO seen_seq (device_id, seq, kind) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING seq`,
      [deviceId, seq, kind],
    );
    if (fresh.rowCount === 0) {
      await client.query('ROLLBACK');
      // Nothing is stored. Tell the device the highest seq we hold, so a device
      // whose flash was erased (seq restarted) can jump past it.
      const { rows } = await pool.query('SELECT max(seq) AS m FROM seen_seq WHERE device_id = $1', [deviceId]);
      return { replay: true, maxSeq: Number(rows[0].m) };
    }
    await insertFn(client);
    await markSeen(client, deviceId, seenExtra);
    await client.query('COMMIT');
    return { replay: false };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ----------------------------------------------------------------- routes ---
app.get('/healthz', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.post('/api/v1/telemetry', authDevice, async (req, res, next) => {
  const b = req.body;
  const err = validateTelemetry(b);
  if (err) return res.status(400).json({ error: err });
  try {
    const r = await storeOnce(req.deviceId, b.seq, 'telemetry', (c) => c.query(
      `INSERT INTO telemetry (device_id, room_id, seq, ts, uptime_s, temp_c, rh, heat_index_c, flame,
                              door, status, heat_trend, rssi, heap_kb, chip_temp_c, fw, quality)
       VALUES ($1,$2,$3,to_timestamp($4),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [req.deviceId, b.room_id, b.seq, b.ts, b.uptime_s, b.temp_c, b.rh, b.heat_index_c, b.flame,
       b.door, b.status, b.heat_trend, b.rssi, b.heap_kb, b.chip_temp_c, b.fw, b.quality],
    ), { fw: b.fw, roomId: b.room_id });
    if (r.replay) {
      console.log(`[replay] rejected telemetry ${req.deviceId} seq=${b.seq}`);
      return res.status(409).json({ error: 'replay', seq: b.seq, max_seq: r.maxSeq });
    }
    res.status(201).json({ ok: true, seq: b.seq });
  } catch (e) { next(e); }
});

app.post('/api/v1/events', authDevice, async (req, res, next) => {
  const b = req.body;
  const err = validateEvent(b);
  if (err) return res.status(400).json({ error: err });
  const resetReason = b.type === 'BOOT' ? (/reason=(\S+)/.exec(b.detail)?.[1] ?? null) : null;
  try {
    const r = await storeOnce(req.deviceId, b.seq, 'event', (c) => c.query(
      `INSERT INTO events (source, device_id, room_id, seq, ts, type, detail)
       VALUES ('device', $1, $2, $3, to_timestamp($4), $5, $6)`,
      [req.deviceId, b.room_id || null, b.seq, b.ts, b.type, b.detail],
    ), { roomId: b.room_id, resetReason });
    if (r.replay) {
      console.log(`[replay] rejected event ${req.deviceId} seq=${b.seq}`);
      return res.status(409).json({ error: 'replay', seq: b.seq, max_seq: r.maxSeq });
    }
    console.log(`[event] ${req.deviceId} ${b.type} ${b.detail}`);
    res.status(201).json({ ok: true, seq: b.seq });
  } catch (e) { next(e); }
});

app.use((_req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
  console.error('[error]', err?.message || err);
  res.status(500).json({ error: 'server error' });
});

// ------------------------------------------------------- offline sweeper ---
async function sweep() {
  try {
    const { rows } = await pool.query(
      `WITH gone AS (
         UPDATE devices SET online = false
          WHERE online AND last_seen < now() - make_interval(secs => $1)
         RETURNING device_id)
       INSERT INTO device_status_log (device_id, state)
       SELECT device_id, 'OFFLINE' FROM gone RETURNING device_id`,
      [OFFLINE_AFTER_S],
    );
    for (const r of rows) console.log(`[presence] ${r.device_id} OFFLINE (silent > ${OFFLINE_AFTER_S}s)`);
  } catch (e) {
    console.error('[sweep]', e.message);
  }
}
const sweeper = setInterval(sweep, SWEEP_MS);

const server = app.listen(PORT, () => {
  console.log(`SmartClass platform listening on :${PORT} (offline after ${OFFLINE_AFTER_S}s)`);
});

function shutdown(sig) {
  console.log(`${sig} received - shutting down`);
  clearInterval(sweeper);
  server.close(() => pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
