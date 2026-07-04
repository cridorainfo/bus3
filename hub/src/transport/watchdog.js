const db = require('../db/db');

const STALE_THRESHOLD_MS = 15000; // spec 3.1: missing heartbeat >15s = hardware fault
const CHECK_INTERVAL_MS = 5000;

// Wraps a transport and tracks heartbeat freshness regardless of whether it's the mock or the
// real serial transport. A stale heartbeat is logged (surfaced to the depot/admin dashboard via
// status.js) — it is never shown to the driver as an actionable error (spec 3.1), since there is
// nothing they can do about it beyond what they're already doing.
class Watchdog {
  constructor(transport) {
    this.transport = transport;
    this.lastHeartbeatAt = null;
    this.connected = false;
    this.lastFault = null;

    transport.on('heartbeat', () => {
      this.lastHeartbeatAt = Date.now();
      if (!this.connected) {
        this.connected = true;
        this._logFault('recovered');
      }
    });

    transport.on('status', ({ connected, reason }) => {
      if (!connected) {
        this.connected = false;
        this._logFault(reason || 'disconnected');
      }
    });

    this._checkTimer = setInterval(() => this._checkStale(), CHECK_INTERVAL_MS);
  }

  _checkStale() {
    if (this.lastHeartbeatAt === null) return; // never connected yet, nothing to call "stale"
    const age = Date.now() - this.lastHeartbeatAt;
    if (age > STALE_THRESHOLD_MS && this.connected) {
      this.connected = false;
      this._logFault('heartbeat_stale');
    }
  }

  _logFault(reason) {
    this.lastFault = { reason, at: new Date().toISOString() };
    // Minimal append-only fault trail via button_events (signal -1 reserved for fault markers)
    // so Fleet Health (Phase 2 admin dashboard) has something to sync up and display.
    try {
      db.prepare('INSERT INTO button_events (signal, timestamp) VALUES (-1, datetime(\'now\'))').run();
    } catch (e) {
      // never let logging a fault crash the Hub
    }
    console.warn(`[watchdog] ${reason} at ${this.lastFault.at}`);
  }

  getStatus() {
    return {
      connected: this.connected,
      lastHeartbeatAt: this.lastHeartbeatAt ? new Date(this.lastHeartbeatAt).toISOString() : null,
      lastFault: this.lastFault,
    };
  }
}

module.exports = Watchdog;
