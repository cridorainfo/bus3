const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.HUB_DB_PATH || path.join(DATA_DIR, 'hub.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// `CREATE TABLE IF NOT EXISTS` doesn't retrofit new columns onto an already-existing dev DB —
// this tiny guard adds them if missing, so `data/hub.db` never needs to be deleted after a
// schema change.
function ensureColumn(table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

ensureColumn('trips', 'direction', "direction TEXT NOT NULL DEFAULT 'going'");
ensureColumn('routes', 'name_ml', 'name_ml TEXT');
ensureColumn('stops', 'ads_enabled', 'ads_enabled INTEGER NOT NULL DEFAULT 0');
ensureColumn('device_config', 'friendly_name', 'friendly_name TEXT');
ensureColumn('device_config', 'api_key', 'api_key TEXT');
ensureColumn('device_config', 'connect_code', 'connect_code TEXT');
ensureColumn('device_config', 'devices_disconnect_last_applied', 'devices_disconnect_last_applied TEXT');
ensureColumn('device_config', 'tier', "tier TEXT DEFAULT 'rural'");
ensureColumn('content_items', 'target_bus_id', 'target_bus_id TEXT');
ensureColumn('content_items', 'display_mode', "display_mode TEXT DEFAULT 'banner'");

db.prepare(`
  UPDATE stops SET route_id = NULL, sequence_no = NULL
  WHERE route_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM route_stops rs WHERE rs.stop_id = stops.stop_id AND rs.route_id = stops.route_id
    )
`).run();

// One-time backfill: stops used to belong to exactly one route (stops.route_id/sequence_no).
// Guarded so unlinking a stop on the cloud side isn't undone on every Hub restart.
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'legacy_route_stops_migrated'").get()) {
  const legacyStops = db
    .prepare('SELECT stop_id, route_id, sequence_no FROM stops WHERE route_id IS NOT NULL')
    .all();
  const insertRouteStop = db.prepare(`
    INSERT OR IGNORE INTO route_stops (route_id, stop_id, sequence_no) VALUES (?, ?, ?)
  `);
  db.transaction(() => {
    for (const s of legacyStops) insertRouteStop.run(s.route_id, s.stop_id, s.sequence_no ?? 0);
    db.prepare("INSERT INTO settings (key, value) VALUES ('legacy_route_stops_migrated', '1')").run();
  })();
}

// One-time rewrite: outro plays only on the trip's last stop; normal stops are chime → filler → stop_name.
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'announcement_outro_last_stop_only'").get()) {
  db.prepare(`
    UPDATE stops SET announcement_template = 'chime,filler,stop_name'
    WHERE announcement_template LIKE '%outro%'
  `).run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('announcement_outro_last_stop_only', '1')").run();
}

// One-time backfill: this bus used to have exactly one route (device_config.route_assigned).
// Carry it forward into assigned_routes so the local route picker has something to show before
// the first sync from the cloud arrives.
const cfg = db.prepare('SELECT route_assigned FROM device_config LIMIT 1').get();
if (cfg && cfg.route_assigned) {
  db.prepare('INSERT OR IGNORE INTO assigned_routes (route_id) VALUES (?)').run(cfg.route_assigned);
}

// Older hub.db files enforced play_logs.content_id -> content_items, which blocks stale-content
// cleanup during sync. Rebuild without that FK whenever it is still present — not only once,
// because a partial migration or copied hub.db can leave the FK behind while the setting flag exists.
function playLogsHasContentIdFk() {
  return db.prepare("PRAGMA foreign_key_list('play_logs')").all().some(
    (f) => f.from === 'content_id' && f.table === 'content_items'
  );
}

function ensurePlayLogsWithoutContentFk() {
  if (!playLogsHasContentIdFk()) return false;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE play_logs_migrated (
        log_id               INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_id              INTEGER REFERENCES trips(trip_id),
        content_id           TEXT,
        campaign_id          TEXT,
        stop_id              TEXT REFERENCES stops(stop_id),
        played_at            TEXT NOT NULL DEFAULT (datetime('now')),
        duration_played_sec  REAL,
        lat                  REAL,
        long                 REAL,
        billable             INTEGER NOT NULL DEFAULT 0,
        synced               INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO play_logs_migrated SELECT * FROM play_logs;
      DROP TABLE play_logs;
      ALTER TABLE play_logs_migrated RENAME TO play_logs;
      CREATE INDEX IF NOT EXISTS idx_play_logs_trip ON play_logs(trip_id);
      CREATE INDEX IF NOT EXISTS idx_play_logs_synced ON play_logs(synced);
    `);
  })();
  db.prepare("INSERT INTO settings (key, value) VALUES ('play_logs_loose_content_id', '1') ON CONFLICT(key) DO NOTHING").run();
  console.log('[db] rebuilt play_logs without content_id FK so sync can delete stale clips');
  return true;
}

ensurePlayLogsWithoutContentFk();

module.exports = db;
module.exports.ensurePlayLogsWithoutContentFk = ensurePlayLogsWithoutContentFk;
