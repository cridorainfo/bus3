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
  built for a 1920x1080 kiosk canvas)
- `http://localhost:3000/sim/` — ESP32 Simulator (stands in for the push switches and cable)

Seeded demo data: bus `HUB-DEV-01` / reg `KL07AX1234`, route `R1` (Kochi–Thrissur, 6 stops),
today's shared PIN is **1234**. Delete `data/hub.db` to reset and re-seed.

## Running against real hardware

Set `HUB_TRANSPORT=serial` (this is what `scripts/install-service.js` configures). The Hub
scans `SerialPort.list()` for a device matching `device_config.esp32_vid` /
`esp32_pid` (defaults to a common USB-serial chip's IDs — override via `HUB_ESP32_VID`
/ `HUB_ESP32_PID` env vars or by editing the seeded `device_config` row to match your actual
board) — never a hardcoded COM port, per spec 3.2.

Flash `../firmware/esp32_controller/esp32_controller.ino` to the ESP32 first.

## The reconnect test (spec Open Question 1 — the most safety-critical item in the spec)

With real hardware: start a trip, advance a couple of stops, then physically unplug the
ESP32 mid-operation and plug it into a **different** USB port. Confirm the Hub reconnects
within a few seconds with no restart and no lost trip progress.

Without hardware, the `/sim/` page's "Simulate unplug" / "Simulate replug" buttons exercise
the same code path (`transport 'status' events` -> `watchdog.js` -> fault logged, trip state
held in `engine/state.js` untouched throughout).

## Cloud sync (sample Phase 2)

By default the Hub connects to `ws://localhost:4000/hub-sync` using bus id `HUB-DEV-01` and
api key `dev-demo-key` — matching `../cloud/`'s seeded demo bus, so running both services
locally just works. Override with `HUB_CLOUD_URL`, `HUB_CLOUD_HTTP`, `HUB_CLOUD_API_KEY`.

Start the cloud server (`cd ../cloud && npm install && npm start`), then in its Admin page
(`http://localhost:4000/admin/`) add a route with some stops and assign it to the bus — the
already-running Hub picks it up within a second or two, no restart, and downloads any
uploaded ad/audio content into `assets/`. If the cloud server is offline or unreachable, the
Hub keeps working exactly as in Phase 1 — the sync agent just retries with backoff in the
background and never blocks anything the driver/conductor does.

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
- **PIN model**: one shared numeric PIN per bus per day (spec's own stated default — flagged
  there as an open question). Change `db/seed.js` or the `daily_pin` table if you want to
  test per-person PINs instead.

## Deploying on the actual PC (once hardware is available)

See `../DEPLOYMENT.md` for the full walkthrough (Windows prep, env vars, ESP32 flashing,
Windows service + kiosk, and an end-to-end test checklist). Short version:

1. `npm install` (add `node-windows` too: `npm install node-windows`, Windows-only)
2. `npm run gen-audio` (or copy real recorded segments into `assets/audio/` with matching
   `content_items.file_path` values)
3. `node scripts/install-service.js` — registers + starts the Windows service (auto-restart
   on crash, no login required)
4. Put a shortcut to `scripts/start-kiosk.bat` in the Startup folder (`shell:startup`) so the
   Display View launches full-screen on every boot

## Directory map

```
src/db/          SQLite schema + seed data
src/transport/    mock + real serial transports, common interface, heartbeat watchdog
src/engine/       trip lifecycle, playback/announcement composition, ad rotation
src/realtime/     WebSocket state broadcast (spec 4.2 multi-session live state)
src/sync/         cloud-lite sync agent (pulls route/content, reports trips/play_logs)
src/api/routes/   trip actions, status, PIN auth, mock-only debug endpoints
public/display/   kiosk Display View (route progress strip + ad/audio playback)
public/panel/     phone Control Panel
public/sim/       ESP32 Simulator (mock mode only)
```
