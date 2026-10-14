import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createConnection } from 'node:net';
import { openDatabase } from '../server/database.js';
import { createApp } from '../server/app.js';
import { suppliedRows, fixture, runningFixture, startServer, patch, list } from './helpers.js';

test('GET returns all supplied dishes with booleans and initial version 1', async (t) => {
  const app = await runningFixture(t);
  const dishes = await list(app.url);
  assert.equal(dishes.length, 5);
  assert.deepEqual(dishes, suppliedRows.map((row) => ({ ...row, version: 1 })));
});

test('real seed command inserts only missing IDs and preserves every field of saved edits', async (t) => {
  const app = await runningFixture(t, { rows: suppliedRows.slice(0, 1) });
  // Simulate an existing image edit only in this isolated temporary test database.
  // The assessment seed file remains unmodified; PATCH cannot change images.
  const fixtureDb = new DatabaseSync(app.filename);
  try {
    fixtureDb.prepare('UPDATE dishes SET imageUrl = ? WHERE dishId = ?')
      .run('https://example.test/edited-rice.jpg', '1');
  } finally { fixtureDb.close(); }
  const saved = await patch(app.url, '1', { dishName: '  Edited rice  ', isPublished: false, expectedVersion: 1 });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.dishName, 'Edited rice');
  assert.equal(saved.body.imageUrl, 'https://example.test/edited-rice.jpg');
  for (let i = 0; i < 2; i++) {
    const seeded = spawnSync(process.execPath, ['scripts/seed.js'], {
      cwd: new URL('../', import.meta.url), encoding: 'utf8',
      env: { ...process.env, DATABASE_PATH: app.filename, SEED_FILE: './data/dishes.json' }
    });
    assert.equal(seeded.status, 0, seeded.stderr);
    assert.ok(seeded.stdout.includes(i === 0
      ? '4 inserted, 1 existing dishes preserved'
      : '0 inserted, 5 existing dishes preserved'), seeded.stdout);
  }
  const dishes = await list(app.url);
  assert.equal(dishes.length, 5);
  assert.deepEqual(dishes[0], saved.body);
  assert.deepEqual(dishes.slice(1), suppliedRows.slice(1).map((row) => ({ ...row, version: 1 })));
});

test('successful explicit status saves persist through a real backend process restart', async (t) => {
  const app = await runningFixture(t);
  let result = await patch(app.url, '1', { dishName: 'Restart proof', isPublished: false, expectedVersion: 1 });
  assert.equal(result.body.version, 2);
  result = await patch(app.url, '1', { dishName: 'Restart proof', isPublished: false, expectedVersion: 2 });
  assert.equal(result.body.isPublished, false); // Same explicit value is not toggled.
  assert.equal(result.body.version, 3);
  await app.stop();
  const restarted = await startServer(app.filename);
  t.after(() => restarted.stop());
  assert.deepEqual((await list(restarted.url))[0], result.body);
});

test('backend shutdown closes speculative browser sockets without waiting for a request', async (t) => {
  const app = await runningFixture(t);
  const socket = createConnection({ host: '127.0.0.1', port: app.port });
  await once(socket, 'connect');
  let forced = false;
  const guard = setTimeout(() => { forced = true; socket.destroy(); }, 2000);
  try {
    await app.stop();
    assert.equal(forced, false, 'Shutdown must close a socket that has sent no HTTP data');
  } finally { clearTimeout(guard); socket.destroy(); }
});

test('empty published names and invalid stored image URLs are rejected without changes', async (t) => {
  const app = await runningFixture(t, { invalidImage: true });
  const before = await list(app.url);
  for (const dishName of ['', '   ', '\n\t']) {
    const result = await patch(app.url, '1', { dishName, isPublished: true, expectedVersion: 1 });
    assert.equal(result.status, 400);
    assert.match(result.body.error.message, /non-empty/);
  }
  const badImage = await patch(app.url, 'test-invalid-image', { dishName: 'Valid name', isPublished: true, expectedVersion: 1 });
  assert.equal(badImage.status, 400);
  assert.match(badImage.body.error.message, /HTTP\/HTTPS/);
  assert.deepEqual(await list(app.url), before);
});

test('unpublished dishes may have empty names; names are trimmed on all saves', async (t) => {
  const app = await runningFixture(t);
  const result = await patch(app.url, '1', { dishName: '  \t ', isPublished: false, expectedVersion: 1 });
  assert.equal(result.status, 200);
  assert.equal(result.body.dishName, '');
  assert.equal(result.body.version, 2);
});

test('required fields, types, positive safe versions and extra fields are validated', async (t) => {
  const app = await runningFixture(t);
  const before = await list(app.url);
  const valid = { dishName: 'Rice', isPublished: true, expectedVersion: 1 };
  const invalid = [null, [], 'bad', {}, { ...valid, dishName: null }, { ...valid, dishName: 123 },
    { ...valid, isPublished: 'true' }, { ...valid, isPublished: 1 }, { ...valid, expectedVersion: '1' },
    { ...valid, expectedVersion: 0 }, { ...valid, expectedVersion: -1 }, { ...valid, expectedVersion: 1.5 },
    { ...valid, expectedVersion: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, imageUrl: 'https://example.com' }];
  for (const field of Object.keys(valid)) {
    const missing = { ...valid }; delete missing[field]; invalid.push(missing);
  }
  for (const body of invalid) {
    const result = await patch(app.url, '1', body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(result.body.error.code, 'VALIDATION_ERROR');
    assert.equal(typeof result.body.error.message, 'string');
  }
  assert.deepEqual(await list(app.url), before);
});

test('invalid identifiers return 400; syntactically valid unknown identifiers return 404', async (t) => {
  const app = await runningFixture(t);
  const before = await list(app.url);
  for (const id of ['', '%20', '%2F', '%ZZ', '-starts-with-dash', 'x'.repeat(65)]) {
    assert.equal((await patch(app.url, id)).status, 400, id);
  }
  const missing = await patch(app.url, 'unknown');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
  assert.deepEqual(await list(app.url), before);
});

test('raw dot-segment identifiers return JSON 400 without being normalized into another route', async (t) => {
  const app = await runningFixture(t);
  const before = await list(app.url);
  // fetch normalizes dot segments before sending. Use raw HTTP paths to test the server.
  for (const id of ['.', '..', '%2e', '%2e%2e']) {
    const response = await new Promise((resolve, reject) => {
      const req = httpRequest(app.url, {
        method: 'PATCH', path: `/dishes/${id}`,
        headers: { 'Content-Type': 'application/json' }
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(JSON.stringify({ dishName: 'Must not save', isPublished: false, expectedVersion: 1 }));
    });
    assert.equal(response.status, 400, id);
    assert.equal(JSON.parse(response.body).error.code, 'VALIDATION_ERROR');
  }
  assert.deepEqual(await list(app.url), before);
});

test('malformed JSON, wrong content type, and oversized bodies return clear 400 errors', async (t) => {
  const app = await runningFixture(t);
  for (const [body, type] of [['{', 'application/json'], ['{}', 'text/plain'], ['x'.repeat(16385), 'application/json']]) {
    const response = await fetch(`${app.url}/dishes/1`, { method: 'PATCH', headers: { 'Content-Type': type }, body });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'VALIDATION_ERROR');
  }
  assert.deepEqual(await list(app.url), suppliedRows.map((row) => ({ ...row, version: 1 })));
});

test('a stale update returns currentDish and leaves the winner unchanged', async (t) => {
  const app = await runningFixture(t);
  const winner = await patch(app.url, '1', { dishName: 'Winner', isPublished: false, expectedVersion: 1 });
  const loser = await patch(app.url, '1', { dishName: 'Losing draft', isPublished: true, expectedVersion: 1 });
  assert.equal(loser.status, 409);
  assert.equal(loser.body.error.code, 'VERSION_CONFLICT');
  assert.deepEqual(loser.body.currentDish, winner.body);
  assert.deepEqual((await list(app.url))[0], winner.body);
});

test('simultaneous same-version writes through separate backend processes have one winner', async (t) => {
  const filename = await fixture(t);
  const a = await startServer(filename);
  const b = await startServer(filename);
  t.after(async () => { await a.stop(); await b.stop(); });
  const results = await Promise.all([
    patch(a.url, '1', { dishName: 'Concurrent A', isPublished: false, expectedVersion: 1 }),
    patch(b.url, '1', { dishName: 'Concurrent B', isPublished: true, expectedVersion: 1 })
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const winner = results.find((result) => result.status === 200).body;
  assert.equal(winner.version, 2);
  assert.deepEqual(results.find((result) => result.status === 409).body.currentDish, winner);
  assert.deepEqual((await list(a.url))[0], winner);
});

test('an invalid seed file cannot partially insert or overwrite dishes', async (t) => {
  const filename = await fixture(t);
  const db = openDatabase(filename);
  t.after(() => db.close());
  const before = db.list();
  assert.throws(() => db.seed([{ ...suppliedRows[0], dishId: 'new' }, { dishId: 'bad' }]));
  assert.deepEqual(db.list(), before);
  assert.throws(() => db.seed([suppliedRows[0], suppliedRows[0]]), /Duplicate/);
});

test('unexpected server failures return JSON 500 without exposing internals', async (t) => {
  const errors = [];
  const server = createApp({ list() { throw new Error('private database detail'); } }, { onError: (error) => errors.push(error) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/dishes`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: { code: 'INTERNAL_ERROR', message: 'The server could not complete the request. Please try again.' } });
  assert.equal(errors.length, 1);
});
