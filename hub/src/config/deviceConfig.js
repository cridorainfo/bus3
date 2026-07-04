const db = require('../db/db');

// This table having zero rows means "unpaired" (a fresh/reinstalled Hub — see
// src/api/routes/pairing.js). It only ever holds one row, since a Hub represents exactly one
// bus, so these read it fresh each call rather than caching a value at require-time — that's
// what lets pairing take effect immediately with no restart.
function getDeviceConfig() {
  return db.prepare('SELECT * FROM device_config LIMIT 1').get();
}

// HUB_BUS_ID/HUB_CLOUD_API_KEY env vars remain a dev/testing shortcut that bypasses pairing
// entirely (see db/seed.js) — real installs have no env vars set and pair via the device-code
// flow instead (see sync/pairingAgent.js).
function getBusId() {
  const cfg = getDeviceConfig();
  return (cfg && cfg.bus_id) || process.env.HUB_BUS_ID || null;
}

function getApiKey() {
  const cfg = getDeviceConfig();
  return (cfg && cfg.api_key) || process.env.HUB_CLOUD_API_KEY || null;
}

function isPaired() {
  return !!getBusId();
}

// Joins in the route's friendly name (not just its ID) for display in the Panel/Display
// identity banner — a non-technical driver/conductor should see "Kochi - Thrissur Express",
// not a raw route_id slug.
function getRouteName(routeId) {
  if (!routeId) return null;
  const route = db.prepare('SELECT name FROM routes WHERE route_id = ?').get(routeId);
  return route ? route.name : null;
}

module.exports = { getBusId, getApiKey, isPaired, getDeviceConfig, getRouteName };
