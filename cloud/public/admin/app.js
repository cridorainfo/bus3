// AdKerala Admin — plain fetch-based SPA, no build step (same "deliberately light" approach
// as the Hub's own frontends). Three tabs: Buses, Routes, Content.

const state = {
  routes: [],
  buses: [],
  content: [],
  expandedRouteId: null,
  createStopOpen: {}, // routeId -> bool, whether the "+ Create new stop" fallback form is open
  displayLang: localStorage.getItem('adkerala_admin_lang') || 'en',
};

// --- Tabs ---
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// --- Language toggle: switches every displayed route/stop name between English and Malayalam.
// Purely a display preference (localStorage) — both fields are always still editable/stored. ---
document.querySelectorAll('#lang-toggle .segment').forEach((btn) => {
  btn.classList.toggle('active', btn.dataset.lang === state.displayLang);
});
document.querySelectorAll('#lang-toggle .segment').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.displayLang = btn.dataset.lang;
    localStorage.setItem('adkerala_admin_lang', state.displayLang);
    document.querySelectorAll('#lang-toggle .segment').forEach((b) => b.classList.toggle('active', b === btn));
    renderRoutes();
    renderBuses();
    renderContent();
  });
});

// Picks the preferred-language name, falling back to the other if empty.
function displayName(obj) {
  if (!obj) return '';
  if (state.displayLang === 'ml') return obj.name_ml || obj.name || '';
  return obj.name || obj.name_ml || '';
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
  if (!query || query.trim().length < 2) {
    cb([]);
    return;
  }
  searchDebounceTimer = setTimeout(async () => {
    const results = await api(`/api/stops/search?q=${encodeURIComponent(query.trim())}`);
    cb(results);
  }, 250);
}

// ===================== BUSES =====================

async function loadBuses() {
  state.buses = await api('/api/buses');
  renderBuses();
}

function renderBuses() {
  const list = document.getElementById('bus-list');
  list.innerHTML = '';
  if (state.buses.length === 0) {
    list.appendChild(el(`<div class="empty-state">No buses yet — add one above.</div>`));
    return;
  }
  for (const bus of state.buses) {
    const routeOptions = ['<option value="">— No route —</option>']
      .concat(state.routes.map((r) => `<option value="${r.route_id}" ${r.route_id === bus.route_id ? 'selected' : ''}>${escapeHtml(displayName(r))}</option>`))
      .join('');

    const tripInfo = bus.trip_active
      ? `<div class="bus-trip">Trip active — stop #${bus.current_stop_index ?? '?'} (${bus.current_direction || 'going'})</div>`
      : '';

    const card = el(`
      <div class="card bus-card" data-bus-id="${bus.bus_id}">
        <div class="bus-main">
          <span class="status-dot ${bus.online ? 'online' : ''}" title="${bus.online ? 'Online' : 'Offline'}"></span>
          <div>
            <div class="bus-reg">${escapeHtml(bus.reg_number)}</div>
            <div class="bus-meta">${bus.tier} · ${bus.online ? 'online now' : (bus.last_seen_at ? 'last seen ' + bus.last_seen_at : 'never connected')}</div>
            ${tripInfo}
          </div>
        </div>
        <div class="bus-actions">
          <select class="assign-route-select">${routeOptions}</select>
          <span class="apikey" title="Click to copy — put this in the Hub's HUB_CLOUD_API_KEY">key: ${bus.api_key.slice(0, 8)}…</span>
          <button class="btn btn-danger btn-small">Remove</button>
        </div>
      </div>
    `);

    card.querySelector('.assign-route-select').addEventListener('change', async (e) => {
      await api(`/api/buses/${bus.bus_id}/assign-route`, { method: 'POST', body: JSON.stringify({ route_id: e.target.value || null }) });
      loadBuses();
    });
    card.querySelector('.apikey').addEventListener('click', () => {
      navigator.clipboard?.writeText(bus.api_key);
    });
    card.querySelector('.btn-danger').addEventListener('click', async () => {
      if (!confirm(`Remove bus ${bus.reg_number}?`)) return;
      await api(`/api/buses/${bus.bus_id}`, { method: 'DELETE' });
      loadBuses();
    });

    list.appendChild(card);
  }
}

document.getElementById('form-add-bus').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/buses', {
    method: 'POST',
    body: JSON.stringify({
      reg_number: document.getElementById('bus-reg').value,
      tier: document.getElementById('bus-tier').value,
      hardware_version: document.getElementById('bus-hw').value,
    }),
  });
  document.getElementById('form-add-bus').reset();
  loadBuses();
});

// ===================== ROUTES =====================

async function loadRoutes() {
  state.routes = await api('/api/routes');
  renderRoutes();
  renderBuses(); // route names feed the assign-route dropdown
  populateContentRouteOptions();
}

function renderRoutes() {
  const list = document.getElementById('route-list');
  list.innerHTML = '';
  if (state.routes.length === 0) {
    list.appendChild(el(`<div class="empty-state">No routes yet — add one above.</div>`));
    return;
  }
  for (const route of state.routes) {
    const card = el(`
      <div class="card" data-route-id="${route.route_id}">
        <div class="route-card-head">
          <div>
            <div class="route-title">${escapeHtml(displayName(route))}</div>
            <div class="route-meta">${route.tier} · ${route.stop_count} stops · ${route.bus_count} bus(es) assigned</div>
          </div>
          <div class="bus-actions">
            <button class="btn btn-ghost btn-small toggle-stops">${state.expandedRouteId === route.route_id ? 'Hide stops' : 'Manage stops'}</button>
            <button class="btn btn-danger btn-small delete-route">Delete</button>
          </div>
        </div>
        <div class="stop-editor-mount"></div>
      </div>
    `);

    card.querySelector('.toggle-stops').addEventListener('click', () => {
      state.expandedRouteId = state.expandedRouteId === route.route_id ? null : route.route_id;
      renderRoutes();
    });
    card.querySelector('.delete-route').addEventListener('click', async () => {
      if (!confirm(`Delete route "${displayName(route)}"?`)) return;
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
    const row = el(`
      <div class="stop-row" data-stop-id="${stop.stop_id}">
        <div class="stop-seq">${idx + 1}</div>
        <div class="stop-names">
          <div class="stop-name-ml">${escapeHtml(displayName({ name: stop.name_en, name_ml: stop.name_ml }))}</div>
          <div class="stop-name-en">${escapeHtml(state.displayLang === 'ml' ? (stop.name_en || '') : (stop.name_ml || ''))}</div>
        </div>
        <div class="ads-toggle-wrap">
          <label class="switch" title="${stop.has_ad_clip ? 'Swap in the stop-name-with-ad clip' : 'Upload a stop_name_ad clip in Content first'}">
            <input type="checkbox" class="ads-toggle" ${stop.ads_enabled ? 'checked' : ''} ${stop.has_ad_clip ? '' : 'disabled'} />
            <span class="slider"></span>
          </label>
          Ads
        </div>
        <div class="stop-row-actions">
          <button class="icon-btn move-up" title="Move up" ${idx === 0 ? 'disabled' : ''}>↑</button>
          <button class="icon-btn move-down" title="Move down" ${idx === stops.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="icon-btn remove-stop" title="Unlink from this route">✕</button>
        </div>
      </div>
    `);

    row.querySelector('.ads-toggle').addEventListener('change', async (e) => {
      await api(`/api/stops/${stop.stop_id}/toggle-ads`, { method: 'POST', body: JSON.stringify({ enabled: e.target.checked }) });
      renderStopEditor(mount, routeId);
    });
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
// with all its recorded audio intact, or fall back to creating a genuinely new one.
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
    debouncedSearchStops(searchInput.value, (results) => {
      resultsEl.innerHTML = '';
      for (const stop of results) {
        const already = alreadyLinkedIds.includes(stop.stop_id);
        const usedElsewhere = stop.used_by_routes.filter((r) => r.route_id !== routeId);
        const row = el(`
          <div class="search-result-row">
            <div>
              <span class="search-result-name">${escapeHtml(displayName({ name: stop.name_en, name_ml: stop.name_ml }))}</span>
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

// ===================== CONTENT =====================

function populateContentRouteOptions() {
  const sel = document.getElementById('content-route');
  const current = sel.value;
  sel.innerHTML = '<option value="">— Global —</option>' + state.routes.map((r) => `<option value="${r.route_id}">${escapeHtml(displayName(r))}</option>`).join('');
  sel.value = current;
}

const STOP_SPECIFIC_TYPES = new Set(['stop_name', 'stop_name_ad']);

const contentStopField = document.getElementById('content-stop-field');
const contentStopSearch = document.getElementById('content-stop-search');
const contentStopResults = document.getElementById('content-stop-results');
const contentStopIdInput = document.getElementById('content-stop-id');
const contentStopPicked = document.getElementById('content-stop-picked');

function updateContentStopFieldVisibility() {
  const isStopType = STOP_SPECIFIC_TYPES.has(document.getElementById('content-type').value);
  contentStopField.style.display = isStopType ? 'flex' : 'none';
}
document.getElementById('content-type').addEventListener('change', updateContentStopFieldVisibility);
updateContentStopFieldVisibility();

contentStopSearch.addEventListener('input', () => {
  debouncedSearchStops(contentStopSearch.value, (results) => {
    contentStopResults.innerHTML = '';
    for (const stop of results) {
      const row = el(`
        <div class="search-result-row">
          <span class="search-result-name">${escapeHtml(displayName({ name: stop.name_en, name_ml: stop.name_ml }))}</span>
          <button type="button" class="btn btn-ghost btn-small">Pick</button>
        </div>
      `);
      row.querySelector('button').addEventListener('click', () => {
        contentStopIdInput.value = stop.stop_id;
        contentStopPicked.textContent = displayName({ name: stop.name_en, name_ml: stop.name_ml });
        contentStopPicked.style.display = 'inline-flex';
        contentStopSearch.value = '';
        contentStopResults.innerHTML = '';
      });
      contentStopResults.appendChild(row);
    }
  });
});

async function loadContent() {
  state.content = await api('/api/content');
  renderContent();
}

function renderContent() {
  const list = document.getElementById('content-list');
  list.innerHTML = '';
  if (state.content.length === 0) {
    list.appendChild(el(`<div class="empty-state">No content uploaded yet.</div>`));
    return;
  }
  const isVideo = (p) => /\.(mp4|webm)$/i.test(p);
  const isImage = (p) => /\.(png|jpe?g|webp)$/i.test(p);

  for (const item of state.content) {
    const url = `/content/${item.file_path}`;
    let preview = `<audio controls src="${url}"></audio>`;
    if (isVideo(item.file_path)) preview = `<video class="preview" controls src="${url}"></video>`;
    if (isImage(item.file_path)) preview = `<img class="preview" src="${url}" alt="" style="max-height:60px;border-radius:8px" />`;

    const scope = item.stop_name ? `${item.route_name || ''} · ${item.stop_name}` : (item.route_name || 'Global');

    const card = el(`
      <div class="card content-card" data-content-id="${item.content_id}">
        <div class="content-main">
          <span class="badge">${item.type.replace('_', ' ')}</span>
          <div>
            <div class="content-title">${escapeHtml(item.original_filename || item.content_id)}</div>
            <div class="content-meta">${escapeHtml(scope)}${item.tier ? ' · ' + item.tier : ''}</div>
          </div>
          ${preview}
        </div>
        <button class="btn btn-danger btn-small">Delete</button>
      </div>
    `);

    card.querySelector('.btn-danger').addEventListener('click', async () => {
      if (!confirm('Delete this content item?')) return;
      await api(`/api/content/${item.content_id}`, { method: 'DELETE' });
      loadContent();
    });

    list.appendChild(card);
  }
}

document.getElementById('form-add-content').addEventListener('submit', async (e) => {
  e.preventDefault();
  const hint = document.getElementById('content-upload-hint');
  hint.textContent = 'Uploading…';
  hint.className = 'hint';

  const fd = new FormData();
  fd.append('type', document.getElementById('content-type').value);
  fd.append('route_id', document.getElementById('content-route').value);
  fd.append('stop_id', contentStopIdInput.value);
  fd.append('tier', document.getElementById('content-tier').value);
  fd.append('file', document.getElementById('content-file').files[0]);

  try {
    await api('/api/content', { method: 'POST', body: fd });
    document.getElementById('form-add-content').reset();
    contentStopIdInput.value = '';
    contentStopPicked.style.display = 'none';
    updateContentStopFieldVisibility();
    hint.textContent = 'Uploaded — pushed live to matching buses that are online.';
    hint.className = 'hint success';
    loadContent();
  } catch (err) {
    hint.textContent = err.message;
    hint.className = 'hint error';
  }
});

// ===================== Shared =====================

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refreshAll() {
  await loadRoutes();
  await loadBuses();
  await loadContent();
}

refreshAll();
setInterval(loadBuses, 5000); // live-ish fleet status without a second WebSocket on the admin side
