const express = require('express');
const db = require('../../db/db');
const { busId } = require('../../config/deviceConfig');

const router = express.Router();

function todayPin() {
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare('SELECT pin FROM daily_pin WHERE bus_id = ? AND date = ?').get(busId, today);
  return row ? row.pin : null;
}

// Shared per-bus-per-day PIN (spec 7.1) — whoever's assigned to this bus today, driver or
// conductor, uses the same short numeric PIN. Deliberately not per-person: keeps onboarding
// as close to frictionless as pressing a button, per the spec's stated design goal.
router.post('/verify-pin', (req, res) => {
  const { pin } = req.body || {};
  const valid = todayPin();
  if (valid && pin === valid) return res.json({ ok: true });
  return res.status(401).json({ ok: false, error: 'invalid_pin' });
});

// Middleware for state-changing actions (start/end trip, corrections, mute — spec 7.1).
// Viewing status/identity never requires this.
function requirePin(req, res, next) {
  const pin = (req.body && req.body.pin) || req.header('x-pin');
  const valid = todayPin();
  if (!valid || pin !== valid) {
    return res.status(401).json({ ok: false, error: 'invalid_pin' });
  }
  next();
}

module.exports = { router, requirePin };
