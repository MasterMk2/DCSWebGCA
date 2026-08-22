'use strict';

/**
 * Unit checks for the ACMI parser and the approach maths, using lines captured
 * verbatim from a DCS 2.9 / Tacview 1.9.5 real-time stream.
 *
 * Run: npm run test:parser
 */

const assert = require('assert');
const { AcmiParser } = require('../src/acmi/AcmiParser');
const { TrackStore } = require('../src/acmi/TrackStore');

const CFG = {
  gca: { staleAfterSec: 15, azToleranceDeg: 0.8, gsToleranceDeg: 0.4 },
};

function collect(lines) {
  const parser = new AcmiParser();
  const objects = [];
  const removed = [];
  const globals = {};
  parser.on('object', (o) => objects.push(o));
  parser.on('remove', (id) => removed.push(id));
  parser.on('global', (k, v) => (globals[k] = v));
  for (const l of lines) parser.handleLine(l);
  return { objects, removed, globals };
}

/* ---------- 1. header + reference-relative coordinates ---------- */
{
  const { objects, globals } = collect([
    'FileType=text/acmi/tacview',
    'FileVersion=2.2',
    '0,ReferenceTime=2026-06-11T04:30:00Z',
    '0,ReferenceLongitude=36',
    '0,ReferenceLatitude=38',
    '#36568.57',
    '29502,T=5.6099836|3.6065419|12.36||-1.5|312|618233.5|-356068.59|306.2,Type=Air+FixedWing,Name=Su-27,Pilot=Aerial-2-1',
  ]);
  assert.strictEqual(globals.ReferenceLatitude, '38');
  assert.strictEqual(objects.length, 1);
  const p = objects[0].props;
  assert.strictEqual(objects[0].id, '29502');
  assert.ok(Math.abs(p.lon - 41.6099836) < 1e-6, 'longitude is reference + relative');
  assert.ok(Math.abs(p.lat - 41.6065419) < 1e-6, 'latitude is reference + relative');
  assert.strictEqual(p.altM, 12.36);
  assert.strictEqual(p.u, 618233.5, 'u = DCS z (east)');
  assert.strictEqual(p.v, -356068.59, 'v = DCS x (north)');
  assert.strictEqual(p.hdg, 306.2);
  assert.strictEqual(p.Type, 'Air+FixedWing');
  assert.strictEqual(p.Pilot, 'Aerial-2-1');
  console.log('ok  header / reference-relative coordinates / 9-field transform');
}

/* ---------- 2. the 5-field transform is not the 9-field one ---------- */
{
  const { objects } = collect(['29502,T=4.7366215|3.5748864||545691.5|-366535.78']);
  const p = objects[0].props;
  assert.strictEqual(p.u, 545691.5, '5-field transform: field 4 is u, not roll');
  assert.strictEqual(p.v, -366535.78, '5-field transform: field 5 is v, not pitch');
  assert.strictEqual(p.roll, undefined);
  assert.strictEqual(p.altM, undefined, 'empty field means unchanged');
  console.log('ok  5-field transform mapping');
}

/* ---------- 3. escaped commas and continued lines ---------- */
{
  const { objects, globals } = collect([
    '0,Comments=line one\\',
    'line two\\, still line two',
    '3001,Type=Ground+Static+Aerodrome,Name=Invisible FARP,Country=xb',
  ]);
  assert.ok(globals.Comments.includes('line two, still line two'), 'escaped comma stays in the value');
  assert.strictEqual(objects.length, 1);
  assert.strictEqual(objects[0].props.Name, 'Invisible FARP');
  console.log('ok  escaped commas / multi-line values');
}

/* ---------- 4. removals ---------- */
{
  const { removed } = collect(['-29502', '-1f02']);
  assert.deepStrictEqual(removed, ['29502', '1f02']);
  console.log('ok  object removal');
}

/* ---------- 5. approach geometry against a DCS runway ---------- */
{
  const store = new TrackStore(CFG);
  // Batumi RWY 31 as DCSServerBot reports it: centre x=-355810.7 z=617386.2,
  // course 0.95013 rad -> true heading 305.56, length 2070 m.
  const headingDeg = 305.56;
  const hRad = (headingDeg * Math.PI) / 180;
  const thr = {
    x: -355810.6875 - Math.cos(hRad) * 1035,
    z: 617386.1875 - Math.sin(hRad) * 1035,
    altFt: 33,
  };
  const rwy = { id: 'Batumi 31', threshold: thr, headingDeg, glidepathDeg: 3.0, lengthNm: 1.117 };

  // aircraft exactly on centreline and glidepath, 5 nm out
  const rangeM = 5 * 1852;
  const t = {
    id: 'x',
    category: 'FixedWing',
    u: thr.z + Math.sin(hRad) * rangeM,
    v: thr.x + Math.cos(hRad) * rangeM,
    altM: (thr.altFt + Math.tan((3 * Math.PI) / 180) * rangeM * 3.28084) * 0.3048,
  };
  const ap = store.computeApproach(t, rwy);
  assert.ok(Math.abs(ap.rangeNm - 5) < 0.01, `range ${ap.rangeNm}`);
  assert.ok(Math.abs(ap.azDevDeg) < 0.01, `az dev ${ap.azDevDeg}`);
  assert.ok(Math.abs(ap.gsDevDeg) < 0.02, `gs dev ${ap.gsDevDeg}`);
  assert.strictEqual(ap.guidance, 'ON COURSE / ON GLIDEPATH');

  // 1 nm right of centreline at 5 nm -> about 11 deg right, "fly left"
  const t2 = Object.assign({}, t, {
    u: t.u + Math.cos(hRad) * 1852,
    v: t.v - Math.sin(hRad) * 1852,
  });
  const ap2 = store.computeApproach(t2, rwy);
  assert.ok(ap2.azDevDeg > 10 && ap2.azDevDeg < 12, `az dev right ${ap2.azDevDeg}`);
  assert.ok(ap2.guidance.startsWith('FLY LEFT'), ap2.guidance);
  console.log('ok  approach geometry (native DCS coordinates)');
}

/* ---------- 6. only aircraft reach the console ---------- */
{
  const store = new TrackStore(CFG);
  store.applyUpdate({ id: '1', props: { Type: 'Air+FixedWing', lat: 41, lon: 41, altM: 1000 } });
  store.applyUpdate({ id: '2', props: { Type: 'Ground+AntiAircraft', lat: 41, lon: 41, altM: 10 } });
  store.applyUpdate({ id: '3', props: { Type: 'Weapon+Missile', lat: 41, lon: 41, altM: 1000 } });
  store.applyUpdate({ id: '4', props: { Type: 'Air+Rotorcraft', lat: 41, lon: 41, altM: 100 } });
  const snap = store.snapshot(null);
  assert.strictEqual(snap.counts.objects, 4);
  assert.deepStrictEqual(
    snap.tracks.map((t) => t.id).sort(),
    ['1', '4'],
    'ground clutter and weapons are filtered out'
  );
  console.log('ok  track filtering');
}

console.log('PARSER TESTS OK');
