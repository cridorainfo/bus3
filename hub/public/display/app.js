// AdKerala Display View — kiosk, FullHD (1920x1080). Three top-level states:
//   1. Unpaired: shows this Hub's pairing ID (read-only — an admin claims it from the dashboard).
//   2. Paired, no phone connected: full-screen QR straight to this bus's Control Panel.
//   3. Normal: top bar (logo + status pills + route + clock/date), center area (fullscreen video
//      ads when playing, otherwise the next stop big + the whole route as a timeline), bottom
//      strip (banner ads normally; the next-stop details move down there while a video ad has
//      the center, so passengers never lose sight of where they are).
// Audio announcements play sequentially through the single aux output; video ads stay muted.

const pairingScreen = document.getElementById('pairing-screen');
const pairingIdValue = document.getElementById('pairing-id-value');
const connectScreen = document.getElementById('connect-screen');
const connectBadge = document.getElementById('connect-badge');
const normalView = document.getElementById('normal-view');
const routeNameLabel = document.getElementById('route-name-label');
const pillOnline = document.getElementById('pill-online');
const pillUpdating = document.getElementById('pill-updating');
const clockTime = document.getElementById('clock-time');
const clockDate = document.getElementById('clock-date');
const adVideo = document.getElementById('ad-video');
const adFullscreenImage = document.getElementById('ad-fullscreen-image');
const infoPanel = document.getElementById('info-panel');
const idleBranding = document.getElementById('idle-branding');
const nextStopBlock = document.getElementById('next-stop-block');
const nextStopName = document.getElementById('next-stop-name');
const timeline = document.getElementById('timeline');
const adBanner = document.getElementById('ad-banner');
const miniNextStop = document.getElementById('mini-next-stop');
const miniNextStopName = document.getElementById('mini-next-stop-name');
const audioPlayer = document.getElementById('audio-player');

let stopsCache = { routeId: null, contentVersion: -1, stops: [] };
let audioQueue = [];
let lastNowPlayingKey = null;
let lastBannerAd = null; // banner ads persist in the bottom strip until replaced by a newer one
let videoAdActive = false;
let latestTrip = null;
let stopNameToggleSec = 4;
let showEnglishStopNames = false;
let stopNameToggleTimer = null;
let lastRenderedStopId = null;

function stopNameForLang(stop, english) {
  if (!stop) return '—';
  if (english) return stop.name_en || stop.name_ml || '—';
  return stop.name_ml || stop.name_en || '—';
}

function pulseLangToggle(el) {
  if (!el) return;
  el.classList.remove('lang-toggle');
  void el.offsetWidth;
  el.classList.add('lang-toggle');
}

function setStopNameLangClass(el, english) {
  if (!el) return;
  el.classList.toggle('lang-en', english);
  el.classList.toggle('lang-ml', !english);
}

function applyStopNameLanguage() {
  const stop = currentNextStop();
  const text = stopNameForLang(stop, showEnglishStopNames);
  nextStopName.textContent = text;
  miniNextStopName.textContent = text;
  setStopNameLangClass(nextStopName, showEnglishStopNames);
  setStopNameLangClass(miniNextStopName, showEnglishStopNames);
  pulseLangToggle(nextStopName);
  pulseLangToggle(miniNextStopName);
  timeline.querySelectorAll('.stop-label').forEach((label, idx) => {
    const s = stopsCache.stops[idx];
    if (!s) return;
    label.textContent = stopNameForLang(s, showEnglishStopNames);
    setStopNameLangClass(label, showEnglishStopNames);
    pulseLangToggle(label);
  });
}

function restartStopNameToggleTimer(sec) {
  stopNameToggleSec = sec;
  clearInterval(stopNameToggleTimer);
  stopNameToggleTimer = setInterval(() => {
    showEnglishStopNames = !showEnglishStopNames;
    applyStopNameLanguage();
  }, stopNameToggleSec * 1000);
}

function syncStopNameToggleSetting(settings) {
  const sec = Number(settings?.stop_name_toggle_sec);
  const nextSec = Number.isFinite(sec) && sec >= 2 ? sec : 4;
  if (nextSec === stopNameToggleSec && stopNameToggleTimer) return;
  restartStopNameToggleTimer(nextSec);
}

// --- Top-level screen switching ---
function renderConnectionState(pairingId, connectedDeviceCount) {
  const unpaired = !!pairingId;
  const noDevicesYet = !unpaired && !connectedDeviceCount;

  pairingScreen.style.display = unpaired ? 'flex' : 'none';
  connectScreen.style.display = noDevicesYet ? 'flex' : 'none';
  normalView.style.display = unpaired || noDevicesYet ? 'none' : 'flex';

  if (unpaired) pairingIdValue.textContent = pairingId;
}

// --- Top bar ---
function renderTopBar(state) {
  const ml = state.bus && state.bus.route_name_ml;
  const en = state.bus && state.bus.route_name;
  if (ml) {
    routeNameLabel.textContent = ml;
    routeNameLabel.className = 'lang-ml';
  } else {
    routeNameLabel.textContent = en || '';
    routeNameLabel.className = en ? 'lang-en' : '';
  }

  pillOnline.textContent = state.cloudOnline ? 'Online' : 'No Internet';
  pillOnline.className = `pill ${state.cloudOnline ? 'ok' : 'bad'}`;

  pillUpdating.style.display = state.updating ? 'inline-block' : 'none';
}

function tickClock() {
  const now = new Date();
  clockTime.textContent = now.toLocaleTimeString('en-IN', { hour12: false });
  clockDate.textContent = now.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
setInterval(tickClock, 1000);
tickClock();

// --- Next stop + full-route timeline ---
function currentNextStop() {
  if (!latestTrip || stopsCache.stops.length === 0) return null;
  return stopsCache.stops[latestTrip.current_stop_index] || null;
}

function renderNextStop() {
  const stop = currentNextStop();
  idleBranding.style.display = stop ? 'none' : 'block';
  nextStopBlock.style.display = stop ? 'block' : 'none';
  if (stop) {
    const stopChanged = lastRenderedStopId !== stop.stop_id;
    if (stopChanged) {
      showEnglishStopNames = false;
      lastRenderedStopId = stop.stop_id;
      // Re-trigger the slide/fade only when the stop actually changes — not on every state push.
      nextStopName.classList.remove('animate');
      void nextStopName.offsetWidth; // forces a reflow so removing+re-adding restarts the animation
      nextStopName.classList.add('animate');
    }
    applyStopNameLanguage();
  } else {
    lastRenderedStopId = null;
  }
}

// Little side-view bus that rides along the timeline, sitting above the current stop.
const BUS_SVG = `
<svg viewBox="0 0 56 34" xmlns="http://www.w3.org/2000/svg">
  <rect x="1" y="2" width="54" height="24" rx="6" fill="#0f6b3e"/>
  <rect x="6" y="7" width="10" height="9" rx="2" fill="#ffffff"/>
  <rect x="20" y="7" width="10" height="9" rx="2" fill="#ffffff"/>
  <rect x="34" y="7" width="10" height="9" rx="2" fill="#ffffff"/>
  <rect x="47" y="9" width="6" height="7" rx="2" fill="#e7f4ec"/>
  <circle cx="14" cy="28" r="5" fill="#14231b"/>
  <circle cx="14" cy="28" r="2" fill="#9a9ab0"/>
  <circle cx="42" cy="28" r="5" fill="#14231b"/>
  <circle cx="42" cy="28" r="2" fill="#9a9ab0"/>
</svg>`;

function renderTimeline() {
  timeline.innerHTML = '';
  if (!latestTrip || stopsCache.routeId !== latestTrip.route_id || stopsCache.stops.length === 0) return;

  const currentIdx = latestTrip.current_stop_index;
  stopsCache.stops.forEach((stop, idx) => {
    const el = document.createElement('div');
    const classes = ['stop'];
    if (idx < currentIdx) classes.push('done'); // solid green + white check via CSS
    if (idx === currentIdx) classes.push('current'); // pulsing dot + the bus riding above it
    el.className = classes.join(' ');
    const busMarker = idx === currentIdx ? `<div class="bus-marker">${BUS_SVG}</div>` : '';
    el.innerHTML = `${busMarker}<div class="dot"></div><div class="stop-label ${showEnglishStopNames ? 'lang-en' : 'lang-ml'}">${stopNameForLang(stop, showEnglishStopNames)}</div>`;
    timeline.appendChild(el);
  });
}

async function ensureStopsLoaded(trip, contentVersion) {
  if (!trip) return;
  // Direction is part of the cache key: /api/trip/state returns stops already ordered for the
  // active trip's direction, so a "return" trip after a "going" one (same route, same content)
  // MUST refetch — reusing the going-order list left the timeline running backwards.
  const upToDate = stopsCache.routeId === trip.route_id && stopsCache.direction === trip.direction && stopsCache.contentVersion === contentVersion && stopsCache.stops.length > 0;
  if (upToDate) return;
  const res = await fetch('/api/trip/state');
  const data = await res.json();
  stopsCache = { routeId: trip.route_id, direction: trip.direction, contentVersion, stops: data.stops || [] };
}

// --- Ads: fullscreen video/image takes the center; banners take the bottom strip ---
// `mode` picks which center element is visible while the center is occupied: 'video' (default)
// or 'image' (fullscreen-style ad_banner). Both share the same next-stop/banner-swap behavior.
function setVideoMode(on, mode = 'video') {
  videoAdActive = on;
  adVideo.style.display = on && mode === 'video' ? 'block' : 'none';
  adFullscreenImage.style.display = on && mode === 'image' ? 'block' : 'none';
  infoPanel.style.display = on ? 'none' : 'flex';

  // While the center is occupied, the next stop moves down into the banner's spot; the moment
  // it clears, the banner comes back and the next stop returns to the center.
  const hasNextStop = !!currentNextStop();
  miniNextStop.style.display = on && hasNextStop ? 'flex' : 'none';
  adBanner.style.display = !on && lastBannerAd ? 'block' : 'none';
}

let videoFailsafeTimer = null;

function handleAd(ad) {
  if (!ad) return;
  if (ad.type === 'ad_video' || ad.type === 'music') {
    if (adVideo.src !== new URL(ad.file_path, location.href).href) adVideo.src = ad.file_path;
    setVideoMode(true, 'video');
    adVideo.currentTime = 0;
    adVideo.play().catch(() => {});
    // Failsafe: if neither 'ended' nor 'error' ever fires (broken file, stalled load), never
    // leave the center stuck on a dead video — force back to the info panel after the ad's
    // declared duration plus slack.
    clearTimeout(videoFailsafeTimer);
    videoFailsafeTimer = setTimeout(() => setVideoMode(false), ((ad.duration_sec || 30) + 5) * 1000);
  } else if (ad.type === 'ad_image' || (ad.type === 'ad_banner' && ad.display_mode === 'fullscreen')) {
    const imageSrc = `${ad.file_path}${ad.file_path.includes('?') ? '&' : '?'}v=${encodeURIComponent(ad.content_id || '')}`;
    if (adFullscreenImage.src !== new URL(imageSrc, location.href).href) adFullscreenImage.src = imageSrc;
    setVideoMode(true, 'image');
    // Static fullscreen image — no natural 'ended' event; return after the admin-set duration.
    clearTimeout(videoFailsafeTimer);
    videoFailsafeTimer = setTimeout(() => setVideoMode(false), ((ad.duration_sec || 30) + 1) * 1000);
  } else if (ad.type === 'ad_banner') {
    lastBannerAd = ad;
    adBanner.src = ad.file_path;
    // Each stop picks one ad — a banner pick supersedes whatever video/fullscreen-image was (or
    // was stuck) playing from the previous stop, which also guarantees stale center media can't linger.
    setVideoMode(false);
  }
}

function exitVideoMode() {
  clearTimeout(videoFailsafeTimer);
  setVideoMode(false);
}

adVideo.addEventListener('ended', exitVideoMode);
adVideo.addEventListener('error', exitVideoMode); // a missing/broken file must never leave a black center
adFullscreenImage.addEventListener('error', exitVideoMode);

// --- Announcement audio (sequential segments through the single aux output) ---
function playAudioQueue(segments) {
  audioQueue = segments.slice();
  playNextInQueue();
}

function playNextInQueue() {
  if (audioQueue.length === 0) return;
  const seg = audioQueue.shift();
  audioPlayer.src = seg.file_path;
  audioPlayer.play().catch(() => {}); // autoplay may need a user gesture on first load; kiosk mode allows it
}

audioPlayer.addEventListener('ended', playNextInQueue);
audioPlayer.addEventListener('error', playNextInQueue); // missing placeholder file shouldn't stall the queue

function handleNowPlaying(nowPlaying) {
  if (!nowPlaying) {
    if (videoAdActive) setVideoMode(false); // e.g. Undo cancelled whatever just started
    return;
  }
  const key = `${nowPlaying.stop_id || ''}:${nowPlaying.startedAt}`;
  if (key !== lastNowPlayingKey) {
    lastNowPlayingKey = key;
    if (nowPlaying.announcement && nowPlaying.announcement.length > 0) {
      playAudioQueue(nowPlaying.announcement);
    }
    handleAd(nowPlaying.ad);
  }
}

// --- Live state over WebSocket ---
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onmessage = async (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type !== 'state') return;
    const payload = msg.payload;

    renderConnectionState(payload.pairingId, payload.connectedDeviceCount);
    if (payload.pairingId || !payload.connectedDeviceCount) return; // pairing/connect screen is up — nothing else to render

    latestTrip = payload.trip;
    renderTopBar(payload);
    syncStopNameToggleSetting(payload.settings);
    if (payload.contentVersion !== stopsCache.contentVersion) {
      stopsCache = { routeId: null, direction: null, contentVersion: -1, stops: [] };
    }
    await ensureStopsLoaded(payload.trip, payload.contentVersion);
    renderNextStop();
    renderTimeline();
    handleNowPlaying(payload.nowPlaying);
  };

  ws.onclose = () => setTimeout(connect, 2000); // kiosk browser is never left alone to show a dead socket
}

connect();
restartStopNameToggleTimer(stopNameToggleSec);
