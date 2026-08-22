'use strict';

/* DCS Web GCA - browser console
 *
 * Modes:
 *   GCA - Precision Approach Radar (azimuth + elevation scopes, talk-down log)
 *   GCI - Ground Controlled Intercept (PPI scope + intercept solution)
 *   TWR - Aerodrome control (field view + traffic list)
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
  gciRangeNm: 20,
  twrRangeNm: 6,
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
  ws = new WebSocket(`${proto}//${location.host}${BASE}ws`);

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
}

function pruneSelections() {
  const ids = new Set(state.tracks.map((t) => t.id));
  if (state.selectedId && !ids.has(state.selectedId)) state.selectedId = null;
  if (state.targetId && !ids.has(state.targetId)) state.targetId = null;
  if (state.ownshipId && !ids.has(state.ownshipId)) state.ownshipId = null;
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

const GCA_MAX_RANGE_NM = 12;
const GCA_MAX_CROSS_NM = 3;
const GCA_MAX_ALT_FT = 6000;

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

  const xOf = (nm) => padL + (nm / GCA_MAX_RANGE_NM) * plotW;
  const yOf = (crossNm) => padT + ((GCA_MAX_CROSS_NM - crossNm) / (2 * GCA_MAX_CROSS_NM)) * plotH;

  grid(ctx, xOf, yOf, padL, padT, plotW, plotH, 'RNG nm', 'AZ');

  ctx.strokeStyle = '#2a5a3a';
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(0));
  ctx.lineTo(xOf(GCA_MAX_RANGE_NM), yOf(0));
  ctx.stroke();

  ctx.strokeStyle = '#1e3a28';
  for (const dev of [1, -1]) {
    const yEnd = yOf(Math.tan((dev * Math.PI) / 180) * GCA_MAX_RANGE_NM);
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(0));
    ctx.lineTo(xOf(GCA_MAX_RANGE_NM), yEnd);
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
    if (!ap || ap.alongNm < -0.5 || ap.alongNm > GCA_MAX_RANGE_NM) continue;
    if (Math.abs(ap.crossNm) > GCA_MAX_CROSS_NM) continue;
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

  const xOf = (nm) => padL + (nm / GCA_MAX_RANGE_NM) * plotW;
  const yOf = (altFt) => padT + ((GCA_MAX_ALT_FT - (altFt - thrAlt)) / GCA_MAX_ALT_FT) * plotH;

  grid(ctx, xOf, yOf, padL, padT, plotW, plotH, 'RNG nm', 'AGL ft');

  const altAtMax = Math.tan((glide * Math.PI) / 180) * GCA_MAX_RANGE_NM * M_PER_NM * 3.28084;
  ctx.strokeStyle = '#2a5a3a';
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(thrAlt));
  ctx.lineTo(xOf(GCA_MAX_RANGE_NM), yOf(thrAlt + Math.min(altAtMax, GCA_MAX_ALT_FT)));
  ctx.stroke();
  ctx.setLineDash([]);

  for (const t of state.tracks) {
    const ap = t.approach;
    if (!ap || ap.altFt === null || ap.alongNm < -0.5 || ap.alongNm > GCA_MAX_RANGE_NM) continue;
    const x = xOf(ap.alongNm), y = yOf(ap.altFt);
    const color = t.id === state.selectedId ? '#ffc23d' : '#39ff8b';
    drawSymbol(ctx, t, x, y, color);
    registerBlip('elevationScope', t.id, x, y);
  }
}

function grid(ctx, xOf, yOf, padL, padT, plotW, plotH, xLabel, yLabel) {
  ctx.strokeStyle = '#14202b';
  ctx.fillStyle = '#5a6b7a';
  ctx.font = '11px Consolas, monospace';

  for (let nm = 0; nm <= GCA_MAX_RANGE_NM; nm += 2) {
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
  ctx.fillText(yLabel, 8, padT + 10);
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

document.getElementById('refreshRunways').addEventListener('click', () => {
  send({ type: 'refreshRunways' });
});

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
];

function fitCanvases() {
  for (const [id, aspect] of CANVAS_ASPECTS) {
    const c = document.getElementById(id);
    if (!c || !c.clientWidth) continue;
    const w = Math.max(280, Math.min(1000, Math.round(c.clientWidth)));
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
