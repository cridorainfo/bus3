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

const authRoutes = require('./api/routes/auth');
const tripRoutes = require('./api/routes/trip');
const createStatusRouter = require('./api/routes/status');
const createDebugRouter = require('./api/routes/debug');

const PORT = Number(process.env.HUB_PORT || 3000);
const TRANSPORT_MODE = (process.env.HUB_TRANSPORT || 'mock').toLowerCase();

const app = express();
app.use(express.json());

// Static frontends — plain HTML/CSS/JS per spec's "deliberately light" recommendation.
app.use('/display', express.static(path.join(__dirname, '..', 'public', 'display')));
app.use('/panel', express.static(path.join(__dirname, '..', 'public', 'panel')));
app.use('/audio', express.static(path.join(__dirname, '..', 'assets', 'audio')));
app.use('/media', express.static(path.join(__dirname, '..', 'assets', 'media')));

if (TRANSPORT_MODE === 'mock') {
  app.use('/sim', express.static(path.join(__dirname, '..', 'public', 'sim')));
}

app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html><html><body style="font-family:sans-serif">
    <h1>AdKerala Local Hub</h1>
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
app.use('/api/auth', authRoutes.router);
app.use('/api/trip', tripRoutes);
app.use('/api/status', createStatusRouter(watchdog));
if (TRANSPORT_MODE === 'mock') {
  app.use('/debug', createDebugRouter(transport));
}

const server = http.createServer(app);
stateBus.attach(server);

server.listen(PORT, () => {
  console.log(`[hub] AdKerala Local Hub listening on http://localhost:${PORT} (transport=${TRANSPORT_MODE})`);
});

// Offline-first, unchanged: if the cloud is unreachable, this just retries in the background —
// every trip/playback/display function above already works with zero network connectivity.
syncAgent.start();
