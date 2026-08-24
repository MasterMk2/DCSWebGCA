'use strict';

/* DCS Web GCA - browser console
 *
 * Modes:
 *   GCA - Precision Approach Radar (azimuth + elevation scopes, talk-down log)
 *   GCI - Ground Controlled Intercept (PPI scope + intercept solution)
 *   TWR - Aerodrome control (field view + traffic list)
 *   LSO - Carrier landing aid (glideslope + lineup against a Sea track)
 *
 * Every browser subscribes to its own (server, runway) pair; nothing here is
 * shared with the other controllers connected to the same console.
 */

const M_PER_NM = 1852;
const KT_TO_MS = 0.514444;

/* The console may be mounted at the site root or behind a sub-path
 * (https://freedomflight.jp/gca/), so every URL is built relative to the
 * directory this page was served from. */
const BASE = location.pathname.replace(/[^/]*$/, '');

/* Optional access token: picked up from ?token=... once, then remembered.
 * The server only enforces it when cfg.auth.token is set. */
const TOKEN = new URLSearchParams(location.search).get('token') || localStorage.getItem('gcaToken') || '';
if (new URLSearchParams(location.search).get('token')) {
  localStorage.setItem('gcaToken', TOKEN);
}
const authQuery = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '';
const authHeaders = TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {};

const state = {
  mode: 'gca',
  sources: [],
  sourceId: null,
  runways: [],
  runwayId: null,
  tracks: [],
  counts: null,
  connected: false,
  selectedId: null, // GCA table selection
  targetId: null,   // GCI target
  ownshipId: null,  // GCI ownship
  carrierId: null,     // LSO carrier (Sea track)
  lsoAircraftId: null, // LSO aircraft being talked onto the deck
  gciRangeNm: 20,
  twrRangeNm: 6,
  gcaRangeNm: 12,
  lsoRangeNm: 4,
  tolerance: { azToleranceDeg: 0.8, gsToleranceDeg: 0.4 },
};

let ws = null;
const blipIndex = {}; // canvasId -> [{ id, x, y }]

/* ---------- helpers ---------- */

function runwayCfg() {
  return state.runways.find((r) => r.id === state.runwayId) || state.runways[0] || null;
}

/** offsets in metres (east, north) of a track from the runway threshold */
function relToRunway(t, rwy) {
  const thr = rwy && rwy.threshold;
  if (!thr) return null;
  if (t.u !== undefined && t.u !== null && thr.z !== undefined) {
    return { x: t.u - thr.z, y: t.v - thr.x };
  }
  if (t.lat === undefined || t.lat === null || thr.lat === undefined) return null;
  const latRad = (thr.lat * Math.PI) / 180;
  return {
    x: (t.lon - thr.lon) * 111320 * Math.cos(latRad),
    y: (t.lat - thr.lat) * 111320,
  };
}

function normDeg(d) {
  return ((d % 360) + 360) % 360;
}

function fmtBrg(d) {
  return String(Math.round(normDeg(d))).padStart(3, '0');
}

function isAircraft(t) {
  return t.category === 'FixedWing' || t.category === 'Rotorcraft';
}

function speedMs(t) {
  const kt = t.gsKt || t.tasKt || t.iasKt;
  return kt ? kt * KT_TO_MS : 0;
}

function courseDeg(t) {
  return t.gc !== null && t.gc !== undefined ? t.gc : t.hdg || 0;
}

function escapeHtml(s) {
  const AMP = '&' + 'amp;';
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, AMP)
    .replace(/</g, '&' + 'lt;')
    .replace(/>/g, '&' + 'gt;')
    .replace(/"/g, '&' + 'quot;')
    .replace(/'/g, '&' + '#39;');
}

/* ---------- WebSocket ---------- */

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}${BASE}ws${authQuery}`);

  ws.onopen = () => setConnStatus(true);
  ws.onclose = () => {
    setConnStatus(false);
    setTimeout(connectWs, 2000);
  };
  ws.onerror = () => ws.close();

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'hello':
        state.sources = msg.sources || [];
        state.sourceId = msg.source;
        state.runwayId = msg.runway;
        if (msg.gca) state.tolerance = msg.gca;
        populateSourceSelect();
        updateInfoBar();
        break;

      case 'sources':
        state.sources = msg.sources || [];
        populateSourceSelect();
        updateInfoBar();
        break;

      case 'runways':
        if (msg.source !== state.sourceId) break;
        state.runways = msg.runways || [];
        state.runwayId = msg.runway;
        populateRunwaySelect();
        updateInfoBar();
        render();
        break;

      case 'tracks':
        if (msg.source !== state.sourceId) break;
        state.tracks = msg.tracks;
        state.counts = msg.counts;
        state.streaming = msg.connected;
        if (msg.runway) state.runwayId = msg.runway;
        recordTrackArrival();
        updateLatency(msg);
        updateInfoBar();
        render();
        break;

      case 'transcript':
        appendTranscript(msg.messages, msg.reset);
        break;
    }
  };
}

function setConnStatus(up) {
  state.connected = up;
  const el = document.getElementById('connStatus');
  el.textContent = up ? 'CONNECTED' : 'DISCONNECTED';
  el.className = 'status ' + (up ? 'connected' : 'disconnected');
}

/* ---------- refresh rate / latency HUD ---------- */

/* Small mode-independent HUD in the header: measured WebSocket update
 * frequency plus server->client latency, e.g. "UPD 4.9 Hz | LAT 120 ms".
 * The user can hide it with the PERF toggle (persisted in localStorage). */

const perfPrefs = { enabled: localStorage.getItem('gcaPerf') !== 'off' };

const PERF_WINDOW = 20; // tracks arrivals kept for the rolling rate estimate
const trackArrivals = []; // arrival timestamps of the last N 'tracks' messages

function recordTrackArrival() {
  trackArrivals.push(Date.now());
  if (trackArrivals.length > PERF_WINDOW) trackArrivals.shift();
}

/** updates per second over the rolling window, or null until two samples */
function updateRateHz() {
  if (trackArrivals.length < 2) return null;
  const spanMs = trackArrivals[trackArrivals.length - 1] - trackArrivals[0];
  if (spanMs <= 0) return null;
  return ((trackArrivals.length - 1) * 1000) / spanMs;
}

function updateLatency(msg) {
  const el = document.getElementById('latency');
  if (!perfPrefs.enabled) {
    el.hidden = true;
    return;
  }
  el.hidden = false;

  const hz = updateRateHz();

  // server send timestamp -> client receipt; fall back to the snapshot age
  // when the two clocks are too far apart for the difference to mean anything
  const now = Date.now();
  let ms = typeof msg.sentAt === 'number' ? Math.max(0, now - msg.sentAt) : null;
  if (ms === null || ms > 10000) {
    ms = typeof msg.time === 'number' ? Math.max(0, now - msg.time) : null;
  }

  el.textContent =
    'UPD ' + (hz === null ? '--' : hz.toFixed(1)) + ' Hz | LAT ' +
    (ms === null ? '--' : String(Math.round(ms))) + ' ms';
  el.className = 'status ' + (ms !== null && ms < 250 ? 'connected' : 'lat-warn');
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/* ---------- talk-down log ---------- */

function appendTranscript(messages, reset) {
  const log = document.getElementById('talkdownLog');
  if (reset) log.innerHTML = '';
  if (!messages || messages.length === 0) return;
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;

  for (const m of messages) {
    const div = document.createElement('div');
    div.className = 'log-line';
    const span = document.createElement('span');
    span.className = 'log-time';
    span.textContent = new Date(m.time).toLocaleTimeString('ja-JP', { hour12: false });
    div.appendChild(span);
    div.appendChild(document.createTextNode(m.text));
    log.appendChild(div);
  }
  while (log.children.length > 100) log.removeChild(log.firstChild);
  if (atBottom || reset) log.scrollTop = log.scrollHeight;
}

/* ---------- UI plumbing ---------- */

function populateSourceSelect() {
  const sel = document.getElementById('sourceSelect');
  const sig = state.sources.map((s) => `${s.id}:${s.connected}`).join(',');
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = '';
    for (const s of state.sources) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name + (s.connected ? '' : ' (offline)');
      sel.appendChild(opt);
    }
  }
  sel.value = state.sourceId || '';
  sel.onchange = () => {
    state.sourceId = sel.value;
    state.tracks = [];
    state.runways = [];
    state.selectedId = state.targetId = state.ownshipId = null;
    send({ type: 'subscribe', source: sel.value });
  };
}

function populateRunwaySelect() {
  const sel = document.getElementById('runwaySelect');
  sel.innerHTML = '';
  let group = null;
  let groupName = null;

  for (const r of state.runways) {
    const airbase = r.airbase || '';
    if (airbase && airbase !== groupName) {
      groupName = airbase;
      group = document.createElement('optgroup');
      group.label = airbase;
      sel.appendChild(group);
    }
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = airbase
      ? `${r.designator || r.id} (${fmtBrg(r.headingDeg)}°)`
      : `${r.id} (${fmtBrg(r.headingDeg)}°)`;
    (airbase ? group : sel).appendChild(opt);
  }
  if (state.runways.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = '-- no runway data --';
    sel.appendChild(opt);
  }
  sel.value = state.runwayId || '';
  sel.onchange = () => send({ type: 'selectRunway', runway: sel.value });
}

function updateInfoBar() {
  const src = state.sources.find((s) => s.id === state.sourceId);
  const rwy = runwayCfg();

  const mission = document.getElementById('missionInfo');
  if (src) {
    const rw = src.runways || {};
    const bits = [src.mission || '(no mission)'];
    if (rw.theatre) bits.push(rw.theatre);
    if (!src.connected) bits.push('Tacview stream down');
    else if (rw.state === 'loading') bits.push('loading runways...');
    else if (rw.state === 'error') bits.push('runway data unavailable');
    mission.textContent = bits.join(' | ');
  } else {
    mission.textContent = '-';
  }

  const info = document.getElementById('runwayInfo');
  info.textContent = rwy
    ? `${rwy.id}  HDG ${fmtBrg(rwy.headingDeg)}  GP ${rwy.glidepathDeg.toFixed(1)}°  THR ${rwy.threshold.altFt} ft` +
      (rwy.lengthNm ? `  LEN ${Math.round(rwy.lengthNm * M_PER_NM)} m` : '')
    : '';

  const counts = document.getElementById('trackCount');
  counts.textContent = state.counts ? `${state.counts.aircraft} aircraft / ${state.counts.objects} objects` : '';
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  document.querySelectorAll('.mode').forEach((s) => (s.hidden = s.id !== 'mode-' + mode));
  fitCanvases();
  render();
}

function render() {
  pruneSelections();
  if (state.mode === 'gca') renderGca();
  else if (state.mode === 'gci') renderGci();
  else if (state.mode === 'twr') renderTwr();
  else if (state.mode === 'lso') renderLso();
}

function pruneSelections() {
  const ids = new Set(state.tracks.map((t) => t.id));
  if (state.selectedId && !ids.has(state.selectedId)) state.selectedId = null;
  if (state.targetId && !ids.has(state.targetId)) state.targetId = null;
  if (state.ownshipId && !ids.has(state.ownshipId)) state.ownshipId = null;
  if (state.carrierId && !ids.has(state.carrierId)) state.carrierId = null;
  if (state.lsoAircraftId && !ids.has(state.lsoAircraftId)) state.lsoAircraftId = null;
}

function clearBlips(canvasId) {
  blipIndex[canvasId] = [];
}

function registerBlip(canvasId, id, x, y) {
  blipIndex[canvasId].push({ id, x, y });
}

function attachCanvasPick(canvasId, onPick) {
  const canvas = document.getElementById(canvasId);
  canvas.addEventListener('click', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const px = (ev.clientX - rect.left) * (canvas.width / rect.width);
    const py = (ev.clientY - rect.top) * (canvas.height / rect.height);
    let best = null;
    let bd = 400; // 20 px radius squared
    for (const b of blipIndex[canvasId] || []) {
      const d = (b.x - px) * (b.x - px) + (b.y - py) * (b.y - py);
      if (d < bd) {
        bd = d;
        best = b.id;
      }
    }
    if (best) onPick(best);
  });
}

/* ---------- shared track symbols ---------- */

function drawSymbol(ctx, t, x, y, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.5;

  if (t.category === 'FixedWing') {
    ctx.rotate((courseDeg(t) * Math.PI) / 180);
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(7, 9);
    ctx.lineTo(0, 5);
    ctx.lineTo(-7, 9);
    ctx.closePath();
    ctx.stroke();
  } else if (t.category === 'Rotorcraft') {
    ctx.beginPath();
    ctx.arc(0, 0, 6, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.strokeRect(-5, -5, 10, 10);
  }
  ctx.restore();
}

function drawTrackLabel(ctx, t, x, y, color) {
  ctx.fillStyle = color;
  ctx.font = '11px Consolas, monospace';
  const lines = [t.pilot || t.name || t.id];
  if (t.altFt !== null && t.altFt !== undefined) lines.push(Math.round(t.altFt) + 'ft');
  if (t.gsKt) lines.push(t.gsKt + 'kt');
  lines.forEach((ln, i) => ctx.fillText(ln, x + 10, y - 4 + i * 12));
}

/* ================= GCA mode ================= */

const GCA_MIN_RANGE_NM = 2;
const GCA_MAX_RANGE_NM = 30;

function renderGca() {
  drawAzimuth();
  drawElevation();
  renderDigest();
  renderApproachTable();
}

/* ---------- approach digest (per-aircraft deviation history) ---------- */

const DIGEST_HISTORY = 60; // samples kept per aircraft (~12 s at 5 Hz)
const digestHistory = new Map(); // track id -> [{ az, gs, rng }]

function pushDigestSample(t) {
  const ap = t.approach;
  let h = digestHistory.get(t.id);
  if (!h) {
    h = [];
    digestHistory.set(t.id, h);
  }
  h.push({ az: ap.azDevDeg, gs: ap.gsDevDeg, rng: ap.rangeNm });
  if (h.length > DIGEST_HISTORY) h.shift();
  return h;
}

/** how well the aircraft has been holding course and glidepath lately */
function gradeOf(history) {
  const az = state.tolerance.azToleranceDeg;
  const gs = state.tolerance.gsToleranceDeg;
  const recent = history.slice(-25);
  if (!recent.length) return { cls: 'grade-fair', text: '--' };
  let inTol = 0;
  for (const s of recent) {
    const okAz = Math.abs(s.az) <= az;
    const okGs = s.gs === null || Math.abs(s.gs) <= gs;
    if (okAz && okGs) inTol++;
  }
  const ratio = inTol / recent.length;
  if (ratio >= 0.8) return { cls: 'grade-good', text: 'ON PARAMS' };
  if (ratio >= 0.4) return { cls: 'grade-fair', text: 'DRIFTING' };
  return { cls: 'grade-poor', text: 'OFF PARAMS' };
}

function renderDigest() {
  const panel = document.getElementById('digestPanel');
  const rows = state.tracks
    .filter((t) => t.approach && t.approach.onFinal && !t.onGround)
    .sort((a, b) => a.approach.rangeNm - b.approach.rangeNm);

  const live = new Set(rows.map((t) => t.id));
  for (const id of [...digestHistory.keys()]) if (!live.has(id)) digestHistory.delete(id);

  if (rows.length === 0) {
    panel.innerHTML = '<div class="digest-empty">no aircraft on final</div>';
    return;
  }

  // keep the existing DOM nodes so the sparklines do not flicker at 5 Hz
  const seen = new Set();
  for (const t of rows) {
    const history = pushDigestSample(t);
    const ap = t.approach;
    const grade = gradeOf(history);
    let row = panel.querySelector('[data-digest-id="' + cssEscape(t.id) + '"]');
    if (!row) {
      row = document.createElement('div');
      row.className = 'digest-row';
      row.dataset.digestId = t.id;
      row.innerHTML =
        '<div class="digest-head"><span class="digest-callsign"></span>' +
        '<span class="digest-status"></span><span class="grade"></span></div>' +
        '<div class="digest-stats"></div>' +
        '<canvas class="sparkline" width="320" height="40"></canvas>';
      panel.appendChild(row);
    }
    seen.add(row);

    row.querySelector('.digest-callsign').textContent = t.pilot || t.name || t.id;
    row.querySelector('.digest-status').textContent = ap.guidance || '';
    const badge = row.querySelector('.grade');
    badge.textContent = grade.text;
    badge.className = 'grade ' + grade.cls;
    row.querySelector('.digest-stats').textContent =
      `RNG ${ap.rangeNm.toFixed(1)} nm  ALT ${t.altFt ?? '-'} ft` +
      (ap.gpAltFt !== null ? ` (GP ${ap.gpAltFt})` : '') +
      `  VS ${t.vsFpm ?? '-'}  GS ${t.gsKt ?? '-'} kt`;
    drawSparkline(row.querySelector('.sparkline'), history);
  }

  for (const child of [...panel.children]) {
    if (!seen.has(child)) panel.removeChild(child);
  }
}

/** deviation history: azimuth (green) and glidepath (amber) around the centre line */
function drawSparkline(canvas, history) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const azTol = state.tolerance.azToleranceDeg;
  const gsTol = state.tolerance.gsToleranceDeg;

  // tolerance band + centre line
  ctx.fillStyle = '#0e1a14';
  ctx.fillRect(0, H / 2 - H * 0.15, W, H * 0.3);
  ctx.strokeStyle = '#1d2a36';
  ctx.beginPath();
  ctx.moveTo(0, H / 2);
  ctx.lineTo(W, H / 2);
  ctx.stroke();

  const plot = (key, tol, color) => {
    const scale = tol * 5; // full scale = 5x tolerance
    ctx.strokeStyle = color;
    ctx.beginPath();
    let started = false;
    history.forEach((s, i) => {
      const v = s[key];
      if (v === null || v === undefined) return;
      const x = (i / Math.max(1, DIGEST_HISTORY - 1)) * W;
      const y = H / 2 - Math.max(-1, Math.min(1, v / scale)) * (H / 2 - 2);
      if (started) ctx.lineTo(x, y);
      else {
        ctx.moveTo(x, y);
        started = true;
      }
    });
    ctx.stroke();
  };

  plot('az', azTol, '#39ff8b');
  plot('gs', gsTol, '#ffc23d');
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

function drawAzimuth() {
  const canvas = document.getElementById('azimuthScope');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  clearBlips('azimuthScope');

  const padL = 50, padR = 20, padT = 15, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const R = state.gcaRangeNm;
  const C = Math.max(0.5, R / 4); // cross-track half-width scales with range

  const xOf = (nm) => padL + (nm / R) * plotW;
  const yOf = (crossNm) => padT + ((C - crossNm) / (2 * C)) * plotH;

  grid(ctx, xOf, yOf, padL, padT, plotW, plotH, 'RNG nm', 'AZ', R);

  ctx.strokeStyle = '#2a5a3a';
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(0));
  ctx.lineTo(xOf(R), yOf(0));
  ctx.stroke();

  ctx.strokeStyle = '#1e3a28';
  for (const dev of [1, -1]) {
    const yEnd = yOf(Math.tan((dev * Math.PI) / 180) * R);
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(0));
    ctx.lineTo(xOf(R), yEnd);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // the scope is drawn looking along the approach course, so the upper half is
  // right of centreline
  ctx.fillStyle = '#5a6b7a';
  ctx.font = '11px Consolas, monospace';
  ctx.fillText('R', padL - 18, padT + plotH * 0.25);
  ctx.fillText('L', padL - 18, padT + plotH * 0.75);

  for (const t of state.tracks) {
    const ap = t.approach;
    if (!ap || ap.alongNm < -0.5 || ap.alongNm > R) continue;
    if (Math.abs(ap.crossNm) > C) continue;
    const x = xOf(ap.alongNm), y = yOf(ap.crossNm);
    const color = t.id === state.selectedId ? '#ffc23d' : '#39ff8b';
    drawSymbol(ctx, t, x, y, color);
    drawTrackLabel(ctx, t, x, y, color);
    registerBlip('azimuthScope', t.id, x, y);
  }
}

function drawElevation() {
  const canvas = document.getElementById('elevationScope');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  clearBlips('elevationScope');

  const padL = 60, padR = 20, padT = 15, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const rwy = runwayCfg();
  const thrAlt = rwy ? rwy.threshold.altFt : 0;
  const glide = rwy ? rwy.glidepathDeg : 3;

  const R = state.gcaRangeNm;
  // altitude axis follows the glidepath so the beam stays mid-screen
  const ALT = Math.max(
    1000,
    Math.round((Math.tan((glide * Math.PI) / 180) * R * M_PER_NM * 3.28084) / 500) * 500
  );

  const xOf = (nm) => padL + (nm / R) * plotW;
  const yOf = (altFt) => padT + ((ALT - (altFt - thrAlt)) / ALT) * plotH;

  grid(ctx, xOf, yOf, padL, padT, plotW, plotH, 'RNG nm', 'AGL ft', R);

  const altAtMax = Math.tan((glide * Math.PI) / 180) * R * M_PER_NM * 3.28084;
  ctx.strokeStyle = '#2a5a3a';
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(thrAlt));
  ctx.lineTo(xOf(R), yOf(thrAlt + Math.min(altAtMax, ALT)));
  ctx.stroke();
  ctx.setLineDash([]);

  for (const t of state.tracks) {
    const ap = t.approach;
    if (!ap || ap.altFt === null || ap.alongNm < -0.5 || ap.alongNm > R) continue;
    const x = xOf(ap.alongNm), y = yOf(ap.altFt);
    const color = t.id === state.selectedId ? '#ffc23d' : '#39ff8b';
    drawSymbol(ctx, t, x, y, color);
    registerBlip('elevationScope', t.id, x, y);
  }
}

function grid(ctx, xOf, yOf, padL, padT, plotW, plotH, xLabel, yLabel, maxRange, yLabelX) {
  ctx.strokeStyle = '#14202b';
  ctx.fillStyle = '#5a6b7a';
  ctx.font = '11px Consolas, monospace';

  const step = Math.max(1, Math.round(maxRange / 6));
  for (let nm = 0; nm <= maxRange + 0.01; nm += step) {
    const x = xOf(nm);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.fillText(String(nm), x - 6, padT + plotH + 16);
  }
  ctx.fillText(xLabel, padL + plotW / 2 - 20, padT + plotH + 28);

  for (let i = 0; i <= 4; i++) {
    const y = padT + (i / 4) * plotH;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
  }
  ctx.fillText(yLabel, yLabelX === undefined ? 8 : yLabelX, padT + 10);
}

function renderApproachTable() {
  const tbody = document.querySelector('#trackTable tbody');
  tbody.innerHTML = '';

  const rows = state.tracks
    .filter((t) => t.approach && t.approach.onFinal && !t.onGround)
    .sort((a, b) => a.approach.rangeNm - b.approach.rangeNm);

  for (const t of rows) {
    const ap = t.approach;
    const tr = document.createElement('tr');
    tr.dataset.id = t.id;
    if (t.id === state.selectedId) tr.style.background = '#1c2a1f';

    const gsTxt = ap.gsDevDeg === null ? '-' : (ap.gsDevDeg > 0 ? '+' : '') + ap.gsDevDeg.toFixed(2) + '°';
    const onCourse = Math.abs(ap.azDevDeg) < state.tolerance.azToleranceDeg;
    const onGp = ap.gsDevDeg !== null && Math.abs(ap.gsDevDeg) < state.tolerance.gsToleranceDeg;

    tr.innerHTML =
      '<td>' + escapeHtml(t.pilot || t.name) + '</td>' +
      '<td>' + escapeHtml(t.name) + '</td>' +
      '<td>' + ap.rangeNm.toFixed(2) + '</td>' +
      '<td>' + (ap.azDevDeg > 0 ? 'R' : 'L') + ' ' + Math.abs(ap.azDevDeg).toFixed(2) + '°</td>' +
      '<td>' + gsTxt + '</td>' +
      '<td>' + (t.altFt === null ? '-' : t.altFt) + '</td>' +
      '<td>' + (t.vsFpm === null || t.vsFpm === undefined ? '-' : t.vsFpm) + '</td>' +
      '<td>' + (t.gsKt === null ? '-' : t.gsKt) + '</td>' +
      '<td class="' + (onCourse && onGp ? 'guidance-ok' : 'guidance-warn') + '">' +
      escapeHtml(ap.guidance) + '</td>';
    tbody.appendChild(tr);
  }

  if (rows.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="9" class="empty">no traffic on final</td>';
    tbody.appendChild(tr);
  }
}

/* ---------- map background (OpenStreetMap tiles) ---------- */

/* Optional geographic underlay for the north-up scopes (GCI PPI, TWR field
 * view). Tiles come from the OSM tile CDN and are cached in memory; a tile
 * that cannot be loaded (offline, blocked CDN) is marked failed and never
 * retried, so the scopes simply fall back to plain radar. */

const MAP_TILE_URL = 'https://tile.openstreetmap.org';
const MAP_TILE_PX = 256;
const MAP_ALPHA = 0.35;
const MAP_CACHE_MAX = 400;

const mapPrefs = { enabled: localStorage.getItem('gcaMap') !== 'off' };
const tileCache = new Map(); // url -> { img, ready, failed }
let mapRenderQueued = false;

function lonToTileX(lon, z) {
  return ((lon + 180) / 360) * Math.pow(2, z);
}

function latToTileY(lat, z) {
  const rad = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z);
}

function getTile(url) {
  let entry = tileCache.get(url);
  if (!entry) {
    if (tileCache.size >= MAP_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
    const img = new Image();
    entry = { img, ready: false, failed: false };
    tileCache.set(url, entry);
    img.onload = () => {
      entry.ready = true;
      scheduleMapRender();
    };
    img.onerror = () => {
      entry.failed = true; // offline -> keep radar-only
    };
    img.src = url;
  }
  return entry;
}

function scheduleMapRender() {
  if (mapRenderQueued) return;
  mapRenderQueued = true;
  requestAnimationFrame(() => {
    mapRenderQueued = false;
    render();
  });
}

/** dim OSM raster under a north-up scope centred on `ref` (threshold lat/lon) */
function drawMapBackground(ctx, W, H, ref, mPerPx) {
  if (!mapPrefs.enabled || !ref || ref.lat === undefined || ref.lon === undefined) return;

  const latRad = (ref.lat * Math.PI) / 180;
  const zoom = Math.max(
    3,
    Math.min(16, Math.round(Math.log2((156543.034 * Math.cos(latRad)) / mPerPx)))
  );
  const resM = (156543.034 * Math.cos(latRad)) / Math.pow(2, zoom); // metres per tile pixel
  const k = resM / mPerPx; // canvas pixels per tile pixel
  const cxp = lonToTileX(ref.lon, zoom) * MAP_TILE_PX;
  const cyp = latToTileY(ref.lat, zoom) * MAP_TILE_PX;

  const x0 = Math.floor((cxp - W / 2 / k) / MAP_TILE_PX);
  const x1 = Math.floor((cxp + W / 2 / k) / MAP_TILE_PX);
  const y0 = Math.floor((cyp - H / 2 / k) / MAP_TILE_PX);
  const y1 = Math.floor((cyp + H / 2 / k) / MAP_TILE_PX);
  const n = Math.pow(2, zoom);

  ctx.save();
  ctx.globalAlpha = MAP_ALPHA;
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = Math.max(0, y0); ty <= Math.min(n - 1, y1); ty++) {
      const wx = ((tx % n) + n) % n;
      const entry = getTile(`${MAP_TILE_URL}/${zoom}/${wx}/${ty}.png`);
      if (!entry.ready || entry.failed) continue;
      ctx.drawImage(
        entry.img,
        W / 2 + (tx * MAP_TILE_PX - cxp) * k,
        H / 2 + (ty * MAP_TILE_PX - cyp) * k,
        MAP_TILE_PX * k + 1,
        MAP_TILE_PX * k + 1
      );
    }
  }
  ctx.restore();

  ctx.fillStyle = '#5a6b7a';
  ctx.font = '10px Consolas, monospace';
  ctx.textAlign = 'right';
  ctx.fillText('© OpenStreetMap contributors', W - 8, H - 8);
  ctx.textAlign = 'left';
}

/* ================= GCI mode ================= */

function renderGci() {
  drawPpi();
  updateOwnshipSelect();
  updateInterceptInfo();
}

function drawPpi() {
  const canvas = document.getElementById('ppiScope');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  clearBlips('ppiScope');

  const rwy = runwayCfg();
  if (!rwy) return;
  const cx = W / 2, cy = H / 2;
  const radius = Math.min(W, H) / 2 - 40;
  const mPerPx = (state.gciRangeNm * M_PER_NM) / radius;

  const sx = (x) => cx + x / mPerPx;
  const sy = (y) => cy - y / mPerPx;

  drawMapBackground(ctx, W, H, rwy.threshold, mPerPx);

  ctx.strokeStyle = '#14202b';
  ctx.fillStyle = '#5a6b7a';
  ctx.font = '11px Consolas, monospace';
  const step = state.gciRangeNm / 4;
  for (let r = step; r <= state.gciRangeNm + 0.01; r += step) {
    ctx.beginPath();
    ctx.arc(cx, cy, (r * M_PER_NM) / mPerPx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText(r.toFixed(0), cx + 4, cy - (r * M_PER_NM) / mPerPx - 3);
  }
  ctx.beginPath();
  ctx.moveTo(cx - radius, cy);
  ctx.lineTo(cx + radius, cy);
  ctx.moveTo(cx, cy - radius);
  ctx.lineTo(cx, cy + radius);
  ctx.stroke();

  ctx.fillStyle = '#5a6b7a';
  ctx.font = '13px Consolas, monospace';
  ctx.fillText('N', cx - 4, cy - radius - 8);
  ctx.fillText('S', cx - 4, cy + radius + 16);
  ctx.fillText('E', cx + radius + 8, cy + 4);
  ctx.fillText('W', cx - radius - 16, cy + 4);

  // runway strip, drawn from the threshold away from the approach direction
  const hdgRad = (rwy.headingDeg * Math.PI) / 180;
  const lenM = (rwy.lengthNm || 1.2) * M_PER_NM;
  ctx.strokeStyle = '#3a5a4a';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(sx(0), sy(0));
  ctx.lineTo(sx(Math.sin(hdgRad) * lenM), sy(Math.cos(hdgRad) * lenM));
  ctx.stroke();
  ctx.lineWidth = 1.5;

  for (const t of state.tracks) {
    const p = relToRunway(t, rwy);
    if (!p) continue;
    if (Math.hypot(p.x, p.y) / M_PER_NM > state.gciRangeNm) continue;
    const x = sx(p.x), y = sy(p.y);

    let color = '#39ff8b';
    if (t.id === state.targetId) color = '#ff5252';
    else if (t.id === state.ownshipId) color = '#4dc3ff';

    drawSymbol(ctx, t, x, y, color);
    drawTrackLabel(ctx, t, x, y, color);
    registerBlip('ppiScope', t.id, x, y);

    // velocity leader: one minute of travel
    const spd = speedMs(t);
    if (spd > 0) {
      const h = (courseDeg(t) * Math.PI) / 180;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (Math.sin(h) * spd * 60) / mPerPx, y - (Math.cos(h) * spd * 60) / mPerPx);
      ctx.stroke();
    }
  }
}

function updateOwnshipSelect() {
  const sel = document.getElementById('ownshipSelect');
  const current = state.ownshipId || '';
  const airborne = state.tracks.filter(isAircraft);
  const ids = new Set(airborne.map((t) => t.id));

  const sig = airborne.map((t) => t.id).join(',');
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '-- none --';
    sel.appendChild(none);
    for (const t of airborne) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.pilot || t.name || t.id;
      sel.appendChild(opt);
    }
  }
  sel.value = ids.has(current) ? current : '';
  if (sel.value === '') state.ownshipId = null;
  sel.onchange = () => {
    state.ownshipId = sel.value || null;
    render();
  };
}

/**
 * Straight-line intercept solution (lead pursuit) in the runway-local frame.
 */
function interceptSolution(own, tgt) {
  const rwy = runwayCfg();
  const ro = relToRunway(own, rwy);
  const rt = relToRunway(tgt, rwy);
  if (!ro || !rt) return null;
  const r = { x: rt.x - ro.x, y: rt.y - ro.y };

  const distM = Math.hypot(r.x, r.y);
  const brg = (Math.atan2(r.x, r.y) * 180) / Math.PI;

  const hO = (courseDeg(own) * Math.PI) / 180;
  const hT = (courseDeg(tgt) * Math.PI) / 180;
  const sO = speedMs(own);
  const sT = speedMs(tgt);
  const vo = { x: Math.sin(hO) * sO, y: Math.cos(hO) * sO };
  const vt = { x: Math.sin(hT) * sT, y: Math.cos(hT) * sT };

  const u = { x: vt.x - vo.x, y: vt.y - vo.y };
  const uu = u.x * u.x + u.y * u.y;

  let steerBrg = brg;
  let ttiSec = null;
  let closureKt = null;

  if (uu > 1) {
    const tStar = Math.max(0, Math.min(600, -(r.x * u.x + r.y * u.y) / uu));
    const ip = { x: r.x + vt.x * tStar, y: r.y + vt.y * tStar };
    steerBrg = (Math.atan2(ip.x, ip.y) * 180) / Math.PI;
    if (tStar > 0.5) ttiSec = tStar;
  }
  if (distM > 1) {
    const closing = -(r.x * u.x + r.y * u.y) / distM; // m/s
    closureKt = Math.round(closing / KT_TO_MS);
    if (closing > 1 && ttiSec === null) ttiSec = distM / closing;
  }

  return {
    distNm: Math.round((distM / M_PER_NM) * 10) / 10,
    brg: fmtBrg(brg),
    steer: fmtBrg(steerBrg),
    closureKt,
    deltaAltFt: own.altFt !== null && tgt.altFt !== null ? tgt.altFt - own.altFt : null,
    tti: ttiSec !== null ? fmtTti(ttiSec) : '--:--',
  };
}

function fmtTti(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function updateInterceptInfo() {
  const el = document.getElementById('interceptInfo');
  const own = state.tracks.find((t) => t.id === state.ownshipId);
  const tgt = state.tracks.find((t) => t.id === state.targetId);

  if (!own || !tgt) {
    el.innerHTML = '<div class="cell">Select OWN (dropdown) and TARGET (click blip) on the scope.</div>';
    return;
  }

  const sol = interceptSolution(own, tgt);
  if (!sol) {
    el.innerHTML = '<div class="cell">No position data.</div>';
    return;
  }
  const cells = [
    ['OWN', own.pilot || own.name || own.id],
    ['TARGET', tgt.pilot || tgt.name || tgt.id],
    ['RNG (nm)', sol.distNm],
    ['BRG TO TGT', sol.brg],
    ['STEER', sol.steer],
    ['CLOSURE (kt)', sol.closureKt === null ? '-' : sol.closureKt],
    ['DELTA ALT (ft)', sol.deltaAltFt === null ? '-' : (sol.deltaAltFt > 0 ? '+' : '') + sol.deltaAltFt],
    ['TIME TO INT.', sol.tti],
  ];
  el.innerHTML = cells
    .map(
      ([k, v]) =>
        '<div class="cell"><div class="k">' + escapeHtml(k) + '</div><div class="v">' + escapeHtml(v) + '</div></div>'
    )
    .join('');
}

/* ================= TWR mode ================= */

function renderTwr() {
  document.querySelector('#mode-twr h2').textContent =
    'Aerodrome View (' + state.twrRangeNm.toFixed(1) + ' nm) - scroll to zoom';
  drawTwrScope();
  renderFieldTable();
}

function drawTwrScope() {
  const canvas = document.getElementById('twrScope');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  clearBlips('twrScope');

  const rwy = runwayCfg();
  if (!rwy) return;
  const cx = W / 2, cy = H / 2;
  const radius = Math.min(W, H) / 2 - 30;
  const mPerPx = (state.twrRangeNm * M_PER_NM) / radius;

  const sx = (x) => cx + x / mPerPx;
  const sy = (y) => cy - y / mPerPx;

  drawMapBackground(ctx, W, H, rwy.threshold, mPerPx);

  ctx.strokeStyle = '#14202b';
  ctx.fillStyle = '#5a6b7a';
  ctx.font = '11px Consolas, monospace';
  for (let r = 1; r <= state.twrRangeNm; r++) {
    ctx.beginPath();
    ctx.arc(cx, cy, (r * M_PER_NM) / mPerPx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText(r + 'nm', cx + 4, cy - (r * M_PER_NM) / mPerPx - 3);
  }

  const hdgRad = (rwy.headingDeg * Math.PI) / 180;
  const sinH = Math.sin(hdgRad), cosH = Math.cos(hdgRad);

  // runway: from the threshold along the landing heading
  const lenM = (rwy.lengthNm || 1.2) * M_PER_NM;
  ctx.strokeStyle = '#3a5a4a';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(sx(0), sy(0));
  ctx.lineTo(sx(sinH * lenM), sy(cosH * lenM));
  ctx.stroke();

  // extended centreline: the 5 nm final, on the opposite side of the threshold
  ctx.strokeStyle = '#2a5a3a';
  ctx.setLineDash([8, 8]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(sx(0), sy(0));
  ctx.lineTo(sx(-sinH * 5 * M_PER_NM), sy(-cosH * 5 * M_PER_NM));
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#7aa892';
  ctx.fillText('THR ' + (rwy.designator || rwy.id), sx(0) + 8, sy(0) - 8);

  for (const t of state.tracks) {
    const p = relToRunway(t, rwy);
    if (!p) continue;
    if (Math.hypot(p.x, p.y) / M_PER_NM > state.twrRangeNm) continue;
    const x = sx(p.x), y = sy(p.y);
    const color = t.onGround ? '#8a9aa8' : t.id === state.selectedId ? '#ffc23d' : '#39ff8b';
    drawSymbol(ctx, t, x, y, color);
    drawTrackLabel(ctx, t, x, y, color);
    registerBlip('twrScope', t.id, x, y);
  }
}

function renderFieldTable() {
  const tbody = document.querySelector('#fieldTable tbody');
  tbody.innerHTML = '';

  const rwy = runwayCfg();
  if (!rwy) return;

  const rows = state.tracks
    .map((t) => {
      const p = relToRunway(t, rwy);
      if (!p) return null;
      return {
        t,
        distNm: Math.hypot(p.x, p.y) / M_PER_NM,
        brg: normDeg((Math.atan2(p.x, p.y) * 180) / Math.PI),
      };
    })
    .filter((r) => r && r.distNm <= state.twrRangeNm)
    .sort((a, b) => a.distNm - b.distNm);

  for (const r of rows) {
    const t = r.t;
    const tr = document.createElement('tr');
    tr.dataset.id = t.id;
    if (t.id === state.selectedId) tr.style.background = '#1c2a1f';
    tr.innerHTML =
      '<td>' + escapeHtml(t.pilot || t.name) + '</td>' +
      '<td>' + escapeHtml(t.name) + '</td>' +
      '<td>' + r.distNm.toFixed(2) + '</td>' +
      '<td>' + fmtBrg(r.brg) + '</td>' +
      '<td>' + (t.altFt === null ? '-' : t.altFt) + '</td>' +
      '<td>' + (t.vsFpm === null || t.vsFpm === undefined ? '-' : t.vsFpm) + '</td>' +
      '<td>' + (t.gsKt === null ? '-' : t.gsKt) + '</td>';
    tbody.appendChild(tr);
  }

  if (rows.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="7" class="empty">no traffic within ' + state.twrRangeNm.toFixed(1) + ' nm</td>';
    tbody.appendChild(tr);
  }
}

/* ================= LSO mode ================= */

/* IFLOLS-style carrier landing aid. The reference is the carrier (Sea) track
 * itself: the deck is assumed to sit at the carrier's position and altitude,
 * and the approach course is the carrier's heading (into-wind recovery). */

const LSO_GLIDEPATH_DEG = 3.0;
const LSO_MIN_RANGE_NM = 1;
const LSO_MAX_RANGE_NM = 8;

function carriers() {
  return state.tracks.filter((t) => t.category === 'Sea');
}

function carrierCfg() {
  return state.tracks.find((t) => t.id === state.carrierId) || null;
}

/** offsets in metres (east, north) of a track from an arbitrary reference track */
function relToRef(t, ref) {
  if (t.u !== undefined && t.u !== null && ref.u !== undefined && ref.u !== null) {
    return { x: t.u - ref.u, y: t.v - ref.v };
  }
  if (t.lat === undefined || t.lat === null || ref.lat === undefined) return null;
  const latRad = (ref.lat * Math.PI) / 180;
  return {
    x: (t.lon - ref.lon) * 111320 * Math.cos(latRad),
    y: (t.lat - ref.lat) * 111320,
  };
}

/** glideslope / lineup solution of `ac` relative to the carrier's deck */
function lsoSolution(ac, car) {
  const off = relToRef(ac, car);
  if (!off) return null;

  const hdgRad = (courseDeg(car) * Math.PI) / 180;
  const sinH = Math.sin(hdgRad);
  const cosH = Math.cos(hdgRad);

  // same convention as the PAR: an aircraft on final sits astern of the
  // reference point flying towards it, so dot(rel, heading) is negative
  const along = -(off.x * sinH + off.y * cosH); // metres still to fly
  const cross = off.x * cosH - off.y * sinH;    // + right of centreline

  const deckAltFt = car.altFt !== null && car.altFt !== undefined ? car.altFt : 0;
  const aglFt = ac.altFt !== null && ac.altFt !== undefined ? ac.altFt - deckAltFt : null;

  const elevDeg =
    along > 50 && aglFt !== null ? (Math.atan2(aglFt * 0.3048, along) * 180) / Math.PI : null;
  const lineupDeg = along > 50 ? (Math.atan2(cross, along) * 180) / Math.PI : null;

  return {
    rangeNm: Math.hypot(off.x, off.y) / M_PER_NM,
    alongNm: along / M_PER_NM,
    crossNm: cross / M_PER_NM,
    aglFt,
    gsDevDeg: elevDeg !== null ? elevDeg - LSO_GLIDEPATH_DEG : null,
    lineupDeg,
    // Tacview does not carry AoA; shown when a future stream provides it
    aoaDeg: ac.aoaDeg !== undefined && ac.aoaDeg !== null ? ac.aoaDeg : null,
  };
}

function renderLso() {
  updateCarrierSelect();
  updateLsoPilotSelect();
  drawLsoScope();
  drawLsoPlatformView();
  updateLsoInfo();
}

function updateCarrierSelect() {
  const sel = document.getElementById('carrierSelect');
  const list = carriers();
  const sig = list.map((t) => t.id).join(',');
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '-- none --';
    sel.appendChild(none);
    for (const c of list) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name || c.id;
      sel.appendChild(opt);
    }
  }
  sel.value = list.some((t) => t.id === state.carrierId) ? state.carrierId : '';
  if (sel.value === '') state.carrierId = null;
  sel.onchange = () => {
    state.carrierId = sel.value || null;
    render();
  };
}

function updateLsoPilotSelect() {
  const sel = document.getElementById('lsoPilotSelect');
  const car = carrierCfg();
  const carId = car ? car.id : null;
  const list = state.tracks.filter((t) => isAircraft(t) && !t.onGround && t.id !== carId);
  const ids = new Set(list.map((t) => t.id));

  const sig = list.map((t) => t.id).join(',');
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '-- none --';
    sel.appendChild(none);
    for (const t of list) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.pilot || t.name || t.id;
      sel.appendChild(opt);
    }
  }
  sel.value = ids.has(state.lsoAircraftId) ? state.lsoAircraftId : '';
  if (sel.value === '') state.lsoAircraftId = null;
  sel.onchange = () => {
    state.lsoAircraftId = sel.value || null;
    render();
  };
}

function drawLsoScope() {
  const canvas = document.getElementById('lsoScope');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  clearBlips('lsoScope');

  const car = carrierCfg();
  ctx.fillStyle = '#5a6b7a';
  ctx.font = '13px Consolas, monospace';
  if (!car) {
    ctx.fillText('select a carrier (Sea) track', 20, H / 2);
    return;
  }

  const R = state.lsoRangeNm;
  const mid = W / 2;

  /* ----- left panel: LINEUP (top-down view along the recovery course) ----- */
  const padL = 50, padR = 25, padT = 30, padB = 30;
  const plotW = mid - padL - padR, plotH = H - padT - padB;
  const C = Math.max(0.15, R / 8); // cross-track half width (nm)

  const lxOf = (nm) => padL + (nm / R) * plotW;
  const lyOf = (crossNm) => padT + ((C - crossNm) / (2 * C)) * plotH;

  grid(ctx, lxOf, lyOf, padL, padT, plotW, plotH, 'RNG nm', 'LINEUP', R);

  ctx.strokeStyle = '#2a5a3a';
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(lxOf(0), lyOf(0));
  ctx.lineTo(lxOf(R), lyOf(0));
  ctx.stroke();

  // +/- 1 deg lineup corridors
  ctx.strokeStyle = '#1e3a28';
  for (const dev of [1, -1]) {
    ctx.beginPath();
    ctx.moveTo(lxOf(0), lyOf(0));
    ctx.lineTo(lxOf(R), lyOf(Math.tan((dev * Math.PI) / 180) * R));
    ctx.stroke();
  }
  ctx.setLineDash([]);

  ctx.fillStyle = '#7aa892';
  ctx.fillText('DECK', lxOf(0) + 6, lyOf(0) - 8);

  /* ----- right panel: GLIDESLOPE (altitude above deck vs distance) ----- */
  const gPadL = 60;
  const gPlotW = W - mid - gPadL - padR;
  const ALT = Math.max(
    500,
    Math.round((Math.tan((LSO_GLIDEPATH_DEG * Math.PI) / 180) * R * M_PER_NM * 3.28084) / 250) * 250
  );

  const gxOf = (nm) => mid + gPadL + (nm / R) * gPlotW;
  const gyOf = (aglFt) => padT + ((ALT - aglFt) / ALT) * plotH;

  grid(ctx, gxOf, gyOf, mid + gPadL, padT, gPlotW, plotH, 'RNG nm', 'AGL ft', R, mid + gPadL - 44);

  ctx.strokeStyle = '#2a5a3a';
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(gxOf(0), gyOf(0));
  ctx.lineTo(gxOf(R), gyOf(Math.tan((LSO_GLIDEPATH_DEG * Math.PI) / 180) * R * M_PER_NM * 3.28084));
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#5a6b7a';
  ctx.font = '11px Consolas, monospace';
  ctx.fillText(
    LSO_GLIDEPATH_DEG.toFixed(1) + '° GP',
    gxOf(R * 0.55),
    gyOf(Math.tan((LSO_GLIDEPATH_DEG * Math.PI) / 180) * R * 0.55 * M_PER_NM * 3.28084) - 6
  );

  /* ----- the aircraft ----- */
  const ac = state.tracks.find((t) => t.id === state.lsoAircraftId);
  if (!ac) return;
  const sol = lsoSolution(ac, car);
  if (!sol || sol.alongNm < -0.2 || sol.alongNm > R) return;

  const color = '#4dc3ff';
  const lx = lxOf(sol.alongNm), ly = lyOf(sol.crossNm);
  drawSymbol(ctx, ac, lx, ly, color);
  drawTrackLabel(ctx, ac, lx, ly, color);
  registerBlip('lsoScope', ac.id, lx, ly);

  if (sol.aglFt !== null && sol.aglFt < ALT) {
    const gx = gxOf(sol.alongNm), gy = gyOf(sol.aglFt);
    drawSymbol(ctx, ac, gx, gy, color);
    registerBlip('lsoScope', ac.id, gx, gy);
  }
}

function updateLsoInfo() {
  const el = document.getElementById('lsoInfo');
  const car = carrierCfg();
  const ac = state.tracks.find((t) => t.id === state.lsoAircraftId);

  if (!car || !ac) {
    el.innerHTML = '<div class="cell">Select a CARRIER and an AIRCRAFT (dropdown or click a blip).</div>';
    return;
  }

  const sol = lsoSolution(ac, car);
  if (!sol) {
    el.innerHTML = '<div class="cell">No position data.</div>';
    return;
  }

  const gpTxt =
    sol.gsDevDeg === null ? '-' : (sol.gsDevDeg > 0 ? '+' : '') + sol.gsDevDeg.toFixed(2) + '°';
  const luTxt =
    sol.lineupDeg === null
      ? '-'
      : (sol.lineupDeg > 0 ? 'R ' : 'L ') + Math.abs(sol.lineupDeg).toFixed(2) + '°';

  const cells = [
    ['CARRIER', car.name || car.id],
    ['AIRCRAFT', ac.pilot || ac.name || ac.id],
    ['RNG (nm)', sol.rangeNm.toFixed(2)],
    ['ALT AGL (ft)', sol.aglFt === null ? '-' : Math.round(sol.aglFt)],
    ['GS DEV', gpTxt],
    ['LINEUP', luTxt],
    ['AoA', sol.aoaDeg === null ? '-' : sol.aoaDeg.toFixed(1) + '°'],
    ['CALL', lsoCall(sol)],
  ];
  el.innerHTML = cells
    .map(
      ([k, v]) =>
        '<div class="cell"><div class="k">' + escapeHtml(k) + '</div><div class="v">' + escapeHtml(v) + '</div></div>'
    )
    .join('');
}

/** short LSO-style deviation call, e.g. "HIGH / COME LEFT" or "ON PATH / ON LINEUP" */
function lsoCall(sol) {
  if (sol.gsDevDeg === null || sol.lineupDeg === null) return '-';
  const parts = [];
  parts.push(Math.abs(sol.gsDevDeg) < 0.75 ? 'ON PATH' : sol.gsDevDeg > 0 ? 'HIGH' : 'LOW');
  parts.push(Math.abs(sol.lineupDeg) < 1.0 ? 'ON LINEUP' : sol.lineupDeg > 0 ? 'COME LEFT' : 'COME RIGHT');
  return parts.join(' / ');
}

/* ---------- LSO Platform View ---------- */

/* Pseudo view from the LSO platform astern of the carrier: the camera is
 * fixed to the platform, so the horizon, flight deck and datum stay put in
 * the frame (only a small decorative roll remains) while the aircraft moves
 * as an aft silhouette proportionally to its lineup / glideslope errors.
 * All data comes from lsoSolution(); no AoA or other unavailable inputs. */

const PLATFORM_ROLL_PER_DEG = 0.4;   // decorative horizon tilt per lineup deg
const PLATFORM_ROLL_MAX_DEG = 2;     // clamp so the horizon stays near level
const PLATFORM_PX_PER_DEG_AZ = 14;   // lateral aircraft movement per lineup deg
const PLATFORM_PX_PER_DEG_GS = 22;   // vertical aircraft movement per GS deg

function drawLsoPlatformView() {
  const canvas = document.getElementById('lsoPlatformScope');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const car = carrierCfg();
  const ac = state.tracks.find((t) => t.id === state.lsoAircraftId);
  ctx.fillStyle = '#5a6b7a';
  ctx.font = '13px Consolas, monospace';
  if (!car) {
    ctx.fillText('select a carrier (Sea) track', 20, H / 2);
    return;
  }
  if (!ac) {
    ctx.fillText('select an aircraft', 20, H / 2);
    return;
  }
  const sol = lsoSolution(ac, car);
  if (!sol || sol.lineupDeg === null) {
    ctx.fillText('no solution data', 20, H / 2);
    return;
  }

  const cx = W / 2;
  const hy = H * 0.40;          // nominal horizon height
  const datumY = hy + H * 0.16; // where the jet sits when exactly on the 3.0° path

  /* ----- horizon: fixed to the platform, with only a small decorative roll -----
   * the camera is bolted to the LSO platform, so the sea stays level */
  const rollDeg = Math.max(
    -PLATFORM_ROLL_MAX_DEG,
    Math.min(PLATFORM_ROLL_MAX_DEG, -sol.lineupDeg * PLATFORM_ROLL_PER_DEG)
  );
  ctx.save();
  ctx.translate(cx, hy);
  ctx.rotate((rollDeg * Math.PI) / 180);
  ctx.fillStyle = '#08131c'; // sea shading below the horizon
  ctx.fillRect(-W, 0, 2 * W, H);
  ctx.strokeStyle = '#7aa892';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-W, 0);
  ctx.lineTo(W, 0);
  ctx.stroke();
  ctx.restore();

  /* ----- flight deck: fixed position and scale -----
   * the camera sits on the platform, so the deck never moves in the frame;
   * only the aircraft's silhouette shifts with its errors */
  const deckCy = datumY;
  const dw = 150;
  const dh = 22;

  // hull below the deck
  ctx.fillStyle = '#101c26';
  ctx.strokeStyle = '#3a5a4a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - dw * 0.72, deckCy + dh);
  ctx.lineTo(cx + dw * 0.72, deckCy + dh);
  ctx.lineTo(cx + dw * 0.58, deckCy + dh + 16);
  ctx.lineTo(cx - dw * 0.58, deckCy + dh + 16);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // angled flight deck
  ctx.fillStyle = '#13251d';
  ctx.beginPath();
  ctx.moveTo(cx - dw / 2, deckCy - dh / 2);
  ctx.lineTo(cx + dw / 2, deckCy - dh / 2);
  ctx.lineTo(cx + dw * 0.58, deckCy + dh / 2);
  ctx.lineTo(cx - dw * 0.58, deckCy + dh / 2);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // deck edge lights
  ctx.fillStyle = '#ffc23d';
  for (const fx of [-dw / 2, -dw / 4, 0, dw / 4, dw / 2]) {
    ctx.fillRect(cx + fx - 1.5, deckCy - dh / 2 - 3, 3, 3);
  }

  ctx.fillStyle = '#7aa892';
  ctx.font = '11px Consolas, monospace';
  ctx.fillText('DECK', cx + dw / 2 + 8, deckCy);

  /* ----- 3.0° glidepath datum -----
   * fixed reference: the jet belongs on this line at its present range */
  ctx.strokeStyle = '#2a5a3a';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(W * 0.12, datumY);
  ctx.lineTo(W * 0.88, datumY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#39ff8b';
  ctx.font = '11px Consolas, monospace';
  ctx.fillText(LSO_GLIDEPATH_DEG.toFixed(1) + '° DATUM', W * 0.12, datumY - 6);

  /* ----- the aircraft: aft silhouette, size from range ----- */
  const azOff = Math.max(-W * 0.3, Math.min(W * 0.3, sol.lineupDeg * PLATFORM_PX_PER_DEG_AZ));
  const gsPix =
    sol.gsDevDeg === null
      ? 0
      : Math.max(-H * 0.32, Math.min(H * 0.32, -sol.gsDevDeg * PLATFORM_PX_PER_DEG_GS));
  const ax = cx + azOff;
  const ay = datumY + gsPix;
  const s = Math.max(9, Math.min(32, 22000 / (sol.alongNm * M_PER_NM)));

  drawAftSilhouette(ctx, ax, ay, s, '#4dc3ff');

  /* ----- status overlay ----- */
  ctx.font = '13px Consolas, monospace';
  ctx.fillStyle = '#5a6b7a';
  ctx.fillText('PLATFORM VIEW', 14, 20);

  const call = lsoCall(sol);
  const bad = call.indexOf('LOW') >= 0 || call.indexOf('HIGH') >= 0 || call.indexOf('COME') >= 0;
  ctx.fillStyle = call === '-' ? '#5a6b7a' : bad ? '#ffc23d' : '#39ff8b';
  ctx.textAlign = 'right';
  ctx.fillText(call, W - 14, 20);
  ctx.textAlign = 'left';

  ctx.fillStyle = '#5a6b7a';
  ctx.font = '11px Consolas, monospace';
  ctx.fillText(
    'RNG ' + sol.rangeNm.toFixed(2) + ' nm  AGL ' +
      (sol.aglFt === null ? '-' : Math.round(sol.aglFt)) + ' ft',
    14,
    H - 12
  );
}

/** rear-view aircraft silhouette used by the platform view */
function drawAftSilhouette(ctx, x, y, s, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, s * 0.09);

  // wings
  ctx.beginPath();
  ctx.moveTo(-s, s * 0.15);
  ctx.lineTo(s, s * 0.15);
  ctx.stroke();
  // fuselage
  ctx.beginPath();
  ctx.moveTo(0, -s * 0.55);
  ctx.lineTo(0, s * 0.55);
  ctx.stroke();
  // tailplanes
  ctx.beginPath();
  ctx.moveTo(-s * 0.38, s * 0.45);
  ctx.lineTo(s * 0.38, s * 0.45);
  ctx.stroke();
  // twin vertical tails
  ctx.beginPath();
  ctx.moveTo(-s * 0.14, s * 0.45);
  ctx.lineTo(-s * 0.14, -s * 0.05);
  ctx.moveTo(s * 0.14, s * 0.45);
  ctx.lineTo(s * 0.14, -s * 0.05);
  ctx.stroke();
  ctx.restore();
}

/* ---------- selection wiring ---------- */

attachCanvasPick('ppiScope', (id) => {
  state.targetId = state.targetId === id ? null : id;
  render();
});
for (const c of ['azimuthScope', 'elevationScope', 'twrScope']) {
  attachCanvasPick(c, (id) => {
    state.selectedId = state.selectedId === id ? null : id;
    render();
  });
}
attachCanvasPick('lsoScope', (id) => {
  state.lsoAircraftId = state.lsoAircraftId === id ? null : id;
  render();
});

document.querySelector('#trackTable tbody').addEventListener('click', (ev) => {
  const tr = ev.target.closest('tr');
  if (!tr || !tr.dataset.id) return;
  state.selectedId = state.selectedId === tr.dataset.id ? null : tr.dataset.id;
  render();
});

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
});

document.getElementById('gciRange').addEventListener('change', (ev) => {
  state.gciRangeNm = parseInt(ev.target.value, 10);
  render();
});

/* ---------- mouse wheel zoom ---------- */

function attachWheelZoom(canvasId, getRange, setRange) {
  document.getElementById(canvasId).addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      const factor = ev.deltaY > 0 ? 1.15 : 1 / 1.15; // scroll down = zoom out
      setRange(getRange() * factor);
    },
    { passive: false }
  );
}

attachWheelZoom(
  'ppiScope',
  () => state.gciRangeNm,
  (v) => {
    state.gciRangeNm = Math.min(120, Math.max(2, Math.round(v * 10) / 10));
    const sel = document.getElementById('gciRange');
    for (const opt of sel.options) {
      if (Math.abs(parseFloat(opt.value) - state.gciRangeNm) < 0.05) sel.value = opt.value;
    }
    render();
  }
);

attachWheelZoom(
  'twrScope',
  () => state.twrRangeNm,
  (v) => {
    state.twrRangeNm = Math.min(15, Math.max(1, Math.round(v * 10) / 10));
    render();
  }
);

// GCA scopes share one range (2 - 30 nm); the altitude axis follows the glidepath
function setGcaRange(v) {
  state.gcaRangeNm = Math.min(GCA_MAX_RANGE_NM, Math.max(GCA_MIN_RANGE_NM, Math.round(v * 10) / 10));
  render();
}
attachWheelZoom('azimuthScope', () => state.gcaRangeNm, setGcaRange);
attachWheelZoom('elevationScope', () => state.gcaRangeNm, setGcaRange);
attachPinchZoom('azimuthScope', () => state.gcaRangeNm, setGcaRange);
attachPinchZoom('elevationScope', () => state.gcaRangeNm, setGcaRange);

// LSO scope: 1 - 8 nm from the carrier
function setLsoRange(v) {
  state.lsoRangeNm = Math.min(LSO_MAX_RANGE_NM, Math.max(LSO_MIN_RANGE_NM, Math.round(v * 10) / 10));
  render();
}
attachWheelZoom('lsoScope', () => state.lsoRangeNm, setLsoRange);
attachPinchZoom('lsoScope', () => state.lsoRangeNm, setLsoRange);

document.getElementById('refreshRunways').addEventListener('click', () => {
  send({ type: 'refreshRunways' });
});

/* ---------- map background toggle ---------- */

function syncMapToggle() {
  document.getElementById('mapToggle').classList.toggle('active', mapPrefs.enabled);
}
document.getElementById('mapToggle').addEventListener('click', () => {
  mapPrefs.enabled = !mapPrefs.enabled;
  localStorage.setItem('gcaMap', mapPrefs.enabled ? 'on' : 'off');
  syncMapToggle();
  render();
});
syncMapToggle();

/* ---------- refresh-rate / latency HUD toggle ---------- */

function syncPerfToggle() {
  document.getElementById('perfToggle').classList.toggle('active', perfPrefs.enabled);
  document.getElementById('latency').hidden = !perfPrefs.enabled;
}
document.getElementById('perfToggle').addEventListener('click', () => {
  perfPrefs.enabled = !perfPrefs.enabled;
  localStorage.setItem('gcaPerf', perfPrefs.enabled ? 'on' : 'off');
  syncPerfToggle();
});
syncPerfToggle();

/* ---------- touch: pinch zoom on scopes ---------- */

function attachPinchZoom(canvasId, getRange, setRange) {
  const el = document.getElementById(canvasId);
  if (!el) return;
  let startDist = 0;
  let startRange = 0;

  el.addEventListener('touchstart', (ev) => {
    if (ev.touches.length === 2) {
      startDist = Math.hypot(
        ev.touches[0].clientX - ev.touches[1].clientX,
        ev.touches[0].clientY - ev.touches[1].clientY
      );
      startRange = getRange();
    }
  }, { passive: true });

  el.addEventListener('touchmove', (ev) => {
    if (ev.touches.length === 2 && startDist > 0) {
      ev.preventDefault();
      const dist = Math.hypot(
        ev.touches[0].clientX - ev.touches[1].clientX,
        ev.touches[0].clientY - ev.touches[1].clientY
      );
      if (dist > 10) setRange(startRange * (startDist / dist)); // pinch in = zoom in
    }
  }, { passive: false });

  el.addEventListener('touchend', () => {
    startDist = 0;
  });
}

attachPinchZoom(
  'ppiScope',
  () => state.gciRangeNm,
  (v) => {
    state.gciRangeNm = Math.min(120, Math.max(2, Math.round(v * 10) / 10));
    render();
  }
);

attachPinchZoom(
  'twrScope',
  () => state.twrRangeNm,
  (v) => {
    state.twrRangeNm = Math.min(15, Math.max(1, Math.round(v * 10) / 10));
    render();
  }
);

/* ---------- responsive canvas sizing (smartphones / tablets) ---------- */

const CANVAS_ASPECTS = [
  ['azimuthScope', 900 / 360],
  ['elevationScope', 900 / 300],
  ['ppiScope', 1],
  ['twrScope', 900 / 640],
  ['lsoScope', 900 / 520],
  ['lsoPlatformScope', 900 / 300],
];

function fitCanvases() {
  // render at device resolution so scopes stay crisp on HD/Retina screens
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (const [id, aspect] of CANVAS_ASPECTS) {
    const c = document.getElementById(id);
    if (!c || !c.clientWidth) continue;
    const w = Math.max(280 * dpr, Math.min(1000 * dpr, Math.round(c.clientWidth * dpr)));
    const h = Math.round(w / aspect);
    if (Math.abs(c.width - w) > 4 || Math.abs(c.height - h) > 4) {
      c.width = w;
      c.height = h;
    }
  }
}

window.addEventListener('resize', () => {
  fitCanvases();
  render();
});

/* ---------- boot ---------- */

fitCanvases();
connectWs();
