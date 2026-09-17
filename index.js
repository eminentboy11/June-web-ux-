/**
 * A WhatsApp Bot
 * Built on Baileys | Inspired by JUNE-X structure
 */
// ─── Suppress pg SSL compatibility warning ──────────────────────────
process.on('warning', (warning) => {
    const message = String(warning?.message || '');

    if (
        warning?.code === 'SECURITY WARNING' ||
        message.includes('SECURITY WARNING') ||
        message.includes('The SSL modes') ||
        message.includes('pg-connection-string')
    ) {
        return;
    }

    // Keep all other warnings visible
    console.warn(warning);
});
// --- Environment Setup ---
require('dotenv').config();

// ─── Uptime Synchronization ──────────────────────────────────────────────────
// If JUNE_START_TIME is set (passed by the supervisor), monkey-patch 
// process.uptime() to reflect the total system uptime instead of just 
// the current process uptime.
if (process.env.JUNE_START_TIME) {
    const startTime = parseInt(process.env.JUNE_START_TIME);
    process.uptime = () => (Date.now() - startTime) / 1000;
}

/*************************************
 * Raw Output Suppression
 *
 * Baileys/libsignal may print recoverable old-session decrypt noise directly
 * to stdout/stderr, bypassing the configured Pino logger. Filter only the
 * known Bad MAC / SessionEntry chatter at stream level; ordinary errors remain.
 *************************************/
const originalWrite = process.stdout.write;
const originalWriteError = process.stderr.write;
const originalLog = console.log;
let suppressSignalStackUntil = 0;

const SIGNAL_NOISE_PATTERNS = [
    'closing session: sessionentry',
    'sessionentry {',
    'failed to decrypt message with any known session',
    'session error: error: bad mac',
    'bad mac error: bad mac',
    'decrypted message with closed session',
    'incoming prekey bundle',
];

function outputText(chunk) {
    if (typeof chunk === 'string') return chunk;
    if (Buffer.isBuffer(chunk)) return chunk.toString('utf8');
    try { return String(chunk); } catch (_) { return ''; }
}

function shouldSuppressSignalNoise(chunk) {
    const message = outputText(chunk);
    const lower = message.toLowerCase();
    const isKnownNoise = SIGNAL_NOISE_PATTERNS.some((pattern) => lower.includes(pattern));

    if (isKnownNoise) {
        // libsignal often prints the error header and stack trace as separate
        // writes. Suppress only its immediately following frames as well.
        suppressSignalStackUntil = Date.now() + 2500;
        return true;
    }

    const isLibsignalFrame =
        lower.includes('/libsignal/') ||
        lower.includes('session_cipher.js') ||
        lower.includes('queue_job.js') ||
        /^\s*at\s/.test(message) ||
        lower.trim() === '...';

    return Date.now() < suppressSignalStackUntil && isLibsignalFrame;
}

function acknowledgeSuppressedWrite(encoding, callback) {
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') {
        try { done(); } catch (_) {}
    }
    return true;
}

process.stdout.write = function (chunk, encoding, callback) {
    if (shouldSuppressSignalNoise(chunk)) {
        return acknowledgeSuppressedWrite(encoding, callback);
    }
    return originalWrite.apply(this, arguments);
};

process.stderr.write = function (chunk, encoding, callback) {
    if (shouldSuppressSignalNoise(chunk)) {
        return acknowledgeSuppressedWrite(encoding, callback);
    }
    return originalWriteError.apply(this, arguments);
};

console.log = function (message, ...optionalParams) {
    if (shouldSuppressSignalNoise(message)) return;
    originalLog.apply(console, [message, ...optionalParams]);
};

const fs = require('fs')
const chalk = require('chalk')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidNormalizedUser,
    makeCacheableSignalKeyStore,
    delay
} = require('@whiskeysockets/baileys')

const NodeCache = require('node-cache')
const pino = require('pino')
const readline = require('readline')
const { rmSync } = require('fs')
const moment = require('moment-timezone')
const lolcatjs = require('lolcatjs')
const { normalizeJidWithLid } = require('./utils/jidHelper')
const { applyFont } = require('./utils/fontConverter')
const {
    atomicWriteFile,
    createDiskManager,
} = require('./utils/juneDb/runtimeProtection')
const juneDatabase = require('./database')
const pgAdapter = require('./utils/juneDb/pgAdapter')
const mongoAdapter = require('./utils/juneDb/mongoAdapter')
const juneApiAdapter = require('./utils/juneDb/juneApiMirror')
const replayDrain = require('./utils/juneDb/replayDrain')
const {
    useSQLiteAuthState,
    getSQLiteAuthStats,
    validateSQLiteAuth,
    migrateFilesToSQLite,
    finalizePendingFileMigration,
    cleanupSessionQuarantines,
    getSessionIdFingerprint,
    setSessionIdFingerprint,
    getSessionIdRevokedFingerprint,
    setSessionIdRevokedFingerprint,
    getAuthSource,
    setAuthSource,
    isAuthConnectionVerified,
    setAuthConnectionVerified,
    isLocallyVerifiedAuth,
    hasVerifiedSQLiteAuth,
    clearSQLiteAuth,
    invalidateSQLiteAuth,
} = require('./utils/juneDb/auth-state')
const sessionServer = require('./utils/juneDb/sessionServer')

process.env.PUPPETEER_SKIP_DOWNLOAD = 'true'
process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'true'

// ─── Centralized Logger ───────────────────────────────────────────────────────

function log(message, color = 'white', isError = false) {
    // Console Theme Engine — dark = classic Ultra prefix style, light = June
    // Lite's timestamped style. Signature unchanged for every log() caller.
    require('./utils/consoleTheme').log(message, color, isError)
}
global.log = log;

// Console redaction — never print bot tokens or phone numbers in plaintext
const { maskNumber, maskBotId } = require('./utils/redact');

// ─── One-box Startup Report ──────────────────────────────────────────────────

const STARTUP_REPORT_WIDTH = 62

function startupPlain(value) {
    return String(value ?? '')
        .replace(/\r?\n/g, ' ')
        .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
}

function startupFit(value, width) {
    const text = startupPlain(value)
    return text.length > width
        ? `${text.slice(0, Math.max(0, width - 1))}…`
        : text.padEnd(width)
}

function startupStatusIcon(status) {
    const normalized = String(status || '').toLowerCase()
    if (['ok', 'ready', 'connected', 'active', 'online', 'enabled', 'passed'].includes(normalized)) {
        return chalk.green('✓')
    }
    if (['warn', 'warning', 'degraded', 'fallback', 'connecting'].includes(normalized)) {
        return chalk.yellow('!')
    }
    if (['off', 'disabled', 'not_set', 'unavailable', 'error', 'failed'].includes(normalized)) {
        return chalk.red('×')
    }
    return chalk.cyan('•')
}

function startupStatusText(status, label) {
    const normalized = String(status || '').toLowerCase()
    const text = label || status || 'unknown'
    if (['ok', 'ready', 'connected', 'active', 'online', 'enabled', 'passed'].includes(normalized)) {
        return chalk.green(text)
    }
    if (['warn', 'warning', 'degraded', 'fallback', 'connecting'].includes(normalized)) {
        return chalk.yellow(text)
    }
    if (['off', 'disabled', 'not_set', 'unavailable', 'error', 'failed'].includes(normalized)) {
        return chalk.red(text)
    }
    return chalk.cyan(text)
}

function startupRow(label, value, status) {
    const left = startupFit(label, 18)
    const right = status
        ? `${startupStatusIcon(status)} ${startupStatusText(status, value)}`
        : startupPlain(value)
    return `│  ${chalk.gray(left)} : ${right}`
}

function startupHeading(title) {
    return `│  ${chalk.cyan.bold(`◆ ${title}`)}`
}

function startupSeparator() {
    return `│  ${chalk.gray('─'.repeat(STARTUP_REPORT_WIDTH - 4))}`
}

function startupToggleValue(enabled) {
    return enabled ? chalk.green('•ON') : chalk.red('•OFF')
}

function startupTogglePair(leftLabel, leftEnabled, rightLabel, rightEnabled) {
    const left = `${chalk.gray(startupFit(leftLabel, 12))} ${startupToggleValue(leftEnabled)}`
    const right = `${chalk.gray(startupFit(rightLabel, 12))} ${startupToggleValue(rightEnabled)}`
    return `│  ${left} ${chalk.gray('│')} ${right}`
}

function normalizeStartupPostgres(postgres = {}) {
    if (postgres.available || postgres.ready) {
        return { ...postgres, status: 'connected', label: 'connected' }
    }
    return { ...postgres, status: 'disabled', label: 'not set' }
}

function getStartupToggleState() {
    const db = juneDatabase
    const statusSettings = db.loadSettings?.() || {}
    const _presence = (() => { try { return require('./utils/presenceSettings').getModes(); } catch (_) { return { pm: 'off', group: 'off' }; } })();
    const _anyTyping = _presence.pm === 'typing' || _presence.group === 'typing';
    const _anyRecording = _presence.pm === 'recording' || _presence.group === 'recording' || _presence.pm === 'recordtype' || _presence.group === 'recordtype';
    const _anyRecordType = _presence.pm === 'recordtype' || _presence.group === 'recordtype';
    const autoReact = (() => {
        try {
            return Boolean(require('./utils/autoReact').load().enabled)
        } catch (_) {
            return Boolean(db.getBotSetting?.('autoReact') ?? juneDatabase.getBotSetting('autoReact'))
        }
    })()
    // Auto-download status has one source of truth: SQLite bot_settings.
    const autoDownload = Boolean(db.getAutoDownloadStatusSettings().enabled)
    // Anti-feature configuration is read directly from SQLite. There is no
    // data/*.json or config.js fallback for these values.
    const antideleteMode = db.getAntideleteMode()
    const antideleteStatus = db.isAntideleteStatusEnabled()

    return {
        autoStatusView: Boolean(statusSettings.enabled),
        autoStatusReact: Boolean(statusSettings.react),
        autoTyping: _anyTyping,
        autoRecording: _anyRecording,
        autoRecordType: _anyRecordType,
        autoDownload,
        alwaysOnline: Boolean(db.getBotSetting?.('alwaysOnline')),
        antideleteStatus,
        autoReact,
        antiDelete: antideleteMode !== 'off',
    }
}


function printStartupReport(data = {}) {
    const now = data.time || new Date().toLocaleTimeString();
    const platform = data.platform || os.platform();
    const mode = String(data.mode || 'public').toUpperCase();
    const commandCount = data.commandCount ?? '—';
    
    // Get database info
    const dbInfo = data.databaseInfo || getExternalDatabaseStatus();
    
    // Build database rows
    let databaseRows = [
        startupHeading('DATABASE'),
        startupRow('SQLite', data.sqliteLabel || 'ready', data.sqliteStatus || 'ready'),
        startupRow('Driver', data.sqliteDriver || 'sql.js-fallback'),
        startupRow('Schema', data.schemaVersion ? `v${data.schemaVersion}` : '—'),
        startupRow('Integrity', data.integrityLabel || 'passed', data.integrityStatus || 'passed'),
    ];
    
    // Show both available remote adapters while none is configured. Once a
    // remote database is configured, show only the configured adapter(s).
    const configuredExternal = (dbInfo.databases || []).filter((entry) => entry.configured)
    databaseRows.push(startupSeparator());
    databaseRows.push(startupHeading(
        configuredExternal.length > 0 ? 'EXTERNAL DATABASE' : 'EXTERNAL DATABASES'
    ));

    if (configuredExternal.length === 0) {
        for (const entry of dbInfo.databases || []) {
            databaseRows.push(startupRow(entry.name, 'not configured', 'not_set'));
        }
    } else {
        for (const entry of configuredExternal) {
            databaseRows.push(startupRow(
                entry.name,
                entry.connected ? 'connected' : 'unavailable — SQLite fallback',
                entry.connected ? 'connected' : 'warning'
            ));
        }
    }
    
    const lines = [
        `┌${'─'.repeat(48- 2)}┐`,
        `┃${chalk.cyan('┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓').padEnd(10 - 1)}┃`,
        `┃${chalk.white.bold('        🤖 JUNE X (•ˇ_ˇ•) ULTRA STARTING...').padEnd(66 - 1)}┃`,
        `┃${chalk.cyan('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛').padEnd(10 - 1)}┃`,
        `├${'─'.repeat(48 - 2)}┤`,
        startupHeading('SYSTEM'),
        startupRow('Platform', platform),
        startupRow('Node.js', data.nodeVersion || process.version),
        startupRow('Time', now),
        startupRow('Startup', data.startupTime || '—'),
        startupSeparator(),
        startupHeading('CONFIGURATION'),
        startupRow('Prefix', data.prefix ?? '.'),
        startupRow('Mode', mode, 'active'),
        startupRow('Owner', data.owner || 'configured'),
        startupRow('Commands', `${commandCount} loaded${data.aliasCount ? ` (+${data.aliasCount} aliases)` : ''}`, 'ready'),
        startupSeparator(),
        ...databaseRows,
        startupSeparator(),
        startupHeading('TOGGLES'),
        startupTogglePair('Status View', data.toggles?.autoStatusView, 'Status React', data.toggles?.autoStatusReact),
        startupTogglePair('Typing', data.toggles?.autoTyping, 'Recording', data.toggles?.autoRecording),
        startupTogglePair('Record+Type', data.toggles?.autoRecordType, 'Auto-Save', data.toggles?.autoDownload),
        startupTogglePair('Auto-React', data.toggles?.autoReact, 'Always-On', data.toggles?.alwaysOnline),
        startupTogglePair('Anti-Delete', data.toggles?.antiDelete, 'Anti-Status', data.toggles?.antideleteStatus),
        startupSeparator(),
        startupHeading('RUNTIME PROTECTION'),
        startupRow('Disk manager', data.diskManagerLabel || 'active', data.diskManagerStatus || 'active'),
        startupRow('Atomic writes', data.atomicWritesLabel || 'enabled', data.atomicWritesStatus || 'enabled'),
        startupRow('Cache limits', data.cacheLabel || 'enabled', data.cacheStatus || 'enabled'),
        startupRow('Telemetry', data.telemetryLabel || 'enabled', data.telemetryStatus || 'enabled'),
        startupRow('Shutdown', data.shutdownLabel || 'protected', data.shutdownStatus || 'active'),
        startupSeparator(),
        startupHeading('AUTHENTICATION'),
        startupRow('Session', data.sessionLabel || 'restored', data.sessionStatus || 'ready'),
        startupRow('Auth source', data.authSource || 'SQLite'),
        startupRow('Signal keys', data.signalKeysLabel || 'verified', data.signalKeysStatus || 'ready'),
        startupRow('Session Srv', data.sessionServerLabel || 'not set', data.sessionServerStatus || 'off'),
        startupSeparator(),
        startupHeading('CONNECTION'),
        startupRow('WhatsApp', data.whatsappLabel || 'connecting', data.whatsappStatus || 'connecting'),
        startupRow('Account', data.accountLabel || 'hidden', data.accountStatus),
        startupRow('Group join', data.groupJoinLabel || 'not set', data.groupJoinStatus),
        `│  ${chalk.gray('─'.repeat(49 - 4))}`,
        `│  ${chalk.gray.bold('(•ˇ_ˇ•)  JUNE SYSTEM REPORT SUMMARY   (•ˇ_ˇ•)')}`,
  `│  ${chalk.gray('─'.repeat(49- 4))}`,
        `┗${'━'.repeat(46)}┛`,
    ];
    
    //console.clear();
    console.log(lines.join('\n'));
    
    // Log actual remote adapter state without exposing connection strings.
    const configuredExternalForLog = (dbInfo.databases || []).filter((entry) => entry.configured)
    const connectedExternal = configuredExternalForLog.filter((entry) => entry.connected)
    if (connectedExternal.length > 0) {
        log(`[ DATABASE ] External database connected: ${connectedExternal.map((entry) => entry.name).join(', ')}`, 'green');
    }
    if (configuredExternalForLog.some((entry) => !entry.connected)) {
        log('[ DATABASE ] A configured external database is unavailable; using SQLite safely.', 'yellow');
    }
    if (configuredExternalForLog.length === 0) {
        log('[ DATABASE ] No external database configured (using SQLite only)', 'cyan');
    }
}

// ─── Global Flags ─────────────────────────────────────────────────────────────

global.isBotConnected = false
global.connectDebounceTimeout = null
global.errorRetryCount = 0
    
global.isReconnecting = false   // Guard: prevents concurrent reconnect loops
global._consecutive500Count = 0  // Guard: only clear session after 3 real 500s in a row
global._conflictCount = 0       // Consecutive 409/440 device-conflict reconnects
global._lastConflictLogTime = 0 // Track when we last logged a conflict
global._suppressedConflictCount = 0 // Count suppressed messages
global._conflictSummaryTimer = null // Timer for summary message    
global._reconnectTimer = null
global._shutdownRequested = false
global.startupReportPrinted = false

// Use supervisor start time if available for continuous uptime tracking
global.startupStartedAt = process.env.JUNE_START_TIME 
    ? parseInt(process.env.JUNE_START_TIME) 
    : Date.now()

// Track active intervals so we can clear them on reconnect
global._activeIntervals = []

// ─── Dashboard state ──────────────────────────────────────────────────
global.botState   = 'disconnected'
global.currentSock = null
global.connectedAt = null

// ─── Paths ────────────────────────────────────────────────────────────────────

global.__CORE__ = __dirname
global.__ROOT__ = __dirname


// ─── Apply Persisted Runtime Settings ─────────────────────────────────────────
// Database access must happen after juneDatabase.ready resolves. Keeping this
// at module scope races the async sql.js fallback and leaves stmts undefined.
async function applyPersistedRuntimeSettings() {
    try {
        await juneDatabase.ready;
        const db = juneDatabase;
        // Nothing to hydrate any more: config.js is gone and every caller reads
        // database.getBotSetting() directly, so stored values are already live.
        // Only the presence flags below still need mirroring, because they are
        // owned by utils/presenceSettings rather than bot_settings.
        // Restore presence flags so .botstatus/.getsettings reflect the correct state
        try {
          const _m = require('./utils/presenceSettings').getModes();
          juneDatabase.setBotSetting('autoTyping', _m.pm === 'typing' || _m.group === 'typing');
          juneDatabase.setBotSetting('autoRecording', _m.pm === 'recording' || _m.group === 'recording' || _m.pm === 'recordtype' || _m.group === 'recordtype');
          juneDatabase.setBotSetting('autoRecordType', _m.pm === 'recordtype' || _m.group === 'recordtype');
        } catch (_) {}

        // Custom menu images stay in SQLite and are decoded directly by
        // commands/general/menu.js when a menu is sent. Do not rebuild or
        // maintain a persistent runtime image copy here.
    } catch (e) {
        log(`[ SETTINGS ] Could not load runtime settings: ${e.message}`, 'yellow');
    }
}

// Loaded only after database.ready in main(), because command modules may read
// database-backed settings during require-time.
let handler = null
const { saveSession, getSession, clearSession } = juneDatabase

const sessionDir = path.join(__dirname, juneDatabase.SESSION_NAME || 'session')
const credsPath = path.join(sessionDir, 'creds.json')
const envPath = path.join(process.cwd(), '.env')
// Login metadata and session-ID fingerprints are stored in SQLite metadata.
// Raw SESSION_ID values remain environment-only secrets.

// ─── Auto-generate .env if missing ────────────────────────────────────────────
if (!fs.existsSync(envPath)) {
    const defaultEnv = [
        '# June Ultra — Environment Variables',
        `# Official session mechanism: pair at ${sessionServer.getServerUrl()}/pair`,
        '# and paste your june-ultra:~ token here (JUNE_SESSION_TOKEN also works).',
        'SESSION_ID=',
        '',
        '# Optional: override bot port (default 5000)',
        '# PORT=5000',
    ].join('\n')
    atomicWriteFile(envPath, defaultEnv, 'utf8')
    log('[ .env ] No .env file found — created with default template.', 'green')
}

// ─── Direct .env SESSION_ID reader ───────────────────────────────────────────
function readSessionIDFromEnv() {
    try {
        if (!fs.existsSync(envPath)) return ''
        const lines = fs.readFileSync(envPath, 'utf8').split('\n')
        for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed.startsWith('#') || !trimmed.startsWith('SESSION_ID=')) continue
            // Everything after the first '=' is the value (preserves '=' inside base64)
            const value = trimmed.slice('SESSION_ID='.length).trim()
            return value
        }
    } catch (e) {
        log(`[ .env ] Failed to read SESSION_ID: ${e.message}`, 'red', true)
    }
    return ''
}

// Inject the directly-read value into process.env so the rest of the code
const _rawSessionID = readSessionIDFromEnv()
// A non-empty local .env value overrides the platform value. An empty local
// value intentionally leaves Heroku/Replit/Railway environment secrets intact.
if (_rawSessionID) process.env.SESSION_ID = _rawSessionID

// ─── Direct .env JUNE_SESSION_TOKEN reader (Session Server token) ───────────
// Additive centralized-session support: a june-ultra:~ token takes priority
// over a legacy SESSION_ID. It is routed through process.env.SESSION_ID so
// all existing fingerprint/revocation bookkeeping works unchanged.
function readJuneSessionTokenFromEnv() {
    try {
        if (!fs.existsSync(envPath)) return ''
        const lines = fs.readFileSync(envPath, 'utf8').split('\n')
        for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed.startsWith('#') || !trimmed.startsWith('JUNE_SESSION_TOKEN=')) continue
            return trimmed.slice('JUNE_SESSION_TOKEN='.length).trim()
        }
    } catch (e) {
        log(`[ .env ] Failed to read JUNE_SESSION_TOKEN: ${e.message}`, 'red', true)
    }
    return ''
}

function applyJuneSessionToken() {
    const fromFile = readJuneSessionTokenFromEnv()
    if (fromFile) process.env.JUNE_SESSION_TOKEN = fromFile
    // SESSION_ID is the OFFICIAL home of the token now: a june-ultra:~ value
    // in SESSION_ID feeds the Session Server flow directly.
    const fromSessionId = String(process.env.SESSION_ID || '').trim()
    if (fromSessionId && (sessionServer.isSessionServerToken(fromSessionId) || sessionServer.isJuneHandle(fromSessionId))
        && !String(process.env.JUNE_SESSION_TOKEN || '').trim()) {
        process.env.JUNE_SESSION_TOKEN = fromSessionId
    }
    const token = String(process.env.JUNE_SESSION_TOKEN || '').trim()
    if (!token) return false
    if (sessionServer.isSessionServerToken(token) || sessionServer.isJuneHandle(token)) {
        process.env.SESSION_ID = token
        return true
    }
    if (!process.env.JUNE_SESSION_TOKEN_NOTICE_SHOWN) {
        process.env.JUNE_SESSION_TOKEN_NOTICE_SHOWN = '1'
        log('[ SESSION SERVER ] JUNE_SESSION_TOKEN is set but not a valid june-ultra:~ token or JUNE~ Session ID — ignoring it.', 'yellow')
    }
    return false
}
applyJuneSessionToken()

// ─── Session Error Counter Helpers ───────────────────────────────────────────
// The retry state is stored in SQLite KV through database.js. No session error
// counter file is read or written.

function getPersistedSessionErrorState() {
    try {
        return juneDatabase.getSessionErrorState()
    } catch (error) {
        log(`Error loading session retry state: ${error.message}`, 'red', true)
        return { count: 0, last_error_timestamp: 0 }
    }
}

function setPersistedSessionErrorState(state) {
    try {
        return juneDatabase.setSessionErrorState(state)
    } catch (error) {
        log(`Error saving session retry state: ${error.message}`, 'red', true)
        return { count: 0, last_error_timestamp: 0 }
    }
}

function clearPersistedSessionErrorState() {
    try {
        juneDatabase.clearSessionErrorState()
        return true
    } catch (error) {
        log(`Failed to clear session retry state: ${error.message}`, 'red', true)
        return false
    }
}

// ─── Cleanup Functions ────────────────────────────────────────────────────────

function clearSessionFiles() {
    try {
        log('[ CLEARING ] session folder...', 'blue')
        if (fs.existsSync(sessionDir)) {
            const quarantinePath = `${sessionDir}.quarantine-${Date.now()}`
            try {
                fs.renameSync(sessionDir, quarantinePath)
                log(`[ SESSION ] Previous auth preserved at ${path.basename(quarantinePath)}.`, 'yellow')
            } catch (renameError) {
                log(`[ SESSION ] Could not quarantine old auth: ${renameError.message}`, 'yellow')
                rmSync(sessionDir, { recursive: true, force: true })
            }
        }
        juneDatabase.clearStoredLoginMethod()
        clearPersistedSessionErrorState()
        global.errorRetryCount = 0
        clearSession()
        clearSQLiteAuth(juneDatabase._db, 'session-cleared')
        // A deliberate local logout/session clear must not leave an older
        // remote auth state behind in the external mirror.
        juneDatabase.clearRemoteAuthState()
        clearSessionIdFingerprint()
        juneDatabase.markDatabaseDirty('session-cleared')
        log('[ SESSION ] files cleared successfully.', 'green')
    } catch (e) {
        log(`Failed to clear session files: ${e.message}`, 'red', true)
    }
}

const ROOT_TEMP_FILE_PATTERN = /^(?:tmp|temp|download|converted|upload|media|sticker)[._-]/i
const ROOT_TEMP_EXTENSIONS = new Set(['.gif', '.png', '.mp3', '.mp4', '.opus', '.jpg', '.jpeg', '.webp', '.webm', '.zip'])
const ROOT_TEMP_MAX_AGE_MS = 60 * 60 * 1000

function cleanupJunkFiles(sock) {
    const dir = path.join(__dirname)
    fs.readdir(dir, { withFileTypes: true }, (err, entries) => {
        if (err) return log(`[Junk Cleanup] Error reading dir: ${err}`, 'red', true)
        const cutoff = Date.now() - ROOT_TEMP_MAX_AGE_MS
        const junk = entries.filter((entry) => {
            if (!entry.isFile()) return false
            const ext = path.extname(entry.name).toLowerCase()
            if (!ROOT_TEMP_EXTENSIONS.has(ext) || !ROOT_TEMP_FILE_PATTERN.test(entry.name)) return false
            try {
                return fs.statSync(path.join(dir, entry.name)).mtimeMs < cutoff
            } catch (_) {
                return false
            }
        }).map((entry) => entry.name)

        if (junk.length === 0) return
        if (sock?.user?.id) {
            sock.sendMessage(sock.user.id.split(':')[0] + '@s.whatsapp.net', {
                text: `🧹 Removed ${junk.length} expired temporary file(s).`
            }).catch(() => {})
        }
        for (const file of junk) {
            try { fs.unlinkSync(path.join(dir, file)) } catch (_) {}
        }
        log(`[Junk Cleanup] Removed ${junk.length} expired temporary root file(s).`, 'yellow')
    })
}

let diskManager = null
function runEmergencyCleanup({ aggressive = false } = {}) {
    // Anti-delete records are SQLite-backed and bounded by database maintenance.
    try { juneDatabase.pruneAntideleteData?.() } catch (_) {}
    try { cleanupJunkFiles(null) } catch (_) {}
    try { cleanupExpiredSessionQuarantines('low-disk cleanup') } catch (_) {}
    try { handler?.cleanupRuntimeCaches?.(aggressive) } catch (_) {}
    try { Promise.resolve(juneDatabase.flushBackup?.()).catch(() => {}) } catch (_) {}
}

diskManager = createDiskManager({
    root: __dirname,
    cleanup: ({ aggressive }) => {
        runEmergencyCleanup({ aggressive })
        log(`[ DISK ] Low storage detected; ${aggressive ? 'emergency ' : ''}cleanup completed.`, 'yellow')
    },
})
global.diskManager = diskManager

// ─── Readline ─────────────────────────────────────────────────────────────────

const rl = process.stdin.isTTY
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null
const question = (text) => rl
    ? new Promise(resolve => rl.question(text, resolve))
    : Promise.resolve('')

// ─── Session Helpers ──────────────────────────────────────────────────────────

async function saveLoginMethod(method) {
    return juneDatabase.setStoredLoginMethod(method)
}

async function getLastLoginMethod() {
    return juneDatabase.getStoredLoginMethod()
}

function clearLoginMethod() {
    return juneDatabase.clearStoredLoginMethod()
}

function sessionExists() {
    return fs.existsSync(credsPath)
}

function fingerprintSessionId(sessionId) {
    return crypto.createHash('sha256').update(String(sessionId)).digest('hex')
}

function hasUsableFileSession() {
    if (!sessionExists()) return false
    try {
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'))
        return !!(creds && typeof creds === 'object' && (
            creds.noiseKey ||
            creds.signedIdentityKey ||
            creds.registrationId ||
            creds.registered === true
        ))
    } catch (_) {
        return false
    }
}

function rememberSessionIdFingerprint(fingerprint) {
    if (!fingerprint) return false

    setSessionIdFingerprint(juneDatabase._db, fingerprint)
    const persisted = getSessionIdFingerprint(juneDatabase._db)
    if (persisted !== fingerprint) {
        // Never print the fingerprint itself. The presence check is enough to
        // diagnose persistence without exposing any session-derived value.
        log('[ AUTH META ] SESSION_ID fingerprint could not be verified in SQLite.', 'red', true)
        return false
    }

    juneDatabase.markDatabaseDirty('session-id-fingerprint')
    return true
}

function clearSessionIdFingerprint() {
    setSessionIdFingerprint(juneDatabase._db, null)
    juneDatabase.markDatabaseDirty('session-id-fingerprint-cleared')
}

function markSessionIdFingerprintRevoked(fingerprint) {
    if (!fingerprint) return
    setSessionIdRevokedFingerprint(juneDatabase._db, fingerprint)
    juneDatabase.markDatabaseDirty('session-id-revoked')
}

function clearRevokedSessionIdFingerprint() {
    setSessionIdRevokedFingerprint(juneDatabase._db, null)
    juneDatabase.markDatabaseDirty('session-id-revocation-cleared')
}

function cleanupExpiredSessionQuarantines(source = 'startup') {
    const result = cleanupSessionQuarantines(sessionDir)
    if (result.removed.length > 0) {
        const details = []
        if (result.removedByRetention) details.push(`${result.removedByRetention} expired`)
        if (result.removedByLimit) details.push(`${result.removedByLimit} over limit`)
        log(
            `[ SESSION ] Removed ${result.removed.length} quarantine(s) during ${source}${details.length ? ` (${details.join(', ')})` : ''}.`,
            'yellow'
        )
    }
    return result
}

// A new SESSION_ID deliberately replaces file auth once. The old directory is
// preserved as a short-lived quarantine backup, never deleted during the swap.
function quarantineCurrentSessionForReplacement() {
    if (!fs.existsSync(sessionDir)) return null
    try {
        const entries = fs.readdirSync(sessionDir)
        if (entries.length === 0) {
            fs.rmSync(sessionDir, { recursive: true, force: true })
            return null
        }
        const quarantinedPath = `${sessionDir}.quarantine-${Date.now()}`
        fs.renameSync(sessionDir, quarantinedPath)
        return quarantinedPath
    } catch (error) {
        throw new Error(`Could not preserve the current session directory: ${error.message}`)
    }
}

// ─── Session Format Validator ─────────────────────────────────────────────────
// The ONLY accepted format is the Session Server token:
//   june-ultra:~<24 chars>  |  june-ultra:<custom-id>:~<24 chars>
// The legacy raw-session prefixes (Ultra-X:~/JUNE-MD:~/June-Ultra:~/June::~
// base64 strings) were RETIRED — hard cutover to the Session Server system.

const VALID_PREFIXES = ['june-ultra:~', 'june-ultra:', 'JUNE~', 'june~']
const LEGACY_SESSION_PREFIXES = ['JUNE-MD:~', 'Ultra-X:~', 'June-Ultra:~', 'June::~', 'ultra-x:~', 'June-X:~']

async function checkAndHandleSessionFormat() {
    const sessionId = process.env.SESSION_ID
    if (sessionId && sessionId.trim() !== '') {
        if (LEGACY_SESSION_PREFIXES.some(p => sessionId.trim().startsWith(p))) {
            log(chalk.black.bgRedBright('[ERROR]: The raw-session SESSION_ID format was RETIRED.'), 'white')
            log(chalk.white.bgRedBright('Your SESSION_ID is an old Ultra-X:~/JUNE-MD:~/June-Ultra:~ base64 string.'), 'white')
            log(chalk.white.bgRedBright('These no longer work. Migrate now:'), 'white')
            log(chalk.white.bgRedBright(`  1. Pair at ${sessionServer.getServerUrl()}/pair`), 'white')
            log(chalk.white.bgRedBright('  2. Set SESSION_ID to your new june-ultra:~ token'), 'white')
            log(chalk.white.bgRedBright('  3. Restart the bot. Exiting in 30 seconds...'), 'white')
            await delay(30000)
            process.exit(1)
        }
        if (!VALID_PREFIXES.some(p => sessionId.trim().startsWith(p))) {
            log(chalk.black.bgYellowBright('[ERROR]: Invalid SESSION_ID format.'), 'white')
            log(chalk.black.bgYellowBright('[SESSION ID] Must be a JUNE~ Session ID or a june-ultra:~ Session Server token.'), 'white')
            log(chalk.black.bgYellowBright(`Get one at ${sessionServer.getServerUrl()}/pair — then restart. Exiting in 20 seconds...`), 'white')
            await delay(20000)
            process.exit(1)
        }
    }
}

// ─── Download Session from SESSION_ID ─────────────────────────────────────────

async function downloadSessionData() {
    await fs.promises.mkdir(sessionDir, { recursive: true })
    if (!fs.existsSync(credsPath) && global.SESSION_ID) {
        const sid = global.SESSION_ID
        // Tokens are restored through the Session Server flow — never decoded
        // into a creds file here. The legacy raw-session download path was
        // RETIRED with the hard cutover.
        if (sessionServer.isSessionServerToken(sid) || sessionServer.isJuneHandle(sid)) return
        log('[ SESSION ] The raw-session SESSION_ID download path was retired. '
          + `Pair at ${sessionServer.getServerUrl()}/pair and use a june-ultra:~ token.`, 'red', true)
        process.exit(1)
    }
}

// ─── Restore Session from Database ────────────────────────────────────────────

async function restoreSessionFromDB() {
    if (sessionExists()) return false // already on disk, nothing to do
    const b64 = getSession()
    if (!b64) return false
    try {
        await fs.promises.mkdir(sessionDir, { recursive: true })
        const data = Buffer.from(b64, 'base64')
        JSON.parse(data.toString('utf8')) // validate
        atomicWriteFile(credsPath, data)
        return true
    } catch (e) {
        log(`⚠️ DB session restore failed`, 'yellow')
        clearSession()
        return false
    }
}


// ─── Login Method Selector ────────────────────────────────────────────────────

async function getLoginMethod() {
    const lastMethod = await getLastLoginMethod()
    if (lastMethod && sessionExists()) {
        return lastMethod
    }

    if (!sessionExists() && lastMethod) {
        clearLoginMethod()
    }

    if (!process.stdin.isTTY) {
        log('❌ No SESSION_ID found and no TTY available for interactive login.', 'red')
        process.exit(1)
    }

    log('Choose Any WhatsApp Login method:', 'green')
    log('1. ✓Enter Session ID', 'yellow')
    log('2. ✓Enter Phone Number', 'yellow')

    let choice = await question(chalk.greenBright('\nYour choice (1 or 2): '))
    choice = choice.trim()

    if (choice === '1') {
        log(`\nEnter your Session ID — get it at ${sessionServer.getServerUrl()}/pair`, 'yellow')
        log('Accepted format: JUNE~xxxxxx or june-ultra:~<token>', 'yellow')
        let sessionId = await question(chalk.greenBright('\nYour session token: '))
        sessionId = sessionId.trim()
        if (!VALID_PREFIXES.some(p => sessionId.startsWith(p))) {
            log('Invalid token! It must be a june-ultra:~ Session Server token (pair on the website).', 'red')
            process.exit(1)
        }

        global.SESSION_ID = sessionId
        // The Session Server client reads the token from the environment, not
        // from this global — set both so interactive entry behaves exactly
        // like a token configured in .env (fetch, sync and revoke all see it).
        process.env.SESSION_ID = sessionId
        process.env.JUNE_SESSION_TOKEN = sessionId
        await saveLoginMethod('session')
        return 'session'
    } else if (choice === '2') {
        log('\nEnter your WhatsApp phone number with country code.', 'green')
        log('Example: 2547xxxxxxxx', 'green')
        let phone = await question(chalk.greenBright('\nYour phone number: '))
        phone = phone.trim().replace(/[^0-9]/g, '')
        if (phone.length < 7) { log('Invalid phone number.', 'red'); return getLoginMethod() }
        global.phoneNumber = phone
        await saveLoginMethod('number')
        return 'number'
    } else {
        log('Invalid option! Please choose 1 or 2.', 'red')
        return getLoginMethod()
    }
}

// ─── Request Pairing Code ─────────────────────────────────────────────────────

async function requestPairingCode(socket) {
    try {
        log('Waiting 3 seconds for socket to stabilize...', 'yellow')
        await delay(3000)
        let code = await socket.requestPairingCode(global.phoneNumber)
        code = code?.match(/.{1,4}/g)?.join('-') || code
        log(chalk.black.bgCyanBright(`\n🔑 Your Pairing Code: ${code}\n`), 'white')
        log(`\n1. Open WhatsApp → Settings → Linked Devices\n2. Tap "Link a Device"\n3. Enter the code above\n`, 'blue')
        return true
    } catch (e) {
        log(`Failed to get pairing code: ${e.message}`, 'red', true)
        return false
    }
}

// ─── Welcome Message ───────────────────────────────────────────────────────────
function detectPlatform() {
  if (process.env.DYNO) return '☁️ Heroku';
  if (process.env.RENDER) return '⚡ Render';
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) return '🚉 Railway';
  if (process.env.REPLIT_SLUG || process.env.REPL_ID) return '🔵 Replit';
  if (process.env.PREFIX && process.env.PREFIX.includes('termux')) return '📱 Termux';
  if (process.env.PORTS && process.env.CYPHERX_HOST_ID) return '🌀 CypherX Platform';
  if (process.env.P_SERVER_UUID) return '🖥️ Panel';
  if (process.env.LXC) return '🐦‍⬛ Linux Container (LXC)';
  switch (os.platform()) {
    case 'win32': return '🪟 Windows';
    case 'darwin': return '🍎 macOS';
    case 'linux': return '🐧 Linux';
    default: return '❓ Unknown';
  }
}

async function sendWelcomeMessage(sock) {
    if (global.isBotConnected) return
    await delay(1500)
    try {
        if (!sock.user || global.isBotConnected) return
        global.isBotConnected = true
        const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net'
        const prefix = juneDatabase.getBotSetting('prefix') === '' ? 'none' : (juneDatabase.getBotSetting('prefix') || '.')
        const platform = detectPlatform()
        const ownerName = (Array.isArray(juneDatabase.getOwnerNames()) ? juneDatabase.getOwnerNames()[0] : juneDatabase.getOwnerNames()) || 'Bot Owner'

        const welcomeText = applyFont(
`┏━━━✧ CONNECTED ✧━━━━
┃✧ Bot: ${juneDatabase.getBotSetting('botName')}
┃✧ Prefix: [ ${prefix} ]
┃✧ Owner: ${ownerName}
┃✧ Platform: ${platform}
┃✧ Status: online 
┃✧ Time: ${new Date().toLocaleString()}
┃✧ T.Group: t.me/juneOff
┃✧ Telegram: t.me/supremlord
┃✧ Repo: https://github.com/Vinpink2
┗━━━━━━━━━━━━━━━` )

        // Creds-only warm start: instead of a separate message, fold the
        // warm-up info UNDER the CONNECTED banner behind WhatsApp's
        // "Read more" button (same LRM trick as menu.js). Only a
        // session-server restore warms up — manual pairings generate keys
        // during pairing, and restarts with local keys have nothing to
        // rebuild, so neither sees this.
        let outgoingText = welcomeText
        if (global._credsOnlyWarmStart) {
            global._credsOnlyWarmStart = false
            log(`[ AUTH ] Baileys is rebuilding your WhatsApp auth keys… this can take a few minutes on a whale-sized account. Early replies may be slow.`, 'yellow')
            // WhatsApp only renders the "Read more" fold past a length
            // threshold (~4-5k chars on Android, higher on iOS). The banner +
            // a 4001-char LRM run stayed UNDER it, so the warm-up text
            // showed fully expanded (reported on iOS). A 12k run puts the
            // total safely past every client's threshold while staying
            // invisible. Same trick as menu.js, just a longer run.
            const readmore = String.fromCharCode(8206).repeat(12000)
            const warmUpText = applyFont(
`🔥 WARMING UP…

Session restored — bot is online ✅

First replies may be slow for 2–3 minutes
while keys rebuild. Then: instant ⚡`
            )
            outgoingText = `${welcomeText}${readmore}\n${warmUpText}`
        }

        await sock.sendMessage(botJid, { text: outgoingText })

        clearPersistedSessionErrorState()
        global.errorRetryCount = 0
    } catch (e) {
        log(`Welcome message error: ${e.message}`, 'red', true)
        global.isBotConnected = false
    }
}

// ─── 408 Timeout Error Handler ────────────────────────────────────────────────

async function handle408Error(statusCode) {
    if (statusCode !== DisconnectReason.connectionTimeout) return false

    global.errorRetryCount++
    const MAX_RETRIES = 10
    const errorState = getPersistedSessionErrorState()
    errorState.count = global.errorRetryCount
    errorState.last_error_timestamp = Date.now()
    setPersistedSessionErrorState(errorState)

    log(`Connection Timeout (408). Retry ${global.errorRetryCount}/${MAX_RETRIES}`, 'yellow')

    if (global.errorRetryCount >= MAX_RETRIES) {
        log(chalk.black.bgYellowBright(`[MAX TIMEOUTS] ${MAX_RETRIES} reached. Waiting 60s before next attempt...`), 'white')
        clearPersistedSessionErrorState()
        global.errorRetryCount = 0
        await delay(60000)
    }
    return true
}

// ─── Session Integrity Check ──────────────────────────────────────────────────

async function checkSessionIntegrityAndClean() {
    const folderExists = fs.existsSync(sessionDir)
    const validSession = sessionExists()
    if (folderExists && !validSession) {
        if (hasVerifiedSQLiteAuth(juneDatabase._db)) {
            const files = fs.readdirSync(sessionDir)
            if (files.length > 0) {
                const quarantinePath = `${sessionDir}.incomplete-${Date.now()}`
                try {
                    fs.renameSync(sessionDir, quarantinePath)
                    log(`[ SESSION ] Incomplete session folder preserved at ${path.basename(quarantinePath)}.`, 'yellow')
                } catch (_) {}
            }
            return
        }
        clearSessionFiles()
        log('Cleanup done. Waiting 3 seconds...', 'yellow')
        await delay(3000)
    }
}

// ─── .env File Watcher ────────────────────────────────────────────────────────

function checkEnvStatus() {
    try {
        global._envWatcher = fs.watch(envPath, { persistent: false }, (eventType, filename) => {
            if (filename && eventType === 'change') {
                // Suppress restart when we ourselves wrote the session update.
                // Use a time-window (not a one-shot boolean) because fs.watch fires
                // multiple events per write on Linux/Replit.
                if (global._suppressEnvWatcherUntil && Date.now() < global._suppressEnvWatcherUntil) {
                    return
                }
                log(chalk.black.bgBlueBright('[ENV CHANGED] Restarting to apply new configuration...'), 'white')
                process.exit(1)
            }
        })
    } catch (e) {
        log(`⚠️ .env watcher failed: ${e.message}`, 'yellow')
    }
}

// ─── In-memory Message Store ──────────────────────────────────────────────────

const store = {
    messages: new Map(),
    maxPerChat: 20,
    bind(ev) {
        ev.on('messages.upsert', ({ messages }) => {
            for (const msg of messages) {
                if (!msg.key?.id) continue
                const jid = msg.key.remoteJid
                if (!store.messages.has(jid)) store.messages.set(jid, new Map())
                const chat = store.messages.get(jid)
                chat.set(msg.key.id, msg)
                if (chat.size > store.maxPerChat) {
                    chat.delete(chat.keys().next().value)
                }
            }
        })
    },
    async loadMessage(jid, id) {
        return store.messages.get(jid)?.get(id) || null
    }
}

// ─── Deduplication ────────────────────────────────────────────────────────────

const processedMessages = new Set()
setInterval(() => processedMessages.clear(), 5 * 60 * 1000)




// ─── Database Type Detection ──────────────────────────────────────────────

// ─── Get External Database Status ──────────────────────────────────────────

function getExternalDatabaseStatus() {
    const postgres = pgAdapter.getStatus?.() || {}
    const mongo = mongoAdapter.getStatus?.() || {}
    const juneApi = juneApiAdapter.getStatus?.() || {}
    const databases = [
        {
            name: 'PostgreSQL',
            configured: Boolean(postgres.configured || String(process.env.DATABASE_URL || '').trim()),
            connected: postgres.available === true,
            error: postgres.lastError ? 'connection unavailable' : null,
        },
        {
            name: 'MongoDB',
            configured: Boolean(mongo.configured || String(process.env.MONGODB_URI || process.env.MONGO_URL || '').trim()),
            connected: mongo.available === true,
            error: mongo.lastError ? 'connection unavailable' : null,
        },
        {
            name: 'June API',
            configured: juneApi.configured === true,
            connected: juneApi.available === true,
            error: juneApi.lastError ? 'connection unavailable' : null,
        },
    ]

    return {
        configured: databases.some((entry) => entry.configured),
        connected: databases.some((entry) => entry.connected),
        databases,
    }
}
// ─── Suppressed Logger ────────────────────────────────────────────────────────

const NOISE_PATTERNS = [
    'closing session', 'sessionentry', 'prekey bundle', 'pendingprekey',
    '_chains', 'registrationid', 'currentratchet', 'chainkey', 'ratchet',
    'signal protocol', 'ephemeralkeypair', 'indexinfo', 'basekey', 'ratchetkey', '(node:33) Warning:', '(node:33)','WARNING:','SECURITY',
]

function suppressedLogger() {
    const logger = pino({ level: 'silent' })
    logger.info = (...args) => {
        const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ').toLowerCase()
        if (!NOISE_PATTERNS.some(p => msg.includes(p))) pino({ level: 'info' }).info(...args)
    }
    logger.debug = () => {}
    logger.trace = () => {}
    return logger
}

// ─── System JID Filter ────────────────────────────────────────────────────────

const isSystemJid = (jid) => !jid ||
    jid.includes('@broadcast') ||
    jid.includes('status.broadcast') ||
    jid.includes('@newsletter')


// ─── Start Bot (Main Socket) ──────────────────────────────────────────────────

// ─── Baileys Version Cache ────────────────────────────────────────────────────
// Fetch the WA version once per process. Reconnect loops reuse the cached
// value so startup/reconnect never blocks on a remote network request.
let _baileysVersionCache = null
async function getBaileysVersion() {
    if (_baileysVersionCache) return _baileysVersionCache
    try {
        const result = await fetchLatestBaileysVersion()
        _baileysVersionCache = result.version
    } catch (e) {
        // Fallback to a known-good version so the bot still starts if GitHub is unreachable
        _baileysVersionCache = [2, 3000, 1023507977]
        log(`[ VERSION ] fetchLatestBaileysVersion failed (${e.message}). Using fallback version.`, 'yellow')
    }
    return _baileysVersionCache
}

async function startJunexBot() {
    if (global._shutdownRequested) return null
    // Reconnects must not leave the previous Baileys socket alive. A stale
    // socket can keep emitting updates and create the same duplicate-session
    // pressure as a second deployed bot instance.
    const previousSock = global.currentSock
    if (previousSock) {
        global.currentSock = null
        try { previousSock.ev?.removeAllListeners?.() } catch (_) {}
        try { previousSock.ws?.close?.() } catch (_) {}
        try { previousSock.end?.(new Error('replaced by reconnect')) } catch (_) {}
        await delay(250)
    }
    if (global._activeIntervals && global._activeIntervals.length > 0) {
        global._activeIntervals.forEach(id => clearInterval(id))
        global._activeIntervals = []
        log('[ CLEANUP ] Cleared stale intervals from previous connection.', 'yellow')
    }

    const version = await getBaileysVersion()
    const authStatsBeforeStart = getSQLiteAuthStats(juneDatabase._db)
    if (authStatsBeforeStart.pendingFileMigration && fs.existsSync(sessionDir)) {
        try {
            const finalized = await finalizePendingFileMigration(juneDatabase._db, sessionDir, {
                onMutation: (reason) => juneDatabase.markDatabaseDirty(reason),
            })
            if (finalized.ok) {
                log(`[ AUTH ] Finalized pending file-auth migration; session folder quarantined.`, 'green')
            }
        } catch (error) {
            log(`[ AUTH ] Pending file-auth migration deferred: ${error.message}`, 'yellow')
            log('[ AUTH ] Continuing with the previously verified SQLite snapshot.', 'yellow')
        }
    }
    const authValidation = await validateSQLiteAuth(juneDatabase._db, {
        onMutation: (reason) => juneDatabase.markDatabaseDirty(reason),
    })
    if (authValidation.repairedLidMappings > 0) {
        const count = authValidation.repairedLidMappings
        log(`[ AUTH ] Repaired ${count} malformed auxiliary LID mapping ${count === 1 ? 'row' : 'rows'}; valid Signal auth preserved.`, 'yellow')
        // Persist the repaired snapshot immediately. Otherwise a process
        // crash before the normal debounce window could restore the old bad
        // LID row from the database backup on the next boot.
        try {
            await juneDatabase.createBackup?.()
        } catch (backupError) {
            log(`[ AUTH ] Could not flush cleaned auth backup yet: ${backupError.message}`, 'yellow')
        }
    }
    if (authValidation.wasVerified && !authValidation.ok) {
        log(`[ AUTH ] ❌ SQLite startup validation failed: ${authValidation.reason}`, 'red', true)
        log('[ AUTH ] Recovery required: restore the last valid database backup or perform an explicit re-pair.', 'yellow')
        throw new Error(`AUTH_STARTUP_VALIDATION_FAILED: ${authValidation.reason}`)
    }

    let authState
    try {
        if (!hasVerifiedSQLiteAuth(juneDatabase._db)) {
            await fs.promises.mkdir(sessionDir, { recursive: true })
        }
        authState = await useSQLiteAuthState(juneDatabase._db, sessionDir, {
            allowFresh: true,
            allowFreshAfterInvalid: authStatsBeforeStart.invalidReason === 'session-cleared',
            onMutation: (reason) => juneDatabase.markDatabaseDirty(reason),
        })
    } catch (authError) {
        if (!authError.message?.startsWith('AUTH_MIGRATION_NO_KEY_FILES') &&
            !authError.message?.startsWith('AUTH_MIGRATION_NO_VALID_KEY_FILES')) {
            throw authError
        }
        //log('[ AUTH ] Only legacy creds.json is available; using file auth until Signal keys exist.', 'yellow')
        await fs.promises.mkdir(sessionDir, { recursive: true })
        const fileState = await useMultiFileAuthState(sessionDir)
        authState = { ...fileState, source: 'files', stats: getSQLiteAuthStats(juneDatabase._db) }
    }
    const { state, saveCreds } = authState
    // Creds-only warm start: 0 signal key rows means every WhatsApp key
    // regenerates after connecting — first messages may be slow for a few
    // minutes. ONLY a session-server restore warms up (fresh manual pairings
    // generate their keys during pairing; local restarts already have keys),
    // so the notice never fires in those cases.
    global._credsOnlyWarmStart = authState.source === 'sqlite' && authState.stats.totalKeys === 0 && getAuthSource(juneDatabase._db) === 'session-server'
    const authLine = `[ AUTH ] ${authState.source === 'sqlite' ? 'SQLite' : 'file'} auth active (${authState.stats.totalKeys} key rows).`
    if (global._credsOnlyWarmStart) {
        log(`${authLine} Creds-only restore — keys rebuild after connect (first messages slow ~2 min).`, 'cyan')
    } else {
        log(authLine, 'cyan')
    }
    const msgRetryCounterCache = new NodeCache()
    let fileMigrationInFlight = null
    let fileMigrationComplete = false
    let fileMigrationBlockedReason = null
    let credsUpdateMigrationTimer = null
    const CREDS_UPDATE_MIGRATION_DELAY_MS = Math.min(
        1500,
        Math.max(500, Number(process.env.JUNE_CREDS_MIGRATION_DELAY_MS) || 1000)
    )
    const tryMigrateFileAuth = async (trigger) => {
        if (authState.source !== 'files' || fileMigrationComplete) return null
        const currentStats = getSQLiteAuthStats(juneDatabase._db)
        if (currentStats.verified && !currentStats.pendingFileMigration) return null
        if (fileMigrationBlockedReason) return null
        if (fileMigrationInFlight) return fileMigrationInFlight
        fileMigrationInFlight = (async () => {
            try {
                const result = await migrateFilesToSQLite(juneDatabase._db, sessionDir, {
                    replace: true,
                    quarantine: false,
                    onMutation: (reason) => juneDatabase.markDatabaseDirty(reason),
                })
                authState.stats = result.stats
                fileMigrationComplete = true
                fileMigrationBlockedReason = null
                log(`[ AUTH ] File-auth snapshot migrated to SQLite after ${trigger}; quarantine will complete on the next start.`, 'green')
                return result
            } catch (error) {
                if (error.message?.startsWith('AUTH_MIGRATION_NO_VALID_KEY_FILES')) {
                    fileMigrationBlockedReason = error.message
                    log(`[ AUTH ] File-auth SQLite migration paused: ${error.message}`, 'yellow')
                } else if (!error.message?.startsWith('AUTH_MIGRATION_NO_KEY_FILES')) {
                    log(`[ AUTH ] File-auth migration after ${trigger} failed: ${error.message}`, 'yellow')
                }
                return null
            } finally {
                fileMigrationInFlight = null
            }
        })()
        return fileMigrationInFlight
    }

    // creds.update can fire while Baileys is still atomically replacing or
    // finishing creds.json. Debounce the file-auth snapshot migration so it
    // reads the completed file instead of a partial JSON write.
    const scheduleCredsUpdateMigration = () => {
        if (credsUpdateMigrationTimer) clearTimeout(credsUpdateMigrationTimer)
        credsUpdateMigrationTimer = setTimeout(() => {
            credsUpdateMigrationTimer = null
            if (global._shutdownRequested || global.currentSock !== sock) return
            void tryMigrateFileAuth('creds-update')
        }, CREDS_UPDATE_MIGRATION_DELAY_MS)
        credsUpdateMigrationTimer.unref?.()
    }

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' }))
        },
        // Stealth mode: connect without the "online" mark while stealth is on
        markOnlineOnConnect: (() => { try { return !require('./utils/stealthMode').isEnabled(); } catch (_) { return true; } })(),
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        downloadHistory: false,
        msgRetryCounterCache,
        getMessage: async (key) => {
            // rc13: LID-based DMs have remoteJid as @lid.
            // jidNormalizedUser preserves @lid as-is, so a direct lookup works.
            // But the message may have been stored under either the LID or the
            // phone JID depending on which arrived first — try both.
            const primaryJid = key.remoteJid?.endsWith('@lid')
                ? key.remoteJid
                : jidNormalizedUser(key.remoteJid)
            let stored = await store.loadMessage(primaryJid, key.id)
            if (!stored?.message && key.remoteJidAlt) {
                stored = await store.loadMessage(key.remoteJidAlt, key.id)
            }
            return stored?.message || ''
        }
    })

    store.bind(sock.ev)
    sock.botStore = store
    global.currentSock = sock

    // Stealth mode: silence presence updates + read receipts on this socket.
    // Wrapped per connection (checks the setting on every call), so every
    // reconnect is covered and toggling stealth takes effect immediately.
    try { require('./utils/stealthMode').applyToSocket(sock) } catch (_) {}

    // ── Connection Updates ──────────────────────────────────────────────────────
    let _pairingCodeRequested = false
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update

        // ── Pairing code flow: intercept QR and request a code instead ──────────
        if (qr && global.phoneNumber && !_pairingCodeRequested) {
            _pairingCodeRequested = true
            await requestPairingCode(sock)
        }

        if (connection === 'close') {
            global.isBotConnected = false
            global.botState = 'connecting'
            const statusCode = lastDisconnect?.error?.output?.statusCode
            const disconnectMessage = String(
                lastDisconnect?.error?.message ||
                lastDisconnect?.error?.output?.payload?.message ||
                ''
            ).toLowerCase()
            // Baileys can report a device conflict as 401 with "conflict".
            // That is recoverable and must not erase the verified session.
            const isConflict401 = statusCode === 401 && disconnectMessage.includes('conflict')

            // 403 is WhatsApp refusing the account outright — almost always a ban.
            // It was not handled, so it fell through to the generic branch and
            // reconnected every 5s forever, surviving restarts because the dead
            // credentials stayed in SQLite. Retrying a banned account is useless
            // and keeps hammering WhatsApp, so give up after a few attempts and
            // clear the session so a different number can pair.
            const isForbidden = statusCode === 403
            if (isForbidden) {
                global._forbiddenCount = (global._forbiddenCount || 0) + 1
                log(`[ BANNED ] WhatsApp refused this account (403) — attempt `
                  + `${global._forbiddenCount}/3. This usually means the number is banned.`, 'yellow')
            } else {
                global._forbiddenCount = 0
            }
            const bannedOut = isForbidden && global._forbiddenCount >= 3

            const loggedOut = !isConflict401 &&
                (statusCode === DisconnectReason.loggedOut || statusCode === 401 || bannedOut)

            if (bannedOut) {
                log(chalk.white.bgRedBright('☠️  Account refused by WhatsApp (403) three times.'), 'white')
                log('[ BANNED ] Clearing the stored credentials so another number can pair.', 'yellow')
                log('[ BANNED ] After pairing a new number, also update PN= in .env and run '
                  + '.setownernumber, or the bot keeps using the old number\'s data.', 'yellow')
            }

            if (loggedOut) {
                log(chalk.white.bgRedBright(`💥 Disconnected [${statusCode}] — logged out. Clearing session...`), 'white')
                // Remember only a hash so an expired SESSION_ID cannot cause an
                // endless file-download/relogin loop on the next startup.
                const configuredSessionId = process.env.SESSION_ID?.trim()
                if (configuredSessionId && VALID_PREFIXES.some((prefix) => configuredSessionId.startsWith(prefix))) {
                    markSessionIdFingerprintRevoked(fingerprintSessionId(configuredSessionId))
                }
                // Genuine WhatsApp logout (loggedOut / non-conflict 401 /
                // 403 ban-out) ONLY: revoke the server-side session so the
                // token can no longer fetch these credentials. Conflicts,
                // timeouts, 5xx and plain restarts never reach this branch.
                //
                // v3.0.1 exception: if the credentials in use were only a
                // mirror-restored copy that never opened a connection here,
                // this 401 rejects THOSE KEYS — it is not proof that the
                // server-side session died. Keep the token revocable at the
                // manage page instead of destroying a possibly healthy session;
                // the next start re-fetches the authoritative snapshot.
                if (getAuthSource(juneDatabase._db) === 'mirror-restore' && !isAuthConnectionVerified(juneDatabase._db)) {
                    log('[ SESSION SERVER ] Local auth was only a mirror copy; NOT revoking the server-side session — it will be re-fetched from the Session Server on the next start.', 'yellow')
                } else {
                    sessionServer.revokeSession('whatsapp-logout').catch(() => {})
                }
                global.botState = 'disconnected'
                global.connectedAt = null
                clearSessionFiles()
                log('Session cleared. Returning to login menu in 10 seconds...', 'yellow')
                for (let i = 10; i > 0; i--) {
                    log(`Restarting login in ${i}s...`, 'cyan')
                    await delay(1000)
                }
                log('Restarting login flow...', 'green')
                return main()
            } else {
                if (global.isReconnecting) {
                    return
                }
                global.isReconnecting = true

                const is408 = await handle408Error(statusCode)

                let waitMs
                // Conflict branches already provide a throttled reconnect message.
                // Avoid a second generic "Connection closed" line every retry.
                let showConnectionClosedLog = true
                if (is408) {
                    // 408 timeout — exponential backoff capped at 60s
                    waitMs = Math.min(5000 * Math.pow(2, Math.min(global.errorRetryCount, 3)), 60000)
                } else if (statusCode === 503) {
                    // 503 Service Unavailable — WhatsApp servers overloaded.
                    global.errorRetryCount++
                    setPersistedSessionErrorState({
                        count: global.errorRetryCount,
                        last_error_timestamp: Date.now(),
                    })
                    waitMs = Math.min(30000 * global.errorRetryCount, 300000) // 30s, 60s, 90s … max 5 min
                    log(chalk.black.bgYellowBright(`[503] WhatsApp servers unavailable. Retry ${global.errorRetryCount} — waiting ${waitMs / 1000}s...`), 'white')
                } else if (statusCode === 500) {
                    //Error 500
                    global._consecutive500Count = (global._consecutive500Count || 0) + 1
                    if (global._consecutive500Count >= 3) {
                        log(chalk.white.bgRedBright(`[500×${global._consecutive500Count}] Persistent server errors. Preserving verified auth state...`), 'white')
                        global._consecutive500Count = 0
                        log('[500] Keeping the verified SQLite auth state; this may be a transient server error.', 'yellow')
                        waitMs = 8000
                    } else {
                        log(chalk.black.bgYellowBright(`[500] WhatsApp error (attempt ${global._consecutive500Count}/3). Retrying without clearing session...`), 'white')
                        waitMs = 10000
                    }
                } else if (statusCode === 409 || statusCode === 440 || isConflict401) {
                    // 409/440 means the WhatsApp session was replaced or
                    // conflicted with another active client. This is not a
                    // logout and must never clear verified auth.
                    // The conflict branch below emits a throttled status line,
                    // so suppress the generic reconnect line for this cycle.
                    showConnectionClosedLog = false
                    global._conflictCount = (global._conflictCount || 0) + 1
                    const now = Date.now()
                    const lastLogTime = global._lastConflictLogTime || 0
                    const SUPPRESS_WINDOW = 3 * 60 * 1000 // 3 minutes
                    const shouldLog = (now - lastLogTime) > SUPPRESS_WINDOW
                    
                    if (global._conflictCount >= 10) {
                        waitMs = 300000
                        if (shouldLog) {
                            log(`[ CONFLICT ] Persistent device conflict (${statusCode} × ${global._conflictCount}). Waiting 5 minutes; close other WhatsApp bot instances.`, 'yellow')
                            global._lastConflictLogTime = now
                            global._suppressedConflictCount = 0
                        } else {
                            global._suppressedConflictCount++
                        }
                        global._conflictCount = 0
                    } else {
                        waitMs = Math.min(8000 + (global._conflictCount * 5000), 120000)
                        
                        if (shouldLog) {
                            // Initial message: show reconnection timing
                            log(`[ CONFLICT ] WhatsApp session replaced (${statusCode}). Reconnecting in ${waitMs / 1000}s.`, 'yellow')
                            global._lastConflictLogTime = now
                            global._suppressedConflictCount = 0
                            
                            // Set up summary message after suppress window ends
                            if (global._conflictSummaryTimer) clearTimeout(global._conflictSummaryTimer)
                            global._conflictSummaryTimer = setTimeout(() => {
                                if (global._suppressedConflictCount > 0) {
                                    log(`[ CONFLICT ] Repeated ${statusCode} conflicts suppressed — ${global._suppressedConflictCount} reconnect attempts.`, 'yellow')
                                }
                                global._suppressedConflictCount = 0
                                global._conflictSummaryTimer = null
                            }, SUPPRESS_WINDOW)
                        } else {
                            // Inside suppress window: just increment counter silently
                            global._suppressedConflictCount++
                        }
                    }
                } else {
                    waitMs = 5000
                }

                if (showConnectionClosedLog) {
                    log(`Connection closed (${statusCode}). Reconnecting in ${waitMs / 1000}s...`, 'yellow')
                }
                await new Promise(resolve => {
                    global._reconnectTimer = setTimeout(resolve, waitMs)
                    global._reconnectTimer.unref?.()
                })
                global._reconnectTimer = null
                if (global._shutdownRequested) {
                    global.isReconnecting = false
                    return
                }
                global.isReconnecting = false
                try {
                    await startJunexBot()
                } catch (error) {
                    const message = String(error?.message || error || 'unknown startup error')
                    const authFailure = message.includes('AUTH_STARTUP_VALIDATION_FAILED')
                    global.botState = 'connecting'
                    if (authFailure) {
                        log(`[ AUTH ] Reconnect stopped safely: ${message.replace(/^AUTH_STARTUP_VALIDATION_FAILED:\s*/, '')}`, 'yellow')
                        log('[ AUTH ] No auth data was cleared. Restore a known-good backup or explicitly re-pair to recover.', 'yellow')
                    } else {
                        const retryMs = 30000
                        log(`[ RECONNECT ] Startup retry failed safely: ${message}`, 'yellow')
                        log(`[ RECONNECT ] Retrying in ${retryMs / 1000}s...`, 'yellow')
                        global._reconnectTimer = setTimeout(() => {
                            global._reconnectTimer = null
                            void startJunexBot().catch(retryError => {
                                log(`[ RECONNECT ] Retry stopped safely: ${retryError?.message || retryError}`, 'yellow')
                            })
                        }, retryMs)
                        global._reconnectTimer.unref?.()
                    }
                }
            }
        } else if (connection === 'open') {
            global.isReconnecting = false
            global.errorRetryCount = 0
            global._forbiddenCount = 0   // a good connect clears any 403 streak
            clearPersistedSessionErrorState()
            global._consecutive500Count = 0  // Clear the 500 guard on successful connect
            global._conflictCount = 0
            
            // Clear conflict summary timer and show success
            if (global._conflictSummaryTimer) {
                clearTimeout(global._conflictSummaryTimer)
                global._conflictSummaryTimer = null
            }
            if (global._suppressedConflictCount > 0) {
                log(`[ CONFLICT ] Connection restored successfully.`, 'green')
                global._suppressedConflictCount = 0
            }
            global._lastConflictLogTime = 0
            
            global.botState = 'connected'
            global.connectedAt = Date.now()
            // v3.0.1 provenance: a real connection just opened with the current
            // SQLite auth state — from now on this store's auth is trusted for
            // the Session Server fast path. Never let bookkeeping break a connect.
            try {
                setAuthConnectionVerified(juneDatabase._db, true)
            } catch (_) {}
            // Drop only stale replay traffic for a brief, bounded period after
            // reconnect so WhatsApp backlog delivery cannot block live commands.
            replayDrain.markConnectionOpen()
            global.phoneNumber = null  // Clear so reconnects don't re-request pairing code
            const botNum = sock.user?.id?.split(':')[0] || 'unknown'

            // ── Owner identity ────────────────────────────────────────────
            // The paired account is the owner by definition, so derive it here
            // rather than making the user run a setup command.
            //
            //  - Claim only when no owner exists. A deliberate owner, or one
            //    kept from a previous pairing, is never overwritten silently.
            //  - The account's display name is handed to database.js as a
            //    runtime value, not stored, so .setownername still wins and a
            //    renamed WhatsApp account is picked up on the next boot.
            try {
                const pairedPn = String(sock.user?.id || '').split(':')[0].split('@')[0].replace(/\D/g, '')
                juneDatabase.setRuntimeOwnerName(sock.user?.name || sock.user?.verifiedName || '')

                if (pairedPn) {
                    const owners = juneDatabase.getOwners()
                    if (!owners.length) {
                        juneDatabase.setOwners([pairedPn], 'auto')
                        log(`[ OWNER ] Claimed ${maskNumber(pairedPn)} from the paired account.`, 'green')
                    } else if (!owners.includes(pairedPn)) {
                        // Re-paired to a different account. Left alone on
                        // purpose, but silence here would hide the fact that
                        // the previous number still holds owner rights.
                        log(`[ OWNER ] Paired as ${maskNumber(pairedPn)} but owner is ${owners.map((o) => maskNumber(o)).join(', ')} `
                          + `(set: ${juneDatabase.getOwnerSource() || 'unknown'}). Not changing — `
                          + `run .setownernumber ${maskNumber(pairedPn)} to update.`, 'yellow')
                    }
                }
            } catch (ownerErr) {
                log(`[ OWNER ] Could not resolve owner from the session: ${ownerErr.message}`, 'yellow')
            }

            // The real number is only knowable once connected. If it disagrees
            // with what keyed the remote store, every mirrored row is going to
            // the wrong partition — silent until someone wipes and restores.
            try {
                const remoteOn = !!(process.env.DATABASE_URL || process.env.MONGODB_URI || process.env.MONGO_URL)
                const src = global.__BOT_ID_SOURCE__
                if (remoteOn && src) {
                    const pairedPn = String(sock.user?.id || '').split(':')[0].split('@')[0].replace(/\D/g, '')
                    const configured = String(src).split('@')[0].split(':')[0].replace(/\D/g, '')
                    if (pairedPn && configured && pairedPn !== configured) {
                        log(`[ BOT ID ] PN is ${maskNumber(configured)} but this session is paired as ${maskNumber(pairedPn)}. `
                          + `Remote data is stored under "${maskBotId(pgAdapter.buildBotId(src))}". `
                          + `Set PN=${maskNumber(pairedPn)} in .env if that is wrong.`, 'yellow')
                    }
                }
            } catch (_) {}

            await tryMigrateFileAuth('connection-open')
            // Auto-export the session to .env so restarts never need re-login
            const cmdCount = handler.getCommandCount ? handler.getCommandCount() : '?'
            const aliasCount = handler.getAliasCount ? handler.getAliasCount() : 0
            const newsletters = ["120363405182019728@newsletter", "120363407337963331@newsletter"];
            const groupInvites = ["FiJ0HpoqKOS0llgeS1uydN", "HBFnfdfE501GRBbQPjXOGM", "DYypfAwEthA6N4VHreEC4O"];
            global.newsletters = newsletters;
            global.groupInvites = groupInvites;

            // Resolve the startup join result before printing the one-box report.
            // This keeps the connection summary complete and removes a duplicate
            // standalone "Group join failed" line below the box.
            let groupJoinLabel = 'Failed'
let groupJoinStatus = 'warning'

if (groupInvites.length > 0) {
    const joinResults = await Promise.allSettled(
        groupInvites.map(inv => sock.groupAcceptInvite(inv))
    )

    const hasSuccess = joinResults.some(
        result => result.status === 'fulfilled'
    )

    const errors = joinResults
        .filter(result => result.status === 'rejected')
        .map(result =>
            String(
                result.reason?.message ||
                result.reason ||
                'failed'
            ).toLowerCase()
        )

    const alreadyJoined = errors.some(error =>
        error.includes('already') ||
        error.includes('conflict')
    )

    if (hasSuccess) {
        groupJoinLabel = 'Connected'
        groupJoinStatus = 'connected'
    } else if (alreadyJoined) {
        groupJoinLabel = 'Joined already'
        groupJoinStatus = 'connected'
    } else {
        groupJoinLabel = 'Failed'
        groupJoinStatus = 'warning'
    }
}
           
            if (!global.startupReportPrinted) {
                const isUpdate = process.env.JUNE_IS_UPDATE === 'true';
                if (isUpdate) {
                    log('[ SYSTEM ] Bot respawned successfully after update.', 'green');
                    global.startupReportPrinted = true;
                } else {
                    const databaseHealth = juneDatabase.getDatabaseHealth()
                    const authStats = getSQLiteAuthStats(juneDatabase._db)
                    const postgres = pgAdapter.getStatus()
                    const mongo = mongoAdapter.getStatus()
                    const mode = juneDatabase.getBotMode?.() || 'public'
                    const diskReport = diskManager?.getStatus?.() || {}
                    const toggles = getStartupToggleState()
                    const owner = Array.isArray(juneDatabase.getOwnerNames())
                        ? juneDatabase.getOwnerNames()[0]
                        : (juneDatabase.getOwnerNames() || 'configured')
                    const startupSeconds = ((Date.now() - global.startupStartedAt) / 1000).toFixed(2)

                    const _startupData = ({
                        version: juneDatabase.VERSION,
                        platform: os.platform(),
                        nodeVersion: process.version,
                        prefix: juneDatabase.getBotSetting('prefix') === '' ? 'none' : (juneDatabase.getBotSetting('prefix') || '.'),
                        mode,
                        owner,
                        commandCount: cmdCount,
                        aliasCount,
                        startupTime: `${startupSeconds}s`,
                        sqliteLabel: databaseHealth.ok ? 'ready' : 'degraded',
                        sqliteStatus: databaseHealth.ok ? 'ready' : 'warning',
                        sqliteDriver: databaseHealth.driver || 'unknown',
                        schemaVersion: databaseHealth.schemaVersion,
                        integrityLabel: databaseHealth.lastIntegrityCheck?.ok === false
                            ? 'failed'
                            : 'passed',
                        integrityStatus: databaseHealth.lastIntegrityCheck?.ok === false
                            ? 'failed'
                            : 'passed',
                        postgres,
                        mongo,
                        toggles,
                        diskManagerLabel: diskReport.low ? 'low storage' : 'active',
                        diskManagerStatus: diskReport.low ? 'warning' : 'active',
                        sessionLabel: authStats.verified ? 'verified' : 'active',
                        sessionStatus: authStats.verified ? 'ready' : 'warning',
                        authSource: authState.source === 'sqlite' ? 'SQLite' : 'file auth',
                        sessionServerLabel: sessionServer.isTokenModeActive()
                            ? (sessionServer.isAuthenticated() ? 'connected' : 'token set')
                            : 'not set',
                        sessionServerStatus: sessionServer.isTokenModeActive() ? 'connected' : 'off',
                        signalKeysLabel: `${authStats.totalKeys || 0} key rows`,
                        signalKeysStatus: authStats.verified ? 'ready' : 'warning',
                        whatsappLabel: 'connected',
                        whatsappStatus: 'connected',
                        accountLabel: `+${String(botNum).slice(0, 3)}******${String(botNum).slice(-3)}`,
                        accountStatus: 'connected',
                        groupJoinLabel,
                        groupJoinStatus,
                        databaseInfo: getExternalDatabaseStatus(),
                    })
                    if (require('./utils/consoleTheme').currentTheme() === 'light') {
                        // ☀️ Day boot = June Lite's timestamped banner
                        require('./utils/consoleTheme').bootBanner(_startupData)
                    } else {
                        // 🌙 Night boot = Ultra's classic one-box report
                        printStartupReport(_startupData)
                    }
                    global.startupReportPrinted = true
                }
            }
            if (!global.welcomeSent) {
                global.welcomeSent = true
                await sendWelcomeMessage(sock)
            }
            handler.initializeAntiCall(sock)

            // Scheduled website pinger (.pinger command): attach the socket so
            // status-transition DMs can reach the owner; loads persisted targets.
            require('./utils/pinger').onBotConnected(sock)

            // Notes reminders (.mynotes remind / .note-remind): attach the
            // socket for reminder DMs; the scanner loads persisted reminders.
            require('./utils/notes').onBotConnected(sock)

            // Session Server background sync (token mode only): authenticate,
            // verify the session belongs to this account, push the latest
            // verified auth state, and start the heartbeat. Never blocks the
            // connection on server availability.
            sessionServer.onBotConnected(juneDatabase._db, { botVersion: juneDatabase.VERSION }).catch(() => {})

            // ── Auto-follow newsletters (non-blocking) ──
            setImmediate(async () => {
                await Promise.allSettled(
                    newsletters.filter(Boolean).map(n =>
                        sock.newsletterFollow(n)
                            .catch(e => {
                                if (!e.message?.includes('already') && !e.message?.includes('conflict') && !e.message?.includes('unexpected')) {
                                    log(`🚫 Newsletter follow failed: ${e.message}`, 'red');
                                }
                            })
                    )
                );
            });

            // Apply always-online heartbeat if enabled
            try {
                const aolMod = require('./commands/owner/alwaysonline')
                const aolSettings = aolMod.loadSettings()
                if (aolSettings.enabled) {
                    aolMod.startHeartbeat(sock)
                }
            } catch (_) {}
        }
    })

    // ── Message Handler ────────────────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return
        messages = messages.filter((msg) => !replayDrain.isReplayMessage(msg))
        if (messages.length === 0) return

        // ── Status Handler ─────────────────────────────────────────────────────
        // shared settings module required once outside the loop for efficiency
        const { loadSettings, pickEmoji } = require('./database')
        const { handleAutoDownloadStatus } = require('./commands/owner/autodownloadstatus')

        // ── Reaction queue: one at a time, properly spaced ──
        if (!global._sReactQueue) {
            global._sReactQueue = []
            global._sReactQueueRunning = false
        }

        function enqueueStatusReact(job) {
            global._sReactQueue.push(job)
            if (!global._sReactQueueRunning) runStatusReactQueue()
        }

        async function runStatusReactQueue() {
            global._sReactQueueRunning = true
            while (global._sReactQueue.length) {
                const { sock, emoji, reactKey, normPart } = global._sReactQueue.shift()
                try {
                    await sock.sendMessage('status@broadcast', {
                        react: { text: emoji, key: reactKey }
                    }, { statusJidList: [normPart] })
                    // STATUS DEBUG LOG — commented out to reduce noise; re-enable for diagnostics
                    // log(`[ STATUS ] Reacted ${emoji} to status ${reactKey?.id || '?'} from ${normPart}`, 'green')
                } catch (e) {
                    log(`[ STATUS ] Auto-react FAILED for ${reactKey?.id || '?'}: ${e.message}`, 'red')
                }
                // space out reactions — 2.5–4s between each, not concurrent
                await new Promise(r => setTimeout(r, 2500 + Math.floor(Math.random() * 1500)))
            }
            global._sReactQueueRunning = false
        }

        for (const msg of messages) {
            if (!msg.message || !msg.key?.id) continue
            const from = msg.key.remoteJid

            // Only process status@broadcast, skip own messages
            if (from !== 'status@broadcast' || msg.key.fromMe) continue

            // Skip protocol/system messages — not real statuses
            if (msg.message?.protocolMessage) continue
            if (msg.messageStubType) continue

            const rawPart  = msg.key.participant

            // IMPORTANT (Baileys v7 / LID): msg.key.participant may be a @lid JID.
            // Read receipts and status reactions must echo the EXACT identity
            // WhatsApp delivered — normalizeJidWithLid would otherwise fabricate a
            // "<lid>@s.whatsapp.net" phone JID that does not exist, and WhatsApp
            // silently drops receipts/reacts addressed to it.
            const receiptPart = rawPart || msg.key.participantAlt || null
            const normPart = rawPart ? normalizeJidWithLid(rawPart) : (msg.key.participantAlt || null)

            // STATUS DEBUG LOG — commented out to reduce noise; re-enable for diagnostics
            // log(`[ STATUS ] Status seen: id=${msg.key.id} participant=${rawPart || 'none'} alt=${msg.key.participantAlt || 'none'}`, 'cyan')

            // Skip if the status came from the bot itself (check BOTH the
            // connected account's phone JID and its LID).
            const partBare = receiptPart ? String(receiptPart).split(':')[0].split('@')[0] : null
            const myBares = [sock.user?.id, sock.user?.lid]
                .filter(Boolean)
                .map((id) => String(id).split(':')[0].split('@')[0])
            if (partBare && myBares.includes(partBare)) continue

            // Store status for .getsw command
            if (normPart && msg.message) {
                if (!global.statusStore) global.statusStore = new Map()
                const existing = global.statusStore.get(normPart) || []
                existing.push(msg)
                if (existing.length > 20) existing.shift()
                global.statusStore.set(normPart, existing)
            }

            // Auto-download status before anti-delete storage
            try {
                await handleAutoDownloadStatus(sock, msg.key, msg.message)
            } catch (_) {}

            // Store status for antideletestatus (recover deleted statuses)
            try {
                const antideletestatus = require('./commands/owner/antideletestatus')
                if (antideletestatus?.storeStatusMessage) antideletestatus.storeStatusMessage(msg)
            } catch (_) {}

            try {
                const s = loadSettings()
                // STATUS DEBUG LOG — commented out to reduce noise; re-enable for diagnostics
                // log(`[ STATUS ] Gates: autoview=${s.enabled ? 'ON' : 'off'} autoreact=${s.react ? 'ON' : 'off'} — will${receiptPart ? '' : ' NOT'} process (participant ${receiptPart || 'missing'})`, 'cyan')

                // Auto View — readMessages alone dispatches the correct receipt
                // type for status@broadcast keys. Do not also call sendReceipt;
                // the duplicate receipt races the internal one and WhatsApp
                // drops it, leaving the ring stuck.
                if (s.enabled && receiptPart) {
                    const readKey = {
                        remoteJid: 'status@broadcast',
                        id: msg.key.id,
                        participant: receiptPart,
                        fromMe: false,
                    }
                    await new Promise(r => setTimeout(r, 500 + Math.floor(Math.random() * 500)))
                    try {
                        await sock.readMessages([readKey])
                        // STATUS DEBUG LOG — commented out to reduce noise; re-enable for diagnostics
                        // log(`[ STATUS ] Viewed status ${msg.key.id} from ${receiptPart}`, 'green')
                    } catch (viewErr) {
                        log(`[ STATUS ] Auto-view FAILED for ${msg.key.id}: ${viewErr.message}`, 'red')
                    }
                }

                // Auto React — routed through the serialized queue, no inline setTimeout
                if (s.react && receiptPart) {
                    if (!global._sReactedIds) global._sReactedIds = new Set()
                    if (!global._sReactedIds.has(msg.key.id)) {
                        global._sReactedIds.add(msg.key.id)
                        // Keep set bounded
                        if (global._sReactedIds.size > 500) {
                            global._sReactedIds.delete(global._sReactedIds.values().next().value)
                        }

                        enqueueStatusReact({
                            sock,
                            emoji: pickEmoji(s) || '💙',
                            reactKey: {
                                remoteJid:   'status@broadcast',
                                id:          msg.key.id,
                                participant: receiptPart,
                                fromMe:      false,
                            },
                            normPart: receiptPart,
                        })
                    }
                }
            } catch (e) {
                log(`[ STATUS ] Handler error: ${e.message}`, 'red')
            }
        }
        // ── End Status Handler ─────────────────────────────────────────────────

        // Route commands
        for (const msg of messages) {
            if (!msg.message || !msg.key?.id) continue
            const from = msg.key.remoteJid
            if (!from || isSystemJid(from)) continue
            if (processedMessages.has(msg.key.id)) continue

            const MESSAGE_AGE_LIMIT = 5 * 60 * 1000
            if (msg.messageTimestamp && (Date.now() - msg.messageTimestamp * 1000) > MESSAGE_AGE_LIMIT) continue

            processedMessages.add(msg.key.id)

            // Store message
            if (!store.messages.has(from)) store.messages.set(from, new Map())
            store.messages.get(from).set(msg.key.id, msg)

            // Unwrap ephemeral/view-once wrappers
            if (msg.message?.ephemeralMessage) {
                msg.message = msg.message.ephemeralMessage.message
            }

            // ── JUNE-X Style Message Log ────────────────────────────────────────
            // Themed gate: this rainbow log is the DARK theme's message
            // display. In light (Lite) theme the boxed Lite-style logger in
            // handler.js is shown instead — never both at once.
            let _msgLogDark = true
            try { _msgLogDark = require('./utils/consoleTheme').currentTheme() === 'dark' } catch (_) {}
            if (msg.message && _msgLogDark) {
                try {
                    const tz = juneDatabase.getTimeZone() // same clock as the whole bot
                    const mtype = Object.keys(msg.message)[0] || 'N/A'
                    const pushname = msg.pushName || 'N/A'
                    const body = msg.message?.conversation
                        || msg.message?.extendedTextMessage?.text
                        || msg.message?.imageMessage?.caption
                        || msg.message?.videoMessage?.caption
                        || ''
                    const isGrp = from.endsWith('@g.us')
                    let groupName = null
                    if (isGrp) {
                        try {
                            const meta = await handler.getGroupMetadata(sock, from)
                            groupName = meta?.subject || null
                        } catch (_) {}
                    }
                    const dayz = moment(Date.now()).tz(tz).locale('en').format('dddd')
                    const timez = moment(Date.now()).tz(tz).locale('en').format('HH:mm:ss z')
                    const datez = moment(Date.now()).tz(tz).format('DD/MM/YYYY')
                    lolcatjs.fromString(`┏━━━━━━━━━━━━━『  JUNE ULTRA 』━━━━━━━━━━━━━─`)
                    lolcatjs.fromString(`»  Sent Time: ${dayz}, ${timez}`)
                    lolcatjs.fromString(`»  Date: ${datez}`)
                    lolcatjs.fromString(`»  Message Type: ${mtype}`)
                    lolcatjs.fromString(`»  Sender Name: ${pushname}`)
                    lolcatjs.fromString(`»  Chat ID: ${from.split('@')[0]}`)
                    if (isGrp && groupName) {
                        lolcatjs.fromString(`»  Group: ${groupName}`)
                        lolcatjs.fromString(`»  Group JID: ${from.split('@')[0]}`)
                    }
                    if (body) lolcatjs.fromString(`»  Message: ${body}`)
                    lolcatjs.fromString('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━─ ⳹\n')
                } catch (_) {}
            }
            // ───────────────────────────────────────────────────────────────────

            // Auto-save status: triggered when someone replies to a status
            setImmediate(() => {
                try {
                    const saveStatusMod = require('./commands/owner/savestatus')
                    saveStatusMod.handleStatusReply(sock, msg).catch(() => {})
                } catch (_) {}
            })

            // Auto-read (.autoread): mark incoming chat messages read per the
            // configured mode. Fire-and-forget; failures are swallowed inside
            // and can never block or break message handling.
            require('./commands/owner/autoread').readMessageIfEnabled(sock, msg).catch(() => {})

            // Handle command
            handler.handleMessage(sock, msg).catch(err => {
                if (!err.message?.includes('rate-overlimit') && !err.message?.includes('not-authorized')) {
                    log(`Message handler error: ${err.message}`, 'red', true)
                }
            })

            // Note: antilink is handled inside handler.handleMessage via Promise.allSettled
        }
    })

    // ── Credentials + Group Events ─────────────────────────────────────────────
    sock.ev.on('creds.update', async () => {
        await saveCreds()
        // Persist to database so session survives restarts without re-login
        saveSession(credsPath)
        if (authState.source === 'sqlite') juneDatabase.markDatabaseDirty('auth-creds')
        // Session Server (token mode only): keep the server copy of the
        // evolved Signal keys fresh, debounced — no-op without a token.
        sessionServer.scheduleAuthPush(juneDatabase._db, 'creds-update')
        // Wait briefly for Baileys to finish the credentials write before the
        // file-auth migration attempts to parse its JSON snapshot.
        scheduleCredsUpdateMigration()
        // Session export is disabled by default; this is a no-op unless the
        // owner explicitly enables JUNE_EXPORT_SESSION_TO_ENV.
    })

    // ── Presence Tracker ───────────────────────────────────────────────────────
    if (!global.presenceStore) global.presenceStore = {}

    sock.ev.on('presence.update', ({ id, presences }) => {
        try {
            for (const [jid, data] of Object.entries(presences)) {
                global.presenceStore[jid] = {
                    status: data.lastKnownPresence || 'unavailable',
                    lastSeen: data.lastSeen || null,
                    updatedAt: Date.now()
                }
                try {
                    juneDatabase.recordRuntimeTelemetry('presence', jid, {
                        chatId: id,
                        status: data.lastKnownPresence || 'unavailable',
                    })
                } catch (_) {}
            }
        } catch (e) {
            log(`[Presence] update error: ${e.message}`, 'yellow')
        }
    })

    sock.ev.on('group-participants.update', async (update) => {
        try { await handler.handleGroupUpdate(sock, update) } catch (e) {
            log(`Group update error: ${e.message}`, 'red', true)
        }
    })

    // ── Newsletter Auto-React ───────────────────────────────────────────────────
    const NEWSLETTERS = [
        '120363405182019728@newsletter',
        '120363405182019728@newsletter',
        '120363366284524544@newsletter',
    ];
    const _newsletterEmojis = ['❤️','💛','👍','💜','😮','🤍','💙'];
    sock.ev.on('messages.upsert', async (mek) => {
        try {
            const msg = mek.messages[0];
            if (!msg?.message || !msg?.key?.server_id) return;
            if (!NEWSLETTERS.includes(msg.key.remoteJid)) return;
            const emoji = _newsletterEmojis[Math.floor(Math.random() * _newsletterEmojis.length)];
            await sock.newsletterReactMessage(msg.key.remoteJid, msg.key.server_id.toString(), emoji);
        } catch {}
    })

    // ── Background Cleanup Intervals ───────────────────────────────────────────

    // Auth key files are live Signal state. Never delete them by age.
    // Only remove completed migration quarantines after the configured retention.
    global._activeIntervals.push(setInterval(() => {
        cleanupExpiredSessionQuarantines('scheduled cleanup')
    }, 6 * 60 * 60 * 1000))

    // Junk file cleanup (every 10 minutes)
    global._activeIntervals.push(setInterval(() => cleanupJunkFiles(sock), 10 * 60 * 1000))

    return sock
}

// ─── Session Server Token Flow (additive) ─────────────────────────────────────
// Activates ONLY when a june-ultra:~ token is configured. Semantics mirror the
// legacy SESSION_ID policy exactly: the token is a provisioning/recovery input
// and NEVER overrides a verified local SQLite auth state unless
// JUNE_FORCE_SESSION_BOOTSTRAP=true is set. All legacy formats and flows are
// untouched when no token is present.

async function connectViaSessionServerToken({ token, fingerprint, sqliteAuthReady, sameToken, forceBootstrap, usableFileSession }) {
    // Hard format + configuration errors: fail loudly like the legacy
    // invalid-SESSION_ID path, then exit so the owner can fix the environment.
    if (!sessionServer.isSessionServerToken(token) && !sessionServer.isJuneHandle(token)) {
        const problem = sessionServer.describeTokenProblem(token)
        log(chalk.black.bgYellowBright(`[ERROR]: Invalid session credential (${problem}).`), 'white')
        log(chalk.black.bgYellowBright('A Session ID looks like: JUNE~ab12cd — or a legacy june-ultra:~ token.'), 'white')
        if (problem === 'legacy-string-in-token-var') {
            log(chalk.black.bgYellowBright('That value is a legacy base64 session string — put it in SESSION_ID instead.'), 'white')
        }
        await delay(10000)
        process.exit(1)
    }
    log('[ SESSION SERVER ] Token configured (redacted) — fetching the authoritative session…', 'cyan')

    // FAST PATH — verified local auth exists: the token is only a recovery
    // input, exactly like a legacy SESSION_ID. Connect immediately; the
    // background sync (sessionServer.onBotConnected) refreshes the server copy.
    if (sqliteAuthReady && !forceBootstrap && isLocallyVerifiedAuth(juneDatabase._db)) {
        // v3.0.1: honest fingerprint reporting. A missing stored fingerprint
        // (fresh or mirror-restored store) is NOT a token change.
        const storedFingerprint = getSessionIdFingerprint(juneDatabase._db)
        if (fingerprint && storedFingerprint !== fingerprint) {
            if (storedFingerprint) {
                log('[ SESSION SERVER ] Token changed; keeping the verified local auth (set JUNE_FORCE_SESSION_BOOTSTRAP=true to replace it).', 'yellow')
            }
            rememberSessionIdFingerprint(fingerprint)
        }
        await saveLoginMethod('session')
        await startJunexBot()
        return
    }

    // v3.0.1: auth rows exist but are unproven (mirror-restored this boot, or
    // restored and never connected). Connecting with them can draw a false
    // 401-logout that would also revoke a healthy server-side session — fetch
    // the authoritative snapshot from the Session Server instead.
    if (sqliteAuthReady && !forceBootstrap) {
        log('[ SESSION SERVER ] Local auth was restored from a mirror and has never opened a connection here; fetching the authoritative session from the Session Server instead of trusting the mirror copy.', 'yellow')
    }

    // FULL BOOTSTRAP — no usable local auth (or an explicit forced replace):
    // fetch the encrypted session from the server and restore it into SQLite.
    if (forceBootstrap && sessionExists()) {
        log('[ SESSION SERVER ] Forced bootstrap — preserving prior file auth first.', 'yellow')
        try {
            const oldSessionPath = quarantineCurrentSessionForReplacement()
            if (oldSessionPath) {
                log(`[ SESSION ] Previous file auth preserved at ${path.basename(oldSessionPath)}.`, 'yellow')
            }
        } catch (error) {
            log(`[ SESSION SERVER ] Could not quarantine prior file auth: ${error.message}`, 'yellow')
        }
    }
    let attempt = 0
    while (!global._shutdownRequested) {
        try {
            const result = await sessionServer.fetchAndRestoreSnapshot(juneDatabase._db)
            log(`[ SESSION SERVER ] ✅ Auth state restored (${result.keyRows} signal key rows). Connecting...`, 'green')
            juneDatabase.markDatabaseDirty('session-server-restore')
            // v3.0.1: authoritative restore — this state is trusted for the
            // fast path, and a 401 on it is genuine evidence the session died.
            setAuthSource(juneDatabase._db, 'session-server')
            setAuthConnectionVerified(juneDatabase._db, true)
            rememberSessionIdFingerprint(fingerprint)
            clearRevokedSessionIdFingerprint()
            await saveLoginMethod('session')
            await startJunexBot()
            return
        } catch (error) {
            if (error.terminal) {
                log(`[ SESSION SERVER ] ❌ ${error.code}: ${error.message}`, 'red', true)
                log('[ SESSION SERVER ] This token can no longer be used. Pair again on the website, update JUNE_SESSION_TOKEN, and restart.', 'yellow')
                checkEnvStatus()
                return
            }
            // A missing token is a configuration error, not a network problem —
            // retrying can never succeed. Fail fast with actionable guidance.
            if (/No valid JUNE_SESSION_TOKEN/.test(error.message || '')) {
                log('[ SESSION SERVER ] ❌ The session token is missing from the environment — this is a configuration error, not a network problem.', 'red', true)
                log('[ SESSION SERVER ] Add SESSION_ID=<token> (or JUNE_SESSION_TOKEN=<token>) to .env or your host panel, then restart.', 'yellow')
                checkEnvStatus()
                return
            }
            if (error.code === 'session_in_use') {
                const takeover = /^(1|true|yes|on)$/i.test(String(process.env.JUNE_TAKEOVER_SESSION || ''))
                if (takeover) {
                    try {
                        await sessionServer.authenticate({ takeover: true })
                        continue
                    } catch (takeoverError) {
                        if (takeoverError.terminal) { error = takeoverError; continue }
                        log(`[ SESSION SERVER ] Takeover failed: ${takeoverError.message}`, 'yellow')
                    }
                } else {
                    log('[ SESSION SERVER ] Another bot instance holds the session lease (session_in_use).', 'yellow')
                    log('[ SESSION SERVER ] Set JUNE_TAKEOVER_SESSION=true to deliberately take over, or stop the other instance.', 'yellow')
                }
                if (usableFileSession) {
                    log('[ SESSION SERVER ] Falling back to the existing local file session for now.', 'yellow')
                    await saveLoginMethod('session')
                    await startJunexBot()
                    return
                }
                await delay(30000)
                continue
            }
            attempt += 1
            if ((usableFileSession || (sqliteAuthReady && !forceBootstrap)) && attempt >= 2) {
                // The server is unreachable but local auth exists — never brick
                // a deploy because of session-server downtime. v3.0.1: this can
                // also be a mirror-restored (unproven) copy; the 401 handler
                // knows not to revoke the server-side session for it.
                log(`[ SESSION SERVER ] Unreachable (${error.message}); falling back to the existing local auth${usableFileSession ? ' (file session)' : ' (mirror-restored, unproven)'}.`, 'yellow')
                await saveLoginMethod('session')
                await startJunexBot()
                return
            }
            const waitSec = Math.min(15 * attempt, 300)
            log(`[ SESSION SERVER ] Unreachable (${error.message}); retrying in ${waitSec}s...`, 'yellow')
            await delay(waitSec * 1000)
        }
    }
}

// ─── Main Login Flow ──────────────────────────────────────────────────────────

async function main() {
    // The database uses async sql.js initialization when better-sqlite3 cannot
    // load on an older VPS. Nothing may read settings/auth/schema before this.
    await juneDatabase.ready
    // Remote rows are partitioned by bot_id. The product name alone is shared by
    // every deployment, so two bots pointed at one database would collide —
    // including session_auth_state, meaning one could restore the other's
    // WhatsApp session. PN identifies the deployment; the product name stays as
    // the prefix so a single database can also host other June products.
    //
    // Falls back to the bare product name when nothing is set, which is what
    // existing deployments already use, so their data stays reachable.
    // v3.1.0 token-scoped identity: when no explicit PN/JUNE_PN/JUNE_BOT_ID/
    // BOT_ID/OWNER_NUMBER is configured, the session token itself scopes the
    // remote mirrors — SHA-256 of the token body (never raw token material) —
    // so two token deployments can share one external Postgres/Mongo database
    // without colliding and without any PN= configuration. Explicit env vars
    // always win. The stored owner number only applies when no token is
    // present, so re-pairing to a new token can never silently keep reading
    // the previous number's partition.
    const explicitBotIdSource = process.env.PN || process.env.JUNE_PN ||
        process.env.JUNE_BOT_ID || process.env.BOT_ID || process.env.OWNER_NUMBER
    const tokenBotId = explicitBotIdSource ? null
        : sessionServer.tokenBotIdSuffix(sessionServer.getConfiguredToken())
    let botIdSource
    let configuredBotId
    if (tokenBotId) {
        botIdSource = 'session-token'
        // Product prefix mirrors pgAdapter's BOT_ID_PRODUCT ('june-ultra-main').
        configuredBotId = `june-ultra-main-tk-${tokenBotId}`
        log(`[ BOT ID ] Token identity active — bot_id="${maskBotId(configuredBotId)}" (no PN needed).`, 'cyan')
    } else {
        botIdSource = explicitBotIdSource || juneDatabase.getOwners()?.[0]
        configuredBotId = pgAdapter.buildBotId(botIdSource)
    }
    global.__BOT_ID_SOURCE__ = botIdSource || null
    pgAdapter.setBotId(configuredBotId)
    mongoAdapter.setBotId(configuredBotId)
    juneApiAdapter.setBotId(configuredBotId)
    if (!botIdSource && (process.env.DATABASE_URL || process.env.MONGODB_URI || process.env.MONGO_URL)) {
        log('[ BOT ID ] No SESSION_ID set — cloud data (Postgres/Mongo) is saved under the shared name '
          + `"${configuredBotId}".\n`
          + '  • Running only ONE bot on this database? You can ignore this.\n'
          + '  • Running more than one bot on the same database? They will overwrite each other\'s data.\n'
          + '  • Fix: paste your session token (SESSION_ID) in .env — each token automatically gets its own '
          + 'separate data space.\n'
          + '    (Old way still works: PN=<your number> in .env)', 'yellow')
    }

    const [pgStatus, mongoStatus, juneApiStatus] = await Promise.all([
        pgAdapter.init(),
        mongoAdapter.init(),
        juneApiAdapter.init(),
    ])
    if (pgStatus.available) {
        const restored = await juneDatabase.restoreFromPostgres()
        if (restored.restored > 0) {
            log(`[ PG ] Restored ${restored.restored} missing local database records.`, 'green')
        }
    }
    if (mongoStatus.available) {
        const restored = await juneDatabase.restoreFromMongo()
        if (restored.restored > 0) {
            log(`[ MONGO ] Restored ${restored.restored} missing local database records.`, 'green')
        }
    }

    if (juneApiStatus.available) {
        const restored = await juneApiAdapter.restoreIntoSQLite(juneDatabase._db)
        juneDatabase.clearBotSettingsCache()
        if (restored.restored > 0) {
            juneDatabase.markDatabaseDirty('june-api-restore')
            log(`[ JUNE API ] Restored ${restored.restored} missing local database records.`, 'green')
        } else if (restored.error) {
            log('[ JUNE API ] Restore failed; local data was left unchanged.', 'yellow')
        }
    }

    // Pull first, then push. Anything changed while the remote was unreachable
    // never mirrored, and the retry queue lives in the local database — so a
    // wiped ./database/ takes the queue with it. This closes that gap on every
    // successful connect. All mirror writes are upserts, so it is idempotent.
    if (pgStatus.available || mongoStatus.available || juneApiStatus.available) {
        try {
            const pushed = juneDatabase.backfillRemote()
            if (pushed.pushed > 0) {
                log(`[ SYNC ] Backfilled ${pushed.pushed} records to the remote mirror.`, 'cyan')
            }
        } catch (e) {
            log(`[ SYNC ] Backfill skipped: ${e.message}`, 'yellow')
        }
    }

    // Disaster recovery path: if this host lost its local auth database and
    // has no usable file session, restore the direct remote auth state before
    // normal SESSION_ID/session startup decisions run.
    if (!hasVerifiedSQLiteAuth(juneDatabase._db) && !hasUsableFileSession()) {
        const authRecovery = await juneDatabase.restoreRemoteAuthState()
        if (authRecovery.restored) {
            // v3.0.1 provenance record: mirror-restored keys are structurally
            // 'verified' but unproven — they must never shortcut the Session
            // Server bootstrap, and a 401 on them must not revoke the
            // server-side session.
            setAuthSource(juneDatabase._db, 'mirror-restore')
            setAuthConnectionVerified(juneDatabase._db, false)
            log(`[ AUTH MIRROR ] Restored ${authRecovery.source} auth state (${authRecovery.keyRows} key rows).`, 'green')
            log('[ AUTH MIRROR ] Mirror copy is unproven — the Session Server snapshot stays authoritative.', 'cyan')
        } else if (authRecovery.error) {
            log('[ AUTH MIRROR ] Remote auth state was unavailable or invalid.', 'yellow')
        }
    }
    if (hasVerifiedSQLiteAuth(juneDatabase._db)) {
        // Ensure an already healthy deployment mirrors the current auth state
        // without waiting for the next creds.update event.
        if (juneDatabase.scheduleRemoteAuthMirror('startup')) {
            log('[ AUTH MIRROR ] External auth state mirror scheduled.', 'cyan')
        }
    }

    await applyPersistedRuntimeSettings()
    if (!handler) handler = require('./handler')
    diskManager.start()

    // 0. Re-read SESSION_ID directly from .env every time main() runs so that
    //    recursive calls (after logout) always see the latest value, and dotenvx
    //    quirks (which mangle long base64 values) are bypassed entirely.
    const _freshSessionID = readSessionIDFromEnv()
    // Keep a platform-provided SESSION_ID when .env intentionally contains
    // SESSION_ID= (the normal pattern for Heroku/Replit/Railway secrets).
    if (_freshSessionID) process.env.SESSION_ID = _freshSessionID
    // Re-read the Session Server token the same way (token wins when present).
    applyJuneSessionToken()

    // 1. Validate SESSION_ID format before doing anything
    await checkAndHandleSessionFormat()

    // 2. Restore the persisted retry counter from SQLite KV.
    global.errorRetryCount = getPersistedSessionErrorState().count
    if (global.errorRetryCount > 0) log(`Initial 408 retry count: ${global.errorRetryCount}`, 'yellow')

    cleanupExpiredSessionQuarantines('startup')

    // 3. SESSION_ID is a provisioning/recovery source — never an unconditional
    // override for a verified SQLite auth state. Store only an opaque SHA-256
    // fingerprint so we can detect a genuinely changed SESSION_ID safely.
    const envSessionID = process.env.SESSION_ID?.trim() || ''
    const hasValidEnvSessionID = Boolean(
        envSessionID && VALID_PREFIXES.some((prefix) => envSessionID.startsWith(prefix))
    )
    const sqliteAuthReady = hasVerifiedSQLiteAuth(juneDatabase._db)
    const currentSessionFingerprint = hasValidEnvSessionID
        ? fingerprintSessionId(envSessionID)
        : null
    // SQLite session_auth_meta is the sole persistent home for opaque SHA-256
    // SESSION_ID fingerprints. The raw SESSION_ID remains environment-only.
    const storedSessionFingerprints = [
        getSessionIdFingerprint(juneDatabase._db),
    ].filter(Boolean)
    const revokedSessionFingerprints = [
        getSessionIdRevokedFingerprint(juneDatabase._db),
    ].filter(Boolean)
    const sameSessionId = Boolean(
        currentSessionFingerprint && storedSessionFingerprints.includes(currentSessionFingerprint)
    )
    const sessionIdChanged = Boolean(
        currentSessionFingerprint &&
        storedSessionFingerprints.length > 0 &&
        !sameSessionId
    )
    const sessionIdRevoked = Boolean(
        currentSessionFingerprint && revokedSessionFingerprints.includes(currentSessionFingerprint)
    )
    const usableFileSession = hasUsableFileSession()

    log(`[ SESSION_ID ] ${hasValidEnvSessionID ? 'Configured (redacted)' : '(none)'}`, 'cyan')

    // Session Server input diagnostics — presence only, never raw values.
    {
        const _ssToken = String(process.env.JUNE_SESSION_TOKEN || '').trim()
        const _ssValid = sessionServer.isSessionServerToken(_ssToken) || sessionServer.isJuneHandle(_ssToken)
        const _ssFlag = /^(1|true|yes|on)$/i.test(String(process.env.JUNE_FORCE_SESSION_BOOTSTRAP || ''))
        if (_ssToken) {
            if (!_ssValid) log('[ SESSION SERVER ] token: INVALID FORMAT (must be JUNE~xxxxxx or june-ultra:~ + 24 letters/digits — check quotes/spaces)', 'yellow')
        } else if (_ssFlag) {
            log('[ SESSION SERVER ] JUNE_FORCE_SESSION_BOOTSTRAP is set but no JUNE_SESSION_TOKEN is configured — the flag has no effect.', 'yellow')
        } else if (String(process.env.JUNE_SESSION_SERVER_URL || '').trim()) {
            log('[ SESSION SERVER ] Server URL set but no JUNE_SESSION_TOKEN configured.', 'yellow')
        }
    }

    if (sessionIdRevoked) {
        log('[ SESSION_ID ] This session was logged out by WhatsApp. Add a fresh session token (june-ultra:~…) or SESSION_ID, then restart.', 'red', true)
        checkEnvStatus()
        return
    }

    // A fingerprint mismatch is a warning, not permission to destroy a usable
    // file session. Auto-exported creds can legitimately change the raw backup
    // SESSION_ID over time. Preserve usable auth and refresh the SQLite metadata;
    // an owner can use JUNE_FORCE_SESSION_BOOTSTRAP=true for an intentional
    // replacement.
    // ─── Session Server token mode (additive) ─────────────────────────────
    // A june-ultra:~ token never enters the base64 SESSION_ID bootstrap path
    // below; it gets its own flow with identical safety semantics.
    if (sessionServer.isSessionServerToken(envSessionID) || sessionServer.isJuneHandle(envSessionID)) {
        await connectViaSessionServerToken({
            token: envSessionID,
            fingerprint: currentSessionFingerprint,
            sqliteAuthReady,
            sameToken: Boolean(sameSessionId),
            forceBootstrap: /^(1|true|yes|on)$/i.test(String(process.env.JUNE_FORCE_SESSION_BOOTSTRAP || '')),
            usableFileSession,
        })
        checkEnvStatus()
        return
    }

    const forceSessionBootstrap = /^(1|true|yes|on)$/i.test(
        String(process.env.JUNE_FORCE_SESSION_BOOTSTRAP || '')
    )
    const shouldBootstrapFromSessionId = hasValidEnvSessionID && (
        forceSessionBootstrap ||
        (!sqliteAuthReady && !usableFileSession)
    )

    if (shouldBootstrapFromSessionId) {
        global.SESSION_ID = envSessionID
        const replacingFileSession =
            (forceSessionBootstrap && sessionExists()) ||
            (!usableFileSession && sessionExists())

        if (replacingFileSession) {
            const reason = forceSessionBootstrap
                ? 'a forced SESSION_ID bootstrap'
                : 'an unusable existing file session'
            log(`[ SESSION_ID ] Applying ${reason} — preserving prior file auth first.`, 'yellow')
            const oldSessionPath = quarantineCurrentSessionForReplacement()
            if (oldSessionPath) {
                log(`[ SESSION ] Previous file auth preserved at ${path.basename(oldSessionPath)}.`, 'yellow')
            }
        } else {
            log('[ SESSION_ID MODE ] No usable local auth found — bootstrapping from SESSION_ID.', 'white')
        }

        if (!sessionExists()) {
            log('[ SESSION_ID ] Writing creds.json from SESSION_ID...', 'magenta')
            await fs.promises.mkdir(sessionDir, { recursive: true })
            try {
                await downloadSessionData()
                if (!hasUsableFileSession()) {
                    throw new Error('creds.json was not written or is invalid after SESSION_ID bootstrap')
                }
                log('[ SESSION_ID ] ✅ Session bootstrap saved successfully.', 'green')
            } catch (e) {
                log(`[ SESSION_ID ] ❌ Failed to bootstrap session: ${e.message}`, 'red', true)
                log('Retrying in 5 seconds...', 'yellow')
                await delay(5000)
                return main()
            }
        }

        invalidateSQLiteAuth(
            juneDatabase._db,
            forceSessionBootstrap ? 'session-id-forced-bootstrap' : 'session-id-bootstrap'
        )
        rememberSessionIdFingerprint(currentSessionFingerprint)
        clearRevokedSessionIdFingerprint()
        await saveLoginMethod('session')
        log('[ SESSION_ID ] Connecting...', 'cyan')
        await startJunexBot()
        checkEnvStatus()
        return
    }

    if (hasValidEnvSessionID && sqliteAuthReady) {
        if (revokedSessionFingerprints.length > 0 && !sessionIdRevoked) {
            clearRevokedSessionIdFingerprint()
        }
        if (!sameSessionId) {
            // Upgrade path for an existing verified June X installation.
            rememberSessionIdFingerprint(currentSessionFingerprint)
            log('[ AUTH ] Linked the existing verified SQLite auth to the configured SESSION_ID fingerprint.', 'cyan')
        }
        log('[ AUTH ] Verified SQLite auth found; SESSION_ID is retained only as a recovery backup.', 'green')
    } else if (hasValidEnvSessionID && usableFileSession) {
        // The file session is usable. If fingerprint metadata is absent (for
        // example after the move from marker files to session_auth_meta), adopt
        // this session instead of quarantining and recreating it.
        if (!sameSessionId && currentSessionFingerprint) {
            if (sessionIdChanged) {
                log('[ SESSION_ID ] Configured fingerprint differs; retaining usable file auth. Set JUNE_FORCE_SESSION_BOOTSTRAP=true only for an intentional replacement.', 'yellow')
            }
            const saved = rememberSessionIdFingerprint(currentSessionFingerprint)
            if (saved) {
                log('[ SESSION_ID ] Existing file auth adopted; fingerprint recorded in SQLite.', 'green')
            }
        }
        if (revokedSessionFingerprints.length > 0 && !sessionIdRevoked) {
            clearRevokedSessionIdFingerprint()
        }
        await saveLoginMethod('session')
        log('[ SESSION_ID ] Existing usable file session retained; rebuilding SQLite auth if needed.', 'cyan')
    } else {
        log('[ SESSION_ID ] No SESSION_ID in .env — checking for a saved session...', 'yellow')
    }

    // 4. Integrity check on stored session
    await checkSessionIntegrityAndClean()

    // 5. Use existing stored session if valid
    if (sessionExists()) {
        log('[ SESSION_ID ] Saved session found — continuing with it.', 'green')
        await startJunexBot()
        checkEnvStatus()
        return
    }

    // 5b. A verified SQLite auth state is complete on its own. Do not
    // reconstruct only creds.json from the legacy session table.
    if (hasVerifiedSQLiteAuth(juneDatabase._db)) {
        log('[ AUTH ] Verified SQLite auth found; starting without session files.', 'green')
        await saveLoginMethod('session')
        await startJunexBot()
        checkEnvStatus()
        return
    }

    // 5c. Legacy fallback for databases created before complete auth storage.
    const restoredFromDB = await restoreSessionFromDB()
    if (restoredFromDB) {
        await saveLoginMethod('session')
        await startJunexBot()
        checkEnvStatus()
        return
    }

    // 6. No SESSION_ID and no stored session — show the interactive login menu.
    log(chalk.black.bgYellowBright('[ LOGIN ] No SESSION_ID found and no stored session. Launching login menu...'), 'white')
    const loginMethod = await getLoginMethod()
    if (loginMethod === 'session') {
        // A june-ultra:~ token entered interactively routes through the
        // Session Server flow instead of the base64 download path.
        if (sessionServer.isSessionServerToken(global.SESSION_ID) || sessionServer.isJuneHandle(global.SESSION_ID)) {
            await connectViaSessionServerToken({
                token: String(global.SESSION_ID).trim(),
                fingerprint: fingerprintSessionId(String(global.SESSION_ID).trim()),
                sqliteAuthReady: hasVerifiedSQLiteAuth(juneDatabase._db),
                sameToken: false,
                forceBootstrap: true,
                usableFileSession: false,
            })
            checkEnvStatus()
            return
        }
        if (sessionServer.isSessionServerToken(global.SESSION_ID) || sessionServer.isJuneHandle(global.SESSION_ID)) {
            // A june-ultra token / JUNE~ handle is never base64 creds — it is
            // handled by the Session Server flow above and must not reach this path.
            log('[ LOGIN ] june-ultra tokens and JUNE~ Session IDs cannot be used as base64 session strings.', 'red', true)
            process.exit(1)
        }
        try {
            await downloadSessionData()
            if (!sessionExists()) {
                throw new Error('Session file was not written — SESSION_ID may be corrupt or expired.')
            }
            log('[ LOGIN ] ✅ Session ID accepted. Connecting...', 'green')
        } catch (e) {
            log(`[ LOGIN ] ❌ Failed to load session: ${e.message}`, 'red', true)
            log('Please check your SESSION_ID and try again. Retrying in 5 seconds...', 'yellow')
            await delay(5000)
            return main()
        }
    }
    await startJunexBot()
    checkEnvStatus()
}

// ─── Keep-Alive HTTP Server ────────────────────────────────────────────────────

function startKeepAliveServer() {
    const express   = require('express');
    const http      = require('http');
    const app       = express();
    const START_TIME = Date.now();

    // Read-only status dashboard — server-rendered, no client JS/fetch, no
    // pairing/session-ID UI or endpoints. Auto-refreshes via <meta refresh>
    // so it renders identically on every platform/browser.
    app.get('/', (req, res) => {
        const uptimeMs = Date.now() - START_TIME;
        const totalSeconds = Math.floor(uptimeMs / 1000);
        const days = Math.floor(totalSeconds / 86400);
        const hours = Math.floor((totalSeconds % 86400) / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        const uptimeStr = days > 0
            ? `${days}d ${hours}h ${minutes}m ${seconds}s`
            : `${hours.toString().padStart(2, '0')}h ${minutes.toString().padStart(2, '0')}m ${seconds.toString().padStart(2, '0')}s`;

        const now = new Date();
        const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const platform = detectPlatform();
        const connected = global.botState === 'connected';
        const botNum = global.currentSock?.user?.id?.split(':')[0];
        const statusLabel = connected ? 'OPERATIONAL • ACTIVE' : (global.botState === 'connecting' ? 'CONNECTING' : 'OFFLINE');
        const statusColor = connected ? '#00ffe0' : (global.botState === 'connecting' ? '#ffb703' : '#e94560');

        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="10">
  <title>June-X Ultra — Dashboard</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=JetBrains+Mono:wght@400;600&display=swap');
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: radial-gradient(circle at 20% 30%, #0a0f1e, #03060c);
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      color: #e2f0ff;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem;
      position: relative;
      overflow-x: hidden;
    }
    body::before {
      content: '';
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      background-image: radial-gradient(2px 2px at 20px 30px, #00ffe0, rgba(0,0,0,0)), radial-gradient(1px 1px at 80px 140px, #ff6b35, rgba(0,0,0,0)), radial-gradient(3px 3px at 260px 80px, #00aaff, rgba(0,0,0,0));
      background-size: 200px 200px, 180px 180px, 220px 220px;
      background-repeat: no-repeat;
      opacity: 0.3;
      pointer-events: none;
      animation: drift 60s linear infinite;
    }
    @keyframes drift {
      0% { background-position: 0 0, 0 0, 0 0; }
      100% { background-position: 400px 400px, 300px 300px, 500px 500px; }
    }
    .wrapper { max-width: 500px; width: 100%; z-index: 2; position: relative; }
    .header { text-align: center; margin-bottom: 2.5rem; }
    .bot-name {
      font-family: 'JetBrains Mono', 'SF Mono', 'Cascadia Code', 'Consolas', 'Courier New', monospace;
      font-size: 2.5rem;
      font-weight: 700;
      background: linear-gradient(135deg, #00ffe0, #ff6b35);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
      text-shadow: 0 0 20px rgba(0,255,224,0.3);
      letter-spacing: -0.02em;
      display: inline-block;
      animation: glitch 3s infinite;
    }
    @keyframes glitch {
      0%, 100% { transform: skew(0deg, 0deg); opacity: 1; }
      95% { transform: skew(0deg, 0deg); opacity: 1; }
      96% { transform: skew(2deg, 1deg); opacity: 0.8; text-shadow: -2px 0 #ff6b35, 2px 0 #00ffe0; }
      97% { transform: skew(-1deg, -0.5deg); opacity: 0.9; }
    }
    .tagline { font-size: 0.8rem; letter-spacing: 4px; text-transform: uppercase; color: #7f9eb5; margin-top: 0.5rem; }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      background: rgba(0,255,224,0.1);
      border-radius: 60px;
      padding: 0.4rem 1.5rem;
      margin-top: 1.2rem;
      font-size: 0.75rem;
      font-weight: 500;
      letter-spacing: 1px;
      backdrop-filter: blur(4px);
    }
    .dot {
      width: 10px; height: 10px;
      background: ${statusColor};
      border-radius: 50%;
      box-shadow: 0 0 8px ${statusColor};
      animation: pulse 1.4s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.8); }
    }
    .dashboard-grid { display: flex; flex-direction: column; align-items: center; gap: 1.5rem; margin-bottom: 2rem; }
    .card {
      width: 100%; max-width: 400px;
      background: rgba(10, 20, 28, 0.65);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(0, 255, 224, 0.2);
      border-radius: 0;
      padding: 1.5rem;
      transition: transform 0.2s ease, border-color 0.2s;
      box-shadow: 0 0 15px rgba(0, 255, 224, 0.2), 0 8px 20px rgba(0,0,0,0.2);
      text-align: center;
      position: relative;
      overflow: hidden;
    }
    .card::before, .card::after {
      content: '';
      position: absolute;
      width: 50px; height: 50px;
      pointer-events: none;
      transition: 0.3s;
    }
    .card::before { top: 0; left: 0; border-top: 2px solid #00ffe0; border-left: 2px solid #00ffe0; border-radius: 0 0 20px 0; box-shadow: -2px -2px 12px rgba(0,255,224,0.5); }
    .card::after  { bottom: 0; right: 0; border-bottom: 2px solid #ff6b35; border-right: 2px solid #ff6b35; border-radius: 20px 0 0 0; box-shadow: 2px 2px 12px rgba(255,107,53,0.5); }
    .card:hover::before { border-top-color: #ff6b35; border-left-color: #ff6b35; box-shadow: -2px -2px 18px #ff6b35; }
    .card:hover::after  { border-bottom-color: #00ffe0; border-right-color: #00ffe0; box-shadow: 2px 2px 18px #00ffe0; }
    .card:hover { transform: translateY(-4px); border-color: rgba(0, 255, 224, 0.6); box-shadow: 0 0 25px rgba(0,255,224,0.3), 0 15px 30px rgba(0,0,0,0.3); }
    .card-title { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 2px; color: #6c8ea0; margin-bottom: 0.75rem; display: flex; align-items: center; justify-content: center; gap: 0.5rem; }
    .card-value { font-family: 'JetBrains Mono', 'SF Mono', 'Cascadia Code', 'Consolas', 'Courier New', monospace; font-size: 1.6rem; font-weight: 600; color: #00ffe0; text-shadow: 0 0 6px rgba(0,255,224,0.3); line-height: 1.2; word-break: break-word; }
    .card-value.small { font-size: 1.2rem; }
    .card-sub { font-size: 0.65rem; color: #8aaec0; margin-top: 0.6rem; border-top: 1px dashed rgba(0,255,224,0.2); padding-top: 0.6rem; }
    .footer { text-align: center; margin-top: 2rem; font-size: 0.7rem; color: #5a7c8c; letter-spacing: 1px; text-transform: uppercase; }
    .footer strong { color: #00ffe0; }
    .refresh-note { text-align: center; font-size: 0.65rem; margin-top: 1rem; opacity: 0.6; }
    @media (max-width: 480px) {
      body { padding: 1rem; }
      .bot-name { font-size: 1.8rem; }
      .card-value { font-size: 1.3rem; }
      .card-value.small { font-size: 1rem; }
      .card { max-width: 100%; }
    }
  </style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <div class="bot-name">June-X Ultra</div>
    <div class="tagline">Autonomous Bot Matrix</div>
    <div class="status-badge">
      <span class="dot"></span> ${statusLabel}
    </div>
  </div>
  <div class="dashboard-grid">
    <div class="card">
      <div class="card-title">🖥️ PLATFORM</div>
      <div class="card-value small">${platform}</div>
      <div class="card-sub">deployment environment</div>
    </div>
    <div class="card">
      <div class="card-title">⏱ UPTIME</div>
      <div class="card-value">${uptimeStr}</div>
      <div class="card-sub">continuous runtime</div>
    </div>
    <div class="card">
      <div class="card-title">📅 DATE</div>
      <div class="card-value small">${dateStr}</div>
      <div class="card-sub">local server date</div>
    </div>
    <div class="card">
      <div class="card-title">📶 CONNECTION</div>
      <div class="card-value small">${connected ? `+${botNum}` : statusLabel}</div>
      <div class="card-sub">whatsapp session</div>
    </div>
  </div>
  <div class="footer">
    ⚡ Powered by <strong>supreme</strong> &nbsp;|&nbsp; June-X Ultra
  </div>
  <div class="refresh-note">⟳ dashboard auto-refreshes every 10 seconds</div>
</div>
</body>
</html>`);
    });

    app.get('/health', (req, res) => res.status(200).send('OK'));

    app.get('/health/details', async (req, res) => {
        try {
            const databaseHealth = juneDatabase.getDatabaseHealth();
            const authStats = getSQLiteAuthStats(juneDatabase._db);
            let antiDelete = null;
            try {
                antiDelete = require('./commands/owner/antidelete').getStoreStats();
            } catch (_) {}
            res.json({
                ok: databaseHealth.ok === true &&
                    (!databaseHealth.backupExists || databaseHealth.backupValid === true),
                botState: global.botState || 'unknown',
                database: {
                    sizeBytes: databaseHealth.databaseSizeBytes,
                    backupSizeBytes: databaseHealth.backupSizeBytes,
                    backupExists: databaseHealth.backupExists,
                    backupValid: databaseHealth.backupValid,
                    dirty: databaseHealth.dirty,
                    lastBackup: databaseHealth.lastBackup,
                    integrity: databaseHealth.lastIntegrityCheck,
                    maintenance: databaseHealth.maintenance,
                    remoteSync: databaseHealth.remoteSync,
                    authMirror: databaseHealth.authMirror,
                    postgres: databaseHealth.postgres,
                    mongo: databaseHealth.mongo,
                    juneApi: databaseHealth.juneApi,
                },
                stability: {
                    replayDrain: replayDrain.getStats(),
                },
                auth: {
                    verified: authStats.verified,
                    hasCreds: authStats.hasCreds,
                    totalKeys: authStats.totalKeys,
                    byType: authStats.byType,
                    pendingFileMigration: authStats.pendingFileMigration,
                    invalidReason: authStats.invalidReason,
                },
                antiDelete,
                storage: diskManager?.getReport?.() || null,
                telemetry: {
                    stats: (() => {
                        const rows = juneDatabase.getRuntimeTelemetry(1000);
                        return {
                            total: rows.length,
                            eventTypes: rows.reduce((counts, row) => {
                                counts[row.eventType] = (counts[row.eventType] || 0) + row.count;
                                return counts;
                            }, {}),
                        };
                    })(),
                },
            });
        } catch (error) {
            res.status(503).json({ ok: false, error: error.message });
        }
    });

    const server = http.createServer(app);

    const PORTS_TO_TRY = process.env.PORT
        ? [parseInt(process.env.PORT, 10)]
        : [5000, 3000, 8000, 4000];

    let portIndex = 0;

    function tryListen() {
        if (portIndex >= PORTS_TO_TRY.length) return;
        const PORT = PORTS_TO_TRY[portIndex];
        server.listen(PORT, '0.0.0.0');

        server.once('listening', () => {
            const selfPingUrl = process.env.APP_URL || `http://localhost:${PORT}/health`;
            setInterval(() => {
                http.get(selfPingUrl, (r) => {}).on('error', () => {});
            }, 4 * 60 * 1000);
        });

        server.once('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                portIndex++;
                tryListen();
            }
        });
    }

    tryListen();
    return server;
}

let keepAliveServer = null

global.__JUNE_SHUTDOWN = async () => {
    if (global._shutdownPromise) return global._shutdownPromise
    global._shutdownRequested = true
    global._shutdownPromise = (async () => {
        log('[ SHUTDOWN ] Gracefully stopping June-X...', 'yellow')
        if (global._reconnectTimer) {
            clearTimeout(global._reconnectTimer)
            global._reconnectTimer = null
        }
        for (const interval of global._activeIntervals || []) clearInterval(interval)
        global._activeIntervals = []
        try { global._envWatcher?.close?.() } catch (_) {}
        try { diskManager?.stop?.() } catch (_) {}
        // Anti-delete and group stats keep small in-memory debounce queues.
        // Persist both before shutdownDatabase closes SQLite.
        try { global.__JUNE_FLUSH_ANTIDELETE?.() } catch (_) {}
        try { global.__JUNE_FLUSH_GROUP_STATS?.() } catch (_) {}
        try {
            const sock = global.currentSock
            if (sock?.ws?.close) sock.ws.close()
            else if (sock?.end) sock.end(new Error('process shutdown'))
        } catch (_) {}
        try { keepAliveServer?.close?.() } catch (_) {}
        try { await juneDatabase.shutdownDatabase() } catch (error) {
            log(`[ SHUTDOWN ] Database flush failed: ${error.message}`, 'red', true)
        }
        log('[ SHUTDOWN ] Complete.', 'green')
    })()
    return global._shutdownPromise
}

keepAliveServer = startKeepAliveServer();

// ─── Boot ──────────────────────────────────────────────────────────────────────

main().catch(err => log(`Fatal error: ${err.message}`, 'red', true))

process.on('uncaughtException', (err) => {
    if (err.code === 'ENOSPC' || err.errno === -28) {
        log('⚠️ ENOSPC: No space left on device. Attempting cleanup...', 'yellow')
        cleanupJunkFiles(null)
        return
    }
    log(`Uncaught Exception: ${err.message}`, 'red', true)
})

process.on('unhandledRejection', (err) => {
    if (err?.code === 'ENOSPC' || err?.errno === -28) {
        log('⚠️ ENOSPC in promise.', 'yellow')
        return
    }
    if (err?.message?.includes('rate-overlimit')) return
    if (err?.message?.includes('AUTH_STARTUP_VALIDATION_FAILED')) {
        log(`[ AUTH ] Startup recovery stopped safely: ${err.message.replace(/^AUTH_STARTUP_VALIDATION_FAILED:\s*/, '')}`, 'yellow')
        log('[ AUTH ] No auth data was cleared. Restore a known-good backup or explicitly re-pair.', 'yellow')
        return
    }
    log(`Unhandled Rejection: ${err?.message}`, 'red', true)
})

module.exports = { store }
