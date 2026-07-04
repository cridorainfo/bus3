// Registers the Hub as a Windows service (spec 4.1/16): survives crashes, auto-restarts,
// starts with no login required. Run once on the deployment PC: `node scripts/install-service.js`
// Requires `node-windows` (Windows-only, not installed by default — see hub/README.md).

const path = require('path');

let Service;
try {
  ({ Service } = require('node-windows'));
} catch (e) {
  console.error('node-windows is not installed. Run: npm install node-windows');
  console.error('(Only needed on the actual deployment PC — not required for dev/mock testing.)');
  process.exit(1);
}

const svc = new Service({
  name: 'AdKeralaHub',
  description: 'AdKerala Local Hub — offline bus media system backend',
  script: path.join(__dirname, '..', 'src', 'server.js'),
  env: [
    { name: 'HUB_TRANSPORT', value: 'serial' }, // real hardware on the deployed bus
  ],
});

svc.on('install', () => {
  console.log('[install-service] Installed. Starting service...');
  svc.start();
});

svc.on('alreadyinstalled', () => {
  console.log('[install-service] Already installed.');
});

svc.on('start', () => {
  console.log('[install-service] Service started — AdKerala Hub is now running unattended.');
});

svc.install();
