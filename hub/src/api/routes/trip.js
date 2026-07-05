const express = require('express');
const db = require('../../db/db');
const state = require('../../engine/state');
const tripEngine = require('../../engine/tripEngine');
const playbackEngine = require('../../engine/playbackEngine');
const { getBusId, getDeviceConfig, getRouteName } = require('../../config/deviceConfig');
const { requireDevice } = require('./auth');

const router = express.Router();

router.get('/state', (req, res) => {
  // Stops are always returned already ordered for the active trip's direction, so Panel/Display
  // frontend code never needs direction-aware logic of its own.
  const stops = state.trip ? tripEngine.getStopsForRoute(state.trip.route_id, state.trip.direction) : [];
  res.json({ ...state.snapshot(), stops });
});

// The routes this bus is currently assigned (synced down from the cloud) — what the phone's
// route picker offers. Switching which one is active never needs the cloud: everything here is
// already downloaded, so this works fully offline.
router.get('/routes', (req, res) => {
  const routes = db
    .prepare(`
      SELECT route_id, name, name_ml FROM routes
      WHERE route_id IN (SELECT route_id FROM assigned_routes)
      ORDER BY name
    `)
    .all();
  res.json({ routes, active_route_id: state.bus.route_assigned });
});

router.post('/select-route', requireDevice, (req, res) => {
  if (state.trip) {
    return res.status(409).json({ ok: false, error: 'trip_active', message: 'End the current trip before switching routes.' });
  }
  const { route_id } = req.body || {};
  const assigned = db.prepare('SELECT 1 FROM assigned_routes WHERE route_id = ?').get(route_id);
  if (!assigned) return res.status(404).json({ ok: false, error: 'route_not_assigned' });

  db.prepare('UPDATE device_config SET route_assigned = ? WHERE bus_id = ?').run(route_id, getBusId());
  const cfg = getDeviceConfig();
  state.update({
    bus: { ...state.bus, route_assigned: cfg.route_assigned, route_name: getRouteName(cfg.route_assigned) },
  });
  res.json({ ok: true, route_id });
});

// Primary path (spec 4.2): a deliberate phone tap by either driver or conductor.
router.post('/start', requireDevice, (req, res) => {
  const { direction } = req.body || {};
  const trip = tripEngine.startTrip({ via: 'phone', direction: direction === 'return' ? 'return' : 'going' });
  res.json({ ok: true, trip });
});

router.post('/end', requireDevice, (req, res) => {
  tripEngine.endTrip();
  res.json({ ok: true });
});

router.post('/jump', requireDevice, (req, res) => {
  const { index } = req.body || {};
  if (typeof index !== 'number') return res.status(400).json({ ok: false, error: 'index_required' });
  const clamped = tripEngine.jumpToStop(index);
  res.json({ ok: true, current_stop_index: clamped });
});

// Phone-side equivalents of the ESP32/Uno push switches — same engine functions, same
// composed-announcement-plays-on-the-Display-View behavior either way. Forward advances one
// stop and plays that stop's announcement once; Announcement replays the *current* stop's
// announcement without moving; Undo steps back one stop and cancels whatever just started
// playing from the last Forward (e.g. an accidental double-press).
router.post('/forward', requireDevice, (req, res) => {
  playbackEngine.handleForward();
  res.json({ ok: true, current_stop_index: state.trip ? state.trip.current_stop_index : null });
});

router.post('/undo', requireDevice, (req, res) => {
  playbackEngine.handleUndo();
  res.json({ ok: true, current_stop_index: state.trip ? state.trip.current_stop_index : null });
});

router.post('/announce', requireDevice, (req, res) => {
  playbackEngine.handleReplay();
  res.json({ ok: true });
});

router.post('/mute', requireDevice, (req, res) => {
  const { muted } = req.body || {};
  state.update({ muted: !!muted });
  res.json({ ok: true, muted: state.muted });
});

// Queued locally, synced when online (Phase 2) — no device pairing required, reporting a
// problem should never be harder than the problem itself.
router.post('/issue', (req, res) => {
  const { description } = req.body || {};
  if (!description || !description.trim()) return res.status(400).json({ ok: false, error: 'description_required' });
  db.prepare(`
    INSERT INTO issues (trip_id, description, reported_at, synced)
    VALUES (?, ?, datetime('now'), 0)
  `).run(state.trip ? state.trip.trip_id : null, description.trim());
  res.json({ ok: true });
});

module.exports = router;
