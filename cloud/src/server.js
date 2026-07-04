const path = require('path');
const express = require('express');
const http = require('http');

const { ASSETS_DIR } = require('./config');

require('./db/db'); // applies schema before anything else touches the DB
const seed = require('./db/seed');
seed();

const hubSyncServer = require('./sync/hubSyncServer');
const busesRoutes = require('./api/routes/buses');
const routesRoutes = require('./api/routes/routes');
const contentRoutes = require('./api/routes/content');
const stopsRoutes = require('./api/routes/stops');
const pairingRoutes = require('./api/routes/pairing');
const hubReleasesRoutes = require('./api/routes/hubReleases');

// Railway (and most PaaS hosts) inject PORT and expect the app to bind to it — CLOUD_PORT
// still wins for local dev if both happen to be set.
const PORT = Number(process.env.CLOUD_PORT || process.env.PORT || 4000);

const app = express();
app.use(express.json());

app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));
app.use('/content', express.static(ASSETS_DIR));

app.get('/', (req, res) => res.redirect('/admin/'));

app.use('/api/buses', busesRoutes);
app.use('/api/routes', routesRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/stops', stopsRoutes);
app.use('/api/pair', pairingRoutes);
app.use('/api/hub-releases', hubReleasesRoutes);

// Multer file-type/size rejections land here as generic Express errors — surface them as JSON
// instead of an HTML stack trace, since this API is consumed by fetch() from the Admin SPA.
app.use((err, req, res, next) => {
  if (err) {
    console.error('[cloud] request error:', err.message);
    return res.status(400).json({ error: 'upload_failed', message: err.message });
  }
  next();
});

const server = http.createServer(app);
hubSyncServer.attach(server);

server.listen(PORT, () => {
  console.log(`[cloud] AdKerala cloud-lite server listening on http://localhost:${PORT} (admin: /admin/)`);
});
