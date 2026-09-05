/**
 * config.js — a live view over the database, not a storage file.
 *
 * Nothing here is a stored value any more. Every property either reads from
 * SQLite (user-changeable settings) or from the static constants in
 * database.js (fixed application values).
 *
 * Why it still exists: 138 files do `require('../../config')` across roughly
 * 436 call sites. Keeping the module means none of them had to change, while
 * the values behind them moved to storage that actually survives.
 *
 * Why the values moved: the public loader re-extracts the application
 * directory from the published build on every boot, so anything written into
 * this file is overwritten. `./database/` is in the loader's SKIP_DIRS and is
 * preserved, which makes SQLite the only durable store.
 *
 * Setters are provided as well as getters. Code that already did
 * `config.prefix = 'j'` keeps working unchanged and now persists, which fixes
 * settings silently reverting on restart.
 *
 * Reads are cheap: database.js keeps a write-through cache, so a property
 * access is a Map lookup rather than a query.
 */

// Lazy so this module can be required from anywhere without caring about load
// order. database.js no longer requires config.js, so there is no cycle.
let _db = null;
const db = () => (_db || (_db = require('./database')));

const setting = (key) => ({
  get() { return db().getBotSetting(key); },
  set(value) { db().setBotSetting(key, value); },
  enumerable: true,
  configurable: true,
});

const constant = (key) => ({
  get() { return db()[key]; },
  enumerable: true,
  configurable: true,
});

const config = {};

Object.defineProperties(config, {
  // ── Identity ────────────────────────────────────────────────────────────
  // Owners are a dedicated list rather than a plain setting so the values are
  // normalised to digits and de-duplicated on write.
  ownerNumber: {
    get() { return db().getOwners(); },
    set(value) { db().setOwners(Array.isArray(value) ? value : [value]); },
    enumerable: true,
    configurable: true,
  },
  // Never returns an empty list. Display sites across the codebase do
  // `Array.isArray(config.ownerName) ? config.ownerName[0] : (… || 'N/A')`,
  // which puts the fallback on the wrong branch — an empty array takes the
  // array path and renders `undefined`. Falling back here fixes every one of
  // those sites at once: stored name, else the owner number, else a label.
  ownerName: {
    get() {
      const stored = db().getBotSetting('ownerName');
      const list = (Array.isArray(stored) ? stored : [stored])
        .filter(v => v !== null && v !== undefined && String(v).trim() !== '');
      if (list.length) return list;
      const owners = db().getOwners();
      return owners.length ? owners : ['Bot Owner'];
    },
    set(value) {
      db().setBotSetting('ownerName', Array.isArray(value) ? value : [value]);
    },
    enumerable: true,
    configurable: true,
  },
  botName:   setting('botName'),

  // ── Behaviour ───────────────────────────────────────────────────────────
  prefix:      setting('prefix'),
  selfMode:    setting('selfMode'),
  timezone:    setting('timezone'),
  maxWarnings: setting('maxWarnings'),

  // ── Auto-features ───────────────────────────────────────────────────────
  autoRead:       setting('autoRead'),
  autoReact:      setting('autoReact'),
  autoReactMode:  setting('autoReactMode'),
  autoBio:        setting('autoBio'),
  autoSticker:    setting('autoSticker'),
  autoTyping:     setting('autoTyping'),
  autoRecording:  setting('autoRecording'),
  autoRecordType: setting('autoRecordType'),

  // ── Stickers ────────────────────────────────────────────────────────────
  // config.author and config.stickerAuthor were read by four files but never
  // defined here, so they evaluated to undefined at runtime. They now have
  // real defaults in BOT_SETTINGS_DEFAULTS.
  packname:      setting('packname'),
  author:        setting('author'),
  stickerAuthor: setting('stickerAuthor'),

  // ── Channel ─────────────────────────────────────────────────────────────
  newsletterJid: setting('newsletterJid'),

  // ── Static application constants (never stored) ─────────────────────────
  messages:             constant('MESSAGES'),
  // static template with the live anticall settings merged over it
  defaultGroupSettings: {
    get() { return db().getDefaultGroupSettings(); },
    enumerable: true,
    configurable: true,
  },
  anticallPresets:      constant('ANTICALL_PRESETS'),
  social:               constant('SOCIAL'),
  apiKeys:              constant('API_KEYS'),
  telegramToken:        constant('TELEGRAM_TOKEN'),
  JUNE_API_URL:         constant('JUNE_API_URL'),
  JUNE_BOT_ID:          constant('JUNE_BOT_ID'),
  updateZipUrl:         constant('UPDATE_ZIP_URL'),
  version:              constant('VERSION'),
});

// ── Plain values ──────────────────────────────────────────────────────────
// Read from the environment at module load, before the database is open.
config.sessionID = process.env.SESSION_ID || '';

// Deliberately not a database getter: index.js and utils/cleanup.js read this
// at module load to build the session directory path, which happens before
// SQLite is ready.
config.sessionName = '';

module.exports = config;
