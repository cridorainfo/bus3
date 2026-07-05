const WebSocket = require('ws');
const db = require('../db/db');
const { currentSettings } = require('../settingsStore');

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

  // Ad targeting is single-select per content item (all buses / one tier / one route / one bus)
  // — this clause excludes anything targeted at a *different* bus or a *different* tier than
  // this one, applied to every content query below regardless of its route/stop scope.
  const targetingClause = 'AND (target_bus_id IS NULL OR target_bus_id = @busId) AND (tier IS NULL OR tier = @tier)';
  const targetingParams = { busId, tier: bus.tier || null };

  const contentMap = new Map();
  // Truly global content (chime/filler/outro) ships regardless of route assignment, so a bus
  // can play something sensible the moment a route is assigned — this bucket also carries
  // tier-targeted and bus-targeted ads, since neither sets route_id/stop_id.
  for (const item of db.prepare(`SELECT * FROM content_items WHERE route_id IS NULL AND stop_id IS NULL ${targetingClause}`).all(targetingParams)) {
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

    for (const item of db.prepare(`SELECT * FROM content_items WHERE route_id = @routeId ${targetingClause}`).all({ routeId, ...targetingParams })) {
      contentMap.set(item.content_id, item);
    }
    for (const stop of stops) {
      for (const item of db.prepare(`SELECT * FROM content_items WHERE stop_id = @stopId ${targetingClause}`).all({ stopId: stop.stop_id, ...targetingParams })) {
        contentMap.set(item.content_id, item);
      }
    }
  }

  // --- Campaign budget/quota (simplified Pacing Engine — recomputed on every sync, no nightly
  // batch job): an inactive campaign's content doesn't ship at all; an unlimited (budget_paisa
  // NULL) campaign needs no quota row, since the hub already knows "unlimited" from the
  // campaign row itself; a budgeted campaign gets this bus's rounded-down share of what's left. ---
  const campaignIds = new Set(Array.from(contentMap.values()).map((c) => c.campaign_id).filter(Boolean));
  const campaigns = [];
  const campaignQuotas = [];
  for (const campaignId of campaignIds) {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE campaign_id = ?').get(campaignId);
    if (!campaign) continue; // unknown campaign_id — leave its content as-is; hub fails open (unlimited) for an unrecognized campaign

    if (!campaign.active) {
      for (const [id, item] of contentMap) {
        if (item.campaign_id === campaignId) contentMap.delete(id);
      }
      continue;
    }
    campaigns.push(campaign);
    if (campaign.budget_paisa == null) continue; // unlimited/free — no quota needed

    const remainingPaisa = Math.max(0, campaign.budget_paisa - campaign.spent_paisa);
    const playsRemainingTotal = Math.floor(remainingPaisa / campaign.rate_paisa);
    // v1 assumption: one campaign maps to one targeting scope — resolved from whichever
    // content_item referencing it is present (see the plan's known limitation if that's ever violated).
    const representativeItem = Array.from(contentMap.values()).find((c) => c.campaign_id === campaignId);
    const eligibleBusIds = representativeItem ? eligibleBusIdsForItem(representativeItem) : [busId];
    const playsAllotted = Math.floor(playsRemainingTotal / Math.max(1, eligibleBusIds.length));
    campaignQuotas.push({ campaign_id: campaignId, plays_allotted: playsAllotted });
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
      campaigns,
      campaign_quotas: campaignQuotas,
      settings: currentSettings(), // fleet-wide knobs, e.g. ad_interval_sec — see settingsStore.js
    },
  };
}

// Which buses are eligible for a given content item's own targeting (route/tier/specific-bus,
// or "all buses" when none is set) — used to split a campaign's remaining budget fairly across
// however many buses could actually play it.
function eligibleBusIdsForItem(item) {
  if (item.target_bus_id) return [item.target_bus_id];
  if (item.route_id) return busIdsAffectedByRoute(item.route_id);
  if (item.tier) return db.prepare('SELECT bus_id FROM buses WHERE tier = ?').all(item.tier).map((r) => r.bus_id);
  return busIdsAffectedByRoute(null); // null = every bus, same resolution the push-targeting helper already uses
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

const findExistingPlayLog = db.prepare('SELECT 1 FROM play_logs WHERE bus_id = ? AND hub_log_id = ?');
const insertOrReplacePlayLog = db.prepare(`
  INSERT OR REPLACE INTO play_logs
    (bus_id, hub_log_id, trip_id, content_id, campaign_id, stop_id, played_at, duration_played_sec, billable, received_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
`);
const incrementCampaignSpend = db.prepare('UPDATE campaigns SET spent_paisa = spent_paisa + ? WHERE campaign_id = ?');
const getCampaignRate = db.prepare('SELECT rate_paisa FROM campaigns WHERE campaign_id = ?');

function storeReportedPlayLogs(busId, logs) {
  const tx = db.transaction((rows) => {
    for (const l of rows) {
      // A dropped ack (see syncAgent.js's reportUp/markSynced) can resend the same log more than
      // once — INSERT OR REPLACE keeps storage itself idempotent via the (bus_id, hub_log_id)
      // UNIQUE constraint, but billing needs the same guarantee explicitly: only ever charge a
      // campaign for a play the very first time this exact log is seen, never on a resend/replace.
      const alreadyStored = !!findExistingPlayLog.get(busId, l.log_id);
      insertOrReplacePlayLog.run(busId, l.log_id, l.trip_id, l.content_id, l.campaign_id, l.stop_id, l.played_at, l.duration_played_sec, l.billable ? 1 : 0);

      if (!alreadyStored && l.billable && l.campaign_id) {
        const campaign = getCampaignRate.get(l.campaign_id);
        if (campaign) incrementCampaignSpend.run(campaign.rate_paisa, l.campaign_id);
      }
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
