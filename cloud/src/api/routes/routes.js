const express = require('express');
const db = require('../../db/db');
const { uniqueId } = require('../idgen');
const { pushSyncStateToBuses, busIdsAffectedByRoute } = require('../../sync/hubSyncServer');

const router = express.Router();

// Stops are global; route_stops defines which stops belong to a route, in what order (spec
// ask: a stop and its recorded audio can be linked into any number of routes).
function getStops(routeId) {
  return db
    .prepare(`
      SELECT s.*, rs.sequence_no AS sequence_no
      FROM stops s JOIN route_stops rs ON rs.stop_id = s.stop_id
      WHERE rs.route_id = ?
      ORDER BY rs.sequence_no ASC
    `)
    .all(routeId);
}

function pushToBusesOnRoute(routeId) {
  pushSyncStateToBuses(busIdsAffectedByRoute(routeId));
}

const firstStopStmt = db.prepare(`
  SELECT s.name_en, s.name_ml FROM stops s JOIN route_stops rs ON rs.stop_id = s.stop_id
  WHERE rs.route_id = ? ORDER BY rs.sequence_no ASC LIMIT 1
`);
const lastStopStmt = db.prepare(`
  SELECT s.name_en, s.name_ml FROM stops s JOIN route_stops rs ON rs.stop_id = s.stop_id
  WHERE rs.route_id = ? ORDER BY rs.sequence_no DESC LIMIT 1
`);

router.get('/', (req, res) => {
  const routes = db.prepare('SELECT * FROM routes ORDER BY created_at DESC').all();
  const withCounts = routes.map((r) => {
    const first = firstStopStmt.get(r.route_id);
    const last = lastStopStmt.get(r.route_id);
    return {
      ...r,
      stop_count: db.prepare('SELECT COUNT(*) c FROM route_stops WHERE route_id = ?').get(r.route_id).c,
      bus_count: db.prepare('SELECT COUNT(*) c FROM buses WHERE route_id = ?').get(r.route_id).c,
      // Null when a route has 0-1 stops (first === last stop, not a meaningful "first/last") —
      // feeds the bus-card route search and the "suggest name from stops" helper on the client.
      first_stop_name_en: first ? first.name_en : null,
      first_stop_name_ml: first ? first.name_ml : null,
      last_stop_name_en: last ? last.name_en : null,
      last_stop_name_ml: last ? last.name_ml : null,
    };
  });
  res.json(withCounts);
});

router.get('/:routeId', (req, res) => {
  const route = db.prepare('SELECT * FROM routes WHERE route_id = ?').get(req.params.routeId);
  if (!route) return res.status(404).json({ error: 'route_not_found' });

  const hasAdClip = db.prepare("SELECT 1 FROM content_items WHERE stop_id = ? AND type = 'stop_name_ad' LIMIT 1");
  const stops = getStops(route.route_id).map((s) => ({ ...s, has_ad_clip: !!hasAdClip.get(s.stop_id) }));
  res.json({ ...route, stops });
});

router.post('/', (req, res) => {
  const { name, name_ml, tier } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name_required' });

  const routeId = uniqueId(db, 'routes', 'route_id', `R-${name}`);
  db.prepare('INSERT INTO routes (route_id, name, name_ml, tier) VALUES (?, ?, ?, ?)').run(
    routeId,
    name.trim(),
    (name_ml || '').trim() || null,
    tier || 'rural'
  );
  res.status(201).json({ ...db.prepare('SELECT * FROM routes WHERE route_id = ?').get(routeId), stops: [] });
});

// Editing name/name_ml/tier after creation — pushes to every bus currently assigned this route
// immediately (same live-propagation pattern as the stop endpoints below), so a rename or tier
// change reaches an online Hub without waiting for its next periodic reconnect.
router.put('/:routeId', (req, res) => {
  const { routeId } = req.params;
  const route = db.prepare('SELECT * FROM routes WHERE route_id = ?').get(routeId);
  if (!route) return res.status(404).json({ error: 'route_not_found' });

  const { name, name_ml, tier } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name_required' });

  db.prepare('UPDATE routes SET name = ?, name_ml = ?, tier = ? WHERE route_id = ?').run(
    name.trim(),
    (name_ml || '').trim() || null,
    tier || route.tier,
    routeId
  );

  pushToBusesOnRoute(routeId);
  res.json({ ...db.prepare('SELECT * FROM routes WHERE route_id = ?').get(routeId), stops: getStops(routeId) });
});

router.delete('/:routeId', (req, res) => {
  const { routeId } = req.params;
  const assigned = db.prepare('SELECT COUNT(*) c FROM buses WHERE route_id = ?').get(routeId).c;
  if (assigned > 0) {
    return res.status(409).json({ error: 'route_in_use', message: 'Unassign this route from all buses first.' });
  }
  // Only unlinks this route's stops — the global stop rows (and their audio) stay put in case
  // another route still references them.
  db.prepare('DELETE FROM route_stops WHERE route_id = ?').run(routeId);
  db.prepare('DELETE FROM content_items WHERE route_id = ?').run(routeId);
  db.prepare('DELETE FROM routes WHERE route_id = ?').run(routeId);
  res.json({ ok: true });
});

// --- Stops (route_stops link/unlink; stops themselves are global) ---

// mode: 'create' makes a brand-new global stop and links it; 'link' attaches an existing
// stop_id (found via /api/stops/search) instead of duplicating it.
router.post('/:routeId/stops', (req, res) => {
  const { routeId } = req.params;
  const route = db.prepare('SELECT * FROM routes WHERE route_id = ?').get(routeId);
  if (!route) return res.status(404).json({ error: 'route_not_found' });

  const { mode, name_ml, name_en, stop_id } = req.body || {};
  const nextSeq = (db.prepare('SELECT MAX(sequence_no) m FROM route_stops WHERE route_id = ?').get(routeId).m ?? -1) + 1;

  if (mode === 'link') {
    const stop = db.prepare('SELECT * FROM stops WHERE stop_id = ?').get(stop_id);
    if (!stop) return res.status(404).json({ error: 'stop_not_found' });
    db.prepare('INSERT OR IGNORE INTO route_stops (route_id, stop_id, sequence_no) VALUES (?, ?, ?)').run(routeId, stop_id, nextSeq);
  } else {
    if (!name_ml || !name_ml.trim()) return res.status(400).json({ error: 'name_ml_required' });
    const newStopId = uniqueId(db, 'stops', 'stop_id', `ST-${name_en || name_ml}`);
    db.prepare(`
      INSERT INTO stops (stop_id, route_id, name_ml, name_en, sequence_no, ads_enabled, announcement_template)
      VALUES (?, NULL, ?, ?, NULL, 0, 'chime,filler,stop_name,outro')
    `).run(newStopId, name_ml.trim(), (name_en || '').trim());
    db.prepare('INSERT INTO route_stops (route_id, stop_id, sequence_no) VALUES (?, ?, ?)').run(routeId, newStopId, nextSeq);
  }

  pushToBusesOnRoute(routeId);
  res.status(201).json(getStops(routeId));
});

// Unlinks the stop from this route only — the global stop and its audio are never deleted
// here, since another route may still reference them.
router.delete('/:routeId/stops/:stopId', (req, res) => {
  const { routeId, stopId } = req.params;
  db.prepare('DELETE FROM route_stops WHERE route_id = ? AND stop_id = ?').run(routeId, stopId);
  // route_stops is the source of truth; clear vestigial stops.route_id so a server restart
  // doesn't re-link this stop via the legacy migration in db.js.
  db.prepare('UPDATE stops SET route_id = NULL, sequence_no = NULL WHERE stop_id = ?').run(stopId);

  // Resequence remaining links so sequence_no stays contiguous (0..n-1).
  const remaining = db.prepare('SELECT stop_id FROM route_stops WHERE route_id = ? ORDER BY sequence_no ASC').all(routeId);
  const renumber = db.prepare('UPDATE route_stops SET sequence_no = ? WHERE route_id = ? AND stop_id = ?');
  db.transaction(() => {
    remaining.forEach((s, i) => renumber.run(i, routeId, s.stop_id));
  })();

  pushToBusesOnRoute(routeId);
  res.json(getStops(routeId));
});

router.post('/:routeId/stops/reorder', (req, res) => {
  const { routeId } = req.params;
  const { order } = req.body || {}; // array of stop_id in desired order
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order_required' });

  const renumber = db.prepare('UPDATE route_stops SET sequence_no = ? WHERE route_id = ? AND stop_id = ?');
  db.transaction(() => {
    order.forEach((stopId, i) => renumber.run(i, routeId, stopId));
  })();

  pushToBusesOnRoute(routeId);
  res.json(getStops(routeId));
});

module.exports = router;
