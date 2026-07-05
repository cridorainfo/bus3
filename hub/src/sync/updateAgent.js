const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const state = require('../engine/state');
const { CLOUD_HTTP_BASE } = require('../config/cloudConfig');
const { readState, writeState } = require('../config/updateState');

// Updates the Hub's own *code* (routes/stops/content already sync live via syncAgent.js — this
// is separate). No-op unless this Hub was installed via scripts/setup-auto-update.js
// (HUB_INSTALL_ROOT set) — a plain dev checkout (`npm start`) is entirely unaffected.
//
// Never touches the live running app: a newer release is downloaded, checksum-verified, and
// extracted into hub-releases/staged-<version>/ in the background. The swap into the live
// hub/ folder only happens later, and only when there's no active trip — never mid-route.
// See bootGuard.js for the crash-loop rollback that runs on the *next* boot if a bad version
// fails to start.

const INSTALL_ROOT = process.env.HUB_INSTALL_ROOT || null;
const SERVICE_NAME = 'AdKeralaHub'; // must match scripts/install-service.js / setup-auto-update.js
// Overridable for testing a full check/apply cycle without waiting the real-world cadence.
const CHECK_INTERVAL_MS = Number(process.env.HUB_UPDATE_CHECK_INTERVAL_MS) || 30 * 60 * 1000;
const APPLY_CHECK_INTERVAL_MS = Number(process.env.HUB_UPDATE_APPLY_INTERVAL_MS) || 5 * 60 * 1000;
const INITIAL_CHECK_DELAY_MS = Number(process.env.HUB_UPDATE_INITIAL_DELAY_MS) || 10 * 1000;

function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function restartService() {
  // Detached so it survives this process exiting/being killed by "net stop" — a Windows service
  // stopping itself mid-command wouldn't reliably run the following "net start" otherwise.
  const child = spawn('cmd', ['/c', `timeout /t 2 /nobreak >nul & net stop ${SERVICE_NAME} & net start ${SERVICE_NAME}`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function start(hubAppDir) {
  if (!INSTALL_ROOT) return; // dev/mock checkout — auto-update is entirely opt-in

  const RELEASES_DIR = path.join(INSTALL_ROOT, 'hub-releases');
  if (!fs.existsSync(RELEASES_DIR)) fs.mkdirSync(RELEASES_DIR, { recursive: true });
  const localVersion = require(path.join(hubAppDir, 'package.json')).version;

  async function checkForUpdate() {
    let manifest;
    try {
      const res = await fetch(`${CLOUD_HTTP_BASE}/api/hub-releases/latest`);
      if (!res.ok) return;
      manifest = await res.json();
    } catch (err) {
      return; // offline — never surfaced anywhere, just retried next tick
    }
    if (!manifest.version || compareVersions(manifest.version, localVersion) <= 0) return;

    const stagedDir = path.join(RELEASES_DIR, `staged-${manifest.version}`);
    if (fs.existsSync(path.join(stagedDir, 'package.json'))) return; // already staged

    const zipPath = path.join(RELEASES_DIR, `${manifest.version}.zip`);
    try {
      console.log(`[updateAgent] downloading v${manifest.version}…`);
      state.update({ updating: true }); // Display's status bar shows "Updating…" while this runs
      const res = await fetch(`${CLOUD_HTTP_BASE}/api/hub-releases/${manifest.version}/download`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));

      const actualChecksum = sha256File(zipPath);
      if (actualChecksum !== manifest.checksum_sha256) {
        throw new Error(`checksum mismatch (expected ${manifest.checksum_sha256}, got ${actualChecksum})`);
      }

      fs.rmSync(stagedDir, { recursive: true, force: true });
      new AdmZip(zipPath).extractAllTo(stagedDir, true);
      fs.unlinkSync(zipPath);
      console.log(`[updateAgent] v${manifest.version} staged and verified — will apply next time the bus is idle`);
    } catch (err) {
      console.error(`[updateAgent] failed to stage v${manifest.version}:`, err.message);
      fs.rmSync(zipPath, { force: true });
      fs.rmSync(stagedDir, { recursive: true, force: true });
    } finally {
      state.update({ updating: false });
    }
  }

  function findStagedVersion() {
    const entries = fs.readdirSync(RELEASES_DIR).filter((name) => name.startsWith('staged-'));
    const versions = entries.map((name) => name.slice('staged-'.length));
    return versions.sort(compareVersions).pop() || null;
  }

  function applyIfIdle() {
    const newVersion = findStagedVersion();
    if (!newVersion) return;
    if (state.trip) return; // never swap out from under a live trip

    console.log(`[updateAgent] idle — applying v${newVersion} now`);
    const stagedDir = path.join(RELEASES_DIR, `staged-${newVersion}`);
    const rollbackDir = path.join(RELEASES_DIR, `rollback-${localVersion}`);

    try {
      // Only one rollback generation is kept — bound disk usage on a small volume.
      for (const name of fs.readdirSync(RELEASES_DIR)) {
        if (name.startsWith('rollback-')) fs.rmSync(path.join(RELEASES_DIR, name), { recursive: true, force: true });
      }

      fs.renameSync(hubAppDir, rollbackDir);
      fs.renameSync(stagedDir, hubAppDir);

      const updateState = readState(INSTALL_ROOT, localVersion);
      updateState.previousVersion = localVersion;
      updateState.currentVersion = newVersion;
      writeState(INSTALL_ROOT, updateState);

      console.log(`[updateAgent] applied v${newVersion} — restarting service`);
      restartService();
    } catch (err) {
      console.error('[updateAgent] failed to apply staged update:', err.message);
    }
  }

  setTimeout(checkForUpdate, INITIAL_CHECK_DELAY_MS); // small delay so this never competes with initial boot
  setInterval(checkForUpdate, CHECK_INTERVAL_MS);
  setInterval(applyIfIdle, APPLY_CHECK_INTERVAL_MS);
}

module.exports = { start };
