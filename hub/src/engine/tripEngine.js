const db = require('../db/db');
const state = require('./state');

// Spec Open Question 2: no tested number yet — 4h is the spec's own starting proposal.
const IDLE_AUTO_CLOSE_MS = Number(process.env.HUB_IDLE_AUTO_CLOSE_MS || 4 * 60 * 60 * 1000);
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;

let lastActivityAt = Date.now();

// One canonical stop order per route (route_stops.sequence_no ascending = "going"). "Return" is
// simply that same list walked in reverse — no separate stop list to keep in sync, matching the
// spec's bias toward simple over clever. Stops themselves are global (shared across routes via
// this join table), so a stop's audio only needs to exist once no matter how many routes use it.
function getStopsForRoute(routeId, direction = 'going') {
  const stops = db
    .prepare(`
      SELECT s.* FROM stops s
      JOIN route_stops rs ON rs.stop_id = s.stop_id
      WHERE rs.route_id = ?
      ORDER BY rs.sequence_no ASC
    `)
    .all(routeId);
  return direction === 'return' ? stops.slice().reverse() : stops;
}

function noteActivity() {
  lastActivityAt = Date.now();
}

// Primary path: a deliberate phone tap (spec 4.2). `via` is 'phone' unless called from the
// button-fallback safety net in playbackEngine, which passes 'button_fallback' (and always
// defaults to 'going' — a driver who forgot the phone step shouldn't be blocked, but the
// direction should be corrected via the phone if it's actually a return trip).
function startTrip({ via = 'phone', direction = 'going' } = {}) {
  if (state.trip) return state.trip; // already running — starting again is a no-op, not an error

  const routeId = state.bus.route_assigned;
  const startTime = new Date().toISOString();
  const result = db
    .prepare(`
      INSERT INTO trips (route_id, start_time, current_stop_index, started_via, direction, auto_closed, synced)
      VALUES (?, ?, 0, ?, ?, 0, 0)
    `)
    .run(routeId, startTime, via, direction);

  noteActivity();
  state.update({
    trip: {
      trip_id: result.lastInsertRowid,
      route_id: routeId,
      start_time: startTime,
      current_stop_index: 0,
      started_via: via,
      direction,
    },
    segmentAnchorAt: Date.now(),
  });
  return state.trip;
}

function endTrip({ autoClosed = false } = {}) {
  if (!state.trip) return null;
  const endTime = new Date().toISOString();
  db.prepare('UPDATE trips SET end_time = ?, auto_closed = ? WHERE trip_id = ?').run(
    endTime,
    autoClosed ? 1 : 0,
    state.trip.trip_id
  );
  noteActivity();
  state.update({ trip: null, nowPlaying: null, segmentAnchorAt: null });
}

// Manual correction (spec 7.1 "Correction / Jump to Stop") — clamped to route bounds.
function jumpToStop(index) {
  if (!state.trip) return null;
  const stops = getStopsForRoute(state.trip.route_id, state.trip.direction);
  const clamped = Math.max(0, Math.min(index, stops.length - 1));
  db.prepare('UPDATE trips SET current_stop_index = ? WHERE trip_id = ?').run(clamped, state.trip.trip_id);
  noteActivity();
  state.update({ trip: { ...state.trip, current_stop_index: clamped } });
  return clamped;
}

// Safety net only (spec 4.2/4.5) — not the primary mechanism. A trip left with zero signals,
// button or phone, for the idle threshold auto-closes so a forgotten "End Trip" tap doesn't
// corrupt the next day's data.
function startIdleAutoCloseChecker() {
  setInterval(() => {
    if (!state.trip) return;
    if (Date.now() - lastActivityAt > IDLE_AUTO_CLOSE_MS) {
      console.warn(`[tripEngine] idle auto-close after ${IDLE_AUTO_CLOSE_MS}ms of silence`);
      endTrip({ autoClosed: true });
    }
  }, IDLE_CHECK_INTERVAL_MS);
}

module.exports = {
  getStopsForRoute,
  noteActivity,
  startTrip,
  endTrip,
  jumpToStop,
  startIdleAutoCloseChecker,
  IDLE_AUTO_CLOSE_MS,
};
