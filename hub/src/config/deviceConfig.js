const db = require('../db/db');

const busId = process.env.HUB_BUS_ID || 'HUB-DEV-01';

function getDeviceConfig() {
  return db.prepare('SELECT * FROM device_config WHERE bus_id = ?').get(busId);
}

// Joins in the route's friendly name (not just its ID) for display in the Panel/Display
// identity banner — a non-technical driver/conductor should see "Kochi - Thrissur Express",
// not a raw route_id slug.
function getRouteName(routeId) {
  if (!routeId) return null;
  const route = db.prepare('SELECT name FROM routes WHERE route_id = ?').get(routeId);
  return route ? route.name : null;
}

module.exports = { busId, getDeviceConfig, getRouteName };
