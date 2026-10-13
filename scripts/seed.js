import { readFile } from 'node:fs/promises';
import { openDatabase } from '../server/database.js';

let store;
try {
  const filename = process.env.SEED_FILE || './data/dishes.json';
  const rows = JSON.parse(await readFile(filename, 'utf8'));
  store = openDatabase();
  const { inserted, skipped } = store.seed(rows);
  console.log(`Seed complete: ${inserted} inserted, ${skipped} existing dishes preserved.`);
} catch (error) {
  console.error(`Seed failed: ${error.message}`);
  process.exitCode = 1;
} finally { store?.close(); }
