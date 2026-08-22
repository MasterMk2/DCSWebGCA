'use strict';

/**
 * Live world state for one DCS server.
 *
 * ACMI updates are merged into per-object records; approach geometry is then
 * computed against the selected runway.
 *
 * Geometry is done in DCS native metres (u = east / DCS z, v = north / DCS x)
 * whenever the stream carries them, which is the same frame the runway data
 * from DCSServerBot lives in — no projection, no flat-earth error. lat/lon is
 * kept as a fallback for streams that only send the 3-field transform.
 */

const M_PER_FT = 0.3048;
const M_PER_NM = 1852;
const EARTH_M_PER_DEG = 111320;
const KT_PER_MS = 1.943844;

class TrackStore {
  constructor(cfg, label = 'store') {
    this.cfg = cfg;
    this.label = label;
    this.tracks = new Map();
    // config.load() fills these in, but the store is also constructed directly
    // (tests, embedders), so never depend on them being present.
    const gca = (cfg && cfg.gca) || {};
    this.tuning = {
      staleAfterSec: gca.staleAfterSec ?? 15,
      azToleranceDeg: gca.azToleranceDeg ?? 0.8,
      gsToleranceDeg: gca.gsToleranceDeg ?? 0.4,
    };
  }

  clear() {
    this.tracks.clear();
  }

  applyUpdate({ id, props }) {
    let t = this.tracks.get(id);
    if (!t) {
      t = { id, firstSeen: Date.now() };
      this.tracks.set(id, t);
    }
    const now = Date.now();

    Object.assign(t, props);
    if (props.Type !== undefined) t.category = categorize(props.Type);

    // Velocity is differentiated against a reference sample that is only
    // replaced once enough time has passed. Comparing against the *previous*
    // update instead would never work: the stream sends 5-10 updates a second,
    // so the interval never reaches the minimum and nothing is ever computed.
    const pos = planar(t);
    if (pos) {
      if (!t.velRef) {
        t.velRef = { e: pos.e, n: pos.n, altM: t.altM, at: now };
      } else {
        const dt = (now - t.velRef.at) / 1000;
        if (dt >= 0.5) {
          const de = pos.e - t.velRef.e;
          const dn = pos.n - t.velRef.n;
          const gs = Math.hypot(de, dn) / dt; // m/s
          t.gsMs = smooth(t.gsMs, gs, 0.4);
          if (gs > 2) t.trkDeg = normDeg((Math.atan2(de, dn) * 180) / Math.PI);
          if (t.altM !== undefined && t.velRef.altM !== undefined) {
            const vs = ((t.altM - t.velRef.altM) / M_PER_FT) / (dt / 60); // ft/min
            t.vsFpm = smooth(t.vsFpm, vs, 0.4);
          }
          t.velRef = { e: pos.e, n: pos.n, altM: t.altM, at: now };
        }
      }
    }
    t.lastUpdate = now;
  }

  remove(id) {
    this.tracks.delete(id);
  }

  prune() {
    const cutoff = Date.now() - this.tuning.staleAfterSec * 1000;
    for (const [id, t] of this.tracks) {
      if ((t.lastUpdate || 0) < cutoff) this.tracks.delete(id);
    }
  }

  isAirborne(t) {
    return (t.category === 'FixedWing' || t.category === 'Rotorcraft') && planar(t) !== null;
  }

  /** offsets in metres (east, north) of a track from a runway threshold */
  offsets(t, rwy) {
    const thr = rwy.threshold;
    if (t.u !== undefined && thr.z !== undefined) {
      return { east: t.u - thr.z, north: t.v - thr.x };
    }
    if (t.lat === undefined || thr.lat === undefined) return null;
    const latRad = (thr.lat * Math.PI) / 180;
    return {
      east: (t.lon - thr.lon) * EARTH_M_PER_DEG * Math.cos(latRad),
      north: (t.lat - thr.lat) * EARTH_M_PER_DEG,
    };
  }

  computeApproach(t, rwy) {
    const off = this.offsets(t, rwy);
    if (!off) return null;

    const hdgRad = (rwy.headingDeg * Math.PI) / 180;
    const sinH = Math.sin(hdgRad);
    const cosH = Math.cos(hdgRad);

    // An aircraft landing on this runway flies *towards* the threshold on the
    // runway heading, so it sits on the far side of it: dot(rel, heading) is
    // negative on final. "along" is therefore the distance still to fly (PAR's
    // "miles from touchdown"), positive on approach and negative once over the
    // runway. "cross" is + to the right of the centreline from the pilot's seat.
    const along = -(off.east * sinH + off.north * cosH);
    const cross = off.east * cosH - off.north * sinH;

    const rangeNm = Math.hypot(off.east, off.north) / M_PER_NM;
    const altFt = t.altM !== undefined ? t.altM / M_PER_FT : null;
    const aboveThrFt = altFt !== null ? altFt - rwy.threshold.altFt : null;

    const azDevDeg = along > 50 ? (Math.atan2(cross, along) * 180) / Math.PI : 0;
    const elevDeg =
      along > 50 && aboveThrFt !== null ? (Math.atan2(aboveThrFt * M_PER_FT, along) * 180) / Math.PI : null;
    const gsDevDeg = elevDeg !== null ? elevDeg - rwy.glidepathDeg : null;
    const gpAltFt =
      along > 0
        ? Math.round((Math.tan((rwy.glidepathDeg * Math.PI) / 180) * along) / M_PER_FT + rwy.threshold.altFt)
        : null;

    const az = this.tuning.azToleranceDeg;
    const gs = this.tuning.gsToleranceDeg;

    return {
      rangeNm: round(rangeNm, 2),
      alongNm: round(along / M_PER_NM, 2),
      crossNm: round(cross / M_PER_NM, 3),
      azDevDeg: round(azDevDeg, 2),
      elevDeg: elevDeg !== null ? round(elevDeg, 2) : null,
      gsDevDeg: gsDevDeg !== null ? round(gsDevDeg, 2) : null,
      altFt: altFt !== null ? Math.round(altFt) : null,
      aboveThrFt: aboveThrFt !== null ? Math.round(aboveThrFt) : null,
      gpAltFt,
      onFinal: along > 50 && Math.abs(azDevDeg) < 30 && rangeNm < 25,
      guidance: guidanceText(azDevDeg, gsDevDeg, az, gs),
    };
  }

  snapshot(rwy) {
    this.prune();
    const tracks = [];
    let total = 0;

    for (const t of this.tracks.values()) {
      total++;
      if (!this.isAirborne(t)) continue;

      const altFt = t.altM !== undefined ? Math.round(t.altM / M_PER_FT) : null;
      const rec = {
        id: t.id,
        name: t.Name || 'Unknown',
        type: t.Type || '',
        category: t.category,
        pilot: t.Pilot || '',
        group: t.Group || '',
        coalition: t.Coalition || '',
        color: t.Color || '',
        lat: t.lat,
        lon: t.lon,
        u: t.u,
        v: t.v,
        altFt,
        hdg: t.hdg !== undefined ? Math.round(t.hdg) : t.trkDeg !== undefined ? Math.round(t.trkDeg) : null,
        gc: t.trkDeg !== undefined ? Math.round(t.trkDeg) : null, // ground course
        gsKt: t.gsMs !== undefined ? Math.round(t.gsMs * KT_PER_MS) : null,
        iasKt: numProp(t.IAS, KT_PER_MS),
        tasKt: numProp(t.TAS, KT_PER_MS),
        vsFpm: t.vsFpm !== undefined ? Math.round(t.vsFpm / 10) * 10 : null,
      };
      if (rwy) {
        rec.approach = this.computeApproach(t, rwy);
        if (rec.approach && rec.approach.aboveThrFt !== null) {
          rec.onGround = rec.approach.aboveThrFt < 50 && (rec.gsKt === null || rec.gsKt < 40);
        }
      }
      tracks.push(rec);
    }

    return {
      time: Date.now(),
      runway: rwy || null,
      tracks,
      counts: { aircraft: tracks.length, objects: total },
    };
  }
}

/** planar position in metres: DCS native coordinates, or a flat-earth stand-in */
function planar(t) {
  if (t.u !== undefined && t.v !== undefined) return { e: t.u, n: t.v };
  if (t.lat !== undefined && t.lon !== undefined) {
    return {
      e: t.lon * EARTH_M_PER_DEG * Math.cos((t.lat * Math.PI) / 180),
      n: t.lat * EARTH_M_PER_DEG,
    };
  }
  return null;
}

function numProp(v, factor) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : Math.round(n * factor);
}

function smooth(prev, next, alpha) {
  return prev === undefined ? next : prev + alpha * (next - prev);
}

function round(v, d) {
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

function normDeg(d) {
  return ((d % 360) + 360) % 360;
}

/** ACMI object types are '+' separated tag lists, e.g. 'Air+FixedWing' */
function categorize(type) {
  const tags = String(type || '').split('+');
  const has = (x) => tags.includes(x);
  if (has('FixedWing')) return 'FixedWing';
  if (has('Rotorcraft')) return 'Rotorcraft';
  if (has('Missile') || has('Bomb') || has('Rocket') || has('Projectile') || has('Shrapnel')) return 'Weapon';
  if (has('Flare') || has('Chaff') || has('Decoy')) return 'Countermeasure';
  if (has('Watercraft')) return 'Sea';
  if (has('Bullseye') || has('Waypoint') || has('Navaid')) return 'Navaid';
  if (has('Parachutist')) return 'Parachutist';
  if (has('Ground')) return 'Ground';
  return 'Other';
}

function guidanceText(azDev, gsDev, azTol, gsTol) {
  if (gsDev === null) return '';
  const parts = [];
  parts.push(Math.abs(azDev) < azTol ? 'ON COURSE' : azDev > 0 ? 'FLY LEFT' : 'FLY RIGHT');
  parts.push(Math.abs(gsDev) < gsTol ? 'ON GLIDEPATH' : gsDev > 0 ? 'COMING HIGH' : 'COMING LOW');
  return parts.join(' / ');
}

module.exports = { TrackStore, categorize };
