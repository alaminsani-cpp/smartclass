-- FastRobox SmartClass platform - Level 2 schema (PostgreSQL 14+)

CREATE TABLE IF NOT EXISTS devices (
  device_id          text PRIMARY KEY,
  token_hash         text UNIQUE NOT NULL,          -- SHA-256 of the device token (token itself never stored)
  room_id            text,
  fw                 text,
  last_reset_reason  text,
  last_seen          timestamptz,
  online             boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Replay protection: every (device_id, seq) is accepted exactly once,
-- whatever kind of message carried it.
CREATE TABLE IF NOT EXISTS seen_seq (
  device_id   text NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  seq         bigint NOT NULL,
  kind        text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, seq)
);

CREATE TABLE IF NOT EXISTS telemetry (
  id            bigserial PRIMARY KEY,
  device_id     text NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  room_id       text NOT NULL,
  seq           bigint NOT NULL,
  ts            timestamptz NOT NULL,               -- when the reading was TAKEN (device clock, NTP)
  uptime_s      integer NOT NULL,
  temp_c        real,
  rh            real,
  heat_index_c  real,
  flame         boolean NOT NULL,
  door          text NOT NULL CHECK (door IN ('LOCKED','UNLOCKED')),
  status        text NOT NULL CHECK (status IN ('SAFE','WARNING','DANGER','FIRE')),
  heat_trend    text NOT NULL CHECK (heat_trend IN ('RISING','STABLE','FALLING')),
  rssi          smallint,
  heap_kb       integer NOT NULL,
  chip_temp_c   real,
  fw            text NOT NULL,
  quality       text NOT NULL CHECK (quality IN ('good','bad')),
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, seq)
);
CREATE INDEX IF NOT EXISTS telemetry_dev_ts ON telemetry (device_id, ts DESC);

-- Device events carry the device seq; server events (later levels) have seq NULL
-- and are identified by id (the "server ID").
CREATE TABLE IF NOT EXISTS events (
  id           bigserial PRIMARY KEY,
  source       text NOT NULL DEFAULT 'device' CHECK (source IN ('device','server')),
  device_id    text REFERENCES devices(device_id) ON DELETE CASCADE,
  room_id      text,
  seq          bigint,
  ts           timestamptz NOT NULL,
  type         text NOT NULL,
  detail       text NOT NULL DEFAULT '',
  received_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS events_dev_seq ON events (device_id, seq) WHERE seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_type_ts ON events (type, ts DESC);

-- Online/offline history
CREATE TABLE IF NOT EXISTS device_status_log (
  id         bigserial PRIMARY KEY,
  device_id  text NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  state      text NOT NULL CHECK (state IN ('ONLINE','OFFLINE')),
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS status_log_dev_at ON device_status_log (device_id, at DESC);
