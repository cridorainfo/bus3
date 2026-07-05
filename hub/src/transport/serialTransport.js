const EventEmitter = require('events');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { getDeviceConfig } = require('../config/deviceConfig');

const SCAN_INTERVAL_MS = 2000; // short enough that plugging the board in feels instant
const BAUD_RATE = 115200;

// Fallback auto-detection: every USB-serial bridge chip an ESP32 dev board or Arduino Uno
// plausibly shows up as. The explicitly configured VID/PID (env var or device_config) always
// wins if that exact device is present — this list only kicks in when it isn't, so a bench
// setup (e.g. an Uno standing in for the ESP32) connects with zero configuration. pid: null
// means "any product from this vendor".
const KNOWN_USB_SERIAL = [
  { vid: '10C4', pid: 'EA60' }, // Silicon Labs CP210x — most ESP32 dev boards
  { vid: '1A86', pid: '7523' }, // WCH CH340 — ESP32/Uno clones
  { vid: '1A86', pid: '55D4' }, // WCH CH9102 — newer ESP32 boards
  { vid: '0403', pid: null },   // FTDI — many adapters/older boards
  { vid: '2341', pid: null },   // Arduino (genuine, e.g. Uno R3 2341:0043)
  { vid: '2A03', pid: null },   // Arduino (older arduino.org boards)
  { vid: '067B', pid: '2303' }, // Prolific PL2303 adapters
];

// Real ESP32 transport (spec 3.2): never hardcode a COM port. Identify the device by
// USB VID/PID and re-scan on a timer so a bumped cable / different USB socket / brown-out
// reboot recovers automatically without any human action. Trip state itself is held by the
// engine layer (not here), so a reconnect gap never loses progress — this module only owns
// finding and re-finding the device.
class SerialTransport extends EventEmitter {
  constructor() {
    super();
    this._port = null;
    this._connectedPath = null;
    this._connected = false;
    this._scanTimer = setInterval(() => this._scanAndConnect(), SCAN_INTERVAL_MS);
    this._scanAndConnect();
  }

  _getTargetVidPid() {
    const cfg = getDeviceConfig();
    return {
      vid: (process.env.HUB_ESP32_VID || (cfg && cfg.esp32_vid) || '10C4').toUpperCase(),
      pid: (process.env.HUB_ESP32_PID || (cfg && cfg.esp32_pid) || 'EA60').toUpperCase(),
    };
  }

  async _scanAndConnect() {
    if (this._connected) return; // already have a good connection; scanning resumes if it drops
    try {
      const { vid, pid } = this._getTargetVidPid();
      const ports = await SerialPort.list();

      // The explicitly configured device first; failing that, anything recognizable as a
      // USB-serial bridge (see KNOWN_USB_SERIAL) — so an Uno bench rig or a board with a
      // different bridge chip connects instantly without editing env vars/device_config.
      const match =
        ports.find((p) => (p.vendorId || '').toUpperCase() === vid && (p.productId || '').toUpperCase() === pid) ||
        ports.find((p) =>
          KNOWN_USB_SERIAL.some(
            (k) => (p.vendorId || '').toUpperCase() === k.vid && (k.pid === null || (p.productId || '').toUpperCase() === k.pid)
          )
        );
      if (!match) return; // not found this cycle, try again next tick — no error surfaced to the driver

      this._connectToPath(match.path);
    } catch (err) {
      // Listing ports failed (rare/OS-level) — stay silent to the driver, just retry next tick.
    }
  }

  _connectToPath(path) {
    const port = new SerialPort({ path, baudRate: BAUD_RATE }, (err) => {
      if (err) return; // will retry on the next scan tick
    });
    const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

    port.on('open', () => {
      this._port = port;
      this._connectedPath = path;
      this._connected = true;
      this.emit('status', { connected: true, reason: 'connected', path });
    });

    parser.on('data', (line) => this._handleLine(line));

    const handleDisconnect = (reason) => {
      if (!this._connected && this._connectedPath !== path) return;
      this._connected = false;
      this._port = null;
      this._connectedPath = null;
      this.emit('status', { connected: false, reason });
      // Next scan tick will look for the device again, on this port or any other.
    };

    port.on('close', () => handleDisconnect('port_closed'));
    port.on('error', () => handleDisconnect('port_error'));
  }

  _handleLine(rawLine) {
    const line = rawLine.trim();
    if (!line) return;

    if (line.startsWith('HB,')) {
      const uptimeMs = Number(line.slice(3));
      this.emit('heartbeat', { uptimeMs: Number.isFinite(uptimeMs) ? uptimeMs : 0 });
      return;
    }

    const signal = Number(line);
    if ([0, 1, 2, 3].includes(signal)) {
      if (signal !== 0) this.emit('signal', { signal });
    }
  }

  isConnected() {
    return this._connected;
  }
}

module.exports = SerialTransport;
