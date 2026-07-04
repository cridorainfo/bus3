// Common transport interface — the rest of the Hub never knows whether it's talking to a real
// ESP32 over serial or the mock simulator. Both implementations are EventEmitters that emit:
//   'signal'      { signal: 0|1|2|3 }         — edge-triggered button press
//   'heartbeat'   { uptimeMs }                 — every ~5s while connected
//   'status'      { connected: bool, reason }  — connection state changes (for status.js / dashboard)
//
// Swap via HUB_TRANSPORT=mock|serial (default mock, since most dev machines have no ESP32 attached).

function createTransport() {
  const mode = (process.env.HUB_TRANSPORT || 'mock').toLowerCase();
  if (mode === 'serial') {
    const SerialTransport = require('./serialTransport');
    return new SerialTransport();
  }
  const MockTransport = require('./mockTransport');
  return new MockTransport();
}

module.exports = { createTransport };
