'use strict';

const { INTERNAL_JUNE_API_URL, JuneApiStore } = require('./juneApiAdapter');

const VALID_MODES = new Set(['auto', 'ephemeral', 'persistent', 'local']);

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

// Hosts with durable local disks where June DB usage is unnecessary by default.
// Not exhaustive and not guaranteed correct for every panel config — that's
// why JUNE_FORCE_DB exists as an escape hatch below.
function isKnownStable(env) {
  return hasValue(env, 'P_SERVER_UUID');   // Pterodactyl panel
}

function _computeSelection(env) {
  const requested = String(env.JUNE_STORAGE_MODE || 'auto').trim().toLowerCase();
  if (!VALID_MODES.has(requested)) {
    throw new Error('JUNE_STORAGE_MODE must be one of auto, ephemeral, persistent, or local');
  }

  // DATABASE_URL always wins. This preserves the existing direct PostgreSQL
  // path even if a host also exposes an ephemeral-provider signal.
  if (hasValue(env, 'DATABASE_URL')) {
    if (env.DB !== undefined) {
      console.warn(
        '[storage] Both DATABASE_URL and DB are set — DATABASE_URL takes ' +
        'priority, so DB is being ignored and June DB will NOT be used. ' +
        'Remove DATABASE_URL if you intended to use June DB instead.'
      );
    }
    return { mode: requested, storage: 'postgres', reason: 'DATABASE_URL' };
  }
  if (requested === 'local' || requested === 'persistent') {
    return { mode: requested, storage: 'sqlite', reason: requested };
  }
  // DB is an explicit opt-in. It must not hijack pre-existing direct mirrors.
  if (env.DB !== undefined) {
    if (['POSTGRESQL_URL','POSTGRES_URL','MONGODB_URI','MONGO_URL'].some(key=>hasValue(env,key))) {
      return { mode: requested, storage: 'sqlite', reason: 'existing-direct-mirror' };
    }
    // If we're confident this host has durable local storage, don't let a
    // stray/copy-pasted DB value occupy June DB unnecessarily. Users who
    // genuinely need June DB on a "stable" host can force it with
    // JUNE_FORCE_DB=1 (e.g. a Pterodactyl node whose volume isn't actually
    // persisted in their specific setup).
    if (isKnownStable(env) && !hasValue(env, 'JUNE_FORCE_DB')) {
      console.warn(
        '[storage] DB is set but this host looks stable/persistent, so ' +
        'June DB is NOT being used — falling back to local SQLite to avoid ' +
        'occupying June DB unnecessarily. If this host is actually ephemeral ' +
        'and you need June DB, set JUNE_FORCE_DB=1.'
      );
      return { mode: requested, storage: 'sqlite', reason: 'stable-host-db-ignored' };
    }
    return { mode: requested, storage: 'june-api', reason: 'DB', automatic: true };
  }
  if (requested === 'ephemeral' || (requested === 'auto' && isKnownEphemeral(env))) {
    return { mode: requested, storage: 'june-api', reason: requested === 'ephemeral' ? 'override' : 'known-ephemeral-provider' };
  }

  // Option B: this is the risky fallback — we couldn't confirm the host is
  // ephemeral OR confirm it's persistent, we're just guessing "persistent".
  // Warn loudly so an unrecognized host doesn't silently lose data on restart.
  // Exception: if we recognize the host as a known-stable platform (e.g.
  // Pterodactyl), skip the scary warning and log a calm confirmation instead,
  // since data loss isn't actually a real risk there.
  if (requested === 'auto') {
    if (isKnownStable(env)) {
      console.log('[storage] Pterodactyl server detected — using local SQLite storage.');
    } else {
      console.warn(
        '[storage] Could not detect a known ephemeral hosting provider. ' +
        'Defaulting to local SQLite storage. If this host wipes its disk on ' +
        'restart/redeploy, your data WILL be lost. If that\'s the case, set ' +
        'JUNE_STORAGE_MODE=ephemeral (or provide DATABASE_URL) to use persistent ' +
        'June DB storage instead.'
      );
    }
  }

  return { mode: requested, storage: 'sqlite', reason: 'unknown-or-persistent-environment' };
}

// Memoized so repeated calls (accidental or otherwise, e.g. once per
// message/command instead of once at startup) don't re-run detection or
// re-log warnings every time. Computed once per process, reused after that.
let _cachedSelection = null;

function selectStorage(env = process.env) {
  if (_cachedSelection) return _cachedSelection;
  _cachedSelection = _computeSelection(env);
  return _cachedSelection;
}

function createSelectedStorage({ env = process.env, token, dbId, baseUrl, fetchImpl } = {}) {
  const selection = selectStorage(env);
  if (selection.storage !== 'june-api') {
    return { ...selection, adapter: null };
  }
  if (selection.automatic) {
    if (token || dbId || hasValue(env,'JUNE_DB_TOKEN') || hasValue(env,'JUNE_DB_ID')) {
      throw new Error('DB cannot be combined with legacy installation credentials; no automatic tenant migration is performed');
    }
    const { AutomaticJuneApiStore } = require('./automaticJuneApi');
    return { ...selection, adapter: new AutomaticJuneApiStore({ secret:env.DB, fetchImpl }) };
  }
  const resolvedToken = token || env.JUNE_DB_TOKEN;
  if (!resolvedToken) {
    throw new Error('JUNE_DB_TOKEN is required when June API storage is selected');
  }
  return {
    ...selection,
    adapter: new JuneApiStore({ token: resolvedToken, dbId: dbId || env.JUNE_DB_ID, baseUrl: baseUrl || env.JUNE_DB_API_URL || INTERNAL_JUNE_API_URL, fetchImpl }),
  };
}

module.exports = {
  VALID_MODES,
  isKnownEphemeral,
  isKnownStable,
  selectStorage,
  createSelectedStorage,
};
