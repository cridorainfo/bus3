const express = require('express');
const { getDeviceConfig } = require('../../config/deviceConfig');
const { CLOUD_HTTP_BASE } = require('../../config/cloudConfig');
const pairingAgent = require('../../sync/pairingAgent');
const syncAgent = require('../../sync/syncAgent');
const { requireDevice } = require('./auth');

const router = express.Router();

// Read by the Display View to decide whether to show the pairing-ID screen or the normal
// ads/progress-strip view — see public/display/app.js.
router.get('/status', (req, res) => {
  const cfg = getDeviceConfig();
  res.json({
    paired: !!cfg,
    reg_number: cfg ? cfg.reg_number : null,
    device_pairing_id: cfg ? null : pairingAgent.getCurrentPairingId(),
  });
});

// Driver/conductor-initiated Disconnect from Server (Panel's Report screen) — same effect as
// the admin clicking it in the cloud dashboard, just started from the bus end. Best-effort
// tells the cloud first (so the bus record flips to Awaiting Pairing and its api_key rotates —
// if the cloud is reachable it'll also push its own 'unpaired' back, which is harmless/idempotent),
// then resets locally either way. The reset itself is deferred until any active trip ends
// (never mid-route), after which the Display View shows a fresh pairing ID for re-pairing.
router.post('/unpair', requireDevice, async (req, res) => {
  const cfg = getDeviceConfig();
  if (!cfg) return res.json({ ok: true, already_unpaired: true });

  try {
    await fetch(`${CLOUD_HTTP_BASE}/api/buses/${encodeURIComponent(cfg.bus_id)}/unpair`, { method: 'POST' });
  } catch (err) {
    // offline — the local reset below still invalidates this Hub's copy; the cloud side catches
    // up the next time anything tries to connect with the now-abandoned credentials
  }

  syncAgent.requestLocalUnpair();
  res.json({ ok: true });
});

module.exports = router;
