const EventEmitter = require('events');
const { busId, getDeviceConfig, getRouteName } = require('../config/deviceConfig');

// Single in-memory live state, source of truth for what every connected phone/display sees
// right now (spec 4.2: "multiple phones, one live state"). Persisted facts (trips, play_logs,
// etc.) live in SQLite; this is just the current snapshot pushed over the state bus.
class HubState extends EventEmitter {
  constructor() {
    super();
    const cfg = getDeviceConfig();
    this.bus = cfg
      ? { bus_id: cfg.bus_id, reg_number: cfg.reg_number, route_assigned: cfg.route_assigned, route_name: getRouteName(cfg.route_assigned) }
      : { bus_id: busId, reg_number: 'UNKNOWN', route_assigned: null, route_name: null };
    this.trip = null; // { trip_id, route_id, start_time, current_stop_index, started_via }
    this.esp32 = { connected: false, lastHeartbeatAt: null };
    this.muted = false;
    this.lastForwardAt = 0;
    this.lastFault = null;
    this.nowPlaying = null; // composed segment sequence currently pushed to the display
    this.contentVersion = 0; // bumped by syncAgent whenever route/stop/content data changes
  }

  snapshot() {
    return {
      bus: this.bus,
      trip: this.trip,
      esp32: this.esp32,
      muted: this.muted,
      lastFault: this.lastFault,
      nowPlaying: this.nowPlaying,
      contentVersion: this.contentVersion,
    };
  }

  update(partial) {
    Object.assign(this, partial);
    this.emit('change', this.snapshot());
  }
}

module.exports = new HubState();
