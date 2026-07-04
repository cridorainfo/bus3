const db = require('../db/db');
const state = require('./state');
const tripEngine = require('./tripEngine');
const contentScheduler = require('./contentScheduler');

const FORWARD_DEBOUNCE_MS = 2000; // spec 4.5 — absorbs an over-eager double-press

let lastForwardHandledAt = 0;

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
      item = db.prepare('SELECT * FROM content_items WHERE type = ? LIMIT 1').get(type);
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

function writePlayLog({ tripId, contentId, campaignId, stopId }) {
  db.prepare(`
    INSERT INTO play_logs (trip_id, content_id, campaign_id, stop_id, played_at, billable, synced)
    VALUES (?, ?, ?, ?, datetime('now'), 0, 0)
  `).run(tripId, contentId, campaignId || null, stopId);
}

function pushNowPlaying({ announcement, ad, stop }) {
  state.update({
    nowPlaying: {
      stop_id: stop.stop_id,
      stop_name_ml: stop.name_ml,
      announcement: announcement.map((s) => ({ content_id: s.content_id, file_path: s.file_path, duration_sec: s.duration_sec, type: s.type })),
      ad: ad ? { content_id: ad.content_id, file_path: ad.file_path, duration_sec: ad.duration_sec, type: ad.type } : null,
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
  const ad = contentScheduler.selectScreenAd({ routeId: trip.route_id, tier: null });

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

// Scheduler tick (spec 4.5, ~60s): fills dead time between stops so the screen is never
// frozen/dark while the bus sits idle mid-segment.
function idleAdTick() {
  if (!state.trip) return;
  const ad = contentScheduler.selectScreenAd({ routeId: state.trip.route_id, tier: null });
  if (!ad) return;
  writePlayLog({ tripId: state.trip.trip_id, contentId: ad.content_id, campaignId: ad.campaign_id, stopId: null });
  state.update({
    nowPlaying: {
      ...(state.nowPlaying || {}),
      ad: { content_id: ad.content_id, file_path: ad.file_path, duration_sec: ad.duration_sec, type: ad.type },
      startedAt: Date.now(),
    },
  });
}

module.exports = { handleForward, handleUndo, handleReplay, composeAnnouncement, idleAdTick };
