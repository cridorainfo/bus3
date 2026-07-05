// AdKerala Control Panel — used by either driver or conductor (spec 7.1). Two screens: Trip
// (route/direction pickers, Start/Forward/Undo/Announcement/End) and Report (issue reporting +
// the Disconnect-Hub-from-Server danger zone). A one-time "connect to this bus" code gates the
// actions that change state — once connected, the phone stays connected (localStorage, survives
// closing the browser) until it disconnects or an admin disconnects every device on this bus.
// Viewing status/identity never requires it.

const DEVICE_TOKEN_KEY = 'adkerala_device_token';

let latestState = null;
let stopsCache = { routeId: null, contentVersion: -1, stops: [] };
let routesCache = { contentVersion: -1, routes: [] };
let pendingRetry = null;
let codeBuffer = '';
let selectedDirection = localStorage.getItem('adkerala_direction') === 'return' ? 'return' : 'going';

const els = {
  busName: document.getElementById('bus-name'),
  busFriendlyName: document.getElementById('bus-friendly-name'),
  regNumberSub: document.getElementById('reg-number-sub'),
  routeName: document.getElementById('route-name'),
  routePicker: document.getElementById('route-picker'),
  disconnectBtn: document.getElementById('btn-disconnect'),
  esp32Pill: document.getElementById('esp32-pill'),
  netPill: document.getElementById('net-pill'),
  currentStopName: document.getElementById('current-stop-name'),
  tripHint: document.getElementById('trip-hint'),
  btnStartTrip: document.getElementById('btn-start-trip'),
  btnForward: document.getElementById('btn-forward'),
  secondaryTripActions: document.getElementById('secondary-trip-actions'),
  btnEndTrip: document.getElementById('btn-end-trip'),
  issueText: document.getElementById('issue-text'),
  issueHint: document.getElementById('issue-hint'),
  connectOverlay: document.getElementById('connect-overlay'),
  pinDisplay: document.getElementById('pin-display'),
  pinError: document.getElementById('pin-error'),
};

// --- Tab navigation ---
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.screen).classList.add('active');
  });
});

// --- Device pairing (connect once, stay connected) ---
function deviceToken() {
  return localStorage.getItem(DEVICE_TOKEN_KEY);
}

function updateDisconnectVisibility() {
  els.disconnectBtn.style.display = deviceToken() ? 'inline-block' : 'none';
}

function showConnectOverlay(onConnected) {
  pendingRetry = onConnected || null;
  codeBuffer = '';
  els.pinError.textContent = '';
  renderCodeBuffer();
  els.connectOverlay.classList.remove('hidden');
}

function hideConnectOverlay() {
  els.connectOverlay.classList.add('hidden');
  pendingRetry = null;
}

function renderCodeBuffer() {
  const slots = ['—', '—', '—', '—'];
  for (let i = 0; i < codeBuffer.length; i++) slots[i] = '•';
  els.pinDisplay.textContent = slots.join(' ');
}

document.querySelectorAll('.keypad button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.key;
    if (key === 'clear') codeBuffer = '';
    else if (key === 'back') codeBuffer = codeBuffer.slice(0, -1);
    else if (codeBuffer.length < 4) codeBuffer += key;
    renderCodeBuffer();
    if (codeBuffer.length === 4) submitConnectCode();
  });
});

async function submitConnectCode() {
  const code = codeBuffer;
  const res = await fetch('/api/auth/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (res.ok) {
    const data = await res.json();
    localStorage.setItem(DEVICE_TOKEN_KEY, data.device_token);
    updateDisconnectVisibility();
    const retry = pendingRetry;
    hideConnectOverlay();
    if (retry) retry();
  } else {
    els.pinError.textContent = 'Wrong code, try again';
    codeBuffer = '';
    renderCodeBuffer();
  }
}

els.disconnectBtn.addEventListener('click', async () => {
  if (!confirm('Disconnect this phone from this bus? Use this when switching to a different bus.')) return;
  await fetch('/api/auth/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-device-token': deviceToken() || '' },
  });
  localStorage.removeItem(DEVICE_TOKEN_KEY);
  updateDisconnectVisibility();
  showConnectOverlay();
});

// Runs a state-changing action, prompting to connect first if this phone never has, and again
// if the server rejects the stored token (disconnected by an admin, or another device took over).
async function runProtected(fn) {
  if (!deviceToken()) {
    showConnectOverlay(() => runProtected(fn));
    return;
  }
  const res = await fn();
  if (res && res.status === 401) {
    localStorage.removeItem(DEVICE_TOKEN_KEY);
    updateDisconnectVisibility();
    showConnectOverlay(() => runProtected(fn));
  }
  return res;
}

function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-device-token': deviceToken() || '' },
    body: JSON.stringify(body || {}),
  });
}

// --- Route picker — a bus can be assigned more than one route; switching which is active is
// a purely local decision (no cloud round-trip), locked once a trip is active. ---
els.routePicker.addEventListener('change', () => {
  const routeId = els.routePicker.value;
  if (!routeId) return;
  runProtected(async () => {
    const res = await postJson('/api/trip/select-route', { route_id: routeId });
    if (!res.ok && res.status !== 401) renderRoutePicker(latestState); // revert on failure (e.g. trip just started elsewhere)
    return res;
  });
});

async function ensureRoutesLoaded(contentVersion) {
  if (routesCache.contentVersion === contentVersion) return;
  const res = await fetch('/api/trip/routes');
  const data = await res.json();
  routesCache = { contentVersion, routes: data.routes || [] };
}

function renderRoutePicker(state) {
  const tripActive = !!state.trip;
  if (routesCache.routes.length === 0) {
    els.routePicker.innerHTML = '<option value="">No routes assigned</option>';
  } else {
    els.routePicker.innerHTML = routesCache.routes
      .map((r) => `<option value="${r.route_id}" ${r.route_id === state.bus.route_assigned ? 'selected' : ''}>${escapeAttr(r.name)}${r.name_ml ? ' · ' + escapeAttr(r.name_ml) : ''}</option>`)
      .join('');
  }
  els.routePicker.disabled = tripActive || routesCache.routes.length === 0;
}

function escapeAttr(str) {
  return String(str ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

// --- Direction toggle ("Going" / "Coming Back") — locked once a trip is active, since a
// direction only makes sense to pick before starting a trip (spec: same stop list, walked in
// reverse for the return leg). ---
const directionToggle = document.getElementById('direction-toggle');

directionToggle.querySelectorAll('.segment').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (latestState && latestState.trip) return; // locked mid-trip
    selectedDirection = btn.dataset.direction;
    localStorage.setItem('adkerala_direction', selectedDirection);
    renderDirectionToggle();
  });
});

function renderDirectionToggle() {
  const tripActive = !!(latestState && latestState.trip);
  const activeDirection = tripActive ? latestState.trip.direction : selectedDirection;
  directionToggle.querySelectorAll('.segment').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.direction === activeDirection);
  });
  directionToggle.classList.toggle('locked', tripActive);
}

// --- Actions ---
els.btnStartTrip.addEventListener('click', () => {
  runProtected(() => postJson('/api/trip/start', { direction: selectedDirection }));
});

els.btnEndTrip.addEventListener('click', () => {
  runProtected(() => postJson('/api/trip/end'));
});

// Phone-side equivalents of the ESP32/Uno push switches (only shown once a trip is active —
// see renderTrip below). Forward advances one stop and plays that stop's announcement once on
// the passenger Display View; Announcement replays the *current* stop's announcement without
// moving, for when it needs to be heard again mid-travel; Undo steps back one stop, for an
// accidental Forward press.
document.getElementById('btn-forward').addEventListener('click', () => {
  runProtected(() => postJson('/api/trip/forward'));
});

document.getElementById('btn-undo').addEventListener('click', () => {
  runProtected(() => postJson('/api/trip/undo'));
});

document.getElementById('btn-announce').addEventListener('click', () => {
  runProtected(() => postJson('/api/trip/announce'));
});

// Severs this bus's server pairing entirely (Report screen's danger zone) — after this the
// Display View shows a fresh pairing ID and an admin must re-claim it from the dashboard. Every
// connected phone (this one included) is disconnected as part of the reset, so also clear the
// local token immediately rather than waiting to discover it via a 401.
document.getElementById('btn-unpair-server').addEventListener('click', () => {
  if (!confirm('Disconnect this bus from the AdKerala server? The screen will show a new pairing ID, an admin must pair it again, and every connected phone (including this one) will be disconnected.')) return;
  runProtected(async () => {
    const res = await postJson('/api/pair/unpair');
    if (res.ok) {
      localStorage.removeItem(DEVICE_TOKEN_KEY);
      updateDisconnectVisibility();
      showConnectOverlay();
    }
    return res;
  });
});

document.getElementById('btn-submit-issue').addEventListener('click', async () => {
  const description = els.issueText.value.trim();
  if (!description) return;
  const res = await postJson('/api/trip/issue', { description });
  if (res.ok) {
    els.issueText.value = '';
    els.issueHint.textContent = 'Reported — thank you.';
    setTimeout(() => (els.issueHint.textContent = ''), 3000);
  }
});

// --- Rendering ---
function renderIdentity(state) {
  const friendly = state.bus.friendly_name || '';
  const reg = state.bus.reg_number || '—';
  els.busFriendlyName.textContent = friendly;
  els.busFriendlyName.style.display = friendly ? 'block' : 'none';
  els.busName.textContent = reg;
  els.regNumberSub.textContent = '';
  els.routeName.textContent = state.bus.route_assigned ? (state.bus.route_name || `Route ${state.bus.route_assigned}`) : 'No route assigned';
}

function renderStatusPills(state) {
  const esp32Ok = state.esp32 && state.esp32.connected;
  els.esp32Pill.textContent = `Console ${esp32Ok ? '✓' : '✗'}`;
  els.esp32Pill.className = `status-pill ${esp32Ok ? 'ok' : 'bad'}`;

  els.netPill.textContent = 'Internet —'; // stubbed until Phase 2 sync engine exists
  els.netPill.className = 'status-pill';
}

function renderTrip(state) {
  const tripActive = !!state.trip;
  els.btnStartTrip.style.display = tripActive ? 'none' : 'block';
  els.btnForward.style.display = tripActive ? 'block' : 'none';
  els.secondaryTripActions.style.display = tripActive ? 'flex' : 'none';
  els.btnEndTrip.style.display = tripActive ? 'block' : 'none';

  if (!tripActive) {
    els.currentStopName.textContent = 'No active trip';
    els.tripHint.textContent = 'Tap Start Trip to begin';
    return;
  }
  const stop = stopsCache.stops[state.trip.current_stop_index];
  els.currentStopName.textContent = stop ? stop.name_ml : `Stop #${state.trip.current_stop_index}`;
  const directionLabel = state.trip.direction === 'return' ? 'Coming Back' : 'Going';
  els.tripHint.textContent = state.trip.started_via === 'button_fallback'
    ? `Trip started automatically from the push switch — ${directionLabel}`
    : directionLabel;
}

async function ensureStopsLoaded(trip, contentVersion) {
  if (!trip) return;
  // Direction is part of the cache key: stops come back already ordered for the trip's
  // direction, so a "return" trip after a "going" one (same route/content) must refetch.
  const upToDate = stopsCache.routeId === trip.route_id && stopsCache.direction === trip.direction && stopsCache.contentVersion === contentVersion && stopsCache.stops.length > 0;
  if (upToDate) return;
  const res = await fetch('/api/trip/state');
  const data = await res.json();
  stopsCache = { routeId: trip.route_id, direction: trip.direction, contentVersion, stops: data.stops || [] };
}

async function applyState(state) {
  latestState = state;
  await ensureStopsLoaded(state.trip, state.contentVersion);
  await ensureRoutesLoaded(state.contentVersion);
  renderIdentity(state);
  renderStatusPills(state);
  renderTrip(state);
  renderDirectionToggle();
  renderRoutePicker(state);
}

// --- Initial load + live updates ---
updateDisconnectVisibility();
if (!deviceToken()) showConnectOverlay(); // prompt right away rather than waiting for the first tap
fetch('/api/trip/state').then((r) => r.json()).then(applyState);

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'state') applyState(msg.payload);
  };
  ws.onclose = () => setTimeout(connect, 2000);
}
connect();
