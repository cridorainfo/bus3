const express = require('express');
const db = require('../../db/db');
const { pushSyncStateToBuses, busIdsAffectedByStop } = require('../../sync/hubSyncServer');

const router = express.Router();

function pushToBusesOnStop(stopId) {
  pushSyncStateToBuses(busIdsAffectedByStop(stopId));
}

// Search across every stop, regardless of which route(s) it's linked to — this is what backs
// the Admin's "find or link a stop" flow (spec ask: reuse a stop + its recorded audio across
// routes instead of duplicating both).
router.get('/search', (req, res) => {
  const q = (req.query.q || '').trim();
  const like = `%${q}%`;
  const rows = db
    .prepare(`
      SELECT * FROM stops
      WHERE name_ml LIKE ? OR name_en LIKE ?
      ORDER BY name_en, name_ml
      LIMIT 25
    `)
    .all(like, like);

  const routesForStop = db.prepare(`
    SELECT r.route_id, r.name FROM route_stops rs
    JOIN routes r ON r.route_id = rs.route_id
    WHERE rs.stop_id = ?
  `);
  const hasAdClip = db.prepare("SELECT 1 FROM content_items WHERE stop_id = ? AND type = 'stop_name_ad' LIMIT 1");

  res.json(
    rows.map((s) => ({
      ...s,
      used_by_routes: routesForStop.all(s.stop_id),
      has_ad_clip: !!hasAdClip.get(s.stop_id),
    }))
  );
});

// Global edit — renaming a stop (or fixing a mispronunciation source name) updates it
// everywhere it's linked, in one place, per the spec's "one route, many buses" propagation
// principle extended to "one stop, many routes."
router.put('/:stopId', (req, res) => {
  const stop = db.prepare('SELECT * FROM stops WHERE stop_id = ?').get(req.params.stopId);
  if (!stop) return res.status(404).json({ error: 'stop_not_found' });

  const { name_ml, name_en, announcement_template } = req.body || {};
  db.prepare('UPDATE stops SET name_ml = ?, name_en = ?, announcement_template = ? WHERE stop_id = ?').run(
    name_ml ?? stop.name_ml,
    name_en ?? stop.name_en,
    announcement_template ?? stop.announcement_template,
    stop.stop_id
  );

  pushToBusesOnStop(stop.stop_id);
  res.json(db.prepare('SELECT * FROM stops WHERE stop_id = ?').get(stop.stop_id));
});

// Swap toggle (spec ask): when on and a stop_name_ad clip exists, the Hub plays it instead of
// the plain stop_name — see hub/src/engine/playbackEngine.js composeAnnouncement.
router.post('/:stopId/toggle-ads', (req, res) => {
  const stop = db.prepare('SELECT * FROM stops WHERE stop_id = ?').get(req.params.stopId);
  if (!stop) return res.status(404).json({ error: 'stop_not_found' });

  const { enabled } = req.body || {};
  db.prepare('UPDATE stops SET ads_enabled = ? WHERE stop_id = ?').run(enabled ? 1 : 0, stop.stop_id);

  pushToBusesOnStop(stop.stop_id);
  res.json({ ok: true, ads_enabled: !!enabled });
});

module.exports = router;
