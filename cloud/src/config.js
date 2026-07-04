const path = require('path');

// Overridable so a real deployment (e.g. Railway) can point this at a mounted persistent
// volume — otherwise uploaded content and the SQLite DB live on ephemeral container storage
// and vanish on the next deploy. See ../../DEPLOYMENT.md.
const ASSETS_DIR = process.env.CLOUD_ASSETS_DIR || path.join(__dirname, '..', 'assets');

// Uploaded Hub software release bundles (.zip) — same persistence concern as ASSETS_DIR.
const RELEASES_DIR = process.env.CLOUD_RELEASES_DIR || path.join(__dirname, '..', 'releases');

module.exports = { ASSETS_DIR, RELEASES_DIR };
