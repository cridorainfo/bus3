// Packages this Hub checkout into a release bundle for Admin's Updates tab (see
// cloud/src/api/routes/hubReleases.js + src/sync/updateAgent.js). Run this AFTER bumping the
// version in package.json and testing your changes locally.
//
// IMPORTANT: run this on a machine matching the target bus PCs' architecture (Windows x64,
// same Node major version) — better-sqlite3 and serialport are native modules, and the zip
// bundles whatever's currently in node_modules/ as-is (no npm install is run for you here, so
// make sure `npm install` reflects exactly what you want shipped before running this).
//
// Usage: node scripts/build-release.js

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const HUB_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(HUB_DIR, 'dist');

const pkg = JSON.parse(fs.readFileSync(path.join(HUB_DIR, 'package.json'), 'utf8'));
const version = pkg.version;

// Everything needed to run standalone — excludes dev-only / local-state directories that must
// never ship (data/ is this specific PC's live database; dist/ is this script's own output).
const EXCLUDE_DIRS = new Set(['data', 'dist', '.git', 'node_modules/.cache']);

if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });
const outPath = path.join(DIST_DIR, `hub-release-${version}.zip`);
if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

console.log(`[build-release] packaging v${version} from ${HUB_DIR}…`);

const zip = new AdmZip();
for (const entry of fs.readdirSync(HUB_DIR)) {
  if (EXCLUDE_DIRS.has(entry)) continue;
  const full = path.join(HUB_DIR, entry);
  if (fs.statSync(full).isDirectory()) {
    zip.addLocalFolder(full, entry);
  } else {
    zip.addLocalFile(full);
  }
}
zip.writeZip(outPath);

const checksum = crypto.createHash('sha256').update(fs.readFileSync(outPath)).digest('hex');
const sizeMb = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(1);

console.log(`[build-release] wrote ${outPath} (${sizeMb} MB)`);
console.log(`[build-release] version:  ${version}`);
console.log(`[build-release] sha256:   ${checksum}`);
console.log(`[build-release] Next: upload this zip in Admin's Updates tab (version "${version}"), then Publish it when ready to roll out.`);
