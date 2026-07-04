const express = require('express');
const db = require('../../db/db');
const state = require('../../engine/state');
const tripEngine = require('../../engine/tripEngine');
const { requirePin } = require('./auth');

const router = express.Router();

router.get('/state', (req, res) => {
  // Stops are always returned already ordered for the active trip's direction, so Panel/Display
  // frontend code never needs direction-aware logic of its own.
  const stops = state.trip ? tripEngine.getStopsForRoute(state.trip.route_id, state.trip.direction) : [];
  res.json({ ...state.snapshot(), stops });
});

// Primary path (spec 4.2): a deliberate phone tap by either driver or conductor.
router.post('/start', requirePin, (req, res) => {
  const { direction } = req.body || {};
  const trip = tripEngine.startTrip({ via: 'phone', direction: direction === 'return' ? 'return' : 'going' });
  res.json({ ok: true, trip });
});

router.post('/end', requirePin, (req, res) => {
  tripEngine.endTrip();
  res.json({ ok: true });
});

router.post('/jump', requirePin, (req, res) => {
  const { index } = req.body || {};
  if (typeof index !== 'number') return res.status(400).json({ ok: false, error: 'index_required' });
  const clamped = tripEngine.jumpToStop(index);
  res.json({ ok: true, current_stop_index: clamped });
});

router.post('/mute', requirePin, (req, res) => {
  const { muted } = req.body || {};
  state.update({ muted: !!muted });
  res.json({ ok: true, muted: state.muted });
});

// Queued locally, synced when online (Phase 2) — no PIN required, reporting a problem should
// never be harder than the problem itself.
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
