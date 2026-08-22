'use strict';

const config = require('./config');
const { TacviewClient } = require('./acmi/TacviewClient');
const { TrackStore } = require('./acmi/TrackStore');
const { Talkdown } = require('./acmi/Talkdown');
const { createServer } = require('./web/httpServer');
const { WsHub } = require('./net/WsHub');

const cfg = config.load();
const store = new TrackStore(cfg);

const tacview = new TacviewClient(cfg);
tacview.on('update', (upd) => store.applyUpdate(upd));
tacview.on('remove', (id) => store.remove(id));
tacview.on('global', (k, v) => {
  if (k === 'ReferenceTime') console.log(`[tacview] mission time reference: ${v}`);
  // ReferenceLongitude/Latitude: ACMI lon/lat are relative to these
  store.setReference(k, v);
});
tacview.start();

// Expose connection state for /api/config
setInterval(() => {
  store.tacviewConnected = Boolean(tacview.socket && !tacview.socket.destroyed);
}, 1000);

const server = createServer(cfg, store);
server.listen(cfg.server.port, cfg.server.bind, () => {
  console.log(`[web] DCS Web GCA listening on http://${cfg.server.bind}:${cfg.server.port}`);
});

const hub = new WsHub(server, store, cfg);
hub.startBroadcasting(200);

// Real-time PAR talk-down phrase generation (1 Hz), per selected runway
const talkdown = new Talkdown(cfg);
setInterval(() => {
  for (const runwayId of hub.activeRunwayIds()) {
    const snap = store.snapshot(runwayId);
    const msgs = talkdown.update(snap.tracks, snap.runway);
    hub.pushTranscript(msgs.map((m) => ({ ...m, runway: snap.runway })));
  }
}, 1000);

process.on('SIGINT', () => {
  console.log('\n[main] shutting down');
  tacview.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
});
