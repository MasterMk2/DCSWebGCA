'use strict';

/**
 * Parser for ACMI 2.2 text streams (line-based).
 *
 * Line kinds:
 *   V2.2                          -> protocol version
 *   #123.45                       -> global time update
 *   Key=Value                     -> global property (object 0, e.g. ReferenceLongitude)
 *   T=<id>|<prop>=<value>|...     -> object update (prop "T" is the transform)
 *   -<id>                         -> object removal
 *
 * Transform fields (comma separated, empty = unchanged):
 *   0 Longitude  1 Latitude  2 Altitude(m)  3 Roll  4 Pitch  5 Yaw
 *   6 U  7 V  8 Heading(track)
 */

const { EventEmitter } = require('events');

const TRANSFORM_KEYS = ['lon', 'lat', 'altM', 'roll', 'pitch', 'yaw', 'u', 'v', 'hdg'];

class AcmiParser extends EventEmitter {
  constructor() {
    super();
    this.global = {};
  }

  handleLine(line) {
    if (!line) return;

    if (line[0] === '#') {
      const t = parseFloat(line.slice(1));
      if (!Number.isNaN(t)) this.emit('time', t);
      return;
    }

    if (line.startsWith('T=')) {
      this.parseObjectUpdate(line.slice(2));
      return;
    }

    if (line[0] === '-') {
      this.emit('remove', line.slice(1));
      return;
    }

    if (line[0] === 'V' && /^V\d/.test(line)) {
      this.emit('version', line);
      return;
    }

    // Global property (Key=Value). Skip binary escape lines starting with '\'.
    if (line[0] === '\\') return;
    const eq = line.indexOf('=');
    if (eq > 0) {
      const key = line.slice(0, eq);
      const val = line.slice(eq + 1);
      this.global[key] = val;
      this.emit('global', key, val);
    }
  }

  parseObjectUpdate(body) {
    const fields = body.split('|');
    let id = fields.shift();
    if (!id) return;

    // Optional /A (added) or /X (removed) event suffix
    let removed = false;
    if (id.endsWith('/X')) {
      removed = true;
      id = id.slice(0, -2);
    } else if (id.endsWith('/A')) {
      id = id.slice(0, -2);
    }
    id = id.trim();
    if (!id) return;

    if (removed) {
      this.emit('remove', id);
      return;
    }

    const props = {};
    for (const field of fields) {
      const eq = field.indexOf('=');
      if (eq <= 0) continue;
      const key = field.slice(0, eq);
      const val = field.slice(eq + 1);
      if (key === 'T') {
        this.applyTransform(props, val);
      } else {
        props[key] = val;
      }
    }
    if (Object.keys(props).length > 0) {
      this.emit('object', { id, props });
    }
  }

  applyTransform(props, val) {
    const parts = val.split(',');
    for (let i = 0; i < Math.min(parts.length, TRANSFORM_KEYS.length); i++) {
      const raw = parts[i];
      if (raw === '') continue;
      const num = parseFloat(raw);
      if (!Number.isNaN(num)) props[TRANSFORM_KEYS[i]] = num;
    }
  }
}

module.exports = { AcmiParser };
