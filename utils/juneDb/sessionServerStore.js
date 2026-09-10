'use strict';

/**
 * June DB storage adapter that authenticates with the JuneX session token.
 *
 * One-token mode: when JUNE_SESSION_TOKEN is set (and no DATABASE_URL / DB=
 * is configured), the bot's settings/kv data is stored on the session
 * server's June DB API under the session's own tenant. The user sets a
 * single secret string; no separate DB credential exists.
 *
 * This client is deliberately independent from the legacy June API client
 * code (juneApiAdapter/automaticJuneApi) — it speaks the same storage
 * protocol but only ever talks to the configured session server.
 */

const crypto = require('node:crypto');

class SessionServerStore {
  constructor({ token, baseUrl, fetchImpl = globalThis.fetch, requestTimeoutMs = 15_000 } = {}) {
    if (typeof token !== 'string' || !token.trim()) {
      throw new Error('A session token is required for session-server storage');
    }
    if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
      throw new Error('A session server URL is required for session-server storage');
    }
    this.token = token.trim();
    this.dbId = null; // resolved server-side; never configured locally
    this.baseUrl = baseUrl.trim().replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async request(path, { method = 'GET', body, idempotencyKey } = {}) {
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.token}`,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && method !== 'HEAD') {
      headers['Idempotency-Key'] = idempotencyKey || crypto.randomUUID();
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response;
    try {
      response = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    let payload = null;
    try { payload = await response.json(); }
    catch { payload = null; }
    if (!response.ok) {
      const error = new Error(payload?.message || `Session server returned HTTP ${response.status}`);
      error.status = response.status;
      error.code = payload?.error || 'request_failed';
      error.retryable = response.status === 0 || response.status === 408 || response.status === 429 || response.status >= 500;
      throw error;
    }
    return payload?.data === undefined ? payload : payload.data;
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

  close() { /* stateless HTTP client — nothing to close */ }
}

module.exports = { SessionServerStore };
