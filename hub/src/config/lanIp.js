const os = require('os');

// The address a phone on this bus's own WiFi should use to reach this Hub — needed to build the
// Control Panel URL encoded in the pairing QR code (see src/api/routes/panelQr.js). Auto-detected
// from the PC's network interfaces; override with HUB_LAN_IP if the PC has more than one adapter
// (e.g. Ethernet + WiFi) and auto-detection picks the wrong one.
function detectLanIp() {
  if (process.env.HUB_LAN_IP) return process.env.HUB_LAN_IP;

  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null; // no usable network interface found — the QR endpoint surfaces this as an error
}

module.exports = { detectLanIp };
