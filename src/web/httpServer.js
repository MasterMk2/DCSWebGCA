'use strict';

/**
 * Static file server + JSON API.
 *
 *   GET /api/config                  sources and guidance tuning
 *   GET /api/runways?source=         runway definitions of one server
 *   GET /api/state?source=&runway=   current snapshot (REST fallback / probing)
 *   GET /api/health                  per-source stream health (ops)
 *   GET /api/diagnostics             Tacview protocol evidence (TACVIEW_DEBUG=1)
 *
 * All asset references in public/ are relative, so the console can be mounted
 * at the site root or behind a reverse-proxy sub-path (e.g. /gca/).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function createServer(cfg, sources) {
  const authToken = (cfg.auth && cfg.auth.token) || '';

  // Token check for the API and the WebSocket endpoint. Static assets stay
  // open so the page itself loads; every data path is protected. The token
  // comes either as ?token=... (WebSocket / simple links) or as an
  // Authorization: Bearer header.
  function authorized(url, req) {
    if (!authToken) return true;
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/ws') return true;
    if (url.searchParams.get('token') === authToken) return true;
    const header = req.headers.authorization || '';
    return header === `Bearer ${authToken}`;
  }

  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (!authorized(url, req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' });
      return res.end('Unauthorized');
    }

    const pick = () => sources.get(url.searchParams.get('source')) || [...sources.values()][0];

    switch (url.pathname) {
      case '/api/config':
        return json(res, {
          sources: [...sources.values()].map((s) => ({
            id: s.id,
            name: s.name,
            connected: s.client.connected,
            mission: s.client.missionTitle,
            defaultRunway: s.defaultRunwayId(),
          })),
          gca: cfg.gca,
        });

      case '/api/runways': {
        const src = pick();
        if (!src) return json(res, { runways: [] });
        return json(res, { source: src.id, runways: src.runways, status: src.runwayProvider.status });
      }

      case '/api/state': {
        const src = pick();
        if (!src) return json(res, { tracks: [] });
        return json(res, src.snapshot(url.searchParams.get('runway')));
      }

      case '/api/health': {
        const list = [...sources.values()].map((s) => s.status);
        const ok = list.some((s) => s.connected);
        return json(res, { ok, sources: list }, ok ? 200 : 503);
      }

      // Protocol diagnostics (Issue #8): only populated when the server runs
      // with TACVIEW_DEBUG=1; otherwise reports enabled:false per source.
      case '/api/diagnostics':
        return json(res, {
          enabled: [...sources.values()].some((s) => s.diagnostics),
          sources: [...sources.values()].map((s) =>
            s.diagnostics ? Object.assign({ id: s.id, name: s.name }, s.diagnostics.report()) : { id: s.id, name: s.name, enabled: false }
          ),
        });

      default:
        return serveStatic(url.pathname, res);
    }
  });
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function json(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

module.exports = { createServer };
