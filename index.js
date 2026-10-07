/**
 * June-X Ultra - WhatsApp Bot (Baileys)
 */
require('./utils/shutdown').enforceShutdownChain();

process.on('warning', (warning) => {
    const message = String(warning?.message || '');
    if (
        warning?.code === 'SECURITY WARNING' ||
        message.includes('SECURITY WARNING') ||
        message.includes('The SSL modes') ||
        message.includes('pg-connection-string')
    ) return;
    console.warn(warning);
});

require('dotenv').config();

// ─── ffmpeg ──────────────────────────────────────────────────────────────────
const FFMPEG_PATH = require('./utils/ffmpegPath');
require('fluent-ffmpeg').setFfmpegPath(FFMPEG_PATH());
const { ensureFfmpegRuntime } = require('./utils/ffmpegRuntime');
if (FFMPEG_PATH() === 'ffmpeg') ensureFfmpegRuntime();
if (FFMPEG_PATH() === 'ffmpeg') {
    console.log('[ BOOT ] WARNING: ffmpeg not found. Sticker/media conversion may fail until it is downloaded.');
} else {
    console.log(`[ BOOT ] ffmpeg: ${FFMPEG_PATH()}`);
}

if (process.env.JUNE_START_TIME) {
    const startTime = parseInt(process.env.JUNE_START_TIME);
    process.uptime = () => (Date.now() - startTime) / 1000;
}

// ─── Hide libsignal noise ────────────────────────────────────────────────────
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

    if (SIGNAL_NOISE_PATTERNS.some((p) => lower.includes(p))) {
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
    if (shouldSuppressSignalNoise(chunk)) return acknowledgeSuppressedWrite(encoding, callback);
    return originalWrite.apply(this, arguments);
};

process.stderr.write = function (chunk, encoding, callback) {
    if (shouldSuppressSignalNoise(chunk)) return acknowledgeSuppressedWrite(encoding, callback);
    return originalWriteError.apply(this, arguments);
};

console.log = function (message, ...optionalParams) {
    if (shouldSuppressSignalNoise(message)) return;
    originalLog.apply(console, [message, ...optionalParams]);
};

const fs = require('fs')
const BOOT_DEBUG = /^(1|true|yes|on)$/i.test(String(process.env.DEBUG || ''))
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
const { runFileSweep, startScheduledCleanups, stopScheduledCleanups } = require('./utils/cleanup')
const { createMessageStore } = require('./utils/messageStore')
const { applyFont } = require('./utils/fontConverter')
const {
    atomicWriteFile,
    createDiskManager,
} = require('./utils/juneDb/runtimeProtection')
const juneDatabase = require('./database')
const pgAdapter = require('./utils/juneDb/pgAdapter')
const mongoAdapter = require('./utils/juneDb/mongoAdapter')
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
const { wrapSockSanitized } = require('./utils/sanitizeUserText')

process.env.PUPPETEER_SKIP_DOWNLOAD = 'true'
process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'true'

function log(message, color = 'white', isError = false) {
    require('./utils/consoleTheme').log(message, color, isError)
}
global.log = log;

const { maskNumber, maskBotId } = require('./utils/redact');

// ─── Startup report (plain ASCII, works on any terminal or panel) ────────────

const REPORT_WIDTH = 56
const LINE = '-'.repeat(REPORT_WIDTH)

function plain(value) {
    return String(value ?? '')
        .replace(/\r?\n/g, ' ')
        .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
}

function fit(value, width) {
    const text = plain(value)
    return text.length > width ? `${text.slice(0, width - 3)}...` : text.padEnd(width)
}

const GOOD = ['ok', 'ready', 'connected', 'active', 'online', 'enabled', 'passed']
const WARN = ['warn', 'warning', 'degraded', 'fallback', 'connecting']
const BAD = ['off', 'disabled', 'not_set', 'unavailable', 'error', 'failed']

function statusColor(status) {
    const s = String(status || '').toLowerCase()
    if (GOOD.includes(s)) return chalk.green
    if (WARN.includes(s)) return chalk.yellow
    if (BAD.includes(s)) return chalk.red
    return chalk.cyan
}

function statusTag(status) {
    const s = String(status || '').toLowerCase()
    if (GOOD.includes(s)) return 'OK'
    if (WARN.includes(s)) return '!!'
    if (BAD.includes(s)) return 'XX'
    return '--'
}

function row(label, value, status) {
    const left = chalk.gray(fit(label, 14))
    if (!status) return `  ${left} : ${plain(value)}`
    const color = statusColor(status)
    return `  ${left} : ${color(`[${statusTag(status)}]`)} ${color(plain(value))}`
}

function heading(title) {
    return chalk.cyan.bold(`[ ${title} ]`)
}

function toggle(label, enabled) {
    return `${chalk.gray(fit(label, 13))} ${enabled ? chalk.green('ON ') : chalk.red('OFF')}`
}

function togglePair(a, aOn, b, bOn) {
    return `  ${toggle(a, aOn)}   ${toggle(b, bOn)}`
}

function getStartupToggleState() {
    const db = juneDatabase
    const statusSettings = db.loadSettings?.() || {}
    const presence = (() => { try { return require('./utils/presenceSettings').getModes(); } catch (_) { return { pm: 'off', group: 'off' }; } })();
    const anyTyping = presence.pm === 'typing' || presence.group === 'typing';
    const anyRecording = ['recording', 'recordtype'].includes(presence.pm) || ['recording', 'recordtype'].includes(presence.group);
    const anyRecordType = presence.pm === 'recordtype' || presence.group === 'recordtype';
    const autoReact = (() => {
        try {
            return Boolean(require('./utils/autoReact').load().enabled)
        } catch (_) {
            return Boolean(db.getBotSetting?.('autoReact'))
        }
    })()

    return {
        autoStatusView: Boolean(statusSettings.enabled),
        autoStatusReact: Boolean(statusSettings.react),
        autoTyping: anyTyping,
        autoRecording: anyRecording,
        autoRecordType: anyRecordType,
        autoDownload: Boolean(db.getAutoDownloadStatusSettings().enabled),
        alwaysOnline: Boolean(db.getBotSetting?.('alwaysOnline')),
        antideleteStatus: db.isAntideleteStatusEnabled(),
        autoReact,
        antiDelete: db.getAntideleteMode() !== 'off',
    }
}

function printStartupReport(data = {}) {
    const mode = String(data.mode || 'public').toUpperCase()
    const dbInfo = data.databaseInfo || getExternalDatabaseStatus()
    const configured = (dbInfo.databases || []).filter((e) => e.configured)

    const externalRows = configured.length === 0
        ? (dbInfo.databases || []).map((e) => row(e.name, 'not configured', 'not_set'))
        : configured.map((e) => row(
            e.name,
            e.connected ? 'connected' : 'unavailable, using SQLite',
            e.connected ? 'connected' : 'warning'
        ))

    const lines = [
        '',
        chalk.cyan(`+${LINE}+`),
        chalk.white.bold('  JUNE-X ULTRA - STARTUP REPORT'),
        chalk.cyan(`+${LINE}+`),
        heading('SYSTEM'),
        row('Platform', data.platform || os.platform()),
        row('Node.js', data.nodeVersion || process.version),
        row('Time', data.time || new Date().toLocaleTimeString()),
        row('Startup', data.startupTime || '-'),
        '',
        heading('CONFIG'),
        row('Prefix', data.prefix ?? '.'),
        row('Mode', mode, 'active'),
        row('Owner', data.owner || 'configured'),
        row('Commands', `${data.commandCount ?? '-'} loaded${data.aliasCount ? ` (+${data.aliasCount} aliases)` : ''}`, 'ready'),
        '',
        heading('DATABASE'),
        row('SQLite', data.sqliteLabel || 'ready', data.sqliteStatus || 'ready'),
        row('Driver', data.sqliteDriver || 'sql.js-fallback'),
        row('Schema', data.schemaVersion ? `v${data.schemaVersion}` : '-'),
        row('Integrity', data.integrityLabel || 'passed', data.integrityStatus || 'passed'),
        ...externalRows,
        '',
        heading('TOGGLES'),
        togglePair('Status View', data.toggles?.autoStatusView, 'Status React', data.toggles?.autoStatusReact),
        togglePair('Typing', data.toggles?.autoTyping, 'Recording', data.toggles?.autoRecording),
        togglePair('Record+Type', data.toggles?.autoRecordType, 'Auto-Save', data.toggles?.autoDownload),
        togglePair('Auto-React', data.toggles?.autoReact, 'Always-On', data.toggles?.alwaysOnline),
        togglePair('Anti-Delete', data.toggles?.antiDelete, 'Anti-Status', data.toggles?.antideleteStatus),
        '',
        heading('PROTECTION'),
        row('Disk manager', data.diskManagerLabel || 'active', data.diskManagerStatus || 'active'),
        row('Atomic writes', data.atomicWritesLabel || 'enabled', data.atomicWritesStatus || 'enabled'),
        row('Cache limits', data.cacheLabel || 'enabled', data.cacheStatus || 'enabled'),
        row('Telemetry', data.telemetryLabel || 'enabled', data.telemetryStatus || 'enabled'),
        row('Shutdown', data.shutdownLabel || 'protected', data.shutdownStatus || 'active'),
        '',
        heading('AUTH'),
        row('Session', data.sessionLabel || 'restored', data.sessionStatus || 'ready'),
        row('Auth source', data.authSource || 'SQLite'),
        row('Signal keys', data.signalKeysLabel || 'verified', data.signalKeysStatus || 'ready'),
        row('Session Srv', data.sessionServerLabel || 'not set', data.sessionServerStatus || 'off'),
        '',
        heading('CONNECTION'),
        row('WhatsApp', data.whatsappLabel || 'connecting', data.whatsappStatus || 'connecting'),
        row('Account', data.accountLabel || 'hidden', data.accountStatus),
        row('Group join', data.groupJoinLabel || 'not set', data.groupJoinStatus),
        chalk.cyan(`+${LINE}+`),
        '',
    ]

    console.log(lines.join('\n'))

    const connected = configured.filter((e) => e.connected)
    if (connected.length > 0) {
        log(`[ DATABASE ] External database connected: ${connected.map((e) => e.name).join(', ')}`, 'green');
    }
    if (configured.some((e) => !e.connected)) {
        log('[ DATABASE ] External database unavailable; using SQLite.', 'yellow');
    }
    if (configured.length === 0) {
        log('[ DATABASE ] No external database configured (SQLite only).', 'cyan');
    }
}

// ─── Global state ────────────────────────────────────────────────────────────

global.isBotConnected = false
global.connectDebounceTimeout = null
global.errorRetryCount = 0
global.isReconnecting = false
global._consecutive500Count = 0
global._conflictCount = 0
global._lastConflictLogTime = 0
global._suppressedConflictCount = 0
global._conflictSummaryTimer = null
global._reconnectTimer = null
global._shutdownRequested = false
global.startupReportPrinted = false

global.startupStartedAt = process.env.JUNE_START_TIME
    ? parseInt(process.env.JUNE_START_TIME)
    : Date.now()

global._activeIntervals = []

global.botState = 'disconnected'
global.currentSock = null
global.connectedAt = null

global.__CORE__ = __dirname
global.__ROOT__ = __dirname

async function applyPersistedRuntimeSettings() {
    try {
        await juneDatabase.ready;
        try {
            const m = require('./utils/presenceSettings').getModes();
            juneDatabase.setBotSetting('autoTyping', m.pm === 'typing' || m.group === 'typing');
            juneDatabase.setBotSetting('autoRecording', ['recording', 'recordtype'].includes(m.pm) || ['recording', 'recordtype'].includes(m.group));
            juneDatabase.setBotSetting('autoRecordType', m.pm === 'recordtype' || m.group === 'recordtype');
        } catch (_) {}
    } catch (e) {
        log(`[ SETTINGS ] Could not load runtime settings: ${e.message}`, 'yellow');
    }
}

let handler = null
const { saveSession, getSession, clearSession } = juneDatabase

const sessionDir = path.join(__dirname, juneDatabase.SESSION_NAME || 'session')
const credsPath = path.join(sessionDir, 'creds.json')
const envPath = path.join(process.cwd(), '.env')

if (!fs.existsSync(envPath)) {
    const defaultEnv = [
        '# June Ultra - Environment Variables',
        `# Pair at ${sessionServer.getServerUrl()}/pair and paste your JUNE-X~ Session ID below.`,
        'SESSION_ID=',
        '',
        '# Optional: bot port (default 5000)',
        '# PORT=5000',
    ].join('\n')
    atomicWriteFile(envPath, defaultEnv, 'utf8')
    log('[ .env ] No .env file found, created a default one.', 'green')
}

function readSessionIDFromEnv() {
    try {
        if (!fs.existsSync(envPath)) return ''
        const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
        for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed.startsWith('#') || !trimmed.startsWith('SESSION_ID=')) continue
            return trimmed.slice('SESSION_ID='.length).trim()
        }
    } catch (e) {
        log(`[ .env ] Failed to read SESSION_ID: ${e.message}`, 'red', true)
    }
    return ''
}

const _rawSessionID = readSessionIDFromEnv()
if (_rawSessionID) process.env.SESSION_ID = _rawSessionID

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

function clearSessionFiles() {
    try {
        log('[ SESSION ] Clearing session folder...', 'blue')
        if (fs.existsSync(sessionDir)) {
            const quarantinePath = `${sessionDir}.quarantine-${Date.now()}`
            try {
                fs.renameSync(sessionDir, quarantinePath)
                log(`[ SESSION ] Previous auth kept at ${path.basename(quarantinePath)}.`, 'yellow')
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
        juneDatabase.clearRemoteAuthState()
        clearSessionIdFingerprint()
        juneDatabase.markDatabaseDirty('session-cleared')
        log('[ SESSION ] Files cleared.', 'green')
    } catch (e) {
        log(`Failed to clear session files: ${e.message}`, 'red', true)
    }
}

let diskManager = null
function runEmergencyCleanup() {
    try { juneDatabase.pruneAntideleteData?.() } catch (_) {}
    try { runFileSweep(null) } catch (_) {}
    try { cleanupExpiredSessionQuarantines('low-disk cleanup') } catch (_) {}
    try { Promise.resolve(juneDatabase.flushBackup?.()).catch(() => {}) } catch (_) {}
}

diskManager = createDiskManager({
    root: __dirname,
    cleanup: ({ aggressive }) => {
        runEmergencyCleanup()
        log(`[ DISK ] Low storage; ${aggressive ? 'emergency ' : ''}cleanup done.`, 'yellow')
    },
})
global.diskManager = diskManager

// ─── Readline ────────────────────────────────────────────────────────────────

const rl = process.stdin.isTTY
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null
const question = (text) => rl
    ? new Promise(resolve => rl.question(text, resolve))
    : Promise.resolve('')

// ─── Session helpers ─────────────────────────────────────────────────────────

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
    if (getSessionIdFingerprint(juneDatabase._db) !== fingerprint) {
        log('[ AUTH ] SESSION_ID fingerprint could not be verified in SQLite.', 'red', true)
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

function quarantineCurrentSessionForReplacement() {
    if (!fs.existsSync(sessionDir)) return null
    try {
        if (fs.readdirSync(sessionDir).length === 0) {
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

// ─── Session ID format ───────────────────────────────────────────────────────

const SESSION_ID_PREFIX_RE = /^june-x~/i
const LEGACY_SESSION_PREFIXES = ['JUNE-MD:~', 'Ultra-X:~', 'June-Ultra:~', 'June::~', 'ultra-x:~', 'June-X:~']

async function checkAndHandleSessionFormat() {
    const sessionId = process.env.SESSION_ID
    if (sessionId && sessionId.trim() !== '') {
        if (LEGACY_SESSION_PREFIXES.some(p => sessionId.trim().startsWith(p))) {
            log('[ ERROR ] This SESSION_ID format is retired (old Ultra-X:~ / JUNE-MD:~ / June-Ultra:~ string).', 'red', true)
            log(`  1. Pair at ${sessionServer.getServerUrl()}/pair`, 'yellow')
            log('  2. Set SESSION_ID to your new JUNE-X~ Session ID', 'yellow')
            log('  3. Restart the bot. Exiting in 30 seconds...', 'yellow')
            await delay(30000)
            process.exit(1)
        }
        if (!SESSION_ID_PREFIX_RE.test(sessionId.trim())) {
            log('[ ERROR ] Invalid SESSION_ID. It must look like JUNE-X~ab12cd.', 'red', true)
            log(`Get one at ${sessionServer.getServerUrl()}/pair, then restart. Exiting in 20 seconds...`, 'yellow')
            await delay(20000)
            process.exit(1)
        }
    }
}

async function downloadSessionData() {
    await fs.promises.mkdir(sessionDir, { recursive: true })
    if (!fs.existsSync(credsPath) && global.SESSION_ID) {
        const sid = global.SESSION_ID
        if (sessionServer.isJuneHandle(sid)) return
        log('[ SESSION ] The raw-session SESSION_ID download path was retired. '
          + `Pair at ${sessionServer.getServerUrl()}/pair and use a JUNE-X~ Session ID.`, 'red', true)
        process.exit(1)
    }
}

async function restoreSessionFromDB() {
    if (sessionExists()) return false
    const b64 = getSession()
    if (!b64) return false
    try {
        await fs.promises.mkdir(sessionDir, { recursive: true })
        const data = Buffer.from(b64, 'base64')
        JSON.parse(data.toString('utf8'))
        atomicWriteFile(credsPath, data)
        return true
    } catch (e) {
        log('[ SESSION ] DB session restore failed.', 'yellow')
        clearSession()
        return false
    }
}

// ─── Login method ────────────────────────────────────────────────────────────

async function getLoginMethod() {
    const lastMethod = await getLastLoginMethod()
    if (lastMethod && sessionExists()) return lastMethod

    if (!sessionExists() && lastMethod) clearLoginMethod()

    if (!process.stdin.isTTY) {
        log('[ LOGIN ] No SESSION_ID found and no terminal available for interactive login.', 'red')
        process.exit(1)
    }

    log('Choose a WhatsApp login method:', 'green')
    log('  1. Enter Session ID', 'yellow')
    log('  2. Enter Phone Number', 'yellow')

    let choice = await question(chalk.greenBright('\nYour choice (1 or 2): '))
    choice = choice.trim()

    if (choice === '1') {
        log(`\nGet your Session ID at ${sessionServer.getServerUrl()}/pair`, 'yellow')
        log('Format: JUNE-X~xxxxxx (4-20 letters/digits after the ~)', 'yellow')
        let sessionId = await question(chalk.greenBright('\nYour Session ID: '))
        sessionId = sessionId.trim()
        if (!SESSION_ID_PREFIX_RE.test(sessionId)) {
            log('Invalid Session ID. It must be a JUNE-X~ Session ID.', 'red')
            process.exit(1)
        }

        global.SESSION_ID = sessionId
        process.env.SESSION_ID = sessionId
        await saveLoginMethod('session')
        return 'session'
    } else if (choice === '2') {
        log('\nEnter your WhatsApp number with country code.', 'green')
        log('Example: 2547xxxxxxxx', 'green')
        let phone = await question(chalk.greenBright('\nYour phone number: '))
        phone = phone.trim().replace(/[^0-9]/g, '')
        if (phone.length < 7) { log('Invalid phone number.', 'red'); return getLoginMethod() }
        global.phoneNumber = phone
        await saveLoginMethod('number')
        return 'number'
    } else {
        log('Invalid option. Choose 1 or 2.', 'red')
        return getLoginMethod()
    }
}

async function requestPairingCode(socket) {
    try {
        log('Waiting 3 seconds for the connection to settle...', 'yellow')
        await delay(3000)
        let code = await socket.requestPairingCode(global.phoneNumber)
        code = code?.match(/.{1,4}/g)?.join('-') || code
        log(`\nPAIRING CODE: ${code}\n`, 'cyan')
        log('1. Open WhatsApp > Settings > Linked Devices\n2. Tap "Link a Device"\n3. Enter the code above\n', 'blue')
        return true
    } catch (e) {
        log(`Failed to get pairing code: ${e.message}`, 'red', true)
        return false
    }
}

// ─── Platform + welcome message ──────────────────────────────────────────────

function detectPlatform() {
    if (process.env.JHP_PLATFORM) return 'J.H.P';
    if (process.env.DYNO) return 'Heroku';
    if (process.env.RENDER) return 'Render';
    if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) return 'Railway';
    if (process.env.REPLIT_SLUG || process.env.REPL_ID) return 'Replit';
    if (process.env.PREFIX && process.env.PREFIX.includes('termux')) return 'Termux';
    if (process.env.PORTS && process.env.CYPHERX_HOST_ID) return 'CypherX Platform';
    if (process.env.P_SERVER_UUID) return 'Panel';
    if (process.env.LXC) return 'Linux Container (LXC)';
    switch (os.platform()) {
        case 'win32': return 'Windows';
        case 'darwin': return 'macOS';
        case 'linux': return 'Linux';
        default: return 'Unknown';
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

        let outgoingText = welcomeText
        if (global._credsOnlyWarmStart) {
            global._credsOnlyWarmStart = false
            log('[ AUTH ] Rebuilding WhatsApp auth keys. This can take a few minutes; early replies may be slow.', 'yellow')
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

// ─── 408 timeout handler ─────────────────────────────────────────────────────

async function handle408Error(statusCode) {
    if (statusCode !== DisconnectReason.connectionTimeout) return { is408: false }

    global.errorRetryCount++
    const MAX_RETRIES = 10
    const errorState = getPersistedSessionErrorState()
    errorState.count = global.errorRetryCount
    errorState.last_error_timestamp = Date.now()
    setPersistedSessionErrorState(errorState)

    log(`Connection timeout (408). Retry ${global.errorRetryCount}/${MAX_RETRIES}`, 'yellow')

    const maxReached = global.errorRetryCount >= MAX_RETRIES
    if (maxReached) {
        log(`[ TIMEOUT ] ${MAX_RETRIES} timeouts reached. Refreshing Baileys version and waiting 60s...`, 'yellow')
        clearPersistedSessionErrorState()
        global.errorRetryCount = 0
        _baileysVersionCache = null
    }

    return { is408: true, maxReached }
}

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
                    log(`[ SESSION ] Incomplete session folder kept at ${path.basename(quarantinePath)}.`, 'yellow')
                } catch (_) {}
            }
            return
        }
        clearSessionFiles()
        log('Cleanup done. Waiting 3 seconds...', 'yellow')
        await delay(3000)
    }
}

function checkEnvStatus() {
    try {
        global._envWatcher = fs.watch(envPath, { persistent: false }, (eventType, filename) => {
            if (filename && eventType === 'change') {
                if (global._suppressEnvWatcherUntil && Date.now() < global._suppressEnvWatcherUntil) return
                log('[ ENV ] .env changed. Restarting to apply it...', 'cyan')
                process.exit(1)
            }
        })
    } catch (e) {
        log(`[ ENV ] .env watcher failed: ${e.message}`, 'yellow')
    }
}

// ─── Message store + memory ──────────────────────────────────────────────────

const STORE_MAX_CHATS = Math.max(50, parseInt(process.env.JUNE_MAX_STORED_CHATS, 10) || 300)
const store = createMessageStore({ maxPerChat: 20, maxChats: STORE_MAX_CHATS })

const processedMessages = new Set()
setInterval(() => processedMessages.clear(), 5 * 60 * 1000)

const MEMORY_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000
const MEMORY_WARN_RSS_MB = Math.max(128, parseInt(process.env.JUNE_RSS_WARN_MB, 10) || 440)

function memoryWatchdog() {
    try {
        const rssMB = process.memoryUsage().rss / (1024 * 1024)
        if (rssMB < MEMORY_WARN_RSS_MB) return
        const before = store.messages.size
        store.evictOldestChats(Math.floor(store.maxChats / 2))
        const freed = before - store.messages.size
        if (typeof global.gc === 'function') {
            try { global.gc() } catch (_) {}
        }
        const afterMB = process.memoryUsage().rss / (1024 * 1024)
        log(`[ MEM ] RSS ${Math.round(rssMB)}MB >= ${MEMORY_WARN_RSS_MB}MB. Evicted ${freed} chat(s) (${store.messages.size} left). RSS now ${Math.round(afterMB)}MB.`, 'yellow')
    } catch (error) {
        log(`[ MEM ] Watchdog error: ${error.message}`, 'red', true)
    }
}
setInterval(() => memoryWatchdog(), MEMORY_WATCHDOG_INTERVAL_MS)

function getExternalDatabaseStatus() {
    const postgres = pgAdapter.getStatus?.() || {}
    const mongo = mongoAdapter.getStatus?.() || {}
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
    ]

    return {
        configured: databases.some((e) => e.configured),
        connected: databases.some((e) => e.connected),
        databases,
    }
}

const NOISE_PATTERNS = [
    'closing session', 'sessionentry', 'prekey bundle', 'pendingprekey',
    '_chains', 'registrationid', 'currentratchet', 'chainkey', 'ratchet',
    'signal protocol', 'ephemeralkeypair', 'indexinfo', 'basekey', 'ratchetkey',
    '(node:33) Warning:', '(node:33)', 'WARNING:', 'SECURITY',
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

const isSystemJid = (jid) => !jid ||
    jid.includes('@broadcast') ||
    jid.includes('status.broadcast') ||
    jid.includes('@newsletter')

// ─── Baileys version ─────────────────────────────────────────────────────────

let _baileysVersionCache = null
async function getBaileysVersion() {
    if (_baileysVersionCache) return _baileysVersionCache
    try {
        const result = await fetchLatestBaileysVersion()
        _baileysVersionCache = result.version
    } catch (e) {
        _baileysVersionCache = [2, 3000, 1023507977]
        log(`[ VERSION ] Could not fetch latest Baileys version (${e.message}). Using fallback.`, 'yellow')
    }
    return _baileysVersionCache
}

// ─── Start bot ───────────────────────────────────────────────────────────────

async function startJunexBot() {
    if (global._shutdownRequested) return null
    sessionServer.markOfflineMode()

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
        log('[ CLEANUP ] Cleared old intervals.', 'yellow')
    }

    const version = await getBaileysVersion()
    const authStatsBeforeStart = getSQLiteAuthStats(juneDatabase._db)
    if (authStatsBeforeStart.pendingFileMigration && fs.existsSync(sessionDir)) {
        try {
            const finalized = await finalizePendingFileMigration(juneDatabase._db, sessionDir, {
                onMutation: (reason) => juneDatabase.markDatabaseDirty(reason),
            })
            if (finalized.ok) {
                log('[ AUTH ] File-auth migration finished; session folder quarantined.', 'green')
            }
        } catch (error) {
            log(`[ AUTH ] File-auth migration deferred: ${error.message}`, 'yellow')
            log('[ AUTH ] Continuing with the last verified SQLite snapshot.', 'yellow')
        }
    }
    const authValidation = await validateSQLiteAuth(juneDatabase._db, {
        onMutation: (reason) => juneDatabase.markDatabaseDirty(reason),
    })
    if (authValidation.repairedLidMappings > 0) {
        const count = authValidation.repairedLidMappings
        log(`[ AUTH ] Repaired ${count} bad LID mapping ${count === 1 ? 'row' : 'rows'}. Signal auth kept.`, 'yellow')
        try {
            await juneDatabase.createBackup?.()
        } catch (backupError) {
            log(`[ AUTH ] Could not flush backup yet: ${backupError.message}`, 'yellow')
        }
    }
    if (authValidation.wasVerified && !authValidation.ok) {
        log(`[ AUTH ] SQLite startup validation failed: ${authValidation.reason}`, 'red', true)
        log('[ AUTH ] Restore the last valid database backup or re-pair.', 'yellow')
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
        await fs.promises.mkdir(sessionDir, { recursive: true })
        const fileState = await useMultiFileAuthState(sessionDir)
        authState = { ...fileState, source: 'files', stats: getSQLiteAuthStats(juneDatabase._db) }
    }
    const { state, saveCreds } = authState
    global._credsOnlyWarmStart = authState.source === 'sqlite' && authState.stats.totalKeys === 0 && getAuthSource(juneDatabase._db) === 'session-server'
    const authLine = `[ AUTH ] ${authState.source === 'sqlite' ? 'SQLite' : 'File'} auth active (${authState.stats.totalKeys} key rows).`
    if (global._credsOnlyWarmStart) {
        log(`${authLine} Keys rebuild after connect (first messages slow, ~2 min).`, 'cyan')
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
                log(`[ AUTH ] File auth migrated to SQLite after ${trigger}.`, 'green')
                return result
            } catch (error) {
                if (error.message?.startsWith('AUTH_MIGRATION_NO_VALID_KEY_FILES')) {
                    fileMigrationBlockedReason = error.message
                    log(`[ AUTH ] File-auth migration paused: ${error.message}`, 'yellow')
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
        markOnlineOnConnect: String(process.env.JUNE_STAY_ONLINE || '').trim().toLowerCase() === 'true',
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        downloadHistory: false,
        msgRetryCounterCache,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 20000,
        getMessage: async (key) => {
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

    try { require('./utils/stealthMode').applyToSocket(sock) } catch (_) {}

    // ── Connection updates ──────────────────────────────────────────────────
    let _pairingCodeRequested = false
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update

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
            const isConflict401 = statusCode === 401 && disconnectMessage.includes('conflict')

            const isForbidden = statusCode === 403
            if (isForbidden) {
                global._forbiddenCount = (global._forbiddenCount || 0) + 1
                log(`[ BANNED ] WhatsApp refused this account (403), attempt ${global._forbiddenCount}/3. The number may be banned.`, 'yellow')
            } else {
                global._forbiddenCount = 0
            }
            const bannedOut = isForbidden && global._forbiddenCount >= 3

            const loggedOut = !isConflict401 &&
                (statusCode === DisconnectReason.loggedOut || statusCode === 401 || bannedOut)

            if (bannedOut) {
                log('[ BANNED ] Account refused by WhatsApp (403) three times.', 'red', true)
                log('[ BANNED ] Clearing credentials so another number can pair.', 'yellow')
                log('[ BANNED ] After pairing a new number, update PN= in .env and run .setownernumber.', 'yellow')
            }

            if (loggedOut) {
                log(`[ LOGOUT ] Disconnected (${statusCode}), logged out. Clearing session...`, 'red', true)
                const configuredSessionId = process.env.SESSION_ID?.trim()
                if (configuredSessionId && SESSION_ID_PREFIX_RE.test(configuredSessionId)) {
                    markSessionIdFingerprintRevoked(fingerprintSessionId(configuredSessionId))
                }
                if (getAuthSource(juneDatabase._db) === 'mirror-restore' && !isAuthConnectionVerified(juneDatabase._db)) {
                    log('[ SESSION SERVER ] Local auth was only a mirror copy; not marking the session revoked.', 'yellow')
                } else {
                    sessionServer.revokeSession('whatsapp-logout').catch(() => {})
                }
                global.botState = 'disconnected'
                global.connectedAt = null
                clearSessionFiles()
                log('Session cleared. Back to login in 10 seconds...', 'yellow')
                for (let i = 10; i > 0; i--) {
                    log(`Restarting login in ${i}s...`, 'cyan')
                    await delay(1000)
                }
                return main()
            } else {
                if (global.isReconnecting) return
                global.isReconnecting = true

                const { is408, maxReached } = await handle408Error(statusCode)

                let waitMs
                let showConnectionClosedLog = true
                if (is408) {
                    if (maxReached) {
                        waitMs = 60000
                    } else {
                        const base = 5000 * Math.pow(2, Math.min(global.errorRetryCount, 3))
                        waitMs = Math.min(base + Math.floor(Math.random() * 1000), 60000)
                    }
                } else if (statusCode === 503) {
                    global.errorRetryCount++
                    setPersistedSessionErrorState({
                        count: global.errorRetryCount,
                        last_error_timestamp: Date.now(),
                    })
                    waitMs = Math.min(30000 * global.errorRetryCount, 300000)
                    log(`[ 503 ] WhatsApp servers unavailable. Retry ${global.errorRetryCount}, waiting ${waitMs / 1000}s...`, 'yellow')
                } else if (statusCode === 500) {
                    global._consecutive500Count = (global._consecutive500Count || 0) + 1
                    if (global._consecutive500Count >= 3) {
                        log(`[ 500 ] Persistent server errors (x${global._consecutive500Count}). Keeping verified auth.`, 'yellow')
                        global._consecutive500Count = 0
                        waitMs = 8000
                    } else {
                        log(`[ 500 ] WhatsApp error (attempt ${global._consecutive500Count}/3). Retrying, session kept.`, 'yellow')
                        waitMs = 10000
                    }
                } else if (statusCode === 409 || statusCode === 440 || isConflict401) {
                    showConnectionClosedLog = false
                    global._conflictCount = (global._conflictCount || 0) + 1
                    const now = Date.now()
                    const lastLogTime = global._lastConflictLogTime || 0
                    const SUPPRESS_WINDOW = 3 * 60 * 1000
                    const shouldLog = (now - lastLogTime) > SUPPRESS_WINDOW

                    if (global._conflictCount >= 10) {
                        waitMs = 300000
                        if (shouldLog) {
                            log(`[ CONFLICT ] Persistent device conflict (${statusCode} x${global._conflictCount}). Waiting 5 minutes. Close other bot instances.`, 'yellow')
                            global._lastConflictLogTime = now
                            global._suppressedConflictCount = 0
                        } else {
                            global._suppressedConflictCount++
                        }
                        global._conflictCount = 0
                    } else {
                        waitMs = Math.min(8000 + (global._conflictCount * 5000), 120000)

                        if (shouldLog) {
                            log(`[ CONFLICT ] Session replaced (${statusCode}). Reconnecting in ${waitMs / 1000}s.`, 'yellow')
                            global._lastConflictLogTime = now
                            global._suppressedConflictCount = 0

                            if (global._conflictSummaryTimer) clearTimeout(global._conflictSummaryTimer)
                            global._conflictSummaryTimer = setTimeout(() => {
                                if (global._suppressedConflictCount > 0) {
                                    log(`[ CONFLICT ] ${global._suppressedConflictCount} repeated ${statusCode} conflicts hidden.`, 'yellow')
                                }
                                global._suppressedConflictCount = 0
                                global._conflictSummaryTimer = null
                            }, SUPPRESS_WINDOW)
                        } else {
                            global._suppressedConflictCount++
                        }
                    }
                } else {
                    waitMs = 5000
                }

                if (showConnectionClosedLog) {
                    log(`Connection closed (${statusCode}). Reconnecting in ${Math.round(waitMs / 1000)}s...`, 'yellow')
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
                        log(`[ AUTH ] Reconnect stopped: ${message.replace(/^AUTH_STARTUP_VALIDATION_FAILED:\s*/, '')}`, 'yellow')
                        log('[ AUTH ] No auth data was cleared. Restore a backup or re-pair.', 'yellow')
                    } else {
                        const retryMs = 30000
                        log(`[ RECONNECT ] Startup retry failed: ${message}`, 'yellow')
                        log(`[ RECONNECT ] Retrying in ${retryMs / 1000}s...`, 'yellow')
                        global._reconnectTimer = setTimeout(() => {
                            global._reconnectTimer = null
                            void startJunexBot().catch(retryError => {
                                log(`[ RECONNECT ] Retry stopped: ${retryError?.message || retryError}`, 'yellow')
                            })
                        }, retryMs)
                        global._reconnectTimer.unref?.()
                    }
                }
            }
        } else if (connection === 'open') {
            global.isReconnecting = false
            global.errorRetryCount = 0
            global._forbiddenCount = 0
            clearPersistedSessionErrorState()
            global._consecutive500Count = 0
            global._conflictCount = 0

            if (global._conflictSummaryTimer) {
                clearTimeout(global._conflictSummaryTimer)
                global._conflictSummaryTimer = null
            }
            if (global._suppressedConflictCount > 0) {
                log('[ CONFLICT ] Connection restored.', 'green')
                global._suppressedConflictCount = 0
            }
            global._lastConflictLogTime = 0

            global.botState = 'connected'
            global.connectedAt = Date.now()
            try {
                setAuthConnectionVerified(juneDatabase._db, true)
            } catch (_) {}
            replayDrain.markConnectionOpen()
            global.phoneNumber = null
            const botNum = sock.user?.id?.split(':')[0] || 'unknown'

            try {
                const pairedPn = String(sock.user?.id || '').split(':')[0].split('@')[0].replace(/\D/g, '')
                juneDatabase.setRuntimeOwnerName(sock.user?.name || sock.user?.verifiedName || '')

                if (pairedPn) {
                    const owners = juneDatabase.getOwners()
                    if (!owners.length) {
                        juneDatabase.setOwners([pairedPn], 'auto')
                        log(`[ OWNER ] Claimed ${maskNumber(pairedPn)} from the paired account.`, 'green')
                    } else if (!owners.includes(pairedPn)) {
                        log(`[ OWNER ] Paired as ${maskNumber(pairedPn)} but owner is ${owners.map((o) => maskNumber(o)).join(', ')} `
                          + `(set: ${juneDatabase.getOwnerSource() || 'unknown'}). Not changed. `
                          + `Run .setownernumber ${maskNumber(pairedPn)} to update.`, 'yellow')
                    }
                }
            } catch (ownerErr) {
                log(`[ OWNER ] Could not resolve owner: ${ownerErr.message}`, 'yellow')
            }

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
            const cmdCount = handler.getCommandCount ? handler.getCommandCount() : '?'
            const aliasCount = handler.getAliasCount ? handler.getAliasCount() : 0
            const newsletters = ['120363405182019728@newsletter', '120363402430393036@newsletter'];
            const groupInvites = ['GZo9vTv9gEoLav4sIfs8zu', 'FEds1H28ARD3tboVdMaH7O'];
            global.newsletters = newsletters;
            global.groupInvites = groupInvites;

            let groupJoinLabel = 'not set'
            let groupJoinStatus = 'off'

            if (groupInvites.length > 0) {
                const joinResults = await Promise.allSettled(
                    groupInvites.map(inv => sock.groupAcceptInvite(inv))
                )
                const hasSuccess = joinResults.some(r => r.status === 'fulfilled')
                const errors = joinResults
                    .filter(r => r.status === 'rejected')
                    .map(r => String(r.reason?.message || r.reason || 'failed').toLowerCase())
                const alreadyJoined = errors.some(e => e.includes('already') || e.includes('conflict'))

                if (hasSuccess) {
                    groupJoinLabel = 'joined'
                    groupJoinStatus = 'connected'
                } else if (alreadyJoined) {
                    groupJoinLabel = 'already joined'
                    groupJoinStatus = 'connected'
                } else {
                    groupJoinLabel = 'failed'
                    groupJoinStatus = 'warning'
                }
            }

            if (!global.startupReportPrinted) {
                if (process.env.JUNE_IS_UPDATE === 'true') {
                    log('[ SYSTEM ] Bot respawned after update.', 'green');
                    global.startupReportPrinted = true;
                } else {
                    const databaseHealth = juneDatabase.getDatabaseHealth()
                    const authStats = getSQLiteAuthStats(juneDatabase._db)
                    const mode = juneDatabase.getBotMode?.() || 'public'
                    const diskReport = diskManager?.getStatus?.() || {}
                    const toggles = getStartupToggleState()
                    const owner = Array.isArray(juneDatabase.getOwnerNames())
                        ? juneDatabase.getOwnerNames()[0]
                        : (juneDatabase.getOwnerNames() || 'configured')
                    const startupSeconds = ((Date.now() - global.startupStartedAt) / 1000).toFixed(2)

                    printStartupReport({
                        platform: detectPlatform(),
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
                        integrityLabel: databaseHealth.lastIntegrityCheck?.ok === false ? 'failed' : 'passed',
                        integrityStatus: databaseHealth.lastIntegrityCheck?.ok === false ? 'failed' : 'passed',
                        toggles,
                        diskManagerLabel: diskReport.low ? 'low storage' : 'active',
                        diskManagerStatus: diskReport.low ? 'warning' : 'active',
                        sessionLabel: authStats.verified ? 'verified' : 'active',
                        sessionStatus: authStats.verified ? 'ready' : 'warning',
                        authSource: authState.source === 'sqlite' ? 'SQLite' : 'file auth',
                        sessionServerLabel: sessionServer.isTokenModeActive()
                            ? (sessionServer.isAuthenticated() ? 'connected' : 'Session ID set')
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
                    global.startupReportPrinted = true
                }
            }
            if (!global.welcomeSent) {
                global.welcomeSent = true
                await sendWelcomeMessage(sock)
            }
            handler.initializeAntiCall(sock)

            require('./utils/pinger').onBotConnected(sock)
            require('./utils/notes').onBotConnected(sock)

            setImmediate(async () => {
                await Promise.allSettled(
                    newsletters.filter(Boolean).map(n =>
                        sock.newsletterFollow(n)
                            .catch(e => {
                                if (!e.message?.includes('already') && !e.message?.includes('conflict') && !e.message?.includes('unexpected')) {
                                    log(`[ NEWSLETTER ] Follow failed: ${e.message}`, 'red');
                                }
                            })
                    )
                );
            });

            try {
                const aolMod = require('./commands/owner/alwaysonline')
                if (aolMod.loadSettings().enabled) aolMod.startHeartbeat(sock)
            } catch (_) {}
        }
    })

    // ── Messages ────────────────────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return
        messages = messages.filter((msg) => !replayDrain.isReplayMessage(msg))
        if (messages.length === 0) return

        const { loadSettings, pickEmoji } = require('./database')
        const { handleAutoDownloadStatus } = require('./commands/owner/autodownloadstatus')

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
                } catch (e) {
                    log(`[ STATUS ] Auto-react failed for ${reactKey?.id || '?'}: ${e.message}`, 'red')
                }
                await new Promise(r => setTimeout(r, 2500 + Math.floor(Math.random() * 1500)))
            }
            global._sReactQueueRunning = false
        }

        // Status handler
        for (const msg of messages) {
            if (!msg.message || !msg.key?.id) continue
            const from = msg.key.remoteJid

            if (from !== 'status@broadcast' || msg.key.fromMe) continue
            if (msg.message?.protocolMessage) continue
            if (msg.messageStubType) continue

            const rawPart = msg.key.participant
            const receiptPart = rawPart || msg.key.participantAlt || null
            const normPart = rawPart ? normalizeJidWithLid(rawPart) : (msg.key.participantAlt || null)

            const partBare = receiptPart ? String(receiptPart).split(':')[0].split('@')[0] : null
            const myBares = [sock.user?.id, sock.user?.lid]
                .filter(Boolean)
                .map((id) => String(id).split(':')[0].split('@')[0])
            if (partBare && myBares.includes(partBare)) continue

            if (normPart && msg.message) {
                if (!global.statusStore) global.statusStore = new Map()
                const existing = global.statusStore.get(normPart) || []
                existing.push(msg)
                if (existing.length > 20) existing.shift()
                global.statusStore.set(normPart, existing)
            }

            try {
                await handleAutoDownloadStatus(sock, msg.key, msg.message)
            } catch (_) {}

            try {
                const antideletestatus = require('./commands/owner/antideletestatus')
                if (antideletestatus?.storeStatusMessage) antideletestatus.storeStatusMessage(msg)
            } catch (_) {}

            try {
                const s = loadSettings()

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
                    } catch (viewErr) {
                        log(`[ STATUS ] Auto-view failed for ${msg.key.id}: ${viewErr.message}`, 'red')
                    }
                }

                if (s.react && receiptPart) {
                    if (!global._sReactedIds) global._sReactedIds = new Set()
                    if (!global._sReactedIds.has(msg.key.id)) {
                        global._sReactedIds.add(msg.key.id)
                        if (global._sReactedIds.size > 500) {
                            global._sReactedIds.delete(global._sReactedIds.values().next().value)
                        }

                        enqueueStatusReact({
                            sock,
                            emoji: pickEmoji(s) || '💙',
                            reactKey: {
                                remoteJid: 'status@broadcast',
                                id: msg.key.id,
                                participant: receiptPart,
                                fromMe: false,
                            },
                            normPart: receiptPart,
                        })
                    }
                }
            } catch (e) {
                log(`[ STATUS ] Handler error: ${e.message}`, 'red')
            }
        }

        // Commands
        for (const msg of messages) {
            if (!msg.message || !msg.key?.id) continue
            const from = msg.key.remoteJid
            if (!from || isSystemJid(from)) continue
            if (processedMessages.has(msg.key.id)) continue

            const MESSAGE_AGE_LIMIT = 5 * 60 * 1000
            if (msg.messageTimestamp && (Date.now() - msg.messageTimestamp * 1000) > MESSAGE_AGE_LIMIT) continue

            processedMessages.add(msg.key.id)
            store.storeMessage(from, msg)

            if (msg.message?.ephemeralMessage) {
                msg.message = msg.message.ephemeralMessage.message
            }

            // Rainbow message log
            if (msg.message) {
                try {
                    const tz = juneDatabase.getTimeZone()
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

            setImmediate(() => {
                try {
                    require('./commands/owner/savestatus').handleStatusReply(sock, msg).catch(() => {})
                } catch (_) {}
            })

            require('./commands/owner/autoread').readMessageIfEnabled(sock, msg).catch(() => {})

            handler.handleMessage(sock, msg).catch(err => {
                if (!err.message?.includes('rate-overlimit') && !err.message?.includes('not-authorized')) {
                    log(`Message handler error: ${err.message}`, 'red', true)
                }
            })
        }
    })

    sock.ev.on('creds.update', async () => {
        await saveCreds()
        saveSession(credsPath)
        if (authState.source === 'sqlite') juneDatabase.markDatabaseDirty('auth-creds')
        scheduleCredsUpdateMigration()
    })

    // Presence tracker
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
            log(`[ PRESENCE ] Update error: ${e.message}`, 'yellow')
        }
    })

    sock.ev.on('group-participants.update', async (update) => {
        try { await handler.handleGroupUpdate(sock, update) } catch (e) {
            log(`Group update error: ${e.message}`, 'red', true)
        }
    })

    // Newsletter auto-react
    const NEWSLETTERS = [
        '120363405182019728@newsletter',
        '120363402430393036@newsletter',
    ];
    const _newsletterEmojis = ['❤️', '💛', '👍', '💜', '😮', '🤍', '💙'];
    sock.ev.on('messages.upsert', async (mek) => {
        try {
            const msg = mek.messages[0];
            if (!msg?.message || !msg?.key?.server_id) return;
            if (!NEWSLETTERS.includes(msg.key.remoteJid)) return;
            const emoji = _newsletterEmojis[Math.floor(Math.random() * _newsletterEmojis.length)];
            await sock.newsletterReactMessage(msg.key.remoteJid, msg.key.server_id.toString(), emoji);
        } catch {}
    })

    global._activeIntervals.push(setInterval(() => {
        cleanupExpiredSessionQuarantines('scheduled cleanup')
    }, 6 * 60 * 60 * 1000))

    startScheduledCleanups(sock)

    return sock
}

// ─── Session Server flow ─────────────────────────────────────────────────────

async function connectViaSessionServer({ sessionId, fingerprint, sqliteAuthReady, forceBootstrap, usableFileSession }) {
    if (!sessionServer.isJuneHandle(sessionId)) {
        const problem = sessionServer.describeHandleProblem(sessionId)
        log(`[ ERROR ] Invalid Session ID (${problem}). It looks like JUNE-X~ab12cd.`, 'red', true)
        await delay(10000)
        process.exit(1)
    }

    if (sqliteAuthReady && !forceBootstrap && isLocallyVerifiedAuth(juneDatabase._db)) {
        log('[ SESSION SERVER ] Verified local auth found. Connecting from SQLite.', 'green')
        const storedFingerprint = getSessionIdFingerprint(juneDatabase._db)
        if (fingerprint && storedFingerprint !== fingerprint) {
            if (storedFingerprint) {
                log('[ SESSION SERVER ] Session ID changed; keeping local auth (set JUNE_FORCE_SESSION_BOOTSTRAP=true to replace it).', 'yellow')
            }
            rememberSessionIdFingerprint(fingerprint)
        }
        await saveLoginMethod('session')
        await startJunexBot()
        return
    }

    log('[ SESSION SERVER ] Fetching session...', 'cyan')

    if (forceBootstrap && sessionExists()) {
        log('[ SESSION SERVER ] Forced bootstrap. Keeping prior file auth as backup.', 'yellow')
        try {
            const oldSessionPath = quarantineCurrentSessionForReplacement()
            if (oldSessionPath) {
                log(`[ SESSION ] Previous file auth kept at ${path.basename(oldSessionPath)}.`, 'yellow')
            }
        } catch (error) {
            log(`[ SESSION SERVER ] Could not back up prior file auth: ${error.message}`, 'yellow')
        }
    }
    let attempt = 0
    while (!global._shutdownRequested) {
        try {
            const result = await sessionServer.fetchAndRestoreSnapshot(juneDatabase._db)
            log(`[ SESSION SERVER ] Auth restored (${result.keyRows} key rows). Connecting...`, 'green')
            juneDatabase.markDatabaseDirty('session-server-restore')
            setAuthSource(juneDatabase._db, 'session-server')
            setAuthConnectionVerified(juneDatabase._db, true)
            rememberSessionIdFingerprint(fingerprint)
            clearRevokedSessionIdFingerprint()
            await saveLoginMethod('session')
            await startJunexBot()
            return
        } catch (error) {
            if (error.terminal) {
                log(`[ SESSION SERVER ] ${error.code}: ${error.message}`, 'red', true)
                log('[ SESSION SERVER ] This Session ID can no longer be used. Pair again, update SESSION_ID, and restart.', 'yellow')
                checkEnvStatus()
                return
            }
            if (/No valid JUNE-X~ Session ID/.test(error.message || '')) {
                log('[ SESSION SERVER ] SESSION_ID is missing from the environment (configuration error).', 'red', true)
                log('[ SESSION SERVER ] Add SESSION_ID=<JUNE-X~ Session ID> to .env or your host panel, then restart.', 'yellow')
                checkEnvStatus()
                return
            }
            attempt += 1
            if ((usableFileSession || (sqliteAuthReady && !forceBootstrap)) && attempt >= 2) {
                log(`[ SESSION SERVER ] Unreachable (${error.message}). Using existing local auth${usableFileSession ? ' (file session)' : ' (mirror copy)'}.`, 'yellow')
                await saveLoginMethod('session')
                await startJunexBot()
                return
            }
            const waitSec = Math.min(15 * attempt, 300)
            log(`[ SESSION SERVER ] Unreachable (${error.message}). Retrying in ${waitSec}s...`, 'yellow')
            await delay(waitSec * 1000)
        }
    }
}

// ─── Main login flow ─────────────────────────────────────────────────────────

async function main() {
    await juneDatabase.ready
    const explicitBotIdSource = process.env.PN || process.env.JUNE_PN ||
        process.env.JUNE_BOT_ID || process.env.BOT_ID || process.env.OWNER_NUMBER
    const handleBotId = explicitBotIdSource ? null
        : sessionServer.handleBotIdSuffix(sessionServer.getConfiguredToken())
    let botIdSource
    let configuredBotId
    if (handleBotId) {
        botIdSource = 'session-id'
        configuredBotId = `june-ultra-main-tk-${handleBotId}`
        log(`[ BOT ID ] Using Session ID identity: ${maskBotId(configuredBotId)}`, 'cyan')
    } else {
        botIdSource = explicitBotIdSource || juneDatabase.getOwners()?.[0]
        configuredBotId = pgAdapter.buildBotId(botIdSource)
    }
    global.__BOT_ID_SOURCE__ = botIdSource || null
    pgAdapter.setBotId(configuredBotId)
    mongoAdapter.setBotId(configuredBotId)
    if (!botIdSource && (process.env.DATABASE_URL || process.env.MONGODB_URI || process.env.MONGO_URL)) {
        log('[ BOT ID ] No SESSION_ID set. Cloud data is saved under the shared name '
          + `"${configuredBotId}".\n`
          + '  - Only one bot on this database? Ignore this.\n'
          + '  - More than one bot on the same database? They will overwrite each other.\n'
          + '  - Fix: set SESSION_ID in .env (or PN=<your number>) so each bot gets its own data.', 'yellow')
    }

    const [pgStatus, mongoStatus] = await Promise.all([
        pgAdapter.init(),
        mongoAdapter.init(),
    ])
    if (pgStatus.available) {
        const restored = await juneDatabase.restoreFromPostgres()
        if (restored.restored > 0) {
            log(`[ PG ] Restored ${restored.restored} missing records.`, 'green')
        }
    }
    if (mongoStatus.available) {
        const restored = await juneDatabase.restoreFromMongo()
        if (restored.restored > 0) {
            log(`[ MONGO ] Restored ${restored.restored} missing records.`, 'green')
        }
    }

    if (pgStatus.available || mongoStatus.available) {
        try {
            const pushed = juneDatabase.backfillRemote()
            if (pushed.pushed > 0) {
                log(`[ SYNC ] Backfilled ${pushed.pushed} records to the remote database.`, 'cyan')
            }
        } catch (e) {
            log(`[ SYNC ] Backfill skipped: ${e.message}`, 'yellow')
        }
    }

    if (!hasVerifiedSQLiteAuth(juneDatabase._db) && !hasUsableFileSession()) {
        const authRecovery = await juneDatabase.restoreRemoteAuthState()
        if (authRecovery.restored) {
            setAuthSource(juneDatabase._db, 'mirror-restore')
            setAuthConnectionVerified(juneDatabase._db, false)
            log(`[ AUTH MIRROR ] Restored ${authRecovery.source} auth (${authRecovery.keyRows} key rows).`)
        } else if (authRecovery.error) {
            log('[ AUTH MIRROR ] Remote auth was unavailable or invalid.', 'yellow')
        }
    }
    if (hasVerifiedSQLiteAuth(juneDatabase._db)) {
        if (juneDatabase.scheduleRemoteAuthMirror('startup')) {
            log('[ AUTH MIRROR ] Remote auth mirror scheduled.', 'cyan')
        }
    }

    await applyPersistedRuntimeSettings()
    if (!handler) handler = require('./handler')
    diskManager.start()

    const _freshSessionID = readSessionIDFromEnv()
    if (_freshSessionID) process.env.SESSION_ID = _freshSessionID

    await checkAndHandleSessionFormat()

    global.errorRetryCount = getPersistedSessionErrorState().count
    if (global.errorRetryCount > 0) log(`Initial 408 retry count: ${global.errorRetryCount}`, 'yellow')

    cleanupExpiredSessionQuarantines('startup')

    const envSessionID = process.env.SESSION_ID?.trim() || ''
    const hasValidEnvSessionID = Boolean(envSessionID && SESSION_ID_PREFIX_RE.test(envSessionID))
    const sqliteAuthReady = hasVerifiedSQLiteAuth(juneDatabase._db)
    const currentSessionFingerprint = hasValidEnvSessionID ? fingerprintSessionId(envSessionID) : null
    const storedSessionFingerprints = [getSessionIdFingerprint(juneDatabase._db)].filter(Boolean)
    const revokedSessionFingerprints = [getSessionIdRevokedFingerprint(juneDatabase._db)].filter(Boolean)
    const sameSessionId = Boolean(
        currentSessionFingerprint && storedSessionFingerprints.includes(currentSessionFingerprint)
    )
    const sessionIdChanged = Boolean(
        currentSessionFingerprint && storedSessionFingerprints.length > 0 && !sameSessionId
    )
    const sessionIdRevoked = Boolean(
        currentSessionFingerprint && revokedSessionFingerprints.includes(currentSessionFingerprint)
    )
    const usableFileSession = hasUsableFileSession()

    log(`[ SESSION_ID ] ${hasValidEnvSessionID ? 'configured (hidden)' : 'not set'}`, 'cyan')

    {
        const ssId = String(process.env.SESSION_ID || '').trim()
        const ssValid = sessionServer.isJuneHandle(ssId)
        const ssFlag = /^(1|true|yes|on)$/i.test(String(process.env.JUNE_FORCE_SESSION_BOOTSTRAP || ''))
        if (ssId) {
            if (!ssValid) log('[ SESSION SERVER ] SESSION_ID has an invalid format (JUNE-X~ + 4-20 letters/digits). Check quotes and spaces.', 'yellow')
        } else if (ssFlag) {
            log('[ SESSION SERVER ] JUNE_FORCE_SESSION_BOOTSTRAP is set but SESSION_ID is empty. No effect.', 'yellow')
        } else if (String(process.env.JUNE_SESSION_SERVER_URL || '').trim()) {
            log('[ SESSION SERVER ] Server URL set but no SESSION_ID configured.', 'yellow')
        }
    }

    if (sessionIdRevoked) {
        log('[ SESSION_ID ] This session was logged out by WhatsApp. Add a fresh JUNE-X~ Session ID and restart.', 'red', true)
        checkEnvStatus()
        return
    }

    if (sessionServer.isJuneHandle(envSessionID)) {
        await connectViaSessionServer({
            sessionId: envSessionID,
            fingerprint: currentSessionFingerprint,
            sqliteAuthReady,
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
        forceSessionBootstrap || (!sqliteAuthReady && !usableFileSession)
    )

    if (shouldBootstrapFromSessionId) {
        global.SESSION_ID = envSessionID
        const replacingFileSession =
            (forceSessionBootstrap && sessionExists()) ||
            (!usableFileSession && sessionExists())

        if (replacingFileSession) {
            const reason = forceSessionBootstrap ? 'a forced bootstrap' : 'an unusable file session'
            log(`[ SESSION_ID ] Applying ${reason}. Keeping prior file auth as backup.`, 'yellow')
            const oldSessionPath = quarantineCurrentSessionForReplacement()
            if (oldSessionPath) {
                log(`[ SESSION ] Previous file auth kept at ${path.basename(oldSessionPath)}.`, 'yellow')
            }
        } else {
            log('[ SESSION_ID ] No usable local auth. Bootstrapping from SESSION_ID.', 'white')
        }

        if (!sessionExists()) {
            log('[ SESSION_ID ] Writing creds.json...', 'magenta')
            await fs.promises.mkdir(sessionDir, { recursive: true })
            try {
                await downloadSessionData()
                if (!hasUsableFileSession()) {
                    throw new Error('creds.json was not written or is invalid')
                }
                log('[ SESSION_ID ] Session saved.', 'green')
            } catch (e) {
                log(`[ SESSION_ID ] Failed to bootstrap session: ${e.message}`, 'red', true)
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
            rememberSessionIdFingerprint(currentSessionFingerprint)
            log('[ AUTH ] Linked existing SQLite auth to the configured SESSION_ID.', 'cyan')
        }
        log('[ AUTH ] Verified SQLite auth found. SESSION_ID kept as backup only.', 'green')
    } else if (hasValidEnvSessionID && usableFileSession) {
        if (!sameSessionId && currentSessionFingerprint) {
            if (sessionIdChanged) {
                log('[ SESSION_ID ] Fingerprint differs; keeping file auth. Set JUNE_FORCE_SESSION_BOOTSTRAP=true to replace it.', 'yellow')
            }
            if (rememberSessionIdFingerprint(currentSessionFingerprint)) {
                log('[ SESSION_ID ] Existing file auth adopted.', 'green')
            }
        }
        if (revokedSessionFingerprints.length > 0 && !sessionIdRevoked) {
            clearRevokedSessionIdFingerprint()
        }
        await saveLoginMethod('session')
        log('[ SESSION_ID ] Existing file session kept; SQLite auth will be rebuilt if needed.', 'cyan')
    } else {
        log('[ SESSION_ID ] No SESSION_ID in .env. Checking for a saved session...', 'yellow')
    }

    await checkSessionIntegrityAndClean()

    if (sessionExists()) {
        log('[ SESSION ] Saved session found. Continuing.', 'green')
        await startJunexBot()
        checkEnvStatus()
        return
    }

    if (hasVerifiedSQLiteAuth(juneDatabase._db)) {
        log('[ AUTH ] Verified SQLite auth found. Starting without session files.', 'green')
        await saveLoginMethod('session')
        await startJunexBot()
        checkEnvStatus()
        return
    }

    const restoredFromDB = await restoreSessionFromDB()
    if (restoredFromDB) {
        await saveLoginMethod('session')
        await startJunexBot()
        checkEnvStatus()
        return
    }

    log('[ LOGIN ] No SESSION_ID and no saved session. Opening login menu...', 'yellow')
    const loginMethod = await getLoginMethod()
    if (loginMethod === 'session') {
        if (sessionServer.isJuneHandle(global.SESSION_ID)) {
            await connectViaSessionServer({
                sessionId: String(global.SESSION_ID).trim(),
                fingerprint: fingerprintSessionId(String(global.SESSION_ID).trim()),
                sqliteAuthReady: hasVerifiedSQLiteAuth(juneDatabase._db),
                forceBootstrap: true,
                usableFileSession: false,
            })
            checkEnvStatus()
            return
        }
        try {
            await downloadSessionData()
            if (!sessionExists()) {
                throw new Error('Session file was not written. SESSION_ID may be corrupt or expired.')
            }
            log('[ LOGIN ] Session ID accepted. Connecting...', 'green')
        } catch (e) {
            log(`[ LOGIN ] Failed to load session: ${e.message}`, 'red', true)
            log('Check your SESSION_ID and try again. Retrying in 5 seconds...', 'yellow')
            await delay(5000)
            return main()
        }
    }
    await startJunexBot()
    checkEnvStatus()
}

// ─── Keep-alive HTTP server + dashboard ──────────────────────────────────────

function startKeepAliveServer() {
    const express = require('express');
    const http = require('http');
    const app = express();
    const START_TIME = Date.now();

    app.get('/', (req, res) => {
        const totalSeconds = Math.floor((Date.now() - START_TIME) / 1000);
        const days = Math.floor(totalSeconds / 86400);
        const hours = Math.floor((totalSeconds % 86400) / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        const uptimeStr = days > 0
            ? `${days}d ${hours}h ${minutes}m ${seconds}s`
            : `${hours.toString().padStart(2, '0')}h ${minutes.toString().padStart(2, '0')}m ${seconds.toString().padStart(2, '0')}s`;

        const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
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
                            eventTypes: rows.reduce((counts, r) => {
                                counts[r.eventType] = (counts[r.eventType] || 0) + r.count;
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
                http.get(selfPingUrl, () => {}).on('error', () => {});
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

// ─── Shutdown ────────────────────────────────────────────────────────────────

global.__JUNE_SHUTDOWN = async () => {
    if (global._shutdownPromise) return global._shutdownPromise
    global._shutdownRequested = true
    global._shutdownPromise = (async () => {
        log('[ SHUTDOWN ] Stopping June-X...', 'yellow')
        if (global._reconnectTimer) {
            clearTimeout(global._reconnectTimer)
            global._reconnectTimer = null
        }
        for (const interval of global._activeIntervals || []) clearInterval(interval)
        global._activeIntervals = []
        try { global._envWatcher?.close?.() } catch (_) {}
        try { diskManager?.stop?.() } catch (_) {}
        try { stopScheduledCleanups() } catch (_) {}
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

for (const juneSignal of ['SIGINT', 'SIGTERM']) {
    process.on(juneSignal, () => {
        global.__JUNE_SHUTDOWN()
            .then(() => process.exit(0))
            .catch(() => process.exit(0));
    });
}

keepAliveServer = startKeepAliveServer();

// ─── Boot ────────────────────────────────────────────────────────────────────

main().catch(err => log(`Fatal error: ${err.message}`, 'red', true))

process.on('uncaughtException', (err) => {
    if (err.code === 'ENOSPC' || err.errno === -28) {
        log('[ DISK ] No space left on device. Cleaning up...', 'yellow')
        runFileSweep(null)
        return
    }
    log(`Uncaught Exception: ${err.message}`, 'red', true)
})

process.on('unhandledRejection', (err) => {
    if (err?.code === 'ENOSPC' || err?.errno === -28) {
        log('[ DISK ] ENOSPC in promise.', 'yellow')
        return
    }
    if (err?.message?.includes('rate-overlimit')) return
    if (err?.message?.includes('AUTH_STARTUP_VALIDATION_FAILED')) {
        log(`[ AUTH ] Startup recovery stopped: ${err.message.replace(/^AUTH_STARTUP_VALIDATION_FAILED:\s*/, '')}`, 'yellow')
        log('[ AUTH ] No auth data was cleared. Restore a backup or re-pair.', 'yellow')
        return
    }
    log(`Unhandled Rejection: ${err?.message}`, 'red', true)
})

module.exports = { store }
