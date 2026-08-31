'use strict';

/**
 * Configuration loading.
 *
 * config/config.json (or $GCA_CONFIG) holds the whole deployment description:
 * one entry per DCS server ("source"), the DCSServerBot RestAPI used to pull
 * runway geometry, and the guidance tuning constants.
 *
 * The legacy single-server shape ({ tacview: {...}, gca: { runways: [...] } })
 * is still accepted and normalised into a one-element `sources` array.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = process.env.GCA_CONFIG || path.join(ROOT, 'config', 'config.json');
const EXAMPLE_PATH = path.join(ROOT, 'config', 'config.example.json');

const DEFAULT_GCA = {
  staleAfterSec: 15,
  // How long a track record is kept after it goes quiet. Far longer than
  // staleAfterSec on purpose: see TrackStore.prune().
  forgetAfterSec: 3600,
  glidepathDeg: 3.0,
  azToleranceDeg: 0.8,
  gsToleranceDeg: 0.4,
};

const DEFAULT_DCSSB = {
  enabled: false,
  baseUrl: '',
  prefix: '/stats',
  apiKey: '',
  timeoutMs: 45000,
  // Each /airbase call runs a Lua query inside the DCS mission thread, so the
  // whole airbase sweep is deliberately slow-walked to stay off the sim's back.
  requestSpacingMs: 1500,
  refreshOnMissionChange: true,
};

function load() {
  let file = CONFIG_PATH;
  if (!fs.existsSync(file)) {
    file = EXAMPLE_PATH;
    console.warn(`[config] ${path.relative(ROOT, CONFIG_PATH)} not found, falling back to ${path.relative(ROOT, file)}`);
  }
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));

  cfg.server = Object.assign({ port: 8080, bind: '0.0.0.0' }, cfg.server);
  cfg.gca = Object.assign({}, DEFAULT_GCA, cfg.gca);
  cfg.dcssb = Object.assign({}, DEFAULT_DCSSB, cfg.dcssb);
  cfg.cacheDir = cfg.cacheDir || path.join(ROOT, 'cache');

  // --- legacy single-source shape -------------------------------------------
  if (!Array.isArray(cfg.sources) || cfg.sources.length === 0) {
    cfg.sources = [
      {
        id: 'dcs',
        name: 'DCS Server',
        tacview: cfg.tacview || {},
        runways: (cfg.gca && cfg.gca.runways) || [],
        defaultRunway: cfg.gca && cfg.gca.defaultRunway,
      },
    ];
  }

  cfg.sources = cfg.sources.map((src, i) => normaliseSource(src, i, cfg));

  // --- environment overrides (docker / systemd) -----------------------------
  if (process.env.GCA_PORT) cfg.server.port = parseInt(process.env.GCA_PORT, 10);
  if (process.env.GCA_BIND) cfg.server.bind = process.env.GCA_BIND;
  if (process.env.GCA_CACHE_DIR) cfg.cacheDir = process.env.GCA_CACHE_DIR;
  if (process.env.DCSSB_BASE_URL) {
    cfg.dcssb.baseUrl = process.env.DCSSB_BASE_URL;
    cfg.dcssb.enabled = true;
  }
  if (process.env.DCSSB_API_PREFIX) cfg.dcssb.prefix = process.env.DCSSB_API_PREFIX;
  if (process.env.DCSSB_API_KEY) cfg.dcssb.apiKey = process.env.DCSSB_API_KEY;

  // Protocol diagnostics (Issue #8 field verification). Off by default; when
  // enabled the Tacview pipeline aggregates handshake/reference/transform/
  // Type/u-v/ground-speed evidence, served on /api/diagnostics and dumped to
  // TACVIEW_DEBUG_DUMP (signals are not portable on Windows).
  cfg.debug = {
    enabled: process.env.TACVIEW_DEBUG === '1' || process.env.TACVIEW_DEBUG === 'true',
    dumpPath: process.env.TACVIEW_DEBUG_DUMP || null,
  };

  // Dev convenience: point the first source at a mock/other host.
  const first = cfg.sources[0];
  if (process.env.TACVIEW_HOST) first.tacview.host = process.env.TACVIEW_HOST;
  if (process.env.TACVIEW_PORT) first.tacview.port = parseInt(process.env.TACVIEW_PORT, 10);
  if (process.env.TACVIEW_PASSWORD !== undefined) first.tacview.password = process.env.TACVIEW_PASSWORD;

  return cfg;
}

function normaliseSource(src, i, cfg) {
  const out = Object.assign({}, src);
  out.id = out.id || `dcs${i + 1}`;
  out.name = out.name || out.id;
  out.tacview = Object.assign(
    { host: '127.0.0.1', port: 42674, password: '', reconnectDelayMs: 5000, clientName: 'DCSWebGCA' },
    out.tacview
  );
  // `dcssbServerName` is the server name as DCSServerBot knows it (servers.yaml).
  out.dcssbServerName = out.dcssbServerName || out.dcssb || null;
  out.glidepathDeg = out.glidepathDeg || cfg.gca.glidepathDeg;
  out.runways = Array.isArray(out.runways) ? out.runways : [];
  return out;
}

module.exports = { load, ROOT };
