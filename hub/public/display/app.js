// AdKerala Display View — kiosk, FullHD. This is the Hub's only screen, so while unpaired it
// shows the device's pairing ID (read-only — nothing is ever typed here) instead of the normal
// view. Once paired: route name, the route-progress strip from current_stop_index (no GPS
// needed), and whatever the Hub pushes as "nowPlaying" — the composed announcement audio,
// sequentially, plus a screen ad (shown muted, since the single aux output is reserved for the
// announcement voice — see hub/README.md).

const pairingScreen = document.getElementById('pairing-screen');
const pairingIdValue = document.getElementById('pairing-id-value');
const connectScreen = document.getElementById('connect-screen');
const connectBadge = document.getElementById('connect-badge');
const normalView = document.getElementById('normal-view');
const routeNameLabel = document.getElementById('route-name-label');
const stopsTrack = document.getElementById('stops-track');
const adVideo = document.getElementById('ad-video');
const adBanner = document.getElementById('ad-banner');
const idleMessage = document.getElementById('idle-message');
const audioPlayer = document.getElementById('audio-player');

let stopsCache = { routeId: null, contentVersion: -1, stops: [] };
let audioQueue = [];
let lastNowPlayingKey = null;

// Unpaired: this is the Hub's only screen, so its pairing ID (a smart-TV-style device code)
// shows here, big and read-only — nothing is ever typed at this kiosk PC. An admin reads the
// ID and claims it from the Admin dashboard against a bus record.
//
// Once paired, a second gate applies before showing ads/route content: no driver/conductor
// phone has connected yet, so the full screen instead shows a QR code straight to this bus's
// Control Panel (avoids anyone needing to be told an IP address to type in). The moment at
// least one phone connects, this switches to the normal view — but keeps a small QR badge in a
// corner so a second crew member (e.g. the conductor, after the driver's already connected) can
// still scan their own way in independently.
function renderConnectionState(pairingId, connectedDeviceCount) {
  const unpaired = !!pairingId;
  const noDevicesYet = !unpaired && !connectedDeviceCount;

  pairingScreen.style.display = unpaired ? 'flex' : 'none';
  connectScreen.style.display = noDevicesYet ? 'flex' : 'none';
  normalView.style.display = unpaired || noDevicesYet ? 'none' : 'block';
  connectBadge.style.display = !unpaired && !noDevicesYet ? 'block' : 'none';

  if (unpaired) pairingIdValue.textContent = pairingId;
}

function renderRouteName(bus) {
  routeNameLabel.textContent = bus && bus.route_name ? bus.route_name : '';
}

function renderProgressStrip(trip) {
  stopsTrack.innerHTML = '';
  if (!trip || stopsCache.routeId !== trip.route_id || stopsCache.stops.length === 0) return;

  const stops = stopsCache.stops;
  const currentIdx = trip.current_stop_index;
  const lastIdx = stops.length - 1;

  const windowStart = Math.max(0, currentIdx - 3);
  const windowEnd = Math.min(lastIdx, currentIdx + 4);
  const visibleIdx = [];
  for (let i = windowStart; i <= windowEnd; i++) visibleIdx.push(i);

  const includesFinal = visibleIdx.includes(lastIdx);

  for (const i of visibleIdx) {
    stopsTrack.appendChild(buildStopEl(stops[i], i, currentIdx, lastIdx));
  }

  if (!includesFinal) {
    const ellipsis = document.createElement('div');
    ellipsis.className = 'ellipsis';
    ellipsis.textContent = '···';
    stopsTrack.appendChild(ellipsis);
    stopsTrack.appendChild(buildStopEl(stops[lastIdx], lastIdx, currentIdx, lastIdx));
  }
}

function buildStopEl(stop, idx, currentIdx, lastIdx) {
  const el = document.createElement('div');
  const classes = ['stop'];
  if (idx < currentIdx) classes.push('done');
  if (idx === currentIdx) classes.push('current');
  if (idx === lastIdx) classes.push('final');
  el.className = classes.join(' ');
  el.innerHTML = `<div class="dot"></div><div class="stop-label">${stop.name_ml}</div>`;
  return el;
}

async function ensureStopsLoaded(trip, contentVersion) {
  if (!trip) return;
  const upToDate = stopsCache.routeId === trip.route_id && stopsCache.contentVersion === contentVersion && stopsCache.stops.length > 0;
  if (upToDate) return;
  const res = await fetch('/api/trip/state');
  const data = await res.json();
  stopsCache = { routeId: trip.route_id, contentVersion, stops: data.stops || [] };
}

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

function showAd(ad) {
  adVideo.style.display = 'none';
  adBanner.style.display = 'none';
  idleMessage.style.display = 'none';

  if (!ad) {
    idleMessage.style.display = 'block';
    return;
  }
  if (ad.type === 'ad_video') {
    adVideo.src = ad.file_path;
    adVideo.style.display = 'block';
    adVideo.play().catch(() => {});
  } else {
    adBanner.src = ad.file_path;
    adBanner.style.display = 'block';
  }
}

function handleNowPlaying(nowPlaying) {
  if (!nowPlaying) {
    showAd(null);
    return;
  }
  const key = `${nowPlaying.stop_id || ''}:${nowPlaying.startedAt}`;
  if (key !== lastNowPlayingKey) {
    lastNowPlayingKey = key;
    if (nowPlaying.announcement && nowPlaying.announcement.length > 0) {
      playAudioQueue(nowPlaying.announcement);
    }
  }
  showAd(nowPlaying.ad);
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onmessage = async (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type !== 'state') return;
    const { bus, trip, nowPlaying, contentVersion, pairingId, connectedDeviceCount } = msg.payload;

    renderConnectionState(pairingId, connectedDeviceCount);
    if (pairingId || !connectedDeviceCount) return; // nothing else to render while showing the pairing/connect screen

    renderRouteName(bus);
    await ensureStopsLoaded(trip, contentVersion);
    renderProgressStrip(trip);
    handleNowPlaying(nowPlaying);
  };

  ws.onclose = () => setTimeout(connect, 2000); // kiosk browser never left alone to show a dead socket
}

connect();
