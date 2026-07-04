# AdKerala Local Hub — Phase 1 (+ sample Phase 2 sync)

Implements spec Section 17 Phase 1 ("Core Offline Loop, Zero-Touch Operation") from
`../AdKerala_Developer_Spec.md`: the fully offline bus hub — ESP32 protocol + reconnect
watchdog, trip lifecycle, playback engine, passenger display, control panel — plus a sample
of Phase 2's sync engine (`src/sync/syncAgent.js`) that talks to the `../cloud/` cloud-lite
server and admin dashboard. No ad budget pacing / owner dashboard yet — those are Phases 3-4.

**Route direction**: a trip is started as either "Going" or "Coming Back" (Control Panel
segmented toggle). Both directions walk the same stop list — "Coming Back" just walks it in
reverse — so there's only ever one stop list per route to manage, in the admin or locally.

**Announcement composition**: every stop plays `chime → filler → stop_name → outro` — `chime`/
`filler`/`outro` are shared, global clips; `filler` is the common phrase spoken at every stop
(e.g. "next stop is..."). When a stop's Ads toggle is on **and** a `stop_name_ad` clip has been
uploaded for it, that combined "stop name + sponsor" clip swaps in for the plain `stop_name` —
see `composeAnnouncement` in `src/engine/playbackEngine.js`.

**Stops are global**, not owned by one route — `route_stops` links a stop into a route's order,
so the same physical stop (and its recorded audio) can be shared across routes without
duplicating anything. See the Admin's Routes tab "find or link a stop" search.

**Multi-route buses + identity**: a bus can be assigned several routes; the driver/conductor
picks which is active from the Control Panel, entirely locally (no cloud round-trip). The Hub
itself pairs to the cloud like a smart TV — it generates and displays its own short **pairing
ID** on the Display View (its only screen; there's no keyboard at an unattended kiosk PC), an
admin reads that ID and claims it from the Admin dashboard. Phones connect to the Control Panel
separately, with a persistent **connect code** that keeps them paired until they disconnect or
an admin disconnects everyone — see "Pairing this Hub to the cloud" below.

## Quick start (dev, no hardware needed)

```
cd hub
npm install
npm run gen-audio      # writes placeholder WAV tones to assets/audio/ (not real recordings)
HUB_TRANSPORT=mock npm start
```

Open in a browser:
- `http://localhost:3000/panel/` — Control Panel (phone UI)
- `http://localhost:3000/display/` — Display View (open this on a second tab/window; it's
  built for a 1920x1080 kiosk canvas). Shows this Hub's pairing ID until it's paired — see below.
- `http://localhost:3000/sim/` — ESP32 Simulator (stands in for the push switches and cable)

Seeded demo data: a local route `R1` (Kochi–Thrissur, 6 stops) — but **no bus identity** until
you pair it (see below). `HUB_BUS_ID`/`HUB_REG_NUMBER`/`HUB_CLOUD_API_KEY` env vars remain a
dev-only shortcut that bypasses pairing entirely (see `src/db/seed.js`). Delete `data/hub.db` to
reset everything and start unpaired again.

## Running against real hardware

Set `HUB_TRANSPORT=serial` (this is what `scripts/install-service.js` configures). The Hub
scans `SerialPort.list()` for a device matching `device_config.esp32_vid` /
`esp32_pid` (defaults to a common USB-serial chip's IDs — override via `HUB_ESP32_VID`
/ `HUB_ESP32_PID` env vars or by editing the seeded `device_config` row to match your actual
board) — never a hardcoded COM port, per spec 3.2.

Flash `../firmware/esp32_controller/esp32_controller.ino` to the ESP32 first. Bench-testing with
an Arduino Uno instead? Use `../firmware/arduino_uno_controller/arduino_uno_controller.ino` —
same protocol, Uno-valid pins — see `../DEPLOYMENT.md` Part 2.4a for wiring and VID/PID lookup.

## The reconnect test (spec Open Question 1 — the most safety-critical item in the spec)

With real hardware: start a trip, advance a couple of stops, then physically unplug the
ESP32 mid-operation and plug it into a **different** USB port. Confirm the Hub reconnects
within a few seconds with no restart and no lost trip progress.

Without hardware, the `/sim/` page's "Simulate unplug" / "Simulate replug" buttons exercise
the same code path (`transport 'status' events` -> `watchdog.js` -> fault logged, trip state
held in `engine/state.js` untouched throughout).

## Pairing this Hub to the cloud

A fresh (or freshly reinstalled) Hub has no bus identity — `device_config` is empty,
`src/sync/pairingAgent.js` generates a short pairing ID and shows it on the Display View (the
Hub's only screen — no keyboard, nothing is ever typed here), and `src/sync/syncAgent.js` just
waits. Like pairing a smart TV: the admin reads the ID off the screen and links it to a bus from
the dashboard, not the other way around.

1. Start the cloud server (`cd ../cloud && npm install && npm start`), start this Hub, and open
   its Display View (`http://localhost:3000/display/`) — it shows a 6-character pairing ID.
2. In the cloud's Admin (`http://localhost:4000/admin/`), Buses tab, use the **Pair a Bus** card:
   enter that ID and pick which bus record it should link to (add the bus first if it doesn't
   exist yet). The Hub polls every ~4s and picks up the claim automatically — no restart needed.
3. **If this Hub's disk is later wiped and reinstalled**, it'll show a *new* pairing ID — claim
   that one against the *same* bus in Admin (the cloud rotates the api_key, so the old one on
   the lost disk stops working), and every route/stop/content assigned to that bus re-downloads
   automatically.

If the cloud is offline or unreachable, none of this blocks anything — the Hub (paired or not)
keeps working exactly as in Phase 1, offline-first; both agents just retry with backoff.

Override the cloud location with `HUB_CLOUD_URL`/`HUB_CLOUD_HTTP` env vars (default
`ws://localhost:4000/hub-sync`).

## Known Phase 1 simplifications (intentional, documented trade-offs)

- **Audio plays in the browser, not natively in Node.** The kiosk Chrome instance already
  owns the PC's single aux output (spec 3.4); the server just tells it what to play over
  WebSocket.
- **Sequential audio playback, not pre-concatenation** (spec 11.5 allows either). Avoids an
  ffmpeg/audio-processing dependency; revisit if inter-segment gaps become a real issue.
- **`campaign_quotas` / `billable` columns exist in the schema but are inert** — every
  campaign is treated as having unlimited quota until the Phase 3 Pacing Engine exists.
- **No sync engine, no cloud.** `synced` flags exist on every table for Phase 2 to use; the
  Hub never blocks on a network call because there isn't one yet.
- **Device pairing model**: a persistent connect code (admin-set, not daily) pairs a phone once;
  it then stays connected — via a token in the browser's `localStorage` — until it disconnects
  or an admin disconnects every device on the bus. No per-action PIN prompts. See
  `src/api/routes/auth.js` and `public/panel/app.js`.

## Deploying on the actual PC (once hardware is available)

See `../DEPLOYMENT.md` for the full walkthrough (Windows prep, pairing, ESP32 flashing,
Windows service + kiosk, and an end-to-end test checklist). Short version:

1. `npm install` (add `node-windows` too: `npm install node-windows`, Windows-only)
2. `npm run gen-audio` (or copy real recorded segments into `assets/audio/` with matching
   `content_items.file_path` values)
3. `node scripts/install-service.js` — registers + starts the Windows service (auto-restart
   on crash, no login required)
4. Put a shortcut to `scripts/start-kiosk.bat` in the Startup folder (`shell:startup`) so the
   Display View launches full-screen on every boot
5. On first boot the Display View shows this Hub's pairing ID — read it off the kiosk screen and
   claim it from Admin's "Pair a Bus" card (see "Pairing this Hub to the cloud" above); no
   further action is needed at the PC itself

## Directory map

```
src/db/          SQLite schema + seed data
src/transport/    mock + real serial transports, common interface, heartbeat watchdog
src/engine/       trip lifecycle, playback/announcement composition, ad rotation
src/realtime/     WebSocket state broadcast (spec 4.2 multi-session live state)
src/sync/         cloud-lite sync agent + pairingAgent.js (generates/polls this Hub's pairing ID)
src/api/routes/   trip actions, status, phone connect/disconnect auth, pairing status, mock-only debug endpoints
public/display/   kiosk Display View (pairing ID screen when unpaired; route progress strip + ad/audio playback once paired)
public/panel/     phone Control Panel (connect-once device pairing, no PIN)
public/sim/       ESP32 Simulator (mock mode only)
```
