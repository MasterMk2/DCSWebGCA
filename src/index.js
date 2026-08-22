'use strict';

const config = require('./config');
const { DcsSource } = require('./sources/DcsSource');
const { createServer } = require('./web/httpServer');
const { WsHub } = require('./net/WsHub');

const cfg = config.load();

const sources = new Map();
for (const srcCfg of cfg.sources) {
  const src = new DcsSource(cfg, srcCfg);
  sources.set(src.id, src);
  src.start();
  console.log(`[main] source ${src.id} (${src.name}) -> ${srcCfg.tacview.host}:${srcCfg.tacview.port}`);
}

const server = createServer(cfg, sources);
server.listen(cfg.server.port, cfg.server.bind, () => {
  console.log(`[web] DCS Web GCA listening on http://${cfg.server.bind}:${cfg.server.port}`);
});

const hub = new WsHub(server, sources, cfg);
hub.start(cfg.server.broadcastIntervalMs || 200);

let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[main] ${sig}, shutting down`);
  hub.stop();
  for (const src of sources.values()) src.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
