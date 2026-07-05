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
    announcement_template TEXT NOT NULL DEFAULT 'chime,filler,stop_name'
);

CREATE TABLE IF NOT EXISTS route_stops (
    route_id     TEXT NOT NULL REFERENCES routes(route_id),
    stop_id      TEXT NOT NULL REFERENCES stops(stop_id),
    sequence_no  INTEGER NOT NULL,
    PRIMARY KEY (route_id, stop_id)
);

CREATE TABLE IF NOT EXISTS content_items (
    content_id        TEXT PRIMARY KEY,
    type              TEXT NOT NULL, -- chime | filler | stop_name | stop_name_ad | outro | ad_video | ad_banner | ad_image | music
    file_path         TEXT NOT NULL, -- served at /content/<file_path>
    original_filename  TEXT,
    duration_sec      REAL,
    tier              TEXT,
    advertiser_id     TEXT,
    campaign_id       TEXT,
    route_id          TEXT REFERENCES routes(route_id),
    stop_id           TEXT REFERENCES stops(stop_id),
    target_bus_id     TEXT REFERENCES buses(bus_id), -- single-bus ad targeting (mutually exclusive with route_id/tier in the UI)
    display_mode      TEXT DEFAULT 'banner', -- ad_banner images only: 'banner' (bottom strip) | 'fullscreen' (center, like video)
    active_from       TEXT,
    active_to         TEXT,
    uploaded_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaigns (
    campaign_id      TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    advertiser_name  TEXT,
    rate_paisa       INTEGER NOT NULL DEFAULT 25,
    budget_paisa     INTEGER,              -- NULL = unlimited/free
    spent_paisa      INTEGER NOT NULL DEFAULT 0,
    active           INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bus Management (spec 12) + live status fields, updated in near-real-time by the Hub's sync
-- agent while connected (spec "Fleet Health" light version for this sample).
-- route_id here is a read-only mirror of whichever route the bus is actively running right now
-- (set by the live-status report) — the admin's *assignment* of routes to a bus lives in
-- bus_routes below, since a bus can now run more than one route.
CREATE TABLE IF NOT EXISTS buses (
    bus_id                    TEXT PRIMARY KEY,
    reg_number                TEXT NOT NULL,
    friendly_name             TEXT,
    api_key                   TEXT NOT NULL UNIQUE,
    tier                      TEXT DEFAULT 'rural',
    hardware_version          TEXT,
    route_id                  TEXT REFERENCES routes(route_id),
    created_at                TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at              TEXT,
    esp32_connected           INTEGER NOT NULL DEFAULT 0,
    trip_active               INTEGER NOT NULL DEFAULT 0,
    current_stop_index        INTEGER,
    current_direction         TEXT,
    -- Last time this bus was (re)paired via a device pairing ID claim — see pending_pairings
    -- below. Rotates api_key on every claim, so a lost/wiped Hub disk's old key stops working
    -- the moment the replacement Hub is paired.
    paired_at                 TEXT,
    -- Persistent phone connect code (replaces the old daily_pin concept) + a bumped timestamp
    -- that tells every paired phone to disconnect the next time the bus's Hub is online.
    connect_code              TEXT,
    devices_disconnect_at     TEXT
);

-- Device-code pairing (spec: the Hub generates and displays its own short ID; an admin reads
-- it off the bus's screen and claims it against a bus record here — no typing ever happens at
-- the unattended, keyboard-less Hub PC). A pending row with no claimed_bus_id is just waiting;
-- the Hub polls GET /api/pair/status/:id until one shows up.
CREATE TABLE IF NOT EXISTS pending_pairings (
    device_pairing_id  TEXT PRIMARY KEY,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    -- Refreshed on every /register call while the Hub keeps polling — lets the Admin list only
    -- show IDs that are actually still live, instead of one a Hub broadcast once and then
    -- disappeared (crashed, lost network, got a new ID after a restart) but that lingers in
    -- this table for up to PENDING_EXPIRY_MS regardless.
    last_seen_at        TEXT NOT NULL DEFAULT (datetime('now')),
    claimed_bus_id      TEXT REFERENCES buses(bus_id),
    claimed_api_key     TEXT,
    claimed_at          TEXT
);

-- Which routes a bus is allowed to run. The driver/conductor picks the active one locally on
-- the Hub (device_config.route_assigned) from whatever's in here for their bus — no cloud
-- round-trip needed to switch, since all assigned routes are already synced down.
CREATE TABLE IF NOT EXISTS bus_routes (
    bus_id    TEXT NOT NULL REFERENCES buses(bus_id),
    route_id  TEXT NOT NULL REFERENCES routes(route_id),
    PRIMARY KEY (bus_id, route_id)
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

-- Fleet-wide behavior settings (e.g. ad_interval_sec — how often the screen rotates ads;
-- stop_name_toggle_sec — how often stop names alternate EN/ML on the passenger display),
-- editable from Admin's Content tab and shipped to every bus inside sync_state.
CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);

-- Hub software releases (the Hub's *code*, not its data — routes/stops/content already sync
-- live via hubSyncServer). A staged release isn't visible to Hubs until published; publishing
-- lets an admin stage + review before rolling out, and unpublish/delete give a way to pull a bad
-- release before it reaches any more buses (a Hub that already applied it rolls back on its own
-- if it crash-loops — see hub/src/bootGuard.js).
CREATE TABLE IF NOT EXISTS hub_releases (
    version           TEXT PRIMARY KEY,
    notes             TEXT,
    file_path         TEXT NOT NULL, -- relative to RELEASES_DIR
    checksum_sha256   TEXT NOT NULL,
    published         INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stops_route ON stops(route_id, sequence_no);
CREATE INDEX IF NOT EXISTS idx_route_stops_route ON route_stops(route_id, sequence_no);
CREATE INDEX IF NOT EXISTS idx_route_stops_stop ON route_stops(stop_id);
CREATE INDEX IF NOT EXISTS idx_content_items_route ON content_items(route_id);
CREATE INDEX IF NOT EXISTS idx_content_items_stop ON content_items(stop_id);
CREATE INDEX IF NOT EXISTS idx_buses_route ON buses(route_id);
CREATE INDEX IF NOT EXISTS idx_bus_routes_bus ON bus_routes(bus_id);
CREATE INDEX IF NOT EXISTS idx_bus_routes_route ON bus_routes(route_id);
CREATE INDEX IF NOT EXISTS idx_trips_bus ON trips(bus_id);
CREATE INDEX IF NOT EXISTS idx_play_logs_bus ON play_logs(bus_id);
