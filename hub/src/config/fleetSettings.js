const db = require('../db/db');

// Defaults mirror cloud/src/settingsStore.js — kept in sync manually.
const DEFAULTS = {
  ad_interval_sec: 60,
  stop_name_toggle_sec: 4,
};

function currentFleetSettings() {
  const out = { ...DEFAULTS };
  const rows = db.prepare('SELECT key, value FROM settings').all();
  for (const r of rows) {
    const n = Number(r.value);
    if (Number.isFinite(n)) out[r.key] = n;
  }
  return out;
}

module.exports = { DEFAULTS, currentFleetSettings };
