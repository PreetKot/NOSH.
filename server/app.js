import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ApiError, badRequest, validateId } from './errors.js';

const publicRoot = new URL('../public/', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/api.js', ['api.js', 'text/javascript; charset=utf-8']],
  ['/sync.js', ['sync.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw badRequest('Content-Type must be application/json.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw badRequest('Request body must be at most 16 KiB.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw badRequest('Request body must contain valid JSON.'); }
}

export function createApp(store, { onError = console.error } = {}) {
  return createServer(async (req, res) => {
    try {
      // Route the original path so URL dot-segment normalization cannot turn an
      // invalid dishId (such as /dishes/..) into a different endpoint before validation.
      const path = req.url.split('?')[0];
      if (path === '/dishes' && req.method === 'GET') return json(res, 200, store.list());
      if (path.startsWith('/dishes/') && req.method === 'PATCH') {
        let id;
        try { id = decodeURIComponent(path.slice('/dishes/'.length)); }
        catch { throw badRequest('dishId contains invalid URL encoding.'); }
        validateId(id);
        return json(res, 200, store.patch(id, await readBody(req)));
      }
      if (assets.has(path) && ['GET', 'HEAD'].includes(req.method)) {
        const [filename, type] = assets.get(path);
        const content = await readFile(fileURLToPath(new URL(filename, publicRoot)));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
        return res.end(req.method === 'HEAD' ? undefined : content);
      }
      throw new ApiError(404, 'NOT_FOUND', 'Route was not found.');
    } catch (error) {
      if (res.destroyed || res.headersSent) return;
      if (error instanceof ApiError) {
        const body = { error: { code: error.code, message: error.message } };
        if (error.currentDish) body.currentDish = error.currentDish;
        return json(res, error.status, body);
      }
      onError(error);
      json(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'The server could not complete the request. Please try again.' } });
    }
  });
}
