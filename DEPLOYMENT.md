# AdKerala — Deployment Guide

Two separate things to stand up:

1. **`cloud/`** — the admin dashboard + sync server. Goes on Railway (or any Node host).
2. **`hub/`** — the Local Hub. Goes on the actual PC installed on each bus.

They talk to each other over the internet (WebSocket `/hub-sync` + HTTPS for content downloads),
but the Hub is designed to keep working perfectly with zero connectivity — deploying the cloud
side first, then bringing buses online one at a time, is the natural order.

---

## Part 1 — Deploy `cloud/` to Railway

**Status: done for this project.** `cloud/` is deployed to the **`strong-liberation`** Railway
project, service **`cloud`**, at **`https://cloud-production-9b7b.up.railway.app`** — the Admin
Dashboard is live at `https://cloud-production-9b7b.up.railway.app/admin/` and `/hub-sync`
(`wss://`) has been confirmed working. One step is still outstanding — see 1.3. The commands
below are exactly what was run, via the Railway CLI (already logged in as `cridorainfo@gmail.com`),
so you can repeat this for another project/environment later.

### 1.1 Create the service

This is a monorepo (`hub/`, `cloud/`, `firmware/` in one repo), so the service was pointed at the
`cloud/` subtree specifically:

```
railway link -p strong-liberation      # picks the project (interactive: pick workspace/env)
railway add --service cloud            # creates an empty service named "cloud"
```

### 1.2 Environment variables

```
railway variables --service cloud --set "CLOUD_DB_PATH=/data/cloud.db" --set "CLOUD_ASSETS_DIR=/data/assets"
```
(On Windows Git Bash specifically, prefix with `MSYS_NO_PATHCONV=1` — otherwise Git Bash silently
rewrites `/data/...` into a local Windows path before Railway ever sees it.)

You do **not** need to set `PORT` / `CLOUD_PORT` — Railway injects `PORT` automatically and
`cloud/src/server.js` already honors it.

### 1.3 ⚠️ Add a persistent Volume — not done yet, do this before relying on any uploaded content

**This is the single most important step, and it's a manual dashboard action — the Railway CLI
has no command for it.** Railway's container filesystem is otherwise ephemeral: every redeploy
wipes it, so `data/cloud.db` (every route/bus/stop) and `assets/uploads/` (every ad/audio file)
would disappear on the next deploy without this.

In the Railway dashboard: **strong-liberation → cloud service → Settings → Volumes** → add a
volume, mount path `/data`. That's what `CLOUD_DB_PATH`/`CLOUD_ASSETS_DIR` above already point
into — no other config changes needed once it's mounted, just redeploy (`railway up cloud
--path-as-root --service cloud`) after adding it so the app restarts with the volume attached.

### 1.4 Deploying (and redeploying after changes)

From the repo root (not from inside `cloud/` — Railway's CLI upload root didn't reliably follow
`cd` in testing):
```
railway up cloud --path-as-root --service cloud --ci
```
`--path-as-root` tells Railway to treat `cloud/` as the build root instead of the whole repo
(otherwise Railpack can't detect a buildable app among `hub/`/`firmware/`/docs at the top level).

### 1.5 Domain

```
railway domain --service cloud
```
generated `https://cloud-production-9b7b.up.railway.app` — Railway's free HTTPS domain, no
further config. The `/hub-sync` WebSocket works over it as `wss://` automatically. A custom
domain is optional (**Settings → Networking → Custom Domain**) if you want one later.

### 1.6 First-time check

`https://cloud-production-9b7b.up.railway.app/admin/` shows the green/white Admin Dashboard with
one pre-registered demo bus (`HUB-DEV-01`, api key `dev-demo-key`). Add your real buses/routes
from here — but add the Volume (1.3) first, or anything entered before then is at risk on the
next deploy.

---

## Part 2 — Install the Hub on a bus PC (Windows)

This expands `hub/README.md`'s quick-start into what you actually do on the physical machine
bolted into the bus.

### 2.1 Prep the Windows PC

- Create a dedicated local Windows account for this and set it to **auto-login** (Settings →
  Accounts → Sign-in options, or `netplwiz` → uncheck "must enter a password").
- Disable sleep/screen-timeout (also handled by `scripts/start-kiosk.bat`, but worth setting at
  the OS level too: Settings → Power, set both to "Never").
- Turn off Windows Update auto-restarts during expected operating hours if possible (Group
  Policy or Settings → Update → Pause updates) — a mid-route reboot is exactly the kind of thing
  this system is built to never need.

### 2.2 Install Node.js and the app

1. Install [Node.js LTS](https://nodejs.org) for Windows.
2. Copy the `hub/` folder onto the PC (USB drive, or `git clone` if the PC has network access
   during setup).
3. Open a terminal in `hub/` and run:
   ```
   npm install
   npm install node-windows
   npm run gen-audio
   ```
   (`gen-audio` writes placeholder tones — replace files in `assets/audio/` with real recorded
   Malayalam announcements before going live; same filenames, or update `content_items` rows to
   match via the Admin's Content tab instead, which is the normal path once the cloud is wired up.)

### 2.3 Configure the cloud location, then pair this bus

Set these as **persistent system environment variables** (Windows: search "environment
variables" → Edit the system environment variables → Environment Variables → New, under System
variables so they survive the auto-login) — just the cloud location and hardware mode, no
per-bus secret to copy:

| Variable | Value |
|---|---|
| `HUB_CLOUD_URL` | `wss://cloud-production-9b7b.up.railway.app/hub-sync` |
| `HUB_CLOUD_HTTP` | `https://cloud-production-9b7b.up.railway.app` |
| `HUB_TRANSPORT` | `serial` (real hardware — leave unset/`mock` only for a test bench with no ESP32) |
| `HUB_ESP32_VID` / `HUB_ESP32_PID` | your ESP32 board's USB vendor/product ID, if different from the default (`10C4`/`EA60`) |

Then **pair the bus** — like pairing a smart TV, the PC generates and displays its own code;
nothing is ever typed at this PC (it has no keyboard at an unattended kiosk anyway):

1. On this PC, start the Hub (`npm start`, or once the service is installed in 2.5 it starts on
   its own) and open the Display View (`http://localhost:3000/display/`, or just look at the
   kiosk screen once it's set up). It shows a 6-character **pairing ID**.
2. In Admin's **Buses** tab, add the bus if you haven't, then use the **Pair a Bus** card: enter
   that pairing ID and pick this bus from the dropdown, then submit. The Hub polls the cloud
   every ~4 seconds and picks up the claim automatically — it exchanges the ID for a permanent
   `bus_id`/`api_key`, stores them locally, and starts syncing, with no restart and nothing
   further to do at the PC. The Display View switches from the pairing screen to the normal
   route/ads view once it's picked up.

**If this exact PC's disk is ever wiped and Windows/the Hub reinstalled**, it comes back
unpaired and displays a *new* pairing ID — redo step 2 against the *same* bus record (it
re-links to that bus, rotating the api_key so the old one on the wiped disk stops working), and
every route/stop/content assigned to that bus re-downloads automatically.

Also set the bus's **connect code** in the same Admin card (**Generate**/**Regenerate** under
Connect Code) — this is what the driver/conductor enters once on their phone's Control Panel
(see Part 3 of the driver-facing side in `hub/README.md`); it stays valid until you regenerate
it, unlike the one-time pairing ID above (which is single-use, per Hub install).

### 2.4 Flash the ESP32 and wire it up

Flash `firmware/esp32_controller/esp32_controller.ino` (Arduino IDE or `arduino-cli`) onto the
ESP32, wired to the three push switches per the pin comments at the top of that file. Plug it
into the PC via USB — no specific port required, the Hub finds it by VID/PID.

### 2.4a Testing with an Arduino Uno bench rig (before the ESP32 is wired into the bus)

If you're testing the physical buttons with a bare Arduino Uno on a bench first — a good idea
before committing to in-vehicle wiring — use `firmware/arduino_uno_controller/arduino_uno_controller.ino`
instead. Same protocol as the ESP32 sketch (Forward/Undo/Announcement + heartbeat); only the pin
numbers and the third button's name differ (physically it's labeled "Announcement," not
"Replay" — functionally identical: it repeats the current stop's announcement).

**Wiring** — one leg of each push button to the pin below, the other leg to GND. No external
resistor needed (the sketch uses `INPUT_PULLUP`, so unpressed reads HIGH, a press pulls LOW):

| Button | Uno digital pin |
|---|---|
| Forward | 2 |
| Undo | 3 |
| Announcement | 4 |

Pins 0/1 are the Uno's hardware serial (used for USB) — never wire a button there.

**Upload the sketch**: Arduino IDE → Tools → Board → "Arduino Uno" → Tools → Port → (select the
Uno's port) → Upload.

**Find the Uno's VID/PID** (Windows): plug it in, open Device Manager → Ports (COM & LPT) →
right-click the Uno's entry → Properties → Details tab → property "Hardware Ids". You'll see
something like `USB\VID_2341&PID_0043` (genuine Uno R3, ATmega16U2) or `USB\VID_1A86&PID_7523`
(common CH340-based clone) — the four hex digits after `VID_` and `PID_` are what you need.

**Point the Hub at it**:
```
HUB_TRANSPORT=serial
HUB_ESP32_VID=2341   (or 1A86 for a CH340 clone — use whatever Device Manager showed)
HUB_ESP32_PID=0043   (or 7523)
```
Then `npm start` in `hub/` and watch the console — you should see the watchdog connect within a
few seconds. Press each button and confirm (via `/panel/` or the Hub's logs) that Forward
advances the stop, Undo reverts it, and Announcement replays without changing the stop. Finish
with the same physical reconnect test as the ESP32: unplug the Uno mid-trip, plug it back in
(a different USB port is fine), and confirm the Hub reconnects with trip progress intact.

### 2.5 Install as a Windows service + kiosk

```
node scripts/install-service.js
```
This registers and starts the Hub as a Windows service (auto-restart on crash, no login
prompt). Then put a shortcut to `scripts/start-kiosk.bat` in the Startup folder
(Win+R → `shell:startup`) so the Display View launches full-screen on every boot.

Reboot the PC once, fully unattended, and confirm the kiosk Display View comes up on its own.

---

## Part 3 — End-to-end test checklist

Work through these on the real bus, in this order, before considering it live:

- [ ] **Service survives a reboot.** Power-cycle the PC; confirm the Hub service and kiosk
      Display View both come back with zero manual steps (spec's <60s boot-to-operational).
- [ ] **Phone reaches the Control Panel.** Connect a phone to the bus's own WiFi
      (`AdKerala-<reg-number>` SSID) and open `http://<pc-ip>:3000/panel/`. Confirm the identity
      banner shows the right registration number and route.
- [ ] **ESP32 reconnect test (the most safety-critical item in the whole spec).** Start a trip,
      advance a couple of stops, then physically unplug the ESP32 and plug it into a
      **different** USB port. Confirm the Hub reconnects within a few seconds with trip
      progress fully intact — no restart needed.
- [ ] **A trip in both directions.** Start a trip as "Going," Forward through a few stops,
      End Trip, then start one as "Coming Back" and confirm stops advance in reverse.
- [ ] **Admin shows the bus live.** With the PC online, confirm its status dot goes green in
      the Admin's Buses tab within ~30 seconds, and that starting a trip updates its
      "trip active / stop / direction" line there.
- [ ] **Content reaches the bus live.** Upload a new audio/ad clip in Admin's Content tab
      (or flip a stop's Ads toggle), and confirm — without restarting anything on the bus —
      the next Forward press at that stop uses it.
- [ ] **Offline resilience.** Disconnect the bus's SIM/router from the internet (or just from
      power) mid-trip. Confirm everything keeps working exactly as before — trip, playback,
      display, control panel. Reconnect and confirm the Hub catches back up (check the Admin
      Buses tab goes green again, and that the trip appears in `cloud/data/cloud.db` once ended).
- [ ] **Connect code works for whoever's on shift.** On a phone that's never connected, confirm
      the Control Panel prompts for the connect code, and that entering it lets either the
      driver or conductor start/end trips, switch route/direction, and make corrections with no
      further prompts — then close and reopen the browser and confirm it's still connected
      (localStorage, not cleared by closing the tab).
- [ ] **Admin can free up a bus for a new driver.** From Admin, hit **Disconnect All Devices** on
      this bus; confirm the connected phone gets booted back to the connect screen (immediately
      if the bus is online, otherwise the next time it comes online) and needs the code again.

Once all of these pass on one bus, repeat the pairing steps (2.3) for each additional bus —
everything else (route, stops, content) is already shared and will sync down automatically the
moment each new Hub connects.
