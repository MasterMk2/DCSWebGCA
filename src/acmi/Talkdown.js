'use strict';

/**
 * Real-time PAR talk-down phrase generator.
 *
 * Produces controller-style precision approach messages with graduated
 * phraseology actually used on PAR frequencies:
 *
 *   lateral: on course / slightly right of course / right of course /
 *            well right of course (+ turn heading)
 *   vertical: on glidepath / slightly high / high / well high
 *             (each with the expected altitude readout)
 *
 * A message is emitted when an aircraft first appears, when its deviation
 * state changes, or at least every 15 seconds.
 * State is tracked per runway so multiple controllers can talk aircraft
 * down to different runways independently.
 */

const M_PER_NM = 1852;
const FT_PER_M = 3.28084;

/**
 * Phrase templates. Override any of them through config:
 *
 *   "gca": {
 *     "phrases": {
 *       "onCourse": "{callsign}、コース上です",
 *       ...
 *     }
 *   }
 *
 * Placeholders: {callsign} {range} {side} {other} {heading} {dir}
 *               {intensity} {altitude} {verb}
 */
const DEFAULT_PHRASES = {
  intro: '{callsign}, {range} miles from touchdown',
  onCourse: 'on course',
  slightlyOffCourse: 'slightly {side} of course, correct {other}',
  offCourse: '{intensity}{side} of course, turn heading {heading}',
  reportAltitude: 'report altitude',
  onGlidepath: 'on glidepath',
  offGlidepathHigh: '{intensity}high, descend and maintain {altitude} feet',
  offGlidepathLow: '{intensity}low, climb and maintain {altitude} feet',
  overThreshold: 'over threshold, check runway in sight',
  oneMile: 'one mile, runway should be in sight',
};

class Talkdown {
  constructor(cfg) {
    this.cfg = cfg;
    this.intervalMs = ((cfg.gca && cfg.gca.talkdownIntervalSec) || 15) * 1000;
    this.maxRangeNm = (cfg.gca && cfg.gca.talkdownMaxRangeNm) || 12;
    this.phrases = Object.assign({}, DEFAULT_PHRASES, (cfg.gca && cfg.gca.phrases) || {});
    this.state = new Map(); // runwayId -> Map(trackId -> { lastMsgAt, lastKey })
  }

  /** Render a template with placeholder substitution. */
  t(key, vars) {
    return String(this.phrases[key] || DEFAULT_PHRASES[key] || key).replace(
      /\{(\w+)\}/g,
      (_, name) => (vars[name] !== undefined ? vars[name] : `{${name}}`)
    );
  }

  /**
   * Accepts either a resolved runway object (preferred, as passed by
   * DcsSource) or a runway id looked up in cfg.gca.runways.
   */
  resolveRunway(runway) {
    if (runway && typeof runway === 'object') return runway;
    const g = this.cfg.gca || {};
    const runways = g.runways || [];
    return runways.find((r) => r.id === runway) || null;
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
      const ap = t.approach;
      // Only aircraft actually established on final get talked down: a tanker
      // orbiting 80 nm away would otherwise be told it is "well right of course".
      if (!ap || ap.onFinal === false || t.onGround) continue;
      if (ap.rangeNm > this.maxRangeNm) continue;
      seen.add(t.id);

      const st = rwyState.get(t.id) || { lastMsgAt: 0, lastKey: '' };
      const key = guidanceKey(ap);
      const due = now - st.lastMsgAt >= this.intervalMs;
      const changed = key !== st.lastKey;

      if (!st.lastKey || due || changed) {
        msgs.push({ time: now, id: t.id, text: this.buildPhrase(t, t.approach, rwy) });
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

/** Replace {placeholder} tokens from a vars object. */
function renderTemplate(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (_, name) =>
    vars[name] !== undefined ? String(vars[name]) : `{${name}}`
  );
}

Talkdown.prototype.buildPhrase = function (t, ap, rwy) {
  const P = this.phrases;
  const parts = [
    renderTemplate(P.intro, { callsign: t.pilot || t.name || t.id, range: ap.rangeNm.toFixed(1) }),
  ];

  // ---- lateral guidance (graduated PAR phraseology) ----
  const a = Math.abs(ap.azDevDeg);
  const side = ap.azDevDeg > 0 ? 'right' : 'left';
  const other = side === 'right' ? 'left' : 'right';

  if (a < 0.3) {
    parts.push(renderTemplate(P.onCourse, {}));
  } else if (a < 1.5) {
    parts.push(renderTemplate(P.slightlyOffCourse, { side, other }));
  } else {
    const intensity = a >= 3 ? 'well ' : '';
    const corr = Math.max(5, Math.min(30, a * 3));
    const heading = String(
      Math.round(normDeg(rwy.headingDeg + (ap.azDevDeg > 0 ? -corr : corr)) / 5) * 5
    ).padStart(3, '0');
    parts.push(renderTemplate(P.offCourse, { intensity, side, heading }));
  }

  // ---- vertical guidance (graduated PAR phraseology) ----
  if (ap.gsDevDeg === null) {
    parts.push(renderTemplate(P.reportAltitude, {}));
  } else {
    const g = Math.abs(ap.gsDevDeg);
    if (g < 0.2) {
      parts.push(renderTemplate(P.onGlidepath, {}));
    } else {
      const dir = ap.gsDevDeg > 0 ? 'high' : 'low';
      const intensity = g >= 1.5 ? 'well ' : g >= 0.7 ? '' : 'slightly ';
      const alongM = ap.alongNm * M_PER_NM;
      const altitude =
        Math.round(
          (Math.tan((rwy.glidepathDeg * Math.PI) / 180) * alongM * FT_PER_M + rwy.threshold.altFt) / 100
        ) * 100;
      const verb = dir === 'high' ? 'descend' : 'climb';
      parts.push(renderTemplate(dir === 'high' ? P.offGlidepathHigh : P.offGlidepathLow, { intensity, altitude, verb }));
    }
  }

  // ---- short-final calls ----
  if (ap.rangeNm < 0.5) parts.push(renderTemplate(P.overThreshold, {}));
  else if (ap.rangeNm < 1) parts.push(renderTemplate(P.oneMile, {}));

  return parts.join(', ') + '.';
};

module.exports = { Talkdown };
