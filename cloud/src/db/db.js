const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.CLOUD_DB_PATH || path.join(__dirname, '..', '..', 'data', 'cloud.db');

// Ensure the DB file's directory exists — matters both for the default local path and for a
// custom CLOUD_DB_PATH pointing at a mounted volume (e.g. Railway's /data), which won't exist
// on a brand-new volume until something creates it.
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// `CREATE TABLE IF NOT EXISTS` doesn't retrofit new columns onto an already-existing dev DB —
// this guard adds them if missing, so `data/cloud.db` never needs to be deleted after a schema
// change (mirrors the same helper in hub/src/db/db.js).
function ensureColumn(table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

ensureColumn('routes', 'name_ml', 'name_ml TEXT');
ensureColumn('stops', 'ads_enabled', 'ads_enabled INTEGER NOT NULL DEFAULT 0');
ensureColumn('buses', 'friendly_name', 'friendly_name TEXT');
ensureColumn('buses', 'paired_at', 'paired_at TEXT');
ensureColumn('buses', 'connect_code', 'connect_code TEXT');
ensureColumn('buses', 'devices_disconnect_at', 'devices_disconnect_at TEXT');
ensureColumn('pending_pairings', 'last_seen_at', 'last_seen_at TEXT');
ensureColumn('content_items', 'target_bus_id', 'target_bus_id TEXT REFERENCES buses(bus_id)');
ensureColumn('content_items', 'display_mode', "display_mode TEXT DEFAULT 'banner'");

// Stops.route_id is vestigial — if it points at a route the stop is no longer linked to,
// clear it so the legacy backfill below can't resurrect removed route members on restart.
db.prepare(`
  UPDATE stops SET route_id = NULL, sequence_no = NULL
  WHERE route_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM route_stops rs WHERE rs.stop_id = stops.stop_id AND rs.route_id = stops.route_id
    )
`).run();

// One-time backfill: stops used to belong to exactly one route — carry forward any pre-existing
// route_id/sequence_no into route_stops. Guarded so it never runs again after the first boot —
// otherwise unlinking a stop (route_stops delete) leaves stops.route_id set and every deploy
// restart re-inserts the stop into the route.
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

// One-time backfill: a bus used to have exactly one assigned route (buses.route_id) — carry it
// forward into bus_routes so existing assignments aren't lost now that a bus can run several.
const legacyBusRoutes = db.prepare('SELECT bus_id, route_id FROM buses WHERE route_id IS NOT NULL').all();
const insertBusRoute = db.prepare('INSERT OR IGNORE INTO bus_routes (bus_id, route_id) VALUES (?, ?)');
db.transaction(() => {
  for (const b of legacyBusRoutes) insertBusRoute.run(b.bus_id, b.route_id);
})();

module.exports = db;
