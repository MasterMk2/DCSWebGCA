'use strict';

// ACMI is a delta protocol: silence alone is not a fault. Retain only the
// identity and position needed to compare a quiet player aircraft with a fresh
// snapshot. Never substitute snapshot data into the live world or invent motion.
const POSITION_KEYS = ['u', 'v', 'lon', 'lat', 'altM'];
const IDENTITY_KEYS = ['Type', 'Pilot', 'Name'];
const MAX_RECORDS = 2048;
const RETAIN_MS = 3600000;
const MAX_CANDIDATES = 128;

function mergeSample(target, props) {
  for (const key of IDENTITY_KEYS) {
    if (props[key] !== undefined) target[key] = props[key];
  }
  for (const key of POSITION_KEYS) {
    if (Number.isFinite(props[key])) target[key] = props[key];
  }
}

function hasPosition(p) {
  return (Number.isFinite(p.u) && Number.isFinite(p.v)) ||
    (Number.isFinite(p.lon) && Number.isFinite(p.lat));
}

function isPlayerAircraft(p) {
  const tags = String(p.Type || '').split('+');
  return !!String(p.Pilot || '').trim() &&
    (tags.includes('FixedWing') || tags.includes('Rotorcraft'));
}

function positionDiffers(a, b) {
  let distance;
  if ([a.u, a.v, b.u, b.v].every(Number.isFinite)) {
    distance = Math.hypot(a.u - b.u, a.v - b.v);
  } else if ([a.lon, a.lat, b.lon, b.lat].every(Number.isFinite)) {
    distance = Math.hypot(
      (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180),
      (a.lat - b.lat) * 111320
    );
  } else {
    return false;
  }
  return distance > 1 || (Number.isFinite(a.altM) && Number.isFinite(b.altM) && Math.abs(a.altM - b.altM) > 1);
}

class AircraftFreshness {
  constructor() {
    this.records = new Map();
  }

  clear() { this.records.clear(); }
  remove(id) { this.records.delete(id); }

  update({ id, props }, now) {
    let record = this.records.get(id);
    if (!record) {
      // Ignore ground clutter and position-only deltas until aircraft identity
      // arrives. Type and Pilot can arrive separately, in either order.
      const tags = String(props.Type || '').split('+');
      if (!String(props.Pilot || '').trim() && !tags.includes('FixedWing') && !tags.includes('Rotorcraft')) return;
      // Full identity can be split over several updates. Bound even those
      // provisional entries, without evicting an active player for clutter.
      if (this.records.size >= MAX_RECORDS) this.prune(now);
      if (this.records.size >= MAX_RECORDS) return;
      record = { sample: {}, revision: 0, lastSeenAt: now, positionAt: null, checkedAt: 0 };
      this.records.set(id, record);
    }
    mergeSample(record.sample, props);
    record.lastSeenAt = now;
    if ([...POSITION_KEYS, ...IDENTITY_KEYS].some((key) => props[key] !== undefined)) record.revision++;
    if (POSITION_KEYS.some((key) => Number.isFinite(props[key]))) record.positionAt = now;
  }

  prune(now) {
    for (const [id, r] of this.records) {
      if (now - r.lastSeenAt > RETAIN_MS) this.records.delete(id);
    }
  }

  candidates(now, staleAfterMs) {
    this.prune(now);
    return [...this.records]
      .filter(([, r]) => isPlayerAircraft(r.sample) && hasPosition(r.sample) &&
        r.positionAt !== null && now - r.positionAt >= staleAfterMs)
      .sort((a, b) => a[1].checkedAt - b[1].checkedAt)
      .slice(0, MAX_CANDIDATES)
      .map(([id, r]) => {
        r.checkedAt = now;
        // Retain the record identity too: removal/reuse cannot match revision 1.
        return { id, record: r, revision: r.revision, sample: { ...r.sample } };
      });
  }

  confirmsDrift(candidate, fresh) {
    const current = this.records.get(candidate.id);
    return current === candidate.record && current.revision === candidate.revision &&
      IDENTITY_KEYS.every((key) => (candidate.sample[key] || '') === (fresh[key] || '')) &&
      hasPosition(fresh) && positionDiffers(candidate.sample, fresh);
  }
}

module.exports = { AircraftFreshness, mergeSample, MAX_RECORDS, MAX_CANDIDATES };
