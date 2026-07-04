const WebSocket = require('ws');
const db = require('../db/db');

// Live bus_id -> socket map, so an admin action (assign route, edit a stop, upload content)
// can push an updated `sync_state` to a connected bus immediately (the "real-time while the
// bus PC is live" requirement), while a disconnected bus just catches up on its next `hello`.
const liveSockets = new Map();

function buildSyncState(busId) {
  const bus = db.prepare('SELECT * FROM buses WHERE bus_id = ?').get(busId);
  if (!bus) return null;

  let route = null;
  let stops = [];
  let contentItems = [];

  if (bus.route_id) {
    route = db.prepare('SELECT * FROM routes WHERE route_id = ?').get(bus.route_id);
    // Stops are global — joined in via route_stops so a stop shared across routes only needs
    // downloading/storing once on the Hub, no matter how many routes reference it.
    stops = db
      .prepare(`
        SELECT s.*, rs.sequence_no AS sequence_no
        FROM stops s JOIN route_stops rs ON rs.stop_id = s.stop_id
        WHERE rs.route_id = ?
        ORDER BY rs.sequence_no ASC
      `)
      .all(bus.route_id);
    const stopIds = stops.map((s) => s.stop_id);
    const stopPlaceholders = stopIds.length ? stopIds.map(() => '?').join(',') : "''";
    contentItems = db
      .prepare(`SELECT * FROM content_items WHERE route_id = ? OR route_id IS NULL OR stop_id IN (${stopPlaceholders})`)
      .all(bus.route_id, ...stopIds);
  } else {
    // No route assigned yet — global content (chime/filler/outro) still ships so a bus can
    // play *something* sensible the moment a route does get assigned.
    contentItems = db.prepare('SELECT * FROM content_items WHERE route_id IS NULL').all();
  }

  return {
    type: 'sync_state',
    payload: {
      bus: { bus_id: bus.bus_id, reg_number: bus.reg_number, tier: bus.tier },
      route: route ? { route_id: route.route_id, name: route.name, name_ml: route.name_ml, tier: route.tier } : null,
      stops,
      content_items: contentItems,
    },
  };
}

function pushSyncStateToBus(busId) {
  const socket = liveSockets.get(busId);
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  const state = buildSyncState(busId);
  if (!state) return false;
  socket.send(JSON.stringify(state));
  return true;
}

function pushSyncStateToBuses(busIds) {
  for (const id of busIds) pushSyncStateToBus(id);
}

// Any bus with no route (route_id IS NULL) or the given route assigned — used when global
// content (route_id NULL) or a specific route's content/stops change.
function busIdsAffectedByRoute(routeId) {
  const rows = routeId
    ? db.prepare('SELECT bus_id FROM buses WHERE route_id = ?').all(routeId)
    : db.prepare('SELECT bus_id FROM buses').all(); // route_id NULL content is global — ship to everyone
  return rows.map((r) => r.bus_id);
}

// Every bus currently on a route that includes this stop — used when a global stop edit
// (rename, ads toggle) needs to reach every affected bus, regardless of how many routes
// share that stop.
function busIdsAffectedByStop(stopId) {
  const rows = db
    .prepare(`
      SELECT DISTINCT b.bus_id FROM buses b
      JOIN route_stops rs ON rs.route_id = b.route_id
      WHERE rs.stop_id = ?
    `)
    .all(stopId);
  return rows.map((r) => r.bus_id);
}

function markBusReport(busId, liveStatus) {
  db.prepare(`
    UPDATE buses SET last_seen_at = datetime('now'), esp32_connected = ?, trip_active = ?,
      current_stop_index = ?, current_direction = ?
    WHERE bus_id = ?
  `).run(
    liveStatus.esp32Connected ? 1 : 0,
    liveStatus.tripActive ? 1 : 0,
    liveStatus.currentStopIndex ?? null,
    liveStatus.direction ?? null,
    busId
  );
}

function storeReportedTrips(busId, trips) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO trips
      (bus_id, hub_trip_id, route_id, start_time, end_time, current_stop_index, started_via, direction, auto_closed, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const tx = db.transaction((rows) => {
    for (const t of rows) {
      stmt.run(busId, t.trip_id, t.route_id, t.start_time, t.end_time, t.current_stop_index, t.started_via, t.direction, t.auto_closed ? 1 : 0);
    }
  });
  tx(trips);
}

function storeReportedPlayLogs(busId, logs) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO play_logs
      (bus_id, hub_log_id, trip_id, content_id, campaign_id, stop_id, played_at, duration_played_sec, billable, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const tx = db.transaction((rows) => {
    for (const l of rows) {
      stmt.run(busId, l.log_id, l.trip_id, l.content_id, l.campaign_id, l.stop_id, l.played_at, l.duration_played_sec, l.billable ? 1 : 0);
    }
  });
  tx(logs);
}

function attach(server) {
  const wss = new WebSocket.Server({ server, path: '/hub-sync' });

  wss.on('connection', (socket) => {
    let authedBusId = null;

    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        return;
      }

      if (msg.type === 'hello') {
        const bus = db.prepare('SELECT * FROM buses WHERE bus_id = ?').get(msg.bus_id);
        if (!bus || bus.api_key !== msg.api_key) {
          socket.send(JSON.stringify({ type: 'error', message: 'invalid_bus_or_key' }));
          socket.close();
          return;
        }
        authedBusId = bus.bus_id;
        liveSockets.set(authedBusId, socket);
        db.prepare("UPDATE buses SET last_seen_at = datetime('now') WHERE bus_id = ?").run(authedBusId);
        const state = buildSyncState(authedBusId);
        if (state) socket.send(JSON.stringify(state));
        return;
      }

      if (!authedBusId) return; // ignore anything before a valid hello

      if (msg.type === 'report') {
        const { liveStatus, trips, playLogs } = msg.payload || {};
        if (liveStatus) markBusReport(authedBusId, liveStatus);
        if (Array.isArray(trips) && trips.length) storeReportedTrips(authedBusId, trips);
        if (Array.isArray(playLogs) && playLogs.length) storeReportedPlayLogs(authedBusId, playLogs);
        socket.send(JSON.stringify({ type: 'report_ack' }));
      }
    });

    socket.on('close', () => {
      // Don't zero out esp32_connected here — that reflects the Hub's own hardware status as
      // of its last report, a separate signal from "is this bus's Hub reachable to the cloud
      // right now" (which the Admin UI derives from last_seen_at recency instead).
      if (authedBusId && liveSockets.get(authedBusId) === socket) {
        liveSockets.delete(authedBusId);
      }
    });
  });

  return wss;
}

module.exports = { attach, pushSyncStateToBus, pushSyncStateToBuses, busIdsAffectedByRoute, busIdsAffectedByStop };
