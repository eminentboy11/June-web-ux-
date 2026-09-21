'use strict';

const crypto = require('crypto');
const zlib = require('zlib');

let BufferJSON = null;
try { ({ BufferJSON } = require('@whiskeysockets/baileys/lib/Utils/generics')); } catch (_) {}

const TOKEN_PREFIX = 'june-ultra:';
const TOKEN_LABEL_PATTERN = /^[A-Za-z0-9_-]{3,24}$/;
const TOKEN_BODY_PATTERN = /^[A-Za-z0-9]{24}$/;
const DEFAULT_SESSION_SERVER_URL = 'https://burning-lorena-eminentbo-ede53cc1.koyeb.app';
const DEFAULT_TIMEOUT_MS = 20000;
const PUSH_DEBOUNCE_MS = 2000;
const HEARTBEAT_INTERVAL_MS = 60000;
const HANDLE_PATTERN = /^JUNE(?:-X)?~[A-Za-z0-9]{4,12}$/i;
const HANDLE_BODY_STRIP = /^june(?:-x)?~/i;
const AUTH_KEY_TYPES = [
  'app-state-sync-version', 'app-state-sync-key', 'sender-key-memory',
  'sender-key', 'identity-key', 'device-list', 'lid-mapping',
  'pre-key', 'session', 'tctoken',
];

// ─── Errors ─────────────────────────────────────────────────────────────────

class SessionServerError extends Error {
  constructor(message, { status = 0, code = 'request_failed' } = {}) {
    super(message);
    this.name = 'SessionServerError';
    this.status = status;
    this.code = code;
    this.retryable = status === 0 || status === 408 || status === 429 || status >= 500;
    this.terminal = [
      'token_invalid', 'token_revoked', 'token_expired',
      'session_revoked', 'session_expired', 'session_state_missing',
    ].includes(code);
  }
}

// ─── Format helpers ─────────────────────────────────────────────────────────

function parseSessionServerToken(value) {
  const raw = String(value || '').trim();
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  const rest = raw.slice(TOKEN_PREFIX.length);
  const tilde = rest.indexOf('~');
  if (tilde === -1) return null;
  const label = tilde === 0 ? '' : rest.slice(0, tilde).replace(/:$/, '');
  const body = rest.slice(tilde + 1);
  if (label !== '' && !TOKEN_LABEL_PATTERN.test(label)) return null;
  if (!TOKEN_BODY_PATTERN.test(body)) return null;
  return { label: label || null, body };
}

function isSessionServerToken(value) {
  return parseSessionServerToken(value) !== null;
}

function isJuneHandle(value) {
  return HANDLE_PATTERN.test(String(value || '').trim());
}

const handleBody = (value) => String(value || '').trim().replace(HANDLE_BODY_STRIP, '').toLowerCase();

function describeTokenProblem(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'empty';
  if (raw.startsWith('June-Ultra:~') || raw.startsWith('Ultra-X:~') || raw.startsWith('JUNE-MD:~')) {
    return 'legacy-string-in-token-var';
  }
  if (/^june(?:-x)?~/i.test(raw)) {
    const body = raw.replace(HANDLE_BODY_STRIP, '');
    if (!body) return 'june-handle-empty (expected JUNE-X~ + 6 letters/digits)';
    if (body.length < 4 || body.length > 12) return `june-handle-bad-length (${body.length} after ~, expected 6)`;
    return 'june-handle-charset (only letters/digits after JUNE-X~)';
  }
  if (!raw.startsWith(TOKEN_PREFIX)) {
    if (raw.toLowerCase().startsWith(TOKEN_PREFIX)) return 'wrong-case';
    return 'missing-prefix';
  }
  const rest = raw.slice(TOKEN_PREFIX.length);
  const tilde = rest.indexOf('~');
  if (tilde === -1) return 'missing ~ separator (expected june-ultra:<id>:~<24 chars> or june-ultra:~<24 chars>)';
  const label = rest.slice(0, tilde);
  const body = rest.slice(tilde + 1);
  if (label !== '' && !TOKEN_LABEL_PATTERN.test(label)) {
    return `bad custom id "${label.slice(0, 20)}" (3-24 chars: letters, numbers, - or _)`;
  }
  if (body.length !== 24) return `bad-length (${body.length} after ~, expected 24)`;
  return 'bad-charset';
}

function tokenBotIdSuffix(value) {
  const raw = String(value || '').trim();
  if (isJuneHandle(raw)) return sha256Hex(handleBody(raw)).slice(0, 12);
  const parsed = parseSessionServerToken(value);
  if (!parsed) return null;
  return sha256Hex(parsed.body).slice(0, 12);
}

function getServerUrl() {
  const override = String(process.env.JUNE_SESSION_SERVER_URL || '').trim().replace(/\/+$/, '');
  return override || DEFAULT_SESSION_SERVER_URL;
}

function getConfiguredToken() {
  const fromEnv = String(process.env.JUNE_SESSION_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const sessionId = String(process.env.SESSION_ID || '').trim();
  return (isSessionServerToken(sessionId) || isJuneHandle(sessionId)) ? sessionId : '';
}

function isTokenModeActive() {
  if (state.offlineMode) return false;
  const token = getConfiguredToken();
  return isSessionServerToken(token) || isJuneHandle(token);
}

function markOfflineMode() {
  state.offlineMode = true;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function getInstallationId(db) {
  if (state.installationId && state.installationIdSource === 'kv') return state.installationId;
  const readDb = db || state.lastDb;
  if (readDb) {
    try {
      const existing = String(readDb.prepare(
        "SELECT value FROM kv_store WHERE namespace = 'session-server' AND key = 'installation-id'"
      ).get()?.value || '').trim();
      let id;
      if (existing.length >= 8) {
        id = existing;
      } else {
        id = state.installationId || crypto.randomUUID();
        readDb.prepare(
          "INSERT OR REPLACE INTO kv_store (namespace, key, value) VALUES ('session-server', 'installation-id', ?)"
        ).run(id);
      }
      state.installationId = id;
      state.installationIdSource = 'kv';
      return id;
    } catch (_) {}
  }
  if (!state.installationId) {
    const os = require('os');
    state.installationId = sha256Hex(`${os.hostname()}|${__dirname}`).slice(0, 24);
    state.installationIdSource = 'fallback';
  }
  return state.installationId;
}

function throttleLog(message, everyMs = 60000) {
  const now = Date.now();
  if (state.lastLogAt[message] && now - state.lastLogAt[message] < everyMs) return;
  state.lastLogAt[message] = now;
  (global.log || console.log)(message, 'cyan');
}

// ─── Module state ───────────────────────────────────────────────────────────

const state = {
  leaseToken: null,
  leaseExpiresAt: 0,
  leaseId: null,
  sessionId: null,
  sessionMeta: null,
  version: null,
  installationId: null,
  installationIdSource: null,
  everAuthenticated: false,
  lastDb: null,
  authPromise: null,
  pushTimer: null,
  pushing: false,
  heartbeatTimer: null,
  lastLogAt: Object.create(null),
  terminalFailure: null,
  revoked: false,
  offlineMode: false,
};

function resetLease() {
  state.leaseToken = null;
  state.leaseExpiresAt = 0;
  state.leaseId = null;
  state.sessionId = null;
  state.sessionMeta = null;
  state.version = null;
}

// ─── Transport ──────────────────────────────────────────────────────────────

async function rawRequest(url, { method = 'GET', body, idempotencyKey } = {}) {
  const headers = { Accept: 'application/json' };
  if (state.leaseToken) headers.Authorization = `Bearer ${state.leaseToken}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') {
    headers['Idempotency-Key'] = idempotencyKey || crypto.randomUUID();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_) {
      throw new SessionServerError('Session Server returned invalid JSON', { status: response.status });
    }
    if (!response.ok || payload?.ok === false) {
      throw new SessionServerError(
        payload?.message || `Session Server returned HTTP ${response.status}`,
        { status: response.status, code: payload?.error || 'request_failed' },
      );
    }
    return payload?.data !== undefined ? payload.data : payload;
  } catch (cause) {
    if (cause instanceof SessionServerError) throw cause;
    throw new SessionServerError(`Session Server unreachable: ${cause.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function request(path, { method = 'GET', body, idempotencyKey, allowReauth = true } = {}) {
  const serverUrl = getServerUrl();
  if (!serverUrl) throw new SessionServerError('JUNE_SESSION_SERVER_URL is not configured');
  if (state.terminalFailure) throw state.terminalFailure;

  if (!state.leaseToken || Date.now() >= state.leaseExpiresAt - 60000) {
    await authenticate();
  }
  try {
    return await rawRequest(`${serverUrl}${path}`, { method, body, idempotencyKey });
  } catch (error) {
    if (error.status === 401 && allowReauth && !error.terminal) {
      resetLease();
      await authenticate({ db: state.lastDb, takeover: false });
      return rawRequest(`${serverUrl}${path}`, { method, body, idempotencyKey });
    }
    if (error.terminal) rememberTerminalFailure(error);
    throw error;
  }
}

function rememberTerminalFailure(error) {
  if (!state.terminalFailure) {
    state.terminalFailure = error;
    resetLease();
    stopHeartbeat();
  }
}

// ─── Authentication ─────────────────────────────────────────────────────────

async function authenticate({ takeover = false, db = null } = {}) {
  if (state.revoked) throw new SessionServerError('Session was revoked', { code: 'session_revoked' });
  if (state.terminalFailure) throw state.terminalFailure;
  if (state.authPromise) return state.authPromise;
  if (db) state.lastDb = db;

  const token = getConfiguredToken();
  const serverUrl = getServerUrl();
  if (!isSessionServerToken(token) && !isJuneHandle(token)) {
    throw new SessionServerError('No valid JUNE_SESSION_TOKEN or JUNE~ Session ID configured');
  }
  if (!serverUrl) throw new SessionServerError('JUNE_SESSION_SERVER_URL is not configured');

  if (isJuneHandle(token)) {
    state.authPromise = Promise.resolve().then(() => {
      state.leaseToken = token;
      state.leaseExpiresAt = Date.now() + 20 * 60 * 1000;
      state.sessionId = null;
      state.sessionMeta = null;
      state.terminalFailure = null;
      state.everAuthenticated = true;
      return { session: null, lease: { token, expiresAt: state.leaseExpiresAt } };
    }).finally(() => { state.authPromise = null; });
    return state.authPromise;
  }

  state.authPromise = (async () => {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const data = await rawRequest(`${serverUrl}/v1/session-tokens/authenticate`, {
          method: 'POST',
          body: { token, instance: getInstallationId(db), takeover },
        });
        state.leaseToken = data.lease?.token || null;
        state.leaseExpiresAt = Number(data.lease?.expiresAt || 0);
        state.leaseId = data.lease?.leaseId || null;
        state.sessionId = data.session?.id || null;
        state.sessionMeta = data.session || null;
        state.terminalFailure = null;
        state.everAuthenticated = true;
        return data;
      } catch (error) {
        if (error.terminal) {
          rememberTerminalFailure(error);
          throw error;
        }
        if (error.code === 'session_in_use') throw error;
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
      }
    }
    throw lastError;
  })().finally(() => { state.authPromise = null; });

  return state.authPromise;
}

function isAuthenticated() {
  return Boolean(state.leaseToken && Date.now() < state.leaseExpiresAt);
}

// ─── Snapshot validation + SQLite restore ───────────────────────────────────

function validateSnapshot(statePayload) {
  if (!statePayload || typeof statePayload !== 'object') return null;
  const creds = Array.isArray(statePayload.sessionCreds) ? statePayload.sessionCreds : null;
  const keys = Array.isArray(statePayload.sessionKeys) ? statePayload.sessionKeys : null;
  const meta = Array.isArray(statePayload.sessionAuthMeta) ? statePayload.sessionAuthMeta : null;
  if (!creds || !keys || !meta) return null;
  if (!creds.some((row) => row?.key === 'creds' && typeof row.value === 'string')) return null;
  if (meta.find((row) => row?.key === 'status')?.value !== 'verified') return null;
  if (!creds.every((row) => typeof row?.key === 'string' && typeof row?.value === 'string')) return null;
  if (!keys.every((row) => typeof row?.type === 'string' && typeof row?.id === 'string' && typeof row?.value === 'string')) return null;
  if (!meta.every((row) => typeof row?.key === 'string' && typeof row?.value === 'string')) return null;
  return { creds, keys, meta };
}

function restoreSnapshotIntoSQLite(db, snapshot) {
  const now = Date.now();
  const insertCred = db.prepare(`
    INSERT INTO session_creds (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const insertKey = db.prepare(`
    INSERT INTO session_keys (type, id, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(type, id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const insertMeta = db.prepare(`
    INSERT INTO session_auth_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const restore = db.transaction(() => {
    db.prepare('DELETE FROM session_creds').run();
    db.prepare('DELETE FROM session_keys').run();
    db.prepare('DELETE FROM session_auth_meta').run();
    for (const row of snapshot.creds) insertCred.run(row.key, row.value, Number(row.updated_at || now));
    for (const row of snapshot.keys) insertKey.run(row.type, row.id, row.value, Number(row.updated_at || now));
    for (const row of snapshot.meta) insertMeta.run(row.key, row.value);
  });
  restore();
  return { credentialRows: snapshot.creds.length, keyRows: snapshot.keys.length, metaRows: snapshot.meta.length };
}

// ─── JUNE~ handle restore (lite vault) ──────────────────────────────────────

function parseAuthKeyFilename(name) {
  if (!name.endsWith('.json') || name === 'creds.json') return null;
  const base = name.slice(0, -'.json'.length);
  const type = AUTH_KEY_TYPES.find((candidate) => base.startsWith(`${candidate}-`));
  if (!type) return null;
  const id = base.slice(type.length + 1).replace(/__/g, '/').replace(/-/g, ':');
  return id ? { type, id } : null;
}

function filesToSnapshot(files) {
  const now = Date.now();
  const canonicalAuthJson = (value) => {
    try {
      const revived = JSON.parse(JSON.stringify(value), BufferJSON.reviver);
      return JSON.parse(JSON.stringify(revived, BufferJSON.replacer));
    } catch (_) {
      return value;
    }
  };
  const credsFile = files ? canonicalAuthJson(files['creds.json']) : null;
  if (!credsFile || typeof credsFile !== 'object') return null;
  const sessionCreds = [{ key: 'creds', value: JSON.stringify(credsFile), updated_at: now }];
  const sessionKeys = [];
  for (const [name, value] of Object.entries(files || {})) {
    if (name === 'creds.json') continue;
    const parsed = parseAuthKeyFilename(name);
    if (!parsed || !value || typeof value !== 'object') continue;
    sessionKeys.push({ type: parsed.type, id: parsed.id, value: JSON.stringify(canonicalAuthJson(value)), updated_at: now });
  }
  const sessionAuthMeta = [
    { key: 'status', value: 'verified' },
    { key: 'source', value: 'june-session-server' },
  ];
  return { creds: sessionCreds, keys: sessionKeys, meta: sessionAuthMeta };
}

async function fetchAndRestoreSnapshot(db) {
  const configuredCredential = getConfiguredToken();
  if (isJuneHandle(configuredCredential)) {
    const serverUrl = getServerUrl();
    let response;
    try {
      response = await fetch(`${serverUrl}/session/${encodeURIComponent(configuredCredential)}`, {
        headers: { Accept: 'text/plain' },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new SessionServerError(`Session Server unreachable: ${cause.message}`);
    }
    const text = (await response.text()).trim();
    if (!response.ok) {
      throw new SessionServerError('This Session ID is unknown or was revoked', { code: 'session_revoked', status: response.status });
    }
    let blob = text;
    const tilde = blob.indexOf('~');
    if (tilde >= 0) blob = blob.slice(tilde + 1);
    let creds;
    try {
      creds = JSON.parse(zlib.gunzipSync(Buffer.from(blob, 'base64')).toString('utf8'));
    } catch (_) {
      throw new SessionServerError('Session Server returned an invalid session blob', { code: 'session_state_missing' });
    }
    const snapshot = filesToSnapshot({ 'creds.json': creds });
    if (!snapshot) {
      throw new SessionServerError('Session Server returned an invalid session blob', { code: 'session_state_missing' });
    }
    state.offlineMode = true;
    state.version = null;
    state.leaseToken = null;
    state.leaseExpiresAt = 0;
    const restored = restoreSnapshotIntoSQLite(db, snapshot);
    return { ...restored, version: null, sessionId: null };
  }
  if (!state.leaseToken || Date.now() >= state.leaseExpiresAt - 60000) {
    await authenticate({ takeover: !state.everAuthenticated, db });
  }
  const data = await request('/v1/session/auth-state');
  if (data?.leaseExpiresAt) state.leaseExpiresAt = Number(data.leaseExpiresAt);
  const snapshot = validateSnapshot(data?.state);
  if (!snapshot) throw new SessionServerError('Session Server returned an invalid auth snapshot', { code: 'session_state_missing' });
  state.version = Number(data?.version) || null;
  const restored = restoreSnapshotIntoSQLite(db, snapshot);
  return { ...restored, version: state.version, sessionId: state.sessionId };
}

function buildAuthSnapshot(db) {
  try {
    const sessionCreds = db.prepare('SELECT key, value, updated_at FROM session_creds ORDER BY key ASC').all();
    const sessionKeys = db.prepare('SELECT type, id, value, updated_at FROM session_keys ORDER BY type ASC, id ASC').all();
    const sessionAuthMeta = db.prepare('SELECT key, value FROM session_auth_meta ORDER BY key ASC').all();
    const status = sessionAuthMeta.find((row) => row.key === 'status')?.value;
    if (!sessionCreds.some((row) => row.key === 'creds') || sessionKeys.length === 0 || status !== 'verified') {
      return null;
    }
    return { sessionCreds, sessionKeys, sessionAuthMeta };
  } catch (_) {
    return null;
  }
}

// ─── Runtime push ───────────────────────────────────────────────────────────

async function pushAuthStateNow(db, reason = 'scheduled') {
  if (!isTokenModeActive() || state.revoked || state.terminalFailure) return false;
  const snapshot = buildAuthSnapshot(db);
  if (!snapshot) return false;

  try {
    if (!state.leaseToken || Date.now() >= state.leaseExpiresAt - 60000) {
      await authenticate({ takeover: !state.everAuthenticated, db });
    }
    if (state.version === null) {
      const current = await request('/v1/session/auth-state');
      state.version = Number(current?.version) || null;
      if (current?.leaseExpiresAt) state.leaseExpiresAt = Number(current.leaseExpiresAt);
    }
    const body = { state: snapshot };
    if (state.version !== null) body.expectedVersion = state.version;
    try {
      const result = await request('/v1/session/auth-state', { method: 'PUT', body });
      state.version = Number(result?.version) || state.version + 1;
      return true;
    } catch (error) {
      if (error.code === 'version_conflict') {
        const current = await request('/v1/session/auth-state');
        state.version = Number(current?.version) || null;
        const retryBody = { state: snapshot };
        if (state.version !== null) retryBody.expectedVersion = state.version;
        const retried = await request('/v1/session/auth-state', { method: 'PUT', body: retryBody });
        state.version = Number(retried?.version) || state.version + 1;
        if (retried?.leaseExpiresAt) state.leaseExpiresAt = Number(retried.leaseExpiresAt);
        return true;
      }
      throw error;
    }
  } catch (error) {
    if (error.code === 'session_in_use') {
      throttleLog('[ SESSION SERVER ] Another deployment is actively syncing this session — key pushes paused on this instance.', 3600000);
      return false;
    }
    if (error.terminal) {
      throttleLog(`[ SESSION SERVER ] ${error.code} — server rejected the token; keeping the verified local auth and continuing.`, 300000);
      return false;
    }
    throttleLog(`[ SESSION SERVER ] Auth-state push deferred (${error.message}).`, 120000);
    return false;
  }
}

function scheduleAuthPush(db, reason = 'scheduled') {
  if (!isTokenModeActive()) return false;
  if (state.pushTimer) clearTimeout(state.pushTimer);
  state.pushTimer = setTimeout(() => {
    state.pushTimer = null;
    if (state.pushing) return;
    state.pushing = true;
    pushAuthStateNow(db, reason)
      .catch(() => {})
      .finally(() => { state.pushing = false; });
  }, PUSH_DEBOUNCE_MS);
  state.pushTimer.unref?.();
  return true;
}

// ─── Heartbeat ──────────────────────────────────────────────────────────────

async function sendHeartbeat(botState, botVersion) {
  if (!isTokenModeActive() || state.revoked || state.terminalFailure) return;
  try {
    const data = await request('/v1/session/heartbeat', {
      method: 'POST',
      body: { state: botState || 'connected', botVersion: botVersion || '' },
    });
    if (data?.leaseExpiresAt) state.leaseExpiresAt = Number(data.leaseExpiresAt);
  } catch (error) {
    if (error.terminal) {
      throttleLog('[ SESSION SERVER ] Heartbeat stopped — the server rejected the token. The bot keeps running on local auth.', 300000);
      stopHeartbeat();
      return;
    }
    if (error.code === 'session_in_use') {
      throttleLog('[ SESSION SERVER ] Another deployment holds the session lease — remote sync stopped on this instance.', 3600000);
      stopHeartbeat();
      return;
    }
  }
}

function startHeartbeat(botVersion) {
  if (!isTokenModeActive() || state.heartbeatTimer) return;
  state.heartbeatTimer = setInterval(() => {
    void sendHeartbeat('connected', botVersion);
  }, HEARTBEAT_INTERVAL_MS);
  state.heartbeatTimer.unref?.();
  void sendHeartbeat('connected', botVersion);
}

function stopHeartbeat() {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}

// ─── Connection lifecycle ───────────────────────────────────────────────────

async function onBotConnected(db, { botVersion } = {}) {
  if (!isTokenModeActive()) return;
  try {
    if (!state.leaseToken || Date.now() >= state.leaseExpiresAt - 60000) {
      await authenticate({ takeover: !state.everAuthenticated, db });
    }
  } catch (error) {
    if (error.terminal) {
      throttleLog(`[ SESSION SERVER ] ${error.code} — token rejected by the server. Continuing without remote sync.`, 300000);
    } else if (error.code === 'session_in_use') {
      throttleLog('[ SESSION SERVER ] Another deployment is actively syncing this session — remote sync disabled on this instance.', 3600000);
    } else {
      throttleLog(`[ SESSION SERVER ] Background authenticate deferred (${error.message}).`, 120000);
    }
    return;
  }

  const sock = global.currentSock;
  if (sock?.user?.id && state.sessionMeta?.phoneLast4) {
    const pairedLast4 = String(sock.user.id).split(':')[0].split('@')[0].replace(/\D/g, '').slice(-4);
    if (pairedLast4 && pairedLast4 !== String(state.sessionMeta.phoneLast4)) {
      throttleLog(`[ SESSION SERVER ] Token session belongs to account …${state.sessionMeta.phoneLast4} but this bot is connected as …${pairedLast4} — remote sync disabled. Set JUNE_FORCE_SESSION_BOOTSTRAP=true and restart to override.`, 300000);
      return;
    }
  }

  await pushAuthStateNow(db, 'connection-open').catch(() => {});
  startHeartbeat(botVersion);
}

// ─── Revocation ─────────────────────────────────────────────────────────────

async function revokeSession(reason = 'whatsapp-logout') {
  if (!isTokenModeActive() || state.revoked) return { revoked: false, skipped: 'already-revoked-or-not-active' };
  state.revoked = true;
  stopHeartbeat();
  if (state.pushTimer) { clearTimeout(state.pushTimer); state.pushTimer = null; }
  try {
    const token = getConfiguredToken();
    const serverUrl = getServerUrl();
    if (!token || !serverUrl) return { revoked: false, skipped: 'not-configured' };
    await rawRequest(`${serverUrl}/v1/manage/revoke`, { method: 'POST', body: { token } });
    (global.log || console.log)('[ SESSION SERVER ] Server-side session revoked.', 'green');
    return { revoked: true };
  } catch (error) {
    (global.log || console.log)(`[ SESSION SERVER ] Could not reach the server for revocation (${error.message}).`, 'yellow');
    return { revoked: false, error: error.code || 'revoke-failed' };
  }
}

// ─── Manage ─────────────────────────────────────────────────────────────────

async function checkTokenStatus() {
  const token = getConfiguredToken();
  const serverUrl = getServerUrl();
  if ((!isSessionServerToken(token) && !isJuneHandle(token)) || !serverUrl) return null;
  const data = await rawRequest(`${serverUrl}/v1/manage/check`, { method: 'POST', body: { token } });
  return data;
}

function getStatus() {
  return {
    tokenMode: isTokenModeActive(),
    serverConfigured: Boolean(getServerUrl()),
    authenticated: isAuthenticated(),
    sessionId: state.sessionId,
    sessionMeta: state.sessionMeta,
    version: state.version,
    heartbeatRunning: Boolean(state.heartbeatTimer),
    terminalFailure: state.terminalFailure ? state.terminalFailure.code : null,
  };
}

module.exports = {
  TOKEN_PREFIX,
  HANDLE_PATTERN,
  DEFAULT_SESSION_SERVER_URL,
  isJuneHandle,
  filesToSnapshot,
  SessionServerError,
  isSessionServerToken,
  parseSessionServerToken,
  describeTokenProblem,
  tokenBotIdSuffix,
  getServerUrl,
  getConfiguredToken,
  isTokenModeActive,
  markOfflineMode,
  sha256Hex,
  authenticate,
  isAuthenticated,
  fetchAndRestoreSnapshot,
  validateSnapshot,
  restoreSnapshotIntoSQLite,
  buildAuthSnapshot,
  scheduleAuthPush,
  pushAuthStateNow,
  onBotConnected,
  startHeartbeat,
  stopHeartbeat,
  revokeSession,
  checkTokenStatus,
  getStatus,
};
