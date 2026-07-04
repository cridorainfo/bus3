const crypto = require('crypto');
const db = require('../db/db');
const state = require('../engine/state');
const { isPaired } = require('../config/deviceConfig');
const { CLOUD_HTTP_BASE } = require('../config/cloudConfig');
const syncAgent = require('./syncAgent');

// Device-code pairing: this Hub generates its own short ID and displays it on the passenger
// screen (public/display/) — there's no keyboard at an unattended kiosk PC, so nothing is ever
// typed here. An admin reads the ID off that screen and claims it from the Admin dashboard
// against a real bus record; this agent just polls until that claim shows up.

const PAIRING_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — easy to read off a screen
const POLL_INTERVAL_MS = 4000;

function generatePairingId() {
  let id = '';
  for (let i = 0; i < 6; i++) id += PAIRING_ID_CHARS[crypto.randomInt(PAIRING_ID_CHARS.length)];
  return id;
}

// Stable across restarts while unpaired, rather than regenerating (which would strand an admin
// mid-claim if the Hub happened to reboot).
function getOrCreatePendingId() {
  const row = db.prepare('SELECT device_pairing_id FROM pending_pairing LIMIT 1').get();
  if (row) return row.device_pairing_id;
  const id = generatePairingId();
  db.prepare('INSERT INTO pending_pairing (device_pairing_id) VALUES (?)').run(id);
  return id;
}

function getCurrentPairingId() {
  const row = db.prepare('SELECT device_pairing_id FROM pending_pairing LIMIT 1').get();
  return row ? row.device_pairing_id : null;
}

async function registerWithCloud(id) {
  try {
    const res = await fetch(`${CLOUD_HTTP_BASE}/api/pair/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_pairing_id: id }),
    });
    return res.ok;
  } catch (err) {
    return false; // offline — never surfaced to the driver, just retried
  }
}

async function pollOnce(id) {
  try {
    const res = await fetch(`${CLOUD_HTTP_BASE}/api/pair/status/${id}`);
    if (res.status === 404) {
      await registerWithCloud(id); // cloud doesn't know this ID (e.g. its DB was reset) — re-register
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    if (data.claimed) adoptIdentity(data.bus_id, data.api_key);
  } catch (err) {
    // cloud unreachable — just try again next tick
  }
}

function adoptIdentity(busId, apiKey) {
  db.prepare('DELETE FROM device_config').run();
  db.prepare(`
    INSERT INTO device_config (bus_id, reg_number, api_key, hardware_version, esp32_vid, esp32_pid, last_sync_at)
    VALUES (?, ?, ?, 'v1', '10C4', 'EA60', NULL)
  `).run(busId, busId, apiKey); // reg_number is a placeholder — corrected by the first sync_state

  db.prepare('DELETE FROM pending_pairing').run();

  console.log(`[pairingAgent] paired as ${busId}`);
  state.update({
    bus: { bus_id: busId, reg_number: busId, friendly_name: null, route_assigned: null, route_name: null },
    pairingId: null,
  });
  syncAgent.connectIfPaired();
}

function start() {
  if (isPaired()) return; // nothing to do — already has an identity

  const id = getOrCreatePendingId();
  state.update({ pairingId: id });
  console.log(`[pairingAgent] not paired — showing pairing ID ${id} on the Display View`);

  let registered = false;
  registerWithCloud(id).then((ok) => { registered = ok; });

  const timer = setInterval(async () => {
    if (isPaired()) {
      clearInterval(timer);
      return;
    }
    if (!registered) registered = await registerWithCloud(id);
    await pollOnce(id);
  }, POLL_INTERVAL_MS);
}

module.exports = { start, getCurrentPairingId };
