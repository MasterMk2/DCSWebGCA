'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { AcmiParser } = require('../src/acmi/AcmiParser');
const { TrackStore } = require('../src/acmi/TrackStore');
const { Talkdown } = require('../src/acmi/Talkdown');

/* ---------- AcmiParser ---------- */
// Wire format (real DCS Tacview export):
//   0,ReferenceLatitude=38              global property (object id 0)
//   29502,T=lon|lat|alt|...|hdg,Type=Air+FixedWing,Name=F-16C
//   -29502                              object removed

test('AcmiParser: 9-field transform with reference-relative coordinates', () => {
  const p = new AcmiParser();
  p.handleLine('0,ReferenceLongitude=140,ReferenceLatitude=36');

  let got = null;
  p.on('object', (u) => (got = u));
  p.handleLine('29502,T=4.73|3.57|2286|-0.6|4.6|129.8|545654|-366511.31|124.6,Type=Air+FixedWing,Name=F-16C');

  assert.ok(got);
  assert.strictEqual(got.id, '29502');
  assert.ok(Math.abs(got.props.lon - 144.73) < 1e-9); // reference + relative
  assert.ok(Math.abs(got.props.lat - 39.57) < 1e-9);
  assert.strictEqual(got.props.altM, 2286);
  assert.strictEqual(got.props.yaw, 129.8);
  assert.strictEqual(got.props.u, 545654);
  assert.strictEqual(got.props.v, -366511.31);
  assert.strictEqual(got.props.hdg, 124.6);
  assert.strictEqual(got.props.Name, 'F-16C');
  assert.strictEqual(got.props.Type, 'Air+FixedWing');
});

test('AcmiParser: 3-field and 5-field transforms keep positional mapping', () => {
  const p = new AcmiParser();
  p.handleLine('0,ReferenceLongitude=140,ReferenceLatitude=36');
  const updates = [];
  p.on('object', (u) => updates.push(u));

  p.handleLine('2,T=1|2|300');
  p.handleLine('3,T=1|2|300|10|20');

  // 3 fields: lon/lat/alt only -- no u/v hallucinated
  assert.ok(Math.abs(updates[0].props.lon - 141) < 1e-9);
  assert.ok(Math.abs(updates[0].props.lat - 38) < 1e-9);
  assert.strictEqual(updates[0].props.altM, 300);
  assert.strictEqual(updates[0].props.u, undefined);

  // 5 fields: u/v land in u/v, NOT in roll/pitch
  assert.strictEqual(updates[1].props.roll, undefined);
  assert.strictEqual(updates[1].props.pitch, undefined);
  assert.strictEqual(updates[1].props.u, 10);
  assert.strictEqual(updates[1].props.v, 20);
});

test('AcmiParser: partial update keeps unchanged fields, removal line', () => {
  const p = new AcmiParser();
  p.handleLine('0,ReferenceLongitude=140,ReferenceLatitude=36');
  const updates = [];
  const removed = [];
  p.on('object', (u) => updates.push(u));
  p.on('remove', (id) => removed.push(id));

  p.handleLine('29502,T=4.73|3.57|2286|-0.6|4.6|129.8|545654|-366511.31|124.6,Type=Air+FixedWing');
  p.handleLine('29502,T=|||545691.5|-366535.78');
  p.handleLine('-29502');

  // partial update: parser emits ONLY the refreshed fields (u/v);
  // merging with previous state is TrackStore's responsibility
  assert.strictEqual(updates.length, 2);
  assert.strictEqual(updates[1].props.u, 545691.5);
  assert.strictEqual(updates[1].props.v, -366535.78);
  assert.strictEqual(updates[1].props.altM, undefined);
  assert.strictEqual(updates[1].props.Type, undefined);
  assert.deepStrictEqual(removed, ['29502']);
});

test('AcmiParser: global properties via object id 0 and header lines', () => {
  const p = new AcmiParser();
  const globals = {};
  let headers = 0;
  p.on('global', (k, v) => (globals[k] = v));
  p.on('header', () => headers++);

  p.handleLine('FileType=text/acmi/tacview');
  p.handleLine('FileVersion=2.2');
  p.handleLine('0,ReferenceLatitude=38,ReferenceLongitude=140,Title=Test');
  p.handleLine('#36568.57');

  assert.strictEqual(headers, 2);
  assert.strictEqual(globals.ReferenceLatitude, '38');
  assert.strictEqual(globals.ReferenceLongitude, '140');
  assert.strictEqual(p.reference.lat, 38);
  assert.strictEqual(p.reference.lon, 140);
});

/* ---------- TrackStore ---------- */

function makeStore() {
  const store = new TrackStore({
    gca: {
      staleAfterSec: 15,
      defaultRunway: 'RWY 21',
      runways: [
        {
          id: 'RWY 21',
          threshold: { lat: 36.0, lon: 140.0, altFt: 100 },
          headingDeg: 210,
          glidepathDeg: 3,
          lengthNm: 1.2,
        },
      ],
    },
  });
  return store;
}

test('TrackStore: relative lon/lat converted with ReferenceLongitude/Latitude', () => {
  const store = makeStore();
  store.setReference('ReferenceLongitude', '140.0');
  store.setReference('ReferenceLatitude', '36.0');

  // 0.01 deg north of reference
  store.applyUpdate({ id: 'a', props: { lon: 0, lat: 0.01, altM: 500, Type: 'Air+FixedWing' } });
  const t = store.tracks.get('a');
  assert.ok(Math.abs(t.lat - 36.01) < 1e-9);
  assert.ok(Math.abs(t.lon - 140.0) < 1e-9);
});

test('TrackStore: ground speed/course derived from U/V differencing', async () => {
  const store = makeStore();
  // u = east, v = north; move north-east at ~77 m/s (~150 kt)
  store.applyUpdate({ id: 'a', props: { u: 0, v: 0, lat: 36, lon: 140, Type: 'Air+FixedWing' } });
  await new Promise((r) => setTimeout(r, 550));
  store.applyUpdate({ id: 'a', props: { u: 38.5, v: 66.7 } });

  // dt is wall-clock (~0.55 s), so speed = 77 m/s / dt lands in a wide band.
  // gsKt is exposed on the snapshot record (raw track keeps it as spdKt).
  const snap = store.snapshot(store.cfg.gca.runways[0]);
  const rec = snap.tracks.find((r) => r.id === 'a');
  assert.ok(rec && rec.gsKt > 120 && rec.gsKt < 320, `gsKt=${rec && rec.gsKt}`);
  assert.ok(rec && Math.abs(rec.gc - 30) <= 3, `gc=${rec && rec.gc}`);
});

test('TrackStore: airborne detection for DCS type strings', () => {
  const store = makeStore();
  store.applyUpdate({ id: 'a', props: { lat: 36, lon: 140, Type: 'Air+FixedWing' } });
  store.applyUpdate({ id: 'b', props: { lat: 36, lon: 140, Type: 'Air+Rotorcraft' } });
  store.applyUpdate({ id: 'c', props: { lat: 36, lon: 140, Type: 'Ground+Static' } });

  assert.ok(store.isAirborne(store.tracks.get('a')));
  assert.ok(store.isAirborne(store.tracks.get('b')));
  assert.ok(!store.isAirborne(store.tracks.get('c')));
});

test('TrackStore: approach geometry on-centerline / deviations', () => {
  const store = makeStore();
  const rwy = store.cfg.gca.runways[0];

  // directly on final, 5 nm out
  const alongM = 5 * 1852;
  const hdgRad = (210 * Math.PI) / 180;
  const mk = (crossM) => ({
    lon: 140 + (-alongM * Math.sin(hdgRad) + crossM * Math.cos(hdgRad)) / (111320 * Math.cos((36 * Math.PI) / 180)),
    lat: 36 + (-alongM * Math.cos(hdgRad) - crossM * Math.sin(hdgRad)) / 111320,
    altM: 100 * 0.3048 + Math.tan((3 * Math.PI) / 180) * alongM,
    Type: 'Air+FixedWing',
  });

  store.applyUpdate({ id: 'on', props: mk(0) });
  store.applyUpdate({ id: 'right', props: mk(300) });

  const apOn = store.computeApproach(store.tracks.get('on'), rwy);
  assert.ok(Math.abs(apOn.rangeNm - 5) < 0.05, `range=${apOn.rangeNm}`);
  assert.ok(Math.abs(apOn.azDevDeg) < 0.05, `az=${apOn.azDevDeg}`);
  assert.ok(Math.abs(apOn.gsDevDeg) < 0.05, `gs=${apOn.gsDevDeg}`);
  assert.ok(apOn.guidance.includes('ON COURSE'));

  const apRight = store.computeApproach(store.tracks.get('right'), rwy);
  assert.ok(apRight.azDevDeg > 0.5, `az=${apRight.azDevDeg}`); // right of centerline
});

/* ---------- Talkdown ---------- */

function fakeTrack(rangeNm, azDeg, gsDeg) {
  return {
    id: 'x',
    pilot: 'Viper-1',
    name: 'Hornet',
    approach: {
      rangeNm,
      alongNm: rangeNm,
      azDevDeg: azDeg,
      gsDevDeg: gsDeg,
    },
  };
}

function makeTalkdown() {
  return new Talkdown({
    gca: {
      defaultRunway: 'RWY 21',
      runways: [{ id: 'RWY 21', threshold: { lat: 36, lon: 140, altFt: 100 }, headingDeg: 210, glidepathDeg: 3 }],
    },
  });
}

test('Talkdown: graduated phraseology', () => {
  // each scenario gets a fresh instance: identical deviation bands are
  // intentionally silent (no state change = no repeated call)
  const run = (az, gs) => makeTalkdown().update([fakeTrack(5, az, gs)], 'RWY 21')[0].text;

  assert.match(run(0.1, 0.1), /on course/);
  assert.match(run(0.1, 0.1), /on glidepath/);

  assert.match(run(0.8, 0.5), /slightly (right|left) of course/);
  assert.match(run(0.8, 0.5), /slightly (high|low)/);

  assert.match(run(4, 2), /well (right|left) of course/);
  assert.match(run(4, 2), /well (high|low)/);

  assert.match(run(2, 0.1), /turn heading \d{3}/);
});

test('Talkdown: state is per runway', () => {
  const td = makeTalkdown();
  const cfg2 = {
    gca: {
      defaultRunway: 'RWY 21',
      runways: [
        { id: 'RWY 21', threshold: { lat: 36, lon: 140, altFt: 100 }, headingDeg: 210, glidepathDeg: 3 },
        { id: 'RWY 03', threshold: { lat: 36, lon: 140, altFt: 100 }, headingDeg: 30, glidepathDeg: 3 },
      ],
    },
  };
  const td2 = new Talkdown(cfg2);

  const m1 = td2.update([fakeTrack(5, 0.1, 0.1)], 'RWY 21');
  assert.ok(m1.length === 1);
  // same aircraft, different runway -> independent state, message generated again
  const m2 = td2.update([fakeTrack(5, 0.1, 0.1)], 'RWY 03');
  assert.ok(m2.length === 1);
});
