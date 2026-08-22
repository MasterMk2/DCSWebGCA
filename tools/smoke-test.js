'use strict';

/**
 * End-to-end smoke test: starts the mock Tacview server and the GCA server as
 * child processes, then checks the REST snapshot and the WebSocket feed.
 * Run: npm run smoke
 */

const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');

const MOCK_PORT = 34251;
const WEB_PORT = 8091;

function get(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: WEB_PORT, path }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForTracks() {
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try {
      const res = await get('/api/state');
      if (res.status === 200) {
        const state = JSON.parse(res.body);
        if (state.tracks && state.tracks.length > 0) return state;
      }
    } catch {
      /* retry */
    }
  }
  return null;
}

function wsCheck() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${WEB_PORT}/ws`);
    const seen = new Set();
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`websocket: only saw ${[...seen].join(',') || 'nothing'}`));
    }, 20000);

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      seen.add(msg.type);
      if (msg.type === 'transcript' && msg.messages && msg.messages.length) seen.add('talkdown');
      if (seen.has('hello') && seen.has('runways') && seen.has('tracks') && seen.has('talkdown')) {
        clearTimeout(timer);
        ws.close();
        resolve([...seen]);
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function main() {
  const mock = spawn(process.execPath, ['tools/mock-tacview.js'], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
    stdio: 'inherit',
  });
  const server = spawn(process.execPath, ['src/index.js'], {
    env: { ...process.env, TACVIEW_PORT: String(MOCK_PORT), GCA_PORT: String(WEB_PORT) },
    stdio: 'inherit',
  });

  try {
    const state = await waitForTracks();
    if (!state) throw new Error('no tracks received');

    // ground speed is derived from position differencing, which needs
    // at least ~0.5 s of samples; give the pipeline a moment
    await new Promise((r) => setTimeout(r, 1500));
    const res2 = await get('/api/state');
    state = JSON.parse(res2.body);

    const airborne = state.tracks.filter((t) => t.approach);
    if (airborne.length === 0) throw new Error('tracks have no approach data (runway not resolved?)');
    if (state.tracks.some((t) => t.category === 'Ground')) throw new Error('ground clutter leaked into the console');

    console.log(`SMOKE: ${state.tracks.length} tracks (${state.counts.objects} objects), runway ${state.runway.id}`);
    for (const t of airborne) {
      console.log(
        `  ${t.pilot || t.name}: RNG=${t.approach.rangeNm}nm AZ=${t.approach.azDevDeg}deg ` +
          `GS=${t.approach.gsDevDeg}deg ALT=${t.altFt}ft -> ${t.approach.guidance}`
      );
      if (t.spdKt === null || t.spdKt === undefined || t.spdKt <= 0) speedOk = false;
    }
    if (!speedOk) {
      console.error('SMOKE FAIL: ground speed was not derived from position differencing');
      process.exitCode = 1;
    }

    const seen = await wsCheck();
    console.log(`SMOKE: websocket messages ok (${seen.join(', ')})`);
    console.log('SMOKE OK');
  } catch (err) {
    console.error('SMOKE FAIL:', err.message);
    process.exitCode = 1;
  } finally {
    mock.kill();
    server.kill();
  }
}

main();
