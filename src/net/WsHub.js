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
    this.transcript = []; // recent talk-down messages for late joiners

    this.wss = new WebSocketServer({ server: httpServer, path: '/ws' });

    this.wss.on('connection', (ws) => {
      console.log(`[ws] client connected (total: ${this.wss.clients.size})`);
      ws.send(JSON.stringify({ type: 'hello', runways: cfg.gca.runways.map((r) => r.id), runway: this.selectedRunway }));
      ws.send(JSON.stringify({ type: 'tracks', ...store.snapshot(this.selectedRunway) }));
      if (this.transcript.length > 0) {
        ws.send(JSON.stringify({ type: 'transcript', messages: this.transcript }));
      }

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

  pushTranscript(messages) {
    if (!messages || messages.length === 0) return;
    this.transcript.push(...messages);
    if (this.transcript.length > 100) {
      this.transcript.splice(0, this.transcript.length - 100);
    }
    this.broadcast({ type: 'transcript', messages });
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
