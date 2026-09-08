'use strict';

const crypto = require('node:crypto');

// Default distribution endpoint. storageSelector permits an explicit
// JUNE_DB_API_URL override for isolated staging deployments.
const INTERNAL_JUNE_API_URL = 'https://dbapi-ociq.onrender.com';

class JuneApiError extends Error {
  constructor(message, { status = 0, code = 'request_failed', details = null } = {}) {
    super(message);
    this.name = 'JuneApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryable = status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
  }
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

class JuneApiStore {
  constructor({
    token,
    dbId = null,
    baseUrl = INTERNAL_JUNE_API_URL,
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = 15_000,
  } = {}) {
    this.token = requireString(token, 'token');
    this.dbId = dbId || null;
    this.baseUrl = requireString(baseUrl, 'baseUrl').replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('A fetch implementation is required');
    }
  }

  async request(path, { method = 'GET', body, idempotencyKey } = {}) {
    const headers = { Accept: 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && method !== 'HEAD') {
      // One identity per logical operation, reused across transport retries.
      headers['Idempotency-Key'] = idempotencyKey || crypto.randomUUID();
    }
    const attempts = path === '/v1/installations/register' ? 1 : 3;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      let retryDelay = 100 * (2 ** attempt);
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        const retryAfter = Number(response.headers?.get?.('retry-after'));
        if (Number.isFinite(retryAfter) && retryAfter > 0) retryDelay = Math.min(30000, retryAfter * 1000);
        const text = await response.text(); // Timeout includes receiving the response body.
        let payload = null;
        try { payload = text ? JSON.parse(text) : null; }
        catch { throw new JuneApiError('June API returned invalid JSON', { status: response.status }); }
        if (!response.ok) {
          throw new JuneApiError(payload?.message || `June API returned HTTP ${response.status}`, {
            status: response.status, code: payload?.error || 'request_failed', details: payload,
          });
        }
        return payload?.data === undefined ? payload : payload.data;
      } catch (cause) {
        const error = cause instanceof JuneApiError ? cause : new JuneApiError(`June API request failed: ${cause.message}`);
        if (!error.retryable || attempt === attempts - 1) throw error;
      } finally {
        clearTimeout(timer);
      }
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }

  static async register({ activationCode, baseUrl = INTERNAL_JUNE_API_URL, fetchImpl } = {}) {
    const store = Object.create(JuneApiStore.prototype);
    store.baseUrl = requireString(baseUrl, 'baseUrl').replace(/\/+$/, '');
    store.fetchImpl = fetchImpl || globalThis.fetch;
    store.requestTimeoutMs = 15_000;
    const result = await store.request('/v1/installations/register', {
      method: 'POST',
      body: { activationCode: requireString(activationCode, 'activationCode') },
    });
    return result;
  }

  static async recover({ recoveryToken, baseUrl = INTERNAL_JUNE_API_URL, fetchImpl } = {}) {
    const store = Object.create(JuneApiStore.prototype);
    store.baseUrl = requireString(baseUrl, 'baseUrl').replace(/\/+$/, '');
    store.fetchImpl = fetchImpl || globalThis.fetch;
    store.requestTimeoutMs = 15_000;
    return store.request('/v1/installations/recover', {
      method: 'POST',
      body: { recoveryToken: requireString(recoveryToken, 'recoveryToken') },
    });
  }

  status() {
    return this.request('/v1/installation');
  }

  heartbeat() {
    return this.request('/v1/heartbeat', { method: 'POST', body: {} });
  }

  get(resource, key) {
    return this.request(`/v1/storage/${encodeURIComponent(resource)}/${encodeURIComponent(key)}`);
  }

  list(resource, { limit, cursor, prefix } = {}) {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', limit);
    if (cursor) params.set('cursor', cursor);
    if (prefix) params.set('prefix', prefix);
    const query = params.size ? `?${params}` : '';
    return this.request(`/v1/storage/${encodeURIComponent(resource)}${query}`);
  }

  put(resource, key, value, { expectedVersion, idempotencyKey } = {}) {
    const body = { value };
    if (expectedVersion !== undefined) body.expectedVersion = expectedVersion;
    return this.request(`/v1/storage/${encodeURIComponent(resource)}/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body,
      idempotencyKey,
    });
  }

  delete(resource, key, { expectedVersion, idempotencyKey } = {}) {
    const body = expectedVersion === undefined ? {} : { expectedVersion };
    return this.request(`/v1/storage/${encodeURIComponent(resource)}/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      body,
      idempotencyKey,
    });
  }

  snapshot({ limit, cursor, prefix } = {}) {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', limit);
    if (cursor) params.set('cursor', cursor);
    if (prefix) params.set('prefix', prefix);
    const query = params.size ? `?${params}` : '';
    return this.request(`/v1/storage/snapshot${query}`);
  }

  batch(records, { mode = 'upsert', idempotencyKey } = {}) {
    return this.request('/v1/storage/batch', {
      method: 'PUT',
      body: { mode, records },
      idempotencyKey,
    });
  }

  reset({ resources, clearAuthState = false, idempotencyKey } = {}) {
    const body = { clearAuthState };
    if (resources !== undefined) body.resources = resources;
    return this.request('/v1/storage/reset', {
      method: 'POST',
      body,
      idempotencyKey,
    });
  }

  getAuthState() {
    return this.request('/v1/auth-state');
  }

  putAuthState(state, { expectedVersion, idempotencyKey } = {}) {
    const body = { ...state };
    if (expectedVersion !== undefined) body.expectedVersion = expectedVersion;
    return this.request('/v1/auth-state', {
      method: 'PUT',
      body,
      idempotencyKey,
    });
  }

  deleteAuthState({ idempotencyKey } = {}) {
    return this.request('/v1/auth-state', {
      method: 'DELETE',
      body: {},
      idempotencyKey,
    });
  }

  getLegacySession() {
    return this.request('/v1/auth-state/legacy-session');
  }

  putLegacySession(legacySession, { idempotencyKey } = {}) {
    return this.request('/v1/auth-state/legacy-session', {
      method: 'PUT',
      body: { legacySession },
      idempotencyKey,
    });
  }

  clearLegacySession({ idempotencyKey } = {}) {
    return this.request('/v1/auth-state/legacy-session', {
      method: 'DELETE',
      body: {},
      idempotencyKey,
    });
  }
}

module.exports = {
  INTERNAL_JUNE_API_URL,
  JuneApiError,
  JuneApiStore,
};