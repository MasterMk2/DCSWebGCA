'use strict';

/**
 * Minimal static file server + JSON API.
 *
 *   GET /api/config -> runway definitions and server info
 *   GET /api/state  -> current track snapshot (REST fallback)
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

function createServer(cfg, store) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/config') {
      json(res, {
        runways: cfg.gca.runways,
        defaultRunway: cfg.gca.defaultRunway,
        tacviewConnected: store.tacviewConnected || false,
      });
      return;
    }

    if (url.pathname === '/api/state') {
      json(res, store.snapshot(cfg.gca.defaultRunway));
      return;
    }

    serveStatic(url.pathname, res);
  });
}

function serveStatic(pathname, res) {
  let rel = pathname === '/' ? '/index.html' : pathname;
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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function json(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

module.exports = { createServer };
