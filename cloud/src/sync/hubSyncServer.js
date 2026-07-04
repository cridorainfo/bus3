const WebSocket = require('ws');
const db = require('../db/db');

// Live bus_id -> socket map, so an admin action (assign route, edit a stop, upload content)
// can push an updated `sync_state` to a connected bus immediately (the "real-time while the
// bus PC is live" requirement), while a disconnected bus just catches up on its next `hello`.
const liveSockets = new Map();

// A bus can now be assigned more than one route (spec ask: pick the active one locally on the
// phone) — this ships every assigned route's stops/content in one sync_state, deduplicated, so
// the Hub has everything it needs to let the driver/conductor switch without a cloud round-trip.
function buildSyncState(busId) {
  const bus = db.prepare('SELECT * FROM buses WHERE bus_id = ?').get(busId);
  if (!bus) return null;

  const assignedRouteIds = db.prepare('SELECT route_id FROM bus_routes WHERE bus_id = ?').all(busId).map((r) => r.route_id);

  const contentMap = new Map();
  // Truly global content (chime/filler/outro) ships regardless of route assignment, so a bus
  // can play something sensible the moment a route is assigned.
  for (const item of db.prepare('SELECT * FROM content_items WHERE route_id IS NULL AND stop_id IS NULL').all()) {
    contentMap.set(item.content_id, item);
  }

  const routes = [];
  for (const routeId of assignedRouteIds) {
    const route = db.prepare('SELECT * FROM routes WHERE route_id = ?').get(routeId);
    if (!route) continue;

    const stops = db
      .prepare(`
        SELECT s.*, rs.sequence_no AS sequence_no
        FROM stops s JOIN route_stops rs ON rs.stop_id = s.stop_id
        WHERE rs.route_id = ?
        ORDER BY rs.sequence_no ASC
      `)
      .all(routeId);
    routes.push({ route_id: route.route_id, name: route.name, name_ml: route.name_ml, tier: route.tier, stops });

    for (const item of db.prepare('SELECT * FROM content_items WHERE route_id = ?').all(routeId)) {
      contentMap.set(item.content_id, item);
    }
    for (const stop of stops) {
      for (const item of db.prepare('SELECT * FROM content_items WHERE stop_id = ?').all(stop.stop_id)) {
        contentMap.set(item.content_id, item);
      }
    }
  }

  return {
    type: 'sync_state',
    payload: {
      bus: {
        bus_id: bus.bus_id,
        reg_number: bus.reg_number,
        friendly_name: bus.friendly_name,
        tier: bus.tier,
        connect_code: bus.connect_code,
        devices_disconnect_at: bus.devices_disconnect_at,
      },
      routes,
      content_items: Array.from(contentMap.values()),
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

// Admin-triggered "Disconnect from Server" / delete-bus — tells a currently-connected Hub to
// reset to unpaired *right now* (it shows a fresh pairing ID the moment it's safe to, i.e. once
// any trip in progress ends — see hub/src/sync/syncAgent.js's handleUnpaired) instead of it
// hanging onto invalidated credentials until its next reconnect attempt happens to fail.
function disconnectBus(busId) {
  const socket = liveSockets.get(busId);
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'unpaired' }));
    socket.close();
  }
  liveSockets.delete(busId);
}

// Every bus with this route in its assignment set (bus_routes) — or every bus at all, when the
// content in question is truly global (route_id NULL).
function busIdsAffectedByRoute(routeId) {
  const rows = routeId
    ? db.prepare('SELECT DISTINCT bus_id FROM bus_routes WHERE route_id = ?').all(routeId)
    : db.prepare('SELECT bus_id FROM buses').all();
  return rows.map((r) => r.bus_id);
}

// Every bus assigned to any route that includes this stop — used when a global stop edit
// (rename, ads toggle) needs to reach every affected bus, regardless of how many routes/buses
// share that stop.
function busIdsAffectedByStop(stopId) {
  const rows = db
    .prepare(`
      SELECT DISTINCT br.bus_id FROM bus_routes br
      JOIN route_stops rs ON rs.route_id = br.route_id
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

module.exports = { attach, pushSyncStateToBus, pushSyncStateToBuses, busIdsAffectedByRoute, busIdsAffectedByStop, disconnectBus };
