const path = require('path');
const fs = require('fs');

// Required as the very first line of server.js, before anything else — so even a crash while
// requiring the DB or another early module still counts as a failed boot. No-op unless this
// Hub was installed via scripts/setup-auto-update.js (HUB_INSTALL_ROOT set); a plain `npm start`
// dev checkout is completely unaffected.
//
// Layout (see hub/README.md "Auto-updates"):
//   <HUB_INSTALL_ROOT>\hub\              <- this running app (what the Windows service points at)
//   <HUB_INSTALL_ROOT>\hub-releases\     <- staged-<version>/, rollback-<version>/ (one level back)
//   <HUB_INSTALL_ROOT>\data\update-state.json
//
// If a freshly-applied version fails to reach markHealthy() (i.e. never gets as far as
// server.listen succeeding) MAX_BOOT_ATTEMPTS times in a row, and a rollback copy of the
// previous version exists, this swaps it back in and restarts — an unattended kiosk PC has no
// one to reboot it by hand, so a bad release must be self-healing.

const INSTALL_ROOT = process.env.HUB_INSTALL_ROOT || null;
const MAX_BOOT_ATTEMPTS = 3;

if (!INSTALL_ROOT) {
  module.exports = { markHealthy() {} };
} else {
  const { readState, writeState } = require('./config/updateState');

  const HUB_APP_DIR = path.join(__dirname, '..'); // <root>\hub
  const RELEASES_DIR = path.join(INSTALL_ROOT, 'hub-releases');
  const version = require(path.join(HUB_APP_DIR, 'package.json')).version;

  const state = readState(INSTALL_ROOT, version);
  state.bootAttempts = state.bootAttempts || {};
  state.bootAttempts[version] = (state.bootAttempts[version] || 0) + 1;
  writeState(INSTALL_ROOT, state);

  if (state.bootAttempts[version] > MAX_BOOT_ATTEMPTS) {
    const previousVersion = state.previousVersion;
    const rollbackDir = previousVersion ? path.join(RELEASES_DIR, `rollback-${previousVersion}`) : null;

    if (rollbackDir && fs.existsSync(rollbackDir)) {
      console.error(`[bootGuard] v${version} failed to start ${state.bootAttempts[version]} times in a row — rolling back to v${previousVersion}`);
      try {
        const failedDir = path.join(RELEASES_DIR, `failed-${version}-${Date.now()}`);
        fs.renameSync(HUB_APP_DIR, failedDir);
        fs.renameSync(rollbackDir, HUB_APP_DIR);
        fs.rmSync(failedDir, { recursive: true, force: true });

        state.currentVersion = previousVersion;
        state.previousVersion = null;
        state.bootAttempts[previousVersion] = 0;
        delete state.bootAttempts[version];
        writeState(INSTALL_ROOT, state);

        console.error(`[bootGuard] rolled back to v${previousVersion} — restarting`);
      } catch (err) {
        console.error('[bootGuard] rollback attempt failed:', err.message);
      }
      process.exit(1); // let the Windows service (node-windows) restart the process
    } else {
      console.error(`[bootGuard] v${version} failed to start ${state.bootAttempts[version]} times in a row, but no rollback version is available — continuing anyway`);
    }
  }

  module.exports = {
    markHealthy() {
      const s = readState(INSTALL_ROOT, version);
      s.bootAttempts = s.bootAttempts || {};
      s.bootAttempts[version] = 0;
      s.currentVersion = version;
      writeState(INSTALL_ROOT, s);
    },
  };
}
