'use strict';

/**
 * WebSocket hub: broadcasts track snapshots to connected browsers.
 * Clients may send { "type": "selectRunway", "runway": "<id>" } to switch
 * the reference runway used for GCA guidance computation.
 */

const { WebSocketServer } = require('ws');

class WsHub {
  constructor(httpServer, store, cfg) {
    this.store = store;
    this.cfg = cfg;
    this.selectedRunway = cfg.gca.defaultRunway;

    this.wss = new WebSocketServer({ server: httpServer, path: '/ws' });

    this.wss.on('connection', (ws) => {
      console.log(`[ws] client connected (total: ${this.wss.clients.size})`);
      ws.send(JSON.stringify({ type: 'hello', runways: cfg.gca.runways.map((r) => r.id), runway: this.selectedRunway }));
      ws.send(JSON.stringify({ type: 'tracks', ...store.snapshot(this.selectedRunway) }));

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'selectRunway' && cfg.gca.runways.some((r) => r.id === msg.runway)) {
            this.selectedRunway = msg.runway;
            this.broadcast({ type: 'runwayChanged', runway: this.selectedRunway });
          }
        } catch {
          /* ignore malformed messages */
        }
      });

      ws.on('close', () => console.log(`[ws] client disconnected (total: ${this.wss.clients.size})`));
    });
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if (client.readyState === 1) client.send(data);
    }
  }

  startBroadcasting(intervalMs = 200) {
    setInterval(() => {
      if (this.wss.clients.size > 0) {
        this.broadcast({ type: 'tracks', ...this.store.snapshot(this.selectedRunway) });
      }
    }, intervalMs);
  }
}

module.exports = { WsHub };
