const express = require('express');
const QRCode = require('qrcode');
const { detectLanIp } = require('../../config/lanIp');

// Renders a QR code (SVG, generated server-side — no client-side library or build step needed)
// encoding this Hub's own Control Panel URL, reachable by any phone on this bus's own WiFi. The
// Display View shows it so a driver/conductor can scan their way straight to this specific bus's
// Panel instead of being told an IP address to type in by hand.
function createPanelQrRouter(port) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const ip = detectLanIp();
    if (!ip) {
      return res.status(503).json({ error: 'lan_ip_unavailable', message: 'Could not detect a LAN address for this PC — set HUB_LAN_IP.' });
    }

    const url = `http://${ip}:${port}/panel/`;

    try {
      const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 512 });
      res.type('image/svg+xml').send(svg);
    } catch (err) {
      res.status(500).json({ error: 'qr_generation_failed', message: err.message });
    }
  });

  return router;
}

module.exports = createPanelQrRouter;
