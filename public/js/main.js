'use strict';

/* DCS Web GCA - browser console
 * Modes:
 *   GCA - Precision Approach Radar (azimuth + elevation scopes, talk-down)
 *   GCI - Ground Controlled Intercept (PPI scope + intercept solution)
 *   TWR - Aerodrome control (field view + traffic list)
 */

const M_PER_NM = 1852;
const FT_PER_M = 3.28084;
const KT_TO_MS = 0.514444;

const state = {
  mode: 'gca',
  runway: null,
  runways: [],        // full runway configs from /api/config
  tracks: [],
  selectedId: null,   // GCA table selection
  targetId: null,     // GCI target
  ownshipId: null,    // GCI ownship
  gciRangeNm: 20,
  twrRangeNm: 6,
  glideDeg: 3.0,
};

let ws = null;
const blipIndex = {}; // canvasId -> [{ id, x, y }]

/* ---------- helpers ---------- */

function runwayCfg() {
  return (
    state.runways.find((r) => r.id === state.runway) ||
    state.runways.find((r) => r.id === (state.defaultRunway || '')) ||
    state.runways[0] ||
    null
  );
}

// flat-earth offset (meters, east/north) of a point relative to a reference
function relTo(lat, lon, refLat, refLon) {
  const refRad = (refLat * Math.PI) / 180;
  return {
    x: (lon - refLon) * 111320 * Math.cos(refRad),
    y: (lat - refLat) * 111320,
  };
}

function normDeg(d) {
  return ((d % 360) + 360) % 360;
}

function fmtBrg(d) {
  return String(Math.round(normDeg(d))).padStart(3, '0');
}

function trackSpeedMs(t) {
  // ground speed derived server-side from position differencing
  const kt = t.spdKt;
  return kt ? kt / 1.94384 : 0;
}

function escapeHtml(s) {
  const AMP = '&' + 'amp;';
  return String(s)
    .replace(/&/g, AMP)
    .replace(/</g, '&' + 'lt;')
    .replace(/>/g, '&' + 'gt;')
    .replace(/"/g, '&' + 'quot;')
    .replace(/'/g, '&' + '#39;');
}

/* ---------- WebSocket ---------- */

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '/ws');
  const statusEl = document.getElementById('connStatus');

  ws.onopen = () => {
    statusEl.textContent = 'CONNECTED';
    statusEl.className = 'status connected';
  };
  ws.onclose = () => {
    statusEl.textContent = 'DISCONNECTED';
    statusEl.className = 'status disconnected';
    setTimeout(connectWs, 2000);
  };
  ws.onerror = () => ws.close();

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'hello':
        // full runway configs are loaded from /api/config at boot;
        // hello only confirms the server-side default runway
        state.runway = msg.runway;
        {
          const sel = document.getElementById('runwaySelect');
          if (state.runways.length && state.runways[0].id) sel.value = state.runway;
        }
        break;
      case 'runwayChanged':
        state.runway = msg.runway;
        document.getElementById('runwaySelect').value = state.runway;
        break;
      case 'tracks':
        state.tracks = msg.tracks;
        render();
        break;
      case 'transcript':
        // only show messages for the runway this client is watching
        appendTranscript((msg.messages || []).filter((m) => !m.runway || m.runway === state.runway));
        break;
    }
  };
}

/* ---------- talk-down log ---------- */

function appendTranscript(messages) {
  if (!messages || messages.length === 0) return;
  const log = document.getElementById('talkdownLog');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;

  for (const m of messages) {
    const div = document.createElement('div');
    div.className = 'log-line';
    const time = new Date(m.time).toLocaleTimeString('ja-JP', { hour12: false });
    const span = document.createElement('span');
    span.className = 'log-time';
    span.textContent = time;
    div.appendChild(span);
    div.appendChild(document.createTextNode(m.text));
    log.appendChild(div);
  }
  while (log.children.length > 100) log.removeChild(log.firstChild);

  if (atBottom) log.scrollTop = log.scrollHeight;
}

function selectRunway(id) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'selectRunway', runway: id }));
  }
}

/* ---------- UI plumbing ---------- */

function populateRunwaySelect() {
  const sel = document.getElementById('runwaySelect');
  sel.innerHTML = '';
  for (const r of state.runways) {
    const id = typeof r === 'string' ? r : r.id;
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    sel.appendChild(opt);
  }
  sel.value = state.runway;
  sel.onchange = () => selectRunway(sel.value);
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  document.querySelectorAll('.mode').forEach((s) => (s.hidden = s.id !== 'mode-' + mode));
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
  const kind = t.type || '';
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.5;

  if (kind.startsWith('Air+FixedWing') || kind === 'Airplane') {
    ctx.rotate(((t.hdg || 0) * Math.PI) / 180);
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(7, 9);
    ctx.lineTo(0, 5);
    ctx.lineTo(-7, 9);
    ctx.closePath();
    ctx.stroke();
  } else if (kind.startsWith('Air+Rotorcraft') || kind === 'Helicopter') {
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
  ctx.font = '11px Consolas';
  const lines = [t.pilot || t.name || t.id];
  if (t.altFt !== null && t.altFt !== undefined) lines.push(Math.round(t.altFt) + 'ft');
  if (t.spdKt) lines.push(t.spdKt + 'kt');
  lines.forEach((ln, i) => ctx.fillText(ln, x + 10, y - 4 + i * 12));
}

/* ================= GCA mode ================= */

const GCA_MAX_RANGE_NM = 12;
const GCA_MAX_CROSS_NM = 3;
const GCA_MAX_ALT_FT = 6000;

function renderGca() {
  drawAzimuth();
  drawElevation();
  renderApproachTable();
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

  for (const t of state.tracks) {
    const ap = t.approach;
    if (!ap || ap.alongNm < -0.5 || ap.alongNm > GCA_MAX_RANGE_NM) continue;
    const x = xOf(ap.alongNm), y = yOf(ap.crossNm);
    if (Math.abs(ap.crossNm) > GCA_MAX_CROSS_NM) continue;
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

  const xOf = (nm) => padL + (nm / GCA_MAX_RANGE_NM) * plotW;
  const yOf = (altFt) => padT + ((GCA_MAX_ALT_FT - altFt) / GCA_MAX_ALT_FT) * plotH;

  grid(ctx, xOf, yOf, padL, padT, plotW, plotH, 'RNG nm', 'ALT ft');

  const altAtMax = Math.tan((state.glideDeg * Math.PI) / 180) * GCA_MAX_RANGE_NM * M_PER_NM * FT_PER_M;
  ctx.strokeStyle = '#2a5a3a';
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(0));
  ctx.lineTo(xOf(GCA_MAX_RANGE_NM), yOf(Math.min(altAtMax, GCA_MAX_ALT_FT)));
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
  ctx.font = '11px Consolas';

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
    .filter((t) => t.approach)
    .sort((a, b) => a.approach.rangeNm - b.approach.rangeNm);

  for (const t of rows) {
    const ap = t.approach;
    const tr = document.createElement('tr');
    tr.dataset.id = t.id;
    if (t.id === state.selectedId) tr.style.background = '#1c2a1f';

    const gsTxt = ap.gsDevDeg === null ? '-' : (ap.gsDevDeg > 0 ? '+' : '') + ap.gsDevDeg.toFixed(2) + ' deg';
    const guidClass =
      ap.guidance.indexOf('ON COURSE') >= 0 && ap.guidance.indexOf('ON GLIDEPATH') >= 0
        ? 'guidance-ok'
        : 'guidance-warn';

    tr.innerHTML =
      '<td>' + escapeHtml(t.pilot || t.name) + '</td>' +
      '<td>' + escapeHtml(t.type) + '</td>' +
      '<td>' + ap.rangeNm.toFixed(2) + '</td>' +
      '<td>' + (ap.azDevDeg > 0 ? 'R' : 'L') + ' ' + Math.abs(ap.azDevDeg).toFixed(2) + ' deg</td>' +
      '<td>' + gsTxt + '</td>' +
      '<td>' + (t.altFt === null ? '-' : t.altFt) + '</td>' +
      '<td>' + (t.vsFpm === null || t.vsFpm === undefined ? '-' : t.vsFpm) + '</td>' +
      '<td>' + (t.spdKt === null ? '-' : t.spdKt) + '</td>' +
      '<td class="' + guidClass + '">' + escapeHtml(ap.guidance) + '</td>';
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
  const ref = rwy.threshold;
  const cx = W / 2, cy = H / 2;
  const radius = Math.min(W, H) / 2 - 40;
  const mPerPx = (state.gciRangeNm * M_PER_NM) / radius;

  const sx = (x) => cx + x / mPerPx;
  const sy = (y) => cy - y / mPerPx;

  // range rings
  ctx.strokeStyle = '#14202b';
  ctx.fillStyle = '#5a6b7a';
  ctx.font = '11px Consolas';
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

  // compass labels
  ctx.fillStyle = '#5a6b7a';
  ctx.font = '13px Consolas';
  ctx.fillText('N', cx - 4, cy - radius - 8);
  ctx.fillText('S', cx - 4, cy + radius + 16);
  ctx.fillText('E', cx + radius + 8, cy + 4);
  ctx.fillText('W', cx - radius - 16, cy + 4);

  // runway strip
  const hdgRad = (rwy.headingDeg * Math.PI) / 180;
  const lenM = (rwy.lengthNm || 1.2) * M_PER_NM;
  const farEnd = {
    x: -Math.sin(hdgRad) * lenM,
    y: -Math.cos(hdgRad) * lenM,
  };
  ctx.strokeStyle = '#3a5a4a';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(sx(0), sy(0));
  ctx.lineTo(sx(farEnd.x), sy(farEnd.y));
  ctx.stroke();
  ctx.lineWidth = 1.5;

  // tracks
  for (const t of state.tracks) {
    if (t.lat === undefined || t.lon === undefined) continue;
    const p = relTo(t.lat, t.lon, ref.lat, ref.lon);
    const distNm = Math.hypot(p.x, p.y) / M_PER_NM;
    if (distNm > state.gciRangeNm) continue;
    const x = sx(p.x), y = sy(p.y);

    let color = '#39ff8b';
    if (t.id === state.targetId) color = '#ff5252';
    else if (t.id === state.ownshipId) color = '#4dc3ff';

    drawSymbol(ctx, t, x, y, color);
    drawTrackLabel(ctx, t, x, y, color);
    registerBlip('ppiScope', t.id, x, y);

    // velocity leader line (1 minute projection)
    const spd = trackSpeedMs(t);
    if (spd > 0 && t.hdg !== undefined && t.hdg !== null) {
      const h = (t.hdg * Math.PI) / 180;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.sin(h) * spd * 60 / mPerPx, y - Math.cos(h) * spd * 60 / mPerPx);
      ctx.stroke();
    }
  }
}

function updateOwnshipSelect() {
  const sel = document.getElementById('ownshipSelect');
  const current = state.ownshipId || '';
  const airborne = state.tracks.filter((t) => typeof t.type === 'string' && t.type.startsWith('Air'));
  const ids = new Set(airborne.map((t) => t.id));

  // rebuild only when the set changed
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
 * Straight-line intercept solution (lead pursuit).
 * r: target position relative to ownship (meters, east/north)
 * Vt, Vo: velocity vectors (m/s)
 */
function interceptSolution(own, tgt) {
  const ref = runwayCfg() ? runwayCfg().threshold : { lat: 0, lon: 0 };
  const ro = relTo(own.lat, own.lon, ref.lat, ref.lon);
  const rt = relTo(tgt.lat, tgt.lon, ref.lat, ref.lon);
  const r = { x: rt.x - ro.x, y: rt.y - ro.y };

  const distM = Math.hypot(r.x, r.y);
  const distNm = distM / M_PER_NM;
  const brg = Math.atan2(r.x, r.y) * 180 / Math.PI;

  const hO = ((own.hdg || 0) * Math.PI) / 180;
  const hT = ((tgt.hdg || 0) * Math.PI) / 180;
  const sO = trackSpeedMs(own);
  const sT = trackSpeedMs(tgt);
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
    steerBrg = Math.atan2(ip.x, ip.y) * 180 / Math.PI;
    if (tStar > 0.5) ttiSec = tStar;
  }
  if (distM > 1) {
    const closing = -(r.x * u.x + r.y * u.y) / distM; // m/s
    closureKt = Math.round(closing / KT_TO_MS);
    if (closing > 1 && ttiSec === null) ttiSec = distM / closing;
  }

  return {
    distNm: Math.round(distNm * 10) / 10,
    brg: fmtBrg(brg),
    steer: fmtBrg(steerBrg),
    closureKt,
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
  const cells = [
    ['OWN', own.pilot || own.name || own.id],
    ['TARGET', tgt.pilot || tgt.name || tgt.id],
    ['RNG (nm)', sol.distNm],
    ['BRG TO TGT', sol.brg],
    ['STEER (deg)', sol.steer],
    ['CLOSURE (kt)', sol.closureKt === null ? '-' : sol.closureKt],
    ['TIME TO INT.', sol.tti],
  ];
  el.innerHTML = cells
    .map(([k, v]) => '<div class="cell"><div class="k">' + escapeHtml(k) + '</div><div class="v">' + escapeHtml(v) + '</div></div>')
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
  const ref = rwy.threshold;
  const cx = W / 2, cy = H / 2;
  const radius = Math.min(W, H) / 2 - 30;
  const mPerPx = (state.twrRangeNm * M_PER_NM) / radius;

  const sx = (x) => cx + x / mPerPx;
  const sy = (y) => cy - y / mPerPx;

  // range rings (1 nm)
  ctx.strokeStyle = '#14202b';
  ctx.fillStyle = '#5a6b7a';
  ctx.font = '11px Consolas';
  for (let r = 1; r <= state.twrRangeNm; r++) {
    ctx.beginPath();
    ctx.arc(cx, cy, (r * M_PER_NM) / mPerPx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText(r + 'nm', cx + 4, cy - (r * M_PER_NM) / mPerPx - 3);
  }

  const hdgRad = (rwy.headingDeg * Math.PI) / 180;
  const sinH = Math.sin(hdgRad), cosH = Math.cos(hdgRad);

  // runway strip: threshold -> reciprocal direction
  const lenM = (rwy.lengthNm || 1.2) * M_PER_NM;
  ctx.strokeStyle = '#3a5a4a';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(sx(0), sy(0));
  ctx.lineTo(sx(-sinH * lenM), sy(-cosH * lenM));
  ctx.stroke();

  // extended centerline (final approach course)
  ctx.strokeStyle = '#2a5a3a';
  ctx.setLineDash([8, 8]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(sx(0), sy(0));
  ctx.lineTo(sx(sinH * 5 * M_PER_NM), sy(cosH * 5 * M_PER_NM));
  ctx.stroke();
  ctx.setLineDash([]);

  // threshold marker
  ctx.fillStyle = '#7aa892';
  ctx.fillText('THR', sx(0) + 8, sy(0) - 8);

  // tracks
  for (const t of state.tracks) {
    if (t.lat === undefined || t.lon === undefined) continue;
    const p = relTo(t.lat, t.lon, ref.lat, ref.lon);
    if (Math.hypot(p.x, p.y) / M_PER_NM > state.twrRangeNm) continue;
    const x = sx(p.x), y = sy(p.y);

    const isGround = !(typeof t.type === 'string' && t.type.startsWith('Air'));
    const color = isGround ? '#8a9aa8' : t.id === state.selectedId ? '#ffc23d' : '#39ff8b';
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
  const ref = rwy.threshold;

  const rows = state.tracks
    .filter((t) => t.lat !== undefined && t.lon !== undefined)
    .map((t) => {
      const p = relTo(t.lat, t.lon, ref.lat, ref.lon);
      return {
        t,
        distNm: Math.hypot(p.x, p.y) / M_PER_NM,
        brg: normDeg((Math.atan2(p.x, p.y) * 180) / Math.PI),
      };
    })
    .filter((r) => r.distNm <= state.twrRangeNm)
    .sort((a, b) => a.distNm - b.distNm);

  for (const r of rows) {
    const t = r.t;
    const tr = document.createElement('tr');
    tr.dataset.id = t.id;
    if (t.id === state.selectedId) tr.style.background = '#1c2a1f';
    tr.innerHTML =
      '<td>' + escapeHtml(t.pilot || t.name) + '</td>' +
      '<td>' + escapeHtml(t.type) + '</td>' +
      '<td>' + r.distNm.toFixed(2) + '</td>' +
      '<td>' + fmtBrg(r.brg) + '</td>' +
      '<td>' + (t.altFt === null ? '-' : t.altFt) + '</td>' +
      '<td>' + (t.vsFpm === null || t.vsFpm === undefined ? '-' : t.vsFpm) + '</td>' +
      '<td>' + (t.spdKt === null ? '-' : t.spdKt) + '</td>';
    tbody.appendChild(tr);
  }
}

/* ---------- selection wiring ---------- */

attachCanvasPick('ppiScope', (id) => {
  state.targetId = state.targetId === id ? null : id;
  render();
});
attachCanvasPick('azimuthScope', (id) => {
  state.selectedId = state.selectedId === id ? null : id;
  render();
});
attachCanvasPick('elevationScope', (id) => {
  state.selectedId = state.selectedId === id ? null : id;
  render();
});
attachCanvasPick('twrScope', (id) => {
  state.selectedId = state.selectedId === id ? null : id;
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

attachWheelZoom('ppiScope',
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

attachWheelZoom('twrScope',
  () => state.twrRangeNm,
  (v) => {
    state.twrRangeNm = Math.min(15, Math.max(1, Math.round(v * 10) / 10));
    render();
  }
);

/* ---------- boot ---------- */

(async function init() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    state.runways = cfg.runways;
    state.defaultRunway = cfg.defaultRunway;
    state.runway = cfg.defaultRunway;
    const rwy = runwayCfg();
    if (rwy) state.glideDeg = rwy.glidepathDeg;
    populateRunwaySelect();
  } catch (err) {
    console.error('config load failed', err);
  }
  connectWs();
})();
