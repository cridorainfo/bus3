const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const db = require('../../db/db');
const { ASSETS_DIR } = require('../../config');
const { pushSyncStateToBuses, busIdsAffectedByRoute, busIdsAffectedByStop } = require('../../sync/hubSyncServer');

const router = express.Router();

const UPLOAD_DIR = path.join(ASSETS_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_TYPES = ['chime', 'filler', 'stop_name', 'stop_name_ad', 'outro', 'ad_video', 'ad_banner', 'ad_image', 'music'];

// Stop-specific content (stop_name/stop_name_ad) needs to reach every bus on every route that
// includes that stop — not just the one route it happened to be uploaded against, since stops
// are now shared across routes. A bus-targeted ad only ever needs to reach that one bus.
function pushForContent({ route_id, stop_id, target_bus_id }) {
  if (target_bus_id) {
    pushSyncStateToBuses([target_bus_id]);
  } else if (stop_id) {
    pushSyncStateToBuses(busIdsAffectedByStop(stop_id));
  } else {
    pushSyncStateToBuses(busIdsAffectedByRoute(route_id || null));
  }
}
const ALLOWED_MIME = new Set(['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp4', 'video/mp4', 'image/png', 'image/jpeg', 'image/webp']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB — plenty for a sample ad clip
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) return cb(new Error('unsupported_file_type'));
    cb(null, true);
  },
});

router.get('/', (req, res) => {
  const items = db
    .prepare(`
      SELECT c.*, r.name AS route_name, s.name_ml AS stop_name
      FROM content_items c
      LEFT JOIN routes r ON r.route_id = c.route_id
      LEFT JOIN stops s ON s.stop_id = c.stop_id
      ORDER BY c.uploaded_at DESC
    `)
    .all();
  res.json(items);
});

router.post('/', upload.single('file'), (req, res) => {
  const { type, route_id, stop_id, tier, duration_sec, advertiser_id, campaign_id, target_bus_id, display_mode } = req.body || {};
  if (!req.file) return res.status(400).json({ error: 'file_required' });
  if (!ALLOWED_TYPES.includes(type)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'invalid_type' });
  }

  const contentId = req.file.filename.replace(path.extname(req.file.filename), '');
  const resolvedDisplayMode = type === 'ad_image' ? 'fullscreen' : display_mode === 'fullscreen' ? 'fullscreen' : 'banner';
  db.prepare(`
    INSERT INTO content_items
      (content_id, type, file_path, original_filename, duration_sec, tier, advertiser_id, campaign_id, route_id, stop_id, target_bus_id, display_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    contentId,
    type,
    `uploads/${req.file.filename}`,
    req.file.originalname,
    duration_sec ? Number(duration_sec) : null,
    tier || null,
    advertiser_id || null,
    campaign_id || null,
    route_id || null,
    stop_id || null,
    target_bus_id || null,
    resolvedDisplayMode
  );

  pushForContent({ route_id: route_id || null, stop_id: stop_id || null, target_bus_id: target_bus_id || null });
  res.status(201).json(db.prepare('SELECT * FROM content_items WHERE content_id = ?').get(contentId));
});

router.delete('/:contentId', (req, res) => {
  const item = db.prepare('SELECT * FROM content_items WHERE content_id = ?').get(req.params.contentId);
  if (!item) return res.status(404).json({ error: 'not_found' });

  db.prepare('DELETE FROM content_items WHERE content_id = ?').run(req.params.contentId);
  const filePath = path.join(ASSETS_DIR, item.file_path);
  fs.unlink(filePath, () => {}); // best-effort; missing file shouldn't block the DB delete

  pushForContent({ route_id: item.route_id, stop_id: item.stop_id, target_bus_id: item.target_bus_id });
  res.json({ ok: true });
});

module.exports = router;
