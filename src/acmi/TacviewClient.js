'use strict';

/**
 * TCP client for the Tacview real-time telemetry stream.
 *
 * Handshake (both directions, terminated by a NUL byte):
 *
 *   XtraLib.Stream.0
 *   Tacview.RealTimeTelemetry.0
 *   <client or host name>
 *   <password>\0
 *
 * The host replies with the same four-line block and then streams ACMI text.
 * Sending anything else (e.g. just a password line) leaves DCS waiting for a
 * handshake it never gets and no telemetry is ever delivered.
 */

const net = require('net');
const { EventEmitter } = require('events');
const { AcmiParser } = require('./AcmiParser');
const { AircraftFreshness, mergeSample } = require('./AircraftFreshness');

const IDLE_TIMEOUT_MS = 60000;
const HANDSHAKE_TIMEOUT_MS = 10000;
const HEALTH_INTERVAL_MS = 10000;
const SCENE_KEYS = ['ReferenceTime', 'ReferenceLongitude', 'ReferenceLatitude', 'Title'];
const RECOVERY_DEFAULTS = { enabled: true, staleAfterMs: 30000, probeIntervalMs: 120000, probeTimeoutMs: 10000 };

function recoveryConfig(value) {
  const cfg = Object.assign({}, RECOVERY_DEFAULTS, value);
  if (typeof cfg.enabled !== 'boolean') throw new Error('aircraftRecovery.enabled must be boolean');
  for (const [key, min, max] of [['staleAfterMs', 15000, 3600000], ['probeIntervalMs', 30000, 3600000], ['probeTimeoutMs', 1000, 30000]]) {
    if (!Number.isFinite(cfg[key]) || cfg[key] < min || cfg[key] > max) {
      throw new Error(`aircraftRecovery.${key} must be between ${min} and ${max}`);
    }
  }
  return cfg;
}

class TacviewClient extends EventEmitter {
  constructor(tacviewCfg, label = 'tacview') {
    super();
    this.cfg = Object.assign({ reconnectDelayMs: 5000, clientName: 'DCSWebGCA', password: '' }, tacviewCfg);
    this.label = label;
    this.recoveryCfg = recoveryConfig(this.cfg.aircraftRecovery);
    this.freshness = new AircraftFreshness();
    this.recoveryProbe = null;
    this.nextProbeAt = 0;
    this.recoveryStats = { probes: 0, recoveries: 0, lastProbeAt: null, lastRecoveryAt: null };
    this.frameTime = null;
    this.lastFrameAdvancedAt = null;
    this.socket = null;
    this.parser = new AcmiParser();
    this.buffer = '';
    this.handshakeDone = false;
    this.connected = false;
    this.reconnectTimer = null;
    this.idleTimer = null;
    this.stopped = false;
    this.lastDataAt = 0;
    this.missionTitle = null;
    this.errStreak = 0;

    this.parser.on('object', (upd) => {
      if (this.recoveryCfg.enabled) this.freshness.update(upd, Date.now());
      this.emit('update', upd);
    });
    this.parser.on('remove', (id) => {
      this.freshness.remove(id);
      this.emit('remove', id);
    });
    this.parser.on('time', (time) => {
      if (!Number.isFinite(time)) return;
      if (this.frameTime !== null && time < this.frameTime) this.resetFreshness();
      if (this.frameTime === null || time > this.frameTime) this.lastFrameAdvancedAt = Date.now();
      this.frameTime = time;
    });
    this.parser.on('global', (k, v) => {
      if (k === 'Title' && v !== this.missionTitle) {
        this.missionTitle = v;
        this.emit('mission', v);
      }
      this.emit('global', k, v);
    });
    this.parser.on('header', (line) => {
      // A fresh FileType header means the recording restarted (mission change,
      // server restart): drop everything we knew about the old world.
      if (line.startsWith('FileType=')) {
        this.resetFreshness();
        this.emit('restart');
      }
    });
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.cancelRecoveryProbe();
    clearTimeout(this.reconnectTimer);
    clearInterval(this.idleTimer);
    if (this.socket) this.socket.destroy();
  }

  get status() {
    return {
      connected: this.connected,
      host: this.cfg.host,
      port: this.cfg.port,
      lastDataAt: this.lastDataAt || null,
      mission: this.missionTitle,
      aircraftRecovery: { enabled: this.recoveryCfg.enabled, inProgress: !!this.recoveryProbe, ...this.recoveryStats },
    };
  }

  connect() {
    const { host, port, password, clientName } = this.cfg;
    this.resetFreshness();
    this.buffer = '';
    this.handshakeDone = false;
    this.parser.reset();

    const socket = net.createConnection({ host, port }, () => {
      socket.write(`XtraLib.Stream.0\nTacview.RealTimeTelemetry.0\n${clientName}\n${password || ''}\0`);
    });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setNoDelay(true);

    // A host that accepts the TCP connection but never answers the handshake
    // (wrong port, half-open socket) would otherwise sit there forever.
    const handshakeTimer = setTimeout(() => {
      if (!this.handshakeDone) {
        console.error(`[${this.label}] no handshake within ${HANDSHAKE_TIMEOUT_MS / 1000}s, reconnecting`);
        socket.destroy();
      }
    }, HANDSHAKE_TIMEOUT_MS);
    socket.on('close', () => clearTimeout(handshakeTimer));

    socket.on('data', (chunk) => {
      this.lastDataAt = Date.now();
      if (!this.handshakeDone) {
        this.buffer += chunk;
        const nul = this.buffer.indexOf('\0');
        if (nul < 0) return; // still reading the host handshake
        clearTimeout(handshakeTimer);
        const hello = this.buffer.slice(0, nul).split('\n');
        if (this.diagnostics) this.diagnostics.recordHandshake(this.buffer.slice(0, nul));
        this.handshakeDone = true;
        this.connected = true;
        this.buffer = this.buffer.slice(nul + 1);
        this.errStreak = 0;
        console.log(`[${this.label}] connected to ${host}:${port} (host: ${(hello[2] || '?').trim()})`);
        this.emit('connected');
      } else {
        this.buffer += chunk;
      }

      let idx;
      // ACMI frames are line-based; strip any NUL bytes from the handshake reply
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).replace(/\r$/, '').replace(/\0/g, '');
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          this.parser.handleLine(line);
        } catch (err) {
          console.error(`[${this.label}] parse error: ${err.message}`);
        }
      }
    });

    socket.on('error', (err) => {
      // A server that is simply down would otherwise log every reconnectDelayMs;
      // shout on the first failure of a streak, then once a minute.
      const every = Math.max(1, Math.round(60000 / (this.cfg.reconnectDelayMs || 5000)));
      if (this.errStreak % every === 0) console.error(`[${this.label}] ${err.message}`);
      this.errStreak++;
    });

    socket.on('close', () => {
      this.cancelRecoveryProbe();
      const wasConnected = this.connected;
      this.connected = false;
      this.socket = null;
      if (wasConnected) {
        console.log(`[${this.label}] disconnected`);
        this.emit('disconnected');
      }
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.connect(), this.cfg.reconnectDelayMs);
      }
    });

    // DCS can leave a half-open socket behind (host killed, netns gone): if the
    // stream goes quiet for a minute, force a reconnect rather than sit on a
    // socket that will never produce another frame.
    clearInterval(this.idleTimer);
    this.idleTimer = setInterval(() => this.checkHealth(), HEALTH_INTERVAL_MS);
  }

  resetFreshness() {
    this.cancelRecoveryProbe();
    this.freshness.clear();
    this.frameTime = null;
    this.lastFrameAdvancedAt = null;
  }

  checkHealth(now = Date.now()) {
    if (!this.connected || this.stopped) return;
    if (now - this.lastDataAt > IDLE_TIMEOUT_MS) {
      console.warn(`[${this.label}] no data for ${IDLE_TIMEOUT_MS / 1000}s, reconnecting`);
      this.cancelRecoveryProbe();
      if (this.socket) this.socket.destroy();
      return;
    }
    // Repeated frame timestamps (paused simulation), a quiet stream, and a
    // missing mission identity do not provide enough evidence for a probe.
    if (!this.recoveryCfg.enabled || this.recoveryProbe || now < this.nextProbeAt ||
        this.lastFrameAdvancedAt === null || now - this.lastFrameAdvancedAt > HEALTH_INTERVAL_MS ||
        !this.parser.global.ReferenceTime) return;
    const candidates = this.freshness.candidates(now, this.recoveryCfg.staleAfterMs);
    if (candidates.length) this.startRecoveryProbe(candidates, now);
  }

  createRecoveryProbe() {
    return new TacviewClient({ ...this.cfg, reconnectDelayMs: this.recoveryCfg.probeTimeoutMs + 1000,
      aircraftRecovery: { enabled: false } }, `${this.label}:snapshot`);
  }

  startRecoveryProbe(candidates, now) {
    // One short-lived connection per source, at most once per interval,
    // including failures. The primary connection keeps all traffic flowing.
    this.nextProbeAt = now + this.recoveryCfg.probeIntervalMs;
    this.recoveryStats.probes++;
    this.recoveryStats.lastProbeAt = now;
    const client = this.createRecoveryProbe();
    const state = { client, candidates, samples: new Map(), socket: this.socket,
      scene: Object.fromEntries(SCENE_KEYS.map((key) => [key, this.parser.global[key]])), timer: null };
    this.recoveryProbe = state;
    const ids = new Set(candidates.map((c) => c.id));
    client.on('update', ({ id, props }) => {
      if (!ids.has(id)) return;
      const sample = state.samples.get(id) || {};
      mergeSample(sample, props);
      state.samples.set(id, sample);
    });
    client.on('remove', (id) => state.samples.delete(id));
    client.on('restart', () => state.samples.clear());
    // A failed/closed probe never triggers a live reconnect and never retries
    // outside the parent's cooldown.
    client.on('disconnected', () => this.cancelRecoveryProbe());
    state.timer = setTimeout(() => this.finishRecoveryProbe(state), this.recoveryCfg.probeTimeoutMs);
    client.start();
  }

  finishRecoveryProbe(state, now = Date.now()) {
    if (this.recoveryProbe !== state) return;
    const sceneMatches = SCENE_KEYS.every((key) => state.scene[key] === state.client.parser.global[key] &&
      state.scene[key] === this.parser.global[key]);
    const drift = this.connected && state.client.connected && this.socket === state.socket && sceneMatches &&
      this.lastFrameAdvancedAt !== null && now - this.lastFrameAdvancedAt <= HEALTH_INTERVAL_MS &&
      state.candidates.some((candidate) => {
        const fresh = state.samples.get(candidate.id);
        return fresh && this.freshness.confirmsDrift(candidate, fresh);
      });
    this.cancelRecoveryProbe();
    if (drift && this.socket && !this.stopped) {
      this.recoveryStats.recoveries++;
      this.recoveryStats.lastRecoveryAt = now;
      console.warn(`[${this.label}] confirmed stale aircraft position in fresh snapshot, reconnecting`);
      this.socket.destroy();
    }
  }

  cancelRecoveryProbe() {
    const state = this.recoveryProbe;
    this.recoveryProbe = null;
    if (!state) return;
    clearTimeout(state.timer);
    state.client.stop();
  }
}

module.exports = { TacviewClient };
