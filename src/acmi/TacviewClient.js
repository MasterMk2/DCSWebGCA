'use strict';

const { EventEmitter } = require('events');

/**
 * TCP client for the Tacview real-time telemetry stream.
 *
 * Handshake (XtraLib protocol): the client sends
 *
 *   XtraLib.Stream.0\n
 *   Tacview.RealTimeTelemetry.0\n
 *   <client name>\n
 *   <password>\n
 *   \0
 *
 * The host replies with its own XtraLib header and then starts streaming
 * ACMI text frames.
 */

const net = require('net');
const { AcmiParser } = require('./AcmiParser');

const CLIENT_NAME = 'DCSWebGCA';

class TacviewClient extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg.tacview;
    this.socket = null;
    this.parser = new AcmiParser();
    this.buffer = '';
    this.reconnectTimer = null;
    this.stopped = false;

    this.parser.on('object', (upd) => this.emit('update', upd));
    this.parser.on('remove', (id) => this.emit('remove', id));
    this.parser.on('global', (k, v) => this.emit('global', k, v));
    this.parser.on('version', (v) => console.log(`[tacview] protocol ${v}`));
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    if (this.socket) this.socket.destroy();
  }

  connect() {
    const { host, port, password } = this.cfg;
    console.log(`[tacview] connecting to ${host}:${port} ...`);

    const socket = net.createConnection({ host, port }, () => {
      console.log('[tacview] connected, sending XtraLib handshake');
      const handshake =
        `XtraLib.Stream.0\n` +
        `Tacview.RealTimeTelemetry.0\n` +
        `${CLIENT_NAME}\n` +
        `${password || ''}\n` +
        `\0`;
      socket.write(handshake);
    });
    this.socket = socket;

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      this.buffer += chunk;
      let idx;
      // ACMI frames are line-based; strip any NUL bytes from the handshake reply
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).replace(/\r$/, '').replace(/\0/g, '');
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          this.parser.handleLine(line);
        } catch (err) {
          console.error('[tacview] parse error:', err.message);
        }
      }
    });

    socket.on('error', (err) => {
      console.error(`[tacview] connection error: ${err.message}`);
    });

    socket.on('close', () => {
      this.socket = null;
      if (!this.stopped) {
        console.log(`[tacview] disconnected, retrying in ${this.cfg.reconnectDelayMs} ms`);
        this.reconnectTimer = setTimeout(() => this.connect(), this.cfg.reconnectDelayMs);
      }
    });
  }
}

module.exports = { TacviewClient };
