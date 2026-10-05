'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const { AircraftFreshness, MAX_RECORDS, MAX_CANDIDATES } = require('../src/acmi/AircraftFreshness');
const { TacviewClient } = require('../src/acmi/TacviewClient');

const sample = { Type: 'Air+FixedWing', Pilot: 'Test pilot', Name: 'F-16C', u: 100, v: 200, altM: 1000 };
const scene = { ReferenceTime: '2026-01-01T00:00:00Z', Title: 'Synthetic mission' };
const update = (m, props, now = 0, id = '1') => m.update({ id, props }, now);

// Explicit cleanup also works on early Node 18, before TestContext.after was available.
function testWithCleanup(name, fn) {
  return test(name, async () => {
    const cleanups = [];
    try {
      await fn({ after(cleanup) { cleanups.push(cleanup); } });
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
  });
}

function fixture(t) {
  const client = new TacviewClient({ host: 'unused.invalid', port: 1 });
  let destroys = 0;
  client.socket = { destroy() { destroys++; } };
  client.connected = true;
  client.lastDataAt = 40000;
  client.lastFrameAdvancedAt = 40000;
  client.parser.global = { ...scene };
  update(client.freshness, sample);
  client.createRecoveryProbe = () => {
    const probe = new EventEmitter();
    probe.parser = { global: { ...scene } };
    probe.start = () => { probe.connected = true; };
    probe.stop = () => { probe.stopped = true; probe.connected = false; };
    return probe;
  };
  t.after(() => client.stop());
  return { client, destroys: () => destroys };
}

function begin(client, props = sample) {
  client.checkHealth(40000);
  const state = client.recoveryProbe;
  assert.ok(state);
  state.client.emit('update', { id: '1', props });
  return state;
}

test('freshness: split identity, partial positions, metadata and stale threshold', () => {
  const m = new AircraftFreshness();
  update(m, { Type: sample.Type });
  update(m, { Pilot: sample.Pilot, Name: sample.Name, u: 100, v: 200, altM: 1000 }, 500);
  update(m, { Coalition: 'Blue' }, 30000);
  assert.equal(m.candidates(30499, 30000).length, 0);
  const [candidate] = m.candidates(30500, 30000);
  assert.ok(m.confirmsDrift(candidate, { ...sample, u: 110 }));
  assert.equal(m.confirmsDrift(candidate, sample), false);
  update(m, { v: 220 }, 30501);
  assert.equal(m.confirmsDrift(candidate, { ...sample, u: 110 }), false);
  assert.equal(m.candidates(30502, 30000).length, 0);
});

test('freshness: deletion, ID reuse and mission reset invalidate an in-flight result', () => {
  const m = new AircraftFreshness();
  update(m, sample);
  const [candidate] = m.candidates(40000, 30000);
  m.remove('1');
  assert.equal(m.confirmsDrift(candidate, { ...sample, u: 110 }), false);
  update(m, sample);
  assert.equal(m.confirmsDrift(candidate, { ...sample, u: 110 }), false);
  m.clear();
  assert.equal(m.candidates(40000, 30000).length, 0);
});

test('freshness: only identified aircraft qualify; exact identity and finite positions required', () => {
  const m = new AircraftFreshness();
  for (const [id, props] of Object.entries({
    ground: { ...sample, Type: 'Ground+Vehicle' }, ai: { ...sample, Pilot: '' },
    invalid: { ...sample, u: Infinity }, helicopter: { ...sample, Type: 'Air+Rotorcraft' },
  })) update(m, props, 0, id);
  const candidates = m.candidates(40000, 30000);
  assert.deepEqual(candidates.map((c) => c.id), ['helicopter']);
  assert.equal(m.confirmsDrift(candidates[0], { ...sample, Type: 'Air+Rotorcraft', Pilot: 'other', u: 110 }), false);
});

test('freshness: coordinate fallback, altitude-only drift and metre tolerance', () => {
  const m = new AircraftFreshness();
  const geo = { Type: sample.Type, Pilot: sample.Pilot, Name: sample.Name, lon: 40, lat: 30, altM: 1000 };
  update(m, geo);
  const [c] = m.candidates(40000, 30000);
  assert.equal(m.confirmsDrift(c, { ...geo, lon: 40.000001 }), false);
  assert.equal(m.confirmsDrift(c, { ...geo, lon: 40.001 }), true);
  assert.equal(m.confirmsDrift(c, { ...geo, altM: 1002 }), true);
  assert.equal(m.confirmsDrift(c, { ...sample, u: 120 }), false);
});

test('freshness: memory, probe candidates and retention are bounded; candidates rotate fairly', () => {
  const m = new AircraftFreshness();
  for (let i = 0; i < MAX_RECORDS + 20; i++) update(m, sample, 0, String(i));
  assert.equal(m.records.size, MAX_RECORDS);
  const first = m.candidates(40000, 30000);
  const next = m.candidates(50000, 30000);
  assert.equal(first.length, MAX_CANDIDATES);
  assert.equal(next.length, MAX_CANDIDATES);
  assert.ok(next.every((c) => !first.some((f) => f.id === c.id)));
  m.prune(3600001);
  assert.equal(m.records.size, 0);
});

testWithCleanup('recovery: a quiet parked aircraft, missing aircraft or noisy snapshot never reconnects', (t) => {
  for (const props of [sample, { ...sample, u: 100.5 }, null]) {
    const f = fixture(t);
    const state = begin(f.client, props || {});
    f.client.finishRecoveryProbe(state, 40000);
    assert.equal(f.destroys(), 0);
    assert.equal(state.client.stopped, true);
    assert.equal(f.client.recoveryProbe, null);
  }
});

testWithCleanup('recovery: verified drift triggers once; cooldown persists through resets', (t) => {
  const f = fixture(t);
  const state = begin(f.client, { ...sample, u: 120 });
  f.client.checkHealth(40001);
  assert.equal(f.client.recoveryStats.probes, 1);
  f.client.finishRecoveryProbe(state, 40000);
  f.client.finishRecoveryProbe(state, 40001);
  assert.equal(f.destroys(), 1);
  assert.equal(f.client.status.aircraftRecovery.recoveries, 1);
  assert.equal(f.client.status.aircraftRecovery.lastRecoveryAt, 40000);
  f.client.resetFreshness();
  update(f.client.freshness, sample);
  f.client.lastFrameAdvancedAt = 50000;
  f.client.checkHealth(50000);
  assert.equal(f.client.recoveryProbe, null);
});

testWithCleanup('recovery: primary updates, removal and ID reuse cancel evidence', (t) => {
  for (const operation of ['update', 'remove', 'reuse']) {
    const f = fixture(t);
    const state = begin(f.client, { ...sample, u: 120 });
    if (operation === 'update') update(f.client.freshness, { u: 115 }, 40001);
    else f.client.freshness.remove('1');
    if (operation === 'reuse') update(f.client.freshness, sample, 40001);
    f.client.finishRecoveryProbe(state, 40001);
    assert.equal(f.destroys(), 0);
  }
});

testWithCleanup('recovery: mission mismatch, disconnect, failed probe and paused simulation are safe', (t) => {
  for (const operation of ['mission', 'disconnect', 'failure', 'pause', 'newSocket']) {
    const f = fixture(t);
    const state = begin(f.client, { ...sample, u: 120 });
    if (operation === 'mission') state.client.parser.global.Title = 'Other mission';
    if (operation === 'disconnect') f.client.connected = false;
    if (operation === 'failure') state.client.connected = false;
    if (operation === 'pause') f.client.lastFrameAdvancedAt = 0;
    if (operation === 'newSocket') f.client.socket = { destroy() { throw new Error('wrong socket'); } };
    f.client.finishRecoveryProbe(state, 40000);
    assert.equal(f.destroys(), 0);
    if (operation === 'newSocket') f.client.socket = null;
    assert.equal(state.client.stopped, true);
  }
});

testWithCleanup('recovery: stop, FileType restart, time rewind and probe close clean up without recovery', (t) => {
  for (const operation of ['stop', 'header', 'rewind', 'close']) {
    const f = fixture(t);
    const state = begin(f.client, { ...sample, u: 120 });
    if (operation === 'stop') f.client.stop();
    if (operation === 'header') f.client.parser.handleLine('FileType=text/acmi/tacview');
    if (operation === 'rewind') { f.client.frameTime = 50; f.client.parser.handleLine('#1'); }
    if (operation === 'close') state.client.emit('disconnected');
    assert.equal(f.client.recoveryProbe, null);
    assert.equal(state.client.stopped, true);
    f.client.finishRecoveryProbe(state, 40000);
    assert.equal(f.destroys(), operation === 'stop' ? 1 : 0);
  }
});

testWithCleanup('recovery: disabled, paused, quiet and unknown-scene streams do not probe', (t) => {
  for (const operation of ['disabled', 'pause', 'scene', 'stopped', 'quiet']) {
    const f = fixture(t);
    if (operation === 'disabled') f.client.recoveryCfg.enabled = false;
    if (operation === 'pause') f.client.lastFrameAdvancedAt = 0;
    if (operation === 'scene') delete f.client.parser.global.ReferenceTime;
    if (operation === 'stopped') f.client.stopped = true;
    if (operation === 'quiet') f.client.lastDataAt = -30000;
    f.client.checkHealth(40000);
    assert.equal(f.client.recoveryProbe, null);
    assert.equal(f.destroys(), operation === 'quiet' ? 1 : 0);
  }
});

testWithCleanup('recovery: probe removal and restart discard previously collected positions', (t) => {
  for (const operation of ['remove', 'restart']) {
    const f = fixture(t);
    const state = begin(f.client, { ...sample, u: 120 });
    state.client.emit(operation, '1');
    f.client.finishRecoveryProbe(state, 40000);
    assert.equal(f.destroys(), 0);
  }
});

test('recovery: invalid configuration fails fast; child never recursively probes', () => {
  for (const cfg of [{ enabled: 'yes' }, { staleAfterMs: 0 }, { probeIntervalMs: 1 }, { probeTimeoutMs: NaN }]) {
    assert.throws(() => new TacviewClient({ aircraftRecovery: cfg }), /aircraftRecovery/);
  }
  const parent = new TacviewClient({});
  const child = parent.createRecoveryProbe();
  assert.equal(child.recoveryCfg.enabled, false);
  assert.ok(child.cfg.reconnectDelayMs > parent.recoveryCfg.probeTimeoutMs);
  child.stop();
  parent.stop();
});

testWithCleanup('recovery: synthetic TCP snapshot verifies stale position and restores live updates', async (t) => {
  const sockets = new Set();
  let connections = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const connection = ++connections;
    socket.once('data', () => {
      socket.write('XtraLib.Stream.0\nTacview.RealTimeTelemetry.0\nSynthetic\n\0' +
        'FileType=text/acmi/tacview\n0,ReferenceTime=2026-01-01T00:00:00Z,Title=Synthetic mission\n#1\n' +
        `1,Type=Air+FixedWing,Pilot=Test pilot,Name=F-16C,T=0|0|1000|${connection === 1 ? 100 : 200}|200\n`);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new TacviewClient({ host: '127.0.0.1', port: server.address().port, reconnectDelayMs: 10 });
  t.after(async () => {
    client.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  function waitFor(check) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const timer = setInterval(() => {
        if (check()) { clearInterval(timer); resolve(); }
        else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('synthetic TCP timeout')); }
      }, 5);
    });
  }
  client.start();
  await waitFor(() => client.freshness.records.has('1'));
  client.freshness.records.get('1').positionAt -= 40000;
  client.checkHealth();
  const state = client.recoveryProbe;
  assert.ok(state);
  await waitFor(() => state.samples.has('1'));
  client.finishRecoveryProbe(state);
  await waitFor(() => connections === 3 && client.freshness.records.get('1')?.sample.u === 200);
  assert.equal(client.recoveryStats.recoveries, 1);
  assert.equal(client.recoveryStats.probes, 1);
  assert.equal(client.connected, true);
  assert.equal(client.recoveryProbe, null);
});

testWithCleanup('recovery: timeout disposes auxiliary connection even when handshake never completes', async (t) => {
  const f = fixture(t);
  f.client.recoveryCfg.probeTimeoutMs = 1000;
  const state = begin(f.client, {});
  state.client.connected = false;
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.equal(f.client.recoveryProbe, null);
  assert.equal(state.client.stopped, true);
  assert.equal(f.destroys(), 0);
  f.client.lastDataAt = 160000;
  f.client.lastFrameAdvancedAt = 160000;
  f.client.checkHealth(159999);
  assert.equal(f.client.recoveryStats.probes, 1);
  f.client.checkHealth(160000);
  assert.equal(f.client.recoveryStats.probes, 2);
});

test('freshness: ground clutter cannot exhaust player monitoring capacity', () => {
  const m = new AircraftFreshness();
  for (let i = 0; i < MAX_RECORDS + 20; i++) update(m, { Type: 'Ground+Vehicle', u: 1, v: 2 }, 0, String(i));
  update(m, sample, 0, 'player');
  assert.equal(m.records.size, 1);
  assert.equal(m.candidates(40000, 30000)[0].id, 'player');
});
