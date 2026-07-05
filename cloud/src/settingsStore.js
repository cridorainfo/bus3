const db = require('./db/db');

// Fleet-wide behavior knobs, editable from Admin (api/routes/settings.js) and shipped to every
// bus inside sync_state (sync/hubSyncServer.js). Shared here so both sides agree on the
// allowlist and defaults without requiring each other (which would be circular).
const EDITABLE = {
  // How often (seconds) the passenger screen rotates to a fresh ad between stops.
  ad_interval_sec: { min: 10, max: 3600, default: 60 },
  // How often (seconds) the passenger screen alternates stop names between Malayalam and English.
  stop_name_toggle_sec: { min: 2, max: 120, default: 4 },
};

function currentSettings() {
  const out = {};
  for (const [key, spec] of Object.entries(EDITABLE)) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    const num = row ? Number(row.value) : NaN;
    out[key] = Number.isFinite(num) ? num : spec.default;
  }
  return out;
}

module.exports = { EDITABLE, currentSettings };
