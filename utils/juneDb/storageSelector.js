'use strict';

// Hard cutover (September 2026): the legacy DB= automatic June API storage and
// the JUNE_DB_TOKEN/JUNE_DB_ID installation credentials were REMOVED.
// The single supported remote storage is the Session Server token
// (one-token mode). Direct PostgreSQL/MongoDB mirrors are unchanged.

function hasValue(env, key) {
  return typeof env[key] === 'string' && env[key].trim() !== '';
}

// Option A: expanded allowlist of known ephemeral-storage hosting providers.
function isKnownEphemeral(env) {
  return hasValue(env, 'DYNO')                       // Heroku
    || hasValue(env, 'RENDER')                        // Render
    || hasValue(env, 'RAILWAY_ENVIRONMENT')            // Railway
    || hasValue(env, 'RAILWAY_PROJECT_ID')             // Railway
    || hasValue(env, 'REPL_ID')                        // Replit
    || hasValue(env, 'REPLIT_SLUG')                    // Replit
    || hasValue(env, 'FLY_APP_NAME')                   // Fly.io
    || hasValue(env, 'VERCEL')                         // Vercel
    || hasValue(env, 'AWS_LAMBDA_FUNCTION_NAME')       // AWS Lambda
    || hasValue(env, 'K_SERVICE')                      // Google Cloud Run
    || hasValue(env, 'KOYEB_APP_ID');                  // Koyeb
}

// Hosts with durable local disks where remote storage is unnecessary by default.
function isKnownStable(env) {
  return hasValue(env, 'P_SERVER_UUID');   // Pterodactyl panel
}

function warnRetired(vars) {
  const set = vars.filter((v) => hasValue(process.env, v));
  if (set.length) {
    console.warn(
      `[storage] ${set.join(', ')} ${set.length > 1 ? 'are' : 'is'} set but the DB= / legacy June API storage system was RETIRED. ` +
      'The value is ignored. Use your june-ultra:~ Session Server token (SESSION_ID / JUNE_SESSION_TOKEN) instead.'
    );
  }
}

function _computeSelection(env) {
  const requested = String(env.JUNE_STORAGE_MODE || 'auto').trim().toLowerCase();
  const VALID_MODES = new Set(['auto', 'ephemeral', 'persistent', 'local']);
  if (!VALID_MODES.has(requested)) {
    throw new Error('JUNE_STORAGE_MODE must be one of auto, ephemeral, persistent, or local');
  }

  // DATABASE_URL (direct PostgreSQL mirror) always wins.
  if (hasValue(env, 'DATABASE_URL')) {
    warnRetired(['DB', 'JUNE_DB_TOKEN', 'JUNE_DB_ID']);
    return { mode: requested, storage: 'postgres', reason: 'DATABASE_URL' };
  }
  if (requested === 'local' || requested === 'persistent') {
    warnRetired(['DB', 'JUNE_DB_TOKEN', 'JUNE_DB_ID']);
    return { mode: requested, storage: 'sqlite', reason: requested };
  }

  // One-token mode: the Session Server token doubles as the storage
  // credential. It only engages where local storage is not durable —
  // known-stable hosts keep their local SQLite unless
  // JUNE_FORCE_SESSION_STORE=1.
  if (hasValue(env, 'JUNE_SESSION_TOKEN')) {
    warnRetired(['DB', 'JUNE_DB_TOKEN', 'JUNE_DB_ID']);
    if (isKnownStable(env) && !hasValue(env, 'JUNE_FORCE_SESSION_STORE')) {
      return { mode: requested, storage: 'sqlite', reason: 'stable-host-session-token-ignored' };
    }
    return { mode: requested, storage: 'session-server', reason: 'session-token', sessionServer: true };
  }

  if (requested === 'ephemeral' || (requested === 'auto' && isKnownEphemeral(env))) {
    // No token configured on an ephemeral host. The legacy DB= fallback was
    // removed — fall back to local SQLite with a loud data-loss warning.
    console.warn(
      '[storage] This host looks ephemeral and no june-ultra:~ Session Server token is configured. ' +
      'Defaulting to local SQLite — YOUR DATA WILL BE LOST on restart/redeploy. ' +
      'Pair at the website and set SESSION_ID (or JUNE_SESSION_TOKEN) to survive redeploys.'
    );
    return { mode: requested, storage: 'sqlite', reason: requested === 'ephemeral' ? 'override-no-token' : 'known-ephemeral-provider-no-token' };
  }

  if (requested === 'auto') {
    if (isKnownStable(env)) {
      console.log('[storage] Pterodactyl server detected — using local SQLite storage.');
    } else {
      console.warn(
        '[storage] Could not detect a known ephemeral hosting provider. ' +
        'Defaulting to local SQLite storage. If this host wipes its disk on ' +
        'restart/redeploy, your data WILL be lost — set a june-ultra:~ Session ' +
        'Server token (SESSION_ID) to survive redeploys.'
      );
    }
  }

  return { mode: requested, storage: 'sqlite', reason: 'unknown-or-persistent-environment' };
}

// Memoized so repeated calls don't re-run detection or re-log warnings.
let _cachedSelection = null;

function selectStorage(env = process.env) {
  if (_cachedSelection) return _cachedSelection;
  _cachedSelection = _computeSelection(env);
  return _cachedSelection;
}

function createSelectedStorage({ env = process.env, baseUrl, fetchImpl } = {}) {
  const selection = selectStorage(env);
  if (selection.storage !== 'session-server') {
    return { ...selection, adapter: null };
  }
  const { SessionServerStore } = require('./sessionServerStore');
  const { getServerUrl } = require('./sessionServer');
  return {
    ...selection,
    adapter: new SessionServerStore({
      token: env.JUNE_SESSION_TOKEN,
      baseUrl: baseUrl || getServerUrl(),
      fetchImpl,
    }),
  };
}

module.exports = {
  isKnownEphemeral,
  isKnownStable,
  selectStorage,
  createSelectedStorage,
};
