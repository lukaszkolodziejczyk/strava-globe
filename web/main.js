/* Strava Globe — every GPS activity rendered on a realistic CesiumJS earth. */
'use strict';

const TYPES = {
  Run:  { color: '#fc5200', icon: '🏃' },
  Walk: { color: '#38a8ff', icon: '🚶' },
  Hike: { color: '#3ddc84', icon: '🥾' },
  Ride: { color: '#ffd23f', icon: '🚴' },
  Swim: { color: '#2dd4bf', icon: '🏊' },
  other:{ color: '#c084fc', icon: '📍' },
};
const styleFor = (t) => TYPES[t] ?? TYPES.other;
const TRACK_HEIGHT = 40;   // meters above the ellipsoid, avoids z-fighting with imagery
const LINE_WIDTH = 3;
const LINE_WIDTH_HOVER = 5.5;

/* ---------- viewer ---------- */
const viewer = new Cesium.Viewer('globe', {
  baseLayer: false,
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  animation: false,
  timeline: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
});
const scene = viewer.scene;
window.viewer = viewer;   // debug handle
viewer.useBrowserRecommendedResolution = false;
scene.msaaSamples = 1;   // MSAA renders a black globe on some GPU stacks
scene.postProcessStages.fxaa.enabled = true;
scene.globe.baseColor = Cesium.Color.fromCssColorString('#0b1826');
// Sun-driven atmosphere shading blacks out the globe on software GL; keep the
// whole earth lit and use the distance-based ground haze only.
scene.globe.dynamicAtmosphereLighting = false;
scene.globe.showGroundAtmosphere = true;
scene.skyAtmosphere.show = false;
scene.fog.enabled = false;
viewer.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

const IMAGERY = {
  esri: () => new Cesium.UrlTemplateImageryProvider({
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    credit: 'Imagery © Esri, Maxar, Earthstar Geographics',
    maximumLevel: 19,
  }),
  osm: () => new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }),
};
function setImagery(kind) {
  viewer.imageryLayers.removeAll();
  viewer.imageryLayers.addImageryProvider(IMAGERY[kind]());
}
setImagery('esri');

/* ---------- tracks ---------- */
const lineCollection = scene.primitives.add(new Cesium.PolylineCollection());
const materials = {};   // one shared material per type keeps the collection batched
function materialFor(type) {
  const key = TYPES[type] ? type : 'other';
  materials[key] ??= Cesium.Material.fromType('PolylineGlow', {
    color: Cesium.Color.fromCssColorString(styleFor(key).color).withAlpha(0.95),
    glowPower: 0.16,
    taperPower: 1.0,
  });
  return materials[key];
}

const records = [];     // { a, lines: [Polyline], bbox: [w, s, e, n] }

function addActivity(a, index) {
  const rec = { a, lines: [], bbox: [Infinity, Infinity, -Infinity, -Infinity] };
  for (const seg of a.s) {
    const flat = new Array(seg.length * 3);
    for (let i = 0; i < seg.length; i++) {
      const [lon, lat] = seg[i];
      flat[i * 3] = lon;
      flat[i * 3 + 1] = lat;
      flat[i * 3 + 2] = TRACK_HEIGHT;
      if (lon < rec.bbox[0]) rec.bbox[0] = lon;
      if (lat < rec.bbox[1]) rec.bbox[1] = lat;
      if (lon > rec.bbox[2]) rec.bbox[2] = lon;
      if (lat > rec.bbox[3]) rec.bbox[3] = lat;
    }
    rec.lines.push(lineCollection.add({
      positions: Cesium.Cartesian3.fromDegreesArrayHeights(flat),
      width: LINE_WIDTH,
      material: materialFor(a.t),
      id: index,
    }));
  }
  records.push(rec);
}

/* ---------- filters & stats ---------- */
const enabledTypes = new Set();
const enabledYears = new Set();

function applyFilters() {
  let count = 0, km = 0;
  for (const rec of records) {
    const show = enabledTypes.has(rec.a.t) && enabledYears.has(rec.a.y);
    for (const line of rec.lines) line.show = show;
    if (show) { count++; km += rec.a.km; }
  }
  const el = document.getElementById('stats');
  el.innerHTML = `<b>${count}</b> activities · <b>${Math.round(km).toLocaleString('en')}</b> km · ${dateRangeLabel()}`;
}

let rangeLabel = '';
function dateRangeLabel() { return rangeLabel; }

function buildChips(data) {
  const typeCounts = {}, yearCounts = {};
  for (const a of data.activities) {
    typeCounts[a.t] = (typeCounts[a.t] ?? 0) + 1;
    yearCounts[a.y] = (yearCounts[a.y] ?? 0) + 1;
  }
  const typeBox = document.getElementById('typeChips');
  for (const [t, n] of Object.entries(typeCounts).sort((x, y) => y[1] - x[1])) {
    enabledTypes.add(t);
    typeBox.appendChild(chip(`${t} <span class="n">${n}</span>`, styleFor(t).color, () => toggle(enabledTypes, t)));
  }
  const yearBox = document.getElementById('yearChips');
  for (const [y, n] of Object.entries(yearCounts).sort()) {
    enabledYears.add(Number(y));
    yearBox.appendChild(chip(`${y} <span class="n">${n}</span>`, null, () => toggle(enabledYears, Number(y))));
  }
}
function chip(html, color, onToggle) {
  const el = document.createElement('span');
  el.className = 'chip';
  el.innerHTML = (color ? `<span class="dot" style="--c:${color}"></span>` : '') + html;
  el.addEventListener('click', () => { el.classList.toggle('off', !onToggle()); });
  return el;
}
function toggle(set, value) {
  set.has(value) ? set.delete(value) : set.add(value);
  applyFilters();
  return set.has(value);
}

/* ---------- hover & click ---------- */
const tooltip = document.getElementById('tooltip');
let hovered = null;

function setHover(index, x, y) {
  if (hovered !== null && hovered !== index) {
    for (const line of records[hovered].lines) line.width = LINE_WIDTH;
  }
  hovered = index;
  if (index === null) {
    tooltip.hidden = true;
    viewer.container.style.cursor = '';
    return;
  }
  const rec = records[index];
  for (const line of rec.lines) line.width = LINE_WIDTH_HOVER;
  const { a } = rec;
  tooltip.innerHTML =
    `<div class="t-name">${escapeHtml(a.n)}</div>` +
    `<div class="t-meta">${styleFor(a.t).icon} ${a.t} · ${a.d} · ${a.km.toFixed(1)} km${a.c ? ' · ' + escapeHtml(a.c) : ''}</div>`;
  tooltip.hidden = false;
  const pad = 14;
  tooltip.style.left = Math.min(x + pad, innerWidth - tooltip.offsetWidth - 8) + 'px';
  tooltip.style.top = Math.min(y + pad, innerHeight - tooltip.offsetHeight - 8) + 'px';
  viewer.container.style.cursor = 'pointer';
}
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
let lastPick = 0;
handler.setInputAction((movement) => {
  const now = performance.now();
  if (now - lastPick < 40) return;   // throttle picking
  lastPick = now;
  const picked = scene.pick(movement.endPosition);
  const index = picked && Number.isInteger(picked.id) ? picked.id : null;
  setHover(index, movement.endPosition.x, movement.endPosition.y);
}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

handler.setInputAction((click) => {
  const picked = scene.pick(click.position);
  if (!picked || !Number.isInteger(picked.id)) return;
  setHover(null);
  flyToActivity(records[picked.id]);
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

function flyToActivity(rec) {
  stopSpin();
  let [w, s, e, n] = rec.bbox;
  const padLon = Math.max((e - w) * 0.35, 0.002);
  const padLat = Math.max((n - s) * 0.35, 0.0015);
  scene.camera.flyTo({
    destination: Cesium.Rectangle.fromDegrees(w - padLon, s - padLat, e + padLon, n + padLat),
    duration: 1.8,
  });
}

/* ---------- home view & idle spin ---------- */
let homeDestination = Cesium.Cartesian3.fromDegrees(15, 45, 20_000_000);
function goHome(instant) {
  if (instant) scene.camera.setView({ destination: homeDestination });
  else scene.camera.flyTo({ destination: homeDestination, duration: 1.6 });
}
document.getElementById('home').addEventListener('click', () => { stopSpin(); goHome(false); });
document.getElementById('imagery').addEventListener('change', (e) => setImagery(e.target.value));

let spinning = true;
viewer.clock.onTick.addEventListener(() => {
  if (spinning) scene.camera.rotate(Cesium.Cartesian3.UNIT_Z, -0.0005);
});
function stopSpin() { spinning = false; }
window.stopSpin = stopSpin;   // debug handle
for (const ev of ['pointerdown', 'wheel', 'touchstart']) {
  scene.canvas.addEventListener(ev, () => { stopSpin(); exitTour(false); }, { passive: true });
}

/* ---------- flight tour ---------- */
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtYM = (d) => (d ? `${MONTH_NAMES[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}` : '');
const havKm = (lat1, lon1, lat2, lon2) => {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};
const regionName = (() => {
  try { const dn = new Intl.DisplayNames(['en'], { type: 'region' }); return (cc) => dn.of(cc) ?? cc; }
  catch { return (cc) => cc; }
})();

// Group activities into places (<35 km apart), in order of first visit.
function buildTourStops() {
  const CLUSTER_KM = 35;
  const clusters = [];
  for (const rec of records) {   // records are date-sorted
    const lon = (rec.bbox[0] + rec.bbox[2]) / 2, lat = (rec.bbox[1] + rec.bbox[3]) / 2;
    let best = null, bestD = Infinity;
    for (const cl of clusters) {
      const d = havKm(lat, lon, cl.lat, cl.lon);
      if (d < bestD) { bestD = d; best = cl; }
    }
    if (best && bestD < CLUSTER_KM) {
      best.recs.push(rec);
      best.bbox = [
        Math.min(best.bbox[0], rec.bbox[0]), Math.min(best.bbox[1], rec.bbox[1]),
        Math.max(best.bbox[2], rec.bbox[2]), Math.max(best.bbox[3], rec.bbox[3]),
      ];
    } else {
      clusters.push({ lat, lon, bbox: [...rec.bbox], recs: [rec] });
    }
  }
  const finalize = (cl) => {
    const as = cl.recs.map((r) => r.a);
    const modal = (key) => {
      const counts = {};
      for (const a of as) if (a[key]) counts[a[key]] = (counts[a[key]] ?? 0) + 1;
      return Object.entries(counts).sort((x, y) => y[1] - x[1])[0]?.[0];
    };
    cl.city = modal('c') ?? 'Somewhere';
    cl.country = regionName(modal('cc') ?? '') ?? '';
    cl.km = as.reduce((sum, a) => sum + a.km, 0);
    cl.first = as[0].d;
    cl.last = as[as.length - 1].d;
    const tc = {};
    for (const a of as) tc[a.t] = (tc[a.t] ?? 0) + 1;
    cl.types = Object.entries(tc).sort((x, y) => y[1] - x[1]).slice(0, 3);
  };
  clusters.forEach(finalize);

  // A moving trip can split one town into several clusters — merge same-named ones.
  const byName = new Map();
  const merged = [];
  for (const cl of clusters) {
    const key = `${cl.city}|${cl.country}`;
    const prev = byName.get(key);
    if (prev) {
      prev.recs.push(...cl.recs);
      prev.recs.sort((a, b) => (a.a.d < b.a.d ? -1 : 1));
      prev.bbox = [
        Math.min(prev.bbox[0], cl.bbox[0]), Math.min(prev.bbox[1], cl.bbox[1]),
        Math.max(prev.bbox[2], cl.bbox[2]), Math.max(prev.bbox[3], cl.bbox[3]),
      ];
      finalize(prev);
    } else {
      byName.set(key, cl);
      merged.push(cl);
    }
  }
  return merged;
}

const tour = { active: false, paused: false, stops: [], i: -1, timer: null };
const tourCard = document.getElementById('tourCard');
const tourBtn = document.getElementById('tour');
const tcInfo = document.getElementById('tcInfo');
const tcProgress = document.getElementById('tcProgress');
// Linger at the places with history; brief nods to one-run stopovers.
const dwellMs = (cl) => (cl.recs.length >= 10 ? 4800 : cl.recs.length >= 3 ? 3400 : 2400);

function startTour() {
  if (!records.length || tour.active) return;
  stopSpin();
  setHover(null);
  if (!tour.stops.length) tour.stops = buildTourStops();
  tour.active = true;
  tour.paused = false;
  tour.i = -1;
  tourBtn.textContent = '■ Tour';
  document.getElementById('tcPause').textContent = '⏸';
  advanceTour(1);
}

function exitTour(cancelFlight = true) {
  if (!tour.active) return;
  tour.active = false;
  clearTimeout(tour.timer);
  tour.timer = null;
  tourCard.hidden = true;
  tourBtn.textContent = '▶ Tour';
  if (cancelFlight) scene.camera.cancelFlight();
}

function advanceTour(dir) {
  if (!tour.active) return;
  clearTimeout(tour.timer);
  tour.timer = null;
  const next = tour.i + dir;
  if (next < 0) return;
  if (next >= tour.stops.length) return tourFinale();
  tour.i = next;
  const cl = tour.stops[next];
  renderStopCard(cl, next);
  flyToRect(cl.bbox, () => {
    if (tour.active && !tour.paused) tour.timer = setTimeout(() => advanceTour(1), dwellMs(cl));
  });
}

function tourFinale() {
  const totalKm = Math.round(tour.stops.reduce((sum, c) => sum + c.km, 0));
  tcInfo.innerHTML =
    `<div class="tc-head">🌍 The whole story</div>` +
    `<div class="tc-meta">${tour.stops.length} places · ${records.length} activities · ` +
    `${totalKm.toLocaleString('en')} km · ${fmtYM(records[0].a.d)} → ${fmtYM(records[records.length - 1].a.d)}</div>`;
  tcProgress.textContent = '';
  goHome(false);
  tour.timer = setTimeout(() => exitTour(false), 6000);
}

function renderStopCard(cl, index) {
  const period = cl.first.slice(0, 7) === cl.last.slice(0, 7)
    ? fmtYM(cl.first) : `${fmtYM(cl.first)} → ${fmtYM(cl.last)}`;
  const types = cl.types.map(([t, n]) => `${styleFor(t).icon} ${n}`).join(' · ');
  tcInfo.innerHTML =
    `<div class="tc-head">📍 ${escapeHtml(cl.city)}<span class="tc-country"> · ${escapeHtml(cl.country)}</span></div>` +
    `<div class="tc-meta">${period} · ${cl.recs.length} ${cl.recs.length === 1 ? 'activity' : 'activities'} · ` +
    `${Math.round(cl.km).toLocaleString('en')} km</div>` +
    `<div class="tc-types">${types}</div>`;
  tcProgress.textContent = `${index + 1} / ${tour.stops.length}`;
  tourCard.hidden = false;
}

function flyToRect([w, s, e, n], onComplete) {
  const midLat = (s + n) / 2;
  const minLat = 0.09;
  const minLon = Math.min(minLat / Math.max(Math.cos((midLat * Math.PI) / 180), 0.2), 4);
  const padLon = Math.max((e - w) * 0.3, (minLon - (e - w)) / 2, 0.01);
  const padLat = Math.max((n - s) * 0.3, (minLat - (n - s)) / 2, 0.01);
  scene.camera.flyTo({
    destination: Cesium.Rectangle.fromDegrees(w - padLon, s - padLat, e + padLon, n + padLat),
    complete: onComplete,
  });
}

function toggleTourPause() {
  if (!tour.active) return;
  tour.paused = !tour.paused;
  document.getElementById('tcPause').textContent = tour.paused ? '▶' : '⏸';
  if (tour.paused) {
    clearTimeout(tour.timer);
    tour.timer = null;
  } else if (!tour.timer) {
    tour.timer = setTimeout(() => advanceTour(1), 1800);
  }
}

tourBtn.addEventListener('click', () => (tour.active ? exitTour() : startTour()));
document.getElementById('tcPrev').addEventListener('click', () => advanceTour(-1));
document.getElementById('tcNext').addEventListener('click', () => advanceTour(1));
document.getElementById('tcPause').addEventListener('click', toggleTourPause);
document.getElementById('tcExit').addEventListener('click', () => exitTour());
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
  if (!tour.active) {
    if (e.key === 't' || e.key === 'T') startTour();
    return;
  }
  if (e.key === 'Escape') exitTour();
  else if (e.key === ' ') { e.preventDefault(); toggleTourPause(); }
  else if (e.key === 'ArrowRight') advanceTour(1);
  else if (e.key === 'ArrowLeft') advanceTour(-1);
});

/* ---------- boot ---------- */
(async function boot() {
  const res = await fetch('data/activities.json');
  if (!res.ok) throw new Error(String(res.status));
  const data = await res.json();
  const acts = data.activities;

  document.getElementById('loadmsg').textContent = `Rendering ${acts.length} activities…`;
  acts.forEach(addActivity);

  const first = acts[0]?.d ?? '', last = acts[acts.length - 1]?.d ?? '';
  rangeLabel = `${first.slice(0, 7)} → ${last.slice(0, 7)}`;

  // Home = median of activity centers (robust against trips abroad)
  const lons = records.map((r) => (r.bbox[0] + r.bbox[2]) / 2).sort((a, b) => a - b);
  const lats = records.map((r) => (r.bbox[1] + r.bbox[3]) / 2).sort((a, b) => a - b);
  if (lons.length) {
    const mid = Math.floor(lons.length / 2);
    homeDestination = Cesium.Cartesian3.fromDegrees(lons[mid], lats[mid], 20_000_000);
  }
  goHome(true);

  buildChips(data);
  applyFilters();
  document.getElementById('loading').classList.add('done');
})().catch((err) => {
  document.getElementById('loadmsg').innerHTML =
    'No activity data yet.<br>' +
    'Build it from your Strava export: <code>uv run build_tracks.py path/to/export.zip</code>, then reload.';
  console.error(err);
});
