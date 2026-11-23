import { validateQuery, MAX_CHARS } from './guardrails.js';

const CONFIG = window.SHORTS_ATLAS_CONFIG || {};
const DEMO = !CONFIG.apiUrl;
const YT_ID = /^[\w-]{11}$/;
const PRECISION_LABEL = { exact: 'Exact', place: 'Place name', country: 'Country', ai: 'AI-inferred' };

const $ = (id) => document.getElementById(id);
const els = {
  form: $('search'), q: $('q'), go: $('go'), counter: $('counter'), error: $('q-error'),
  headline: $('headline'), strip: $('strip'), stripCount: $('strip-count'), empty: $('empty'),
  status: $('map-status'), demo: $('demo-banner'), map: $('map'), turnstile: $('turnstile'),
};

const state = { query: '', results: [], selectedId: null, playingId: null, nextPageToken: null, loadingMore: false };
let map = null;
let mapReady = false;
let turnstileId = null;

// ---------- search box ----------
function updateCounter() {
  const n = [...els.q.value].length;
  els.counter.textContent = `${n} / ${MAX_CHARS}`;
  els.counter.classList.toggle('near', n >= MAX_CHARS - 8);
}
els.q.addEventListener('input', () => { updateCounter(); els.error.textContent = ''; });
document.querySelectorAll('.try').forEach((b) => b.addEventListener('click', () => {
  els.q.value = b.dataset.q;
  updateCounter();
  els.form.requestSubmit();
}));
els.form.addEventListener('submit', (e) => { e.preventDefault(); runSearch(els.q.value); });

async function runSearch(raw) {
  const v = validateQuery(raw);
  if (!v.ok) { els.error.textContent = v.message; els.q.focus(); return; }
  els.error.textContent = '';
  els.go.disabled = true;
  els.status.textContent = 'Searching…';
  try {
    const data = DEMO ? await demoSearch(v.query) : await apiSearch(v.query);
    state.nextPageToken = DEMO ? null : data.nextPageToken || null;
    setResults(v.query, data.results || []);
    const url = new URL(location.href);
    url.searchParams.set('q', v.query);
    history.replaceState(null, '', url);
  } catch (err) {
    els.error.textContent = err.message || 'Something went wrong. Please try again.';
    els.status.textContent = '';
  } finally {
    els.go.disabled = false;
    if (turnstileId !== null && window.turnstile) window.turnstile.reset(turnstileId);
  }
}

async function apiSearch(q, pageToken = null) {
  const body = { q };
  if (pageToken) body.pageToken = pageToken;
  if (CONFIG.turnstileSiteKey && window.turnstile && turnstileId !== null) {
    body.turnstileToken = window.turnstile.getResponse(turnstileId);
  }
  let res;
  try {
    res = await fetch(CONFIG.apiUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error('Could not reach the search service. Check your connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'The search failed. Please try again.');
  return data;
}

async function demoSearch() {
  const res = await fetch('demo-data.json');
  return res.json();
}

// ---------- results ----------
function setResults(query, results) {
  state.query = query;
  state.results = results.filter((r) => r && typeof r.id === 'string');
  state.selectedId = null;
  state.playingId = null;
  els.headline.textContent = `Where is the world filming “${query}”?`;
  updateCounts();
  els.empty.textContent = state.results.length ? '' : 'No Shorts found for that search.';
  els.empty.hidden = state.results.length > 0;
  renderStrip();
  updateMapData();
  const placed = state.results.filter((r) => r.place);
  if (placed.length && mapReady) fitToResults(placed);
}

function updateCounts() {
  const placed = state.results.filter((r) => r.place).length;
  const unplaced = state.results.length - placed;
  const byAI = state.results.filter((r) => r.place?.precision === 'ai').length;
  els.status.textContent = state.results.length
    ? `${state.results.length} Shorts · ${placed} on the map${byAI ? ` (${byAI} by AI)` : ''} · ${unplaced} unplaced`
    : 'No Shorts found. Try another word.';
  els.stripCount.textContent = state.results.length ? `${state.results.length} results` : '';
}

// Next page of results, only when asked for: each page costs one search from the daily quota.
async function loadMore() {
  if (!state.nextPageToken || state.loadingMore) return;
  state.loadingMore = true;
  renderStrip();
  try {
    const data = await apiSearch(state.query, state.nextPageToken);
    const seen = new Set(state.results.map((r) => r.id));
    const fresh = (data.results || []).filter((r) => r && typeof r.id === 'string' && !seen.has(r.id));
    state.results.push(...fresh);
    state.nextPageToken = data.nextPageToken || null;
    updateCounts();
    updateMapData();
    els.status.textContent += fresh.length ? '' : ' · no new Shorts on that page';
  } catch (err) {
    els.error.textContent = err.message || 'Could not load more. Please try again.';
  } finally {
    state.loadingMore = false;
    if (turnstileId !== null && window.turnstile) window.turnstile.reset(turnstileId);
    renderStrip();
  }
}

function renderStrip() {
  const cards = [...sorted()].map(renderCard);
  if (state.nextPageToken && state.results.length) cards.push(renderLoadMore());
  els.strip.replaceChildren(...cards);
}

function renderLoadMore() {
  const wrap = document.createElement('div');
  wrap.className = 'card more';
  wrap.setAttribute('role', 'listitem');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'more-btn';
  btn.disabled = state.loadingMore;
  btn.textContent = state.loadingMore ? 'Loading…' : 'Load more Shorts';
  btn.addEventListener('click', loadMore);
  wrap.append(btn);
  return wrap;
}

// Placed Shorts first, unplaced at the end of the strip.
function* sorted() {
  for (const r of state.results) if (r.place) yield r;
  for (const r of state.results) if (!r.place) yield r;
}

function renderCard(r) {
  const card = document.createElement('div');
  card.className = 'card';
  card.setAttribute('role', 'listitem');
  card.dataset.id = r.id;
  if (r.id === state.selectedId) card.classList.add('selected');

  const media = document.createElement('div');
  media.className = 'media';
  if (r.id === state.playingId && YT_ID.test(r.id) && !r.demo) {
    const iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube-nocookie.com/embed/${r.id}?autoplay=1&playsinline=1&rel=0&modestbranding=1`;
    iframe.title = r.title || 'YouTube Short';
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-popups');
    media.append(iframe);
  } else {
    if (r.thumb && /^https:\/\/i\.ytimg\.com\//.test(r.thumb)) {
      const img = document.createElement('img');
      img.src = r.thumb;
      img.alt = '';
      img.loading = 'lazy';
      media.append(img);
    } else {
      const initial = document.createElement('span');
      initial.className = 'initial';
      initial.setAttribute('aria-hidden', 'true');
      initial.textContent = (r.place?.label || r.title || '?').trim().charAt(0).toUpperCase();
      media.append(initial);
    }
    if (r.id === state.selectedId) {
      if (r.demo) {
        const note = document.createElement('p');
        note.className = 'no-video';
        note.textContent = 'Demo mode: connect the API to play real Shorts here.';
        media.append(note);
      } else {
        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'play';
        play.setAttribute('aria-label', `Play: ${r.title}`);
        play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>'; // static markup, no data
        play.addEventListener('click', (e) => { e.stopPropagation(); state.playingId = r.id; renderStrip(); });
        media.append(play);
      }
    }
    media.addEventListener('click', () => select(r.id));
  }

  const text = document.createElement('button');
  text.type = 'button';
  text.className = 'card-text';
  const title = document.createElement('span');
  title.className = 'card-title';
  title.textContent = r.title || 'Untitled Short';
  const meta = document.createElement('span');
  meta.className = 'card-meta';
  if (!r.place) meta.textContent = 'Unplaced';
  else if (r.place.precision === 'ai') {
    meta.append(`${r.place.label} · `);
    const tag = document.createElement('span');
    tag.className = 'ai-tag';
    tag.textContent = r.place.evidence ? `AI, from “${r.place.evidence}”` : 'AI-inferred';
    meta.append(tag);
  } else meta.textContent = `${r.place.label} · ${PRECISION_LABEL[r.place.precision] || ''}`;
  text.append(title, meta);
  text.setAttribute('aria-pressed', String(r.id === state.selectedId));
  text.addEventListener('click', () => select(r.id));
  text.addEventListener('mouseenter', () => highlight(r.id));
  text.addEventListener('focus', () => highlight(r.id));

  card.append(media, text);
  return card;
}

function select(id, { fromMap = false } = {}) {
  if (state.selectedId !== id) state.playingId = null;
  state.selectedId = id;
  renderStrip();
  const r = state.results.find((x) => x.id === id);
  const card = els.strip.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (card) card.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', inline: 'start', block: 'nearest' });
  if (fromMap && card) card.querySelector('.card-text')?.focus({ preventScroll: true });
  highlight(id);
  if (r?.place && map && !fromMap) {
    // Past clusterMaxZoom (6), so the selected Short shows as its own pin.
    const zoom = r.place.precision === 'country' ? 3 : 7;
    map.flyTo({ center: [r.place.lon, r.place.lat], zoom: Math.max(map.getZoom(), zoom), essential: false });
  }
}

// ---------- map ----------
function initMap() {
  if (!window.maplibregl) return mapFallback('The map could not load. The list of Shorts below still works.');
  try {
    window.maplibregl.setWorkerUrl('vendor/maplibre-gl-csp-worker.js');
    map = new window.maplibregl.Map({
      container: els.map,
      style: CONFIG.mapStyle,
      center: [20, 20],
      zoom: 1.1,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
  } catch {
    return mapFallback('Your browser cannot show the map (WebGL is off). The list of Shorts below still works.');
  }
  map.addControl(new window.maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.touchZoomRotate.disableRotation();
  map.on('load', () => {
    darken(map);
    addLayers(map);
    mapReady = true;
    updateMapData();
    const placed = state.results.filter((r) => r.place);
    if (placed.length) fitToResults(placed);
  });
  map.on('error', (e) => console.warn('map error', e?.error?.message));
}

function mapFallback(msg) {
  const p = document.createElement('p');
  p.className = 'map-fallback';
  p.textContent = msg;
  els.map.replaceChildren(p);
}

// Recolor the light OpenFreeMap style to match the page.
function darken(m) {
  for (const layer of m.getStyle().layers) {
    const set = (prop, val) => { try { m.setPaintProperty(layer.id, prop, val); } catch { /* not supported */ } };
    const id = layer.id;
    if (layer.type === 'background') set('background-color', '#1B1815');
    else if (layer.type === 'fill') set('fill-color', /water|ocean|sea|lake/.test(id) ? '#141210' : '#2C2622');
    else if (layer.type === 'line') set('line-color', /water|river/.test(id) ? '#141210' : /boundary|admin/.test(id) ? '#4A413A' : '#3A322C');
    else if (layer.type === 'symbol') { set('text-color', '#B5ABA0'); set('text-halo-color', '#141210'); }
  }
}

function addLayers(m) {
  m.addSource('shorts', { type: 'geojson', data: toGeoJSON(), cluster: true, clusterRadius: 40, clusterMaxZoom: 6 });
  m.addLayer({ id: 'clusters', type: 'circle', source: 'shorts', filter: ['has', 'point_count'],
    paint: { 'circle-color': '#FF6B4A', 'circle-opacity': 0.9, 'circle-stroke-color': '#141210', 'circle-stroke-width': 2,
      'circle-radius': ['step', ['get', 'point_count'], 14, 5, 18, 15, 24] } });
  m.addLayer({ id: 'cluster-count', type: 'symbol', source: 'shorts', filter: ['has', 'point_count'],
    layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 13, 'text-font': ['Noto Sans Bold'] },
    paint: { 'text-color': '#1A0A05' } });
  m.addLayer({ id: 'points', type: 'circle', source: 'shorts', filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-radius': 8,
      'circle-color': ['match', ['get', 'precision'], 'exact', '#FF6B4A', '#141210'],
      'circle-stroke-color': ['match', ['get', 'precision'], 'country', '#B5ABA0', 'ai', '#C4B5FD', '#FF6B4A'],
      'circle-stroke-width': ['match', ['get', 'precision'], 'exact', 0, 3],
    } });
  // AI-inferred pins get a centre dot so they read differently from place-name pins, not by colour alone.
  m.addLayer({ id: 'points-ai-dot', type: 'circle', source: 'shorts',
    filter: ['all', ['!', ['has', 'point_count']], ['==', ['get', 'precision'], 'ai']],
    paint: { 'circle-radius': 3, 'circle-color': '#C4B5FD' } });
  m.addLayer({ id: 'selected', type: 'circle', source: 'shorts', filter: ['==', ['get', 'id'], ''],
    paint: { 'circle-radius': 12, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#F4EEE6', 'circle-stroke-width': 3 } });

  m.on('click', 'clusters', async (e) => {
    const f = e.features[0];
    const zoom = await m.getSource('shorts').getClusterExpansionZoom(f.properties.cluster_id);
    m.easeTo({ center: f.geometry.coordinates, zoom });
  });
  m.on('click', 'points', (e) => select(e.features[0].properties.id, { fromMap: true }));
  for (const layer of ['clusters', 'points']) {
    m.on('mouseenter', layer, () => { m.getCanvas().style.cursor = 'pointer'; });
    m.on('mouseleave', layer, () => { m.getCanvas().style.cursor = ''; });
  }
}

function toGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: state.results.filter((r) => r.place).map((r) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.place.lon, r.place.lat] },
      properties: { id: r.id, precision: r.place.precision },
    })),
  };
}

function updateMapData() {
  if (!mapReady) return;
  map.getSource('shorts').setData(toGeoJSON());
  highlight(state.selectedId);
}

function highlight(id) {
  if (!mapReady) return;
  map.setFilter('selected', ['==', ['get', 'id'], id || '']);
}

function fitToResults(placed) {
  if (placed.length === 1) {
    map.flyTo({ center: [placed[0].place.lon, placed[0].place.lat], zoom: 4 });
    return;
  }
  const lons = placed.map((r) => r.place.lon);
  const lats = placed.map((r) => r.place.lat);
  map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
    { padding: 60, maxZoom: 5, duration: 800 });
}

// ---------- start ----------
function initTurnstile() {
  if (DEMO || !CONFIG.turnstileSiteKey) return;
  window.onTurnstileLoad = () => {
    turnstileId = window.turnstile.render(els.turnstile, { sitekey: CONFIG.turnstileSiteKey, theme: 'dark', size: 'flexible' });
  };
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad&render=explicit';
  s.async = true;
  document.head.append(s);
}

els.demo.hidden = !DEMO;
updateCounter();
initTurnstile();
initMap();
const initial = new URLSearchParams(location.search).get('q');
if (initial) { els.q.value = initial.slice(0, MAX_CHARS); updateCounter(); runSearch(els.q.value); }
else if (DEMO) { els.q.value = 'street food'; updateCounter(); runSearch('street food'); }
