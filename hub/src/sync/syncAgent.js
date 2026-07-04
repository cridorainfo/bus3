const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const db = require('../db/db');
const state = require('../engine/state');
const { getBusId, getApiKey, isPaired, getDeviceConfig, getRouteName } = require('../config/deviceConfig');
const { CLOUD_WS_URL, CLOUD_HTTP_BASE } = require('../config/cloudConfig');
const { ASSETS_DIR } = require('../config/paths');

// Cloud-lite sync (Phase 2 sample, spec Section 8 scaled down): the Hub stays fully offline-first
// regardless of whether any of this succeeds. Every failure here is caught and retried — never
// surfaced to the driver, matching the spec's "zero driver-facing failure surface" requirement.

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const REPORT_INTERVAL_MS = 15000;
const PAIRING_CHECK_INTERVAL_MS = 5000;

let ws = null;
let reconnectDelay = RECONNECT_BASE_MS;
let pendingTripIds = [];
let pendingLogIds = [];
let lastTripActive = false;
let pendingUnpair = false; // admin disconnected this bus while a trip was active — see handleUnpaired below

function start() {
  if (isPaired()) {
    connect();
  } else {
    console.log('[syncAgent] not paired yet — see the Display View for this bus\'s pairing ID');
  }
  // Pairing can complete later (via pairingAgent.js's device-code flow) without a restart —
  // check periodically and start connecting the moment it does. Also guards against a second,
  // independent reconnect path from the one in ws.on('close') below: this fires on its own
  // schedule regardless of *why* ws is currently null, so it needs the same pendingUnpair check
  // — otherwise it'll happily reconnect with credentials the cloud already invalidated while
  // waiting for an active trip to end.
  setInterval(() => {
    if (!ws && isPaired() && !pendingUnpair) connect();
  }, PAIRING_CHECK_INTERVAL_MS);

  setInterval(reportUp, REPORT_INTERVAL_MS);

  // Report promptly when a trip ends, rather than waiting out the full interval — cheap to
  // do via the existing state EventEmitter, no new coupling between tripEngine and sync.
  state.on('change', (snapshot) => {
    const tripActiveNow = !!snapshot.trip;
    if (lastTripActive && !tripActiveNow) {
      reportUp();
      if (pendingUnpair) {
        pendingUnpair = false;
        performUnpair();
      }
    }
    lastTripActive = tripActiveNow;
  });
}

// Exported so pairing.js can kick off the very first connection immediately after a successful
// pair, instead of waiting for the next periodic check.
function connectIfPaired() {
  if (!ws && isPaired()) connect();
}

function connect() {
  // Reentrancy guard: two independent triggers can both decide it's time to reconnect (this
  // function's own close-handler backoff, and start()'s separate periodic isPaired() check) —
  // without this, both could fire close enough together to end up with two live sockets both
  // assigned to the shared `ws` variable, corrupting whichever one loses the race (surfaced as
  // "WebSocket is not open: readyState 0 (CONNECTING)" crashes when a stale handler's closure
  // sends on a socket it no longer actually owns).
  if (ws) return;
  // A retry can already be scheduled (exponential backoff) from before this Hub reset to
  // unpaired — e.g. several reconnect attempts queued up while genuinely offline, and by the
  // time one of them fires we've since found out (via an earlier attempt) that our credentials
  // are dead. Nothing valid to send at that point; let it quietly no-op instead of connecting
  // with a null bus_id just to get rejected again.
  if (!isPaired()) return;

  const socket = new WebSocket(CLOUD_WS_URL);
  ws = socket;

  socket.on('open', () => {
    reconnectDelay = RECONNECT_BASE_MS;
    socket.send(JSON.stringify({ type: 'hello', bus_id: getBusId(), api_key: getApiKey() }));
    console.log(`[syncAgent] connected to cloud at ${CLOUD_WS_URL}`);
  });

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (msg.type === 'sync_state') {
      applySyncState(msg.payload).catch((err) => console.warn('[syncAgent] failed to apply sync_state:', err.message));
    } else if (msg.type === 'report_ack') {
      markSynced();
    } else if (msg.type === 'unpaired') {
      handleUnpaired();
    } else if (msg.type === 'error') {
      // The only error the cloud ever sends here is invalid_bus_or_key — this bus's credentials
      // are no longer valid, whether because it was unpaired/deleted while this Hub happened to
      // be offline (never got the explicit 'unpaired' push above), or the cloud's own database
      // was reset out from under it. Same recovery either way: reset to unpaired so it shows a
      // fresh pairing ID, rather than looping forever retrying with dead credentials while still
      // looking paired locally.
      console.warn('[syncAgent] cloud rejected connection:', msg.message);
      handleUnpaired();
    }
  });

  socket.on('close', () => {
    if (ws !== socket) return; // a newer socket has already superseded this stale one — nothing to do
    ws = null;
    // Nothing valid to reconnect with once unpaired — or about to be, the moment the trip
    // that's holding it off ends (see handleUnpaired) — so don't spam retries with credentials
    // the cloud has already invalidated. pairingAgent will register a fresh identity and the
    // periodic check in start() reconnects once that completes.
    if (!isPaired() || pendingUnpair) return;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  });
  socket.on('error', () => {}); // 'close' always follows; avoid double-logging the same failure
}

// Admin-triggered from the cloud (Disconnect from Server / delete bus) — this Hub's identity is
// being severed. Never disrupts a trip already in progress: if one's active, this just remembers
// to reset once it ends (mirrors updateAgent.js's "apply only when idle" posture) rather than
// pulling device_config out from under the transport layer mid-trip.
function handleUnpaired() {
  if (state.trip) {
    console.log('[syncAgent] admin disconnected this bus — will reset to unpaired once the current trip ends');
    pendingUnpair = true;
    return;
  }
  performUnpair();
}

function performUnpair() {
  if (!isPaired()) return; // already reset — avoids redundantly restarting pairingAgent if this fires more than once
  console.log('[syncAgent] resetting to unpaired (admin disconnected this bus from the server)');
  db.prepare('DELETE FROM device_config').run();
  db.prepare('DELETE FROM paired_devices').run(); // every connected phone loses access too
  db.prepare('DELETE FROM assigned_routes').run(); // no longer this (now different) bus's routes
  state.refreshConnectedDeviceCount();

  if (ws) ws.close();

  state.update({
    bus: { bus_id: null, reg_number: 'Not paired', friendly_name: null, route_assigned: null, route_name: null },
  });

  // Lazy require — pairingAgent.js requires this module at its own top level (to call
  // connectIfPaired() after a successful claim), so requiring it back at this module's top
  // level would create a circular require that resolves to an incomplete export. Requiring it
  // here, inside a function body, is safe because by the time this actually runs both modules
  // have already fully finished loading via server.js's initial require chain.
  require('./pairingAgent').start();
}

// --- Pull: cloud -> hub ---

const upsertStop = db.prepare(`
  INSERT INTO stops (stop_id, route_id, name_ml, name_en, sequence_no, ads_enabled, announcement_template)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(stop_id) DO UPDATE SET name_ml = excluded.name_ml, name_en = excluded.name_en,
    ads_enabled = excluded.ads_enabled, announcement_template = excluded.announcement_template
`);
const upsertRouteStop = db.prepare(`
  INSERT INTO route_stops (route_id, stop_id, sequence_no) VALUES (?, ?, ?)
  ON CONFLICT(route_id, stop_id) DO UPDATE SET sequence_no = excluded.sequence_no
`);
const deleteRouteStop = db.prepare('DELETE FROM route_stops WHERE route_id = ? AND stop_id = ?');

// A bus can be assigned more than one route (spec ask); the driver/conductor picks which one is
// active locally (see select-route in api/routes/trip.js) — this just makes sure every assigned
// route's stops/content are downloaded and ready, whichever one gets picked.
async function applySyncState(payload) {
  const { bus, routes, content_items: contentItems } = payload;
  const incomingRouteIds = new Set((routes || []).map((r) => r.route_id));

  for (const route of routes || []) {
    db.prepare(`
      INSERT INTO routes (route_id, name, name_ml, tier) VALUES (?, ?, ?, ?)
      ON CONFLICT(route_id) DO UPDATE SET name = excluded.name, name_ml = excluded.name_ml, tier = excluded.tier
    `).run(route.route_id, route.name, route.name_ml, route.tier);

    // Stops are global (upserted by stop_id, never deleted here — other routes may still use
    // them); route_stops is what actually defines this route's membership/order, and is fully
    // reconciled to match the incoming list (rows for stops no longer on this route are unlinked).
    const incomingStopIds = new Set(route.stops.map((s) => s.stop_id));
    const localLinkedStopIds = db.prepare('SELECT stop_id FROM route_stops WHERE route_id = ?').all(route.route_id).map((r) => r.stop_id);

    db.transaction(() => {
      for (const s of route.stops) {
        upsertStop.run(s.stop_id, route.route_id, s.name_ml, s.name_en, s.sequence_no, s.ads_enabled ? 1 : 0, s.announcement_template);
        upsertRouteStop.run(route.route_id, s.stop_id, s.sequence_no);
      }
      for (const stopId of localLinkedStopIds) {
        if (!incomingStopIds.has(stopId)) deleteRouteStop.run(route.route_id, stopId);
      }
    })();
  }

  // Reconcile the local assigned_routes mirror to exactly match the incoming assignment set.
  const localAssignedIds = db.prepare('SELECT route_id FROM assigned_routes').all().map((r) => r.route_id);
  const insertAssigned = db.prepare('INSERT OR IGNORE INTO assigned_routes (route_id) VALUES (?)');
  const deleteAssigned = db.prepare('DELETE FROM assigned_routes WHERE route_id = ?');
  db.transaction(() => {
    for (const routeId of incomingRouteIds) insertAssigned.run(routeId);
    for (const routeId of localAssignedIds) {
      if (!incomingRouteIds.has(routeId)) deleteAssigned.run(routeId);
    }
  })();

  const busId = getBusId();

  // If the currently-active route was unassigned and nothing's running, clear it so the driver
  // picks again from what's left — but never disrupt a trip already in progress.
  const cfgBefore = getDeviceConfig();
  if (cfgBefore.route_assigned && !incomingRouteIds.has(cfgBefore.route_assigned) && !state.trip) {
    db.prepare('UPDATE device_config SET route_assigned = NULL WHERE bus_id = ?').run(busId);
  }

  if (bus) {
    db.prepare('UPDATE device_config SET reg_number = ?, friendly_name = ?, connect_code = ? WHERE bus_id = ?').run(
      bus.reg_number,
      bus.friendly_name || null,
      bus.connect_code || null,
      busId
    );

    // Admin's "Disconnect all devices" (spec: takes effect once the bus is next online) — bump
    // is compared against what we last applied, so a repeated sync doesn't keep re-clearing.
    if (bus.devices_disconnect_at && bus.devices_disconnect_at !== cfgBefore.devices_disconnect_last_applied) {
      db.prepare('DELETE FROM paired_devices').run();
      db.prepare('UPDATE device_config SET devices_disconnect_last_applied = ? WHERE bus_id = ?').run(bus.devices_disconnect_at, busId);
      state.refreshConnectedDeviceCount();
      console.log('[syncAgent] admin disconnected all paired phones for this bus');
    }
  }

  for (const item of contentItems || []) {
    await ensureContentDownloaded(item);
  }

  db.prepare("UPDATE device_config SET last_sync_at = datetime('now') WHERE bus_id = ?").run(busId);

  const cfg = getDeviceConfig();
  state.update({
    bus: {
      bus_id: cfg.bus_id,
      reg_number: cfg.reg_number,
      friendly_name: cfg.friendly_name,
      route_assigned: cfg.route_assigned,
      route_name: getRouteName(cfg.route_assigned),
    },
    contentVersion: Date.now(), // Panel/Display refetch stops/content on this change (not just route_id)
  });
}

const AUDIO_TYPES = new Set(['chime', 'filler', 'stop_name', 'stop_name_ad', 'sponsor_snippet', 'outro', 'music']);

async function ensureContentDownloaded(item) {
  const isAudio = AUDIO_TYPES.has(item.type);
  const dir = path.join(ASSETS_DIR, isAudio ? 'audio' : 'media');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const filename = path.basename(item.file_path);
  const localPath = path.join(dir, filename);
  const localUrlPath = `/${isAudio ? 'audio' : 'media'}/${filename}`;

  if (!fs.existsSync(localPath)) {
    try {
      const url = `${CLOUD_HTTP_BASE}/content/${item.file_path}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(localPath, buf);
    } catch (err) {
      console.warn(`[syncAgent] could not download content ${item.content_id}: ${err.message}`);
      return; // don't point a DB row at a file that doesn't actually exist locally
    }
  }

  db.prepare(`
    INSERT INTO content_items (content_id, type, file_path, duration_sec, tier, advertiser_id, campaign_id, route_id, stop_id)
    VALUES (@content_id, @type, @file_path, @duration_sec, @tier, @advertiser_id, @campaign_id, @route_id, @stop_id)
    ON CONFLICT(content_id) DO UPDATE SET type = excluded.type, file_path = excluded.file_path,
      duration_sec = excluded.duration_sec, tier = excluded.tier, advertiser_id = excluded.advertiser_id,
      campaign_id = excluded.campaign_id, route_id = excluded.route_id, stop_id = excluded.stop_id
  `).run({
    content_id: item.content_id,
    type: item.type,
    file_path: localUrlPath,
    duration_sec: item.duration_sec ?? null,
    tier: item.tier ?? null,
    advertiser_id: item.advertiser_id ?? null,
    campaign_id: item.campaign_id ?? null,
    route_id: item.route_id ?? null,
    stop_id: item.stop_id ?? null,
  });
}

// --- Push: hub -> cloud ---

function reportUp() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const liveStatus = {
    esp32Connected: !!(state.esp32 && state.esp32.connected),
    tripActive: !!state.trip,
    currentStopIndex: state.trip ? state.trip.current_stop_index : null,
    direction: state.trip ? state.trip.direction : null,
  };

  // Trips are only reported once ended — a trip is a complete, billing-safe record at that
  // point (matches "never lose progress" without needing to re-sync an in-progress row
  // repeatedly). play_logs are already complete/immutable the moment they're written.
  const trips = db.prepare('SELECT * FROM trips WHERE synced = 0 AND end_time IS NOT NULL').all();
  const playLogs = db.prepare('SELECT * FROM play_logs WHERE synced = 0').all();

  if (trips.length === 0 && playLogs.length === 0 && pendingTripIds.length === 0 && pendingLogIds.length === 0) {
    ws.send(JSON.stringify({ type: 'report', payload: { liveStatus, trips: [], playLogs: [] } }));
    return;
  }

  pendingTripIds = trips.map((t) => t.trip_id);
  pendingLogIds = playLogs.map((l) => l.log_id);

  ws.send(JSON.stringify({
    type: 'report',
    payload: {
      liveStatus,
      trips: trips.map((t) => ({
        trip_id: t.trip_id, route_id: t.route_id, start_time: t.start_time, end_time: t.end_time,
        current_stop_index: t.current_stop_index, started_via: t.started_via, direction: t.direction, auto_closed: t.auto_closed,
      })),
      playLogs: playLogs.map((l) => ({
        log_id: l.log_id, trip_id: l.trip_id, content_id: l.content_id, campaign_id: l.campaign_id,
        stop_id: l.stop_id, played_at: l.played_at, duration_played_sec: l.duration_played_sec, billable: l.billable,
      })),
    },
  }));
}

function markSynced() {
  if (pendingTripIds.length) {
    const stmt = db.prepare('UPDATE trips SET synced = 1 WHERE trip_id = ?');
    db.transaction(() => pendingTripIds.forEach((id) => stmt.run(id)))();
    pendingTripIds = [];
  }
  if (pendingLogIds.length) {
    const stmt = db.prepare('UPDATE play_logs SET synced = 1 WHERE log_id = ?');
    db.transaction(() => pendingLogIds.forEach((id) => stmt.run(id)))();
    pendingLogIds = [];
  }
}

module.exports = { start, connectIfPaired };
