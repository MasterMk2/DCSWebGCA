'use strict';

/**
 * End-to-end smoke test: starts the mock Tacview server and the GCA server
 * as child processes, then verifies /api/state returns live tracks.
 * Run: node tools/smoke-test.js
 */

const { spawn } = require('child_process');
const http = require('http');

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
    // wait for the pipeline to come up
    let state = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const res = await get('/api/state');
        if (res.status === 200) {
          state = JSON.parse(res.body);
          if (state.tracks.length > 0) break;
        }
      } catch {
        /* retry */
      }
    }

    if (!state || state.tracks.length === 0) {
      console.error('SMOKE FAIL: no tracks received');
      process.exitCode = 1;
      return;
    }

    const airborne = state.tracks.filter((t) => t.approach);
    console.log(`SMOKE OK: ${state.tracks.length} tracks, ${airborne.length} airborne`);
    for (const t of airborne) {
      console.log(
        `  ${t.pilot || t.name}: RNG=${t.approach.rangeNm}nm AZ=${t.approach.azDevDeg}deg GS=${t.approach.gsDevDeg}deg -> ${t.approach.guidance}`
      );
    }
  } finally {
    mock.kill();
    server.kill();
  }
}

main().catch((err) => {
  console.error('SMOKE FAIL:', err);
  process.exitCode = 1;
});
