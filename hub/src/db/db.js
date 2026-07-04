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

// One-time backfill: stops used to belong to exactly one route (stops.route_id/sequence_no).
// Now that ordering lives in route_stops, carry forward any stop that predates this change and
// isn't in route_stops yet (idempotent — only inserts rows that don't already exist).
const legacyStops = db
  .prepare('SELECT stop_id, route_id, sequence_no FROM stops WHERE route_id IS NOT NULL')
  .all();
const insertRouteStop = db.prepare(`
  INSERT OR IGNORE INTO route_stops (route_id, stop_id, sequence_no) VALUES (?, ?, ?)
`);
db.transaction(() => {
  for (const s of legacyStops) insertRouteStop.run(s.route_id, s.stop_id, s.sequence_no ?? 0);
})();

// One-time rewrite: the announcement template now always includes the shared `filler` segment,
// and the old additive `sponsor_snippet` token is superseded by the ads_enabled swap mechanism.
db.prepare(`
  UPDATE stops SET announcement_template = 'chime,filler,stop_name,outro'
  WHERE announcement_template NOT LIKE '%filler%'
`).run();

module.exports = db;
