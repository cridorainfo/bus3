const express = require('express');
const crypto = require('crypto');
const db = require('../../db/db');
const { uniqueId } = require('../idgen');
const { pushSyncStateToBus } = require('../../sync/hubSyncServer');

const router = express.Router();

const ONLINE_THRESHOLD_MS = 30 * 1000; // last_seen_at within this window = "online" in the UI

function withComputedStatus(bus) {
  // SQLite's datetime('now') yields 'YYYY-MM-DD HH:MM:SS' (UTC, no separator) — needs
  // reshaping into a format Date() will parse as UTC rather than local time.
  const lastSeenMs = bus.last_seen_at ? new Date(bus.last_seen_at.replace(' ', 'T') + 'Z').getTime() : null;
  const online = !!lastSeenMs && Date.now() - lastSeenMs < ONLINE_THRESHOLD_MS;
  return { ...bus, online };
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
  const { reg_number, tier, hardware_version } = req.body || {};
  if (!reg_number || !reg_number.trim()) {
    return res.status(400).json({ error: 'reg_number_required' });
  }
  const busId = uniqueId(db, 'buses', 'bus_id', reg_number);
  const apiKey = crypto.randomBytes(16).toString('hex');

  db.prepare(`
    INSERT INTO buses (bus_id, reg_number, api_key, tier, hardware_version, route_id)
    VALUES (?, ?, ?, ?, ?, NULL)
  `).run(busId, reg_number.trim(), apiKey, tier || 'rural', hardware_version || null);

  res.status(201).json(withComputedStatus(db.prepare('SELECT * FROM buses WHERE bus_id = ?').get(busId)));
});

router.post('/:busId/assign-route', (req, res) => {
  const { busId } = req.params;
  const { route_id } = req.body || {};
  const bus = db.prepare('SELECT * FROM buses WHERE bus_id = ?').get(busId);
  if (!bus) return res.status(404).json({ error: 'bus_not_found' });

  if (route_id) {
    const route = db.prepare('SELECT * FROM routes WHERE route_id = ?').get(route_id);
    if (!route) return res.status(404).json({ error: 'route_not_found' });
  }

  db.prepare('UPDATE buses SET route_id = ? WHERE bus_id = ?').run(route_id || null, busId);
  const pushed = pushSyncStateToBus(busId); // instant if the bus's Hub is online right now

  res.json({ ok: true, pushed_live: pushed });
});

router.delete('/:busId', (req, res) => {
  const { busId } = req.params;
  db.prepare('DELETE FROM buses WHERE bus_id = ?').run(busId);
  res.json({ ok: true });
});

module.exports = router;
