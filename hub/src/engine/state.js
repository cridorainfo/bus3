const EventEmitter = require('events');
const db = require('../db/db');
const { getDeviceConfig, getRouteName } = require('../config/deviceConfig');
const { currentFleetSettings } = require('../config/fleetSettings');

// Single in-memory live state, source of truth for what every connected phone/display sees
// right now (spec 4.2: "multiple phones, one live state"). Persisted facts (trips, play_logs,
// etc.) live in SQLite; this is just the current snapshot pushed over the state bus.
class HubState extends EventEmitter {
  constructor() {
    super();
    const cfg = getDeviceConfig();
    this.bus = cfg
      ? { bus_id: cfg.bus_id, reg_number: cfg.reg_number, friendly_name: cfg.friendly_name, route_assigned: cfg.route_assigned, route_name: getRouteName(cfg.route_assigned) }
      : { bus_id: null, reg_number: 'Not paired', friendly_name: null, route_assigned: null, route_name: null };
    this.trip = null; // { trip_id, route_id, start_time, current_stop_index, started_via }
    this.esp32 = { connected: false, lastHeartbeatAt: null };
    this.muted = false;
    this.lastForwardAt = 0;
    this.lastFault = null;
    this.nowPlaying = null; // composed segment sequence currently pushed to the display
    this.contentVersion = 0; // bumped by syncAgent whenever route/stop/content data changes
    this.pairingId = null; // set by pairingAgent while unpaired — Display View shows this on screen
    this.connectedDeviceCount = db.prepare('SELECT COUNT(*) c FROM paired_devices').get().c;
    this.cloudOnline = false; // true only while syncAgent has an accepted cloud connection — drives the Display's Online/No Internet pill
    this.updating = false; // true while updateAgent is downloading/staging a release — drives the Display's Updating pill
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
      pairingId: this.pairingId,
      connectedDeviceCount: this.connectedDeviceCount,
      cloudOnline: this.cloudOnline,
      updating: this.updating,
      settings: currentFleetSettings(),
    };
  }

  update(partial) {
    Object.assign(this, partial);
    this.emit('change', this.snapshot());
  }

  // Called anywhere paired_devices changes (auth.js's connect/disconnect, syncAgent's
  // admin-disconnect-all reconciliation) so the Display View's QR-vs-normal-view decision stays
  // live without polling.
  refreshConnectedDeviceCount() {
    this.update({ connectedDeviceCount: db.prepare('SELECT COUNT(*) c FROM paired_devices').get().c });
  }
}

module.exports = new HubState();
