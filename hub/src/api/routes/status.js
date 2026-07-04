const express = require('express');
const state = require('../../engine/state');

// Fault surfacing per spec 3.1/15: hardware/connectivity problems are never shown to the
// driver as an actionable error — this endpoint exists for the Control Panel's status lights
// and, eventually, the depot/admin dashboard (Phase 2), not as a "fix this" prompt on the bus.
function createStatusRouter(watchdog) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const wd = watchdog.getStatus();
    res.json({
      bus: state.bus,
      esp32: { connected: wd.connected, lastHeartbeatAt: wd.lastHeartbeatAt, lastFault: wd.lastFault },
      router_internet: false, // stubbed — real connectivity check arrives with the Phase 2 sync engine
      last_sync_at: null, // stubbed — no cloud sync yet
      trip_active: !!state.trip,
    });
  });

  return router;
}

module.exports = createStatusRouter;
