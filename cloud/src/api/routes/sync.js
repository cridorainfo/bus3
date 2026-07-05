const express = require('express');
const db = require('../../db/db');
const { pushSyncStateToBus } = require('../../sync/hubSyncServer');

const router = express.Router();

// Manual re-push of sync_state — routes/stops/content/settings already on the cloud are
// re-sent to chosen buses (or every bus). Only buses with an open /hub-sync socket receive it
// immediately; others catch up on their next reconnect.
router.post('/push', (req, res) => {
  const { bus_ids: busIds } = req.body || {};
  let targets;
  if (Array.isArray(busIds) && busIds.length > 0) {
    targets = busIds.filter((id) => db.prepare('SELECT 1 FROM buses WHERE bus_id = ?').get(id));
  } else {
    targets = db.prepare('SELECT bus_id FROM buses').all().map((r) => r.bus_id);
  }

  const pushed = [];
  const offline = [];
  for (const busId of targets) {
    if (pushSyncStateToBus(busId)) pushed.push(busId);
    else offline.push(busId);
  }

  res.json({ ok: true, pushed, offline, total: targets.length });
});

module.exports = router;
