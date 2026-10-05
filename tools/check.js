'use strict';

// Verification only: never inherit a deployment config, endpoint, or cache.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'smoke-config.json');

function childEnvironment(base, cacheDir) {
  const env = Object.fromEntries(Object.entries(base).filter(
    ([key]) => !/^(GCA_|TACVIEW_|DCSSB_|MOCK_)/i.test(key)
  ));
  return Object.assign(env, {
    GCA_CONFIG: FIXTURE,
    GCA_BIND: '127.0.0.1',
    GCA_CACHE_DIR: cacheDir,
    TACVIEW_HOST: '127.0.0.1',
    TACVIEW_PASSWORD: '',
    MOCK_PASSWORD: '',
  });
}

function doctor() {
  const stream = require('node:stream');
  // Only allow-listed values, never process.env or user paths.
  console.log(JSON.stringify({
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    ws: require('ws/package.json').version,
    openssl: process.versions.openssl,
    undici: process.versions.undici,
    // This diagnostic API is absent on Node 18 releases before 18.17.
    byteHighWaterMark: typeof stream.getDefaultHighWaterMark === 'function'
      ? stream.getDefaultHighWaterMark(false) : null,
  }, null, 2));
}

function main(command) {
  if (command === 'doctor') { doctor(); return 0; }
  if (command !== undefined && command !== 'smoke') {
    console.error('Usage: node tools/check.js [doctor|smoke]');
    return 2;
  }
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'dcswebgca-check-'));
  const env = childEnvironment(process.env, cache);
  try {
    doctor();
    const tests = fs.readdirSync(path.join(ROOT, 'tests'))
      .filter((name) => name.endsWith('.test.js')).sort()
      .map((name) => path.join('tests', name));
    if (!tests.length) { console.error('No tests found'); return 1; }
    const commands = command === 'smoke'
      ? [['tools/smoke-test.js']]
      : [['--test', ...tests], ['tools/smoke-test.js']];
    for (const args of commands) {
      const result = spawnSync(process.execPath, args, {
        cwd: ROOT, env, stdio: 'inherit', timeout: 120000,
      });
      if (result.error) console.error(result.error.message);
      if (result.status !== 0) return result.status || 1;
    }
    return 0;
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
}

module.exports = { childEnvironment, FIXTURE };
if (require.main === module) process.exitCode = main(process.argv[2]);
