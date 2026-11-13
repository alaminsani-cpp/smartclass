// Live view of the database for the judges (refreshes every 2 s).
//   npm run tail            newest records
//   npm run tail -- count   just the record counts (for the replay test)
import { pool } from '../src/db.js';

const mode = process.argv[2];
const fmt = (d) => d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', hour12: false }) : '-';

async function counts() {
  const { rows: [c] } = await pool.query(
    `SELECT (SELECT count(*) FROM telemetry) AS telemetry, (SELECT count(*) FROM events) AS events,
            (SELECT count(*) FROM seen_seq) AS messages`);
  return c;
}

async function show() {
  const c = await counts();
  if (mode === 'count') {
    console.log(`${fmt(new Date())}  telemetry=${c.telemetry}  events=${c.events}  messages=${c.messages}`);
    return;
  }
  const dev = await pool.query(
    `SELECT device_id, online, last_seen, fw, room_id, last_reset_reason,
            extract(epoch FROM now() - last_seen)::int AS silent_s FROM devices ORDER BY device_id`);
  const tel = await pool.query(
    `SELECT seq, ts, received_at, room_id, temp_c, rh, heat_index_c, flame, door, status, heat_trend,
            rssi, heap_kb, chip_temp_c, fw, quality, uptime_s
       FROM telemetry ORDER BY ts DESC, seq DESC LIMIT 8`);
  const ev = await pool.query(`SELECT seq, ts, type, detail FROM events ORDER BY ts DESC, id DESC LIMIT 6`);
  const st = await pool.query(`SELECT device_id, state, at FROM device_status_log ORDER BY at DESC LIMIT 4`);
  console.clear();
  console.log(`SmartClass DB  ${fmt(new Date())} (Asia/Dhaka)   telemetry=${c.telemetry} events=${c.events}\n`);
  console.log('DEVICES');
  console.table(dev.rows.map((d) => ({ device: d.device_id, state: d.online ? 'ONLINE' : 'OFFLINE',
    last_seen: fmt(d.last_seen), silent_s: d.silent_s, room: d.room_id, fw: d.fw, last_reset: d.last_reset_reason })));
  console.log('NEWEST TELEMETRY (ts = when the reading was taken)');
  console.table(tel.rows.map((t, i, a) => ({ seq: t.seq, ts: fmt(t.ts),
    gap_s: a[i + 1] ? Math.round((new Date(t.ts) - new Date(a[i + 1].ts)) / 1000) : '', room: t.room_id,
    T: t.temp_c, RH: t.rh, HI: t.heat_index_c, flame: t.flame, door: t.door, status: t.status,
    trend: t.heat_trend, rssi: t.rssi, heap: t.heap_kb, chip: t.chip_temp_c, fw: t.fw, q: t.quality, up: t.uptime_s })));
  console.log('NEWEST EVENTS');
  console.table(ev.rows.map((e) => ({ seq: e.seq, ts: fmt(e.ts), type: e.type, detail: e.detail })));
  console.log('ONLINE / OFFLINE LOG');
  console.table(st.rows.map((s) => ({ device: s.device_id, state: s.state, at: fmt(s.at) })));
}

const once = process.argv.includes('--once');
await show();
if (once) await pool.end();
else setInterval(() => show().catch((e) => console.error(e.message)), 2000);
