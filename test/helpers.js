'use strict';

/* ---------------------------------------------------------------------------
 * Shared fixtures.
 *
 * Everything is built from example/, which ships with the repository, so the
 * suite never reads — or writes — whatever real state the machine happens to
 * have beside it.
 * ------------------------------------------------------------------------- */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EXAMPLE = path.join(ROOT, 'example');

// model.js is a plain browser script that also exports for node — see its
// last line — so the tests run the exact code the page runs.
const Model = require(path.join(ROOT, 'public/model.js'));

const readExample = (rel) => JSON.parse(fs.readFileSync(path.join(EXAMPLE, rel), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

/** A temporary state directory, removed by the caller. */
const tempState = () => fsp.mkdtemp(path.join(os.tmpdir(), 'journal-test-'));

/** A port nothing is listening on, for a server spawned by a test. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

module.exports = { ROOT, EXAMPLE, Model, readExample, clone, tempState, freePort };
