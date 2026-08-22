'use strict';

/**
 * Live track store: merges ACMI object updates into current world state
 * and computes GCA (precision approach) guidance data relative to a runway.
 *
 * Notes:
 * - ACMI lon/lat values are RELATIVE to the global ReferenceLongitude /
 *   ReferenceLatitude when those are present (typical for DCS exports).
 *   They are converted to absolute degrees here.
 * - DCS exports do not include IAS/TAS; ground speed and ground course are
 *   derived from consecutive position samples (U/V meters preferred, which
 *   map to DCS z/x and share the coordinate system used by DCS-side runway
 *   data such as DCSSB).
 */

const M_PER_FT = 0.3048;
const M_PER_NM = 1852;
const EARTH_M_PER_DEG = 111320;
const MS_TO_KT = 1.94384;

class TrackStore {
  constructor(cfg) {
    this.cfg = cfg;
    this.tracks = new Map(); // id -> track record
    this.refLon = null;      // absolute ReferenceLongitude (deg)
    this.refLat = null;      // absolute ReferenceLatitude (deg)
  }

  setReference(key, val) {
    const num = parseFloat(val);
    if (Number.isNaN(num)) return;
    if (key === 'ReferenceLongitude') this.refLon = num;
    else if (key === 'ReferenceLatitude') this.refLat = num;
  }

  applyUpdate({ id, props }) {
    let t = this.tracks.get(id);
    if (!t) {
      t = {};
      this.tracks.set(id, t);
    }

    // Convert relative lon/lat to absolute using the global references
    if (props.lon !== undefined && this.refLon !== null) props.lon += this.refLon;
    if (props.lat !== undefined && this.refLat !== null) props.lat += this.refLat;

    const prev = {
      altM: t.altM,
      altTime: t.altTime,
    };
    Object.assign(t, props);

    const now = Date.now();

    // Vertical speed (ft/min) from consecutive altitude samples
    if (props.altM !== undefined) {
      if (prev.altM !== undefined && prev.altTime && now > prev.altTime) {
        const dtSec = (now - prev.altTime) / 1000;
        if (dtSec >= 0.5) {
          t.vsFpm = Math.round(((props.altM - prev.altM) / M_PER_FT) / (dtSec / 60));
        }
      }
      t.altTime = now;
    }

    // Ground speed (kt) and ground course (deg) from position differencing.
    // U/V are meters (u = DCS z = east, v = DCS x = north).
    // The baseline position is kept until a full >=0.5 s window has elapsed,
    // so speed is always distance/time over the same interval.
    if (props.u !== undefined || props.lat !== undefined) {
      if (t.spdBase === undefined) {
        t.spdBase = { u: t.u, v: t.v, lat: t.lat, lon: t.lon, time: now };
      } else {
        const dtSec = (now - t.spdBase.time) / 1000;
        if (dtSec >= 0.5) {
          let de, dn;
          if (t.u !== undefined && t.spdBase.u !== undefined) {
            de = t.u - t.spdBase.u;
            dn = t.v - t.spdBase.v;
          } else if (t.lat !== undefined && t.spdBase.lat !== undefined) {
            dn = (t.lat - t.spdBase.lat) * EARTH_M_PER_DEG;
            de = (t.lon - t.spdBase.lon) * EARTH_M_PER_DEG * Math.cos((t.lat * Math.PI) / 180);
          }
          if (de !== undefined) {
            const dist = Math.hypot(de, dn);
            if (dist > 1) {
              t.spdKt = Math.round((dist / dtSec) * MS_TO_KT);
              t.gc = normDeg((Math.atan2(de, dn) * 180) / Math.PI);
            } else {
              // stationary: report zero speed instead of spiking
              t.spdKt = 0;
            }
            t.spdBase = { u: t.u, v: t.v, lat: t.lat, lon: t.lon, time: now };
          }
        }
      }
    }

    t.lastUpdate = now;
  }

  remove(id) {
    this.tracks.delete(id);
  }

  prune() {
    const cutoff = Date.now() - this.cfg.gca.staleAfterSec * 1000;
    for (const [id, t] of this.tracks) {
      if ((t.lastUpdate || 0) < cutoff) this.tracks.delete(id);
    }
  }

  isAirborne(t) {
    // DCS exports e.g. "Air+FixedWing", "Air+Rotorcraft"
    return typeof t.Type === 'string' && t.Type.startsWith('Air') && typeof t.lat === 'number';
  }

  /**
   * Compute approach geometry of a track relative to a runway definition.
   * Uses flat-earth approximation around the threshold (fine for <30 nm).
   */
  computeApproach(t, rwy) {
    const thrLatRad = (rwy.threshold.lat * Math.PI) / 180;
    const x = (t.lon - rwy.threshold.lon) * EARTH_M_PER_DEG * Math.cos(thrLatRad); // east +
    const y = (t.lat - rwy.threshold.lat) * EARTH_M_PER_DEG;                        // north +

    const hdgRad = (rwy.headingDeg * Math.PI) / 180;
    const sinH = Math.sin(hdgRad);
    const cosH = Math.cos(hdgRad);

    const along = x * sinH + y * cosH;   // distance along final approach course (m)
    const cross = x * cosH - y * sinH;   // + = right of centerline (m)

    const rangeNm = Math.hypot(x, y) / M_PER_NM;
    const altFt = t.altM !== undefined ? t.altM / M_PER_FT : undefined;
    const altAboveThrFt = altFt !== undefined ? altFt - rwy.threshold.altFt : undefined;

    const azDevDeg = along > 1 ? (Math.atan2(cross, along) * 180) / Math.PI : 0;
    const elevDeg =
      along > 1 && altAboveThrFt !== undefined
        ? (Math.atan2(altAboveThrFt * M_PER_FT, along) * 180) / Math.PI
        : null;
    const gsDevDeg = elevDeg !== null ? elevDeg - rwy.glidepathDeg : null;

    return {
      rangeNm: round(rangeNm, 2),
      alongNm: round(along / M_PER_NM, 2),
      crossNm: round(cross / M_PER_NM, 3),
      azDevDeg: round(azDevDeg, 2),
      elevDeg: elevDeg !== null ? round(elevDeg, 2) : null,
      gsDevDeg: gsDevDeg !== null ? round(gsDevDeg, 2) : null,
      altFt: altFt !== undefined ? Math.round(altFt) : null,
      guidance: guidanceText(azDevDeg, gsDevDeg),
    };
  }

  snapshot(runwayId) {
    this.prune();
    const rwy =
      this.cfg.gca.runways.find((r) => r.id === runwayId) ||
      this.cfg.gca.runways.find((r) => r.id === this.cfg.gca.defaultRunway) ||
      this.cfg.gca.runways[0];

    const tracks = [];
    for (const t of this.tracks.values()) {
      const rec = {
        id: t.id,
        name: t.Name || 'Unknown',
        type: t.Type || '',
        pilot: t.Pilot || '',
        lat: t.lat,
        lon: t.lon,
        u: t.u,
        v: t.v,
        altFt: t.altM !== undefined ? Math.round(t.altM / M_PER_FT) : null,
        hdg: t.hdg !== undefined ? Math.round(t.hdg) : null,
        spdKt: t.spdKt !== undefined ? t.spdKt : null,
        gc: t.gc !== undefined ? Math.round(t.gc) : null,
        vsFpm: t.vsFpm !== undefined ? t.vsFpm : null,
      };
      if (rwy && this.isAirborne(t)) {
        rec.approach = this.computeApproach(t, rwy);
      }
      tracks.push(rec);
    }
    return { time: Date.now(), runway: rwy ? rwy.id : null, tracks };
  }
}

function normDeg(d) {
  return ((d % 360) + 360) % 360;
}

function round(v, d) {
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

function guidanceText(azDev, gsDev) {
  if (gsDev === null) return '';
  const parts = [];
  if (Math.abs(azDev) < 0.8) parts.push('ON COURSE');
  else parts.push(azDev > 0 ? 'FLY LEFT' : 'FLY RIGHT');
  if (Math.abs(gsDev) < 0.4) parts.push('ON GLIDEPATH');
  else parts.push(gsDev > 0 ? 'COMING HIGH' : 'COMING LOW');
  return parts.join(' / ');
}

module.exports = { TrackStore };
