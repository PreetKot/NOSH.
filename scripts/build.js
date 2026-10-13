import { execFileSync } from 'node:child_process';
import { cp, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = new URL('../public/', import.meta.url);
const output = new URL('../dist/', import.meta.url);
const files = await readdir(source);
for (const file of files.filter((name) => name.endsWith('.js'))) {
  execFileSync(process.execPath, ['--check', fileURLToPath(new URL(file, source))], { stdio: 'inherit' });
}
// This frontend uses native browser modules: its build validates and stages the
// static assets without transpiling them or adding runtime dependencies.
await rm(output, { recursive: true, force: true });
await cp(source, output, { recursive: true });
console.log(`Frontend build complete: ${files.length} assets staged in dist/.`);
