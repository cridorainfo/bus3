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
route assigned — matching the Hub's own Phase 1 seed — so the walkthrough of "add a route,
assign it, watch the bus pick it up" works immediately against an already-running Hub
(`../hub`, `HUB_TRANSPORT=mock npm start`).

## What's here

- **Admin page** (`/admin/`) — green/white, EN/ML display toggle in the topbar.
  - **Buses**: add/assign-route/live status.
  - **Routes**: add a route (English + Malayalam name), then **find-or-link a stop** — stops are
    global, so searching for one already used by another route and linking it reuses its audio
    instead of duplicating anything. Each stop row has an **Ads toggle**: on (and only once a
    `stop_name_ad` clip has been uploaded for it) swaps that combined "stop name + sponsor" clip
    in for the plain stop name during playback.
  - **Content**: upload ad video/banner or audio segments — `chime`/`filler`/`outro` are global
    (common to every announcement); `stop_name`/`stop_name_ad` are scoped to a specific stop via
    the same search picker.
- **REST API** (`/api/buses`, `/api/routes`, `/api/stops`, `/api/content`) — what the admin page calls.
- **`/hub-sync` WebSocket** — each bus's Hub connects here; admin actions that affect a bus's
  effective state (route assignment, a linked/edited/reordered stop, an ads toggle, new content)
  push an updated `sync_state` to it immediately if it's online, and the Hub reports its unsynced
  trips/play_logs + live status back up on the same connection.

## Known simplifications

- No authentication on the admin page itself (fine for local/demo use, not for a public host).
- No campaign budget pacing (Phase 3) — content can be uploaded and targeted to a route/stop,
  but there's no spend/quota engine yet.
- No owner/revenue dashboards (Phase 3/4).
- Deploying this for real (Railway, persistent volume, env vars) is covered in
  `../DEPLOYMENT.md`.
