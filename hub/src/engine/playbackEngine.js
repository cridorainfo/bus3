const db = require('../db/db');
const state = require('./state');
const tripEngine = require('./tripEngine');
const contentScheduler = require('./contentScheduler');
const { getDeviceConfig } = require('../config/deviceConfig');

const FORWARD_DEBOUNCE_MS = 2000; // spec 4.5 — absorbs an over-eager double-press

let lastForwardHandledAt = 0;

// This bus's own tier (synced down from the cloud's buses.tier) — ad selection needs the real
// value to honor "by tier" targeting; a hardcoded null meant tier-targeted ads never matched.
function busTier() {
  const cfg = getDeviceConfig();
  return (cfg && cfg.tier) || 'rural';
}

function getStop(routeId, direction, index) {
  const stops = tripEngine.getStopsForRoute(routeId, direction);
  return stops[index];
}

// Assembles the segment list for a stop's announcement template (default: chime, filler,
// stop_name, outro). The template is data (stops.announcement_template), so admins can change
// the pattern with no code change. `chime`/`filler`/`outro` are global (common to every
// announcement); `stop_name` is per-stop, and gets *swapped* — not layered — for a
// `stop_name_ad` clip when the admin has both uploaded one and flipped the stop's ads toggle on.
function composeAnnouncement(stop) {
  const types = stop.announcement_template.split(',').map((s) => s.trim());
  const segments = [];
  for (const type of types) {
    let item = null;
    if (type === 'chime' || type === 'filler' || type === 'outro') {
      // Never play seeded placeholders when a cloud-synced clip exists for this slot.
      item = db.prepare(`
        SELECT * FROM content_items
        WHERE type = ? AND route_id IS NULL AND stop_id IS NULL
          AND (
            content_id NOT LIKE '%-default'
            OR NOT EXISTS (
              SELECT 1 FROM content_items c2
              WHERE c2.type = ? AND c2.route_id IS NULL AND c2.stop_id IS NULL
                AND c2.content_id NOT LIKE '%-default'
            )
          )
        ORDER BY CASE WHEN content_id LIKE '%-default' THEN 1 ELSE 0 END, content_id DESC
        LIMIT 1
      `).get(type, type);
    } else if (type === 'stop_name') {
      if (stop.ads_enabled) {
        item = db.prepare('SELECT * FROM content_items WHERE type = ? AND stop_id = ? LIMIT 1').get('stop_name_ad', stop.stop_id);
      }
      if (!item) {
        item = db.prepare('SELECT * FROM content_items WHERE type = ? AND stop_id = ? LIMIT 1').get('stop_name', stop.stop_id);
      }
    }
    if (item) segments.push(item);
  }
  return segments;
}

// Selection (contentScheduler.selectScreenAd) already confirmed quota was available before
// picking a campaign-linked ad, so this doesn't re-check — it just records the outcome: any play
// tied to a campaign counts as billable (including an unlimited/free campaign's plays, useful for
// analytics even though no budget is consumed), and consumes one unit of today's quota if a quota
// row exists for it (a no-op for unlimited campaigns, which have no quota row at all).
function writePlayLog({ tripId, contentId, campaignId, stopId }) {
  const billable = campaignId ? 1 : 0;
  db.prepare(`
    INSERT INTO play_logs (trip_id, content_id, campaign_id, stop_id, played_at, billable, synced)
    VALUES (?, ?, ?, ?, datetime('now'), ?, 0)
  `).run(tripId, contentId, campaignId || null, stopId, billable);

  if (billable) {
    db.prepare("UPDATE campaign_quotas SET plays_used = plays_used + 1 WHERE campaign_id = ? AND date = date('now')").run(campaignId);
  }
}

function pushNowPlaying({ announcement, ad, stop }) {
  state.update({
    nowPlaying: {
      stop_id: stop.stop_id,
      stop_name_ml: stop.name_ml,
      announcement: announcement.map((s) => ({ content_id: s.content_id, file_path: s.file_path, duration_sec: s.duration_sec, type: s.type })),
      ad: ad ? { content_id: ad.content_id, file_path: ad.file_path, duration_sec: ad.duration_sec, type: ad.type, display_mode: ad.display_mode } : null,
      startedAt: Date.now(),
    },
  });
}

function handleForward() {
  const now = Date.now();
  if (now - lastForwardHandledAt < FORWARD_DEBOUNCE_MS) return; // duplicate/mistimed press, ignore
  lastForwardHandledAt = now;

  if (!state.trip) {
    // Safety net, not the primary flow (spec 4.2) — a driver who forgets the phone step
    // shouldn't be blocked from working.
    tripEngine.startTrip({ via: 'button_fallback' });
  } else {
    tripEngine.noteActivity();
  }

  const trip = state.trip;
  const stops = tripEngine.getStopsForRoute(trip.route_id, trip.direction);
  const prevIndex = trip.current_stop_index;
  const newIndex = Math.min(prevIndex + 1, stops.length - 1);

  const anchor = state.segmentAnchorAt || now;
  const segmentDurationSec = (now - anchor) / 1000;
  db.prepare(`
    INSERT INTO stop_segment_timings (route_id, from_stop_seq, to_stop_seq, trip_id, duration_sec, recorded_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(trip.route_id, prevIndex, newIndex, trip.trip_id, segmentDurationSec);

  db.prepare('UPDATE trips SET current_stop_index = ? WHERE trip_id = ?').run(newIndex, trip.trip_id);

  const stop = stops[newIndex];
  const announcement = composeAnnouncement(stop);
  const ad = contentScheduler.selectScreenAd({ routeId: trip.route_id, tier: busTier(), busId: getDeviceConfig()?.bus_id });

  for (const seg of announcement) {
    writePlayLog({ tripId: trip.trip_id, contentId: seg.content_id, campaignId: seg.campaign_id, stopId: stop.stop_id });
  }
  if (ad) {
    writePlayLog({ tripId: trip.trip_id, contentId: ad.content_id, campaignId: ad.campaign_id, stopId: stop.stop_id });
  }

  state.update({ trip: { ...trip, current_stop_index: newIndex }, segmentAnchorAt: now });
  pushNowPlaying({ announcement, ad, stop });
}

function handleUndo() {
  if (!state.trip) {
    db.prepare("INSERT INTO button_events (signal, timestamp) VALUES (2, datetime('now'))").run();
    return;
  }
  const trip = state.trip;
  const newIndex = Math.max(0, trip.current_stop_index - 1);

  db.prepare('UPDATE trips SET current_stop_index = ? WHERE trip_id = ?').run(newIndex, trip.trip_id);
  db.prepare("INSERT INTO button_events (signal, timestamp) VALUES (2, datetime('now'))").run();

  // Cancel any announcement/ad that just started playing from the last Forward.
  state.update({ trip: { ...trip, current_stop_index: newIndex }, nowPlaying: null, segmentAnchorAt: Date.now() });
}

function handleReplay() {
  if (!state.trip) {
    db.prepare("INSERT INTO button_events (signal, timestamp) VALUES (3, datetime('now'))").run();
    return;
  }
  const trip = state.trip;
  const stop = getStop(trip.route_id, trip.direction, trip.current_stop_index);
  const announcement = composeAnnouncement(stop);

  db.prepare("INSERT INTO button_events (signal, timestamp) VALUES (3, datetime('now'))").run();
  for (const seg of announcement) {
    writePlayLog({ tripId: trip.trip_id, contentId: seg.content_id, campaignId: seg.campaign_id, stopId: stop.stop_id });
  }

  pushNowPlaying({ announcement, ad: null, stop });
}

// Scheduler tick (spec 4.5): fills dead time between stops so the screen is never frozen/dark
// while the bus sits idle mid-segment.
function idleAdTick() {
  if (!state.trip) return;
  const ad = contentScheduler.selectScreenAd({ routeId: state.trip.route_id, tier: busTier(), busId: getDeviceConfig()?.bus_id });
  if (!ad) return;
  writePlayLog({ tripId: state.trip.trip_id, contentId: ad.content_id, campaignId: ad.campaign_id, stopId: null });
  state.update({
    nowPlaying: {
      ...(state.nowPlaying || {}),
      // Idle ticks only ever rotate the ad — never re-broadcast the last stop's announcement,
      // or the Display's key (stop_id:startedAt) changing on every tick would replay it forever.
      announcement: [],
      ad: { content_id: ad.content_id, file_path: ad.file_path, duration_sec: ad.duration_sec, type: ad.type, display_mode: ad.display_mode },
      startedAt: Date.now(),
    },
  });
}

// How often the tick above actually fires is an admin-controlled fleet setting (synced down
// from the cloud into the local settings table) rather than a hardcoded 60s — read fresh on
// every check so a change applies live, no restart. server.js polls this frequently and lets
// this gate decide whether it's actually due yet.
let lastIdleAdAt = 0;

function adIntervalMs() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'ad_interval_sec'").get();
  const sec = row ? Number(row.value) : NaN;
  return (Number.isFinite(sec) && sec >= 10 ? sec : 60) * 1000;
}

// Video ads rotate via the player's 'ended' event; fullscreen images use duration_sec only.
function idleAdTickIfDue() {
  const currentAd = state.nowPlaying && state.nowPlaying.ad;
  const usesOwnDuration = !!(
    currentAd &&
    currentAd.duration_sec &&
    (currentAd.type === 'ad_image' || (currentAd.type === 'ad_banner' && currentAd.display_mode === 'fullscreen'))
  );
  const intervalMs = usesOwnDuration ? Math.max(currentAd.duration_sec, 3) * 1000 : adIntervalMs();
  const referenceAt = usesOwnDuration && state.nowPlaying.startedAt ? state.nowPlaying.startedAt : lastIdleAdAt;

  if (Date.now() - referenceAt < intervalMs) return;
  lastIdleAdAt = Date.now();
  idleAdTick();
}

module.exports = { handleForward, handleUndo, handleReplay, composeAnnouncement, idleAdTick, idleAdTickIfDue };
