/**
 * AutoRead Command — Owner only
 * Automatically marks incoming chat messages as read (blue ticks).
 *
 *   .autoread            → show the current mode
 *   .autoread off        → disabled (default; nothing is auto-read)
 *   .autoread all        → read every incoming chat message
 *   .autoread contacts   → read only messages from known contacts
 *
 * Persists in bot_settings under 'autoReadMode' (the pre-existing setting
 * key, default 'off'). Status/broadcast messages are NOT touched here —
 * the status auto-view flow owns those receipts.
 */

const db = require('../../database');

const KEY = 'autoReadMode';
const MODES = ['off', 'all', 'contacts'];

const LABELS = {
    off: '❌ OFF — incoming messages are not auto-read',
    all: '✅ ALL — every incoming chat message is marked read',
    contacts: '👥 CONTACTS — only messages from known contacts are read',
};

/** Current persisted mode (always a valid value). */
function currentMode() {
    const value = db.getBotSetting(KEY);
    return MODES.includes(value) ? value : 'off';
}

/**
 * Pure gate — should this incoming message be auto-read?
 * Exported for index.js (and tests); no side effects.
 *
 *   - 'off'      → never
 *   - 'all'      → every normal chat message
 *   - 'contacts' → only when the sender resolves to a known contact
 * Never: own messages (fromMe), status@broadcast (the status auto-view
 * owns those receipts), newsletters, and protocol JIDs.
 */
function shouldAutoRead(mode, msg, isContact = () => true) {
    if (mode !== 'all' && mode !== 'contacts') return false;
    if (!msg || !msg.key || !msg.key.remoteJid) return false;
    const jid = String(msg.key.remoteJid);
    if (msg.key.fromMe) return false;
    if (jid === 'status@broadcast') return false; // status auto-view owns these
    if (jid.endsWith('@broadcast')) return true;  // broadcast lists: readable
    if (jid.endsWith('@newsletter')) return false;
    if (mode === 'all') return true;
    // contacts mode: private chats → the peer; groups → the sender
    const sender = jid.endsWith('@g.us') ? (msg.key.participant || null) : jid;
    if (!sender) return false;
    return Boolean(isContact(sender));
}

/**
 * Hook used by index.js on every incoming message. Reads the mode from
 * settings, applies the gate, and fire-and-forget marks the message read.
 * Never throws, never blocks message handling.
 */
async function readMessageIfEnabled(sock, msg) {
    try {
        const mode = currentMode();
        if (mode === 'off') return false;
        const contacts = sock?.contacts || {};
        const isContact = (jid) => {
            const bare = String(jid || '').split(':')[0];
            return Boolean(contacts[bare] || contacts[jid]);
        };
        if (!shouldAutoRead(mode, msg, isContact)) return false;
        await sock.readMessages([msg.key]);
        return true;
    } catch (_) {
        return false; // a failed read receipt must never break message flow
    }
}

module.exports = {
    name: 'autoread',
    aliases: ['read', 'autoreadmsgs'],
    category: 'owner',
    description: 'Auto-read incoming messages (off / all / contacts)',
    usage: '.autoread <off | all | contacts>',
    ownerOnly: true,
    adminOnly: false,
    groupOnly: false,
    botAdminOnly: false,

    async execute(sock, msg, args, extra) {
        try {
            const opt = (args[0] || '').toLowerCase();

            if (!opt) {
                return extra.reply(
                    `📖 *Auto Read*\n\n${LABELS[currentMode()]}\n\n` +
                    `*Options:*\n` +
                    `• \`.autoread off\` — disable (default)\n` +
                    `• \`.autoread all\` — read every incoming message\n` +
                    `• \`.autoread contacts\` — read known contacts only`
                );
            }

            if (!MODES.includes(opt)) {
                return extra.reply(`⚠️ Invalid option. Usage: \`.autoread <off | all | contacts>\``);
            }

            db.setBotSetting(KEY, opt);
            if (extra.react) await extra.react(opt === 'off' ? '❌' : '✅').catch(() => {});
            return extra.reply(`📖 *Auto Read updated*\n\n${LABELS[opt]}`);
        } catch (error) {
            console.error('[autoread]', error.message);
            if (extra.react) await extra.react('❌').catch(() => {});
            return extra.reply(`❌ AutoRead error: ${error.message}`);
        }
    },

    // Exposed for index.js and tests
    shouldAutoRead,
    readMessageIfEnabled,
    currentMode,
};
