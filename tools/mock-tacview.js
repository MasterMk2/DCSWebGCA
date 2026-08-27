'use strict';

/**
 * Mock Tacview real-time server for local development.
 * Emits a synthetic ACMI 2.2 stream with an aircraft flying a precision
 * approach to the first runway defined in the config, plus a carrier (Sea
 * track) with its own F/A-18C on a 3-degree glideslope so the LSO mode can
 * be exercised without DCS. Two static bullseyes (one per coalition) are sent
 * once with the initial world state, as the real host does.
 *
 * Faithful to the real protocol:
 * - XtraLib handshake reply; streaming starts only AFTER the handshake
 * - global properties on object id 0, comma separated
 * - object updates: <id>,T=pipe|separated|transform,Type=...,Name=...
 * - ReferenceLongitude/Latitude globals with RELATIVE lon/lat in transforms
 * - 9-field transform form including U/V meters (u = DCS z = east,
 *   v = DCS x = north)
 * - DCS-style types ("Air+FixedWing", "Sea+Watercraft") and NO IAS/TAS
 *
 * Passwords:
 * - MOCK_PASSWORD unset: open host, any client is accepted (as before)
 * - MOCK_PASSWORD set:   the password line of the client handshake must match,
 *                        otherwise the connection is dropped before streaming
 *
 * Usage:  node tools/mock-tacview.js   (listens on 127.0.0.1:34251)
 * Then:   TACVIEW_PORT=34251 npm start
 */

const net = require('net');

const { load } = require('../src/config');

const cfg = load();
const srcCfg = (cfg.sources && cfg.sources[0]) || {};
const rwy = (srcCfg.runways && srcCfg.runways[0]) || {
  id: 'MOCK RWY',
  threshold: { lat: 36.0, lon: 140.0, altFt: 100 },
  headingDeg: 210,
  glidepathDeg: 3.0,
  lengthNm: 1.2,
};
const PORT = process.env.MOCK_PORT || 34251;
const MOCK_PASSWORD = process.env.MOCK_PASSWORD !== undefined ? process.env.MOCK_PASSWORD : '';

const M_PER_FT = 0.3048;
const EARTH_M_PER_DEG = 111320;
const M_PER_NM = 1852;

// --- Carrier scenario (LSO mode) -----------------------------------------
// The carrier sits on the extended centreline a few miles past the field,
// steaming into the same wind as the runway, so its recovery course equals
// the runway heading and both approaches share one reference point.
const CARRIER = {
  name: 'CVN-71',
  hdgDeg: rwy.headingDeg,
  aheadNm: 5, // downrange of the threshold, on the centreline
  speedMs: (12 * M_PER_NM) / 3600, // 12 kt headway: nearly stationary
};
const CAR_HDG_RAD = (CARRIER.hdgDeg * Math.PI) / 180;
const CAR_SIN = Math.sin(CAR_HDG_RAD);
const CAR_COS = Math.cos(CAR_HDG_RAD);
// heading unit vector in (east, north); deck at sea level
const CAR_U0 = CARRIER.aheadNm * M_PER_NM * CAR_SIN;
const CAR_V0 = CARRIER.aheadNm * M_PER_NM * CAR_COS;
const LSO_START_NM = 5; // initial distance astern of the carrier
const LSO_DECK_ALT_M = 0;

const REF_LAT = rwy.threshold.lat;
const REF_LON = rwy.threshold.lon;
const COS_REF = Math.cos((REF_LAT * Math.PI) / 180);

function positionAt(alongNm, crossNm, gsDevDeg) {
  const alongM = alongNm * M_PER_NM;
  const crossM = crossNm * M_PER_NM;
  const hdgRad = (rwy.headingDeg * Math.PI) / 180;
  // aircraft starts BEHIND the threshold (opposite of landing direction)
  // and flies toward it on the landing heading
  const x = -alongM * Math.sin(hdgRad) + crossM * Math.cos(hdgRad); // east
  const y = -alongM * Math.cos(hdgRad) - crossM * Math.sin(hdgRad); // north

  const altM =
    rwy.threshold.altFt * M_PER_FT +
    Math.tan(((rwy.glidepathDeg + gsDevDeg) * Math.PI) / 180) * alongM;

  // coordinates RELATIVE to the reference point (as real Tacview exports)
  const relLat = y / EARTH_M_PER_DEG;
  const relLon = x / (EARTH_M_PER_DEG * COS_REF);

  return { relLat, relLon, altM, u: x, v: y }; // u = east, v = north
}

/** position on the carrier glideslope, `asternNm` behind the deck */
function carrierApproachAt(asternNm, crossNm, gsDevDeg) {
  const asternM = asternNm * M_PER_NM;
  const crossM = crossNm * M_PER_NM;
  const x = CAR_U0 - asternM * CAR_SIN + crossM * CAR_COS; // east
  const y = CAR_V0 - asternM * CAR_COS - crossM * CAR_SIN; // north
  const altM =
    LSO_DECK_ALT_M +
    Math.tan(((3.0 + gsDevDeg) * Math.PI) / 180) * asternM;
  const relLat = y / EARTH_M_PER_DEG;
  const relLon = x / (EARTH_M_PER_DEG * COS_REF);
  return { relLat, relLon, altM, u: x, v: y };
}

/** static reference point `distNm` from the threshold on true bearing `brgDeg` */
function referencePoint(brgDeg, distNm) {
  const r = (brgDeg * Math.PI) / 180;
  const x = distNm * M_PER_NM * Math.sin(r); // east
  const y = distNm * M_PER_NM * Math.cos(r); // north
  return { relLat: y / EARTH_M_PER_DEG, relLon: x / (EARTH_M_PER_DEG * COS_REF), altM: 0, u: x, v: y };
}

function transform(p, roll, pitch, hdg) {
  // transform sub-fields are PIPE separated on the wire
  return `T=${p.relLon.toFixed(7)}|${p.relLat.toFixed(7)}|${p.altM.toFixed(1)}|${roll}|${pitch}|${hdg.toFixed(1)}|${p.u.toFixed(1)}|${p.v.toFixed(1)}|${hdg.toFixed(1)}`;
}

/** Split a NUL-terminated client handshake block into its four lines. */
function parseClientHandshake(text) {
  const lines = String(text).replace(/\0+$/, '').split('\n').map((s) => s.replace(/\r$/, ''));
  return {
    proto: lines[0] || '',
    stream: lines[1] || '',
    name: (lines[2] || '').trim(),
    password: lines.length > 3 ? lines[3] : '',
  };
}

/** Host-side password gate: empty expected password accepts everybody. */
function authorizeClient(hs, expectedPassword) {
  if (!expectedPassword) return { ok: true };
  return { ok: hs.password === expectedPassword };
}

function main() {
  const server = net.createServer((socket) => {
    console.log('[mock] client connected');

    let handshaken = false;
    let timer = null;
    let t = 0;
    let rxBuffer = '';

    // The real host only starts streaming after the client handshake; sending
    // the global header before it would make those lines part of the handshake
    // exchange and get them dropped by the client.
    socket.on('data', (chunk) => {
      if (handshaken) return;

      // With a password configured we must see the full NUL-terminated
      // handshake before deciding whether this client may stream at all.
      if (MOCK_PASSWORD) {
        rxBuffer += chunk.toString('utf8');
        const nul = rxBuffer.indexOf('\0');
        if (nul < 0) return;
        const hs = parseClientHandshake(rxBuffer.slice(0, nul));
        if (!authorizeClient(hs, MOCK_PASSWORD).ok) {
          console.log('[mock] handshake received: password mismatch, rejecting client');
          socket.destroy();
          return;
        }
        handshaken = true;
        console.log(`[mock] handshake received (client: ${hs.name}, password ok), replying as host`);
      } else {
        handshaken = true;
        console.log('[mock] handshake received, replying as host');
      }
      socket.write('XtraLib.Stream.0\nTacview.RealTimeTelemetry.0\nDCSWebGCA-mock\n\0');
      startStream();
    });

    function startStream() {
      socket.write('FileType=text/acmi/tacview\n');
      socket.write('FileVersion=2.2\n');
      // global properties belong to object id 0, comma separated
      socket.write(`0,ReferenceLongitude=${REF_LON}\n`);
      socket.write(`0,ReferenceLatitude=${REF_LAT}\n`);
      socket.write('0,ReferenceTime=2026-01-01T00:00:00Z\n');
      socket.write('0,DataSource=DCS Web GCA mock\n');

      // Bullseyes: one static reference point per coalition. Like the real
      // host, they go out once with the initial world state and are never
      // repeated, so the console has to remember them.
      socket.write(
        `90,${transform(referencePoint(0, 25), 0, 0, 0)},Type=Navaid+Static+Bullseye,Name=Bullseye,Color=Blue,Coalition=Allies\n`
      );
      socket.write(
        `91,${transform(referencePoint(180, 40), 0, 0, 0)},Type=Navaid+Static+Bullseye,Name=Bullseye,Color=Red,Coalition=Enemies\n`
      );

      timer = setInterval(streamFrame, 100);
    }

    function streamFrame() {
      t += 0.1;

      // Approach aircraft: 10 nm out, ~150 kt groundspeed, sinusoidal errors
      const alongNm = 10 - (t / 60) * 2.5; // 2.5 nm per minute
      const looped = ((alongNm % 10) + 10) % 10;
      const d = looped < 0.5 ? looped + 10 : looped; // wrap back to 10 nm
      const crossNm = 0.25 * Math.sin(t / 90);
      const gsDev = 0.35 * Math.sin(t / 140);

      const p = positionAt(d, crossNm, gsDev);
      const hdg = rwy.headingDeg + (crossNm > 0 ? -2 : 2);

      socket.write(`#${(1000 + t).toFixed(2)}\n`);
      // object updates: <id>,T=pipe|separated|transform,Type=...,Name=...,Pilot=...
      socket.write(
        `1,${transform(p, 0, 4, hdg)},Type=Air+FixedWing,Name=F/A-18C,Pilot=Viper-1\n`
      );

      // A second aircraft holding off to the side
      const p2 = positionAt(6 + 2 * Math.sin(t / 30), -2.5, 0);
      socket.write(
        `2,${transform(p2, 0, 10, rwy.headingDeg + 90)},Type=Air+FixedWing,Name=F-16C,Pilot=Falcon-2\n`
      );

      // Ground object at the field
      socket.write(
        `3,T=0|0|${(rwy.threshold.altFt * M_PER_FT).toFixed(1)}|0|0|${rwy.headingDeg.toFixed(1)}|0|0|${rwy.headingDeg.toFixed(1)},Name=Tower,Type=Ground+Static\n`
      );

      // Carrier: slow headway into the wind, deck at sea level
      const carDist = CARRIER.speedMs * t;
      const cu = CAR_U0 + carDist * CAR_SIN;
      const cv = CAR_V0 + carDist * CAR_COS;
      socket.write(
        `4,T=${(cu / (EARTH_M_PER_DEG * COS_REF)).toFixed(7)}|${(cv / EARTH_M_PER_DEG).toFixed(7)}|${LSO_DECK_ALT_M.toFixed(1)}|0|0|${CARRIER.hdgDeg.toFixed(1)}|${cu.toFixed(1)}|${cv.toFixed(1)}|${CARRIER.hdgDeg.toFixed(1)},Type=Sea+Watercraft,Name=${CARRIER.name}\n`
      );

      // Carrier approach aircraft: realistic recovery cycle with no teleport —
      // inbound on the 3-degree glideslope from 5 nm astern to the deck
      // (2 nm per minute), then outbound straight back out along the same line
      // and re-enter for another pass.
      const LSO_LEG_S = (LSO_START_NM / 2) * 60; // seconds per leg at 2 nm/min
      const cPhase = t % (2 * LSO_LEG_S);
      const outbound = cPhase >= LSO_LEG_S;
      const legT = outbound ? cPhase - LSO_LEG_S : cPhase;
      const asternNm = outbound
        ? (legT / 60) * 2 // climb back out astern of the deck
        : LSO_START_NM - (legT / 60) * 2; // ride the slope down to the deck
      const cCross = 0.08 * Math.sin(t / 70);
      const cGsDev = 0.3 * Math.sin(t / 110);
      const cp = carrierApproachAt(asternNm, cCross, cGsDev);
      const cHdg =
        CARRIER.hdgDeg + (outbound ? 180 : 0) + (cCross > 0 ? -2 : 2);
      socket.write(
        `5,${transform(cp, 0, 8, cHdg)},Type=Air+FixedWing,Name=F/A-18C,Pilot=Rag-1\n`
      );
    }

    socket.on('close', () => {
      console.log('[mock] client disconnected');
      if (timer) clearInterval(timer);
    });
    socket.on('error', () => {});
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[mock] Tacview simulator on tcp://127.0.0.1:${PORT} (runway: ${rwy.id})`);
    if (MOCK_PASSWORD) console.log('[mock] password protection: ON (MOCK_PASSWORD)');
    console.log('[mock] start the GCA server with: TACVIEW_PORT=' + PORT + ' npm start');
  });
}

if (require.main === module) main();

module.exports = { parseClientHandshake, authorizeClient };
