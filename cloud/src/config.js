const path = require('path');

// Overridable so a real deployment (e.g. Railway) can point this at a mounted persistent
// volume — otherwise uploaded content and the SQLite DB live on ephemeral container storage
// and vanish on the next deploy. See ../../DEPLOYMENT.md.
const ASSETS_DIR = process.env.CLOUD_ASSETS_DIR || path.join(__dirname, '..', 'assets');

module.exports = { ASSETS_DIR };
