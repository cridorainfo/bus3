-- AdKerala Local Hub — SQLite schema (Phase 1)
-- Append-only where noted; `synced` flags track the outbox to the cloud (Phase 2).
-- campaign_quotas / billable exist now so Phase 3 doesn't need a migration, but are inert in Phase 1.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- route_assigned means "the route currently selected as active by the driver/conductor,
-- locally" — not "what the admin assigned." The set of routes the admin has assigned to this
-- bus (which the local route picker offers) lives in assigned_routes below.
--
-- This table having zero rows means "unpaired" — a fresh/reinstalled Hub with no identity yet.
-- Pairing (src/sync/pairingAgent.js) is what creates this row: the Hub generates and displays
-- its own pairing ID (see pending_pairing below), an admin claims it from the Admin dashboard
-- against a real bus record, and the Hub polls the cloud until that claim shows up.
CREATE TABLE IF NOT EXISTS device_config (
    bus_id                          TEXT PRIMARY KEY,
    reg_number                      TEXT NOT NULL,
    friendly_name                   TEXT,
    api_key                         TEXT,
    route_assigned                  TEXT,
    hardware_version                TEXT,
    tier                            TEXT DEFAULT 'rural', -- synced from the cloud's buses.tier — read by ad targeting/selection
    esp32_vid                       TEXT,
    esp32_pid                       TEXT,
    last_sync_at                    TEXT,
    connect_code                    TEXT,    -- synced from cloud; what a phone's connect screen checks against
    devices_disconnect_last_applied TEXT     -- bookkeeping so a repeated sync doesn't re-clear paired_devices
);

-- Fleet-wide behavior settings synced down from the cloud (e.g. ad_interval_sec — how often
-- the passenger screen rotates ads; stop_name_toggle_sec — EN/ML stop-name alternation).
CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);

-- Holds the Hub's self-generated pairing ID while waiting to be claimed (kept stable across
-- restarts rather than regenerating each boot). Separate from device_config, whose presence
-- means "already paired" — a single row, cleared once claimed.
CREATE TABLE IF NOT EXISTS pending_pairing (
    device_pairing_id  TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Phones that have connected to this bus's Control Panel and stay paired until they disconnect
-- (switching to another bus) or an admin disconnects everyone (see devices_disconnect_at
-- handling in src/sync/syncAgent.js) — replaces asking for a PIN on every action.
CREATE TABLE IF NOT EXISTS paired_devices (
    device_token  TEXT PRIMARY KEY,
    paired_at     TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at  TEXT
);

-- Local mirror of the cloud's bus_routes for this bus — synced down by syncAgent, fully
-- reconciled on every sync_state (rows not in the latest incoming set are removed). The phone
-- Control Panel's route picker reads from here; switching the active route never needs the
-- cloud, since everything it could pick is already downloaded.
CREATE TABLE IF NOT EXISTS assigned_routes (
    route_id  TEXT PRIMARY KEY REFERENCES routes(route_id)
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
    target_bus_id  TEXT, -- no local `buses` table on the hub (its own identity lives in device_config) — plain value, cloud already scoped it correctly
    display_mode   TEXT DEFAULT 'banner', -- ad_banner images only: 'banner' | 'fullscreen'
    active_from    TEXT,
    active_to      TEXT
);

-- Local mirror of the cloud's campaigns — enough to know a campaign is unlimited/free (no quota
-- row needed at all) without waiting on a campaign_quotas row to show up.
CREATE TABLE IF NOT EXISTS campaigns (
    campaign_id   TEXT PRIMARY KEY,
    name          TEXT,
    rate_paisa    INTEGER NOT NULL DEFAULT 25,
    budget_paisa  INTEGER,   -- NULL = unlimited/free
    active        INTEGER NOT NULL DEFAULT 1
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

-- Append-only billing ledger. Never delete before synced=1. content_id is a loose reference
-- (no FK, matching the cloud's own play_logs schema) — a content_item can legitimately be
-- deleted from the cloud (and cascade-deleted from every Hub, see syncAgent.js's applySyncState)
-- after it's already been played and logged; the historical log row must survive that deletion.
CREATE TABLE IF NOT EXISTS play_logs (
    log_id               INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id              INTEGER REFERENCES trips(trip_id),
    content_id           TEXT,
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
