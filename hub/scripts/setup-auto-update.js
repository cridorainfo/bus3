// One-time, opt-in migration: converts a normal Hub install (hub/ copied straight onto the PC,
// per DEPLOYMENT.md Part 2) into the layout src/sync/updateAgent.js and src/bootGuard.js expect,
// so this bus can receive future Hub software releases automatically instead of by hand.
//
// Existing installs are completely unaffected unless you run this — auto-update is off by
// default (see hub/README.md "Auto-updates").
//
// Usage (run from inside the currently-installed hub/scripts/ folder):
//   node scripts/setup-auto-update.js C:\AdKerala
//
// Resulting layout:
//   C:\AdKerala\hub\             <- this app (what the Windows service points at)
//   C:\AdKerala\hub-releases\    <- staged/rollback bundles, managed by updateAgent.js
//   C:\AdKerala\data\            <- hub.db + assets/ + update-state.json (survives every update)
//
// After this script finishes, re-run `node scripts/install-service.js` from the NEW location
// (C:\AdKerala\hub\scripts\) to point the Windows service at it.

const path = require('path');
const fs = require('fs');

const installRoot = process.argv[2];
if (!installRoot) {
  console.error('Usage: node scripts/setup-auto-update.js <install-root>  e.g. C:\\AdKerala');
  process.exit(1);
}

const CURRENT_HUB_DIR = path.join(__dirname, '..');
const TARGET_HUB_DIR = path.join(installRoot, 'hub');
const TARGET_DATA_DIR = path.join(installRoot, 'data');
const TARGET_RELEASES_DIR = path.join(installRoot, 'hub-releases');

if (path.resolve(CURRENT_HUB_DIR) === path.resolve(TARGET_HUB_DIR)) {
  console.error(`Already installed at ${TARGET_HUB_DIR} — nothing to move.`);
  process.exit(1);
}

function uninstallExistingService() {
  return new Promise((resolve) => {
    let Service;
    try {
      ({ Service } = require('node-windows'));
    } catch (err) {
      console.log('[setup-auto-update] node-windows not installed — skipping service uninstall (nothing was registered yet)');
      return resolve();
    }
    const svc = new Service({ name: 'AdKeralaHub', script: path.join(CURRENT_HUB_DIR, 'src', 'server.js') });
    svc.on('uninstall', () => {
      console.log('[setup-auto-update] uninstalled the old AdKeralaHub service registration');
      resolve();
    });
    svc.on('error', () => resolve()); // e.g. wasn't installed in the first place — fine, continue
    svc.uninstall();
  });
}

async function main() {
  console.log(`[setup-auto-update] moving ${CURRENT_HUB_DIR} -> ${TARGET_HUB_DIR}`);
  await uninstallExistingService();

  // Windows refuses to rename a directory that's the process's current working directory (or
  // that of any other running process) — this script is normally launched from inside
  // hub/scripts/, i.e. from inside CURRENT_HUB_DIR itself, so step out of it first.
  process.chdir(require('os').tmpdir());

  fs.mkdirSync(installRoot, { recursive: true });

  // Move data/ out first so it lands in the shared, update-surviving location instead of
  // getting carried along inside the versioned hub/ folder.
  const dataSrc = path.join(CURRENT_HUB_DIR, 'data');
  let tempDataHolder = null;
  if (fs.existsSync(dataSrc)) {
    tempDataHolder = path.join(require('os').tmpdir(), `adkerala-migrate-data-${Date.now()}`);
    fs.renameSync(dataSrc, tempDataHolder);
  }

  fs.renameSync(CURRENT_HUB_DIR, TARGET_HUB_DIR);

  if (tempDataHolder) {
    fs.renameSync(tempDataHolder, TARGET_DATA_DIR);
  } else {
    fs.mkdirSync(TARGET_DATA_DIR, { recursive: true });
  }
  fs.mkdirSync(path.join(TARGET_DATA_DIR, 'assets'), { recursive: true });
  fs.mkdirSync(TARGET_RELEASES_DIR, { recursive: true });

  console.log('[setup-auto-update] done. Now:');
  console.log(`  1. Add these as persistent SYSTEM environment variables (alongside your existing HUB_CLOUD_URL / HUB_TRANSPORT / etc — see DEPLOYMENT.md Part 2.3):`);
  console.log(`       HUB_INSTALL_ROOT=${installRoot}`);
  console.log(`       HUB_DB_PATH=${path.join(TARGET_DATA_DIR, 'hub.db')}`);
  console.log(`       HUB_ASSETS_DIR=${path.join(TARGET_DATA_DIR, 'assets')}`);
  console.log(`  2. cd "${TARGET_HUB_DIR}\\scripts" && node install-service.js`);
  console.log(`  3. Reboot once and confirm the kiosk Display View comes up as before — this bus now checks for and applies Hub software updates on its own.`);
}

main().catch((err) => {
  console.error('[setup-auto-update] failed:', err.message);
  process.exit(1);
});
