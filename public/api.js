export class RequestError extends Error {
  constructor(message, status = 0, currentDish) {
    super(message);
    this.status = status;
    this.currentDish = currentDish;
  }
}

function isDish(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof value.dishId === 'string' && value.dishId.length > 0
    && typeof value.dishName === 'string' && typeof value.imageUrl === 'string'
    && typeof value.isPublished === 'boolean'
    && Number.isSafeInteger(value.version) && value.version > 0;
}

export async function request(path, options = {}) {
  let response;
  const timeout = AbortSignal.timeout(10000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try { response = await fetch(path, { ...options, signal, cache: 'no-store' }); }
  catch { throw new RequestError('Could not reach the server. Your draft is safe. Check the connection and try again.'); }
  let body;
  try { body = await response.json(); }
  catch {
    throw new RequestError(response.ok
      ? 'The server returned an unreadable response. Reload or try again.'
      : `The server returned an unreadable error (HTTP ${response.status}). Your draft is safe; try again.`, response.status);
  }
  if (!response.ok) {
    const message = typeof body?.error?.message === 'string'
      ? body.error.message : `Request failed (HTTP ${response.status}). Please try again.`;
    throw new RequestError(message, response.status, isDish(body?.currentDish) ? body.currentDish : undefined);
  }
  return body;
}

export async function getDishes(options = {}) {
  const dishes = await request('/dishes', options);
  if (!Array.isArray(dishes) || !dishes.every(isDish)
      || new Set(dishes.map((dish) => dish.dishId)).size !== dishes.length) {
    throw new RequestError('The server returned an invalid dish list. Please try again.');
  }
  return dishes;
}

export async function saveDish(id, draft, expectedVersion) {
  const saved = await request(`/dishes/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dishName: draft.dishName, isPublished: draft.isPublished, expectedVersion })
  });
  if (!isDish(saved) || saved.dishId !== id) {
    throw new RequestError('The server returned an invalid saved dish. Your draft is safe. Try saving again; a conflict may mean the earlier save succeeded.');
  }
  return saved;
}
