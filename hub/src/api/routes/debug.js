const express = require('express');

// Only mounted when HUB_TRANSPORT=mock (see server.js) — this is what the ESP32 Simulator
// page (public/sim) and the reconnect test (spec Open Question 1) drive.
function createDebugRouter(transport) {
  const router = express.Router();

  router.post('/signal', (req, res) => {
    const { signal } = req.body || {};
    if (![0, 1, 2, 3].includes(signal)) return res.status(400).json({ ok: false, error: 'invalid_signal' });
    transport.injectSignal(signal);
    res.json({ ok: true });
  });

  router.post('/stale', (req, res) => {
    transport.goStale();
    res.json({ ok: true });
  });

  router.post('/reconnect', (req, res) => {
    transport.reconnect();
    res.json({ ok: true });
  });

  router.get('/status', (req, res) => {
    res.json({ connected: transport.isConnected() });
  });

  return router;
}

module.exports = createDebugRouter;
