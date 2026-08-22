'use strict';

/**
 * WebSocket hub.
 *
 * Every browser picks its own (server, runway) pair — a controller working
 * Batumi on server 1 must not have their scope yanked around because someone
 * else switched to Kutaisi on server 2. Snapshots are therefore computed once
 * per *distinct* subscription and fanned out to its subscribers.
 *
 * client -> server : {type:'subscribe', source, runway} | {type:'selectRunway', runway}
 * server -> client : hello | sources | runways | tracks | transcript
 */

const { WebSocketServer } = require('ws');

const TALKDOWN_EVERY_MS = 1000;

class WsHub {
  constructor(httpServer, sources, cfg) {
    this.sources = sources; // Map<id, DcsSource>
    this.cfg = cfg;
    this.clients = new Map(); // ws -> { sourceId, runwayId }
    this.lastTalkdownAt = 0;

    this.wss = new WebSocketServer({ server: httpServer, path: '/ws' });
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  get sourceList() {
    return [...this.sources.values()];
  }

  onConnection(ws) {
    const first = this.sourceList[0];
    const state = { sourceId: first ? first.id : null, runwayId: first ? first.defaultRunwayId() : null };
    this.clients.set(ws, state);

    send(ws, {
      type: 'hello',
      gca: {
        azToleranceDeg: this.cfg.gca.azToleranceDeg,
        gsToleranceDeg: this.cfg.gca.gsToleranceDeg,
      },
      sources: this.sourceList.map((s) => s.status),
      source: state.sourceId,
      runway: state.runwayId,
    });
    this.sendRunways(ws, state);

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.onMessage(ws, msg);
    });
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => ws.close());
  }

  onMessage(ws, msg) {
    const state = this.clients.get(ws);
    if (!state) return;

    if (msg.type === 'subscribe') {
      if (msg.source && this.sources.has(msg.source)) {
        state.sourceId = msg.source;
        state.runwayId = null;
      }
      const src = this.sources.get(state.sourceId);
      if (!src) return;
      state.runwayId =
        (msg.runway && src.runwayProvider.find(msg.runway) ? msg.runway : null) || src.defaultRunwayId();
      this.sendRunways(ws, state);
      return;
    }

    if (msg.type === 'selectRunway') {
      const src = this.sources.get(state.sourceId);
      if (src && src.runwayProvider.find(msg.runway)) {
        state.runwayId = msg.runway;
        this.sendRunways(ws, state);
      }
      return;
    }

    if (msg.type === 'refreshRunways') {
      const src = this.sources.get(state.sourceId);
      if (src) src.runwayProvider.refresh().then(() => this.sendRunways(ws, state));
    }
  }

  sendRunways(ws, state) {
    const src = this.sources.get(state.sourceId);
    if (!src) return;
    send(ws, {
      type: 'runways',
      source: src.id,
      runways: src.runways,
      runway: state.runwayId,
      status: src.status,
    });
    const transcript = src.transcript(state.runwayId);
    send(ws, { type: 'transcript', reset: true, messages: transcript });
  }

  /** group live clients by their (source, runway) subscription */
  subscriptions() {
    const groups = new Map();
    for (const [ws, state] of this.clients) {
      if (ws.readyState !== 1) continue;
      const src = this.sources.get(state.sourceId);
      if (!src) continue;
      const key = `${state.sourceId} ${state.runwayId}`;
      let g = groups.get(key);
      if (!g) {
        g = { source: src, runwayId: state.runwayId, clients: [] };
        groups.set(key, g);
      }
      g.clients.push(ws);
    }
    return groups;
  }

  tick() {
    const groups = this.subscriptions();
    const doTalkdown = Date.now() - this.lastTalkdownAt >= TALKDOWN_EVERY_MS;
    const watched = new Map(); // sourceId -> Set(runwayId)

    for (const g of groups.values()) {
      const snap = g.source.snapshot(g.runwayId);
      const payload = JSON.stringify({
        type: 'tracks',
        source: g.source.id,
        runway: snap.runway ? snap.runway.id : null,
        time: snap.time,
        counts: snap.counts,
        connected: g.source.client.connected,
        tracks: snap.tracks,
      });
      for (const ws of g.clients) if (ws.readyState === 1) ws.send(payload);

      if (!watched.has(g.source.id)) watched.set(g.source.id, new Set());
      if (snap.runway) watched.get(g.source.id).add(snap.runway.id);

      if (doTalkdown) {
        const msgs = g.source.tickTalkdown(snap);
        if (msgs.length) {
          const t = JSON.stringify({ type: 'transcript', messages: msgs });
          for (const ws of g.clients) if (ws.readyState === 1) ws.send(t);
        }
      }
    }

    if (doTalkdown) {
      this.lastTalkdownAt = Date.now();
      for (const src of this.sourceList) src.retainTalkdowns(watched.get(src.id) || new Set());
    }
  }

  /** push connection/mission status to everybody (cheap, every few seconds) */
  broadcastStatus() {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify({ type: 'sources', sources: this.sourceList.map((s) => s.status) });
    for (const ws of this.clients.keys()) if (ws.readyState === 1) ws.send(payload);
  }

  start(intervalMs = 200) {
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.statusTimer = setInterval(() => this.broadcastStatus(), 5000);
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.statusTimer);
  }
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

module.exports = { WsHub };
