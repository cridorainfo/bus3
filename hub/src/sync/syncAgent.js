const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const db = require('../db/db');
const { ensurePlayLogsWithoutContentFk } = db;
const state = require('../engine/state');
const { getBusId, getApiKey, isPaired, getDeviceConfig, getRouteName, getRouteNameMl } = require('../config/deviceConfig');
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
      // Only reset backoff once the cloud has actually accepted this Hub's credentials (the
      // `hello` handshake succeeded) — resetting it just because the TCP/WS socket opened meant
      // an identity the cloud rejects (e.g. a stale/unknown bus_id) would retry almost every
      // RECONNECT_BASE_MS forever instead of backing off, since open+reject+close happens fast.
      reconnectDelay = RECONNECT_BASE_MS;
      if (!state.cloudOnline) state.update({ cloudOnline: true }); // accepted handshake = genuinely online, not just socket-open
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
    if (state.cloudOnline) state.update({ cloudOnline: false }); // Display's status pill flips to "No Internet"
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
  const { bus, routes, content_items: contentItems, settings, campaigns, campaign_quotas: campaignQuotas } = payload;
  const incomingRouteIds = new Set((routes || []).map((r) => r.route_id));

  // Fleet-wide behavior knobs (e.g. ad_interval_sec) — mirrored locally so they keep applying
  // offline; playbackEngine reads them fresh each use, so no restart needed.
  if (settings && typeof settings === 'object') {
    const upsertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [key, value] of Object.entries(settings)) upsertSetting.run(key, String(value));
  }

  // Campaigns (budget/rate/unlimited-or-not) and today's per-bus quota — enough for
  // contentScheduler.hasQuotaRemaining() to decide locally, with zero live cloud round-trip.
  const upsertCampaign = db.prepare(`
    INSERT INTO campaigns (campaign_id, name, rate_paisa, budget_paisa, active) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(campaign_id) DO UPDATE SET name = excluded.name, rate_paisa = excluded.rate_paisa,
      budget_paisa = excluded.budget_paisa, active = excluded.active
  `);
  for (const c of campaigns || []) {
    upsertCampaign.run(c.campaign_id, c.name, c.rate_paisa, c.budget_paisa ?? null, c.active ? 1 : 0);
  }

  // Keyed by (campaign_id, date) — a new day is naturally a new row, so plays_used starts fresh
  // without an explicit reset; an existing today's row only has plays_allotted refreshed, never
  // plays_used, so an admin topping up mid-day doesn't erase what's already been played today.
  const upsertQuota = db.prepare(`
    INSERT INTO campaign_quotas (campaign_id, date, plays_allotted, plays_used) VALUES (?, date('now'), ?, 0)
    ON CONFLICT(campaign_id, date) DO UPDATE SET plays_allotted = excluded.plays_allotted
  `);
  for (const q of campaignQuotas || []) {
    upsertQuota.run(q.campaign_id, q.plays_allotted);
  }

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

  // Remove routes no longer assigned to this bus (e.g. seeded demo R1 after cloud pairing) so
  // the panel picker and display timeline can't show stale stop lists.
  const deleteOrphanRouteStops = db.prepare('DELETE FROM route_stops WHERE route_id = ?');
  const deleteOrphanRoute = db.prepare('DELETE FROM routes WHERE route_id = ?');
  const localAllRouteIds = db.prepare('SELECT route_id FROM routes').all().map((r) => r.route_id);
  db.transaction(() => {
    for (const routeId of localAllRouteIds) {
      if (incomingRouteIds.has(routeId)) continue;
      deleteOrphanRouteStops.run(routeId);
      deleteOrphanRoute.run(routeId);
    }
  })();

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

  // And the inverse: an admin assigning routes only populates assigned_routes — nothing picked
  // an *active* one, so the Panel header sat on "No route assigned" until the driver manually
  // used the dropdown even when there was only one obvious choice. Auto-activate the first
  // assigned route whenever none is active (never mid-trip); the dropdown still switches freely.
  const cfgAfterClear = getDeviceConfig();
  if (!cfgAfterClear.route_assigned && incomingRouteIds.size > 0 && !state.trip) {
    const firstAssigned = db.prepare('SELECT route_id FROM assigned_routes ORDER BY route_id LIMIT 1').get();
    if (firstAssigned) {
      db.prepare('UPDATE device_config SET route_assigned = ? WHERE bus_id = ?').run(firstAssigned.route_id, busId);
    }
  }

  if (bus) {
    db.prepare('UPDATE device_config SET reg_number = ?, friendly_name = ?, connect_code = ?, tier = ? WHERE bus_id = ?').run(
      bus.reg_number,
      bus.friendly_name || null,
      bus.connect_code || null,
      bus.tier || 'rural',
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

  // Reconcile local content_items to exactly match what's incoming — mirrors the route_stops/
  // assigned_routes reconciliation above. The incoming list is already scoped to what's relevant
  // to this bus (global + assigned routes/stops), so anything local that's missing is either a
  // genuine cloud-side delete or the bus simply lost access (route unassigned, etc.) — both cases
  // should remove the local copy identically, same as route_stops already does.
  const incomingContentIds = new Set((contentItems || []).map((c) => c.content_id));
  const incomingGlobalTypes = new Set((contentItems || []).filter((c) => !c.route_id && !c.stop_id).map((c) => c.type));
  const localContentRows = db.prepare('SELECT content_id, file_path, type, route_id, stop_id, target_bus_id, tier FROM content_items').all();
  const nullPlayLogContentRef = db.prepare('UPDATE play_logs SET content_id = NULL WHERE content_id = ?');
  const deleteContentItem = db.prepare('DELETE FROM content_items WHERE content_id = ?');
  ensurePlayLogsWithoutContentFk();

  // Download first — never drop local clips until replacements are actually on disk, otherwise
  // a failed fetch leaves announcements/ads with nothing to play.
  const downloadedGlobalTypes = new Set();
  const downloadOkById = new Map();
  for (const item of contentItems || []) {
    const ok = await ensureContentDownloaded(item);
    downloadOkById.set(item.content_id, ok);
    if (ok && !item.route_id && !item.stop_id && GLOBAL_ANNOUNCE_TYPES.includes(item.type)) {
      downloadedGlobalTypes.add(item.type);
    }
  }

  db.transaction(() => {
    for (const row of localContentRows) {
      if (incomingContentIds.has(row.content_id)) continue;
      // Keep seeded chime/filler/outro until the cloud ships a replacement — otherwise a fresh
      // paired bus loses all announcement segments the moment it first syncs.
      if (GLOBAL_ANNOUNCE_TYPES.includes(row.type) && !incomingGlobalTypes.has(row.type)) continue;
      // Cloud sent a replacement but the download failed — keep the seed so announcements still play.
      if (row.content_id.endsWith('-default') && GLOBAL_ANNOUNCE_TYPES.includes(row.type) && !downloadedGlobalTypes.has(row.type)) {
        continue;
      }
      // Same for ads and other content: if the cloud sent a new item in this slot but the file
      // didn't land locally, keep what's already here until a later sync succeeds.
      const failedReplacement = (contentItems || []).some(
        (inc) => !downloadOkById.get(inc.content_id) && sameContentScope(inc, row)
      );
      if (failedReplacement) continue;
      removeContentItem(row.content_id, row.file_path, nullPlayLogContentRef, deleteContentItem);
    }
  })();

  enforceSingleGlobalClipPerType(contentItems, downloadOkById, nullPlayLogContentRef, deleteContentItem);
  enforceSingleStopClipPerType(contentItems, downloadOkById, nullPlayLogContentRef, deleteContentItem);
  dedupeGlobalAnnouncementClips(nullPlayLogContentRef, deleteContentItem);
  purgeStaleDefaultClips(downloadOkById, nullPlayLogContentRef, deleteContentItem);
  purgeOrphanAssetFiles();

  db.prepare("UPDATE device_config SET last_sync_at = datetime('now') WHERE bus_id = ?").run(busId);

  // Content pool changed — if a trip is running, rotate the screen ad immediately so new uploads
  // (e.g. ad_image) show up without waiting for the next Forward or idle interval.
  if (state.trip && (contentItems || []).length > 0) {
    require('../engine/playbackEngine').idleAdTick();
  }

  const cfg = getDeviceConfig();
  state.update({
    bus: {
      bus_id: cfg.bus_id,
      reg_number: cfg.reg_number,
      friendly_name: cfg.friendly_name,
      route_assigned: cfg.route_assigned,
      route_name: getRouteName(cfg.route_assigned),
      route_name_ml: getRouteNameMl(cfg.route_assigned),
    },
    contentVersion: Date.now(), // Panel/Display refetch stops/content on this change (not just route_id)
  });
}

const AUDIO_TYPES = new Set(['chime', 'filler', 'stop_name', 'stop_name_ad', 'sponsor_snippet', 'outro', 'music']);
const GLOBAL_ANNOUNCE_TYPES = ['chime', 'filler', 'outro'];

function sameContentScope(a, b) {
  return a.type === b.type
    && (a.route_id || null) === (b.route_id || null)
    && (a.stop_id || null) === (b.stop_id || null)
    && (a.target_bus_id || null) === (b.target_bus_id || null)
    && (a.tier || null) === (b.tier || null);
}

function unlinkContentFile(filePath) {
  if (!filePath) return;
  const localPath = path.join(ASSETS_DIR, filePath.replace(/^\//, ''));
  fs.unlink(localPath, () => {});
}

function removeContentItem(contentId, filePath, nullPlayLogContentRef, deleteContentItem) {
  const runDelete = () => {
    db.transaction(() => {
      nullPlayLogContentRef.run(contentId);
      deleteContentItem.run(contentId);
    })();
    unlinkContentFile(filePath);
  };
  try {
    runDelete();
    return true;
  } catch (err) {
    if (String(err.message).includes('FOREIGN KEY') && ensurePlayLogsWithoutContentFk()) {
      try {
        runDelete();
        return true;
      } catch (retryErr) {
        console.warn(`[syncAgent] could not delete stale content_item ${contentId}: ${retryErr.message}`);
        return false;
      }
    }
    console.warn(`[syncAgent] could not delete stale content_item ${contentId}: ${err.message}`);
    return false;
  }
}

function enforceSingleGlobalClipPerType(contentItems, downloadOkById, nullPlayLogContentRef, deleteContentItem) {
  for (const type of GLOBAL_ANNOUNCE_TYPES) {
    const incoming = (contentItems || [])
      .filter((c) => c.type === type && !c.route_id && !c.stop_id && downloadOkById.get(c.content_id))
      .sort((a, b) => b.content_id.localeCompare(a.content_id));
    if (incoming.length === 0) continue;
    const keepId = incoming[0].content_id;
    const locals = db.prepare(`
      SELECT content_id, file_path FROM content_items
      WHERE type = ? AND route_id IS NULL AND stop_id IS NULL
    `).all(type);
    for (const row of locals) {
      if (row.content_id === keepId) continue;
      removeContentItem(row.content_id, row.file_path, nullPlayLogContentRef, deleteContentItem);
    }
  }
}

function enforceSingleStopClipPerType(contentItems, downloadOkById, nullPlayLogContentRef, deleteContentItem) {
  const keepByKey = new Map();
  for (const item of contentItems || []) {
    if (!item.stop_id || !['stop_name', 'stop_name_ad'].includes(item.type)) continue;
    if (!downloadOkById.get(item.content_id)) continue;
    const key = `${item.stop_id}:${item.type}`;
    if (!keepByKey.has(key)) keepByKey.set(key, item.content_id);
  }
  for (const [key, keepId] of keepByKey) {
    const [stopId, type] = key.split(':');
    const locals = db.prepare('SELECT content_id, file_path FROM content_items WHERE stop_id = ? AND type = ?').all(stopId, type);
    for (const row of locals) {
      if (row.content_id === keepId) continue;
      removeContentItem(row.content_id, row.file_path, nullPlayLogContentRef, deleteContentItem);
    }
  }
}

function purgeStaleDefaultClips(downloadOkById, nullPlayLogContentRef, deleteContentItem) {
  for (const type of GLOBAL_ANNOUNCE_TYPES) {
    const hasCloudClip = db.prepare(`
      SELECT 1 FROM content_items
      WHERE type = ? AND route_id IS NULL AND stop_id IS NULL AND content_id NOT LIKE '%-default'
      LIMIT 1
    `).get(type);
    if (!hasCloudClip) continue;
    const defaults = db.prepare(`
      SELECT content_id, file_path FROM content_items
      WHERE type = ? AND route_id IS NULL AND stop_id IS NULL AND content_id LIKE '%-default'
    `).all(type);
    for (const row of defaults) {
      removeContentItem(row.content_id, row.file_path, nullPlayLogContentRef, deleteContentItem);
    }
  }
}

function purgeOrphanAssetFiles() {
  const referenced = new Set(
    db.prepare('SELECT file_path FROM content_items').all()
      .map((row) => path.basename(row.file_path))
      .filter(Boolean)
  );
  for (const sub of ['audio', 'media']) {
    const dir = path.join(ASSETS_DIR, sub);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      if (!referenced.has(name)) {
        try {
          fs.unlinkSync(path.join(dir, name));
          console.log(`[syncAgent] removed stale ${sub} file ${name}`);
        } catch (err) {
          console.warn(`[syncAgent] could not remove stale ${sub} file ${name}: ${err.message}`);
        }
      }
    }
  }
}

function dedupeGlobalAnnouncementClips(nullPlayLogContentRef, deleteContentItem) {
  for (const type of GLOBAL_ANNOUNCE_TYPES) {
    const rows = db.prepare(`
      SELECT content_id, file_path FROM content_items
      WHERE type = ? AND route_id IS NULL AND stop_id IS NULL
      ORDER BY CASE WHEN content_id LIKE '%-default' THEN 1 ELSE 0 END, content_id DESC
    `).all(type);
    for (let i = 1; i < rows.length; i += 1) {
      removeContentItem(rows[i].content_id, rows[i].file_path, nullPlayLogContentRef, deleteContentItem);
    }
  }
}

async function ensureContentDownloaded(item) {
  const isAudio = AUDIO_TYPES.has(item.type);
  const dir = path.join(ASSETS_DIR, isAudio ? 'audio' : 'media');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const filename = path.basename(item.file_path);
  const localPath = path.join(dir, filename);
  const localUrlPath = `/${isAudio ? 'audio' : 'media'}/${filename}`;

  const existingRow = db.prepare('SELECT file_path FROM content_items WHERE content_id = ?').get(item.content_id);
  if (existingRow?.file_path && path.basename(existingRow.file_path) !== filename) {
    unlinkContentFile(existingRow.file_path);
  }

  // Always re-fetch from cloud on sync so the hub never keeps playing an older local copy.
  try {
    const url = `${CLOUD_HTTP_BASE}/content/${item.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('empty file');
    fs.writeFileSync(localPath, buf);
  } catch (err) {
    if (!fs.existsSync(localPath) || fs.statSync(localPath).size === 0) {
      console.warn(`[syncAgent] could not download content ${item.content_id} (${item.type}): ${err.message}`);
      return false;
    }
    console.warn(`[syncAgent] cloud download failed for ${item.content_id}, keeping existing local file: ${err.message}`);
  }

  db.prepare(`
    INSERT INTO content_items (content_id, type, file_path, duration_sec, tier, advertiser_id, campaign_id, route_id, stop_id, target_bus_id, display_mode)
    VALUES (@content_id, @type, @file_path, @duration_sec, @tier, @advertiser_id, @campaign_id, @route_id, @stop_id, @target_bus_id, @display_mode)
    ON CONFLICT(content_id) DO UPDATE SET type = excluded.type, file_path = excluded.file_path,
      duration_sec = excluded.duration_sec, tier = excluded.tier, advertiser_id = excluded.advertiser_id,
      campaign_id = excluded.campaign_id, route_id = excluded.route_id, stop_id = excluded.stop_id,
      target_bus_id = excluded.target_bus_id, display_mode = excluded.display_mode
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
    target_bus_id: item.target_bus_id ?? null,
    display_mode: item.display_mode || 'banner',
  });
  return true;
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

// requestLocalUnpair: same deferred-until-idle reset as an admin-pushed 'unpaired' message —
// used by the driver-initiated Disconnect-from-Server button (api/routes/pairing.js).
module.exports = { start, connectIfPaired, requestLocalUnpair: handleUnpaired };
