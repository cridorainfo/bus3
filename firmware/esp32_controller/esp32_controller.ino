/*
 * AdKerala ESP32 Controller — Phase 1
 *
 * Event relay only (spec 3.1/16): reads three push switches (Forward/Undo/Replay), debounces
 * them in firmware, and emits a single-signal serial line (0-3) on state change, plus a
 * heartbeat every 5s. All real logic (trip lifecycle, playback, scheduling) lives on the Hub —
 * this firmware never decides anything beyond "which button, and is the machine still alive."
 *
 * Protocol (matches hub/src/transport/serialTransport.js):
 *   "0\n"          idle / no action (not actually sent — only 1/2/3 are emitted on press)
 *   "1\n"          Forward pressed
 *   "2\n"          Undo pressed
 *   "3\n"          Replay pressed
 *   "HB,<millis>\n" heartbeat, every 5000ms
 *
 * Baud rate: 115200 (must match BAUD_RATE in serialTransport.js).
 */

const int PIN_FORWARD = 25;
const int PIN_UNDO = 26;
const int PIN_REPLAY = 27;

const unsigned long DEBOUNCE_MS = 250;      // firmware-level debounce; the Hub applies its own
                                             // 2s duplicate-press suppression on top of this
const unsigned long HEARTBEAT_INTERVAL_MS = 5000;

struct Button {
  int pin;
  int signal;
  int lastReading;
  int stableState;
  unsigned long lastChangeAt;
};

Button buttons[] = {
  { PIN_FORWARD, 1, HIGH, HIGH, 0 },
  { PIN_UNDO, 2, HIGH, HIGH, 0 },
  { PIN_REPLAY, 3, HIGH, HIGH, 0 },
};
const int NUM_BUTTONS = sizeof(buttons) / sizeof(buttons[0]);

unsigned long lastHeartbeatAt = 0;

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < NUM_BUTTONS; i++) {
    pinMode(buttons[i].pin, INPUT_PULLUP); // switch pulls to GND when pressed
  }
}

void loop() {
  unsigned long now = millis();

  for (int i = 0; i < NUM_BUTTONS; i++) {
    Button &b = buttons[i];
    int reading = digitalRead(b.pin);

    if (reading != b.lastReading) {
      b.lastChangeAt = now;
      b.lastReading = reading;
    }

    if ((now - b.lastChangeAt) > DEBOUNCE_MS && reading != b.stableState) {
      b.stableState = reading;
      if (b.stableState == LOW) { // pressed (active-low)
        Serial.println(b.signal);
      }
    }
  }

  if (now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeatAt = now;
    Serial.print("HB,");
    Serial.println(now);
  }
}
