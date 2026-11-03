'use strict';

/* DCS Web GCA - browser console
 *
 * Modes:
 *   GCA - Precision Approach Radar (azimuth + elevation scopes, talk-down log)
 *   GCI - Ground Controlled Intercept (PPI scope + intercept solution)
 *   TWR - Aerodrome control (field view + traffic list)
 *   LSO - Carrier landing aid (glideslope + lineup against a Sea track)
 *
 * Every mode is one screen: scopes on the left, and on the right the aircraft
 * being worked, the traffic list it was picked from and (GCA) the log. GCA and
 * LSO follow the nearest aircraft on their own until the controller picks one.
 *
 * Every browser subscribes to its own (server, runway) pair; nothing here is
 * shared with the other controllers connected to the same console.
 */

const M_PER_NM = 1852;
const KT_TO_MS = 0.514444;
const EARTH_M_PER_DEG = 111320;

/* Bumped whenever the console changes in a way a stale cached copy would
 * hide; logged at start-up so "it does not do the new thing" can be told
 * apart from "the browser is still on yesterday's file". */
const CLIENT_BUILD = '2026-10-30 ui-overhaul';

/* The console may be mounted at the site root or behind a sub-path
 * (https://freedomflight.jp/gca/), so every URL is built relative to the
 * directory this page was served from. */
const BASE = location.pathname.replace(/[^/]*$/, '');

/* localStorage can throw (private windows, blocked site data); the console
 * must still work, it just forgets the controller's choices. */
const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* not remembered */
    }
  },
};

/* Optional access token: picked up from ?token=... once, then remembered.
 * The server only enforces it when cfg.auth.token is set. */
const TOKEN = new URLSearchParams(location.search).get('token') || prefs.get('gcaToken', '');
if (new URLSearchParams(location.search).get('token')) {
  prefs.set('gcaToken', TOKEN);
}
const authQuery = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '';

const MODES = ['gca', 'gci', 'twr', 'lso'];

/* Scope palette. Traffic is neutral so that green / amber / red only ever
 * mean a state, and blue only ever means "the one you picked". */
const COLORS = {
  grid: '#1a2531',
  axis: '#8795a4',
  reference: '#6a9a87', // glidepath / centreline
  corridor: '#2c4a3f',  // tolerance corridors
  runway: '#6f8696',
  label: '#a9b5c1',
  traffic: '#d8e2ea',
  ground: '#7b8896',
  selected: '#5aa9ff',
  own: '#5aa9ff',
  target: '#ff6b6b',
  ok: '#3ddc84',
  warn: '#ffb547',
  bullseye: '#d9b44a',
  sparkAz: '#5aa9ff',
  sparkGs: '#c39bff',
  band: '#0f1c17',
};
const FONT_DATA = 'ui-monospace, "Cascadia Mono", "SF Mono", Consolas, monospace';
const FONT_SCOPE = '12px ' + FONT_DATA;
const FONT_SCOPE_LARGE = '14px ' + FONT_DATA;

/* scope range presets the − / + buttons step through; the wheel and pinch
 * still zoom continuously between them */
const RANGE_STEPS = {
  gca: [3, 5, 8, 12, 20, 30],
  gci: [5, 10, 20, 40, 80, 120],
  twr: [2, 4, 6, 10, 15],
  lso: [1, 2, 4, 6, 8],
};
const RANGE_LIMITS = { gca: [2, 30], gci: [2, 120], twr: [1, 15], lso: [1, 8] };

const savedRanges = (() => {
  try {
    return JSON.parse(prefs.get('gcaRanges', '{}')) || {};
  } catch {
    return {};
  }
})();

function initialMode() {
  const fromHash = location.hash.replace('#', '');
  if (MODES.includes(fromHash)) return fromHash;
  const saved = prefs.get('gcaMode', 'gca');
  return MODES.includes(saved) ? saved : 'gca';
}

const state = {
  mode: initialMode(),
  sources: [],
  sourceId: null,
  runways: [],
  runwayStatus: null, // { state, theatre, wind, ... } of the subscribed source
  runwayId: null,
  tracks: [],
  bullseyes: [],    // mission reference points, one per coalition
  counts: null,
  connected: false,
  streaming: true,  // Tacview stream of the subscribed source
  selectedId: null, // GCA / TWR selection
  targetId: null,   // GCI target
  ownshipId: null,  // GCI ownship
  bullseyeId: null, // GCI bullseye the cursor readout measures from
  /* GCI scope centre, in metres east/north of the runway threshold. Panned by
   * dragging the PPI; metres (not pixels) so zooming and canvas resizes keep
   * the same piece of ground under the middle of the scope. */
  gciPan: { x: 0, y: 0 },
  carrierId: null,     // LSO carrier (Sea track)
  lsoAircraftId: null, // LSO aircraft picked by the controller (null = follow nearest)
  gciRangeNm: clampRange('gci', savedRanges.gci || 20),
  twrRangeNm: clampRange('twr', savedRanges.twr || 6),
  gcaRangeNm: clampRange('gca', savedRanges.gca || 12),
  lsoRangeNm: clampRange('lso', savedRanges.lso || 4),
  tolerance: { azToleranceDeg: 0.8, gsToleranceDeg: 0.4 },
};

let ws = null;
const blipIndex = {}; // canvasId -> [{ id, x, y }] in CSS pixels

/* ---------- helpers ---------- */

function $(id) {
  return document.getElementById(id);
}

function clampRange(mode, v) {
  const [lo, hi] = RANGE_LIMITS[mode];
  return Math.min(hi, Math.max(lo, Math.round(v * 10) / 10));
}

function runwayCfg() {
  return state.runways.find((r) => r.id === state.runwayId) || state.runways[0] || null;
}

function currentSource() {
  return state.sources.find((s) => s.id === state.sourceId) || null;
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

function callsignOf(t) {
  return t.pilot || t.name || t.id;
}

function dash(v) {
  return v === null || v === undefined ? '-' : v;
}

function fmtRangeNm(v) {
  return (Number.isInteger(v) ? String(v) : v.toFixed(1)) + ' nm';
}

/** "R 0.28°" / "L 1.20°" for a signed azimuth or lineup deviation */
function fmtSide(deg) {
  if (deg === null || deg === undefined) return '-';
  return (deg > 0 ? 'R ' : 'L ') + Math.abs(deg).toFixed(2) + '°';
}

function fmtSigned(deg) {
  if (deg === null || deg === undefined) return '-';
  return (deg > 0 ? '+' : '') + deg.toFixed(2) + '°';
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString('ja-JP', { hour12: false });
}

function setText(el, text) {
  const s = String(text);
  if (el && el.textContent !== s) el.textContent = s;
}

/** coalition colour of a track as a CSS class for the little side marker */
function sideClass(t) {
  const c = String(t.color || '').toLowerCase();
  return c === 'blue' || c === 'red' ? c : '';
}

/* ---------- WebSocket ---------- */

/* The source whose remembered runway has already been put back on this
 * connection. Without it a mission change that drops the runway would be
 * fought by the console re-selecting it forever. */
let runwayRestoredFor = null;

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
      case 'hello': {
        state.sources = msg.sources || [];
        state.sourceId = msg.source;
        state.runwayId = msg.runway;
        runwayRestoredFor = null;
        if (msg.gca) state.tolerance = msg.gca;

        // put back the server and runway this browser had last time; the
        // server starts every connection on its own defaults
        const saved = prefs.get('gcaSource', null);
        const want = state.sources.some((s) => s.id === saved) ? saved : msg.source;
        const wantRunway = prefs.get('gcaRunway:' + want, null);
        if (want !== msg.source || (wantRunway && wantRunway !== msg.runway)) {
          state.sourceId = want;
          send({ type: 'subscribe', source: want, runway: wantRunway || undefined });
        }
        populateSourceSelect();
        updateInfoBar();
        break;
      }

      case 'sources':
        state.sources = msg.sources || [];
        populateSourceSelect();
        updateInfoBar();
        break;

      case 'runways': {
        if (msg.source !== state.sourceId) break;
        state.runways = msg.runways || [];
        state.runwayStatus = msg.status || null;

        // the remembered runway may only exist once the airbase sweep is done
        const wanted = prefs.get('gcaRunway:' + msg.source, null);
        if (wanted && runwayRestoredFor !== msg.source && state.runways.some((r) => r.id === wanted)) {
          runwayRestoredFor = msg.source;
          if (wanted !== msg.runway) send({ type: 'selectRunway', runway: wanted });
        }

        // the PPI is centred on the threshold, so a different runway must not
        // inherit the pan of the old one (the new field would be off-screen)
        if (state.runwayId !== msg.runway) resetGciPan();
        state.runwayId = msg.runway;
        populateRunwaySelect();
        updateInfoBar();
        render();
        break;
      }

      case 'tracks':
        if (msg.source !== state.sourceId) break;
        state.tracks = msg.tracks;
        state.bullseyes = msg.bullseyes || [];
        state.counts = msg.counts;
        state.streaming = msg.connected;
        if (msg.runway) state.runwayId = msg.runway;
        recordTrackArrival();
        recordDigest();
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
  const el = $('connStatus');
  el.className = 'conn ' + (up ? 'up' : 'down');
  setText(el.querySelector('.conn-text'), up ? '接続中' : '再接続中…');
  updateInfoBar();
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/* ---------- refresh rate / latency HUD ---------- */

/* Small mode-independent readout in the top bar: measured WebSocket update
 * frequency plus server->client latency, e.g. "4.9 Hz · 120 ms".
 * The user can hide it with the 性能 toggle (persisted in localStorage). */

const perfPrefs = { enabled: prefs.get('gcaPerf', 'on') !== 'off' };

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
  const el = $('latency');
  if (!perfPrefs.enabled) return;

  const hz = updateRateHz();

  // server send timestamp -> client receipt; fall back to the snapshot age
  // when the two clocks are too far apart for the difference to mean anything
  const now = Date.now();
  let ms = typeof msg.sentAt === 'number' ? Math.max(0, now - msg.sentAt) : null;
  if (ms === null || ms > 10000) {
    ms = typeof msg.time === 'number' ? Math.max(0, now - msg.time) : null;
  }

  setText(el, (hz === null ? '--' : hz.toFixed(1)) + ' Hz · ' + (ms === null ? '--' : String(Math.round(ms))) + ' ms');
  el.className = 'perf' + (ms !== null && ms >= 250 ? ' warn' : '');
}

/* ---------- talk-down log ---------- */

const lastCallById = new Map(); // track id -> newest talk-down message for it

function appendTranscript(messages, reset) {
  const log = $('talkdownLog');
  if (reset) {
    log.innerHTML = '';
    lastCallById.clear();
  }
  if (!messages || messages.length === 0) return;
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;

  for (const m of messages) {
    if (m.id !== undefined) lastCallById.set(m.id, m);
    const div = document.createElement('div');
    div.className = 'log-line';
    if (m.id !== undefined) div.dataset.id = m.id;
    const span = document.createElement('span');
    span.className = 'log-time';
    span.textContent = fmtTime(m.time);
    div.appendChild(span);
    div.appendChild(document.createTextNode(m.text));
    log.appendChild(div);
  }
  while (log.children.length > 100) log.removeChild(log.firstChild);
  if (atBottom || reset) log.scrollTop = log.scrollHeight;
  if (state.mode === 'gca') render();
}

/* ---------- top bar / context strip ---------- */

function populateSourceSelect() {
  const sel = $('sourceSelect');
  const sig = state.sources.map((s) => `${s.id}:${s.connected}`).join(',');
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = '';
    for (const s of state.sources) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name + (s.connected ? '' : ' (停止中)');
      sel.appendChild(opt);
    }
  }
  sel.value = state.sourceId || '';
}

$('sourceSelect').addEventListener('change', (ev) => {
  const id = ev.target.value;
  state.sourceId = id;
  state.tracks = [];
  state.bullseyes = [];
  state.runways = [];
  state.runwayStatus = null;
  state.selectedId = state.targetId = state.ownshipId = state.bullseyeId = null;
  state.carrierId = state.lsoAircraftId = null;
  digestHistory.clear();
  resetGciPan();
  prefs.set('gcaSource', id);
  send({ type: 'subscribe', source: id, runway: prefs.get('gcaRunway:' + id, null) || undefined });
  updateInfoBar();
  render();
});

function populateRunwaySelect() {
  const sel = $('runwaySelect');
  const sig = state.runways.map((r) => r.id).join('|');
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
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
        ? `${airbase} ${r.designator || r.id} (${fmtBrg(r.headingDeg)}°)`
        : `${r.id} (${fmtBrg(r.headingDeg)}°)`;
      (airbase ? group : sel).appendChild(opt);
    }
    if (state.runways.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '滑走路データなし';
      sel.appendChild(opt);
    }
  }
  sel.value = state.runwayId || '';
}

$('runwaySelect').addEventListener('change', (ev) => {
  const id = ev.target.value;
  if (!id) return;
  prefs.set('gcaRunway:' + state.sourceId, id);
  runwayRestoredFor = state.sourceId;
  send({ type: 'selectRunway', runway: id });
});

function updateInfoBar() {
  const src = currentSource();
  const rwy = runwayCfg();
  const rwStatus = state.runwayStatus || (src && src.runways) || {};

  const mission = $('missionInfo');
  if (src) {
    const bits = [src.mission || '(ミッション情報なし)'];
    if (rwStatus.theatre) bits.push(rwStatus.theatre);
    setText(mission, bits.join(' · '));
    mission.title = bits.join(' · ');
  } else {
    setText(mission, '');
  }

  setText(
    $('runwayInfo'),
    rwy
      ? `RWY ${rwy.id} · HDG ${fmtBrg(rwy.headingDeg)} · GP ${rwy.glidepathDeg.toFixed(1)}° · THR ${rwy.threshold.altFt} ft` +
          (rwy.lengthNm ? ` · ${Math.round(rwy.lengthNm * M_PER_NM)} m` : '')
      : ''
  );

  const wind = rwStatus.wind;
  setText(
    $('windInfo'),
    wind && wind.windFromDeg !== null && wind.windFromDeg !== undefined && typeof wind.windSpeedMs === 'number'
      ? `WIND ${fmtBrg(wind.windFromDeg)}° / ${Math.round(wind.windSpeedMs * 1.943844)} kt`
      : ''
  );

  setText(
    $('trackCount'),
    state.counts ? `航空機 ${state.counts.aircraft} · 物体 ${state.counts.objects}` : ''
  );

  // one chip for whatever makes the picture untrustworthy right now, worst first
  const alert = $('streamAlert');
  let text = '';
  let bad = false;
  if (!state.connected) {
    text = 'コンソールのサーバーに接続できません。自動で再接続しています';
    bad = true;
  } else if (src && (!src.connected || state.streaming === false)) {
    text = 'Tacview の配信が止まっています。表示は最後に受け取った位置です';
  } else if (rwStatus.state === 'loading') {
    text = '滑走路データを取得中…';
  } else if (rwStatus.state === 'error') {
    text = '滑走路データを取得できません。↻ で取り直せます';
  } else if (src && state.runways.length === 0) {
    text = 'このサーバーには滑走路データがありません';
  }
  alert.hidden = !text;
  alert.className = 'alert-chip' + (bad ? ' bad' : '');
  setText(alert, text);
  document.body.classList.toggle('stale', !state.connected || (!!src && (!src.connected || state.streaming === false)));
}

/* ---------- modes ---------- */

function setMode(mode) {
  if (!MODES.includes(mode)) mode = 'gca';
  state.mode = mode;
  prefs.set('gcaMode', mode);
  if (location.hash !== '#' + mode) history.replaceState(null, '', '#' + mode);
  document.querySelectorAll('.mode-tab').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('.mode').forEach((s) => (s.hidden = s.id !== 'mode-' + mode));
  fitCanvases();
  render();
}

function render() {
  pruneSelections();
  updateZoomLabels();
  if (state.mode === 'gca') renderGca();
  else if (state.mode === 'gci') renderGci();
  else if (state.mode === 'twr') renderTwr();
  else if (state.mode === 'lso') renderLso();
}

function pruneSelections() {
  const ids = new Set(state.tracks.map((t) => t.id));
  const bulls = new Set(state.bullseyes.map((b) => b.id));
  if (state.bullseyeId && !bulls.has(state.bullseyeId)) state.bullseyeId = null;
  if (state.selectedId && !ids.has(state.selectedId)) state.selectedId = null;
  if (state.targetId && !ids.has(state.targetId)) state.targetId = null;
  if (state.ownshipId && !ids.has(state.ownshipId)) state.ownshipId = null;
  if (state.carrierId && !ids.has(state.carrierId)) state.carrierId = null;
  if (state.lsoAircraftId && !ids.has(state.lsoAircraftId)) state.lsoAircraftId = null;
}

/** what Esc does: drop the pick in the current mode (GCA / LSO go back to following) */
function clearSelection() {
  if (state.mode === 'gci') state.ownshipId = state.targetId = null;
  else if (state.mode === 'lso') state.lsoAircraftId = null;
  else state.selectedId = null;
  render();
}

/* ---------- keyed lists ---------- */

/* Lists are redrawn at 5 Hz. Rows are reused by track id and only their text
 * is updated, otherwise a click that spans a redraw is lost and keyboard
 * focus jumps back to the page every 200 ms. */
function syncList(listEl, items, createRow, updateRow, emptyHtml) {
  const existing = new Map();
  for (const child of [...listEl.children]) {
    if (child.dataset.id !== undefined) existing.set(child.dataset.id, child);
  }

  let empty = listEl.querySelector('.list-empty');
  if (!items.length) {
    for (const el of existing.values()) el.remove();
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'list-empty';
      listEl.appendChild(empty);
    }
    if (empty.dataset.html !== emptyHtml) {
      empty.innerHTML = emptyHtml;
      empty.dataset.html = emptyHtml;
    }
    return;
  }
  if (empty) empty.remove();

  let prev = null;
  for (const item of items) {
    const key = String(item.id);
    let row = existing.get(key);
    if (row) existing.delete(key);
    else {
      row = createRow(item);
      row.dataset.id = key;
    }
    updateRow(row, item);
    // only move rows that are out of place: moving a node drops its focus
    const want = prev ? prev.nextSibling : listEl.firstChild;
    if (want !== row) listEl.insertBefore(row, want);
    prev = row;
  }
  for (const el of existing.values()) el.remove();
}

/** a selectable two-line row: name + main figure, then a line of numbers */
function createTrackButton() {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'track';
  b.innerHTML =
    '<span class="name"><i class="side-dot"></i><span class="cs"></span><span class="ty"></span>' +
    '<span class="tag" hidden></span></span>' +
    '<span class="num"></span><span class="nums"></span><span class="extra"></span>';
  return b;
}

function fillTrackName(row, t, tag) {
  const dot = row.querySelector('.side-dot');
  dot.className = 'side-dot ' + sideClass(t);
  dot.title = t.color || '';
  const cs = row.querySelector('.cs');
  setText(cs, callsignOf(t));
  cs.title = callsignOf(t);
  setText(row.querySelector('.ty'), t.name && t.name !== callsignOf(t) ? t.name : '');
  const tagEl = row.querySelector('.tag');
  tagEl.hidden = !tag;
  if (tag) setText(tagEl, tag);
}

/** numbers line: [[text, warn?], ...]; rebuilt only when it actually changed */
function fillNums(el, parts) {
  const html = parts
    .filter(Boolean)
    .map(([txt, warn]) => '<span' + (warn ? ' class="warn"' : '') + '>' + escapeHtml(txt) + '</span>')
    .join('');
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
  }
}

/** build a block once per kind, then hand back a lookup for its [data-f] fields */
function skeleton(el, kind, html) {
  if (el.dataset.kind !== kind) {
    el.innerHTML = html;
    el.dataset.kind = kind;
  }
  return (name) => el.querySelector('[data-f="' + name + '"]');
}

function emptyCard(el, html) {
  if (el.dataset.kind === 'empty' && el.dataset.html === html) return;
  el.innerHTML = html;
  el.dataset.kind = 'empty';
  el.dataset.html = html;
}

/* ---------- canvases ---------- */

const SCOPE_CANVASES = ['azimuthScope', 'elevationScope', 'ppiScope', 'twrScope', 'lsoScope', 'lsoPlatformScope'];

/* Every scope fills its box. The backing store is in device pixels, but all
 * drawing and all pointer maths happen in CSS pixels (the context is scaled
 * once per frame), so labels are the same size on a 100 % and a 150 %
 * desktop and a click lands on the blip it was aimed at. */
function fitCanvases() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let changed = false;
  for (const id of SCOPE_CANVASES) {
    const c = $(id);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) continue; // mode not shown
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (c.width !== bw || c.height !== bh) {
      c.width = bw;
      c.height = bh;
      changed = true;
    }
    c._cssW = w;
    c._cssH = h;
  }
  return changed;
}

/** size of a scope in CSS pixels */
function cssSize(canvas) {
  return { W: canvas._cssW || canvas.clientWidth || 1, H: canvas._cssH || canvas.clientHeight || 1 };
}

/** clear a scope and return a context that draws in CSS pixels */
function beginCanvas(canvas) {
  const { W, H } = cssSize(canvas);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.lineWidth = 1;
  return { ctx, W, H };
}

/** pointer position over a canvas, in the CSS pixels the scope is drawn in */
function canvasPoint(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function drawNotice(ctx, W, H, text) {
  ctx.fillStyle = COLORS.label;
  ctx.font = '14px ' + FONT_DATA;
  ctx.textAlign = 'center';
  ctx.fillText(text, W / 2, H / 2);
  ctx.textAlign = 'left';
}

function clearBlips(canvasId) {
  blipIndex[canvasId] = [];
}

function registerBlip(canvasId, id, x, y) {
  blipIndex[canvasId].push({ id, x, y });
}

function blipAt(canvasId, x, y) {
  let best = null;
  let bd = 22 * 22;
  for (const b of blipIndex[canvasId] || []) {
    const d = (b.x - x) * (b.x - x) + (b.y - y) * (b.y - y);
    if (d < bd) {
      bd = d;
      best = b.id;
    }
  }
  return best;
}

/* Canvas ids whose next click is the tail end of a drag and must not be taken
 * as a designation. Set by attachCanvasPan, consumed by attachCanvasPick. */
const dragSuppressClick = new Set();

function attachCanvasPick(canvasId, onPick) {
  const canvas = $(canvasId);
  canvas.addEventListener('click', (ev) => {
    if (dragSuppressClick.delete(canvasId)) return;
    const p = canvasPoint(canvas, ev.clientX, ev.clientY);
    const id = blipAt(canvasId, p.x, p.y);
    if (id) onPick(id);
  });
  // a pointer cursor over a blip tells the controller it can be clicked
  canvas.addEventListener('pointermove', (ev) => {
    if (ev.pointerType === 'touch') return;
    const p = canvasPoint(canvas, ev.clientX, ev.clientY);
    canvas.classList.toggle('over-blip', !!blipAt(canvasId, p.x, p.y));
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

/** ring around the aircraft being worked, so it is found at a glance */
function drawHalo(ctx, x, y, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, 15, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function shortLabel(s) {
  const str = String(s);
  return str.length > 18 ? str.slice(0, 17) + '…' : str;
}

function drawTrackLabel(ctx, t, x, y, color) {
  ctx.fillStyle = color;
  ctx.font = FONT_SCOPE;
  const lines = [shortLabel(callsignOf(t))];
  if (t.altFt !== null && t.altFt !== undefined) lines.push(Math.round(t.altFt) + 'ft');
  if (t.gsKt) lines.push(t.gsKt + 'kt');
  lines.forEach((ln, i) => ctx.fillText(ln, x + 11, y - 4 + i * 13));
}

/* ================= GCA mode ================= */

const DIGEST_HISTORY = 60; // samples kept per aircraft (~12 s at 5 Hz)
const digestHistory = new Map(); // track id -> [{ az, gs, rng }]

function finalRows() {
  return state.tracks
    .filter((t) => t.approach && t.approach.onFinal && !t.onGround)
    .sort((a, b) => a.approach.rangeNm - b.approach.rangeNm);
}

/* one sample per snapshot (not per redraw, which also happens on zoom and
 * clicks), so the history always spans the same ~12 s */
function recordDigest() {
  const rows = finalRows();
  const live = new Set(rows.map((t) => t.id));
  for (const id of [...digestHistory.keys()]) if (!live.has(id)) digestHistory.delete(id);
  for (const t of rows) pushDigestSample(t);
}

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

/** the picked aircraft if it is on final, otherwise the nearest one */
function gcaFocus(rows) {
  const picked = rows.find((t) => t.id === state.selectedId);
  if (picked) return { t: picked, manual: true };
  return rows.length ? { t: rows[0], manual: false } : null;
}

function renderGca() {
  const rows = finalRows();
  const focus = gcaFocus(rows);
  const focusId = focus ? focus.t.id : null;
  drawAzimuth(focusId);
  drawElevation(focusId);
  renderGcaFocus(focus, rows.length);
  renderGcaList(rows, focus);
  for (const line of $('talkdownLog').children) {
    line.classList.toggle('is-focus', focusId !== null && line.dataset.id === String(focusId));
  }
}

function guidanceClass(ap) {
  const onCourse = Math.abs(ap.azDevDeg) < state.tolerance.azToleranceDeg;
  const onGp = ap.gsDevDeg !== null && Math.abs(ap.gsDevDeg) < state.tolerance.gsToleranceDeg;
  return onCourse && onGp ? 'ok' : 'warn';
}

function renderGcaFocus(focus, count) {
  const el = $('gcaFocus');
  $('gcaFocusAuto').hidden = !(focus && focus.manual);
  setText($('gcaFocusMode'), focus ? (focus.manual ? '選択中' : '自動: 最も近い機体') : '');

  if (!focus) {
    const rwy = runwayCfg();
    emptyCard(
      el,
      '<p class="focus-empty">最終進入中の機体はありません。<br>' +
        (rwy ? 'RWY ' + escapeHtml(rwy.id) + ' の' : '') +
        '進入コースに乗った機体が、ここに自動で表示されます。</p>'
    );
    return;
  }

  const t = focus.t;
  const ap = t.approach;
  const f = skeleton(
    el,
    'gca',
    '<div class="focus-title"><span class="cs" data-f="cs"></span><span class="ty" data-f="ty"></span>' +
      '<span class="grade" data-f="grade"></span></div>' +
      '<div class="guidance" data-f="guidance"></div>' +
      '<dl class="readout">' +
      '<div class="key"><dt>RNG nm</dt><dd data-f="rng"></dd></div>' +
      '<div><dt>AZ DEV</dt><dd data-f="az"></dd></div>' +
      '<div><dt>GS DEV</dt><dd data-f="gs"></dd></div>' +
      '<div><dt>ALT ft</dt><dd data-f="alt"></dd></div>' +
      '<div><dt>GP ALT ft</dt><dd data-f="gp"></dd></div>' +
      '<div><dt>VS fpm</dt><dd data-f="vs"></dd></div>' +
      '</dl>' +
      '<div class="spark-wrap"><canvas class="sparkline" data-f="spark"></canvas>' +
      '<div class="spark-legend"><span><i style="background:' + COLORS.sparkAz + '"></i>AZ</span>' +
      '<span><i style="background:' + COLORS.sparkGs + '"></i>GS</span><span>直近 12 秒 · 帯は許容幅</span></div></div>' +
      '<div class="last-call" data-f="call" hidden><span class="k" data-f="callTime"></span><span data-f="callText"></span></div>'
  );

  const history = digestHistory.get(t.id) || [];
  const grade = gradeOf(history);
  setText(f('cs'), callsignOf(t));
  f('cs').title = callsignOf(t);
  setText(f('ty'), [t.name, t.gsKt ? t.gsKt + ' kt' : null].filter(Boolean).join(' · '));
  const g = f('grade');
  setText(g, grade.text);
  g.className = 'grade ' + grade.cls;
  const gd = f('guidance');
  setText(gd, ap.guidance || '-');
  gd.className = 'guidance ' + guidanceClass(ap);

  const azBad = Math.abs(ap.azDevDeg) >= state.tolerance.azToleranceDeg;
  const gsBad = ap.gsDevDeg !== null && Math.abs(ap.gsDevDeg) >= state.tolerance.gsToleranceDeg;
  setText(f('rng'), ap.rangeNm.toFixed(2));
  setText(f('az'), fmtSide(ap.azDevDeg));
  f('az').className = azBad ? 'warn' : '';
  setText(f('gs'), fmtSigned(ap.gsDevDeg));
  f('gs').className = gsBad ? 'warn' : '';
  setText(f('alt'), dash(t.altFt));
  setText(f('gp'), dash(ap.gpAltFt));
  setText(f('vs'), dash(t.vsFpm));
  drawSparkline(f('spark'), history);

  const call = lastCallById.get(t.id);
  f('call').hidden = !call;
  if (call) {
    setText(f('callTime'), '最新の誘導文 · ' + fmtTime(call.time));
    setText(f('callText'), call.text);
  }
}

function renderGcaList(rows, focus) {
  setText($('gcaListCount'), rows.length ? rows.length + ' 機' : '');
  const azTol = state.tolerance.azToleranceDeg;
  const gsTol = state.tolerance.gsToleranceDeg;
  syncList(
    $('gcaList'),
    rows,
    createTrackButton,
    (row, t) => {
      const ap = t.approach;
      const isFocus = focus && focus.t.id === t.id;
      row.setAttribute('aria-pressed', String(t.id === state.selectedId));
      row.classList.toggle('is-focus', !!isFocus);
      row.classList.toggle('is-auto', !!isFocus && !focus.manual);
      fillTrackName(row, t, '');
      setText(row.querySelector('.num'), ap.rangeNm.toFixed(1) + ' nm');
      fillNums(row.querySelector('.nums'), [
        ['AZ ' + fmtSide(ap.azDevDeg), Math.abs(ap.azDevDeg) >= azTol],
        ['GS ' + fmtSigned(ap.gsDevDeg), ap.gsDevDeg !== null && Math.abs(ap.gsDevDeg) >= gsTol],
        [dash(t.altFt) + ' ft'],
        [dash(t.gsKt) + ' kt'],
      ]);
    },
    '最終進入中の機体はありません。'
  );
}

$('gcaList').addEventListener('click', (ev) => {
  const row = ev.target.closest('.track');
  if (!row) return;
  state.selectedId = state.selectedId === row.dataset.id ? null : row.dataset.id;
  render();
});

$('gcaFocusAuto').addEventListener('click', () => {
  state.selectedId = null;
  render();
});

/** deviation history: azimuth and glidepath around the centre line */
function drawSparkline(canvas, history) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 320;
  const h = canvas.clientHeight || 36;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(canvas.width / w, 0, 0, canvas.height / h, 0, 0);
  const W = w, H = h;
  ctx.clearRect(0, 0, W, H);

  const azTol = state.tolerance.azToleranceDeg;
  const gsTol = state.tolerance.gsToleranceDeg;

  // tolerance band + centre line
  ctx.fillStyle = COLORS.band;
  ctx.fillRect(0, H / 2 - H * 0.1, W, H * 0.2);
  ctx.strokeStyle = COLORS.grid;
  ctx.beginPath();
  ctx.moveTo(0, H / 2);
  ctx.lineTo(W, H / 2);
  ctx.stroke();

  const plot = (key, tol, color) => {
    const scale = tol * 5; // full scale = 5x tolerance
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
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

  plot('az', azTol, COLORS.sparkAz);
  plot('gs', gsTol, COLORS.sparkGs);
}

function trackColor(t, focusId) {
  if (t.id === focusId) return COLORS.selected;
  return t.onGround ? COLORS.ground : COLORS.traffic;
}

function drawAzimuth(focusId) {
  const canvas = $('azimuthScope');
  const { ctx, W, H } = beginCanvas(canvas);
  clearBlips('azimuthScope');

  const padL = 50, padR = 20, padT = 15, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  if (plotW <= 0 || plotH <= 0) return;

  const R = state.gcaRangeNm;
  const C = Math.max(0.5, R / 4); // cross-track half-width scales with range

  const xOf = (nm) => padL + (nm / R) * plotW;
  const yOf = (crossNm) => padT + ((C - crossNm) / (2 * C)) * plotH;

  grid(ctx, xOf, yOf, padL, padT, plotW, plotH, 'RNG nm', 'AZ', R);

  ctx.strokeStyle = COLORS.reference;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(0));
  ctx.lineTo(xOf(R), yOf(0));
  ctx.stroke();

  ctx.strokeStyle = COLORS.corridor;
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
  ctx.fillStyle = COLORS.axis;
  ctx.font = FONT_SCOPE;
  ctx.fillText('R', padL - 18, padT + plotH * 0.25);
  ctx.fillText('L', padL - 18, padT + plotH * 0.75);

  for (const t of state.tracks) {
    const ap = t.approach;
    if (!ap || ap.alongNm < -0.5 || ap.alongNm > R) continue;
    if (Math.abs(ap.crossNm) > C) continue;
    const x = xOf(ap.alongNm), y = yOf(ap.crossNm);
    const color = trackColor(t, focusId);
    if (t.id === focusId) drawHalo(ctx, x, y, color);
    drawSymbol(ctx, t, x, y, color);
    drawTrackLabel(ctx, t, x, y, color);
    registerBlip('azimuthScope', t.id, x, y);
  }
}

function drawElevation(focusId) {
  const canvas = $('elevationScope');
  const { ctx, W, H } = beginCanvas(canvas);
  clearBlips('elevationScope');

  const padL = 60, padR = 20, padT = 15, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  if (plotW <= 0 || plotH <= 0) return;
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

  // altitude ticks along the left edge
  ctx.fillStyle = COLORS.axis;
  ctx.font = FONT_SCOPE;
  ctx.textAlign = 'right';
  for (let i = 1; i <= 4; i++) {
    const agl = (ALT * (4 - i)) / 4;
    ctx.fillText(String(Math.round(agl)), padL - 6, padT + (i / 4) * plotH + 4);
  }
  ctx.textAlign = 'left';

  const altAtMax = Math.tan((glide * Math.PI) / 180) * R * M_PER_NM * 3.28084;
  ctx.strokeStyle = COLORS.reference;
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
    const color = trackColor(t, focusId);
    if (t.id === focusId) drawHalo(ctx, x, y, color);
    drawSymbol(ctx, t, x, y, color);
    registerBlip('elevationScope', t.id, x, y);
  }
}

function grid(ctx, xOf, yOf, padL, padT, plotW, plotH, xLabel, yLabel, maxRange, yLabelX) {
  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.axis;
  ctx.font = FONT_SCOPE;

  const step = Math.max(1, Math.round(maxRange / 6));
  ctx.textAlign = 'center';
  for (let nm = 0; nm <= maxRange + 0.01; nm += step) {
    const x = xOf(nm);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.fillText(String(nm), x, padT + plotH + 15);
  }
  ctx.fillText(xLabel, padL + plotW / 2, padT + plotH + 29);
  ctx.textAlign = 'left';

  for (let i = 0; i <= 4; i++) {
    const y = padT + (i / 4) * plotH;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
  }
  ctx.fillText(yLabel, yLabelX === undefined ? 8 : yLabelX, padT + 10);
}

/* ---------- map background (OpenStreetMap tiles) ---------- */

/* Optional geographic underlay for the north-up scopes (GCI PPI, TWR field
 * view). Tiles come from the OSM tile CDN and are cached in memory; a tile
 * that cannot be loaded (offline, blocked CDN) is marked failed and never
 * retried, so the scopes simply fall back to plain radar. The light OSM
 * style is inverted to a dark one where the browser can filter a canvas, so
 * the map never outshines the traffic. */

const MAP_TILE_URL = 'https://tile.openstreetmap.org';
const MAP_TILE_PX = 256;
const MAP_CACHE_MAX = 400;
const MAP_CAN_FILTER = typeof document.createElement('canvas').getContext('2d').filter === 'string';
const MAP_ALPHA = MAP_CAN_FILTER ? 0.55 : 0.18;
const MAP_FILTER = 'invert(1) hue-rotate(180deg) saturate(0.35) brightness(0.85)';

const mapPrefs = { enabled: prefs.get('gcaMap', 'on') !== 'off' };
const tileCache = new Map(); // url -> { img, ready, failed }
let mapRenderQueued = false;

/** move a lat/lon by (east, north) metres — the flat frame the scopes draw in */
function offsetLatLon(ref, eastM, northM) {
  return {
    lat: ref.lat + northM / EARTH_M_PER_DEG,
    lon: ref.lon + eastM / (EARTH_M_PER_DEG * Math.cos((ref.lat * Math.PI) / 180)),
  };
}

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

/**
 * Dim OSM raster under a north-up scope centred on `ref` (threshold lat/lon).
 * `pan` (metres east/north) shifts the centre for scopes that can be dragged,
 * so the map moves with the tracks instead of staying pinned to the field.
 */
function drawMapBackground(ctx, W, H, ref, mPerPx, pan) {
  if (!mapPrefs.enabled || !ref || ref.lat === undefined || ref.lon === undefined) return;
  if (pan && (pan.x || pan.y)) ref = offsetLatLon(ref, pan.x, pan.y);

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
  if (MAP_CAN_FILTER) ctx.filter = MAP_FILTER;
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

  ctx.fillStyle = COLORS.axis;
  ctx.font = '11px ' + FONT_DATA;
  ctx.textAlign = 'right';
  ctx.fillText('© OpenStreetMap contributors', W - 8, H - 8);
  ctx.textAlign = 'left';
}

/* ================= GCI mode ================= */

function renderGci() {
  drawPpi();
  updateBullseyeSelect();
  updateInterceptInfo();
  renderGciList();
}

function drawPpi() {
  const canvas = $('ppiScope');
  const { ctx, W, H } = beginCanvas(canvas);
  clearBlips('ppiScope');

  const rwy = runwayCfg();
  if (!rwy) {
    drawNotice(ctx, W, H, '滑走路データが無いため、スコープの基準点がありません');
    return;
  }
  const cx = W / 2, cy = H / 2;
  const mPerPx = ppiMPerPx(canvas);

  // The scope centre is the threshold plus the drag offset, so everything —
  // rings, runway, map and tracks — shifts together.
  const pan = state.gciPan;
  const sx = (x) => cx + (x - pan.x) / mPerPx;
  const sy = (y) => cy - (y - pan.y) / mPerPx;

  drawMapBackground(ctx, W, H, rwy.threshold, mPerPx, pan);

  // range rings stay centred on the radar site (the threshold), which is where
  // their labels are measured from, and travel off-centre as the view is panned
  const ox = sx(0), oy = sy(0);
  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.axis;
  ctx.font = FONT_SCOPE;
  const step = state.gciRangeNm / 4;
  for (let r = step; r <= state.gciRangeNm + 0.01; r += step) {
    ctx.beginPath();
    ctx.arc(ox, oy, (r * M_PER_NM) / mPerPx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText(r.toFixed(0), ox + 4, oy - (r * M_PER_NM) / mPerPx - 3);
  }
  ctx.beginPath();
  ctx.moveTo(0, oy);
  ctx.lineTo(W, oy);
  ctx.moveTo(ox, 0);
  ctx.lineTo(ox, H);
  ctx.stroke();

  // north-up, so the compass letters belong to the canvas edges, not the site
  ctx.fillStyle = COLORS.axis;
  ctx.font = FONT_SCOPE_LARGE;
  ctx.fillText('N', cx - 4, 18);
  ctx.fillText('S', cx - 4, H - 8);
  ctx.fillText('E', W - 16, cy + 4);
  ctx.fillText('W', 6, cy + 4);

  // runway strip, drawn from the threshold away from the approach direction
  const hdgRad = (rwy.headingDeg * Math.PI) / 180;
  const lenM = (rwy.lengthNm || 1.2) * M_PER_NM;
  ctx.strokeStyle = COLORS.runway;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(sx(0), sy(0));
  ctx.lineTo(sx(Math.sin(hdgRad) * lenM), sy(Math.cos(hdgRad) * lenM));
  ctx.stroke();
  ctx.lineWidth = 1.5;

  drawBullseyeMarker(ctx, W, H, sx, sy, rwy);

  for (const t of state.tracks) {
    const p = relToRunway(t, rwy);
    if (!p) continue;
    const x = sx(p.x), y = sy(p.y);
    // cull against the canvas, not against a range from the field: once the
    // view is panned the two are no longer the same thing
    if (x < -40 || x > W + 40 || y < -40 || y > H + 40) continue;

    let color = t.onGround ? COLORS.ground : COLORS.traffic;
    if (t.id === state.targetId) color = COLORS.target;
    else if (t.id === state.ownshipId) color = COLORS.own;

    if (t.id === state.targetId || t.id === state.ownshipId) drawHalo(ctx, x, y, color);
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

  // own -> target line, so the pairing reads on the scope as well
  const own = state.tracks.find((t) => t.id === state.ownshipId);
  const tgt = state.tracks.find((t) => t.id === state.targetId);
  const po = own && relToRunway(own, rwy);
  const pt = tgt && relToRunway(tgt, rwy);
  if (po && pt) {
    ctx.save();
    ctx.strokeStyle = COLORS.own;
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.moveTo(sx(po.x), sy(po.y));
    ctx.lineTo(sx(pt.x), sy(pt.y));
    ctx.stroke();
    ctx.restore();
  }
}

/* ---------- PPI geometry (pan / cursor) ---------- */

/** metres per CSS pixel on the PPI at the current range setting */
function ppiMPerPx(canvas) {
  const { W, H } = cssSize(canvas);
  const radius = Math.max(20, Math.min(W, H) / 2 - 40);
  return (state.gciRangeNm * M_PER_NM) / radius;
}

function resetGciPan() {
  state.gciPan = { x: 0, y: 0 };
}

/** CSS pixel on the PPI -> metres east/north of the runway threshold */
function ppiWorldAt(canvas, px, py) {
  const { W, H } = cssSize(canvas);
  const mPerPx = ppiMPerPx(canvas);
  return {
    x: state.gciPan.x + (px - W / 2) * mPerPx,
    y: state.gciPan.y - (py - H / 2) * mPerPx,
  };
}

/* ---------- bullseye ---------- */

function selectedBullseye() {
  if (!state.bullseyes.length) return null;
  return state.bullseyes.find((b) => b.id === state.bullseyeId) || state.bullseyes[0];
}

/** short label for the reference in use, e.g. 'Blue' / 'Allies' / 'Bullseye' */
function bullseyeLabel(b) {
  return b ? b.color || b.coalition || b.name || 'BULLS' : '';
}

/**
 * Bearing and range FROM the selected bullseye TO a point given in the
 * runway-local frame (metres east/north of the threshold) — the reading a
 * controller passes as "bullseye 270/85".
 *
 * DCS native metres are a flat plane, so whenever both the bullseye and the
 * runway carry them the offset is exact. The lat/lon fallback inverts the flat
 * mapping the scope is drawn with and then measures with the scale at the
 * midpoint latitude: a bullseye is often 50+ nm away, far enough for the
 * threshold's own cos(lat) to be several nm out at high latitudes.
 */
function bullseyeVector(pt) {
  const b = selectedBullseye();
  const rwy = runwayCfg();
  const thr = rwy && rwy.threshold;
  if (!b || !thr) return null;

  let east, north;
  if (b.u !== undefined && b.u !== null && thr.z !== undefined) {
    east = thr.z + pt.x - b.u;
    north = thr.x + pt.y - b.v;
  } else if (b.lat !== undefined && b.lat !== null && thr.lat !== undefined) {
    const p = offsetLatLon(thr, pt.x, pt.y);
    const midLat = (((p.lat + b.lat) / 2) * Math.PI) / 180;
    east = (p.lon - b.lon) * EARTH_M_PER_DEG * Math.cos(midLat);
    north = (p.lat - b.lat) * EARTH_M_PER_DEG;
  } else {
    return null;
  }

  return {
    brgDeg: normDeg((Math.atan2(east, north) * 180) / Math.PI),
    rangeNm: Math.hypot(east, north) / M_PER_NM,
  };
}

/** '274/032' — the bullseye call for a point on the scope */
function fmtBullseyeShort(pt) {
  const v = bullseyeVector(pt);
  if (!v) return null;
  return fmtBrg(v.brgDeg) + '/' + String(Math.round(v.rangeNm)).padStart(3, '0');
}

/** 'BULLS(Blue) 274/032' */
function fmtBullseye(pt) {
  const s = fmtBullseyeShort(pt);
  return s ? 'BULLS(' + bullseyeLabel(selectedBullseye()) + ') ' + s : null;
}

/** bullseye call for a track, or null when there is no bullseye / position */
function trackBullseye(t) {
  const rwy = runwayCfg();
  const p = rwy && relToRunway(t, rwy);
  return p ? fmtBullseyeShort(p) : null;
}

function drawBullseyeMarker(ctx, W, H, sx, sy, rwy) {
  const b = selectedBullseye();
  if (!b) return;
  const p = relToRunway(b, rwy);
  if (!p) return;
  const x = sx(p.x), y = sy(p.y);
  if (x < 0 || x > W || y < 0 || y > H) return; // panned out of view

  ctx.save();
  ctx.strokeStyle = COLORS.bullseye;
  ctx.fillStyle = COLORS.bullseye;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.moveTo(x - 12, y);
  ctx.lineTo(x + 12, y);
  ctx.moveTo(x, y - 12);
  ctx.lineTo(x, y + 12);
  ctx.stroke();
  ctx.font = FONT_SCOPE;
  ctx.fillText('BULLS ' + bullseyeLabel(b), x + 14, y - 6);
  ctx.restore();
}

function updateBullseyeSelect() {
  const label = $('bullseyeLabel');
  const sel = $('bullseyeSelect');
  // one bullseye needs no picker: the readout already names it
  label.hidden = state.bullseyes.length < 2;
  if (label.hidden) return;

  const sig = state.bullseyes.map((b) => b.id).join(',');
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = '';
    for (const b of state.bullseyes) {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = bullseyeLabel(b);
      sel.appendChild(opt);
    }
  }
  const cur = selectedBullseye();
  sel.value = cur ? cur.id : '';
}

$('bullseyeSelect').addEventListener('change', (ev) => {
  state.bullseyeId = ev.target.value || null;
  render();
  refreshCursorReadout();
});

/** aircraft for the GCI list: airborne first, then by callsign so rows (and
 * their OWN / TGT buttons) do not shuffle under the pointer */
function gciRows() {
  return state.tracks
    .filter(isAircraft)
    .sort((a, b) => (a.onGround === b.onGround ? 0 : a.onGround ? 1 : -1) ||
      String(callsignOf(a)).localeCompare(String(callsignOf(b))));
}

function renderGciList() {
  const rows = gciRows();
  const airborne = rows.filter((t) => !t.onGround).length;
  setText($('gciListCount'), rows.length ? `飛行中 ${airborne} / ${rows.length} 機` : '');
  syncList(
    $('gciList'),
    rows,
    () => {
      const row = document.createElement('div');
      row.className = 'track';
      row.innerHTML =
        '<span class="name"><i class="side-dot"></i><span class="cs"></span><span class="ty"></span>' +
        '<span class="tag" hidden></span></span>' +
        '<span class="track-actions">' +
        '<button type="button" class="chip-btn own" data-act="own" aria-pressed="false">OWN</button>' +
        '<button type="button" class="chip-btn tgt" data-act="tgt" aria-pressed="false">TGT</button>' +
        '</span><span class="nums"></span>';
      return row;
    },
    (row, t) => {
      row.classList.toggle('on-ground', !!t.onGround);
      fillTrackName(row, t, t.onGround ? '地上' : '');
      const own = row.querySelector('[data-act="own"]');
      const tgt = row.querySelector('[data-act="tgt"]');
      own.setAttribute('aria-pressed', String(t.id === state.ownshipId));
      tgt.setAttribute('aria-pressed', String(t.id === state.targetId));
      own.setAttribute('aria-label', callsignOf(t) + ' を自機 (OWN) にする');
      tgt.setAttribute('aria-label', callsignOf(t) + ' を目標 (TGT) にする');
      const bulls = trackBullseye(t);
      fillNums(row.querySelector('.nums'), [
        [dash(t.altFt) + ' ft'],
        [dash(t.gsKt) + ' kt'],
        ['HDG ' + fmtBrg(courseDeg(t))],
        bulls ? ['BULLS ' + bulls] : null,
      ]);
    },
    'このミッションには航空機がいません。'
  );
}

$('gciList').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('.track').dataset.id;
  if (btn.dataset.act === 'own') {
    state.ownshipId = state.ownshipId === id ? null : id;
    if (state.targetId === state.ownshipId) state.targetId = null;
  } else {
    state.targetId = state.targetId === id ? null : id;
    if (state.ownshipId === state.targetId) state.ownshipId = null;
  }
  render();
});

$('gciClear').addEventListener('click', () => {
  state.ownshipId = state.targetId = null;
  render();
});

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
  const el = $('interceptInfo');
  const own = state.tracks.find((t) => t.id === state.ownshipId);
  const tgt = state.tracks.find((t) => t.id === state.targetId);
  $('gciClear').hidden = !own && !tgt;

  if (!own || !tgt) {
    const who = (t) => (t ? ' <span class="who">' + escapeHtml(callsignOf(t)) + '</span>' : '');
    emptyCard(
      el,
      '<ol class="steps">' +
        '<li class="' + (own ? 'done' : 'now') + '">自機を一覧の「OWN」で選ぶ' + who(own) + '</li>' +
        '<li class="' + (tgt ? 'done' : own ? 'now' : '') + '">目標をスコープの機体クリックか、一覧の「TGT」で選ぶ' + who(tgt) + '</li>' +
        '</ol>'
    );
    return;
  }

  const sol = interceptSolution(own, tgt);
  if (!sol) {
    emptyCard(el, '<p class="focus-empty">位置データが無いため計算できません。</p>');
    return;
  }

  const f = skeleton(
    el,
    'gci',
    '<div class="focus-title"><span class="cs" data-f="own"></span><span class="ty">→</span>' +
      '<span class="cs" data-f="tgt" style="color:var(--bad-text)"></span></div>' +
      '<dl class="readout" style="margin-top:10px">' +
      '<div class="key"><dt>STEER</dt><dd data-f="steer"></dd></div>' +
      '<div class="key"><dt>RNG nm</dt><dd data-f="rng"></dd></div>' +
      '<div class="key"><dt>Δ ALT ft</dt><dd data-f="dalt"></dd></div>' +
      '<div><dt>BRG TO TGT</dt><dd data-f="brg"></dd></div>' +
      '<div><dt>CLOSURE kt</dt><dd data-f="closure"></dd></div>' +
      '<div><dt>TIME TO INT</dt><dd data-f="tti"></dd></div>' +
      '<div class="wide"><dt>TGT BULLSEYE</dt><dd data-f="bulls"></dd></div>' +
      '<div><dt>TGT ALT ft</dt><dd data-f="talt"></dd></div>' +
      '</dl>'
  );
  setText(f('own'), callsignOf(own));
  setText(f('tgt'), callsignOf(tgt));
  setText(f('steer'), sol.steer + '°');
  setText(f('rng'), sol.distNm);
  setText(f('dalt'), sol.deltaAltFt === null ? '-' : (sol.deltaAltFt > 0 ? '+' : '') + sol.deltaAltFt);
  setText(f('brg'), sol.brg + '°');
  setText(f('closure'), dash(sol.closureKt));
  setText(f('tti'), sol.tti);
  const bulls = trackBullseye(tgt);
  setText(f('bulls'), bulls ? bullseyeLabel(selectedBullseye()) + ' ' + bulls : '-');
  setText(f('talt'), dash(tgt.altFt));
}

/* ================= TWR mode ================= */

function renderTwr() {
  drawTwrScope();
  renderFieldList();
}

function drawTwrScope() {
  const canvas = $('twrScope');
  const { ctx, W, H } = beginCanvas(canvas);
  clearBlips('twrScope');

  const rwy = runwayCfg();
  if (!rwy) {
    drawNotice(ctx, W, H, '滑走路データがありません');
    return;
  }
  const cx = W / 2, cy = H / 2;
  const radius = Math.max(20, Math.min(W, H) / 2 - 30);
  const mPerPx = (state.twrRangeNm * M_PER_NM) / radius;

  const sx = (x) => cx + x / mPerPx;
  const sy = (y) => cy - y / mPerPx;

  drawMapBackground(ctx, W, H, rwy.threshold, mPerPx);

  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.axis;
  ctx.font = FONT_SCOPE;
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
  ctx.strokeStyle = COLORS.runway;
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(sx(0), sy(0));
  ctx.lineTo(sx(sinH * lenM), sy(cosH * lenM));
  ctx.stroke();

  // extended centreline: the 5 nm final, on the opposite side of the threshold
  ctx.strokeStyle = COLORS.reference;
  ctx.setLineDash([8, 8]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(sx(0), sy(0));
  ctx.lineTo(sx(-sinH * 5 * M_PER_NM), sy(-cosH * 5 * M_PER_NM));
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = COLORS.label;
  ctx.fillText('THR ' + (rwy.designator || rwy.id), sx(0) + 8, sy(0) - 8);

  for (const t of state.tracks) {
    const p = relToRunway(t, rwy);
    if (!p) continue;
    if (Math.hypot(p.x, p.y) / M_PER_NM > state.twrRangeNm) continue;
    const x = sx(p.x), y = sy(p.y);
    const color = trackColor(t, state.selectedId);
    if (t.id === state.selectedId) drawHalo(ctx, x, y, color);
    drawSymbol(ctx, t, x, y, color);
    drawTrackLabel(ctx, t, x, y, color);
    registerBlip('twrScope', t.id, x, y);
  }
}

function renderFieldList() {
  const rwy = runwayCfg();
  const rows = !rwy
    ? []
    : state.tracks
        .map((t) => {
          const p = relToRunway(t, rwy);
          if (!p) return null;
          return {
            id: t.id,
            t,
            distNm: Math.hypot(p.x, p.y) / M_PER_NM,
            brg: normDeg((Math.atan2(p.x, p.y) * 180) / Math.PI),
          };
        })
        .filter((r) => r && r.distNm <= state.twrRangeNm)
        .sort((a, b) => a.distNm - b.distNm);

  setText($('twrListCount'), rows.length ? rows.length + ' 機' : '');
  syncList(
    $('fieldList'),
    rows,
    createTrackButton,
    (row, r) => {
      const t = r.t;
      row.setAttribute('aria-pressed', String(t.id === state.selectedId));
      row.classList.toggle('on-ground', !!t.onGround);
      fillTrackName(row, t, t.onGround ? '地上' : '');
      setText(row.querySelector('.num'), r.distNm.toFixed(1) + ' nm');
      fillNums(row.querySelector('.nums'), [
        ['BRG ' + fmtBrg(r.brg)],
        [dash(t.altFt) + ' ft'],
        ['VS ' + dash(t.vsFpm)],
        [dash(t.gsKt) + ' kt'],
      ]);
    },
    rwy
      ? escapeHtml(fmtRangeNm(state.twrRangeNm)) + ' 以内に機体はいません。スコープ右上の − / + で範囲を変えられます。'
      : '滑走路データがありません。'
  );
}

$('fieldList').addEventListener('click', (ev) => {
  const row = ev.target.closest('.track');
  if (!row) return;
  state.selectedId = state.selectedId === row.dataset.id ? null : row.dataset.id;
  render();
});

/* ================= LSO mode ================= */

/* IFLOLS-style carrier landing aid. The reference is the carrier (Sea) track
 * itself: the deck is assumed to sit at the carrier's position and altitude,
 * and the approach course is the carrier's heading (into-wind recovery). */

const LSO_GLIDEPATH_DEG = 3.0;
const LSO_MIN_RANGE_NM = 1;
const LSO_MAX_RANGE_NM = 8;
const LSO_LIST_RANGE_NM = 30; // aircraft further out than this are not offered

/** flat-tops if the stream marks them, otherwise every ship */
function carriers() {
  const sea = state.tracks.filter((t) => t.category === 'Sea');
  const flattops = sea.filter((t) => /AircraftCarrier/i.test(t.type || ''));
  return flattops.length ? flattops : sea;
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

/** airborne aircraft near the carrier with their solutions, nearest first */
function lsoRows(car) {
  if (!car) return [];
  return state.tracks
    .filter((t) => isAircraft(t) && !t.onGround && t.id !== car.id)
    .map((t) => ({ id: t.id, t, sol: lsoSolution(t, car) }))
    .filter((r) => r.sol && r.sol.rangeNm <= LSO_LIST_RANGE_NM)
    .sort((a, b) => a.sol.rangeNm - b.sol.rangeNm);
}

/** the picked aircraft, otherwise the nearest one astern and roughly lined up */
function lsoFocus(rows) {
  const picked = rows.find((r) => r.id === state.lsoAircraftId);
  if (picked) return { ...picked, manual: true };
  const astern = rows.find(
    (r) => r.sol.alongNm > 0.1 && r.sol.alongNm <= state.lsoRangeNm + 2 && Math.abs(r.sol.crossNm) < 2
  );
  return astern ? { ...astern, manual: false } : null;
}

function renderLso() {
  const list = carriers();
  // a single carrier needs no picking
  if (!state.carrierId && list.length === 1) state.carrierId = list[0].id;
  updateCarrierSelect(list);

  const car = carrierCfg();
  const rows = lsoRows(car);
  const focus = lsoFocus(rows);
  drawLsoScope(car, focus);
  drawLsoPlatformView(car, focus);
  updateLsoInfo(list, car, focus);
  renderLsoList(car, rows, focus);
}

function updateCarrierSelect(list) {
  const sel = $('carrierSelect');
  const sig = list.map((t) => t.id).join(',');
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = list.length ? `-- 空母を選択 (${list.length} 隻) --` : '-- 空母がいません --';
    sel.appendChild(none);
    for (const c of list) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.pilot && c.pilot !== c.name ? `${c.pilot} (${c.name})` : c.name || c.id;
      sel.appendChild(opt);
    }
  }
  sel.disabled = list.length === 0;
  sel.value = list.some((t) => t.id === state.carrierId) ? state.carrierId : '';
}

$('carrierSelect').addEventListener('change', (ev) => {
  state.carrierId = ev.target.value || null;
  state.lsoAircraftId = null;
  render();
});

function drawLsoScope(car, focus) {
  const canvas = $('lsoScope');
  const { ctx, W, H } = beginCanvas(canvas);
  clearBlips('lsoScope');

  if (!car) {
    drawNotice(ctx, W, H, carriers().length ? '右の欄で空母を選んでください' : 'このミッションには空母がありません');
    return;
  }

  const R = state.lsoRangeNm;
  const mid = W / 2;

  /* ----- left panel: LINEUP (top-down view along the recovery course) ----- */
  const padL = 50, padR = 25, padT = 30, padB = 34;
  const plotW = mid - padL - padR, plotH = H - padT - padB;
  if (plotW <= 0 || plotH <= 0) return;
  const C = Math.max(0.15, R / 8); // cross-track half width (nm)

  const lxOf = (nm) => padL + (nm / R) * plotW;
  const lyOf = (crossNm) => padT + ((C - crossNm) / (2 * C)) * plotH;

  grid(ctx, lxOf, lyOf, padL, padT, plotW, plotH, 'RNG nm', 'LINEUP', R);

  ctx.strokeStyle = COLORS.reference;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(lxOf(0), lyOf(0));
  ctx.lineTo(lxOf(R), lyOf(0));
  ctx.stroke();

  // +/- 1 deg lineup corridors
  ctx.strokeStyle = COLORS.corridor;
  for (const dev of [1, -1]) {
    ctx.beginPath();
    ctx.moveTo(lxOf(0), lyOf(0));
    ctx.lineTo(lxOf(R), lyOf(Math.tan((dev * Math.PI) / 180) * R));
    ctx.stroke();
  }
  ctx.setLineDash([]);

  ctx.fillStyle = COLORS.label;
  ctx.font = FONT_SCOPE;
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

  grid(ctx, gxOf, gyOf, mid + gPadL, padT, gPlotW, plotH, 'RNG nm', 'AGL ft', R, mid + gPadL - 48);

  ctx.strokeStyle = COLORS.reference;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(gxOf(0), gyOf(0));
  ctx.lineTo(gxOf(R), gyOf(Math.tan((LSO_GLIDEPATH_DEG * Math.PI) / 180) * R * M_PER_NM * 3.28084));
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = COLORS.axis;
  ctx.font = FONT_SCOPE;
  ctx.fillText(
    LSO_GLIDEPATH_DEG.toFixed(1) + '° GP',
    gxOf(R * 0.55),
    gyOf(Math.tan((LSO_GLIDEPATH_DEG * Math.PI) / 180) * R * 0.55 * M_PER_NM * 3.28084) - 6
  );

  /* ----- every nearby aircraft, the one being worked highlighted ----- */
  for (const r of lsoRows(car)) {
    const sol = r.sol;
    if (sol.alongNm < -0.2 || sol.alongNm > R || Math.abs(sol.crossNm) > C) continue;
    const isFocus = focus && focus.id === r.id;
    const color = isFocus ? COLORS.selected : COLORS.traffic;
    const lx = lxOf(sol.alongNm), ly = lyOf(sol.crossNm);
    if (isFocus) drawHalo(ctx, lx, ly, color);
    drawSymbol(ctx, r.t, lx, ly, color);
    drawTrackLabel(ctx, r.t, lx, ly, color);
    registerBlip('lsoScope', r.id, lx, ly);

    if (sol.aglFt !== null && sol.aglFt < ALT) {
      const gx = gxOf(sol.alongNm), gy = gyOf(sol.aglFt);
      if (isFocus) drawHalo(ctx, gx, gy, color);
      drawSymbol(ctx, r.t, gx, gy, color);
      registerBlip('lsoScope', r.id, gx, gy);
    }
  }
}

function updateLsoInfo(list, car, focus) {
  const el = $('lsoInfo');
  $('lsoFocusAuto').hidden = !(focus && focus.manual);
  setText($('lsoFocusMode'), focus ? (focus.manual ? '選択中' : '自動: 最も近い機体') : '');

  if (!car) {
    emptyCard(
      el,
      list.length
        ? '<p class="focus-empty">上の欄で空母を選んでください（' + list.length + ' 隻）。</p>'
        : '<p class="focus-empty">このミッションには空母（艦船）がありません。</p>'
    );
    return;
  }
  if (!focus) {
    emptyCard(
      el,
      '<p class="focus-empty">空母の後方から進入中の機体はありません。<br>下の一覧かスコープ上の機体を選ぶと、その機体を誘導できます。</p>'
    );
    return;
  }

  const ac = focus.t;
  const sol = focus.sol;
  const f = skeleton(
    el,
    'lso',
    '<div class="focus-title"><span class="cs" data-f="cs"></span><span class="ty" data-f="ty"></span></div>' +
      '<div class="guidance" data-f="call"></div>' +
      '<dl class="readout">' +
      '<div class="key"><dt>RNG nm</dt><dd data-f="rng"></dd></div>' +
      '<div><dt>GS DEV</dt><dd data-f="gs"></dd></div>' +
      '<div><dt>LINEUP</dt><dd data-f="lu"></dd></div>' +
      '<div><dt>ALT AGL ft</dt><dd data-f="agl"></dd></div>' +
      '<div><dt>AoA</dt><dd data-f="aoa"></dd></div>' +
      '<div><dt>CARRIER</dt><dd data-f="car"></dd></div>' +
      '</dl>'
  );
  setText(f('cs'), callsignOf(ac));
  setText(f('ty'), ac.name || '');
  const call = lsoCall(sol);
  const callEl = f('call');
  setText(callEl, call);
  callEl.className = 'guidance ' + (call === '-' ? 'idle' : /LOW|HIGH|COME/.test(call) ? 'warn' : 'ok');
  setText(f('rng'), sol.rangeNm.toFixed(2));
  setText(f('gs'), fmtSigned(sol.gsDevDeg));
  setText(f('lu'), fmtSide(sol.lineupDeg));
  setText(f('agl'), sol.aglFt === null ? '-' : Math.round(sol.aglFt));
  setText(f('aoa'), sol.aoaDeg === null ? '-' : sol.aoaDeg.toFixed(1) + '°');
  setText(f('car'), car.pilot || car.name || car.id);
  f('car').title = car.pilot || car.name || '';
}

function renderLsoList(car, rows, focus) {
  setText($('lsoListCount'), rows.length ? rows.length + ' 機' : '');
  syncList(
    $('lsoList'),
    rows,
    createTrackButton,
    (row, r) => {
      const isFocus = focus && focus.id === r.id;
      row.setAttribute('aria-pressed', String(r.id === state.lsoAircraftId));
      row.classList.toggle('is-focus', !!isFocus);
      row.classList.toggle('is-auto', !!isFocus && !focus.manual);
      fillTrackName(row, r.t, r.sol.alongNm > 0 ? '' : '前方');
      setText(row.querySelector('.num'), r.sol.rangeNm.toFixed(1) + ' nm');
      fillNums(row.querySelector('.nums'), [
        ['AGL ' + (r.sol.aglFt === null ? '-' : Math.round(r.sol.aglFt))],
        ['LU ' + fmtSide(r.sol.lineupDeg)],
        ['GS ' + fmtSigned(r.sol.gsDevDeg)],
      ]);
    },
    car ? `空母から ${LSO_LIST_RANGE_NM} nm 以内に飛行中の機体はいません。` : '空母を選ぶと、近くの機体がここに並びます。'
  );
}

$('lsoList').addEventListener('click', (ev) => {
  const row = ev.target.closest('.track');
  if (!row) return;
  state.lsoAircraftId = state.lsoAircraftId === row.dataset.id ? null : row.dataset.id;
  render();
});

$('lsoFocusAuto').addEventListener('click', () => {
  state.lsoAircraftId = null;
  render();
});

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

function drawLsoPlatformView(car, focus) {
  const canvas = $('lsoPlatformScope');
  const { ctx, W, H } = beginCanvas(canvas);

  if (!car) {
    drawNotice(ctx, W, H, carriers().length ? '空母を選ぶと表示されます' : 'このミッションには空母がありません');
    return;
  }
  if (!focus) {
    drawNotice(ctx, W, H, '進入中の機体はありません');
    return;
  }
  const sol = focus.sol;
  if (!sol || sol.lineupDeg === null) {
    drawNotice(ctx, W, H, '空母の後方にいないため表示できません');
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
  ctx.strokeStyle = COLORS.label;
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
  ctx.strokeStyle = COLORS.runway;
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
  ctx.fillStyle = '#16232d';
  ctx.beginPath();
  ctx.moveTo(cx - dw / 2, deckCy - dh / 2);
  ctx.lineTo(cx + dw / 2, deckCy - dh / 2);
  ctx.lineTo(cx + dw * 0.58, deckCy + dh / 2);
  ctx.lineTo(cx - dw * 0.58, deckCy + dh / 2);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // deck edge lights
  ctx.fillStyle = COLORS.bullseye;
  for (const fx of [-dw / 2, -dw / 4, 0, dw / 4, dw / 2]) {
    ctx.fillRect(cx + fx - 1.5, deckCy - dh / 2 - 3, 3, 3);
  }

  ctx.fillStyle = COLORS.label;
  ctx.font = FONT_SCOPE;
  ctx.fillText('DECK', cx + dw / 2 + 8, deckCy);

  /* ----- 3.0° glidepath datum -----
   * fixed reference: the jet belongs on this line at its present range */
  ctx.strokeStyle = COLORS.reference;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(W * 0.12, datumY);
  ctx.lineTo(W * 0.88, datumY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = COLORS.reference;
  ctx.font = FONT_SCOPE;
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

  drawAftSilhouette(ctx, ax, ay, s, COLORS.selected);

  /* ----- status overlay ----- */
  const call = lsoCall(sol);
  const bad = call.indexOf('LOW') >= 0 || call.indexOf('HIGH') >= 0 || call.indexOf('COME') >= 0;
  ctx.font = FONT_SCOPE_LARGE;
  ctx.fillStyle = call === '-' ? COLORS.axis : bad ? COLORS.warn : COLORS.ok;
  ctx.textAlign = 'right';
  ctx.fillText(call, W - 14, 22);
  ctx.textAlign = 'left';

  ctx.fillStyle = COLORS.axis;
  ctx.font = FONT_SCOPE;
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
  if (id === state.ownshipId) return; // own aircraft cannot also be the target
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

/* ---------- mode tabs and keyboard ---------- */

document.querySelectorAll('.mode-tab').forEach((btn) => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
});

// arrow keys move along the tab strip (the usual tablist behaviour)
$('mode-gca').closest('.app').querySelector('.modes').addEventListener('keydown', (ev) => {
  if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
  const i = MODES.indexOf(state.mode);
  const next = MODES[(i + (ev.key === 'ArrowRight' ? 1 : MODES.length - 1)) % MODES.length];
  setMode(next);
  document.querySelector(`.mode-tab[data-mode="${next}"]`).focus();
  ev.preventDefault();
});

window.addEventListener('hashchange', () => {
  const m = location.hash.replace('#', '');
  if (MODES.includes(m) && m !== state.mode) setMode(m);
});

/* 1-4 switch modes, M toggles the map, C recentres the PPI, Esc drops the
 * pick. Ignored while a select has focus (its own type-ahead uses the keys). */
document.addEventListener('keydown', (ev) => {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const tag = ev.target && ev.target.tagName;
  if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return;
  const n = ['1', '2', '3', '4'].indexOf(ev.key);
  if (n >= 0) {
    setMode(MODES[n]);
    ev.preventDefault();
  } else if (ev.key === 'm' || ev.key === 'M') {
    toggleMap();
  } else if ((ev.key === 'c' || ev.key === 'C') && state.mode === 'gci') {
    centerGci();
  } else if (ev.key === 'Escape') {
    clearSelection();
  }
});

/* ---------- zoom (buttons, wheel, pinch) ---------- */

const RANGE_KEY = { gca: 'gcaRangeNm', gci: 'gciRangeNm', twr: 'twrRangeNm', lso: 'lsoRangeNm' };

function setRange(mode, v) {
  const next = clampRange(mode, v);
  if (next === state[RANGE_KEY[mode]]) return;
  state[RANGE_KEY[mode]] = next;
  savedRanges[mode] = next;
  prefs.set('gcaRanges', JSON.stringify(savedRanges));
  render();
  if (mode === 'gci') refreshCursorReadout();
}

/** next preset above (dir 1) or below (dir -1) the current range */
function stepRange(mode, dir) {
  const cur = state[RANGE_KEY[mode]];
  const steps = RANGE_STEPS[mode];
  const next = dir > 0 ? steps.find((s) => s > cur + 0.05) : [...steps].reverse().find((s) => s < cur - 0.05);
  if (next !== undefined) setRange(mode, next);
}

function updateZoomLabels() {
  document.querySelectorAll('.zoom').forEach((z) => {
    const mode = z.dataset.zoom;
    const v = state[RANGE_KEY[mode]];
    setText(z.querySelector('output'), fmtRangeNm(v));
    const [lo, hi] = RANGE_LIMITS[mode];
    z.querySelector('[data-step="-1"]').disabled = v <= lo;
    z.querySelector('[data-step="1"]').disabled = v >= hi;
  });
}

document.querySelectorAll('.zoom').forEach((z) => {
  z.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-step]');
    if (b) stepRange(z.dataset.zoom, Number(b.dataset.step));
  });
});

function attachWheelZoom(canvasId, mode) {
  $(canvasId).addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      const factor = ev.deltaY > 0 ? 1.15 : 1 / 1.15; // scroll down = zoom out
      setRange(mode, state[RANGE_KEY[mode]] * factor);
    },
    { passive: false }
  );
}

attachWheelZoom('ppiScope', 'gci');
attachWheelZoom('twrScope', 'twr');
attachWheelZoom('azimuthScope', 'gca');
attachWheelZoom('elevationScope', 'gca');
attachWheelZoom('lsoScope', 'lso');

function attachPinchZoom(canvasId, mode) {
  const el = $(canvasId);
  if (!el) return;
  let startDist = 0;
  let startRange = 0;

  el.addEventListener('touchstart', (ev) => {
    if (ev.touches.length === 2) {
      startDist = Math.hypot(
        ev.touches[0].clientX - ev.touches[1].clientX,
        ev.touches[0].clientY - ev.touches[1].clientY
      );
      startRange = state[RANGE_KEY[mode]];
    }
  }, { passive: true });

  el.addEventListener('touchmove', (ev) => {
    if (ev.touches.length === 2 && startDist > 0) {
      ev.preventDefault();
      const dist = Math.hypot(
        ev.touches[0].clientX - ev.touches[1].clientX,
        ev.touches[0].clientY - ev.touches[1].clientY
      );
      if (dist > 10) setRange(mode, startRange * (startDist / dist)); // pinch in = zoom in
    }
  }, { passive: false });

  el.addEventListener('touchend', () => {
    startDist = 0;
  });
}

attachPinchZoom('ppiScope', 'gci');
attachPinchZoom('twrScope', 'twr');
attachPinchZoom('azimuthScope', 'gca');
attachPinchZoom('elevationScope', 'gca');
attachPinchZoom('lsoScope', 'lso');

/* ---------- GCI: drag to pan, cursor bullseye readout ---------- */

/**
 * Drag a scope around. The offset is kept in metres by the caller, so the
 * ground under the cursor stays under the cursor whatever the zoom level.
 * A drag that actually moved swallows the click that ends it, otherwise
 * every pan would designate whatever blip happened to be under the pointer.
 */
function attachCanvasPan(canvasId, getPan, setPan, getMPerPx) {
  const el = $(canvasId);
  if (!el) return;
  let drag = null; // { x, y, moved } in client (= CSS) pixels

  const begin = (x, y) => {
    dragSuppressClick.delete(canvasId);
    drag = { x, y, moved: 0 };
  };

  const move = (x, y) => {
    if (!drag) return;
    const dx = x - drag.x;
    const dy = y - drag.y;
    drag.x = x;
    drag.y = y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    const m = getMPerPx();
    const p = getPan();
    setPan({ x: p.x - dx * m, y: p.y + dy * m });
  };

  const end = () => {
    if (!drag) return;
    if (drag.moved > 4) dragSuppressClick.add(canvasId);
    drag = null;
    el.style.cursor = '';
  };

  /* Pointer events when the browser has them, plain mouse events otherwise.
   * move/up are bound to `window`, not to the canvas: the drag then survives
   * the pointer leaving the scope without depending on pointer capture. */
  const hasPointer = typeof window.PointerEvent === 'function';
  const DOWN = hasPointer ? 'pointerdown' : 'mousedown';
  const MOVE = hasPointer ? 'pointermove' : 'mousemove';
  const UP = hasPointer ? 'pointerup' : 'mouseup';

  el.addEventListener(DOWN, (ev) => {
    if (ev.pointerType === 'touch' || ev.button !== 0) return; // touch: see below
    ev.preventDefault(); // no text selection / native image drag mid-pan
    begin(ev.clientX, ev.clientY);
    el.style.cursor = 'grabbing';
  });
  window.addEventListener(MOVE, (ev) => {
    if (!drag || ev.pointerType === 'touch') return;
    move(ev.clientX, ev.clientY);
    render();
  });
  window.addEventListener(UP, end);
  window.addEventListener('pointercancel', end);
  window.addEventListener('blur', end);

  // one finger pans; two fingers belong to the pinch-zoom handler
  el.addEventListener('touchstart', (ev) => {
    if (ev.touches.length === 1) begin(ev.touches[0].clientX, ev.touches[0].clientY);
    else end();
  }, { passive: true });
  el.addEventListener('touchmove', (ev) => {
    if (!drag || ev.touches.length !== 1) return;
    ev.preventDefault();
    move(ev.touches[0].clientX, ev.touches[0].clientY);
    render();
  }, { passive: false });
  el.addEventListener('touchend', end);
  el.addEventListener('touchcancel', end);
}

attachCanvasPan(
  'ppiScope',
  () => state.gciPan,
  (p) => {
    state.gciPan = p;
  },
  () => ppiMPerPx($('ppiScope'))
);

function centerGci() {
  resetGciPan();
  render();
  refreshCursorReadout();
}
$('gciCenter').addEventListener('click', centerGci);

/* Bullseye readout for whatever the pointer is over. Written straight into the
 * readout instead of going through render(), so moving the mouse never
 * forces a scope (and map tile) redraw. */

let cursorClient = null; // last pointer position over the PPI, in client pixels

function updateCursorReadout(clientX, clientY) {
  const el = $('ppiScope');
  cursorClient = { x: clientX, y: clientY };
  const p = canvasPoint(el, clientX, clientY);
  const txt = fmtBullseye(ppiWorldAt(el, p.x, p.y));
  setText($('gciCursor'), txt || (state.bullseyes.length ? 'BULLS --' : 'BULLS -- (配信に Bullseye なし)'));
}

/** the same pixel means new ground after a zoom or a recentre */
function refreshCursorReadout() {
  if (cursorClient) updateCursorReadout(cursorClient.x, cursorClient.y);
}

(() => {
  const el = $('ppiScope');
  el.addEventListener('pointermove', (ev) => updateCursorReadout(ev.clientX, ev.clientY));
  el.addEventListener('pointerleave', () => {
    cursorClient = null;
    setText($('gciCursor'), 'BULLS --');
  });
})();

document.getElementById('refreshRunways').addEventListener('click', () => {
  send({ type: 'refreshRunways' });
});

/* ---------- map background toggle ---------- */

function syncMapToggle() {
  $('mapToggle').setAttribute('aria-pressed', String(mapPrefs.enabled));
}
function toggleMap() {
  mapPrefs.enabled = !mapPrefs.enabled;
  prefs.set('gcaMap', mapPrefs.enabled ? 'on' : 'off');
  syncMapToggle();
  render();
}
$('mapToggle').addEventListener('click', toggleMap);
syncMapToggle();

/* ---------- refresh-rate / latency HUD toggle ---------- */

function syncPerfToggle() {
  $('perfToggle').setAttribute('aria-pressed', String(perfPrefs.enabled));
  $('latency').hidden = !perfPrefs.enabled;
}
$('perfToggle').addEventListener('click', () => {
  perfPrefs.enabled = !perfPrefs.enabled;
  prefs.set('gcaPerf', perfPrefs.enabled ? 'on' : 'off');
  syncPerfToggle();
});
syncPerfToggle();

/* ---------- canvas sizing ---------- */

if (typeof ResizeObserver === 'function') {
  const ro = new ResizeObserver(() => {
    if (fitCanvases()) render();
  });
  document.querySelectorAll('.canvas-wrap').forEach((el) => ro.observe(el));
}
window.addEventListener('resize', () => {
  fitCanvases();
  render();
});

/* ---------- boot ---------- */

/* Printed once at start-up: tells you at a glance whether the browser is
 * running the current console or a cached older one. */
console.log('[gca] console build ' + CLIENT_BUILD);

setMode(state.mode);
updateInfoBar();
connectWs();
