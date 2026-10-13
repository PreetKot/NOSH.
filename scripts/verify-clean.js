import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'nosh-clean-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const env = { ...process.env, npm_config_cache: join(directory, 'npm-cache') };
for (const key of ['DATABASE_PATH', 'SEED_FILE', 'HOST', 'PORT', 'NODE_ENV']) delete env[key];
let child;

function run(...args) {
  console.log(`Running: npm ${args.join(' ')}`);
  const result = execFileSync(npm, args, { cwd: directory, env, encoding: 'utf8', timeout: 120000 });
  process.stdout.write(result);
  return result;
}

async function start() {
  console.log('Running: PORT=0 npm start');
  child = spawn(npm, ['start'], {
    cwd: directory, env: { ...env, PORT: '0' },
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  let timer;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Startup timeout: ${errors}`)), 15000);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Startup exited ${code}: ${errors}`)));
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/Nosh dashboard: (http:\/\/[^\s]+)/);
      if (match) resolve(match[1]);
    });
  }).finally(() => clearTimeout(timer));
}

async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  // npm start owns a shell and backend child; stop only this verification's group.
  if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f']);
  else process.kill(-child.pid, 'SIGTERM');
  await exited;
}

async function dishes(url) {
  const response = await fetch(`${url}/dishes`, { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  return response.json();
}

try {
  for (const entry of ['package.json', 'package-lock.json', '.env.example', 'server', 'public', 'scripts', 'tests']) {
    await cp(new URL(entry, root), join(directory, entry), { recursive: true });
  }
  await mkdir(join(directory, 'data'));
  await cp(new URL('data/dishes.json', root), join(directory, 'data/dishes.json'));
  await cp(join(directory, '.env.example'), join(directory, '.env'));
  // No copied node_modules, database, real .env, or existing npm cache.
  run('ci');
  run('run', 'build');
  assert.match(run('run', 'seed'), /5 inserted, 0 existing dishes preserved/);
  assert.match(run('run', 'seed'), /0 inserted, 5 existing dishes preserved/);
  let url = await start();
  for (const path of ['/', '/app.js', '/api.js', '/styles.css']) {
    assert.equal((await fetch(`${url}${path}`, { signal: AbortSignal.timeout(10000) })).status, 200, path);
  }
  const supplied = JSON.parse(await readFile(new URL('data/dishes.json', root), 'utf8'));
  assert.deepEqual(await dishes(url), supplied.map((row) => ({ ...row, version: 1 })));
  const response = await fetch(`${url}/dishes/1`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dishName: 'Clean setup saved edit', isPublished: false, expectedVersion: 1 }),
    signal: AbortSignal.timeout(10000)
  });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.version, 2);
  assert.match(run('run', 'seed'), /0 inserted, 5 existing dishes preserved/);
  assert.deepEqual((await dishes(url))[0], saved);
  await stop();
  url = await start();
  assert.deepEqual((await dishes(url))[0], saved);
  console.log('PASS: clean install/build/seed/start, static HTTP 200, GET fields, idempotent reseed preserving edits, restart persistence.');
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true });
}
