'use strict';

/**
 * Protocol diagnostics collector for Issue #8 (real-world DCS+Tacview
 * verification). Enabled with TACVIEW_DEBUG=1; when disabled no instance is
 * created anywhere in the pipeline, so the hot path stays untouched.
 *
 * Aggregates, per Tacview source:
 *   - the raw host handshake reply (first one only)
 *   - presence and values of ReferenceLongitude / ReferenceLatitude
 *   - a histogram of transform field counts (3 / 5 / 9 ...)
 *   - occurrence counts of every Type string seen
 *   - raw-vs-absolute coordinate samples for the first few tracks, including
 *     the native u/v metres, to prove the axis hypothesis on real data
 *   - ground-speed differencing statistics (sample count + mean)
 *
 * Results are served on GET /api/diagnostics and, when TACVIEW_DEBUG_DUMP is
 * set, periodically written to that file (signals are not portable on Windows).
 */

const fs = require('fs');

const UV_TRACK_SAMPLES = 5; // first N aircraft kept as raw-coordinate evidence
const UV_TRACKER_CAP = 1000; // bound the per-track last-position map
const MIN_DT_S = 0.05; // ignore differencing pairs closer than this
const KT_PER_MS = 1 / 0.514444;

class Diagnostics {
  constructor(opts = {}) {
    this.dumpPath = opts.dumpPath || null;
    this.maxUvTracks = opts.maxUvTracks || UV_TRACK_SAMPLES;
    this.reset();
  }

  reset() {
    this.startedAt = new Date().toISOString();
    this.handshakeRaw = null;
    this.referenceDeclared = {};
    this.referenceValues = {};
    this.transformHistogram = {};
    this.typeCounts = {};
    this.uvSamples = [];
    this.gs = { samples: 0, sumMs: 0 };
    this._lastUv = new Map(); // id -> { u, v, t }
    this._dirty = true;
  }

  /** Raw host handshake reply (called once per connection, kept first only). */
  recordHandshake(raw) {
    if (this.handshakeRaw === null) {
      this.handshakeRaw = String(raw).replace(/\0/g, '');
      this._dirty = true;
    }
  }

  recordGlobal(key, value) {
    if (key !== 'ReferenceLongitude' && key !== 'ReferenceLatitude') return;
    this.referenceDeclared[key] = true;
    const num = parseFloat(value);
    if (!Number.isNaN(num)) this.referenceValues[key] = num;
    this._dirty = true;
  }

  /** Transform field count for one object line (3 / 5 / 9 on the wire). */
  recordTransform(fieldCount) {
    this.transformHistogram[fieldCount] = (this.transformHistogram[fieldCount] || 0) + 1;
    this._dirty = true;
  }

  recordUpdate(id, props) {
    if (props.Type !== undefined) {
      this.typeCounts[props.Type] = (this.typeCounts[props.Type] || 0) + 1;
      this._dirty = true;
    }

    // Evidence sample: raw relative lon/lat as sent, the decoded absolute
    // degrees, and the native u/v metres -- enough to check the axis claim.
    if (
      this.uvSamples.length < this.maxUvTracks &&
      props.lonRel !== undefined &&
      !this.uvSamples.some((s) => s.id === id)
    ) {
      this.uvSamples.push({
        id,
        lonRel: props.lonRel,
        latRel: props.latRel,
        lon: props.lon !== undefined ? props.lon : null,
        lat: props.lat !== undefined ? props.lat : null,
        u: props.u !== undefined ? props.u : null,
        v: props.v !== undefined ? props.v : null,
      });
      this._dirty = true;
    }

    // Ground speed by differencing the native coordinates, mirroring what
    // TrackStore does, so the number can be compared against the DCS HUD.
    if (props.u !== undefined && props.v !== undefined) {
      const now = Date.now();
      const prev = this._lastUv.get(id);
      this._lastUv.set(id, { u: props.u, v: props.v, t: now });
      if (prev) {
        const dt = (now - prev.t) / 1000;
        if (dt >= MIN_DT_S) {
          this.gs.samples++;
          this.gs.sumMs += Math.hypot(props.u - prev.u, props.v - prev.v) / dt;
          this._dirty = true;
        }
      }
      if (this._lastUv.size > UV_TRACKER_CAP) this._lastUv.clear();
    }
  }

  report() {
    const transformTotal = Object.values(this.transformHistogram).reduce((a, b) => a + b, 0);
    const typeTotal = Object.values(this.typeCounts).reduce((a, b) => a + b, 0);
    const meanMs = this.gs.samples > 0 ? this.gs.sumMs / this.gs.samples : null;
    return {
      enabled: true,
      startedAt: this.startedAt,
      handshake: this.handshakeRaw,
      reference: {
        declared: this.referenceDeclared,
        longitude: this.referenceValues.ReferenceLongitude ?? null,
        latitude: this.referenceValues.ReferenceLatitude ?? null,
      },
      transforms: { histogram: this.transformHistogram, total: transformTotal },
      types: { counts: this.typeCounts, distinct: Object.keys(this.typeCounts).length, total: typeTotal },
      uvSamples: this.uvSamples,
      groundSpeed: {
        samples: this.gs.samples,
        meanMs,
        meanKt: meanMs !== null ? meanMs * KT_PER_MS : null,
      },
    };
  }

  /**
   * Write the report to TACVIEW_DEBUG_DUMP when set. Called on a timer; only
   * touches the disk when something changed since the last write.
   */
  maybeDump(force = false) {
    if (!this.dumpPath) return false;
    if (!force && !this._dirty) return false;
    try {
      fs.writeFileSync(this.dumpPath, JSON.stringify(this.report(), null, 2));
      this._dirty = false;
      return true;
    } catch (err) {
      console.error(`[diagnostics] dump failed: ${err.message}`);
      return false;
    }
  }
}

module.exports = { Diagnostics };
