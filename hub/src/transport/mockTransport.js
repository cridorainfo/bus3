const EventEmitter = require('events');

// Simulated ESP32 for development without physical hardware. Driven by the /debug/signal API
// and the sim page (public/sim), not by anything automatic — a human (or the sim page's buttons)
// plays the role of the push switches / cable being unplugged.
class MockTransport extends EventEmitter {
  constructor() {
    super();
    this._connected = true;
    this._uptimeStart = Date.now();
    this._heartbeatTimer = setInterval(() => {
      if (!this._connected) return;
      this.emit('heartbeat', { uptimeMs: Date.now() - this._uptimeStart });
    }, 5000);
    // Fire one heartbeat right away so status reflects "connected" immediately on boot.
    setImmediate(() => {
      if (this._connected) this.emit('heartbeat', { uptimeMs: 0 });
    });
  }

  injectSignal(signal) {
    if (![0, 1, 2, 3].includes(signal)) return;
    if (!this._connected) return; // a truly unplugged device can't send signals either
    this.emit('signal', { signal });
  }

  // Simulates the cable being pulled — heartbeat stops, watchdog should notice within ~15s.
  goStale() {
    this._connected = false;
    this.emit('status', { connected: false, reason: 'simulated_unplug' });
  }

  // Simulates plugging back in, possibly "on a different port" (irrelevant for the mock beyond
  // resetting uptime, since there's no real port to change) — watchdog should pick this back up.
  reconnect() {
    this._connected = true;
    this._uptimeStart = Date.now();
    this.emit('status', { connected: true, reason: 'simulated_replug' });
  }

  isConnected() {
    return this._connected;
  }
}

module.exports = MockTransport;
