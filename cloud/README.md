# AdKerala Cloud-Lite Server (sample Phase 2)

A scaled-down stand-in for the spec's cloud layer (`../AdKerala_Developer_Spec.md`, Section 8
Sync Engine + Section 12 Admin Dashboard): SQLite instead of Postgres, WebSocket push instead
of a full sync/pacing pipeline, no auth hardening — enough to demonstrate "admin assigns a
route/uploads content, the bus picks it up live while its Hub PC is online."

## Quick start

```
cd cloud
npm install
npm start          # http://localhost:4000, admin UI at /admin/
```

A demo bus (`HUB-DEV-01` / `KL07AX1234`, api key `dev-demo-key`) is pre-registered with no
route assigned — matching the Hub's own dev-shortcut seed (`HUB_BUS_ID` env var) — so the
walkthrough of "add a route, assign it, watch the bus pick it up" works immediately against an
already-running Hub (`../hub`, `HUB_TRANSPORT=mock npm start`). For the real flow (no shared
`dev-demo-key`), start an unpaired Hub instead, read the pairing ID off its Display View
(`http://localhost:3000/display/`), and claim it against a bus using the **Pair a Bus** card in
the Buses tab — see `../DEPLOYMENT.md`.

## What's here

- **Admin page** (`/admin/`) — green/white, both English and Malayalam names always shown.
  - **Buses**: a **Pair a Bus** card links an unpaired Hub (which displays its own short pairing
    ID, smart-TV style, on its Display View — nothing is ever typed at the Hub PC) to a bus
    record here, by pairing ID. Below that, add a bus (with a friendly name), assign it **one or
    more routes** (the driver/conductor picks the active one from their phone), see live status,
    and manage its credentials: **Connect Code** (persistent, what a driver/conductor's phone
    uses to connect — replaces the old daily-PIN idea) and **Disconnect All Devices** (frees the
    bus up for a new driver/conductor, next time its Hub is online).
  - **Routes**: add a route (English + Malayalam name), then **find-or-link a stop** — stops are
    global, so searching for one already used by another route and linking it reuses its audio
    instead of duplicating anything. Each stop's Ads status (on/off) is managed from Content >
    Stop Names now, shown here as a read-only badge.
  - **Content**: four sections — **Announcement Audio** (`chime`/`filler`/`outro`, global),
    **Stop Names** (a searchable directory of every stop — upload the plain clip and/or an ad
    clip per stop, and toggle which plays), **Banner Ads**, **Full-Screen Ads** (video/music).
- **REST API** (`/api/buses`, `/api/routes`, `/api/stops`, `/api/content`, and the
  unauthenticated `/api/pair/register`, `/api/pair/status/:id`, `/api/pair/claim` device-code
  pairing exchange) — what the admin page and Hub installs call.
- **`/hub-sync` WebSocket** — each bus's Hub connects here; admin actions that affect a bus's
  effective state (route/stop changes, ads toggle, new content, a connect-code rotation, a
  "disconnect all devices") push an updated `sync_state` to it immediately if it's online, and
  the Hub reports its unsynced trips/play_logs + live status back up on the same connection.

## Known simplifications

- No authentication on the admin page itself (fine for local/demo use, not for a public host).
- No campaign budget pacing (Phase 3) — content can be uploaded and targeted to a route/stop,
  but there's no spend/quota engine yet.
- No owner/revenue dashboards (Phase 3/4).
- Deploying this for real (Railway, persistent volume, env vars) is covered in
  `../DEPLOYMENT.md`.
