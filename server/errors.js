export class ApiError extends Error {
  constructor(status, code, message, currentDish) {
    super(message);
    this.status = status;
    this.code = code;
    this.currentDish = currentDish;
  }
}

export const badRequest = (message) => new ApiError(400, 'VALIDATION_ERROR', message);

export function validateId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
    throw badRequest('dishId must contain 1–64 letters, digits, underscores or hyphens, starting with a letter or digit.');
  }
}

export function validatePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('The request body must be a JSON object.');
  }
  const allowed = ['dishName', 'isPublished', 'expectedVersion'];
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw badRequest('Only dishName, isPublished and expectedVersion may be updated.');
  }
  if (typeof body.dishName !== 'string') throw badRequest('dishName is required and must be a string.');
  if (typeof body.isPublished !== 'boolean') throw badRequest('isPublished is required and must be a boolean.');
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) {
    throw badRequest('expectedVersion is required and must be a positive safe integer.');
  }
}

export function validatePublication(name, imageUrl, isPublished) {
  if (!isPublished) return;
  if (!name.trim()) throw badRequest('A published dish must have a non-empty name.');
  let url;
  try { url = new URL(imageUrl); } catch { /* Report the same clear validation error below. */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw badRequest('A published dish must have a valid HTTP/HTTPS image URL.');
  }
}
