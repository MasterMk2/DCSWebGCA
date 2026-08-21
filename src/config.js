'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = process.env.GCA_CONFIG || path.join(ROOT, 'config', 'config.json');
const EXAMPLE_PATH = path.join(ROOT, 'config', 'config.example.json');

function load() {
  let file = CONFIG_PATH;
  if (!fs.existsSync(file)) {
    file = EXAMPLE_PATH;
    console.warn(`[config] config.json not found, falling back to ${path.relative(ROOT, file)}`);
  }
  const raw = fs.readFileSync(file, 'utf8');
  const cfg = JSON.parse(raw);

  // Environment overrides (useful for systemd deployments)
  if (process.env.GCA_PORT) cfg.server.port = parseInt(process.env.GCA_PORT, 10);
  if (process.env.GCA_BIND) cfg.server.bind = process.env.GCA_BIND;
  if (process.env.TACVIEW_HOST) cfg.tacview.host = process.env.TACVIEW_HOST;
  if (process.env.TACVIEW_PORT) cfg.tacview.port = parseInt(process.env.TACVIEW_PORT, 10);
  if (process.env.TACVIEW_PASSWORD !== undefined) cfg.tacview.password = process.env.TACVIEW_PASSWORD;

  return cfg;
}

module.exports = { load };
