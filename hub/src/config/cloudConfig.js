// Shared by syncAgent.js (WebSocket sync) and api/routes/pairing.js (one-time pairing HTTP
// call) — both need the same cloud base URLs, derived from a single source.
const CLOUD_WS_URL = process.env.HUB_CLOUD_URL || 'ws://localhost:4000/hub-sync';
const CLOUD_HTTP_BASE = process.env.HUB_CLOUD_HTTP || CLOUD_WS_URL.replace(/^ws/, 'http').replace(/\/hub-sync\/?$/, '');

module.exports = { CLOUD_WS_URL, CLOUD_HTTP_BASE };
