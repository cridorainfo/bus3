const path = require('path');
const fs = require('fs');

// Shared by bootGuard.js and sync/updateAgent.js — both must agree on the exact shape and file
// location of <HUB_INSTALL_ROOT>/data/update-state.json, so this is the one place that writes it.

function statePath(installRoot) {
  return path.join(installRoot, 'data', 'update-state.json');
}

function readState(installRoot, defaultVersion) {
  try {
    return JSON.parse(fs.readFileSync(statePath(installRoot), 'utf8'));
  } catch (err) {
    return { currentVersion: defaultVersion, previousVersion: null, bootAttempts: {} };
  }
}

function writeState(installRoot, state) {
  const p = statePath(installRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

module.exports = { readState, writeState };
