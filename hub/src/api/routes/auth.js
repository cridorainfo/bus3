const express = require('express');
const crypto = require('crypto');
const db = require('../../db/db');
const state = require('../../engine/state');
const { getDeviceConfig } = require('../../config/deviceConfig');

const router = express.Router();

function currentConnectCode() {
  const cfg = getDeviceConfig();
  return cfg ? cfg.connect_code : null;
}

// One-time connect, not per-action: a phone enters the bus's connect code once (set/rotated by
// admin via the cloud), gets a device_token, and stays paired — kept in the browser's
// localStorage, not sessionStorage — until it disconnects (switching to a different bus) or an
// admin disconnects every device on this bus (see syncAgent's devices_disconnect_at handling).
router.post('/connect', (req, res) => {
  const { code } = req.body || {};
  const valid = currentConnectCode();
  if (!valid || code !== valid) {
    return res.status(401).json({ ok: false, error: 'invalid_code' });
  }

  const deviceToken = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO paired_devices (device_token, paired_at, last_seen_at) VALUES (?, datetime(\'now\'), datetime(\'now\'))').run(deviceToken);
  state.refreshConnectedDeviceCount(); // Display View switches off the QR-to-connect screen once someone's here

  res.json({ ok: true, device_token: deviceToken });
});

// Self-service — used when a driver/conductor is switching to a different bus.
router.post('/disconnect', (req, res) => {
  const token = req.header('x-device-token') || (req.body && req.body.device_token);
  if (token) db.prepare('DELETE FROM paired_devices WHERE device_token = ?').run(token);
  state.refreshConnectedDeviceCount();
  res.json({ ok: true });
});

// Gates every state-changing trip action (start/end, direction, corrections, route switch).
// Viewing status/identity never requires this.
function requireDevice(req, res, next) {
  const token = req.header('x-device-token') || (req.body && req.body.device_token);
  if (!token) return res.status(401).json({ ok: false, error: 'not_connected' });

  const device = db.prepare('SELECT * FROM paired_devices WHERE device_token = ?').get(token);
  if (!device) return res.status(401).json({ ok: false, error: 'not_connected' });

  db.prepare("UPDATE paired_devices SET last_seen_at = datetime('now') WHERE device_token = ?").run(token);
  next();
}

module.exports = { router, requireDevice };
