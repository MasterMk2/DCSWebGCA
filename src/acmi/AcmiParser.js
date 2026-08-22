'use strict';

/**
 * Parser for the ACMI 2.x flight-recording text format as emitted by the DCS
 * Tacview exporter (`tacviewRealTimeTelemetryEnabled`).
 *
 * Line kinds actually seen on the wire:
 *
 *   FileType=text/acmi/tacview          file header
 *   FileVersion=2.2
 *   0,ReferenceLatitude=38              global property (object id 0)
 *   0,Title=FFS-CaucasusFreeFlight...
 *   #36568.57                           frame time (sec since ReferenceTime)
 *   29502,T=4.73|3.57|2286|-0.6|4.6|129.8|545654|-366511.31|124.6,Type=Air+FixedWing,Name=F-16C
 *   29502,T=|||545691.5|-366535.78      partial update (unchanged fields empty)
 *   -29502                              object destroyed / left the scene
 *
 * Notes that matter and that a "looks about right" parser gets wrong:
 *
 *  - Properties are comma separated; the transform sub-fields are pipe separated
 *    (not the other way round).
 *  - The transform has three valid shapes and the meaning of a field depends on
 *    how many fields the line carries:
 *        3 -> lon | lat | alt
 *        5 -> lon | lat | alt | u | v
 *        9 -> lon | lat | alt | roll | pitch | yaw | u | v | heading
 *    Blindly indexing a 5-field transform as if it were the 9-field one puts the
 *    native coordinates into roll/pitch.
 *  - lon/lat are *relative* to ReferenceLongitude / ReferenceLatitude.
 *  - u/v are the recording's native cartesian coordinates. For DCS these are the
 *    mission coordinates in metres: u = DCS z (east), v = DCS x (north). They are
 *    what the mission scripting API (and therefore DCSServerBot's runway data)
 *    reports, so they let us do the approach geometry without any projection.
 *  - Commas, backslashes and newlines inside property values are backslash
 *    escaped; a value may continue onto the next physical line (mission briefings
 *    do this constantly).
 */

const { EventEmitter } = require('events');

class AcmiParser extends EventEmitter {
  constructor() {
    super();
    this.global = {};
    this.reference = { lat: 0, lon: 0 };
    this.pending = null; // partial line held back by a trailing escape
  }

  reset() {
    this.global = {};
    this.reference = { lat: 0, lon: 0 };
    this.pending = null;
  }

  handleLine(rawLine) {
    let line = rawLine;

    // A value continued on the next physical line ends with an *odd* number of
    // backslashes; join and wait for the rest.
    if (this.pending !== null) {
      line = this.pending + '\n' + line;
      this.pending = null;
    }
    if (endsWithOddBackslash(line)) {
      this.pending = line;
      return;
    }
    if (!line) return;

    const c = line[0];

    if (c === '#') {
      const t = parseFloat(line.slice(1));
      if (!Number.isNaN(t)) this.emit('time', t);
      return;
    }

    if (c === '-') {
      const id = line.slice(1).trim();
      if (id) this.emit('remove', id);
      return;
    }

    if (line.startsWith('FileType=') || line.startsWith('FileVersion=')) {
      this.emit('header', line);
      return;
    }

    const fields = splitEscaped(line, ',');
    const id = fields.shift();
    if (!id) return;

    if (id === '0') {
      for (const f of fields) {
        const eq = f.indexOf('=');
        if (eq <= 0) continue;
        const key = f.slice(0, eq);
        const val = unescapeValue(f.slice(eq + 1));
        this.global[key] = val;
        if (key === 'ReferenceLatitude') this.reference.lat = parseFloat(val) || 0;
        if (key === 'ReferenceLongitude') this.reference.lon = parseFloat(val) || 0;
        this.emit('global', key, val);
      }
      return;
    }

    const props = {};
    for (const f of fields) {
      const eq = f.indexOf('=');
      if (eq <= 0) continue;
      const key = f.slice(0, eq);
      const val = f.slice(eq + 1);
      if (key === 'T') this.applyTransform(props, val);
      else props[key] = unescapeValue(val);
    }
    if (Object.keys(props).length > 0) this.emit('object', { id, props });
  }

  applyTransform(props, val) {
    const raw = val.split('|');
    const n = raw.length;
    let keys;
    if (n <= 3) keys = ['lonRel', 'latRel', 'altM'];
    else if (n <= 5) keys = ['lonRel', 'latRel', 'altM', 'u', 'v'];
    else keys = ['lonRel', 'latRel', 'altM', 'roll', 'pitch', 'yaw', 'u', 'v', 'hdg'];

    for (let i = 0; i < Math.min(n, keys.length); i++) {
      if (raw[i] === '') continue;
      const num = parseFloat(raw[i]);
      if (!Number.isNaN(num)) props[keys[i]] = num;
    }
    if (props.lonRel !== undefined) props.lon = this.reference.lon + props.lonRel;
    if (props.latRel !== undefined) props.lat = this.reference.lat + props.latRel;
  }
}

function endsWithOddBackslash(s) {
  let n = 0;
  for (let i = s.length - 1; i >= 0 && s[i] === '\\'; i--) n++;
  return n % 2 === 1;
}

/** split on `sep`, honouring backslash escapes */
function splitEscaped(s, sep) {
  const out = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      cur += ch + s[i + 1];
      i++;
    } else if (ch === sep) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function unescapeValue(s) {
  return s.replace(/\\([\s\S])/g, (_, c) => (c === 'n' || c === '\n' ? '\n' : c));
}

module.exports = { AcmiParser, splitEscaped, unescapeValue };
