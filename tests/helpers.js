import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openDatabase } from '../server/database.js';

export const suppliedRows = JSON.parse(await readFile(new URL('../data/dishes.json', import.meta.url), 'utf8'));
export const invalidRows = JSON.parse(await readFile(new URL('./fixtures/invalid-image.json', import.meta.url), 'utf8'));

export async function fixture(t, { rows = suppliedRows, invalidImage = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'nosh-test-'));
  const filename = join(directory, 'dishes.sqlite');
  const db = openDatabase(filename);
  db.seed(rows);
  if (invalidImage) db.seed(invalidRows);
  db.close();
  t.after(() => rm(directory, { recursive: true, force: true }));
  return filename;
}

export async function startServer(filename, port = 0) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, DATABASE_PATH: filename, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  let timer;
  const url = await new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Server startup timed out: ${errors}`)), 10000);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Server exited (${code}): ${errors}`)));
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/Nosh dashboard: (http:\/\/[^\s]+)/);
      if (match) resolve(match[1]);
    });
  }).finally(() => clearTimeout(timer));
  return {
    url,
    port: Number(new URL(url).port),
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  };
}

export async function runningFixture(t, options) {
  const filename = await fixture(t, options);
  const server = await startServer(filename);
  t.after(() => server.stop());
  return { filename, ...server };
}

export async function patch(url, id = '1', body = { dishName: 'Updated dish', isPublished: true, expectedVersion: 1 }) {
  const response = await fetch(`${url}/dishes/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

export async function list(url) { return (await fetch(`${url}/dishes`)).json(); }
