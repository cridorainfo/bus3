const bootGuard = require('./bootGuard'); // must be first: a crash in any require below still counts as a failed boot

const path = require('path');
const express = require('express');
const http = require('http');

require('./db/db'); // ensures schema is applied before anything else touches the DB
const seed = require('./db/seed');
seed();

const state = require('./engine/state');
const tripEngine = require('./engine/tripEngine');
const playbackEngine = require('./engine/playbackEngine');
const { createTransport } = require('./transport/transport');
const Watchdog = require('./transport/watchdog');
const stateBus = require('./realtime/stateBus');
const syncAgent = require('./sync/syncAgent');
const pairingAgent = require('./sync/pairingAgent');
const updateAgent = require('./sync/updateAgent');
const { isPaired } = require('./config/deviceConfig');
const { ASSETS_DIR } = require('./config/paths');

const authRoutes = require('./api/routes/auth');
const tripRoutes = require('./api/routes/trip');
const createStatusRouter = require('./api/routes/status');
const createDebugRouter = require('./api/routes/debug');
const pairingRoutes = require('./api/routes/pairing');
const createPanelQrRouter = require('./api/routes/panelQr');

const PORT = Number(process.env.HUB_PORT || 3000);
const TRANSPORT_MODE = (process.env.HUB_TRANSPORT || 'mock').toLowerCase();

const app = express();
app.use(express.json());

// Static frontends — plain HTML/CSS/JS per spec's "deliberately light" recommendation.
app.use('/display', express.static(path.join(__dirname, '..', 'public', 'display')));
app.use('/panel', express.static(path.join(__dirname, '..', 'public', 'panel')));
app.use('/audio', express.static(path.join(ASSETS_DIR, 'audio')));
app.use('/media', express.static(path.join(ASSETS_DIR, 'media')));

if (TRANSPORT_MODE === 'mock') {
  app.use('/sim', express.static(path.join(__dirname, '..', 'public', 'sim')));
}

app.get('/', (req, res) => {
  // Pairing is now shown on the Display View itself (the Hub's only screen) — no separate
  // setup form, since there's no keyboard at an unattended kiosk PC to type into.
  const pairingNotice = isPaired()
    ? ''
    : `<p style="color:#ffb300">This Hub isn't paired to the cloud yet — open the <a href="/display/" style="color:#ffb300">Display View</a> to see its pairing ID, then enter it in the Admin dashboard. Everything below still works fully offline in the meantime.</p>`;
  res.type('html').send(`<!doctype html><html><body style="font-family:sans-serif">
    <h1>AdKerala Local Hub</h1>
    ${pairingNotice}
    <ul>
      <li><a href="/display/">Display View</a> (kiosk, FullHD)</li>
      <li><a href="/panel/">Control Panel</a> (phone)</li>
      ${TRANSPORT_MODE === 'mock' ? '<li><a href="/sim/">ESP32 Simulator (mock mode)</a></li>' : ''}
    </ul>
  </body></html>`);
});

// --- Transport + watchdog + engine wiring ---
const transport = createTransport();
const watchdog = new Watchdog(transport);

transport.on('heartbeat', () => {
  state.update({ esp32: { connected: true, lastHeartbeatAt: new Date().toISOString() } });
});
transport.on('status', ({ connected }) => {
  state.update({ esp32: { ...state.esp32, connected } });
});
transport.on('signal', ({ signal }) => {
  if (signal === 1) playbackEngine.handleForward();
  else if (signal === 2) playbackEngine.handleUndo();
  else if (signal === 3) playbackEngine.handleReplay();
  // signal 0 = idle, no action
});

tripEngine.startIdleAutoCloseChecker();
setInterval(() => playbackEngine.idleAdTick(), 60 * 1000);

// --- API routes ---
app.use('/api/pair', pairingRoutes);
app.use('/api/auth', authRoutes.router);
app.use('/api/trip', tripRoutes);
app.use('/api/status', createStatusRouter(watchdog));
app.use('/api/panel-qr.svg', createPanelQrRouter(PORT));
if (TRANSPORT_MODE === 'mock') {
  app.use('/debug', createDebugRouter(transport));
}

const server = http.createServer(app);
stateBus.attach(server);

server.listen(PORT, () => {
  console.log(`[hub] AdKerala Local Hub listening on http://localhost:${PORT} (transport=${TRANSPORT_MODE})`);
  bootGuard.markHealthy(); // confirms this version isn't crash-looping — no-op unless auto-updates are set up
});

// Offline-first, unchanged: if the cloud is unreachable, this just retries in the background —
// every trip/playback/display function above already works with zero network connectivity.
syncAgent.start();
pairingAgent.start(); // no-op if already paired; otherwise generates/shows a pairing ID and polls for a claim
updateAgent.start(path.join(__dirname, '..')); // no-op unless auto-updates are set up (HUB_INSTALL_ROOT)
