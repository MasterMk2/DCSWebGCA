'use strict';

/**
 * WebSocket hub: broadcasts track snapshots to connected browsers.
 *
 * Runway selection is PER CLIENT: each connection may send
 * { "type": "selectRunway", "runway": "<id>" } and only that client's
 * guidance data is affected.
 */

const { WebSocketServer } = require('ws');

class WsHub {
  constructor(httpServer, store, cfg) {
    this.store = store;
    this.cfg = cfg;
    this.transcript = []; // recent talk-down messages for late joiners

    this.wss = new WebSocketServer({ server: httpServer, path: '/ws' });
    this.clientRunways = new WeakMap(); // ws -> runwayId

    this.wss.on('connection', (ws) => {
      console.log(`[ws] client connected (total: ${this.wss.clients.size})`);
      const defaultRwy = cfg.gca.defaultRunway;
      this.clientRunways.set(ws, defaultRwy);

      ws.send(JSON.stringify({ type: 'hello', runways: cfg.gca.runways.map((r) => r.id), runway: defaultRwy }));
      ws.send(JSON.stringify({ type: 'tracks', ...store.snapshot(defaultRwy) }));
      ws.send(JSON.stringify({ type: 'transcript', messages: this.transcriptFor(defaultRwy) }));

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (
            msg.type === 'selectRunway' &&
            cfg.gca.runways.some((r) => r.id === msg.runway)
          ) {
            // per-client only: do not touch other connections
            this.clientRunways.set(ws, msg.runway);
            ws.send(JSON.stringify({ type: 'runwayChanged', runway: msg.runway }));
            ws.send(JSON.stringify({ type: 'tracks', ...store.snapshot(msg.runway) }));
            ws.send(JSON.stringify({ type: 'transcript', messages: this.transcriptFor(msg.runway) }));
          }
        } catch {
          /* ignore malformed messages */
        }
      });

      ws.on('close', () => console.log(`[ws] client disconnected (total: ${this.wss.clients.size})`));
    });
  }

  runwayOf(ws) {
    return this.clientRunways.get(ws) || this.cfg.gca.defaultRunway;
  }

  /** Distinct runway ids currently selected by connected clients. */
  activeRunwayIds() {
    const ids = new Set();
    for (const ws of this.wss.clients) ids.add(this.runwayOf(ws));
    if (ids.size === 0) ids.add(this.cfg.gca.defaultRunway);
    return [...ids];
  }

  transcriptFor(runwayId) {
    return this.transcript.filter((m) => !m.runway || m.runway === runwayId);
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
    if (this.transcript.length > 200) {
      this.transcript.splice(0, this.transcript.length - 200);
    }
    // deliver each message only to clients watching that runway
    for (const client of this.wss.clients) {
      if (client.readyState !== 1) continue;
      const rwy = this.runwayOf(client);
      const relevant = messages.filter((m) => !m.runway || m.runway === rwy);
      if (relevant.length > 0) {
        client.send(JSON.stringify({ type: 'transcript', messages: relevant }));
      }
    }
  }

  startBroadcasting(intervalMs = 200) {
    setInterval(() => {
      // per-client snapshots so each controller sees their own runway
      const cache = new Map(); // runwayId -> snapshot payload string
      for (const client of this.wss.clients) {
        if (client.readyState !== 1) continue;
        const rwy = this.runwayOf(client);
        if (!cache.has(rwy)) {
          cache.set(rwy, JSON.stringify({ type: 'tracks', ...this.store.snapshot(rwy) }));
        }
        client.send(cache.get(rwy));
      }
    }, intervalMs);
  }
}

module.exports = { WsHub };
