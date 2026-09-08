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

function selectStorage(env = process.env) {
  const requested = String(env.JUNE_STORAGE_MODE || 'auto').trim().toLowerCase();
  if (!VALID_MODES.has(requested)) {
    throw new Error('JUNE_STORAGE_MODE must be one of auto, ephemeral, persistent, or local');
  }

  // DATABASE_URL always wins. This preserves the existing direct PostgreSQL
  // path even if a host also exposes an ephemeral-provider signal.
  if (hasValue(env, 'DATABASE_URL')) {
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
    return { mode: requested, storage: 'june-api', reason: 'DB', automatic: true };
  }
  if (requested === 'ephemeral' || (requested === 'auto' && isKnownEphemeral(env))) {
    return { mode: requested, storage: 'june-api', reason: requested === 'ephemeral' ? 'override' : 'known-ephemeral-provider' };
  }

  // Option B: this is the risky fallback — we couldn't confirm the host is
  // ephemeral OR confirm it's persistent, we're just guessing "persistent".
  // Warn loudly so an unrecognized host doesn't silently lose data on restart.
  if (requested === 'auto') {
   /* console.warn(
      '[storage] Could not detect a known ephemeral hosting provider. ' +
      'Defaulting to local SQLite storage. If this host wipes its disk on ' +
      'restart/redeploy, your data WILL be lost. If that\'s the case, set ' +
      'JUNE_STORAGE_MODE=ephemeral (or provide DATABASE_URL) to use persistent ' +
      'June DB storage instead.'
    );*/
  }

  return { mode: requested, storage: 'sqlite', reason: 'unknown-or-persistent-environment' };
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
  selectStorage,
  createSelectedStorage,
};
