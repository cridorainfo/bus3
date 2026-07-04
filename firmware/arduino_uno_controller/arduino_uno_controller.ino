/*
 * AdKerala Arduino Uno Controller — physical button test rig
 *
 * Same protocol/logic as firmware/esp32_controller/esp32_controller.ino (event relay only —
 * debounced digitalRead + heartbeat, no trip/playback logic here), just Uno-valid pins and the
 * buttons named to match what's physically wired: Forward / Undo / Announcement. The Hub's
 * serialTransport.js treats signal 3 identically whether the button is labeled "Replay" or
 * "Announcement" — it just repeats the current stop's announcement.
 *
 * Protocol (matches hub/src/transport/serialTransport.js):
 *   "1\n"          Forward pressed
 *   "2\n"          Undo pressed
 *   "3\n"          Announcement pressed (repeat current stop's announcement)
 *   "HB,<millis>\n" heartbeat, every 5000ms
 *
 * Baud rate: 115200 (must match BAUD_RATE in serialTransport.js).
 *
 * Wiring: one leg of each push button to the pin below, the other leg to GND. No external
 * resistor needed — INPUT_PULLUP is used, so an unpressed button reads HIGH and a press pulls
 * it LOW. Pins 0/1 are reserved for the Uno's hardware serial (USB) — do not use them.
 */

const int PIN_FORWARD = 2;
const int PIN_UNDO = 3;
const int PIN_ANNOUNCEMENT = 4;

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
  { PIN_ANNOUNCEMENT, 3, HIGH, HIGH, 0 },
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
