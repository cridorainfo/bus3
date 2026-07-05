const express = require('express');
const db = require('../../db/db');
const { pushSyncStateToBus, busIdsAffectedByRoute } = require('../../sync/hubSyncServer');

const router = express.Router();

function pushToBusIds(busIds) {
  const pushed = [];
  const offline = [];
  for (const busId of busIds) {
    if (pushSyncStateToBus(busId)) pushed.push(busId);
    else offline.push(busId);
  }
  return { pushed, offline, total: busIds.length };
}

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

  const { pushed, offline, total } = pushToBusIds(targets);
  res.json({ ok: true, pushed, offline, total });
});

// Push route/stop updates to buses — all buses, or only those assigned to the given routes.
router.post('/push-routes', (req, res) => {
  const { route_ids: routeIds, bus_ids: busIds } = req.body || {};
  let targets;
  if (Array.isArray(busIds) && busIds.length > 0) {
    targets = busIds.filter((id) => db.prepare('SELECT 1 FROM buses WHERE bus_id = ?').get(id));
  } else if (Array.isArray(routeIds) && routeIds.length > 0) {
    const set = new Set();
    for (const routeId of routeIds) {
      for (const id of busIdsAffectedByRoute(routeId)) set.add(id);
    }
    targets = Array.from(set);
  } else {
    targets = db.prepare('SELECT bus_id FROM buses').all().map((r) => r.bus_id);
  }

  const { pushed, offline, total } = pushToBusIds(targets);
  res.json({ ok: true, pushed, offline, total });
});

module.exports = router;
