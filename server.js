'use strict';

/* ---------------------------------------------------------------------------
 * Journal — a local, single-user app.
 *
 * Same shape as `tracker` and `finances`: no dependencies, no build step, all
 * the logic in the browser. The server hands over stored state and writes it
 * back, refusing a write from a client that has fallen behind.
 * ------------------------------------------------------------------------- */

const http = require('node:http');
const os = require('node:os');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { loadEnv } = require('./lib/env.js');
const { createStore, StoreConflict, KEYS: STORE_KEYS } = require('./lib/store.js');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const ENV_PATH = path.join(ROOT, '.env');

// A missing .env is fine; the real environment always wins. See lib/env.js.
loadEnv(ENV_PATH);

// Writable state. Defaults to the project directory, which is the layout when
// running from a checkout. Point STATE_DIR at a mounted volume to containerise
// — and note it must be a *directory*: saves write a temp file and rename over
// the target, which fails against a bind-mounted file. Ignored entirely when
// S3_BUCKET names a bucket.
const STATE_DIR = process.env.STATE_DIR ? path.resolve(process.env.STATE_DIR) : ROOT;

const PORT = Number(process.env.PORT || 4176);

// Listens on every interface so the app is reachable from a phone on the same
// network, or over a Tailscale link. There is no authentication, so anyone who
// can reach the port can read and rewrite everything — set HOST=127.0.0.1 in
// .env to go back to this machine only.
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const MAX_BODY_BYTES = 4 * 1024 * 1024;

// --- storage ----------------------------------------------------------------
//
// Everything goes through lib/store.js, which is either the local filesystem or
// an S3-compatible bucket depending on the environment. The bucket is what lets
// the laptop and the phone be the same app; see mutate() for what keeps them
// from overwriting each other.

const store = createStore(process.env, STATE_DIR);

async function readValue(key, fallback) {
  const { value } = await store.read(key);
  return value === undefined ? fallback : value;
}

const readConfig = () => readValue('config');
const readCollection = () => readValue('days', []);

/**
 * Read, change, write — retrying when another instance writes in between.
 *
 * `change` runs again on a fresh read each time, so a retry re-applies the
 * change to what is there now rather than to the copy it started from. That
 * distinction is the whole point: two instances saving different things at the
 * same moment is nobody's mistake and should just work, while a stale tab
 * trying to overwrite an edit it never saw has to be reported. The first is a
 * retry, the second is `{ reject }`.
 *
 * `change` must build a fresh value rather than mutating what it was handed,
 * or a retry compounds the previous attempt's edits on top of the new read.
 */
async function mutate(key, fallback, change, attempts = 8) {
  for (let attempt = 1; ; attempt++) {
    const { value, token } = await store.read(key);
    const outcome = await change(value === undefined ? fallback : value);
    if (outcome.reject) return outcome;
    try {
      await store.write(key, outcome.value, token);
      return outcome;
    } catch (err) {
      if (!(err instanceof StoreConflict) || attempt >= attempts) throw err;
      // Jittered, so writers who collided once do not line up and collide again.
      await new Promise((r) => setTimeout(r, attempt * 10 + Math.random() * 20));
    }
  }
}

// --- server -----------------------------------------------------------------

const ID = /^[\w-]+$/;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  try {
    // Everything the browser needs to render, in one round trip.
    if (pathname === '/api/state' && (req.method === 'GET' || req.method === 'HEAD')) {
      const [config, days] = await Promise.all([readConfig(), readCollection()]);
      return json(res, 200, { config, days });
    }

    if (pathname === '/api/config' && req.method === 'PUT') {
      const incoming = JSON.parse(await readBody(req) || '{}');

      // Optimistic concurrency. The client echoes back the version it loaded;
      // if the stored copy has moved on since, another writer got there first
      // and this request would silently overwrite them. Reject instead, and
      // hand back the current state so the client can reload rather than guess.
      const out = await mutate('config', undefined, (current) => {
        const held = Number(current.version) || 0;
        const sent = Number(incoming.version) || 0;
        if (sent !== held) {
          return { reject: {
            error: `config was changed elsewhere (you have v${sent}, the stored copy is v${held})`,
            version: held,
            config: current,
          } };
        }
        return { value: { ...current, ...incoming, version: held + 1 } };
      });
      if (out.reject) return json(res, 409, out.reject);
      return json(res, 200, { saved: true, version: out.value.version });
    }

    // Upsert one record by id. The browser owns identity and all arithmetic;
    // the server only keeps two devices from clobbering each other.
    const match = pathname.match(/^\/api\/days\/([\w-]+)$/);
    if (match && req.method === 'PUT') {
      const id = match[1];
      const incoming = JSON.parse(await readBody(req) || '{}');
      if (incoming.id !== id) return json(res, 400, { error: 'id mismatch' });

      const out = await mutate('days', [], (records) => {
        const at = records.findIndex((r) => r.id === id);
        const stored = at === -1 ? null : records[at];
        const held = stored ? Number(stored.version) || 0 : 0;
        const sent = Number(incoming.version) || 0;
        if (stored && sent !== held) {
          return { reject: {
            error: `${id} was changed elsewhere (you have v${sent}, the stored copy is v${held})`,
            version: held,
            record: stored,
          } };
        }
        // A fresh array and a fresh record each time: mutating `incoming` would
        // bump its version again on every retry.
        const saved = { ...incoming, version: held + 1 };
        const next = [...records];
        if (at === -1) next.push(saved); else next[at] = saved;
        return { value: next, record: saved };
      });
      if (out.reject) return json(res, 409, out.reject);
      return json(res, 200, { saved: true, id, version: out.record.version, record: out.record });
    }

    // Delete one record. The version travels in the query — a DELETE body is
    // legal but fetch() and proxies disagree about it — and has to match, so a
    // stale tab cannot remove an edit it never saw.
    if (match && req.method === 'DELETE') {
      const id = match[1];
      const sent = Number(url.searchParams.get('version')) || 0;
      const out = await mutate('days', [], (records) => {
        const stored = records.find((r) => r.id === id);
        if (!stored) return { value: records, missing: true };
        const held = Number(stored.version) || 0;
        if (sent !== held) {
          return { reject: { error: `${id} was changed elsewhere`, version: held, record: stored } };
        }
        return { value: records.filter((r) => r.id !== id) };
      });
      if (out.reject) return json(res, 409, out.reject);
      return json(res, out.missing ? 404 : 200, { deleted: !out.missing, id });
    }

    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
    // HEAD is GET without a body. Proxies, health checks and uptime monitors
    // all use it, and rejecting it makes a working route look broken.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'Method not allowed' });
    }

    const rel = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Forbidden' });

    const data = await fsp.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    return res.end(req.method === 'HEAD' ? undefined : data);
  } catch (err) {
    if (err.code === 'ENOENT') return json(res, 404, { error: 'Not found' });
    // Lost the race often enough to give up. That is a conflict, not a fault,
    // and 409 is what the client already knows how to recover from.
    if (err instanceof StoreConflict) {
      return json(res, 409, { error: 'the state is being written from somewhere else — reload and try again' });
    }
    console.error(err);
    return json(res, 500, { error: err.message });
  }
});

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY_BYTES) reject(new Error('Body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * A store with no config in it gets the example data, so that a fresh checkout
 * runs with `node server.js` and nothing else. Seeding writes each document
 * only if it is genuinely absent — the store refuses a create when something is
 * already there — so pointing at a bucket that already holds real state can
 * never overwrite it.
 */
async function seedIfEmpty() {
  const { value } = await store.read('config');
  if (value !== undefined) return false;

  const examples = path.join(ROOT, 'example');
  for (const [key, rel] of Object.entries(STORE_KEYS)) {
    let raw;
    try {
      raw = await fsp.readFile(path.join(examples, rel), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    try {
      await store.write(key, JSON.parse(raw), null);
    } catch (err) {
      // Another instance seeded it a moment ago. Theirs is as good as ours.
      if (!(err instanceof StoreConflict)) throw err;
    }
  }
  return true;
}

/** Every non-internal IPv4 address, so the reachable URLs can be printed. */
function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
}

async function start() {
  let seeded;
  try {
    seeded = await seedIfEmpty();
  } catch (err) {
    console.error(`Could not reach the state store at ${store.describe()}`);
    console.error(`  ${err.message}`);
    process.exit(1);
  }

  server.listen(PORT, HOST, () => {
    console.log(`Journal → http://127.0.0.1:${PORT}`);
    if (HOST !== '127.0.0.1') {
      for (const address of lanAddresses()) console.log(`         → http://${address}:${PORT}`);
      console.log('Reachable from other devices on this network. No login — set HOST=127.0.0.1 to restrict.');
    }
    console.log(`State:   ${store.describe()} (${store.kind})`);
    if (seeded) console.log('         seeded from example/ — this is made-up data, not yours.');
  });
}

start();
