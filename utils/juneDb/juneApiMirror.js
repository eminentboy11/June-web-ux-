'use strict';

const { createSelectedStorage, selectStorage } = require('./storageSelector');
const API_NAMESPACE = 'june-db-v1';
const { restoreRecords } = require('./juneApiRestore');

const BOT_ID_PRODUCT = 'june-ultra-main';

function normalizeBotId(value) {
  const raw = String(value || '').trim().split('@')[0].split(':')[0];
  const normalized = raw.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/-+/g, '-');
  return normalized || BOT_ID_PRODUCT;
}

function buildBotId(pn) {
  const digits = String(pn || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  return normalizeBotId(digits ? `${BOT_ID_PRODUCT}-${digits}` : BOT_ID_PRODUCT);
}

let activeBotId = buildBotId(
  process.env.PN ||
  process.env.JUNE_PN ||
  process.env.JUNE_BOT_ID ||
  process.env.BOT_ID ||
  process.env.OWNER_NUMBER
);

let store = null;
let ready = false;
let initializing = null;
let lastError = null;
let autoRetryTimer = null;
let autoRetryDelay = 15000;
let autoLifecycle = 0;
let announcedState = null;

function isTerminalAccessError(error) {
  return error?.code === 'installation_revoked' || error?.code === 'unauthorized';
}

function announceUnavailable(message) {
  lastError = message;
  if (announcedState === 'unavailable') return;
  announcedState = 'unavailable';
  console.warn(`[JUNE API] Unavailable: ${message}`);
}

function announceConnected() {
  if (announcedState === 'connected') return;
  announcedState = 'connected';
  console.log(`[JUNE API] Connected; remote persistence enabled for bot_id=${require('../redact').maskBotId(activeBotId)}`);
}

function stopRemotePersistence(error) {
  lastError = error?.message || String(error);
  ready = false;
  if (autoRetryTimer) {
    clearTimeout(autoRetryTimer);
    autoRetryTimer = null;
  }
  try { store?.close?.(); } catch { /* already closed */ }
  store = null;
  if (announcedState === 'revoked') return;
  announcedState = 'revoked';
  console.warn('[JUNE API] Tenant paused or deleted; remote persistence stopped');
}

function selection() {
  try {
    return createSelectedStorage({ env: process.env });
  } catch (error) {
    return {
      mode: String(process.env.JUNE_STORAGE_MODE || 'auto').trim().toLowerCase(),
      storage: 'june-api',
      reason: 'configuration-error',
      error,
    };
  }
}

function getStatus() {
  const selected = selection();
  return {
    configured: selected.storage === 'session-server',
    available: ready,
    mode: selected.mode,
    reason: selected.reason,
    botId: activeBotId,
    lastError: lastError || selected.error?.message || null,
  };
}

async function init() {
  if (announcedState === 'revoked') return getStatus();
  if (ready) return getStatus();
  if (initializing) return initializing;

  initializing = (async () => {
    const selected = selection();
    const lifecycle = autoLifecycle;
    if (selected.storage !== 'session-server') return getStatus();
    if (selected.error) {
      lastError = selected.error.message;
      if (announcedState !== 'config-failed') {
        announcedState = 'config-failed';
        console.warn(`[JUNE API] Configuration failed: ${lastError}`);
      }
      return getStatus();
    }

    try {
      store = selected.adapter;
      // Session-server (one-token) storage pins a fixed namespace: the tenant
      // is per-session, and a PN-derived prefix is not known before the first
      // connect (which would orphan records).
      activeBotId = API_NAMESPACE;
      const status = await store.status();
      if (lifecycle !== autoLifecycle) return getStatus();
      if (store.dbId && status?.installation?.dbId !== store.dbId) {
        throw new Error('JUNE_DB_ID does not match the installation token');
      }
      await store.snapshot({ limit: 1, prefix: `${activeBotId}:` });
      await store.heartbeat();
      if (lifecycle !== autoLifecycle) return getStatus();
      ready = true;
      if (autoRetryTimer) clearTimeout(autoRetryTimer);
      autoRetryTimer = null; autoRetryDelay = 15000;
      lastError = null;
      announceConnected();
    } catch (error) {
      if (lifecycle !== autoLifecycle) return getStatus();
      if (isTerminalAccessError(error)) {
        store = selected.adapter;
        stopRemotePersistence(error);
        return getStatus();
      }
      selected.adapter.close();
      ready = false;
      lastError = error?.message || String(error);
      announceUnavailable(lastError);
      if (error.retryable && !autoRetryTimer) {
        autoRetryTimer = setTimeout(() => { autoRetryTimer = null; void init(); }, autoRetryDelay);
        autoRetryTimer.unref?.();
        autoRetryDelay = Math.min(60000, autoRetryDelay * 2);
      }
    }
    return getStatus();
  })().finally(() => {
    initializing = null;
  });

  return initializing;
}

function setBotId(value) {
  if (selectStorage(process.env).automatic) { activeBotId = API_NAMESPACE; return activeBotId; }
  if (value) activeBotId = normalizeBotId(value);
  return activeBotId;
}

function getBotId() {
  return activeBotId;
}

function scopedKey(...parts) {
  return [activeBotId, ...parts].map((part) => String(part)).join(':');
}

function write(resource, key, value) {
  if (announcedState === 'revoked' || !ready || !store) return Promise.resolve(null);
  return store.put(resource, scopedKey(key), value).catch((error) => {
    if (isTerminalAccessError(error)) {
      stopRemotePersistence(error);
      return null;
    }
    lastError = error?.message || String(error);
    return null;
  });
}

function remove(resource, key) {
  if (announcedState === 'revoked' || !ready || !store) return Promise.resolve(null);
  return store.delete(resource, scopedKey(key)).catch((error) => {
    if (isTerminalAccessError(error)) {
      stopRemotePersistence(error);
      return null;
    }
    lastError = error?.message || String(error);
    return null;
  });
}

const mirrorBotSetting = (key, value) => write('bot_settings', key, { key: String(key), value });
const mirrorGroupSettings = (groupId, settings) =>
  write('group_settings', groupId, { groupId: String(groupId), settings: settings || {} });
const mirrorGroupStat = (groupId, date, data) =>
  write('group_stats', `${groupId}:${date}`, { groupId: String(groupId), date: String(date), data: data || {} });
const mirrorUser = (userId, data) => write('users', userId, { userId: String(userId), data: data || {} });
const mirrorWarning = (groupId, userId, warning) =>
  write('warnings', `${groupId}:${userId}`, {
    groupId: String(groupId),
    userId: String(userId),
    count: Number(warning?.count || 0),
    entries: warning?.entries || [],
  });
const mirrorModerator = (userId, enabled = true) =>
  enabled ? write('moderators', userId, { userId: String(userId) }) : remove('moderators', userId);
const mirrorMutedUser = (groupId, userId, enabled = true) =>
  enabled
    ? write('muted_users', `${groupId}:${userId}`, { groupId: String(groupId), userId: String(userId) })
    : remove('muted_users', `${groupId}:${userId}`);
const mirrorKV = (namespace, key, value) =>
  write('kv_store', `${namespace}:${key}`, { namespace: String(namespace), key: String(key), value });
const deleteKV = (namespace, key) => remove('kv_store', `${namespace}:${key}`);
const mirrorProfile = (botProfileId, userId, profile) =>
  write('profiles', `${botProfileId || 'default'}:${userId}`, {
    botProfileId: String(botProfileId || 'default'),
    userId: String(userId),
    profile: profile || {},
  });
const mirrorAntideleteMessage = (chatId, messageId, payload, storedAt = Date.now()) =>
  write('antidelete_messages', `${chatId}:${messageId}`, { chatId: String(chatId), messageId: String(messageId), payload: payload || {}, storedAt });
const deleteAntideleteMessage = (chatId, messageId) => remove('antidelete_messages', `${chatId}:${messageId}`);
const mirrorAntideleteStatus = (statusId, payload, storedAt = Date.now()) =>
  write('antidelete_statuses', statusId, { statusId: String(statusId), payload: payload || {}, storedAt });
const deleteAntideleteStatus = (statusId) => remove('antidelete_statuses', statusId);
const mirrorLidMap = (direction, user, value, updatedAt = Date.now()) =>
  write('lid_map', `${direction}:${user}`, { direction: String(direction), user: String(user), value: String(value), updatedAt });

function mirrorAuthState(snapshot) {
  return write('auth_state', 'current', snapshot || {});
}

function fetchAuthState() {
  if (announcedState === 'revoked' || !ready || !store) return Promise.resolve(null);
  return store.get('auth_state', scopedKey('current')).then((snapshot) => ({
    snapshot,
    updatedAt: snapshot?.updatedAt || snapshot?.createdAt || 0,
    source: 'june-api',
  })).catch((error) => {
    if (isTerminalAccessError(error)) {
      stopRemotePersistence(error);
      return null;
    }
    lastError = error?.message || String(error);
    return null;
  });
}

const deleteAuthState = () => remove('auth_state', 'current');
const deleteLegacyAuthRecord = () => Promise.resolve(true);
async function restoreIntoSQLite(db) {
  if (!ready || !store || !db) return { restored: 0, skipped: 'june_api_unavailable' };
  // Buffer a complete revision-consistent snapshot before opening a local transaction.
  // On a changed snapshot restart the download; never import a partial page set.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const records = [];
      let cursor;
      do {
        const page = await store.snapshot({ cursor, prefix: `${activeBotId}:` });
        if (!Array.isArray(page?.records)) throw new Error('Invalid June API snapshot response');
        records.push(...page.records);
        if (records.length > 100000) throw new Error('June API restore exceeds the 100000-record safety limit');
        cursor = page.nextCursor;
      } while (cursor);
      const result = restoreRecords(db, records, activeBotId);
      lastError = null;
      return result;
    } catch (error) {
      if (error.code === 'snapshot_changed' && attempt < 2) continue;
      lastError = error?.message || String(error);
      ready = false; // Do not backfill into remote storage after a failed pull.
      if (isTerminalAccessError(error)) {
        stopRemotePersistence(error);
        return { restored: 0, error: lastError };
      }
      announceUnavailable(lastError);
      return { restored: 0, error: lastError };
    }
  }
}
const clearKind = () => Promise.resolve({ ok: false, skipped: 'june_api_clear_requires_explicit_resource_keys' });
const close = async () => { autoLifecycle++; if (autoRetryTimer) clearTimeout(autoRetryTimer); autoRetryTimer = null; ready = false; store?.close?.(); store = null; lastError = null; announcedState = null; };

module.exports = {
  init,
  close,
  getStatus,
  getBotId,
  setBotId,
  buildBotId,
  mirrorBotSetting,
  mirrorGroupSettings,
  mirrorGroupStat,
  mirrorUser,
  mirrorWarning,
  mirrorModerator,
  mirrorMutedUser,
  mirrorKV,
  deleteKV,
  mirrorProfile,
  mirrorAntideleteMessage,
  deleteAntideleteMessage,
  mirrorAntideleteStatus,
  deleteAntideleteStatus,
  mirrorLidMap,
  mirrorAuthState,
  fetchAuthState,
  deleteAuthState,
  deleteLegacyAuthRecord,
  restoreIntoSQLite,
  clearKind,
};