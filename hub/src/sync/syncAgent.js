const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const db = require('../db/db');
const state = require('../engine/state');
const { busId, getDeviceConfig, getRouteName } = require('../config/deviceConfig');

// Cloud-lite sync (Phase 2 sample, spec Section 8 scaled down): the Hub stays fully offline-first
// regardless of whether any of this succeeds. Every failure here is caught and retried — never
// surfaced to the driver, matching the spec's "zero driver-facing failure surface" requirement.
const CLOUD_WS_URL = process.env.HUB_CLOUD_URL || 'ws://localhost:4000/hub-sync';
const CLOUD_HTTP_BASE = process.env.HUB_CLOUD_HTTP || CLOUD_WS_URL.replace(/^ws/, 'http').replace(/\/hub-sync\/?$/, '');
const API_KEY = process.env.HUB_CLOUD_API_KEY || 'dev-demo-key';

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const REPORT_INTERVAL_MS = 15000;

let ws = null;
let reconnectDelay = RECONNECT_BASE_MS;
let pendingTripIds = [];
let pendingLogIds = [];
let lastTripActive = false;

function start() {
  connect();
  setInterval(reportUp, REPORT_INTERVAL_MS);

  // Report promptly when a trip ends, rather than waiting out the full interval — cheap to
  // do via the existing state EventEmitter, no new coupling between tripEngine and sync.
  state.on('change', (snapshot) => {
    const tripActiveNow = !!snapshot.trip;
    if (lastTripActive && !tripActiveNow) reportUp();
    lastTripActive = tripActiveNow;
  });
}

function connect() {
  ws = new WebSocket(CLOUD_WS_URL);

  ws.on('open', () => {
    reconnectDelay = RECONNECT_BASE_MS;
    ws.send(JSON.stringify({ type: 'hello', bus_id: busId, api_key: API_KEY }));
    console.log(`[syncAgent] connected to cloud at ${CLOUD_WS_URL}`);
  });

  ws.on('message', (raw) => {
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
    } else if (msg.type === 'error') {
      console.warn('[syncAgent] cloud rejected connection:', msg.message);
    }
  });

  ws.on('close', () => {
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  });
  ws.on('error', () => {}); // 'close' always follows; avoid double-logging the same failure
}

// --- Pull: cloud -> hub ---

async function applySyncState(payload) {
  const { route, stops, content_items: contentItems } = payload;

  if (route) {
    db.prepare(`
      INSERT INTO routes (route_id, name, name_ml, tier) VALUES (?, ?, ?, ?)
      ON CONFLICT(route_id) DO UPDATE SET name = excluded.name, name_ml = excluded.name_ml, tier = excluded.tier
    `).run(route.route_id, route.name, route.name_ml, route.tier);

    // Stops are global (upserted by stop_id, never deleted here — other routes may still use
    // them); route_stops is what actually defines this route's membership/order, and is fully
    // reconciled to match the incoming list (rows for stops no longer on this route are unlinked).
    const incomingIds = new Set(stops.map((s) => s.stop_id));
    const localLinkedStopIds = db.prepare('SELECT stop_id FROM route_stops WHERE route_id = ?').all(route.route_id).map((r) => r.stop_id);

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

    db.transaction(() => {
      for (const s of stops) {
        upsertStop.run(s.stop_id, route.route_id, s.name_ml, s.name_en, s.sequence_no, s.ads_enabled ? 1 : 0, s.announcement_template);
        upsertRouteStop.run(route.route_id, s.stop_id, s.sequence_no);
      }
      for (const stopId of localLinkedStopIds) {
        if (!incomingIds.has(stopId)) deleteRouteStop.run(route.route_id, stopId);
      }
    })();

    db.prepare('UPDATE device_config SET route_assigned = ? WHERE bus_id = ?').run(route.route_id, busId);
  }
  // route === null means the cloud has nothing assigned yet (e.g. before the admin has acted) —
  // leave whatever route the Hub already knows about untouched rather than wiping it out.

  for (const item of contentItems || []) {
    await ensureContentDownloaded(item);
  }

  db.prepare("UPDATE device_config SET last_sync_at = datetime('now') WHERE bus_id = ?").run(busId);

  const cfg = getDeviceConfig();
  state.update({
    bus: { bus_id: cfg.bus_id, reg_number: cfg.reg_number, route_assigned: cfg.route_assigned, route_name: getRouteName(cfg.route_assigned) },
    contentVersion: Date.now(), // Panel/Display refetch stops/content on this change (not just route_id)
  });
}

const AUDIO_TYPES = new Set(['chime', 'filler', 'stop_name', 'stop_name_ad', 'sponsor_snippet', 'outro', 'music']);

async function ensureContentDownloaded(item) {
  const isAudio = AUDIO_TYPES.has(item.type);
  const dir = path.join(__dirname, '..', '..', 'assets', isAudio ? 'audio' : 'media');
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

module.exports = { start };
