/*
 * The HTTP surface, end to end.
 *
 * The server is started as a child process against an empty state directory,
 * so it seeds itself from example/ and every test runs against made-up data
 * rather than anybody's. S3 is switched off explicitly: a .env in the checkout
 * may name a real bucket, and a test that wrote to it would be a test that
 * edited the user's data.
 *
 *   node --test test/server.test.js
 */
'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { ROOT, tempState, freePort } = require('./helpers.js');

let proc = null;
let base = '';
let banner = '';
let stateDir = '';

before(async () => {
  stateDir = await tempState();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;

  proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      STATE_DIR: stateDir,
      PORT: String(port),
      HOST: '127.0.0.1',
      // Present-but-empty, so the server's .env loader leaves them alone and
      // the store falls through to the filesystem.
      S3_BUCKET: '', S3_PREFIX: '', S3_ENDPOINT: '',
      AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_SESSION_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${banner}`)), 10000);
    proc.stdout.on('data', (chunk) => {
      banner += chunk;
      if (banner.includes('State:')) { clearTimeout(timer); resolve(); }
    });
    proc.stderr.on('data', (chunk) => { banner += chunk; });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}:\n${banner}`)); });
  });
  // The banner's last lines land a tick after "State:"; give them a moment.
  await new Promise((r) => setTimeout(r, 50));
});

after(async () => {
  if (proc) proc.kill();
  if (stateDir) await fsp.rm(stateDir, { recursive: true, force: true });
});

const get = (p) => fetch(base + p);
const put = (p, body) => fetch(base + p, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const del = (p) => fetch(base + p, { method: 'DELETE' });
const state = async () => (await get('/api/state')).json();

describe('server', () => {
  test('an empty store is seeded from example/, and says so', async () => {
    assert.match(banner, /seeded from example\//);
    assert.match(banner, /\(file\)/, 'and on files, not a bucket');
    for (const f of ['config.json', 'data/days.json']) {
      await fsp.access(path.join(stateDir, f));
    }
  });

  test('/api/state hands over everything in one round trip', async () => {
    const res = await get('/api/state');
    assert.equal(res.status, 200);
    const s = await res.json();
    assert.ok(s.config, 'config');
    assert.ok(Array.isArray(s.days), 'days');
  });

  test('a record saves, and the version moves with it', async () => {
    const res = await put('/api/days/t-1', { id: 't-1', name: 'first' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).version, 1);
    const stored = (await state()).days.find((r) => r.id === 't-1');
    assert.equal(stored.name, 'first');
    assert.equal(stored.version, 1);
  });

  test('a stale client is refused, and told what it is missing', async () => {
    const stored = (await state()).days.find((r) => r.id === 't-1');
    const res = await put('/api/days/t-1', { ...stored, name: 'stale', version: stored.version - 1 });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /changed elsewhere/);
    assert.equal(body.version, stored.version, 'hands back the version it holds');
    assert.ok(body.record, 'and the record, so the client can reload');
  });

  test('an id that disagrees with the path is refused', async () => {
    const res = await put('/api/days/t-1', { id: 'other', version: 1 });
    assert.equal(res.status, 400);
  });

  test('several instances writing at once all survive', async () => {
    // The whole point of the conditional writes: two servers on one bucket must
    // not lose each other's edits. They share one file, so every write after
    // the first has to notice and redo itself.
    const ids = Array.from({ length: 12 }, (_, i) => `race-${i}`);
    const statuses = await Promise.all(ids.map((id) =>
      put(`/api/days/${id}`, { id, version: 0 }).then((r) => r.status)));
    assert.deepEqual([...new Set(statuses)], [200]);
    const stored = (await state()).days.map((r) => r.id);
    assert.deepEqual(ids.filter((id) => !stored.includes(id)), [], 'none were clobbered');
  });

  test('a delete needs the current version too', async () => {
    const stored = (await state()).days.find((r) => r.id === 't-1');
    assert.equal((await del(`/api/days/t-1?version=${stored.version + 5}`)).status, 409);
    assert.equal((await del(`/api/days/t-1?version=${stored.version}`)).status, 200);
    assert.equal((await del(`/api/days/t-1?version=${stored.version}`)).status, 404);
    assert.ok(!(await state()).days.some((r) => r.id === 't-1'));
  });

  test('config saves under the same version check', async () => {
    const { config } = await state();
    const ok = await put('/api/config', { ...config });
    assert.equal(ok.status, 200);
    const stale = await put('/api/config', { ...config });
    assert.equal(stale.status, 409);
  });

  describe('routing', () => {
    test('an unknown api route is 404, not the index page', async () => {
      const res = await get('/api/nope');
      assert.equal(res.status, 404);
      assert.match(res.headers.get('content-type'), /json/);
    });

    test('the app itself is served', async () => {
      const res = await get('/');
      assert.equal(res.status, 200);
      assert.match(await res.text(), /<title>Journal<\/title>/);
    });

    test('HEAD works, because health checks use it', async () => {
      const res = await fetch(base + '/api/state', { method: 'HEAD' });
      assert.equal(res.status, 200);
    });

    test('a path cannot climb out of public/', async () => {
      for (const p of ['/../server.js', '/..%2Fserver.js', '/public/../../.env']) {
        const res = await get(p);
        assert.ok(res.status === 403 || res.status === 404, `${p} returned ${res.status}`);
        assert.doesNotMatch(await res.text(), /AWS_SECRET|createStore/, `${p} leaked a file`);
      }
    });

    test('an unsupported method on a static path is refused', async () => {
      const res = await fetch(base + '/styles.css', { method: 'DELETE' });
      assert.equal(res.status, 405);
    });
  });
});
