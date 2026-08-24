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

const IDLE_TIMEOUT_MS = 60000;
const HANDSHAKE_TIMEOUT_MS = 10000;

class TacviewClient extends EventEmitter {
  constructor(tacviewCfg, label = 'tacview') {
    super();
    this.cfg = Object.assign({ reconnectDelayMs: 5000, clientName: 'DCSWebGCA', password: '' }, tacviewCfg);
    this.label = label;
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

    this.parser.on('object', (upd) => this.emit('update', upd));
    this.parser.on('remove', (id) => this.emit('remove', id));
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
      if (line.startsWith('FileType=')) this.emit('restart');
    });
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
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
    };
  }

  connect() {
    const { host, port, password, clientName } = this.cfg;
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
    this.idleTimer = setInterval(() => {
      if (this.connected && Date.now() - this.lastDataAt > IDLE_TIMEOUT_MS) {
        console.warn(`[${this.label}] no data for ${IDLE_TIMEOUT_MS / 1000}s, reconnecting`);
        if (this.socket) this.socket.destroy();
      }
    }, 10000);
  }
}

module.exports = { TacviewClient };
