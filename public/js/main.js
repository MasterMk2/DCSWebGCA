'use strict';

/* DCS Web GCA - browser console */

const MAX_RANGE_NM = 12;   // azimuth/elevation scope range
const MAX_CROSS_NM = 3;    // half-width of azimuth scope
const MAX_ALT_FT = 6000;   // elevation scope ceiling

const state = {
  runway: null,
  runways: [],
  tracks: [],
  selectedId: null,
  glideDeg: 3.0,
};

let ws = null;

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
        state.runways = msg.runways;
        state.runway = msg.runway;
        populateRunwaySelect();
        break;
      case 'runwayChanged':
        state.runway = msg.runway;
        document.getElementById('runwaySelect').value = state.runway;
        break;
      case 'tracks':
        state.tracks = msg.tracks;
        render();
        break;
    }
  };
}

function selectRunway(id) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'selectRunway', runway: id }));
  }
}

/* ---------- UI ---------- */

function populateRunwaySelect() {
  const sel = document.getElementById('runwaySelect');
  sel.innerHTML = '';
  for (const id of state.runways) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    sel.appendChild(opt);
  }
  sel.value = state.runway;
  sel.onchange = () => selectRunway(sel.value);
}

function render() {
  drawAzimuth();
  drawElevation();
  renderTable();
}

/* ---------- Azimuth scope ---------- */

function drawAzimuth() {
  const canvas = document.getElementById('azimuthScope');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const padL = 50, padR = 20, padT = 15, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  // x: range 0..MAX_RANGE_NM, y: cross-track +MAX_CROSS..-MAX_CROSS
  const xOf = (nm) => padL + (nm / MAX_RANGE_NM) * plotW;
  const yOf = (crossNm) => padT + ((MAX_CROSS_NM - crossNm) / (2 * MAX_CROSS_NM)) * plotH;

  grid(ctx, xOf, yOf, padL, padT, plotW, plotH, 'RNG nm', 'AZ');

  // runway centerline
  ctx.strokeStyle = '#2a5a3a';
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(0));
  ctx.lineTo(xOf(MAX_RANGE_NM), yOf(0));
  ctx.stroke();

  // localizer gate lines (+/- 1 deg)
  ctx.strokeStyle = '#1e3a28';
  for (const dev of [1, -1]) {
    const yEnd = yOf(Math.tan((dev * Math.PI) / 180) * MAX_RANGE_NM);
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(0));
    ctx.lineTo(xOf(MAX_RANGE_NM), yEnd);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  drawBlips(ctx, (t) => (t.approach ? { x: t.approach.alongNm, y: t.approach.crossNm } : null), xOf, yOf);
}

/* ---------- Elevation scope ---------- */

function drawElevation() {
  const canvas = document.getElementById('elevationScope');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const padL = 60, padR = 20, padT = 15, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const xOf = (nm) => padL + (nm / MAX_RANGE_NM) * plotW;
  const yOf = (altFt) => padT + ((MAX_ALT_FT - altFt) / MAX_ALT_FT) * plotH;

  grid(ctx, xOf, yOf, padL, padT, plotW, plotH, 'RNG nm', 'ALT ft');

  // glidepath line
  const altAtMax = Math.tan((state.glideDeg * Math.PI) / 180) * MAX_RANGE_NM * 1852 * 3.28084;
  ctx.strokeStyle = '#2a5a3a';
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(0));
  ctx.lineTo(xOf(MAX_RANGE_NM), yOf(Math.min(altAtMax, MAX_ALT_FT)));
  ctx.stroke();
  ctx.setLineDash([]);

  drawBlips(
    ctx,
    (t) => (t.approach && t.approach.altFt !== null ? { x: t.approach.alongNm, y: t.approach.altFt } : null),
    xOf,
    yOf
  );
}

/* ---------- shared drawing helpers ---------- */

function grid(ctx, xOf, yOf, padL, padT, plotW, plotH, xLabel, yLabel) {
  ctx.strokeStyle = '#14202b';
  ctx.fillStyle = '#5a6b7a';
  ctx.font = '11px Consolas';

  for (let nm = 0; nm <= MAX_RANGE_NM; nm += 2) {
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

function drawBlips(ctx, project, xOf, yOf) {
  for (const t of state.tracks) {
    const p = project(t);
    if (!p) continue;
    const x = xOf(p.x), y = yOf(p.y);
    if (Number.isNaN(x) || Number.isNaN(y)) continue;

    const sel = t.id === state.selectedId;
    ctx.fillStyle = sel ? '#ffc23d' : '#39ff8b';
    ctx.beginPath();
    ctx.arc(x, y, sel ? 6 : 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = sel ? '#ffc23d' : '#7aa892';
    ctx.font = '11px Consolas';
    ctx.fillText(t.pilot || t.name || t.id, x + 8, y - 6);
  }
}

/* ---------- table ---------- */

function renderTable() {
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
      '<td>' + (t.iasKt === null ? '-' : t.iasKt) + '</td>' +
      '<td class="' + guidClass + '">' + escapeHtml(ap.guidance) + '</td>';
    tbody.appendChild(tr);
  }
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

/* ---------- selection via table ---------- */

document.querySelector('#trackTable tbody').addEventListener('click', (ev) => {
  const tr = ev.target.closest('tr');
  if (!tr || !tr.dataset.id) return;
  state.selectedId = state.selectedId === tr.dataset.id ? null : tr.dataset.id;
  render();
});

/* ---------- boot ---------- */

(async function init() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    state.runways = cfg.runways.map((r) => r.id);
    state.runway = cfg.defaultRunway;
    const rwy = cfg.runways.find((r) => r.id === cfg.defaultRunway);
    if (rwy) state.glideDeg = rwy.glidepathDeg;
    populateRunwaySelect();
  } catch (err) {
    console.error('config load failed', err);
  }
  connectWs();
})();
