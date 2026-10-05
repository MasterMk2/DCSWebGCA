'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { childEnvironment, FIXTURE } = require('../tools/check');

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
