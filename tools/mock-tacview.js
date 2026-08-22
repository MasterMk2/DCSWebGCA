'use strict';

/**
 * Mock Tacview real-time server for local development.
 * Emits a synthetic ACMI 2.2 stream with an aircraft flying a precision
 * approach to the first runway defined in the config.
 *
 * Faithful to the real protocol:
 * - XtraLib handshake reply
 * - ReferenceLongitude/Latitude globals with RELATIVE lon/lat in transforms
 * - 9-field transform form including U/V meters (u = DCS z = east,
 *   v = DCS x = north)
 * - DCS-style types ("Air+FixedWing") and NO IAS/TAS properties
 *
 * Usage:  node tools/mock-tacview.js   (listens on 127.0.0.1:34251)
 * Then:   TACVIEW_PORT=34251 npm start
 */

const net = require('net');

const { load } = require('../src/config');

const cfg = load();
const rwy = cfg.gca.runways[0];
const PORT = process.env.MOCK_PORT || 34251;

const M_PER_FT = 0.3048;
const EARTH_M_PER_DEG = 111320;
const M_PER_NM = 1852;

const REF_LAT = rwy.threshold.lat;
const REF_LON = rwy.threshold.lon;
const COS_REF = Math.cos((REF_LAT * Math.PI) / 180);

function positionAt(alongNm, crossNm, gsDevDeg) {
  const alongM = alongNm * M_PER_NM;
  const crossM = crossNm * M_PER_NM;
  const hdgRad = (rwy.headingDeg * Math.PI) / 180;
  const x = alongM * Math.sin(hdgRad) + crossM * Math.cos(hdgRad); // east
  const y = alongM * Math.cos(hdgRad) - crossM * Math.sin(hdgRad); // north

  const altM =
    rwy.threshold.altFt * M_PER_FT +
    Math.tan(((rwy.glidepathDeg + gsDevDeg) * Math.PI) / 180) * alongM;

  // coordinates RELATIVE to the reference point (as real Tacview exports)
  const relLat = y / EARTH_M_PER_DEG;
  const relLon = x / (EARTH_M_PER_DEG * COS_REF);

  return { relLat, relLon, altM, u: x, v: y }; // u = east, v = north
}

function transform(p, roll, pitch, hdg) {
  return `T=${p.relLon.toFixed(7)},${p.relLat.toFixed(7)},${p.altM.toFixed(1)},${roll},${pitch},${hdg.toFixed(1)},${p.u.toFixed(1)},${p.v.toFixed(1)},${hdg.toFixed(1)}`;
}

const server = net.createServer((socket) => {
  console.log('[mock] client connected');

  let handshaken = false;
  socket.on('data', (chunk) => {
    if (handshaken) return;
    handshaken = true;
    console.log('[mock] handshake received, replying as host');
    socket.write('XtraLib.Stream.0\nTacview.RealTimeTelemetry.0\nDCSWebGCA-mock\n\0');
  });

  socket.write('V2.2\n');
  socket.write(`ReferenceLongitude=${REF_LON}\n`);
  socket.write(`ReferenceLatitude=${REF_LAT}\n`);
  socket.write('ReferenceTime=2026-01-01T00:00:00Z\n');
  socket.write('DataSource=DCS Web GCA mock\n');

  let t = 0;
  const timer = setInterval(() => {
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
    socket.write(
      `T=1|${transform(p, 0, 4, hdg)}|Name=F/A-18C|Type=Air+FixedWing|Pilot=Viper-1\n`
    );

    // A second aircraft holding off to the side
    const p2 = positionAt(6 + 2 * Math.sin(t / 30), -2.5, 0);
    socket.write(
      `T=2|${transform(p2, 0, 10, rwy.headingDeg + 90)}|Name=F-16C|Type=Air+FixedWing|Pilot=Falcon-2\n`
    );

    // Ground object at the field
    socket.write(
      `T=3|T=0,0,${(rwy.threshold.altFt * M_PER_FT).toFixed(1)},0,0,${rwy.headingDeg.toFixed(1)},0,0,${rwy.headingDeg.toFixed(1)}|Name=Tower|Type=Ground+Static\n`
    );
  }, 100);

  socket.on('close', () => {
    console.log('[mock] client disconnected');
    clearInterval(timer);
  });
  socket.on('error', () => {});
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] Tacview simulator on tcp://127.0.0.1:${PORT} (runway: ${rwy.id})`);
  console.log('[mock] start the GCA server with: TACVIEW_PORT=' + PORT + ' npm start');
});
