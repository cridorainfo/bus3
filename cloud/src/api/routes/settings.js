const express = require('express');
const db = require('../../db/db');
const { EDITABLE, currentSettings } = require('../../settingsStore');
const { pushSyncStateToBuses, busIdsAffectedByRoute } = require('../../sync/hubSyncServer');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(currentSettings());
});

// Deliberately an allowlist (EDITABLE), not free-form key/value from the client — a bad request
// can't plant arbitrary settings the Hubs then trust.
router.put('/', (req, res) => {
  const body = req.body || {};
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

  for (const [key, spec] of Object.entries(EDITABLE)) {
    if (body[key] === undefined) continue;
    const num = Number(body[key]);
    if (!Number.isFinite(num) || num < spec.min || num > spec.max) {
      return res.status(400).json({ error: 'invalid_value', key, min: spec.min, max: spec.max });
    }
    upsert.run(key, String(Math.round(num)));
  }

  // Settings are fleet-wide — push to every online bus immediately (offline ones catch up on
  // their next hello, same as all other sync_state content).
  pushSyncStateToBuses(busIdsAffectedByRoute(null));

  res.json(currentSettings());
});

module.exports = router;
