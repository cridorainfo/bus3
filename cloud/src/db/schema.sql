-- AdKerala cloud-lite server schema (sample Phase 2 scope: SQLite, not Postgres).
-- Mirrors the Hub's shape for routes/stops/content_items (spec 4.4) so sync is a straight
-- upsert in both directions, plus `buses` (spec 12 Bus Management) and landing tables for
-- what buses report up (spec 8 Sync Engine).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS routes (
    route_id    TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    name_ml     TEXT,
    tier        TEXT DEFAULT 'rural',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Stops are global — the same physical stop (and its recorded audio) can be linked into any
-- number of routes via route_stops below, instead of duplicating it per route.
-- route_id/sequence_no here are vestigial (route it was created under) and unused by queries.
CREATE TABLE IF NOT EXISTS stops (
    stop_id               TEXT PRIMARY KEY,
    route_id              TEXT REFERENCES routes(route_id),
    name_ml               TEXT NOT NULL,
    name_en               TEXT,
    sequence_no           INTEGER,
    ads_enabled           INTEGER NOT NULL DEFAULT 0,
    announcement_template TEXT NOT NULL DEFAULT 'chime,filler,stop_name,outro'
);

CREATE TABLE IF NOT EXISTS route_stops (
    route_id     TEXT NOT NULL REFERENCES routes(route_id),
    stop_id      TEXT NOT NULL REFERENCES stops(stop_id),
    sequence_no  INTEGER NOT NULL,
    PRIMARY KEY (route_id, stop_id)
);

CREATE TABLE IF NOT EXISTS content_items (
    content_id        TEXT PRIMARY KEY,
    type              TEXT NOT NULL, -- chime | filler | stop_name | stop_name_ad | outro | ad_video | ad_banner | music
    file_path         TEXT NOT NULL, -- served at /content/<file_path>
    original_filename  TEXT,
    duration_sec      REAL,
    tier              TEXT,
    advertiser_id     TEXT,
    campaign_id       TEXT,
    route_id          TEXT REFERENCES routes(route_id),
    stop_id           TEXT REFERENCES stops(stop_id),
    active_from       TEXT,
    active_to         TEXT,
    uploaded_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bus Management (spec 12) + live status fields, updated in near-real-time by the Hub's sync
-- agent while connected (spec "Fleet Health" light version for this sample).
CREATE TABLE IF NOT EXISTS buses (
    bus_id               TEXT PRIMARY KEY,
    reg_number           TEXT NOT NULL,
    api_key              TEXT NOT NULL UNIQUE,
    tier                 TEXT DEFAULT 'rural',
    hardware_version     TEXT,
    route_id             TEXT REFERENCES routes(route_id),
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at         TEXT,
    esp32_connected      INTEGER NOT NULL DEFAULT 0,
    trip_active          INTEGER NOT NULL DEFAULT 0,
    current_stop_index   INTEGER,
    current_direction    TEXT
);

-- Landing zone for what each bus reports up (spec 8). hub_trip_id/hub_log_id are the Hub's own
-- local autoincrement IDs, kept alongside bus_id so they're globally unique here.
CREATE TABLE IF NOT EXISTS trips (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    bus_id              TEXT NOT NULL REFERENCES buses(bus_id),
    hub_trip_id         INTEGER NOT NULL,
    route_id            TEXT,
    start_time          TEXT,
    end_time            TEXT,
    current_stop_index  INTEGER,
    started_via         TEXT,
    direction            TEXT,
    auto_closed         INTEGER,
    received_at         TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(bus_id, hub_trip_id)
);

CREATE TABLE IF NOT EXISTS play_logs (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    bus_id               TEXT NOT NULL REFERENCES buses(bus_id),
    hub_log_id           INTEGER NOT NULL,
    trip_id              INTEGER,
    content_id           TEXT,
    campaign_id          TEXT,
    stop_id              TEXT,
    played_at            TEXT,
    duration_played_sec  REAL,
    billable             INTEGER,
    received_at          TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(bus_id, hub_log_id)
);

CREATE INDEX IF NOT EXISTS idx_stops_route ON stops(route_id, sequence_no);
CREATE INDEX IF NOT EXISTS idx_route_stops_route ON route_stops(route_id, sequence_no);
CREATE INDEX IF NOT EXISTS idx_route_stops_stop ON route_stops(stop_id);
CREATE INDEX IF NOT EXISTS idx_content_items_route ON content_items(route_id);
CREATE INDEX IF NOT EXISTS idx_content_items_stop ON content_items(stop_id);
CREATE INDEX IF NOT EXISTS idx_buses_route ON buses(route_id);
CREATE INDEX IF NOT EXISTS idx_trips_bus ON trips(bus_id);
CREATE INDEX IF NOT EXISTS idx_play_logs_bus ON play_logs(bus_id);
