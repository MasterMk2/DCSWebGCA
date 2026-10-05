'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stream = require('node:stream');
const { spawnSync } = require('node:child_process');
const { childEnvironment, FIXTURE, testCommands } = require('../tools/check');
const CHECK = path.resolve(__dirname, '../tools/check.js');

function runDoctor(args) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('check: doctor reports the runtime byte high-water mark when available', () => {
  const report = runDoctor([CHECK, 'doctor']);
  const expected = typeof stream.getDefaultHighWaterMark === 'function'
    ? stream.getDefaultHighWaterMark(false) : null;
  assert.equal(report.byteHighWaterMark, expected);
  assert.equal(report.node, process.version);
});

test('check: doctor succeeds when the Node 18 high-water-mark API is absent', () => {
  const report = runDoctor(['-e', `
    require('node:stream').getDefaultHighWaterMark = undefined;
    process.argv = [process.execPath, ${JSON.stringify(CHECK)}, 'doctor'];
    require('node:module').runMain();
  `]);
  assert.equal(report.byteHighWaterMark, null);
  assert.equal(report.node, process.version);
  assert.equal(report.ws, require('ws/package.json').version);
});

test('check: Node 18.0 runs every test file directly and preserves failures', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dcswebgca-runner-test-'));
  try {
    const pass = path.join(directory, 'pass.cjs');
    const fail = path.join(directory, 'fail.cjs');
    fs.writeFileSync(pass, "require('node:test')('passes', () => {});\n");
    fs.writeFileSync(fail, "require('node:test')('fails', () => { throw new Error('expected failure'); });\n");
    const commands = testCommands([pass, fail], '18.0.0');
    assert.deepEqual(commands, [[pass], [fail]]);
    for (const [index, args] of commands.entries()) {
      const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 });
      assert.ifError(result.error);
      assert.equal(result.status, index === 0 ? 0 : 1, result.stderr);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('check: runtimes with the CLI runner include every test in one invocation', () => {
  const files = ['first.test.js', 'second.test.js'];
  for (const version of ['18.1.0', '18.16.0', '22.23.3']) {
    assert.deepEqual(testCommands(files, version), [['--test', ...files]]);
  }
});

test('check: deployment settings cannot leak into synthetic child processes', () => {
  const original = {
    GCA_CONFIG: 'production.json', GCA_CACHE_DIR: 'production-cache',
    TACVIEW_HOST: 'example.invalid', DCSSB_BASE_URL: 'https://example.invalid',
    DCSSB_API_KEY: 'synthetic-secret', TACVIEW_DEBUG_DUMP: 'production.log',
    MOCK_PASSWORD: 'synthetic-password', gca_auth: 'synthetic-auth',
  };
  const env = childEnvironment(original, 'test-cache');
  assert.equal(env.GCA_CONFIG, FIXTURE);
  assert.equal(env.GCA_BIND, '127.0.0.1');
  assert.equal(env.TACVIEW_HOST, '127.0.0.1');
  assert.equal(env.GCA_CACHE_DIR, 'test-cache');
  assert.equal(env.TACVIEW_PASSWORD, '');
  assert.equal(env.MOCK_PASSWORD, '');
  for (const key of ['DCSSB_BASE_URL', 'DCSSB_API_KEY', 'TACVIEW_DEBUG_DUMP', 'gca_auth']) {
    assert.equal(env[key], undefined);
  }
  assert.equal(original.GCA_CONFIG, 'production.json');
});

test('check: runtime controls are preserved', () => {
  const env = childEnvironment({ PATH: 'test-path', NODE_OPTIONS: '--trace-warnings' }, 'test-cache');
  assert.equal(env.PATH, 'test-path');
  assert.equal(env.NODE_OPTIONS, '--trace-warnings');
});

test('check: the fixture has only loopback sources and no external runway API', () => {
  const config = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.equal(config.dcssb.enabled, false);
  assert.equal(config.dcssb.baseUrl, '');
  assert.equal(config.dcssb.apiKey, '');
  assert.equal(config.auth.token, '');
  assert.equal(config.sources.length, 1);
  assert.ok(config.sources.every((source) => source.tacview.host === '127.0.0.1'));
});
