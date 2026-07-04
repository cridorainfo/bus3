const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const db = require('../../db/db');
const { RELEASES_DIR } = require('../../config');

const router = express.Router();

if (!fs.existsSync(RELEASES_DIR)) fs.mkdirSync(RELEASES_DIR, { recursive: true });

// Kept separate from content_items uploads (audio/video/images) — this is the Hub's own code,
// not passenger-facing content, and is versioned rather than replace-in-place.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, RELEASES_DIR),
  filename: (req, file, cb) => cb(null, `${req.body.version}.zip`),
});

const upload = multer({
  storage,
  limits: { fileSize: 300 * 1024 * 1024 }, // a release bundles its own node_modules — can be sizeable
  fileFilter: (req, file, cb) => {
    if (!req.body.version) return cb(new Error('version_required'));
    if (path.extname(file.originalname).toLowerCase() !== '.zip') return cb(new Error('zip_file_required'));
    cb(null, true);
  },
});

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM hub_releases ORDER BY created_at DESC').all());
});

// Polled by every Hub's updateAgent — deliberately unauthenticated, same posture as pairing
// register/status: it's just a version+checksum manifest, no bus-specific data in it.
router.get('/latest', (req, res) => {
  const release = db
    .prepare('SELECT version, checksum_sha256 FROM hub_releases WHERE published = 1 ORDER BY created_at DESC LIMIT 1')
    .get();
  if (!release) return res.json({ version: null });
  res.json({ version: release.version, checksum_sha256: release.checksum_sha256 });
});

router.get('/:version/download', (req, res) => {
  const release = db.prepare('SELECT * FROM hub_releases WHERE version = ?').get(req.params.version);
  if (!release) return res.status(404).json({ error: 'not_found' });
  res.download(path.join(RELEASES_DIR, release.file_path));
});

router.post('/', upload.single('file'), (req, res) => {
  const { version, notes } = req.body || {};
  if (!req.file) return res.status(400).json({ error: 'file_required' });

  const existing = db.prepare('SELECT version FROM hub_releases WHERE version = ?').get(version);
  if (existing) {
    fs.unlink(req.file.path, () => {});
    return res.status(409).json({ error: 'version_already_exists' });
  }

  const checksum = sha256File(req.file.path);
  db.prepare(`
    INSERT INTO hub_releases (version, notes, file_path, checksum_sha256, published)
    VALUES (?, ?, ?, ?, 0)
  `).run(version, notes || null, req.file.filename, checksum);

  res.status(201).json(db.prepare('SELECT * FROM hub_releases WHERE version = ?').get(version));
});

router.post('/:version/publish', (req, res) => {
  const release = db.prepare('SELECT * FROM hub_releases WHERE version = ?').get(req.params.version);
  if (!release) return res.status(404).json({ error: 'not_found' });
  db.prepare('UPDATE hub_releases SET published = 1 WHERE version = ?').run(req.params.version);
  res.json({ ok: true });
});

router.post('/:version/unpublish', (req, res) => {
  const release = db.prepare('SELECT * FROM hub_releases WHERE version = ?').get(req.params.version);
  if (!release) return res.status(404).json({ error: 'not_found' });
  db.prepare('UPDATE hub_releases SET published = 0 WHERE version = ?').run(req.params.version);
  res.json({ ok: true });
});

router.delete('/:version', (req, res) => {
  const release = db.prepare('SELECT * FROM hub_releases WHERE version = ?').get(req.params.version);
  if (!release) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM hub_releases WHERE version = ?').run(req.params.version);
  fs.unlink(path.join(RELEASES_DIR, release.file_path), () => {});
  res.json({ ok: true });
});

module.exports = router;
