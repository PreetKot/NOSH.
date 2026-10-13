import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ApiError, validateId, validatePayload, validatePublication } from './errors.js';

const asDish = (row) => row && ({ ...row, isPublished: Boolean(row.isPublished) });

export function openDatabase(filename = process.env.DATABASE_PATH || './data/nosh.sqlite') {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS dishes (
      dishId TEXT PRIMARY KEY NOT NULL,
      dishName TEXT NOT NULL,
      imageUrl TEXT NOT NULL,
      isPublished INTEGER NOT NULL CHECK (isPublished IN (0, 1)),
      version INTEGER NOT NULL CHECK (version > 0)
    ) STRICT;
  `);
  const list = db.prepare('SELECT * FROM dishes ORDER BY dishId');
  const get = db.prepare('SELECT * FROM dishes WHERE dishId = ?');
  const update = db.prepare(`UPDATE dishes SET dishName = ?, isPublished = ?, version = version + 1
    WHERE dishId = ? AND version = ? RETURNING *`);
  const insert = db.prepare(`INSERT INTO dishes (dishId, dishName, imageUrl, isPublished, version)
    VALUES (?, ?, ?, ?, 1) ON CONFLICT(dishId) DO NOTHING`);

  return {
    close: () => db.close(),
    list: () => list.all().map(asDish),
    seed(rows) {
      if (!Array.isArray(rows)) throw new Error('Seed JSON must be an array.');
      const ids = new Set();
      // Validate the entire file before writing anything.
      for (const row of rows) {
        if (!row || typeof row !== 'object') throw new Error('Every seed entry must be an object.');
        validateId(row.dishId);
        if (ids.has(row.dishId)) throw new Error(`Duplicate seed dishId: ${row.dishId}`);
        ids.add(row.dishId);
        if (typeof row.dishName !== 'string' || typeof row.imageUrl !== 'string' || typeof row.isPublished !== 'boolean') {
          throw new Error(`Invalid seed fields for dish ${row.dishId}.`);
        }
        validatePublication(row.dishName, row.imageUrl, row.isPublished);
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        let inserted = 0;
        for (const row of rows) inserted += Number(insert.run(row.dishId, row.dishName, row.imageUrl, Number(row.isPublished)).changes);
        db.exec('COMMIT');
        return { inserted, skipped: rows.length - inserted };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    patch(id, body) {
      validateId(id);
      validatePayload(body);
      // The write lock covers lookup, stored-image validation, and the conditional update.
      // The SQL version predicate also makes the compare-and-swap explicit.
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = asDish(get.get(id));
        if (!current) throw new ApiError(404, 'NOT_FOUND', `Dish ${id} was not found.`);
        if (current.version !== body.expectedVersion) {
          throw new ApiError(409, 'VERSION_CONFLICT', 'A newer update exists. Reload the dish before saving again.', current);
        }
        const name = body.dishName.trim();
        validatePublication(name, current.imageUrl, body.isPublished);
        const saved = asDish(update.get(name, Number(body.isPublished), id, body.expectedVersion));
        db.exec('COMMIT');
        return saved;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
}
