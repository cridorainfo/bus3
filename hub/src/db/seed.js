// Seeds a demo route so the system is runnable/demoable out of the box, and — only as an
// explicit dev/testing shortcut — a device identity from env vars, bypassing the pairing flow
// (src/api/routes/pairing.js). Real installs set no such env vars: device_config stays empty
// ("unpaired") until an admin claims this Hub's self-generated pairing ID from the Admin
// dashboard (see src/sync/pairingAgent.js, shown on the Display View).

const db = require('./db');

function seed() {
  // Route first: the dev-shortcut identity below now also mirrors R1 into assigned_routes,
  // which has a foreign key on routes — inserting it before R1 exists fails on a fresh DB.
  seedDemoRoute();
  seedDeviceIdentityFromEnv();
}

function seedDeviceIdentityFromEnv() {
  const busId = process.env.HUB_BUS_ID;
  if (!busId) return; // no shortcut requested — stay unpaired until the device-code flow pairs it

  const existingDevice = db.prepare('SELECT bus_id FROM device_config WHERE bus_id = ?').get(busId);
  if (existingDevice) return;

  db.prepare(`
    INSERT INTO device_config (bus_id, reg_number, api_key, route_assigned, hardware_version, esp32_vid, esp32_pid, last_sync_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(busId, process.env.HUB_REG_NUMBER || 'KL07AX1234', process.env.HUB_CLOUD_API_KEY || null, 'R1', 'v1', '10C4', 'EA60');

  // A real (cloud-synced) bus gets this via syncAgent's applySyncState; this dev shortcut skips
  // the cloud entirely, so it has to seed the same local mirror by hand — otherwise the Panel's
  // route picker (which reads from assigned_routes, not device_config.route_assigned) shows
  // "No routes assigned" despite a trip against R1 working fine underneath.
  db.prepare('INSERT OR IGNORE INTO assigned_routes (route_id) VALUES (?)').run('R1');
}

function seedDemoRoute() {
  const existingRoute = db.prepare('SELECT route_id FROM routes WHERE route_id = ?').get('R1');
  if (existingRoute) return; // already seeded

  db.prepare('INSERT INTO routes (route_id, name, name_ml, tier) VALUES (?, ?, ?, ?)')
    .run('R1', 'Kochi - Thrissur Express', 'കൊച്ചി - തൃശ്ശൂർ എക്സ്പ്രസ്', 'urban_standard');

  const stops = [
    ['S1', 'വൈറ്റില', 'Vyttila', 0],
    ['S2', 'അലുവ', 'Aluva', 1],
    ['S3', 'അങ്കമാലി', 'Angamaly', 2],
    ['S4', 'ചാലക്കുടി', 'Chalakudy', 3],
    ['S5', 'ഗുരുവായൂർ', 'Guruvayur', 4],
    ['S6', 'തൃശ്ശൂർ', 'Thrissur', 5],
  ];

  // Stops are global (route_stops links them to a route) — S1..S6 are just created under R1
  // here since this is the only route in a fresh install, but any of them could later be
  // linked into a second route via the Admin's stop search instead of being duplicated.
  const insertStop = db.prepare(`
    INSERT INTO stops (stop_id, route_id, name_ml, name_en, sequence_no, ads_enabled, announcement_template)
    VALUES (?, 'R1', ?, ?, ?, ?, 'chime,filler,stop_name')
  `);
  const insertRouteStop = db.prepare('INSERT INTO route_stops (route_id, stop_id, sequence_no) VALUES (?, ?, ?)');
  for (const [id, ml, en, seq] of stops) {
    // Give the 3rd stop the ads toggle switched on, to demo the stop_name -> stop_name_ad swap.
    const adsEnabled = seq === 2 ? 1 : 0;
    insertStop.run(id, ml, en, seq, adsEnabled);
    insertRouteStop.run('R1', id, seq);
  }

  const insertContent = db.prepare(`
    INSERT INTO content_items (content_id, type, file_path, duration_sec, tier, advertiser_id, campaign_id, route_id, stop_id, active_from, active_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertContent.run('chime-default', 'chime', '/audio/chime.wav', 1.5, null, null, null, null, null, null, null);
  insertContent.run('filler-default', 'filler', '/audio/filler.wav', 1.2, null, null, null, null, null, null, null);
  insertContent.run('outro-default', 'outro', '/audio/outro.wav', 1.0, null, null, null, null, null, null, null);

  for (const [id, , en, seq] of stops) {
    insertContent.run(`stopname-${id}`, 'stop_name', `/audio/stopname-${id}.wav`, 2.0, null, null, null, 'R1', id, null, null);
  }

  // Demo of the ads swap: S3 has ads_enabled=1 above, so this clip (stop name + sponsor line,
  // recorded together) plays instead of the plain stopname-S3 clip — see composeAnnouncement.
  insertContent.run('stopname-ad-S3', 'stop_name_ad', '/audio/stopname-ad-S3.wav', 3.0, 'urban_standard', 'demo-advertiser', 'demo-campaign-audio', 'R1', 'S3', null, null);

  insertContent.run('ad-video-demo-1', 'ad_video', '/media/ad-demo-1.mp4', 15, 'urban_standard', 'demo-advertiser', 'demo-campaign-video', 'R1', null, null, null);
  insertContent.run('ad-video-demo-2', 'ad_video', '/media/ad-demo-2.mp4', 15, 'urban_standard', 'demo-advertiser-2', 'demo-campaign-video-2', 'R1', null, null, null);
  insertContent.run('house-psa-1', 'ad_video', '/media/house-psa.mp4', 10, null, null, null, 'R1', null, null, null);

  console.log('[seed] Seeded demo route R1 (6 stops)');
}

module.exports = seed;
