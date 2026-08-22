'use strict';

/**
 * Mock Tacview real-time server for local development and CI.
 *
 * It speaks the same protocol DCS does — the XtraLib handshake followed by an
 * ACMI 2.2 text stream in the real on-the-wire shape (`id,T=lon|lat|alt|...`,
 * coordinates relative to the ReferenceLatitude/Longitude header) — so running
 * against it actually exercises the parser rather than a private dialect.
 *
 * Usage:  node tools/mock-tacview.js        (listens on 127.0.0.1:34251)
 * Then:   TACVIEW_PORT=34251 npm start
 */

const net = require('net');
const { load } = require('../src/config');

const cfg = load();
const rwy =
  (cfg.sources[0].runways && cfg.sources[0].runways[0]) || {
    id: 'Nellis 21L',
    threshold: { lat: 36.2377, lon: -115.0345, altFt: 1870 },
    headingDeg: 210,
    glidepathDeg: 3.0,
  };

const PORT = parseInt(process.env.MOCK_PORT || '34251', 10);
const M_PER_FT = 0.3048;
const M_PER_NM = 1852;
const EARTH_M_PER_DEG = 111320;

const REF_LAT = Math.floor(rwy.threshold.lat);
const REF_LON = Math.floor(rwy.threshold.lon);

/**
 * Position an aircraft `alongNm` before the threshold on final, `crossNm` to
 * the right of the centreline. Traffic on approach is on the *far* side of the
 * threshold from the runway, i.e. opposite the landing heading.
 */
function positionAt(alongNm, crossNm, gsDevDeg, extraAltM = 0) {
  const alongM = alongNm * M_PER_NM;
  const crossM = crossNm * M_PER_NM;
  const hdgRad = (rwy.headingDeg * Math.PI) / 180;
  const east = -alongM * Math.sin(hdgRad) + crossM * Math.cos(hdgRad);
  const north = -alongM * Math.cos(hdgRad) - crossM * Math.sin(hdgRad);

  const altM =
    rwy.threshold.altFt * M_PER_FT +
    Math.tan(((rwy.glidepathDeg + gsDevDeg) * Math.PI) / 180) * alongM +
    extraAltM;

  const lat = rwy.threshold.lat + north / EARTH_M_PER_DEG;
  const lon = rwy.threshold.lon + east / (EARTH_M_PER_DEG * Math.cos((rwy.threshold.lat * Math.PI) / 180));
  return { lat, lon, altM };
}

/** 9-field transform with the native u/v left empty, as a lat/lon-only exporter would send it */
function transform(p, hdg) {
  return [
    (p.lon - REF_LON).toFixed(7),
    (p.lat - REF_LAT).toFixed(7),
    p.altM.toFixed(2),
    '',
    '',
    hdg.toFixed(1),
    '',
    '',
    hdg.toFixed(1),
  ].join('|');
}

const server = net.createServer((socket) => {
  let handshakeDone = false;
  let timer = null;

  socket.on('data', (chunk) => {
    if (handshakeDone) return;
    if (chunk.indexOf(0) < 0) return;
    handshakeDone = true;
    console.log('[mock] client connected');

    socket.write('XtraLib.Stream.0\nTacview.RealTimeTelemetry.0\nMockServer\n\0');
    socket.write('FileType=text/acmi/tacview\nFileVersion=2.2\n');
    socket.write('0,ReferenceTime=2026-01-01T00:00:00Z\n');
    socket.write(`0,ReferenceLatitude=${REF_LAT}\n0,ReferenceLongitude=${REF_LON}\n`);
    socket.write('0,Title=DCS Web GCA mock\n0,DataSource=mock-tacview\n');

    let t = 0;
    timer = setInterval(() => {
      t += 0.1;

      // #1 aircraft flying a wandering precision approach, looping 10 nm -> 0.5 nm
      const along = 10 - (((t / 60) * 2.5) % 9.5);
      const cross = 0.25 * Math.sin(t / 9);
      const gsDev = 0.35 * Math.sin(t / 14);
      const p1 = positionAt(along, cross, gsDev);
      const hdg1 = rwy.headingDeg + (cross > 0 ? -2 : 2); // correcting back to centreline

      // #2 aircraft holding off to the side
      const p2 = positionAt(6 + 2 * Math.sin(t / 30), -2.5, 0, 600);

      socket.write(`#${(1000 + t).toFixed(2)}\n`);
      socket.write(
        `1001,T=${transform(p1, hdg1)},Type=Air+FixedWing,Name=F/A-18C,Pilot=Viper-1,Group=Viper,` +
          `Coalition=Enemies,Color=Blue,IAS=${(140 + 8 * Math.sin(t / 5)) * 0.514444}\n`
      );
      socket.write(
        `1002,T=${transform(p2, rwy.headingDeg + 90)},Type=Air+FixedWing,Name=F-16C,Pilot=Falcon-2,` +
          `Group=Falcon,Coalition=Enemies,Color=Blue,IAS=${250 * 0.514444}\n`
      );
      // ground clutter: must be filtered out of the console
      socket.write(
        `2001,T=${transform(positionAt(0, 0, 0), 0)},Type=Ground+Static+Aerodrome,Name=Tower\n`
      );
    }, 100);
  });

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  socket.on('close', () => {
    stop();
    console.log('[mock] client disconnected');
  });
  socket.on('error', stop);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] Tacview simulator on tcp://127.0.0.1:${PORT} (runway: ${rwy.id})`);
  console.log(`[mock] start the GCA server with: TACVIEW_PORT=${PORT} npm start`);
});
