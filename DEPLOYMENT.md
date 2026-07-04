# AdKerala — Deployment Guide

Two separate things to stand up:

1. **`cloud/`** — the admin dashboard + sync server. Goes on Railway (or any Node host).
2. **`hub/`** — the Local Hub. Goes on the actual PC installed on each bus.

They talk to each other over the internet (WebSocket `/hub-sync` + HTTPS for content downloads),
but the Hub is designed to keep working perfectly with zero connectivity — deploying the cloud
side first, then bringing buses online one at a time, is the natural order.

---

## Part 1 — Deploy `cloud/` to Railway

### 1.1 Create the service

- **From a GitHub repo** (recommended if you'll keep pushing updates): push this project to a
  GitHub repo, then in Railway: **New Project → Deploy from GitHub repo** → pick it.
- **From your machine directly** (quick one-off): install the Railway CLI (`npm i -g @railway/cli`),
  run `railway login`, then from the `cloud/` folder: `railway init` and `railway up`.

Either way, once the service exists, open its **Settings** tab and set:

| Setting | Value |
|---|---|
| Root Directory | `cloud` (this is a monorepo — `hub/`, `cloud/`, `firmware/` all live in one repo) |
| Start Command | `npm start` (already the default from `cloud/package.json`) |

Railway auto-detects Node via Nixpacks and runs `npm install` during the build — no Dockerfile
needed.

### 1.2 Environment variables

Set these under the service's **Variables** tab:

| Variable | Value | Why |
|---|---|---|
| `CLOUD_DB_PATH` | `/data/cloud.db` | Points the SQLite file at the mounted volume (1.3) instead of ephemeral container storage |
| `CLOUD_ASSETS_DIR` | `/data/assets` | Same reason, for uploaded ad/audio files |

You do **not** need to set `PORT` / `CLOUD_PORT` — Railway injects `PORT` automatically and
`cloud/src/server.js` already honors it.

### 1.3 Add a persistent Volume — do this before you rely on any uploaded content

**This is the single most important step.** Railway's container filesystem is ephemeral — every
redeploy wipes it. Without a volume, `data/cloud.db` (every route, bus, and stop you've entered)
and `assets/uploads/` (every ad/audio file) disappear on the next deploy.

In the service → **Settings → Volumes**: add a volume, mount path `/data`. That's what
`CLOUD_DB_PATH` and `CLOUD_ASSETS_DIR` above point into.

### 1.4 Domain

Railway gives you a free `<something>.up.railway.app` domain with HTTPS out of the box —
nothing else to configure. The `/hub-sync` WebSocket works over it as `wss://` automatically
(Railway's proxy upgrades the connection; no extra setting needed). A custom domain is optional
(**Settings → Networking → Custom Domain**) if you want one later.

### 1.5 First-time check

Visit `https://<your-app>.up.railway.app/admin/` — you should see the green/white Admin
Dashboard with one pre-registered demo bus (`HUB-DEV-01`, api key `dev-demo-key`). Add your
real buses/routes from here.

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

### 2.3 Configure this bus's identity

Get the bus's `bus_id` and `api_key` from the Admin's **Buses** tab (add the bus there first if
you haven't). Then set these as **persistent system environment variables** (Windows: search
"environment variables" → Edit the system environment variables → Environment Variables →
New, under System variables so they survive the auto-login):

| Variable | Value |
|---|---|
| `HUB_BUS_ID` | the bus id from Admin, e.g. `KL07AX1234` |
| `HUB_CLOUD_API_KEY` | the api key shown/copied from Admin's Buses tab |
| `HUB_CLOUD_URL` | `wss://<your-app>.up.railway.app/hub-sync` |
| `HUB_CLOUD_HTTP` | `https://<your-app>.up.railway.app` |
| `HUB_TRANSPORT` | `serial` (real hardware — leave unset/`mock` only for a test bench with no ESP32) |
| `HUB_ESP32_VID` / `HUB_ESP32_PID` | your ESP32 board's USB vendor/product ID, if different from the default (`10C4`/`EA60`) |

### 2.4 Flash the ESP32 and wire it up

Flash `firmware/esp32_controller/esp32_controller.ino` (Arduino IDE or `arduino-cli`) onto the
ESP32, wired to the three push switches per the pin comments at the top of that file. Plug it
into the PC via USB — no specific port required, the Hub finds it by VID/PID.

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
- [ ] **PIN works for whoever's on shift.** Confirm the shared daily PIN (set via
      `daily_pin`/roster — see `hub/README.md`) lets either the driver or conductor start/end
      trips and make corrections from their own phone.

Once all of these pass on one bus, repeat the identity/env-var steps (2.3) for each additional
bus — everything else (route, stops, content) is already shared and will sync down automatically
the moment each new Hub connects.
