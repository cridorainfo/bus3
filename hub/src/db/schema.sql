-- AdKerala Local Hub — SQLite schema (Phase 1)
-- Append-only where noted; `synced` flags track the outbox to the cloud (Phase 2).
-- campaign_quotas / billable exist now so Phase 3 doesn't need a migration, but are inert in Phase 1.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS device_config (
    bus_id            TEXT PRIMARY KEY,
    reg_number        TEXT NOT NULL,
    route_assigned    TEXT,
    hardware_version  TEXT,
    esp32_vid         TEXT,
    esp32_pid         TEXT,
    last_sync_at      TEXT
);

CREATE TABLE IF NOT EXISTS routes (
    route_id    TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    name_ml     TEXT,
    tier        TEXT DEFAULT 'rural',      -- rural / urban_standard / urban_women_premium
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Stops are global (not owned by one route) — the same physical stop, with its own recorded
-- audio, can be linked into any number of routes via `route_stops` below. `route_id`/
-- `sequence_no` here are vestigial (the route a stop happened to be created under) and unused
-- by any query — real ordering lives in `route_stops.sequence_no`.
CREATE TABLE IF NOT EXISTS stops (
    stop_id               TEXT PRIMARY KEY,
    route_id              TEXT REFERENCES routes(route_id),
    name_ml               TEXT NOT NULL,
    name_en               TEXT,
    sequence_no           INTEGER,
    ads_enabled           INTEGER NOT NULL DEFAULT 0, -- swap stop_name -> stop_name_ad when true (and a clip exists)
    announcement_template TEXT NOT NULL DEFAULT 'chime,filler,stop_name,outro' -- comma list; stop_name is swapped for stop_name_ad when ads_enabled
);

-- Which routes include which stops, and in what order. A stop can belong to many routes.
CREATE TABLE IF NOT EXISTS route_stops (
    route_id     TEXT NOT NULL REFERENCES routes(route_id),
    stop_id      TEXT NOT NULL REFERENCES stops(stop_id),
    sequence_no  INTEGER NOT NULL,
    PRIMARY KEY (route_id, stop_id)
);

CREATE TABLE IF NOT EXISTS content_items (
    content_id     TEXT PRIMARY KEY,
    type           TEXT NOT NULL,           -- chime | filler | stop_name | stop_name_ad | outro | ad_video | ad_banner | music | sponsor_snippet(legacy)
    file_path      TEXT NOT NULL,
    duration_sec   REAL,
    tier           TEXT,
    advertiser_id  TEXT,
    campaign_id    TEXT,
    route_id       TEXT REFERENCES routes(route_id),
    stop_id        TEXT REFERENCES stops(stop_id),
    active_from    TEXT,
    active_to      TEXT
);

-- Inert in Phase 1 — scheduler always treats quota as unlimited until the Phase 3 Pacing Engine exists.
CREATE TABLE IF NOT EXISTS campaign_quotas (
    campaign_id    TEXT NOT NULL,
    date           TEXT NOT NULL,
    plays_allotted INTEGER NOT NULL DEFAULT 0,
    plays_used     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (campaign_id, date)
);

CREATE TABLE IF NOT EXISTS playlists (
    playlist_id  TEXT PRIMARY KEY,
    route_id     TEXT REFERENCES routes(route_id),
    rules_json   TEXT
);

CREATE TABLE IF NOT EXISTS trips (
    trip_id             INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id            TEXT REFERENCES routes(route_id),
    start_time          TEXT NOT NULL,
    end_time            TEXT,
    current_stop_index  INTEGER NOT NULL DEFAULT 0,
    started_via         TEXT NOT NULL DEFAULT 'phone', -- phone | button_fallback
    direction           TEXT NOT NULL DEFAULT 'going', -- going | return
    auto_closed         INTEGER NOT NULL DEFAULT 0,
    synced              INTEGER NOT NULL DEFAULT 0
);

-- Append-only billing ledger. Never delete before synced=1.
CREATE TABLE IF NOT EXISTS play_logs (
    log_id               INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id              INTEGER REFERENCES trips(trip_id),
    content_id           TEXT REFERENCES content_items(content_id),
    campaign_id          TEXT,
    stop_id              TEXT REFERENCES stops(stop_id),
    played_at            TEXT NOT NULL DEFAULT (datetime('now')),
    duration_played_sec  REAL,
    lat                  REAL,
    long                 REAL,
    billable             INTEGER NOT NULL DEFAULT 0, -- 0/1, see spec 9.2a — inert until Phase 3 billing
    synced               INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stop_segment_timings (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id       TEXT REFERENCES routes(route_id),
    from_stop_seq  INTEGER,
    to_stop_seq    INTEGER,
    trip_id        INTEGER REFERENCES trips(trip_id),
    duration_sec   REAL NOT NULL,
    recorded_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Raw ESP32 signal log, append-only.
CREATE TABLE IF NOT EXISTS button_events (
    event_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    signal     INTEGER NOT NULL,
    timestamp  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_queue (
    queue_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name  TEXT NOT NULL,
    row_id      TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Whoever is assigned to this bus today — backs the shared per-bus-per-day PIN (spec 7.1).
CREATE TABLE IF NOT EXISTS roster (
    person_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    role           TEXT NOT NULL, -- driver | conductor
    bus_id         TEXT REFERENCES device_config(bus_id),
    assigned_date  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_pin (
    bus_id   TEXT NOT NULL,
    date     TEXT NOT NULL,
    pin      TEXT NOT NULL,
    PRIMARY KEY (bus_id, date)
);

CREATE TABLE IF NOT EXISTS issues (
    issue_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id      INTEGER REFERENCES trips(trip_id),
    description  TEXT NOT NULL,
    reported_at  TEXT NOT NULL DEFAULT (datetime('now')),
    synced       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_stops_route ON stops(route_id, sequence_no);
CREATE INDEX IF NOT EXISTS idx_route_stops_route ON route_stops(route_id, sequence_no);
CREATE INDEX IF NOT EXISTS idx_route_stops_stop ON route_stops(stop_id);
CREATE INDEX IF NOT EXISTS idx_content_items_stop ON content_items(stop_id);
CREATE INDEX IF NOT EXISTS idx_content_items_type ON content_items(type);
CREATE INDEX IF NOT EXISTS idx_play_logs_trip ON play_logs(trip_id);
CREATE INDEX IF NOT EXISTS idx_play_logs_synced ON play_logs(synced);
CREATE INDEX IF NOT EXISTS idx_trips_synced ON trips(synced);
