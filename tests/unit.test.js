'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { AcmiParser } = require('../src/acmi/AcmiParser');
const { TrackStore } = require('../src/acmi/TrackStore');
const { Talkdown } = require('../src/acmi/Talkdown');
const { Diagnostics } = require('../src/acmi/Diagnostics');
const { parseClientHandshake, authorizeClient } = require('../tools/mock-tacview');

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

test('AcmiParser: relative lon/lat converted with ReferenceLongitude/Latitude', () => {
  // the reference offset is applied where the stream is decoded, so the store
  // and everything downstream only ever see absolute degrees
  const p = new AcmiParser();
  const updates = [];
  p.on('object', (o) => updates.push(o));
  p.handleLine('0,ReferenceLongitude=140.0');
  p.handleLine('0,ReferenceLatitude=36.0');
  p.handleLine('a,T=0|0.01|500,Type=Air+FixedWing');

  assert.ok(Math.abs(updates[0].props.lon - 140.0) < 1e-9);
  assert.ok(Math.abs(updates[0].props.lat - 36.01) < 1e-9);
});

test('AcmiParser: escaped commas and values continued on the next line', () => {
  const p = new AcmiParser();
  const globals = {};
  const updates = [];
  p.on('global', (k, v) => (globals[k] = v));
  p.on('object', (o) => updates.push(o));
  p.handleLine('0,Comments=line one\\');
  p.handleLine('line two\\, still line two');
  p.handleLine('3001,Type=Ground+Static+Aerodrome,Name=Invisible FARP,Country=xb');

  assert.ok(globals.Comments.includes('line two, still line two'));
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].props.Name, 'Invisible FARP');
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

test('TrackStore: approach geometry in native DCS coordinates (Batumi RWY 31)', () => {
  const store = makeStore();
  // as DCSServerBot reports it: centre x=-355810.7 z=617386.2, course 0.95013 rad
  // (-> true heading 305.56), length 2070 m
  const headingDeg = 305.56;
  const hRad = (headingDeg * Math.PI) / 180;
  const thr = {
    x: -355810.6875 - Math.cos(hRad) * 1035,
    z: 617386.1875 - Math.sin(hRad) * 1035,
    altFt: 33,
  };
  const rwy = { id: 'Batumi 31', threshold: thr, headingDeg, glidepathDeg: 3.0, lengthNm: 1.117 };

  const rangeM = 5 * 1852;
  const onFinal = {
    id: 'f',
    category: 'FixedWing',
    u: thr.z - Math.sin(hRad) * rangeM, // approach side: opposite the landing heading
    v: thr.x - Math.cos(hRad) * rangeM,
    altM: (thr.altFt + Math.tan((3 * Math.PI) / 180) * rangeM * 3.28084) * 0.3048,
  };
  const ap = store.computeApproach(onFinal, rwy);
  assert.ok(Math.abs(ap.rangeNm - 5) < 0.01, `range=${ap.rangeNm}`);
  assert.ok(ap.alongNm > 0, `on final must have positive along (${ap.alongNm})`);
  assert.ok(Math.abs(ap.azDevDeg) < 0.01, `az=${ap.azDevDeg}`);
  assert.ok(Math.abs(ap.gsDevDeg) < 0.02, `gs=${ap.gsDevDeg}`);
  assert.strictEqual(ap.guidance, 'ON COURSE / ON GLIDEPATH');
  assert.strictEqual(ap.onFinal, true);

  // 1 nm right of the centreline at 5 nm -> ~11 deg, controller says FLY LEFT
  const right = Object.assign({}, onFinal, {
    u: onFinal.u + Math.cos(hRad) * 1852,
    v: onFinal.v - Math.sin(hRad) * 1852,
  });
  const apRight = store.computeApproach(right, rwy);
  assert.ok(apRight.azDevDeg > 10 && apRight.azDevDeg < 12, `az=${apRight.azDevDeg}`);
  assert.ok(apRight.guidance.startsWith('FLY LEFT'), apRight.guidance);

  // an aircraft parked on the runway is past touchdown, not on final
  const onRunway = {
    id: 'g',
    category: 'FixedWing',
    u: thr.z + Math.sin(hRad) * 1000,
    v: thr.x + Math.cos(hRad) * 1000,
    altM: thr.altFt * 0.3048,
  };
  const apGround = store.computeApproach(onRunway, rwy);
  assert.ok(apGround.alongNm < 0, `over the runway must be negative along (${apGround.alongNm})`);
  assert.strictEqual(apGround.onFinal, false);
});

test('TrackStore: ground clutter and weapons never reach the console', () => {
  const store = makeStore();
  store.applyUpdate({ id: '1', props: { Type: 'Air+FixedWing', lat: 36, lon: 140, altM: 1000 } });
  store.applyUpdate({ id: '2', props: { Type: 'Ground+AntiAircraft', lat: 36, lon: 140, altM: 10 } });
  store.applyUpdate({ id: '3', props: { Type: 'Weapon+Missile', lat: 36, lon: 140, altM: 1000 } });
  store.applyUpdate({ id: '4', props: { Type: 'Air+Rotorcraft', lat: 36, lon: 140, altM: 100 } });

  const snap = store.snapshot(null);
  assert.deepStrictEqual(snap.tracks.map((t) => t.id).sort(), ['1', '4']);
  assert.strictEqual(snap.counts.objects, 4);
  assert.strictEqual(snap.counts.aircraft, 2);
});

test('TrackStore: bullseyes are kept out of the track list but exposed separately', () => {
  const store = makeStore();
  store.applyUpdate({
    id: '90',
    props: { Type: 'Navaid+Static+Bullseye', Name: 'Bullseye', Color: 'Blue', Coalition: 'Allies', lat: 36.4, lon: 140.2, u: 1000, v: 2000 },
  });
  store.applyUpdate({ id: '1', props: { Type: 'Air+FixedWing', lat: 36, lon: 140, altM: 1000 } });

  const snap = store.snapshot(null);
  assert.deepStrictEqual(snap.tracks.map((t) => t.id), ['1'], 'a bullseye is not traffic');
  assert.strictEqual(snap.bullseyes.length, 1);
  assert.deepStrictEqual(snap.bullseyes[0], {
    id: '90',
    name: 'Bullseye',
    coalition: 'Allies',
    color: 'Blue',
    lat: 36.4,
    lon: 140.2,
    u: 1000,
    v: 2000,
  });
});

test('TrackStore: a bullseye sent once survives pruning, clear() drops it', () => {
  const store = makeStore();
  store.applyUpdate({ id: '90', props: { Type: 'Navaid+Static+Bullseye', lat: 36.4, lon: 140.2 } });

  // the stream sends static objects once: age the record well past staleAfterSec
  store.tracks.get('90').lastUpdate = Date.now() - 60 * 1000;
  assert.strictEqual(store.snapshot(null).bullseyes.length, 1, 'must outlive prune()');
  assert.strictEqual(store.tracks.has('90'), false, 'the track record itself is pruned as usual');

  store.applyUpdate({ id: '91', props: { Type: 'Navaid+Static+Bullseye', lat: 36.5, lon: 140.3 } });
  store.remove('91');
  assert.strictEqual(store.snapshot(null).bullseyes.length, 1, 'removal line drops it');

  store.clear(); // recording restart / stream drop
  assert.strictEqual(store.snapshot(null).bullseyes.length, 0);
});

test('Talkdown: only aircraft established on final are talked down', () => {
  const td = makeTalkdown();
  const far = fakeTrack(80, 20, 5);
  far.approach.onFinal = false;
  assert.strictEqual(td.update([far], 'RWY 21').length, 0, 'orbiting traffic must stay silent');

  const parked = fakeTrack(0.4, 0, 0);
  parked.onGround = true;
  assert.strictEqual(td.update([parked], 'RWY 21').length, 0, 'aircraft on the ground stay silent');

  assert.strictEqual(td.update([fakeTrack(5, 0.1, 0.1)], 'RWY 21').length, 1);
});

/* ---------- Diagnostics (Issue #8 observation mode) ---------- */

test('Diagnostics: reference, transform histogram and Type counts are aggregated', () => {
  const diag = new Diagnostics();
  diag.recordGlobal('ReferenceLongitude', '140.0');
  diag.recordGlobal('ReferenceLatitude', '36');
  diag.recordGlobal('Title', 'unrelated'); // must be ignored
  for (let i = 0; i < 3; i++) diag.recordTransform(9);
  diag.recordTransform(3);
  diag.recordUpdate('a', { Type: 'Air+FixedWing' });
  diag.recordUpdate('b', { Type: 'Air+FixedWing' });
  diag.recordUpdate('c', { Type: 'Sea+Watercraft' });

  const rep = diag.report();
  assert.deepStrictEqual(rep.reference.declared, { ReferenceLongitude: true, ReferenceLatitude: true });
  assert.strictEqual(rep.reference.longitude, 140.0);
  assert.strictEqual(rep.reference.latitude, 36);
  assert.deepStrictEqual(rep.transforms.histogram, { 9: 3, 3: 1 });
  assert.strictEqual(rep.transforms.total, 4);
  assert.strictEqual(rep.types.counts['Air+FixedWing'], 2);
  assert.strictEqual(rep.types.counts['Sea+Watercraft'], 1);
  assert.strictEqual(rep.types.total, 3);
});

test('Diagnostics: uv samples keep raw relative + absolute + native coordinates', () => {
  const diag = new Diagnostics({ maxUvTracks: 2 });
  diag.recordUpdate('1', { lonRel: 4.73, latRel: 3.57, lon: 144.73, lat: 39.57, u: 545654, v: -366511.31, Type: 'Air+FixedWing' });
  diag.recordUpdate('2', { lonRel: 0.1, latRel: 0.2, lon: 140.1, lat: 36.2 }); // no u/v on the wire
  diag.recordUpdate('1', { u: 1, v: 2 }); // repeat update must not add a second sample
  diag.recordUpdate('3', { lonRel: 9, latRel: 9, lon: 149, lat: 45 }); // beyond maxUvTracks

  assert.strictEqual(diag.uvSamples.length, 2);
  const s = diag.uvSamples[0];
  assert.strictEqual(s.id, '1');
  assert.strictEqual(s.lonRel, 4.73); // raw as sent by the host
  assert.strictEqual(s.latRel, 3.57);
  assert.strictEqual(s.lon, 144.73); // after Reference* was applied
  assert.strictEqual(s.lat, 39.57);
  assert.strictEqual(s.u, 545654); // native DCS metres
  assert.strictEqual(s.v, -366511.31);
  assert.strictEqual(diag.uvSamples[1].u, null);
});

test('Diagnostics: ground speed differencing count and mean', async () => {
  const diag = new Diagnostics();
  diag.recordUpdate('a', { u: 0, v: 0 });
  await new Promise((r) => setTimeout(r, 550));
  // move north-east at ~77 m/s over the elapsed wall-clock dt
  diag.recordUpdate('a', { u: 38.5, v: 66.7 });

  const gs = diag.report().groundSpeed;
  assert.strictEqual(gs.samples, 1);
  assert.ok(gs.meanMs > 50 && gs.meanMs < 200, `meanMs=${gs.meanMs}`);
  assert.ok(gs.meanKt > 100 && gs.meanKt < 400, `meanKt=${gs.meanKt}`);

  // pairs closer than MIN_DT_S are ignored, so no second sample yet
  diag.recordUpdate('a', { u: 40, v: 70 });
  assert.strictEqual(diag.report().groundSpeed.samples, 1);
});

test('Diagnostics: maybeDump writes JSON to TACVIEW_DEBUG_DUMP path', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const file = path.join(os.tmpdir(), `gca-diag-test-${process.pid}.json`);
  try {
    const diag = new Diagnostics({ dumpPath: file });
    diag.recordGlobal('ReferenceLatitude', '38');
    assert.ok(diag.maybeDump(true), 'dump should write when forced');
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(written.reference.latitude, 38);
    assert.strictEqual(written.enabled, true);

    // unchanged state is not rewritten without force
    assert.strictEqual(diag.maybeDump(false), false);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

/* ---------- mock Tacview host handshake / password gate ---------- */

test('mock handshake: parses the four XtraLib lines and gates the password', () => {
  const hs = parseClientHandshake('XtraLib.Stream.0\nTacview.RealTimeTelemetry.0\nDCSWebGCA\nsecret\0');
  assert.strictEqual(hs.proto, 'XtraLib.Stream.0');
  assert.strictEqual(hs.stream, 'Tacview.RealTimeTelemetry.0');
  assert.strictEqual(hs.name, 'DCSWebGCA');
  assert.strictEqual(hs.password, 'secret');

  // correct password passes, wrong one is rejected
  assert.strictEqual(authorizeClient(hs, 'secret').ok, true);
  assert.strictEqual(authorizeClient(hs, 'other').ok, false);

  // open host accepts everybody regardless of what the client sent
  assert.strictEqual(authorizeClient(hs, '').ok, true);

  // client that never sends a password line against a protected host
  const bare = parseClientHandshake('XtraLib.Stream.0\nTacview.RealTimeTelemetry.0\nDCSWebGCA\0');
  assert.strictEqual(bare.password, '');
  assert.strictEqual(authorizeClient(bare, 'secret').ok, false);
});
