const express = require('express');
const { getDeviceConfig } = require('../../config/deviceConfig');
const pairingAgent = require('../../sync/pairingAgent');

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

module.exports = router;
