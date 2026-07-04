const path = require('path');

// Overridable so an auto-updating install (see src/sync/updateAgent.js) can point this at a
// directory outside the versioned app folder — otherwise downloaded ad/audio content would be
// wiped (or left orphaned) every time the app folder gets swapped for a new release.
const ASSETS_DIR = process.env.HUB_ASSETS_DIR || path.join(__dirname, '..', '..', 'assets');

module.exports = { ASSETS_DIR };
