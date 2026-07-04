const express = require('express');
const crypto = require('crypto');
const db = require('../../db/db');
const { uniqueId } = require('../idgen');
const { pushSyncStateToBus, disconnectBus } = require('../../sync/hubSyncServer');

const router = express.Router();

const ONLINE_THRESHOLD_MS = 30 * 1000; // last_seen_at within this window = "online" in the UI

function withComputedStatus(bus) {
  // SQLite's datetime('now') yields 'YYYY-MM-DD HH:MM:SS' (UTC, no separator) — needs
  // reshaping into a format Date() will parse as UTC rather than local time.
  const lastSeenMs = bus.last_seen_at ? new Date(bus.last_seen_at.replace(' ', 'T') + 'Z').getTime() : null;
  const online = !!lastSeenMs && Date.now() - lastSeenMs < ONLINE_THRESHOLD_MS;
  const assignedRoutes = db
    .prepare(`
      SELECT r.route_id, r.name, r.name_ml FROM bus_routes br
      JOIN routes r ON r.route_id = br.route_id
      WHERE br.bus_id = ?
      ORDER BY r.name
    `)
    .all(bus.bus_id);
  return { ...bus, online, assigned_routes: assignedRoutes };
}

router.get('/', (req, res) => {
  const buses = db
    .prepare(`
      SELECT b.*, r.name AS route_name
      FROM buses b LEFT JOIN routes r ON r.route_id = b.route_id
      ORDER BY b.created_at DESC
    `)
    .all();
  res.json(buses.map(withComputedStatus));
});

router.post('/', (req, res) => {
  const { reg_number, friendly_name, tier, hardware_version } = req.body || {};
  if (!reg_number || !reg_number.trim()) {
    return res.status(400).json({ error: 'reg_number_required' });
  }
  const busId = uniqueId(db, 'buses', 'bus_id', reg_number);
  const apiKey = crypto.randomBytes(16).toString('hex');

  db.prepare(`
    INSERT INTO buses (bus_id, reg_number, friendly_name, api_key, tier, hardware_version, route_id)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run(busId, reg_number.trim(), (friendly_name || '').trim() || null, apiKey, tier || 'rural', hardware_version || null);

  res.status(201).json(withComputedStatus(db.prepare('SELECT * FROM buses WHERE bus_id = ?').get(busId)));
});

// A bus can run more than one route — the driver/conductor picks which one is active from
// their phone, locally (hub/src/api/routes/trip.js's select-route), no cloud round-trip needed.
router.post('/:busId/routes', (req, res) => {
  const { busId } = req.params;
  const { route_id } = req.body || {};
  const bus = db.prepare('SELECT * FROM buses WHERE bus_id = ?').get(busId);
  if (!bus) return res.status(404).json({ error: 'bus_not_found' });
  const route = db.prepare('SELECT * FROM routes WHERE route_id = ?').get(route_id);
  if (!route) return res.status(404).json({ error: 'route_not_found' });

  db.prepare('INSERT OR IGNORE INTO bus_routes (bus_id, route_id) VALUES (?, ?)').run(busId, route_id);
  const pushed = pushSyncStateToBus(busId); // instant if the bus's Hub is online right now

  res.json({ ok: true, pushed_live: pushed });
});

router.delete('/:busId/routes/:routeId', (req, res) => {
  const { busId, routeId } = req.params;
  db.prepare('DELETE FROM bus_routes WHERE bus_id = ? AND route_id = ?').run(busId, routeId);
  const pushed = pushSyncStateToBus(busId);
  res.json({ ok: true, pushed_live: pushed });
});

// Severs this Hub's identity without deleting the bus record — its route assignments, friendly
// name, and connect code all stay put (useful when swapping the physical PC/hardware for the
// same bus). Rotates api_key so the old Hub's credentials stop working immediately, and pushes a
// live disconnect if it's online right now so it shows a fresh pairing ID without waiting for a
// reconnect attempt to happen to fail on its own.
router.post('/:busId/unpair', (req, res) => {
  const bus = db.prepare('SELECT * FROM buses WHERE bus_id = ?').get(req.params.busId);
  if (!bus) return res.status(404).json({ error: 'bus_not_found' });

  const apiKey = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE buses SET api_key = ?, paired_at = NULL WHERE bus_id = ?').run(apiKey, bus.bus_id);
  disconnectBus(bus.bus_id);

  res.json({ ok: true });
});

router.delete('/:busId', (req, res) => {
  const { busId } = req.params;
  // Kick any live connection first — otherwise its next periodic report would try to insert a
  // trip/play_log row referencing a bus_id that's about to not exist, violating the foreign key
  // below anyway.
  disconnectBus(busId);
  // trips/play_logs/pending_pairings.claimed_bus_id all reference buses(bus_id) with no ON
  // DELETE clause — deleting the bus without clearing these first fails with a FOREIGN KEY
  // constraint error the moment it has ever run a trip or been paired (i.e. almost always).
  db.prepare('DELETE FROM bus_routes WHERE bus_id = ?').run(busId);
  db.prepare('DELETE FROM trips WHERE bus_id = ?').run(busId);
  db.prepare('DELETE FROM play_logs WHERE bus_id = ?').run(busId);
  db.prepare('UPDATE pending_pairings SET claimed_bus_id = NULL, claimed_api_key = NULL WHERE claimed_bus_id = ?').run(busId);
  db.prepare('DELETE FROM buses WHERE bus_id = ?').run(busId);
  res.json({ ok: true });
});

function generateCode(length, chars) {
  let code = '';
  for (let i = 0; i < length; i++) code += chars[crypto.randomInt(chars.length)];
  return code;
}

// The persistent phone connect code (replaces the old daily_pin) — set/rotated by admin,
// relayed verbally to whoever's driving/conducting that bus. Not one-time: stays valid until
// rotated again.
router.post('/:busId/connect-code', (req, res) => {
  const bus = db.prepare('SELECT * FROM buses WHERE bus_id = ?').get(req.params.busId);
  if (!bus) return res.status(404).json({ error: 'bus_not_found' });

  const code = generateCode(4, '0123456789');
  db.prepare('UPDATE buses SET connect_code = ? WHERE bus_id = ?').run(code, bus.bus_id);
  const pushed = pushSyncStateToBus(bus.bus_id);

  res.json({ ok: true, connect_code: code, pushed_live: pushed });
});

// Boots every currently-paired phone off this bus — e.g. to make room for a new driver/
// conductor. Takes effect the next time the bus's Hub is online (it compares this timestamp on
// every sync), not instantly if the bus happens to be offline right now.
router.post('/:busId/disconnect-devices', (req, res) => {
  const bus = db.prepare('SELECT * FROM buses WHERE bus_id = ?').get(req.params.busId);
  if (!bus) return res.status(404).json({ error: 'bus_not_found' });

  db.prepare("UPDATE buses SET devices_disconnect_at = datetime('now') WHERE bus_id = ?").run(bus.bus_id);
  const pushed = pushSyncStateToBus(bus.bus_id);

  res.json({ ok: true, pushed_live: pushed });
});

module.exports = router;
