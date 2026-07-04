// AdKerala Control Panel — used by either driver or conductor (spec 7.1). Tab bar navigates
// between screens; a shared per-bus-per-day PIN gates only the actions that change state
// (start/end trip, corrections, mute) — viewing status/identity never requires it.

let latestState = null;
let stopsCache = { routeId: null, contentVersion: -1, stops: [] };
let pendingAction = null;
let pinBuffer = '';
let selectedDirection = localStorage.getItem('adkerala_direction') === 'return' ? 'return' : 'going';

const els = {
  regNumber: document.getElementById('reg-number'),
  routeName: document.getElementById('route-name'),
  esp32Pill: document.getElementById('esp32-pill'),
  netPill: document.getElementById('net-pill'),
  currentStopName: document.getElementById('current-stop-name'),
  tripHint: document.getElementById('trip-hint'),
  stopList: document.getElementById('stop-list'),
  muteBtn: document.getElementById('btn-mute-toggle'),
  issueText: document.getElementById('issue-text'),
  issueHint: document.getElementById('issue-hint'),
  pinOverlay: document.getElementById('pin-overlay'),
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

// --- PIN overlay ---
function showPinOverlay(onVerified) {
  pendingAction = onVerified;
  pinBuffer = '';
  els.pinError.textContent = '';
  renderPinBuffer();
  els.pinOverlay.classList.remove('hidden');
}

function hidePinOverlay() {
  els.pinOverlay.classList.add('hidden');
  pendingAction = null;
}

function renderPinBuffer() {
  const slots = ['—', '—', '—', '—'];
  for (let i = 0; i < pinBuffer.length; i++) slots[i] = '•';
  els.pinDisplay.textContent = slots.join(' ');
}

document.querySelectorAll('.keypad button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.key;
    if (key === 'clear') pinBuffer = '';
    else if (key === 'back') pinBuffer = pinBuffer.slice(0, -1);
    else if (pinBuffer.length < 4) pinBuffer += key;
    renderPinBuffer();
    if (pinBuffer.length === 4) submitPin();
  });
});

async function submitPin() {
  const pin = pinBuffer;
  const res = await fetch('/api/auth/verify-pin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  if (res.ok) {
    sessionStorage.setItem('adkerala_pin', pin);
    const action = pendingAction;
    hidePinOverlay();
    if (action) action(pin);
  } else {
    els.pinError.textContent = 'Wrong PIN, try again';
    pinBuffer = '';
    renderPinBuffer();
  }
}

// Runs a state-changing action with the cached PIN, falling back to the keypad if there is
// none cached yet or the server rejects it (e.g. the day rolled over to a new PIN).
async function runProtected(fn) {
  const cached = sessionStorage.getItem('adkerala_pin');
  if (cached) {
    const res = await fn(cached);
    if (res && res.status === 401) {
      sessionStorage.removeItem('adkerala_pin');
      showPinOverlay((pin) => fn(pin));
    }
    return;
  }
  showPinOverlay((pin) => fn(pin));
}

function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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
document.getElementById('btn-start-trip').addEventListener('click', () => {
  runProtected((pin) => postJson('/api/trip/start', { pin, direction: selectedDirection }));
});

document.getElementById('btn-end-trip').addEventListener('click', () => {
  runProtected((pin) => postJson('/api/trip/end', { pin }));
});

els.muteBtn.addEventListener('click', () => {
  const nextMuted = !(latestState && latestState.muted);
  runProtected((pin) => postJson('/api/trip/mute', { pin, muted: nextMuted }));
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
  els.regNumber.textContent = state.bus.reg_number || '—';
  els.routeName.textContent = state.bus.route_assigned ? (state.bus.route_name || `Route ${state.bus.route_assigned}`) : 'No route assigned';
}

function renderStatusPills(state) {
  const esp32Ok = state.esp32 && state.esp32.connected;
  els.esp32Pill.textContent = `ESP32 ${esp32Ok ? '✓' : '✗'}`;
  els.esp32Pill.className = `status-pill ${esp32Ok ? 'ok' : 'bad'}`;

  els.netPill.textContent = 'Internet —'; // stubbed until Phase 2 sync engine exists
  els.netPill.className = 'status-pill';
}

function renderTrip(state) {
  if (!state.trip) {
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

function renderStopList(state) {
  els.stopList.innerHTML = '';
  if (!state.trip || stopsCache.stops.length === 0) {
    els.stopList.innerHTML = '<div class="hint">Start a trip to enable corrections</div>';
    return;
  }
  stopsCache.stops.forEach((stop, idx) => {
    const row = document.createElement('div');
    row.className = 'stop-row' + (idx === state.trip.current_stop_index ? ' current' : '');
    row.innerHTML = `<span>${stop.name_ml}</span>`;
    const btn = document.createElement('button');
    btn.textContent = 'Jump';
    btn.addEventListener('click', () => {
      runProtected((pin) => postJson('/api/trip/jump', { pin, index: idx }));
    });
    row.appendChild(btn);
    els.stopList.appendChild(row);
  });
}

function renderMute(state) {
  els.muteBtn.textContent = state.muted ? 'Unmute' : 'Mute';
  els.muteBtn.classList.toggle('red', !!state.muted);
}

async function ensureStopsLoaded(trip, contentVersion) {
  if (!trip) return;
  const upToDate = stopsCache.routeId === trip.route_id && stopsCache.contentVersion === contentVersion && stopsCache.stops.length > 0;
  if (upToDate) return;
  const res = await fetch('/api/trip/state');
  const data = await res.json();
  stopsCache = { routeId: trip.route_id, contentVersion, stops: data.stops || [] };
}

async function applyState(state) {
  latestState = state;
  await ensureStopsLoaded(state.trip, state.contentVersion);
  renderIdentity(state);
  renderStatusPills(state);
  renderTrip(state);
  renderStopList(state);
  renderMute(state);
  renderDirectionToggle();
}

// --- Initial load + live updates ---
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
