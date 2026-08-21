'use strict';

/**
 * Live track store: merges ACMI object updates into current world state
 * and computes GCA (precision approach) guidance data relative to a runway.
 */

const M_PER_FT = 0.3048;
const M_PER_NM = 1852;
const EARTH_M_PER_DEG = 111320;

const AIRBORNE_TYPES = new Set(['Airplane', 'Helicopter']);

class TrackStore {
  constructor(cfg) {
    this.cfg = cfg;
    this.tracks = new Map(); // id -> track record
  }

  applyUpdate({ id, props }) {
    let t = this.tracks.get(id);
    if (!t) {
      t = { id };
      this.tracks.set(id, t);
    }
    Object.assign(t, props);
    t.lastUpdate = Date.now();
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
    return AIRBORNE_TYPES.has(t.Type) && typeof t.lat === 'number';
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
        altFt: t.altM !== undefined ? Math.round(t.altM / M_PER_FT) : null,
        hdg: t.hdg !== undefined ? Math.round(t.hdg) : null,
        iasKt: t.IAS ? Math.round(parseFloat(t.IAS) * 1.94384) : null,
      };
      if (rwy && this.isAirborne(t)) {
        rec.approach = this.computeApproach(t, rwy);
      }
      tracks.push(rec);
    }
    return { time: Date.now(), runway: rwy ? rwy.id : null, tracks };
  }
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
