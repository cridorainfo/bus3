// AdKerala Admin — plain fetch-based SPA, no build step (same "deliberately light" approach
// as the Hub's own frontends). Three top tabs: Buses, Routes, Content (which itself has four
// sub-sections: Announcement Audio, Stop Names, Banner Ads, Full-Screen Ads).

const state = {
  routes: [],
  buses: [],
  content: [],
  releases: [],
  pendingPairings: [],
  expandedRouteId: null,
  editingRouteId: null,
};

// --- Top-level tabs ---
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// --- Content sub-tabs ---
document.querySelectorAll('.subtab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.subtab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.subtab-panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`subtab-${tab.dataset.subtab}`).classList.add('active');
  });
});

// Both name fields, always shown plainly — no display-language mode to switch between.
function bothNames(obj) {
  if (!obj) return '';
  const en = obj.name ?? obj.name_en ?? '';
  const ml = obj.name_ml ?? '';
  if (en && ml) return `${en} · ${ml}`;
  return en || ml;
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body instanceof FormData ? options.headers : { 'Content-Type': 'application/json', ...options.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || body.error || `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

let searchDebounceTimer = null;
function debouncedSearchStops(query, cb) {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(async () => {
    const results = await api(`/api/stops/search?q=${encodeURIComponent((query || '').trim())}`);
    cb(results);
  }, 250);
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===================== BUSES =====================

async function loadBuses() {
  state.buses = await api('/api/buses');
  renderBuses();
  populatePairBusSelect();
  loadPendingPairings();
}

// Hubs currently broadcasting a pairing ID, waiting to be claimed — listing these lets the admin
// click a real, live ID instead of retyping it off the bus's screen (the likeliest cause of an
// "unknown_pairing_id" error is a misread/typo, or an ID copied from a different environment).
async function loadPendingPairings() {
  state.pendingPairings = await api('/api/pair/pending');
  renderPendingPairings();
}

function timeAgo(isoLikeString) {
  const then = new Date(isoLikeString.replace(' ', 'T') + 'Z').getTime();
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

function renderPendingPairings() {
  const wrap = document.getElementById('pending-pairing-list');
  if (state.pendingPairings.length === 0) {
    wrap.innerHTML = '<div class="hint">No bus is currently waiting to be paired.</div>';
    return;
  }
  wrap.innerHTML = `<div class="hint">Waiting to be paired — click one to fill it in above:</div>`;
  for (const p of state.pendingPairings) {
    const chip = el(`<button type="button" class="pending-pairing-chip">${escapeHtml(p.device_pairing_id)} <span>· ${timeAgo(p.created_at)}</span></button>`);
    chip.addEventListener('click', () => {
      document.getElementById('pair-device-id').value = p.device_pairing_id;
    });
    wrap.appendChild(chip);
  }
}

function renderBuses() {
  const list = document.getElementById('bus-list');
  list.innerHTML = '';
  if (state.buses.length === 0) {
    list.appendChild(el(`<div class="empty-state">No buses yet — add one above.</div>`));
    return;
  }
  for (const bus of state.buses) {
    const tripInfo = bus.trip_active
      ? `<div class="bus-trip">Trip active — stop #${bus.current_stop_index ?? '?'} (${bus.current_direction || 'going'})</div>`
      : '';
    const assignedIds = new Set(bus.assigned_routes.map((r) => r.route_id));

    const connectValue = bus.connect_code
      ? `<span class="cred-value">${escapeHtml(bus.connect_code)}</span>`
      : `<span class="cred-sub">not set</span>`;

    const awaitingPairing = !bus.paired_at;
    const statusDotClass = bus.online ? 'online' : (awaitingPairing ? 'awaiting' : '');
    const statusText = bus.online
      ? 'online now'
      : awaitingPairing
        ? '<span class="awaiting-pairing-badge">Awaiting pairing</span>'
        : (bus.last_seen_at ? 'last seen ' + bus.last_seen_at : 'never connected');

    const card = el(`
      <div class="card bus-card" data-bus-id="${bus.bus_id}">
        <div class="bus-main">
          <span class="status-dot ${statusDotClass}" title="${bus.online ? 'Online' : awaitingPairing ? 'Awaiting pairing' : 'Offline'}"></span>
          <div>
            <div class="bus-reg">${escapeHtml(bus.friendly_name || bus.reg_number)}</div>
            ${bus.friendly_name ? `<div class="bus-reg-sub">${escapeHtml(bus.reg_number)}</div>` : ''}
            <div class="bus-meta">${bus.tier} · ${statusText}${bus.route_name ? ' · running ' + escapeHtml(bus.route_name) : ''}</div>
            ${tripInfo}
          </div>
        </div>
        <div class="bus-actions">
          ${awaitingPairing ? '' : '<button class="btn btn-ghost btn-small unpair-bus-btn">Disconnect from Server</button>'}
          <button class="btn btn-danger btn-small remove-bus-btn">Remove</button>
        </div>
      </div>
    `);

    const credsWrap = el(`
      <div class="credentials-wrap">
        <div class="cred-row">
          <span class="cred-label" title="Persistent code a driver/conductor's phone uses to connect — stays valid until you regenerate it">Connect code</span>
          ${connectValue}
          <button class="btn btn-ghost btn-small gen-connect-code">${bus.connect_code ? 'Regenerate' : 'Generate'}</button>
        </div>
        <button class="btn btn-danger btn-small disconnect-devices-btn">Disconnect All Devices</button>
      </div>
    `);

    credsWrap.querySelector('.gen-connect-code').addEventListener('click', async () => {
      const result = await api(`/api/buses/${bus.bus_id}/connect-code`, { method: 'POST' });
      alert(`Connect code for ${bus.reg_number}: ${result.connect_code}\n\nTell this to the driver/conductor for the Control Panel's connect screen.`);
      loadBuses();
    });
    credsWrap.querySelector('.disconnect-devices-btn').addEventListener('click', async () => {
      if (!confirm(`Disconnect every phone currently paired to ${bus.reg_number}? Takes effect next time this bus's Hub is online.`)) return;
      await api(`/api/buses/${bus.bus_id}/disconnect-devices`, { method: 'POST' });
      alert('Done — every paired phone on this bus will need the connect code again once the Hub is next online.');
    });

    const routesWrap = el(`<div class="bus-routes-wrap"><div class="label">Assigned routes</div><div class="bus-routes-list"></div></div>`);
    const routesList = routesWrap.querySelector('.bus-routes-list');
    if (state.routes.length === 0) {
      routesList.appendChild(el(`<div class="hint">No routes exist yet — add one in the Routes tab.</div>`));
    } else {
      for (const route of state.routes) {
        const checked = assignedIds.has(route.route_id);
        const row = el(`
          <label class="route-check-row">
            <input type="checkbox" ${checked ? 'checked' : ''} />
            <span>${escapeHtml(bothNames(route))}</span>
          </label>
        `);
        row.querySelector('input').addEventListener('change', async (e) => {
          if (e.target.checked) {
            await api(`/api/buses/${bus.bus_id}/routes`, { method: 'POST', body: JSON.stringify({ route_id: route.route_id }) });
          } else {
            await api(`/api/buses/${bus.bus_id}/routes/${route.route_id}`, { method: 'DELETE' });
          }
          loadBuses();
        });
        routesList.appendChild(row);
      }
    }

    const unpairBtn = card.querySelector('.unpair-bus-btn');
    if (unpairBtn) {
      unpairBtn.addEventListener('click', async () => {
        if (!confirm(`Disconnect ${bus.friendly_name || bus.reg_number} from the server? Its Hub will show a new pairing ID (once any trip in progress ends), and every phone currently connected to it will be disconnected. Its routes, name, and connect code all stay — pair it again whenever you're ready.`)) return;
        await api(`/api/buses/${bus.bus_id}/unpair`, { method: 'POST' });
        loadBuses();
      });
    }

    card.querySelector('.remove-bus-btn').addEventListener('click', async () => {
      if (!confirm(`Remove bus ${bus.friendly_name || bus.reg_number}? This deletes it entirely (routes assignments, connect code, history) — its Hub will be disconnected immediately and show a new pairing ID, and every phone connected to it will be disconnected too.`)) return;
      await api(`/api/buses/${bus.bus_id}`, { method: 'DELETE' });
      loadBuses();
    });

    card.appendChild(credsWrap);
    card.appendChild(routesWrap);
    list.appendChild(card);
  }
}

document.getElementById('form-add-bus').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/buses', {
    method: 'POST',
    body: JSON.stringify({
      friendly_name: document.getElementById('bus-name').value,
      reg_number: document.getElementById('bus-reg').value,
      tier: document.getElementById('bus-tier').value,
      hardware_version: document.getElementById('bus-hw').value,
    }),
  });
  document.getElementById('form-add-bus').reset();
  loadBuses();
});

// --- Pair a Bus: the Hub generates and shows its own pairing ID (no keyboard needed at the
// unattended kiosk PC) — the admin reads that ID and picks which bus record it links to. ---
function populatePairBusSelect() {
  const sel = document.getElementById('pair-bus-select');
  // Preserve the current selection only if it's still a valid option after refresh — restoring
  // a stale/empty value here deselects everything (a select's .value doesn't fall back to the
  // first option when set to something that matches no option).
  const current = sel.value;
  sel.innerHTML = state.buses.map((b) => `<option value="${b.bus_id}">${escapeHtml(b.friendly_name || b.reg_number)} (${escapeHtml(b.reg_number)})</option>`).join('');
  if (state.buses.some((b) => b.bus_id === current)) sel.value = current;
}

document.getElementById('form-pair-bus').addEventListener('submit', async (e) => {
  e.preventDefault();
  const hint = document.getElementById('pair-hint');
  hint.textContent = 'Pairing…';
  hint.className = 'hint';
  try {
    await api('/api/pair/claim', {
      method: 'POST',
      body: JSON.stringify({
        device_pairing_id: document.getElementById('pair-device-id').value.trim().toUpperCase(),
        bus_id: document.getElementById('pair-bus-select').value,
      }),
    });
    document.getElementById('form-pair-bus').reset();
    hint.textContent = 'Paired — the bus should pick this up within a few seconds.';
    hint.className = 'hint success';
    loadBuses();
  } catch (err) {
    hint.textContent = err.message;
    hint.className = 'hint error';
  }
});

// ===================== ROUTES =====================

async function loadRoutes() {
  state.routes = await api('/api/routes');
  renderRoutes();
  renderBuses(); // route list feeds the assigned-routes checklist
  populateRouteSelects();
}

function renderRoutes() {
  const list = document.getElementById('route-list');
  list.innerHTML = '';
  if (state.routes.length === 0) {
    list.appendChild(el(`<div class="empty-state">No routes yet — add one above.</div>`));
    return;
  }
  for (const route of state.routes) {
    const isEditing = state.editingRouteId === route.route_id;

    const headInfo = isEditing
      ? `
        <form class="edit-route-form">
          <div class="field"><label>Name (English)</label><input type="text" class="edit-route-name" value="${escapeHtml(route.name)}" required /></div>
          <div class="field"><label>Name (Malayalam)</label><input type="text" class="edit-route-name-ml" value="${escapeHtml(route.name_ml || '')}" /></div>
          <div class="field">
            <label>Tier</label>
            <select class="edit-route-tier">
              <option value="rural" ${route.tier === 'rural' ? 'selected' : ''}>Rural</option>
              <option value="urban_standard" ${route.tier === 'urban_standard' ? 'selected' : ''}>Urban standard</option>
              <option value="urban_women_premium" ${route.tier === 'urban_women_premium' ? 'selected' : ''}>Urban women-premium</option>
            </select>
          </div>
          <div class="bus-actions">
            <button type="submit" class="btn btn-primary btn-small">Save</button>
            <button type="button" class="btn btn-ghost btn-small cancel-edit-route">Cancel</button>
          </div>
        </form>
      `
      : `
        <div>
          <div class="route-title">${escapeHtml(bothNames(route))}</div>
          <div class="route-meta">${route.tier} · ${route.stop_count} stops · ${route.bus_count} bus(es) assigned</div>
        </div>
      `;

    const card = el(`
      <div class="card" data-route-id="${route.route_id}">
        <div class="route-card-head">
          ${headInfo}
          <div class="bus-actions">
            ${isEditing ? '' : '<button class="btn btn-ghost btn-small edit-route">Edit</button>'}
            <button class="btn btn-ghost btn-small toggle-stops">${state.expandedRouteId === route.route_id ? 'Hide stops' : 'Manage stops'}</button>
            <button class="btn btn-danger btn-small delete-route">Delete</button>
          </div>
        </div>
        <div class="stop-editor-mount"></div>
      </div>
    `);

    if (isEditing) {
      const form = card.querySelector('.edit-route-form');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api(`/api/routes/${route.route_id}`, {
            method: 'PUT',
            body: JSON.stringify({
              name: form.querySelector('.edit-route-name').value,
              name_ml: form.querySelector('.edit-route-name-ml').value,
              tier: form.querySelector('.edit-route-tier').value,
            }),
          });
          state.editingRouteId = null;
          loadRoutes();
        } catch (err) {
          alert(err.message);
        }
      });
      card.querySelector('.cancel-edit-route').addEventListener('click', () => {
        state.editingRouteId = null;
        renderRoutes();
      });
    } else {
      card.querySelector('.edit-route').addEventListener('click', () => {
        state.editingRouteId = route.route_id;
        renderRoutes();
      });
    }

    card.querySelector('.toggle-stops').addEventListener('click', () => {
      state.expandedRouteId = state.expandedRouteId === route.route_id ? null : route.route_id;
      renderRoutes();
    });
    card.querySelector('.delete-route').addEventListener('click', async () => {
      if (!confirm(`Delete route "${bothNames(route)}"?`)) return;
      try {
        await api(`/api/routes/${route.route_id}`, { method: 'DELETE' });
        loadRoutes();
      } catch (err) {
        alert(err.message);
      }
    });

    list.appendChild(card);

    if (state.expandedRouteId === route.route_id) {
      renderStopEditor(card.querySelector('.stop-editor-mount'), route.route_id);
    }
  }
}

async function renderStopEditor(mount, routeId) {
  const routeDetail = await api(`/api/routes/${routeId}`);
  const stops = routeDetail.stops;

  mount.innerHTML = '';
  const editor = el(`<div class="stop-editor"></div>`);

  if (stops.length === 0) {
    editor.appendChild(el(`<div class="empty-state">No stops yet — find or create one below.</div>`));
  }

  stops.forEach((stop, idx) => {
    // Ads are managed from Content > Stop Names now — this is a read-only status badge so
    // there's exactly one place that toggles it.
    const adsBadge = stop.has_ad_clip
      ? `<span class="also-used-badge ${stop.ads_enabled ? 'ads-on' : ''}">Ads: ${stop.ads_enabled ? 'on' : 'off'}</span>`
      : '';
    const row = el(`
      <div class="stop-row" data-stop-id="${stop.stop_id}">
        <div class="stop-seq">${idx + 1}</div>
        <div class="stop-names">
          <div class="stop-name-ml">${escapeHtml(bothNames({ name: stop.name_en, name_ml: stop.name_ml }))}</div>
        </div>
        ${adsBadge}
        <div class="stop-row-actions">
          <button class="icon-btn move-up" title="Move up" ${idx === 0 ? 'disabled' : ''}>↑</button>
          <button class="icon-btn move-down" title="Move down" ${idx === stops.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="icon-btn remove-stop" title="Unlink from this route">✕</button>
        </div>
      </div>
    `);

    row.querySelector('.move-up').addEventListener('click', async () => {
      const order = stops.map((s) => s.stop_id);
      [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
      await api(`/api/routes/${routeId}/stops/reorder`, { method: 'POST', body: JSON.stringify({ order }) });
      loadRoutes();
    });
    row.querySelector('.move-down').addEventListener('click', async () => {
      const order = stops.map((s) => s.stop_id);
      [order[idx + 1], order[idx]] = [order[idx], order[idx + 1]];
      await api(`/api/routes/${routeId}/stops/reorder`, { method: 'POST', body: JSON.stringify({ order }) });
      loadRoutes();
    });
    row.querySelector('.remove-stop').addEventListener('click', async () => {
      await api(`/api/routes/${routeId}/stops/${stop.stop_id}`, { method: 'DELETE' });
      loadRoutes();
    });

    editor.appendChild(row);
  });

  editor.appendChild(buildStopPicker(routeId, stops.map((s) => s.stop_id)));
  mount.appendChild(editor);
}

// The "find or link a stop" UX: search across every stop (any route), link an existing one
// with all its recorded audio intact, or fall back to creating a genuinely new one. A stop
// created here shows up in Content > Stop Names immediately — same global `stops` table.
function buildStopPicker(routeId, alreadyLinkedIds) {
  const wrap = el(`
    <div class="stop-picker">
      <div class="field">
        <label>Find or link a stop</label>
        <input type="text" class="stop-search-input" placeholder="Type a stop name…" autocomplete="off" />
      </div>
      <div class="search-results"></div>
      <span class="create-stop-toggle">+ Create a brand-new stop instead</span>
      <form class="create-stop-form">
        <div class="field"><label>Malayalam name</label><input type="text" class="new-stop-ml" required /></div>
        <div class="field"><label>English name (optional)</label><input type="text" class="new-stop-en" /></div>
        <button type="submit" class="btn btn-primary btn-small">Create + add</button>
      </form>
    </div>
  `);

  const resultsEl = wrap.querySelector('.search-results');
  const searchInput = wrap.querySelector('.stop-search-input');
  const createToggle = wrap.querySelector('.create-stop-toggle');
  const createForm = wrap.querySelector('.create-stop-form');

  searchInput.addEventListener('input', () => {
    if (searchInput.value.trim().length < 2) {
      resultsEl.innerHTML = '';
      return;
    }
    debouncedSearchStops(searchInput.value, (results) => {
      resultsEl.innerHTML = '';
      for (const stop of results) {
        const already = alreadyLinkedIds.includes(stop.stop_id);
        const usedElsewhere = stop.used_by_routes.filter((r) => r.route_id !== routeId);
        const row = el(`
          <div class="search-result-row">
            <div>
              <span class="search-result-name">${escapeHtml(bothNames({ name: stop.name_en, name_ml: stop.name_ml }))}</span>
              ${usedElsewhere.length ? `<span class="also-used-badge">also used by ${usedElsewhere.length} other route(s)</span>` : ''}
            </div>
            <button class="btn btn-ghost btn-small link-stop-btn" ${already ? 'disabled' : ''}>${already ? 'Already linked' : 'Link'}</button>
          </div>
        `);
        row.querySelector('.link-stop-btn').addEventListener('click', async () => {
          await api(`/api/routes/${routeId}/stops`, { method: 'POST', body: JSON.stringify({ mode: 'link', stop_id: stop.stop_id }) });
          loadRoutes();
        });
        resultsEl.appendChild(row);
      }
    });
  });

  createToggle.addEventListener('click', () => {
    createForm.classList.toggle('open');
  });

  createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await api(`/api/routes/${routeId}/stops`, {
      method: 'POST',
      body: JSON.stringify({
        mode: 'create',
        name_ml: createForm.querySelector('.new-stop-ml').value,
        name_en: createForm.querySelector('.new-stop-en').value,
      }),
    });
    loadRoutes();
  });

  return wrap;
}

document.getElementById('form-add-route').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/routes', {
    method: 'POST',
    body: JSON.stringify({
      name: document.getElementById('route-name').value,
      name_ml: document.getElementById('route-name-ml').value,
      tier: document.getElementById('route-tier').value,
    }),
  });
  document.getElementById('form-add-route').reset();
  loadRoutes();
});

function populateRouteSelects() {
  const opts = '<option value="">— Global —</option>' + state.routes.map((r) => `<option value="${r.route_id}">${escapeHtml(bothNames(r))}</option>`).join('');
  for (const id of ['banner-route', 'fullscreen-route']) {
    const sel = document.getElementById(id);
    const current = sel.value;
    sel.innerHTML = opts;
    sel.value = current;
  }
}

// ===================== CONTENT =====================

async function loadContent() {
  state.content = await api('/api/content');
  renderAnnouncementList();
  renderBannerList();
  renderFullscreenList();
}

function previewFor(item) {
  const url = `/content/${item.file_path}`;
  const isVideo = /\.(mp4|webm)$/i.test(item.file_path);
  const isImage = /\.(png|jpe?g|webp)$/i.test(item.file_path);
  if (isVideo) return `<video class="preview" controls src="${url}"></video>`;
  if (isImage) return `<img class="preview" src="${url}" alt="" style="max-height:60px;border-radius:8px" />`;
  return `<audio controls src="${url}"></audio>`;
}

function contentCard(item, { scopeLabel }) {
  const card = el(`
    <div class="card content-card" data-content-id="${item.content_id}">
      <div class="content-main">
        <span class="badge">${item.type.replace('_', ' ')}</span>
        <div>
          <div class="content-title">${escapeHtml(item.original_filename || item.content_id)}</div>
          <div class="content-meta">${escapeHtml(scopeLabel)}${item.tier ? ' · ' + item.tier : ''}</div>
        </div>
        ${previewFor(item)}
      </div>
      <button class="btn btn-danger btn-small">Delete</button>
    </div>
  `);
  card.querySelector('.btn-danger').addEventListener('click', async () => {
    if (!confirm('Delete this content item?')) return;
    await api(`/api/content/${item.content_id}`, { method: 'DELETE' });
    loadContent();
  });
  return card;
}

// --- Announcement Audio (chime / filler / outro — global, shared by every stop) ---

function renderAnnouncementList() {
  const list = document.getElementById('announcement-list');
  list.innerHTML = '';
  const items = state.content.filter((c) => ['chime', 'filler', 'outro'].includes(c.type));
  if (items.length === 0) {
    list.appendChild(el(`<div class="empty-state">No announcement clips uploaded yet.</div>`));
    return;
  }
  for (const item of items) {
    list.appendChild(contentCard(item, { scopeLabel: 'Global · every announcement' }));
  }
}

document.getElementById('form-add-announcement').addEventListener('submit', async (e) => {
  e.preventDefault();
  const hint = document.getElementById('announcement-upload-hint');
  hint.textContent = 'Uploading…';
  hint.className = 'hint';
  const fd = new FormData();
  fd.append('type', document.getElementById('announcement-type').value);
  fd.append('file', document.getElementById('announcement-file').files[0]);
  try {
    await api('/api/content', { method: 'POST', body: fd });
    document.getElementById('form-add-announcement').reset();
    hint.textContent = 'Uploaded — if there was already a clip in this slot, delete the old one below so only one plays.';
    hint.className = 'hint success';
    loadContent();
  } catch (err) {
    hint.textContent = err.message;
    hint.className = 'hint error';
  }
});

// --- Stop Names: searchable directory of every global stop ---

let stopDirectoryResults = []; // last text-search result set, before the audio/ads/Malayalam filters below

async function loadStopDirectory(query) {
  stopDirectoryResults = await api(`/api/stops/search?q=${encodeURIComponent(query || '')}`);
  renderFilteredStopDirectory();
}

// Filtering happens client-side against the already-fetched search results — the fields these
// checks need (has_audio_clip, ads_enabled, name_ml) are already in every row, so there's no
// reason to round-trip to the server just because a filter dropdown changed.
function renderFilteredStopDirectory() {
  const audioFilter = document.getElementById('stopnames-filter-audio').value;
  const adsFilter = document.getElementById('stopnames-filter-ads').value;
  const mlFilter = document.getElementById('stopnames-filter-ml').value;

  const filtered = stopDirectoryResults.filter((stop) => {
    if (audioFilter === 'missing' && stop.has_audio_clip) return false;
    if (audioFilter === 'has' && !stop.has_audio_clip) return false;
    if (adsFilter === 'on' && !stop.ads_enabled) return false;
    if (adsFilter === 'off' && stop.ads_enabled) return false;
    if (mlFilter === 'missing' && stop.name_ml && stop.name_ml.trim()) return false;
    if (mlFilter === 'has' && !(stop.name_ml && stop.name_ml.trim())) return false;
    return true;
  });

  renderStopDirectory(filtered);
}

for (const id of ['stopnames-filter-audio', 'stopnames-filter-ads', 'stopnames-filter-ml']) {
  document.getElementById(id).addEventListener('change', renderFilteredStopDirectory);
}

function renderStopDirectory(stops) {
  const list = document.getElementById('stopnames-list');
  list.innerHTML = '';
  if (stops.length === 0) {
    list.appendChild(el(`<div class="empty-state">No stops match — create one from the Routes tab.</div>`));
    return;
  }
  for (const stop of stops) {
    const usedBy = stop.used_by_routes.map((r) => r.name).join(', ') || 'not linked to any route yet';
    const row = el(`
      <div class="card stopname-row" data-stop-id="${stop.stop_id}">
        <div class="stopname-head">
          <div>
            <div class="content-title">${escapeHtml(bothNames({ name: stop.name_en, name_ml: stop.name_ml }))}</div>
            <div class="content-meta">Used by: ${escapeHtml(usedBy)}</div>
          </div>
          <div class="ads-toggle-wrap">
            <label class="switch" title="${stop.has_ad_clip ? 'Swap in the ad clip for this stop' : 'Upload an ad clip first'}">
              <input type="checkbox" class="ads-toggle" ${stop.ads_enabled ? 'checked' : ''} ${stop.has_ad_clip ? '' : 'disabled'} />
              <span class="slider"></span>
            </label>
            Ads
          </div>
        </div>
        <div class="stopname-clips">
          <div class="clip-slot" data-slot="stop_name">
            <div class="label">Stop name (plain)</div>
            <div class="clip-current"></div>
            <input type="file" class="clip-file" />
            <button type="button" class="btn btn-ghost btn-small clip-upload">Upload</button>
          </div>
          <div class="clip-slot" data-slot="stop_name_ad">
            <div class="label">Stop name (with ad)</div>
            <div class="clip-current"></div>
            <input type="file" class="clip-file" />
            <button type="button" class="btn btn-ghost btn-small clip-upload">Upload</button>
          </div>
        </div>
      </div>
    `);

    row.querySelector('.ads-toggle').addEventListener('change', async (e) => {
      await api(`/api/stops/${stop.stop_id}/toggle-ads`, { method: 'POST', body: JSON.stringify({ enabled: e.target.checked }) });
      loadStopDirectory(document.getElementById('stopnames-search').value);
    });

    const existingForType = (type) => state.content.find((c) => c.stop_id === stop.stop_id && c.type === type);
    row.querySelectorAll('.clip-slot').forEach((slotEl) => {
      const slotType = slotEl.dataset.slot;
      const existing = existingForType(slotType);
      const currentEl = slotEl.querySelector('.clip-current');
      currentEl.innerHTML = existing ? previewFor(existing) : '<span class="hint">Not uploaded yet</span>';

      slotEl.querySelector('.clip-upload').addEventListener('click', async () => {
        const fileInput = slotEl.querySelector('.clip-file');
        if (!fileInput.files[0]) return;
        const fd = new FormData();
        fd.append('type', slotType);
        fd.append('stop_id', stop.stop_id);
        fd.append('file', fileInput.files[0]);
        await api('/api/content', { method: 'POST', body: fd });
        state.content = await api('/api/content');
        loadStopDirectory(document.getElementById('stopnames-search').value);
      });
    });

    list.appendChild(row);
  }
}

let stopnamesDebounce = null;
document.getElementById('stopnames-search').addEventListener('input', (e) => {
  clearTimeout(stopnamesDebounce);
  const q = e.target.value;
  stopnamesDebounce = setTimeout(() => loadStopDirectory(q), 250);
});

// --- Banner Ads ---

function renderBannerList() {
  const list = document.getElementById('banner-list');
  list.innerHTML = '';
  const items = state.content.filter((c) => c.type === 'ad_banner');
  if (items.length === 0) {
    list.appendChild(el(`<div class="empty-state">No banner ads uploaded yet.</div>`));
    return;
  }
  for (const item of items) {
    list.appendChild(contentCard(item, { scopeLabel: item.route_name || 'Global' }));
  }
}

document.getElementById('form-add-banner').addEventListener('submit', async (e) => {
  e.preventDefault();
  const hint = document.getElementById('banner-upload-hint');
  hint.textContent = 'Uploading…';
  hint.className = 'hint';
  const fd = new FormData();
  fd.append('type', 'ad_banner');
  fd.append('route_id', document.getElementById('banner-route').value);
  fd.append('tier', document.getElementById('banner-tier').value);
  fd.append('file', document.getElementById('banner-file').files[0]);
  try {
    await api('/api/content', { method: 'POST', body: fd });
    document.getElementById('form-add-banner').reset();
    hint.textContent = 'Uploaded — pushed live to matching buses that are online.';
    hint.className = 'hint success';
    loadContent();
  } catch (err) {
    hint.textContent = err.message;
    hint.className = 'hint error';
  }
});

// --- Full-Screen (Video) Ads ---

function renderFullscreenList() {
  const list = document.getElementById('fullscreen-list');
  list.innerHTML = '';
  const items = state.content.filter((c) => ['ad_video', 'music'].includes(c.type));
  if (items.length === 0) {
    list.appendChild(el(`<div class="empty-state">No full-screen ads uploaded yet.</div>`));
    return;
  }
  for (const item of items) {
    list.appendChild(contentCard(item, { scopeLabel: item.route_name || 'Global' }));
  }
}

document.getElementById('form-add-fullscreen').addEventListener('submit', async (e) => {
  e.preventDefault();
  const hint = document.getElementById('fullscreen-upload-hint');
  hint.textContent = 'Uploading…';
  hint.className = 'hint';
  const fd = new FormData();
  fd.append('type', document.getElementById('fullscreen-type').value);
  fd.append('route_id', document.getElementById('fullscreen-route').value);
  fd.append('tier', document.getElementById('fullscreen-tier').value);
  fd.append('file', document.getElementById('fullscreen-file').files[0]);
  try {
    await api('/api/content', { method: 'POST', body: fd });
    document.getElementById('form-add-fullscreen').reset();
    hint.textContent = 'Uploaded — pushed live to matching buses that are online.';
    hint.className = 'hint success';
    loadContent();
  } catch (err) {
    hint.textContent = err.message;
    hint.className = 'hint error';
  }
});

// ===================== UPDATES (Hub software releases) =====================

async function loadReleases() {
  state.releases = await api('/api/hub-releases');
  renderReleases();
}

function renderReleases() {
  const list = document.getElementById('release-list');
  list.innerHTML = '';
  if (state.releases.length === 0) {
    list.appendChild(el(`<div class="empty-state">No releases uploaded yet.</div>`));
    return;
  }
  for (const release of state.releases) {
    const card = el(`
      <div class="card content-card" data-version="${escapeHtml(release.version)}">
        <div class="content-main">
          <span class="badge ${release.published ? 'badge-live' : ''}">${release.published ? 'Published' : 'Staged'}</span>
          <div>
            <div class="content-title">v${escapeHtml(release.version)}</div>
            <div class="content-meta">${escapeHtml(release.notes || 'No notes')} · uploaded ${escapeHtml(release.created_at)}</div>
            <div class="content-meta">sha256 ${escapeHtml(release.checksum_sha256.slice(0, 16))}…</div>
          </div>
        </div>
        <div class="bus-actions">
          <button class="btn btn-ghost btn-small toggle-publish-btn">${release.published ? 'Unpublish' : 'Publish'}</button>
          <button class="btn btn-danger btn-small delete-release-btn">Delete</button>
        </div>
      </div>
    `);

    card.querySelector('.toggle-publish-btn').addEventListener('click', async () => {
      const action = release.published ? 'unpublish' : 'publish';
      await api(`/api/hub-releases/${release.version}/${action}`, { method: 'POST' });
      loadReleases();
    });
    card.querySelector('.delete-release-btn').addEventListener('click', async () => {
      if (!confirm(`Delete release v${release.version}? Buses already running it are unaffected.`)) return;
      await api(`/api/hub-releases/${release.version}`, { method: 'DELETE' });
      loadReleases();
    });

    list.appendChild(card);
  }
}

document.getElementById('form-add-release').addEventListener('submit', async (e) => {
  e.preventDefault();
  const hint = document.getElementById('release-upload-hint');
  hint.textContent = 'Uploading…';
  hint.className = 'hint';
  const fd = new FormData();
  fd.append('version', document.getElementById('release-version').value.trim());
  fd.append('notes', document.getElementById('release-notes').value);
  fd.append('file', document.getElementById('release-file').files[0]);
  try {
    await api('/api/hub-releases', { method: 'POST', body: fd });
    document.getElementById('form-add-release').reset();
    hint.textContent = 'Uploaded as a staged release — click Publish when you want buses to pick it up.';
    hint.className = 'hint success';
    loadReleases();
  } catch (err) {
    hint.textContent = err.message;
    hint.className = 'hint error';
  }
});

// ===================== Boot =====================

async function refreshAll() {
  await loadRoutes();
  await loadBuses();
  await loadContent();
  await loadReleases();
  loadStopDirectory(''); // browse-all by default — a stop created via Routes shows up immediately
}

refreshAll();
setInterval(loadBuses, 5000); // live-ish fleet status without a second WebSocket on the admin side
