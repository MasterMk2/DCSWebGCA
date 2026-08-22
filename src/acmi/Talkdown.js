'use strict';

/**
 * Real-time PAR talk-down phrase generator.
 *
 * Produces controller-style precision approach messages for each aircraft
 * on final. A message is emitted when an aircraft first appears, when its
 * deviation state changes, or at least every 15 seconds.
 * State is tracked per runway so multiple controllers can talk aircraft
 * down to different runways independently.
 */

const M_PER_NM = 1852;
const FT_PER_M = 3.28084;

class Talkdown {
  constructor(cfg) {
    this.cfg = cfg;
    this.state = new Map(); // runwayId -> Map(trackId -> { lastMsgAt, lastKey })
  }

  resolveRunway(runwayId) {
    const g = this.cfg.gca;
    return (
      g.runways.find((r) => r.id === runwayId) ||
      g.runways.find((r) => r.id === g.defaultRunway) ||
      g.runways[0]
    );
  }

  /**
   * @param {Array} tracks snapshot tracks (with .approach computed for runwayId)
   * @param {string} runwayId selected runway id
   * @returns {Array<{time:number, id:string, text:string}>} new messages
   */
  update(tracks, runwayId) {
    const rwy = this.resolveRunway(runwayId);
    if (!rwy) return [];

    let rwyState = this.state.get(rwy.id);
    if (!rwyState) {
      rwyState = new Map();
      this.state.set(rwy.id, rwyState);
    }

    const now = Date.now();
    const msgs = [];
    const seen = new Set();

    for (const t of tracks) {
      if (!t.approach) continue;
      seen.add(t.id);

      const st = rwyState.get(t.id) || { lastMsgAt: 0, lastKey: '' };
      const key = guidanceKey(t.approach);
      const due = now - st.lastMsgAt >= 15000;
      const changed = key !== st.lastKey;

      if (!st.lastKey || due || changed) {
        msgs.push({ time: now, id: t.id, text: buildPhrase(t, t.approach, rwy) });
        st.lastMsgAt = now;
        st.lastKey = key;
        rwyState.set(t.id, st);
      }
    }

    // forget aircraft that left the scope
    for (const id of [...rwyState.keys()]) {
      if (!seen.has(id)) rwyState.delete(id);
    }
    return msgs;
  }
}

function guidanceKey(ap) {
  const az = Math.abs(ap.azDevDeg) < 0.8 ? 'OK' : ap.azDevDeg > 0 ? 'R' : 'L';
  const gs =
    ap.gsDevDeg === null ? '?' : Math.abs(ap.gsDevDeg) < 0.4 ? 'OK' : ap.gsDevDeg > 0 ? 'H' : 'LOW';
  const band = ap.rangeNm < 1 ? 'SHORT' : ap.rangeNm < 5 ? 'MID' : 'FAR';
  return az + '/' + gs + '/' + band;
}

function normDeg(d) {
  return ((d % 360) + 360) % 360;
}

function buildPhrase(t, ap, rwy) {
  const cs = t.pilot || t.name || t.id;
  const parts = [`${cs}, ${ap.rangeNm.toFixed(1)} miles from touchdown`];

  // lateral guidance
  if (Math.abs(ap.azDevDeg) < 0.8) {
    parts.push('on course');
  } else {
    const corr = Math.max(3, Math.min(30, Math.abs(ap.azDevDeg) * 3));
    const newHdg = Math.round(normDeg(rwy.headingDeg + (ap.azDevDeg > 0 ? -corr : corr)) / 5) * 5;
    parts.push(
      `${ap.azDevDeg > 0 ? 'right' : 'left'} of course, turn heading ${String(normDeg(newHdg)).padStart(3, '0')}`
    );
  }

  // vertical guidance
  if (ap.gsDevDeg === null) {
    parts.push('report altitude');
  } else if (Math.abs(ap.gsDevDeg) < 0.4) {
    parts.push('on glidepath');
  } else {
    const alongM = ap.alongNm * M_PER_NM;
    const shouldFt =
      Math.round(
        (Math.tan((rwy.glidepathDeg * Math.PI) / 180) * alongM * FT_PER_M + rwy.threshold.altFt) / 100
      ) * 100;
    parts.push(`coming ${ap.gsDevDeg > 0 ? 'high' : 'low'}, altitude should be ${shouldFt} feet`);
  }

  // short-final calls
  if (ap.rangeNm < 0.5) parts.push('over threshold, check runway in sight');
  else if (ap.rangeNm < 1) parts.push('one mile, runway should be in sight');

  return parts.join(', ') + '.';
}

module.exports = { Talkdown };
