// Pre-registers the same demo bus the Hub already seeds locally (hub/src/db/seed.js), with no
// route assigned yet — so the Admin walkthrough of "add a route, assign it, watch the bus pick
// it up live" works immediately without any manual ID matching.

const db = require('./db');

function seed() {
  const busId = process.env.CLOUD_DEMO_BUS_ID || 'HUB-DEV-01';
  const existing = db.prepare('SELECT bus_id FROM buses WHERE bus_id = ?').get(busId);
  if (existing) return;

  db.prepare(`
    INSERT INTO buses (bus_id, reg_number, api_key, tier, hardware_version, route_id)
    VALUES (?, ?, ?, ?, ?, NULL)
  `).run(busId, 'KL07AX1234', process.env.CLOUD_DEMO_API_KEY || 'dev-demo-key', 'urban_standard', 'v1');

  console.log(`[seed] Registered demo bus ${busId} (no route assigned yet)`);
}

module.exports = seed;
