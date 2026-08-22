'use strict';

/**
 * Real-time PAR talk-down phrase generator.
 *
 * Produces controller-style precision approach calls for aircraft on final:
 *
 *   "Viper-1, 5.2 miles from touchdown, slightly right of course,
 *    turn heading 205, coming high, altitude should be 1900 feet."
 *
 * A call is emitted when an aircraft joins final, when its deviation state
 * changes, or every `intervalMs` while it is being talked down.
 */

class Talkdown {
  constructor(cfg) {
    this.cfg = cfg;
    this.intervalMs = (cfg.gca.talkdownIntervalSec || 15) * 1000;
    this.maxRangeNm = cfg.gca.talkdownMaxRangeNm || 12;
    this.state = new Map(); // track id -> { lastMsgAt, lastKey }
  }

  /**
   * @param {Array} tracks snapshot tracks (with .approach computed)
   * @param {Object} rwy   runway definition the snapshot was computed against
   * @returns {Array<{time:number, id:string, text:string}>} new messages
   */
  update(tracks, rwy) {
    if (!rwy) return [];
    const now = Date.now();
    const msgs = [];
    const seen = new Set();

    for (const t of tracks) {
      const ap = t.approach;
      if (!ap || !ap.onFinal || t.onGround) continue;
      if (ap.rangeNm > this.maxRangeNm) continue;
      seen.add(t.id);

      const st = this.state.get(t.id) || { lastMsgAt: 0, lastKey: '' };
      const key = guidanceKey(ap, this.cfg.gca);
      const due = now - st.lastMsgAt >= this.intervalMs;

      if (!st.lastKey || due || key !== st.lastKey) {
        msgs.push({ time: now, id: t.id, text: buildPhrase(t, ap, rwy) });
        st.lastMsgAt = now;
        st.lastKey = key;
        this.state.set(t.id, st);
      }
    }

    for (const id of [...this.state.keys()]) {
      if (!seen.has(id)) this.state.delete(id);
    }
    return msgs;
  }
}

function guidanceKey(ap, gca) {
  const az = Math.abs(ap.azDevDeg) < gca.azToleranceDeg ? 'OK' : ap.azDevDeg > 0 ? 'R' : 'L';
  const gs =
    ap.gsDevDeg === null ? '?' : Math.abs(ap.gsDevDeg) < gca.gsToleranceDeg ? 'OK' : ap.gsDevDeg > 0 ? 'H' : 'LOW';
  const band = ap.rangeNm < 1 ? 'SHORT' : ap.rangeNm < 5 ? 'MID' : 'FAR';
  return az + '/' + gs + '/' + band;
}

function normDeg(d) {
  return ((d % 360) + 360) % 360;
}

function buildPhrase(t, ap, rwy) {
  const cs = t.pilot || t.name || t.id;
  const parts = [`${cs}, ${ap.rangeNm.toFixed(1)} miles from touchdown`];

  if (Math.abs(ap.azDevDeg) < 0.8) {
    parts.push('on course');
  } else {
    const corr = Math.max(3, Math.min(30, Math.abs(ap.azDevDeg) * 3));
    const newHdg = Math.round(normDeg(rwy.headingDeg + (ap.azDevDeg > 0 ? -corr : corr)) / 5) * 5;
    parts.push(
      `${ap.azDevDeg > 0 ? 'right' : 'left'} of course, turn heading ${String(normDeg(newHdg)).padStart(3, '0')}`
    );
  }

  if (ap.gsDevDeg === null) {
    parts.push('report altitude');
  } else if (Math.abs(ap.gsDevDeg) < 0.4) {
    parts.push('on glidepath');
  } else {
    const shouldFt = ap.gpAltFt !== null ? Math.round(ap.gpAltFt / 100) * 100 : null;
    parts.push(
      `coming ${ap.gsDevDeg > 0 ? 'high' : 'low'}` + (shouldFt !== null ? `, altitude should be ${shouldFt} feet` : '')
    );
  }

  if (ap.rangeNm < 0.5) parts.push('over threshold, check runway in sight');
  else if (ap.rangeNm < 1) parts.push('one mile, runway should be in sight');

  return parts.join(', ') + '.';
}

module.exports = { Talkdown };
