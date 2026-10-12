/**
 * June-X Ultra — Web Chat server (utils/webChat.js)
 *
 * Attaches an owner-only chat page to the existing keep-alive Express server,
 * so you can read and send WhatsApp messages from a browser tab.
 *
 * Routes added:
 *   GET  /login          password login page                  (public)
 *   POST /login          password check → session cookie      (public)
 *   GET  /chat           chat UI                              (auth)
 *   GET  /api/status     connection status + logged-out flag  (auth)
 *   GET  /api/chats      recent chats (avatars, phonebook)    (auth)
 *   GET  /api/messages   messages for one chat + presence     (auth)
 *   GET  /api/search     full-text message search             (auth)
 *   GET  /api/media      download a media message             (auth)
 *   GET  /api/avatar     profile picture                      (auth)
 *   POST /api/send       send text or media (quoted replies)   (auth)
 *   POST /api/typing     "owner is typing…" presence          (auth)
 *   POST /api/react      add/remove an emoji reaction          (auth)
 *   POST /api/logout     end session                          (auth)
 *
 * Chat identity: a person's LID and PN jids are merged into one chat (the
 *   mapping is shared with the bot via utils/jidHelper.js).
 *
 * Auth: set WEB_PASSWORD in the environment. If it is not set, a random
 * password is generated at boot and printed once to the console — the chat
 * UI is never exposed without a password.
 *
 * Privacy: message bodies are never written to the console. Media is only
 * downloaded on demand, straight from the in-memory message store, and
 * cached briefly in memory (never written to disk).
 *
 * attachChatUI() returns a handle used by index.js to feed the module:
 *   { logMessage(msg), handlePresenceUpdate(id, presences),
 *     handleMessageUpdate(updates), handleReactions(list), handleReceiptUpdate(receipts),
 *     handleLidMapping(mapping) }
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const { spawn } = require('child_process');
const pollCrypto = require('./webChatPoll');
const { unwrapMessage, extractMedia, slimMessage, msgTs, STATUS, applyReaction, quotedDescriptor, editedTextFromProtocol, digits, protoTypeOf, secretEditOf, messageText, isSilentRow } = require('./webChatText');
const { decryptEdit, writeEditDebug } = require('./msgSecret');
const { proto: waProto } = require('@whiskeysockets/baileys');
const { createWebChatStore } = require('./webChatStore');

const PAGE_PATH = path.join(__dirname, 'webChatPage.html');
const SESSION_COOKIE = 'june_web_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;   // 12 h
const MAX_SESSIONS = 100;
const MAX_TEXT_LEN = 4000;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;     // decoded upload cap
const MAX_GROUP_NAME_FETCHES = 25;
const MEDIA_CACHE_TTL_MS = 30 * 60 * 1000;
const MEDIA_CACHE_MAX_ENTRIES = 100;
const MEDIA_CACHE_MAX_BYTES = 200 * 1024 * 1024;
const AVATAR_CACHE_TTL_MS = 60 * 60 * 1000;
const AVATAR_CACHE_MAX = 200;
const PRESENCE_TTL_MS = 20 * 1000;
const JID_RE = /^[0-9]{5,20}@(s\.whatsapp\.net|g\.us|lid|newsletter)$/;
const MSG_ID_RE = /^[A-Za-z0-9!#$%&'*+.^_|~=-]{1,128}$/;

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>June-X · Login</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: radial-gradient(circle at 20% 30%, #0a0f1e, #03060c);
    font-family: 'Inter', -apple-system, 'Segoe UI', system-ui, sans-serif;
    color: #e2f0ff; height: 100vh;
    display: flex; align-items: center; justify-content: center;
  }
  .card {
    background: rgba(10, 20, 28, 0.85);
    border: 1px solid rgba(0, 255, 224, 0.2);
    box-shadow: 0 0 15px rgba(0, 255, 224, 0.2), 0 8px 20px rgba(0,0,0,0.2);
    padding: 2rem; width: 90%; max-width: 360px; text-align: center;
  }
  .brand {
    font-family: 'JetBrains Mono', monospace; font-weight: 700; font-size: 1.4rem;
    background: linear-gradient(135deg, #00ffe0, #ff6b35);
    -webkit-background-clip: text; background-clip: text; color: transparent;
    margin-bottom: 1.5rem;
  }
  input {
    width: 100%; padding: 0.7rem 0.9rem; margin-bottom: 0.8rem;
    background: rgba(0,0,0,0.35); border: 1px solid rgba(0,255,224,0.25);
    color: #e2f0ff; font-size: 0.95rem; outline: none; border-radius: 2px;
  }
  input:focus { border-color: #00ffe0; }
  button {
    width: 100%; padding: 0.7rem; cursor: pointer;
    background: rgba(0,255,224,0.12); color: #00ffe0;
    border: 1px solid rgba(0,255,224,0.4);
    font-size: 0.85rem; letter-spacing: 2px; text-transform: uppercase;
  }
  button:hover { background: rgba(0,255,224,0.22); }
  #err { color: #e94560; font-size: 0.8rem; min-height: 1.2rem; margin-top: 0.6rem; }
</style>
</head>
<body>
  <form class="card" id="form">
    <div class="brand">June-X</div>
    <input id="pw" type="password" placeholder="web password" autocomplete="current-password" autofocus>
    <button type="submit">enter</button>
    <div id="err"></div>
  </form>
<script>
document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  err.textContent = '';
  try {
    const r = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('pw').value })
    });
    if (r.ok) { window.location = '/chat'; return; }
    err.textContent = 'wrong password';
  } catch (_) {
    err.textContent = 'network error';
  }
});
</script>
</body>
</html>`;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCookies(req) {
    const out = {};
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
        const i = part.indexOf('=');
        if (i === -1) continue;
        const key = part.slice(0, i).trim();
        if (!key) continue;
        const val = part.slice(i + 1).trim();
        try { out[key] = decodeURIComponent(val); } catch (_) { out[key] = val; }
    }
    return out;
}

function withTimeout(promise, ms) {
    return Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => {
            const t = setTimeout(() => reject(new Error('timeout')), ms);
            t.unref?.();
        }),
    ]);
}

// Lazy require: Baileys is already loaded by index.js in production, and this
// keeps the module loadable in tests without the full Baileys dependency tree.
async function defaultDownloadMedia(content, kind) {
    const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
    const stream = await downloadContentFromMessage(content, kind);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

const MAX_VOICE_BYTES = 10 * 1024 * 1024;

// Run ffmpeg with stdin input and return its stdout. The binary is resolved
// by utils/ffmpegPath.js (system ffmpeg first, then the runtime-provisioned one).
function runFfmpeg(args, input) {
    return new Promise((resolve, reject) => {
        let bin = 'ffmpeg';
        try { bin = require('./ffmpegPath')() || 'ffmpeg'; } catch (_) {}
        const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        const out = [];
        let errText = '';
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (_) {}
            reject(new Error('audio conversion timed out'));
        }, 30000);
        child.stdout.on('data', (d) => out.push(d));
        child.stderr.on('data', (d) => { if (errText.length < 2000) errText += d.toString(); });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(Buffer.concat(out));
            else reject(new Error('ffmpeg failed: ' + errText.slice(-200)));
        });
        child.stdin.on('error', () => {});
        child.stdin.end(input);
    });
}

// Browser recording (webm/opus, mp4, ...) -> WhatsApp voice format (mono OGG/Opus)
// plus 16 kHz mono PCM for duration and waveform analysis.
async function defaultConvertAudio(buf) {
    const base = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1'];
    const opus = await runFfmpeg([...base, '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1'], buf);
    const pcm = await runFfmpeg([...base, '-ar', '16000', '-f', 's16le', 'pipe:1'], buf);
    return { opus, pcm };
}

// 64 bars, each the peak amplitude of its slice, scaled to WhatsApp's 0–99.
function waveformFromPcm(pcm, bars = 64) {
    const out = new Uint8Array(bars);
    const samples = Math.floor(pcm.length / 2);
    if (!samples) return out;
    const per = Math.max(1, Math.floor(samples / bars));
    for (let b = 0; b < bars; b++) {
        let peak = 0;
        const end = Math.min(samples, b * per + per);
        for (let i = b * per; i < end; i++) {
            const v = Math.abs(pcm.readInt16LE(i * 2));
            if (v > peak) peak = v;
        }
        out[b] = Math.min(99, Math.round((peak / 32768) * 99));
    }
    return out;
}

// Voice note = PTT audio with duration + waveform. Built the same way the
// Baileys voice-note guide describes: prepare the upload, patch the
// AudioMessage, generate the message and relay it (a plain sendMessage with
// ptt renders the waveform as a flat line on some clients).
async function defaultSendVoice(sock, jid, opus, { seconds, waveform, quoted }) {
    const baileys = require('@whiskeysockets/baileys');
    const media = await baileys.prepareWAMessageMedia(
        { audio: opus, mimetype: 'audio/ogg; codecs=opus', ptt: true },
        { upload: sock.waUploadToServer }
    );
    const audioMessage = {
        ...media.audioMessage,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
        seconds,
        waveform,
    };
    const msg = baileys.generateWAMessageFromContent(jid, { audioMessage }, {
        userJid: sock.user.id,
        ...(quoted ? { quoted } : {}),
    });
    await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
    return msg;
}

function defaultMsgId(sock) {
    try {
        return require('@whiskeysockets/baileys').generateMessageIDV2(sock?.user?.id);
    } catch (_) {
        return crypto.randomBytes(10).toString('hex').toUpperCase();
    }
}

/**
 * Send a buffer honouring HTTP Range requests. Audio/video players (iOS Safari
 * in particular) need 206 partial responses to seek and to learn the duration;
 * without them voice-note progress bars stay stuck.
 */
function sendWithRange(req, res, buf) {
    const total = buf.length;
    res.setHeader('Accept-Ranges', 'bytes');
    const header = req.headers.range;
    if (!header) {
        res.setHeader('Content-Length', total);
        return res.end(buf);
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
    if (!m || (m[1] === '' && m[2] === '')) {
        res.setHeader('Content-Range', `bytes */${total}`);
        return res.status(416).end();
    }
    let start;
    let end;
    if (m[1] === '') {                       // suffix: last N bytes
        const n = Number(m[2]);
        start = Math.max(0, total - n);
        end = total - 1;
    } else {
        start = Number(m[1]);
        end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
    }
    if (total === 0 || start >= total || start > end) {
        res.setHeader('Content-Range', `bytes */${total}`);
        return res.status(416).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', end - start + 1);
    return res.end(buf.subarray(start, end + 1));
}

function attachChatUI(app, deps) {
    const getSock = deps.getSock || (() => global.currentSock || null);
    const getBotState = deps.getBotState || (() => global.botState || 'unknown');
    const store = deps.store || null;
    const log = deps.log || console.log;
    const downloadMedia = deps.downloadMedia || defaultDownloadMedia;
    const convertAudio = deps.convertAudio || defaultConvertAudio;
    const sendVoice = deps.sendVoice || defaultSendVoice;
    const newMsgId = deps.newMsgId || defaultMsgId;

    const chatStore = deps.chatStore || createWebChatStore({
        dbPath: path.join(__dirname, '..', 'database', 'webchat.db'),
        phonebookPath: path.join(__dirname, '..', 'database', 'webchat-phonebook.json'),
    });

    // LID ↔ PN identity map. WhatsApp is moving DMs to LID addressing, so one
    // person can appear as both 234…@s.whatsapp.net and 711…@lid. The bot
    // already keeps this mapping (utils/jidHelper.js → SQLite lid_map, shared
    // with every command); reuse it instead of keeping a second copy. Tests
    // inject a lightweight in-memory jidMap with the same interface.
    let jidMap = deps.jidMap || null;
    function getJidMap() {
        if (jidMap) return jidMap;
        const helper = require('./jidHelper');
        const isLid = (j) => helper.isLidJid(j);
        const isPn = (j) => helper.isPnJid(j);
        jidMap = {
            link(a, b) {
                try {
                    let lid = null, pn = null;
                    if (isLid(a) && isPn(b)) { lid = a; pn = b; }
                    else if (isLid(b) && isPn(a)) { lid = b; pn = a; }
                    else return;
                    helper.rememberLidMapping(lid, pn);
                } catch (_) {}
            },
            pnForLid(lid) {
                try {
                    const pn = helper.normalizeJidWithLid(String(lid));
                    return pn && isPn(pn) ? pn : null;
                } catch (_) { return null; }
            },
            lidForPn(pn) {
                try {
                    const user = helper.jidUser(pn);
                    const lidUser = user && helper.getLidMappingValue(user, 'pnToLid');
                    return lidUser ? `${lidUser}@lid` : null;
                } catch (_) { return null; }
            },
            canonical(jid) {
                const j = String(jid || '');
                if (isLid(j)) return this.pnForLid(j) || j;
                return j;
            },
            related(jid) {
                const j = String(jid || '');
                const out = [j];
                try {
                    if (isLid(j)) { const pn = this.pnForLid(j); if (pn) out.push(pn); }
                    else if (isPn(j)) { const lid = this.lidForPn(j); if (lid) out.push(lid); }
                } catch (_) {}
                return out;
            },
            async enrich(jid, sock) {
                // Best-effort live lookup in Baileys' signal store; persists
                // into the shared lid_map so the whole bot benefits.
                try {
                    const j = String(jid || '');
                    if (isLid(j)) { await helper.resolvePhone(sock, j); return; }
                    const lm = sock?.signalRepository?.lidMapping;
                    if (isPn(j) && lm && typeof lm.getLIDForPN === 'function') {
                        const lid = await lm.getLIDForPN(j);
                        if (lid) this.link(lid, j);
                    }
                } catch (_) {}
            },
        };
        return jidMap;
    }

    // Password: WEB_PASSWORD env var, otherwise a random one printed once.
    let webPassword = process.env.WEB_PASSWORD ? String(process.env.WEB_PASSWORD) : null;
    if (!webPassword) {
        webPassword = crypto.randomBytes(5).toString('hex');
        log(`[ WEB ] Chat UI ready at /chat — WEB_PASSWORD not set, using generated password: ${webPassword}`, 'yellow');
    } else {
        log('[ WEB ] Chat UI ready at /chat (password from WEB_PASSWORD)', 'cyan');
    }

    const sessions = new Map();    // token -> expiry ts
    const groupNames = new Map();  // groupJid -> subject
    const presenceMap = new Map(); // jid -> { presence, ts }
    const lastSeenMap = new Map(); // jid -> ms timestamp (WhatsApp "last seen")
    const subscribed = new Map();  // jid -> ts of last presenceSubscribe
    const mediaCache = new Map();  // `${jid}|${msgId}` -> { buf, mime, fileName, kind, size, ts }
    let mediaCacheBytes = 0;
    const avatarCache = new Map(); // jid -> { buf, mime, ts }
    const jsonParser = express.json({ limit: '64kb' });
    const sendParser = express.json({ limit: '25mb' }); // room for base64 media
    const readMarked = new Set(); // `${jid}|${msgId}` already sent read receipts this session

    // Expire old sessions periodically.
    setInterval(() => {
        const now = Date.now();
        for (const [token, exp] of sessions) if (exp <= now) sessions.delete(token);
    }, 10 * 60 * 1000).unref?.();

    function requireAuth(req, res, next) {
        const token = parseCookies(req)[SESSION_COOKIE];
        const exp = token ? sessions.get(token) : null;
        if (exp && exp > Date.now()) return next();
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ ok: false, error: 'unauthorized' });
        }
        return res.redirect('/login');
    }

    function issueSession(res) {
        if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
        const token = crypto.randomBytes(24).toString('hex');
        sessions.set(token, Date.now() + SESSION_TTL_MS);
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`);
    }

    function serveChatPage(req, res) {
        fs.readFile(PAGE_PATH, 'utf8', (err, html) => {
            if (err) return res.status(500).send('webChatPage.html is missing');
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.send(html);
        });
    }

    // Group subjects are fetched in the background so /api/chats never blocks.
    function refreshGroupNames(chats) {
        const sock = getSock();
        if (!sock || typeof sock.groupMetadata !== 'function') return;
        for (const c of chats) {
            if (!c?.jid || !c.isGroup || groupNames.has(c.jid)) continue;
            Promise.resolve()
                .then(() => withTimeout(sock.groupMetadata(c.jid), 4000))
                .then((meta) => {
                    if (meta?.subject) {
                        if (groupNames.size > 500) groupNames.delete(groupNames.keys().next().value);
                        groupNames.set(c.jid, meta.subject);
                    }
                })
                .catch(() => {});
        }
    }

    /* ── presence (typing indicators) ───────────────────────────────────── */

    function handlePresenceUpdate(id, presences) {
        try {
            if (!id || !presences) return;
            let anyComposing = false;
            for (const [jid, data] of Object.entries(presences)) {
                const last = data?.lastKnownPresence;
                if (!last) continue;
                presenceMap.set(jid, { presence: last, ts: Date.now() });
                if (data.lastSeen) lastSeenMap.set(jid, Number(data.lastSeen) * 1000);
                if (last === 'composing') anyComposing = true;
            }
            // For groups, expose a chat-level indicator: composing if anyone is.
            if (String(id).endsWith('@g.us')) {
                presenceMap.set(id, { presence: anyComposing ? 'composing' : 'paused', ts: Date.now() });
            }
        } catch (_) {}
    }

    function getPresence(jid) {
        const p = presenceMap.get(jid);
        if (!p) return null;
        if (Date.now() - p.ts > PRESENCE_TTL_MS) {
            presenceMap.delete(jid);
            return null;
        }
        return p.presence;
    }

    /* ── message status (ticks), reactions, read receipts ───────────────── */

    // Opening a chat marks its incoming messages read → the sender's app
    // shows blue ticks. Keys are deduped for the lifetime of this session.
    function markChatRead(jid, msgs) {
        try {
            // Read state is keyed by the canonical chat so LID/PN twins share it.
            chatStore.setRead(getJidMap().canonical(jid), Date.now());
            const sock = getSock();
            if (!sock || typeof sock.readMessages !== 'function') return;
            if (readMarked.size > 5000) readMarked.clear();
            const keys = [];
            for (const m of msgs) {
                if (!m?.key || m.key.fromMe || m.message?.reactionMessage) continue;
                const k = `${m.key.remoteJid}|${m.key.id}`;
                if (readMarked.has(k)) continue;
                readMarked.add(k);
                keys.push(m.key);
                if (keys.length >= 50) break;
            }
            if (keys.length) Promise.resolve(sock.readMessages(keys)).catch(() => {});
        } catch (_) {}
    }

    // Messages often carry the chat's other address (LID ↔ PN) — learn it.
    function linkKey(key) {
        try {
            if (key?.remoteJid && key?.remoteJidAlt) getJidMap().link(key.remoteJid, key.remoteJidAlt);
        } catch (_) {}
    }

    function reactionSender(stanzaKey) {
        if (!stanzaKey) return 'unknown';
        if (stanzaKey.participant) return stanzaKey.participant;
        if (stanzaKey.fromMe) return 'me';
        return stanzaKey.remoteJid || 'unknown';
    }

    function applyReactionUpdate(chatJid, msgId, emoji, sender) {
        const meta = chatStore.getMsgMeta(chatJid, msgId) || {};
        const reactions = applyReaction(meta.reactions, emoji, sender);
        chatStore.setMsgMeta(chatJid, msgId, { reactions });
        return reactions;
    }

    // messages.update — delivery/read receipts (ticks); some builds also
    // deliver reactions or poll votes through here.
    function handleMessageUpdate(updates) {
        try {
            for (const { key, update } of updates || []) {
                if (!key?.id || !key?.remoteJid) continue;
                linkKey(key);
                const chatJid = canonicalChat(key.remoteJid);
                const msgId = String(key.id);
                if (typeof update?.status === 'number') {
                    chatStore.setMsgMeta(chatJid, msgId, { status: update.status });
                }
                if (Array.isArray(update?.reactions)) {
                    for (const r of update.reactions) {
                        applyReactionUpdate(chatJid, msgId, r?.text || '', reactionSender(r?.key));
                    }
                } else if (update?.reaction && typeof update.reaction === 'object') {
                    const r = update.reaction;
                    applyReactionUpdate(chatJid, msgId, r.text || '', reactionSender(r.key || key));
                }
            }
        } catch (_) {}
    }

    // messages.reaction — Baileys emits { key: reactedToKey, reaction: { ...reactionMessage, key: stanzaKey } }.
    // reaction.text is the emoji (empty = removed); reaction.key identifies the reactor.
    function handleReactions(list) {
        try {
            for (const item of list || []) {
                const reactedTo = item?.key;
                const reaction = item?.reaction || {};
                if (!reactedTo?.id || !reactedTo?.remoteJid) continue;
                linkKey(reactedTo);
                linkKey(reaction?.key);
                // Same canonical chat address as the message rows (a contact may be addressed by LID).
                applyReactionUpdate(
                    canonicalChat(reactedTo.remoteJid),
                    String(reactedTo.id),
                    typeof reaction.text === 'string' ? reaction.text : '',
                    reactionSender(reaction.key)
                );
            }
        } catch (_) {}
    }

    // message-receipt.update — per-participant receipts (this is how group
    // messages get ticks; messages.update carries no status for groups).
    function handleReceiptUpdate(receipts) {
        try {
            for (const { key, receipt } of receipts || []) {
                if (!key?.id || !key?.remoteJid || !key?.fromMe) continue;
                const type = receipt?.type;
                const status = (type === 'read' || type === 'read-self' || type === 'played')
                    ? STATUS.READ
                    : STATUS.DELIVERY_ACK;
                chatStore.setMsgMeta(canonicalChat(key.remoteJid), String(key.id), { status });
            }
        } catch (_) {}
    }

    // lid-mapping.update — Baileys reports { pn, lid } for one person.
    // Saved contact names from the address book. LID entries are stored under their phone number.
    // Counts only (no names or numbers) so the log shows what WhatsApp sent after a link.
    function logContactStats(source, list) {
        try {
            const arr = Array.isArray(list) ? list : [];
            let withName = 0, withNotify = 0, withLid = 0;
            for (const c of arr) {
                if (c?.name) withName++;
                if (c?.notify) withNotify++;
                if (c?.lid) withLid++;
            }
            log(`[webchat] contacts (${source}): ${arr.length} entries, ${withName} with saved name, ${withNotify} with notify, ${withLid} with lid`);
        } catch (_) {}
    }

    // Push names (c.notify) are what a person sets for themselves. They are used only when no
    // saved name is known, and are kept apart from the phonebook.
    const notifyNames = new Map();  // canonical jid -> push name

    function handleContacts(list, source) {
        if (source) logContactStats(source, list);
        try {
            for (const c of (Array.isArray(list) ? list : [])) {
                const name = c?.name;
                // A contact can arrive under its LID, its phone number, or both. Save the name
                // under every address we know, so the chat shows it whichever address it uses.
                const addresses = new Set();
                for (const raw of [c?.id, c?.lid, c?.phoneNumber]) {
                    const j = String(raw || '');
                    if (!/@(s\.whatsapp\.net|lid)$/.test(j)) continue;
                    addresses.add(j);
                    addresses.add(getJidMap().canonical(j));
                }
                if (name) {
                    for (const j of addresses) chatStore.setContactName(j, name);
                } else if (typeof c?.notify === 'string' && c.notify.trim()) {
                    for (const j of addresses) notifyNames.set(j, c.notify.trim());
                }
            }
        } catch (_) {}
    }

    // Full history from WhatsApp (sent once after linking): chats, contacts and messages.
    function handleHistorySync(payload) {
        try {
            const { chats = [], contacts = [], messages = [] } = payload || {};
            const chatsWithName = (Array.isArray(chats) ? chats : []).filter((c) => c?.name && c?.id && !String(c.id).endsWith('@g.us') && !String(c.id).endsWith('@newsletter')).length;
            log(`[webchat] history sync: ${chats.length} chats (${chatsWithName} individual chats with saved name), ${contacts.length} contacts, ${messages.length} messages`);
            handleContacts(contacts, 'history');
            for (const c of (Array.isArray(chats) ? chats : [])) {
                if (!c?.id || !c.name) continue;
                if (String(c.id).endsWith('@g.us')) groupNames.set(getJidMap().canonical(String(c.id)), c.name);
                else if (String(c.id).endsWith('@newsletter')) channelNames.set(String(c.id), c.name);
                else handleContacts([{ id: c.id, name: c.name }]);
            }
            // History is not unread. A chat with no read point yet is marked read at the
            // newest imported message, so only messages that arrive after this count.
            const newest = new Map();
            for (const m of (Array.isArray(messages) ? messages : [])) {
                if (!m?.key) continue;
                logMessage(m);
                const canon = getJidMap().canonical(String(m.key.remoteJid || ''));
                if (canon) newest.set(canon, Math.max(newest.get(canon) || 0, msgTs(m) || 0));
            }
            for (const [canon, ts] of newest) {
                if (ts && chatStore.getRead(canon) === 0) chatStore.setRead(canon, ts);
            }
        } catch (_) {}
    }

    function handleLidMapping(mapping) {
        try {
            if (!mapping) return;
            let pn = mapping.pn || mapping.pnJid || null;
            let lid = mapping.lid || mapping.lidJid || null;
            if (!pn || !lid) return;
            if (!String(pn).includes('@')) pn = `${pn}@s.whatsapp.net`;
            if (!String(lid).includes('@')) lid = `${lid}@lid`;
            getJidMap().link(lid, pn);
        } catch (_) {}
    }

    /* ── media cache (in-memory only, bounded) ──────────────────────────── */

    function cacheMedia(key, entry) {
        if (mediaCache.has(key)) {
            mediaCacheBytes -= mediaCache.get(key).size;
            mediaCache.delete(key);
        }
        mediaCache.set(key, entry);
        mediaCacheBytes += entry.size;
        while (mediaCache.size > MEDIA_CACHE_MAX_ENTRIES || mediaCacheBytes > MEDIA_CACHE_MAX_BYTES) {
            const oldestKey = mediaCache.keys().next().value;
            const old = mediaCache.get(oldestKey);
            if (!old) break;
            mediaCacheBytes -= old.size;
            mediaCache.delete(oldestKey);
        }
    }

    async function resolveMedia(jid, msgId) {
        let msg = store?.messages?.get(jid)?.get(msgId);
        // Fall back to the saved body when the recent store no longer has the message.
        if (!msg) msg = chatStore.getRaw(jid, msgId);
        if (!msg) return { error: 404, message: 'message not in recent store (media expired)' };
        const media = extractMedia(unwrapMessage(msg.message || {}));
        if (!media) return { error: 400, message: 'not a media message' };
        const key = `${jid}|${msgId}`;
        const cached = mediaCache.get(key);
        if (cached && Date.now() - cached.ts < MEDIA_CACHE_TTL_MS) {
            return { buf: cached.buf, mime: cached.mime, fileName: cached.fileName, kind: cached.kind };
        }
        const buf = await downloadMedia(media.content, media.kind);
        // WhatsApp voice notes are Ogg/Opus, which iPhone Safari cannot play (the player spins forever).
        // Convert them to MP3 for the browser. If conversion fails, serve the original file.
        let playBuf = buf, playMime = media.mime;
        if (media.kind === 'audio' && /ogg|opus/i.test(media.mime || '')) {
            try {
                playBuf = await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-codec:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', 'pipe:1'], buf);
                playMime = 'audio/mpeg';
            } catch (_) {
                playBuf = buf; playMime = media.mime;
            }
        }
        const entry = { buf: playBuf, mime: playMime, fileName: media.fileName, kind: media.kind, size: playBuf.length, ts: Date.now() };
        cacheMedia(key, entry);
        return { buf: entry.buf, mime: entry.mime, fileName: entry.fileName, kind: entry.kind };
    }

    /* ── avatars ────────────────────────────────────────────────────────── */

    async function resolveAvatar(jid) {
        const cached = avatarCache.get(jid);
        if (cached && Date.now() - cached.ts < AVATAR_CACHE_TTL_MS) return cached;
        const sock = getSock();
        if (!sock || typeof sock.profilePictureUrl !== 'function') return null;
        const chanMeta = jid.endsWith('@newsletter') ? await loadChannelMeta(jid) : null;
        const url = chanMeta?.pictureUrl || await sock.profilePictureUrl(jid, 'image');
        if (!url) return null;
        const resp = await withTimeout(fetch(url), 8000);
        if (!resp.ok) return null;
        const buf = Buffer.from(await resp.arrayBuffer());
        if (!buf.length) return null;
        const entry = { buf, mime: resp.headers.get('content-type') || 'image/jpeg', ts: Date.now() };
        if (avatarCache.size >= AVATAR_CACHE_MAX) avatarCache.delete(avatarCache.keys().next().value);
        avatarCache.set(jid, entry);
        return entry;
    }

    /* ── shared name resolution ─────────────────────────────────────────── */

    // The owner's own chat is labelled with the owner's profile name plus "(You)",
    // like WhatsApp does. Baileys fills creds.me.name from the owner's own messages.
    function ownChatLabel(canon) {
        try {
            const me = getSock()?.authState?.creds?.me;
            const users = [me?.id, me?.lid].map((j) => String(j || '').split(':')[0].split('@')[0]).filter(Boolean);
            const user = String(canon || '').split(':')[0].split('@')[0];
            if (!user || !users.includes(user)) return null;
            if (!/@(s\.whatsapp\.net|lid)$/.test(String(canon))) return null;
            const name = typeof me?.name === 'string' ? me.name.trim() : '';
            return name && name !== '~' ? `${name} (You)` : 'You';
        } catch (_) { return null; }
    }

    function chatDisplayName(jid, lastMsg) {
        const canon = getJidMap().canonical(jid);
        if (canon.endsWith('@g.us')) return groupNames.get(canon) || null;
        const own = ownChatLabel(canon);
        if (own) return own;
        // lastMsg must be the other side's message: our own pushName is our name, not theirs.
        return chatStore.phonebookName(canon) || notifyNames.get(canon) || lastMsg?.pushName || null;
    }

    /* ── public: login ────────────────────────────────────────────────────── */

    app.get('/login', (req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(LOGIN_PAGE);
    });

    app.post('/login', jsonParser, async (req, res) => {
        await delay(400); // blunt brute-force attempts
        const { password } = req.body || {};
        const ok = typeof password === 'string' &&
            password.length === webPassword.length &&
            crypto.timingSafeEqual(Buffer.from(password), Buffer.from(webPassword));
        if (!ok) {
            log(`[ WEB ] Failed web login attempt from ${req.ip || 'unknown'}`, 'yellow');
            return res.status(401).json({ ok: false, error: 'wrong password' });
        }
        issueSession(res);
        log(`[ WEB ] Web login from ${req.ip || 'unknown'}`, 'green');
        res.json({ ok: true });
    });

    /* ── authed: page & API ───────────────────────────────────────────────── */

    app.get('/chat', requireAuth, serveChatPage);

    app.get('/api/status', requireAuth, (req, res) => {
        const sock = getSock();
        res.json({
            ok: true,
            botState: getBotState(),
            loggedOut: deps.getLoggedOut ? deps.getLoggedOut() : (global.juneLoggedOut === true),
            number: sock?.user?.id ? String(sock.user.id).split(':')[0] : null,
            uptimeSeconds: Math.floor(process.uptime()),
            storedChats: store?.messages?.size || 0,
        });
    });

    /* ── Updates: statuses (24h) and channels ──────────────────────────── */
    const STATUS_WINDOW_MS = 24 * 60 * 60 * 1000;
    const channelNames = new Map();
    // Channel name and picture from WhatsApp, cached for an hour.
    const channelMeta = new Map();
    async function loadChannelMeta(jid) {
        const cached = channelMeta.get(jid);
        if (cached && Date.now() - cached.ts < 60 * 60 * 1000) return cached;
        const entry = { name: '', pictureUrl: '', ts: Date.now() };
        const sock = getSock();
        if (sock && typeof sock.newsletterMetadata === 'function') {
            let meta = null;
            try { meta = await withTimeout(sock.newsletterMetadata('jid', jid), 4000); }
            catch (_) {
                try { meta = await withTimeout(sock.newsletterMetadata(jid), 4000); } catch (_) {}
            }
            // rc14 returns either the parsed shape (name, picture.directPath) or the raw
            // WhatsApp shape (thread_metadata.name.text, thread_metadata.picture.direct_path).
            const tm = meta?.thread_metadata || {};
            const nm = meta?.name ?? tm?.name?.text;
            entry.name = typeof nm === 'string' ? nm : '';
            const dp = meta?.picture?.directPath ?? tm?.picture?.direct_path;
            entry.pictureUrl = typeof dp === 'string' && dp.startsWith('/') ? 'https://pps.whatsapp.net' + dp : '';
        }
        channelMeta.set(jid, entry);
        return entry;
    }
    const statusNameFor = (sender, pushName) =>
        chatStore.phonebookName(sender) || pushName || String(sender || '').split('@')[0];

    app.get('/api/updates', requireAuth, async (req, res) => {
        const since = Date.now() - STATUS_WINDOW_MS;
        const statuses = chatStore.statusPosters(since).map((p) => {
            const read = chatStore.getRead('status:' + p.sender);
            return {
                sender: p.sender,
                name: statusNameFor(p.sender, p.pushName),
                count: p.count,
                lastTs: p.lastTs,
                unread: chatStore.countStatusesSince(p.sender, Math.max(read, since)),
            };
        });
        const channels = await Promise.all(chatStore.channelList(100).map(async (c) => {
            const last = chatStore.pageBefore([c.jid], Number.MAX_SAFE_INTEGER, 1)[0];
            const meta = await loadChannelMeta(c.jid);
            return {
                jid: c.jid,
                name: meta.name || channelNames.get(c.jid) || c.jid.split('@')[0],
                lastTs: c.lastTs,
                preview: String(last?.text || '').slice(0, 100),
                unread: chatStore.countSince([c.jid], chatStore.getRead(c.jid)),
            };
        }));
        res.json({ ok: true, statuses, channels });
    });

    app.get('/api/updates/status', requireAuth, (req, res) => {
        const sender = String(req.query.sender || '');
        if (!JID_RE.test(sender)) return res.status(400).json({ ok: false, error: 'invalid sender' });
        const items = chatStore.statusItems(sender, Date.now() - STATUS_WINDOW_MS);
        res.json({
            ok: true, sender,
            name: statusNameFor(sender, items[items.length - 1]?.pushName),
            items: items.map((i) => ({ id: i.id, text: i.text, ts: i.ts })),
        });
    });

    app.post('/api/updates/viewed', requireAuth, jsonParser, async (req, res) => {
        const { sender } = req.body || {};
        if (typeof sender !== 'string' || !JID_RE.test(sender)) {
            return res.status(400).json({ ok: false, error: 'invalid sender' });
        }
        const since = Date.now() - STATUS_WINDOW_MS;
        const items = chatStore.statusItems(sender, Math.max(chatStore.getRead('status:' + sender), since));
        chatStore.setRead('status:' + sender, Date.now());
        try {
            const sock = getSock();
            if (sock && items.length && typeof sock.readMessages === 'function') {
                // WhatsApp shows the poster that they were viewed, as WhatsApp Web does.
                await sock.readMessages(items.slice(-50).map((i) => ({
                    remoteJid: 'status@broadcast', id: i.id, participant: sender, fromMe: false,
                })));
            }
        } catch (_) {}
        res.json({ ok: true, viewed: items.length });
    });

    app.get('/api/chats', requireAuth, (req, res) => {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
        const byJid = store?.messages;
        const merged = new Map(); // canonical jid → one chat entry
        if (byJid) {
            for (const [jid, msgs] of byJid) {
                if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter') || !msgs || msgs.size === 0) continue;
                const canon = getJidMap().canonical(jid);
                const isGroup = jid.endsWith('@g.us');
                const lastRead = chatStore.getRead(canon);
                let last = null, unread = 0, count = 0;
                let lastIn = null;
                for (const m of msgs.values()) {
                    if (!m?.key || m.message?.reactionMessage) continue; // reactions aren't previews
                    if (isSilentRow(m)) continue; // protocol rows are not shown
                    count++;
                    last = m; // insertion order → last non-reaction is newest
                    if (!m.key.fromMe) lastIn = m;
                    if (!m.key.fromMe && msgTs(m) > lastRead) unread++;
                }
                if (!last) continue;
                const name = chatDisplayName(jid, lastIn) || jid.split('@')[0];
                const lastTs = last.messageTimestamp ? Number(last.messageTimestamp) * 1000 : null;
                const preview = String(slimMessage(last).text || '').slice(0, 100);
                const existing = merged.get(canon);
                if (!existing) {
                    merged.set(canon, {
                        jid: canon,
                        isGroup,
                        name,
                        number: canon.split('@')[0],
                        preview,
                        lastTs,
                        count,
                        unread,
                    });
                    continue;
                }
                // Same person under two addresses (LID ↔ PN) — merge the buckets.
                if ((existing.lastTs || 0) < (lastTs || 0)) {
                    existing.preview = preview;
                    existing.lastTs = lastTs;
                }
                existing.count += count;
                existing.unread += unread;
                // Prefer a real name over a bare number.
                if (existing.name === existing.number && name !== existing.number) existing.name = name;
            }
        }
        // Chats that only exist in the SQLite index (memory is empty after a restart).
        for (const row of chatStore.latestPerChat(200)) {
            const canon = getJidMap().canonical(row.chatJid);
            if (!canon || canon === 'status@broadcast' || merged.has(canon)) continue;
            const isGroup = canon.endsWith('@g.us');
            const lastRead = chatStore.getRead(canon);
            const jids = getJidMap().related(canon);
            const name = chatDisplayName(canon, { pushName: chatStore.lastIncomingName(jids) }) || canon.split('@')[0];
            merged.set(canon, {
                jid: canon,
                isGroup,
                name,
                number: canon.split('@')[0],
                preview: String(row.text || '').slice(0, 100),
                lastTs: row.ts || null,
                count: 0,
                unread: row.fromMe ? 0 : chatStore.countSince(jids, lastRead),
            });
        }
        const chats = Array.from(merged.values()).map((c) => {
            const manual = chatStore.getFlag(c.jid, 'manual_unread');
            return {
                ...c,
                archived: chatStore.isArchived(c.jid),
                pinned: chatStore.getFlag(c.jid, 'pinned'),
                manualUnread: manual,
                unread: c.unread > 0 ? c.unread : (manual ? 1 : 0),
            };
        });
        chats.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || ((b.lastTs || 0) - (a.lastTs || 0)));
        refreshGroupNames(chats.slice(0, MAX_GROUP_NAME_FETCHES));
        res.json({ ok: true, chats: chats.slice(0, limit) });
    });

    // Presence can arrive under either address of a chat — check them all.
    function getPresenceAny(jids) {
        for (const j of jids) {
            const p = getPresence(j);
            if (p) return p;
        }
        return null;
    }

    function lastSeenAny(jids) {
        let best = null;
        for (const j of jids) {
            const v = lastSeenMap.get(j);
            if (v && (!best || v > best)) best = v;
        }
        return best;
    }

    // Ask WhatsApp to keep us subscribed to a chat's presence (last seen,
    // typing, recording). Re-subscribe at most every 10 minutes.
    function subscribePresence(jid) {
        const now = Date.now();
        if ((subscribed.get(jid) || 0) > now - 10 * 60 * 1000) return;
        subscribed.set(jid, now);
        const sock = getSock();
        if (sock && typeof sock.presenceSubscribe === 'function') {
            Promise.resolve().then(() => sock.presenceSubscribe(jid)).catch(() => {});
        }
    }

    // A message row rebuilt from SQLite (after a restart, or older history). When the saved
    // message body exists, rebuild the full DTO so media, quotes and polls still show.
    function dbRowToDto(r, meta, mine) {
        const raw = r.chatJid ? chatStore.getRaw(r.chatJid, r.id) : null;
        if (raw) return slimMessage(raw, meta, mine);
        return {
            ...r, chatJid: undefined, media: null, status: meta.status ?? null,
            // Stored reactions are { emoji, senders }; the page expects { emoji, count, byMe }.
            reactions: (meta.reactions || []).map((x) => ({
                emoji: x.emoji, count: (x.senders || []).length, byMe: (x.senders || []).includes('me'),
            })),
            quoted: meta.quoted || null, edited: !!meta.edited, deleted: false,
            mentions: [], forwarded: false, poll: null,
        };
    }

    app.get('/api/messages', requireAuth, async (req, res) => {
        const jid = String(req.query.jid || '');
        if (!JID_RE.test(jid)) {
            return res.status(400).json({ ok: false, error: 'invalid jid' });
        }
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
        // LID ↔ PN: one person can chat under both addresses. Best-effort
        // live lookup, then merge every bucket that maps to this chat.
        // The lookup can take up to 1.5s; never make a poll wait longer than 150ms for it.
        await Promise.race([
            withTimeout(getJidMap().enrich(jid, getSock()), 1500).catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, 150)),
        ]);
        subscribePresence(jid);
        const jids = getJidMap().related(jid);

        // Infinite scroll: older history from the SQLite index.
        const before = Number(req.query.before) || 0;
        const beforeId = MSG_ID_RE.test(String(req.query.beforeId || '')) ? String(req.query.beforeId) : '';
        if (before) {
            // Ask for one extra row: it tells us exactly whether older history exists.
            const rows = chatStore.pageBefore(jids, before, limit + 1, beforeId);
            const hasMore = rows.length > limit;
            const page = hasMore ? rows.slice(rows.length - limit) : rows;
            const mineOld = myDigits();
            return res.json({
                ok: true, jid, history: true, hasMore,
                messages: page.map((r) => dbRowToDto(r, {}, mineOld)),
            });
        }

        const byId = new Map();
        for (const j of jids) {
            const msgs = store?.messages?.get(j);
            if (!msgs) continue;
            for (const m of msgs.values()) {
                if (m?.message?.reactionMessage) continue; // reactions are noise here
                if (m?.key?.id && !byId.has(m.key.id)) byId.set(m.key.id, m);
            }
        }
        const all = Array.from(byId.values()).sort((a, b) => (msgTs(a) || 0) - (msgTs(b) || 0));
        const list = all.slice(-limit);
        // After a restart memory is empty: fill the newest page from the SQLite index.
        const memIds = new Set(all.map((m) => m?.key?.id));
        const dbFill = list.length < limit
            ? chatStore.pageBefore(jids, Number.MAX_SAFE_INTEGER, limit).filter((r) => !memIds.has(r.id))
            : [];
        // Ticks/reactions/poll meta can be keyed under either address — query both.
        const metas = new Map();
        const metaIds = list.map((m) => m?.key?.id).concat(dbFill.map((r) => r.id));
        // Also the addresses each message was stored under (LID or phone number), so
        // edits/deletes keyed by either address apply even before the JID link is known.
        const metaJids = new Set(jids);
        for (const m of list) {
            if (m?.key?.remoteJid) metaJids.add(String(m.key.remoteJid));
            if (m?.key?.remoteJidAlt) metaJids.add(String(m.key.remoteJidAlt));
        }
        for (const j of metaJids) {
            for (const [id, meta] of chatStore.getMsgMetas(j, metaIds)) {
                if (!metas.has(id)) metas.set(id, meta);
            }
        }
        // Opening a chat marks it read → the sender sees blue ticks.
        markChatRead(jid, all);
        const mine = myDigits();
        const memDtos = list.map((m) => slimMessage(m, metas.get(m?.key?.id), mine));
        const indexDtos = dbFill.map((r) => dbRowToDto(r, metas.get(r.id) || {}, mine));
        const dtos = indexDtos.concat(memDtos)
            .filter((d) => !d.hidden) // protocol rows are not shown; the target carries the state
            .sort((a, b) => (a.ts || 0) - (b.ts || 0) || String(a.id).localeCompare(String(b.id)))
            .slice(-limit);
        // Enrich quoted blocks with the sender's profile name when we have it.
        for (const d of dtos) {
            if (d.quoted?.id && !d.quoted.pushName) {
                for (const j of jids) {
                    const qm = store?.messages?.get(j)?.get(d.quoted.id);
                    if (qm) {
                        d.quoted.pushName = qm.pushName || '';
                        d.quoted.fromMe = !!qm.key?.fromMe;
                        break;
                    }
                }
            }
            if (d.deleted) { d.text = 'This message was deleted'; d.media = null; d.poll = null; }
        }
        // Cursor = oldest message on screen. With nothing in memory, ask the
        // index for anything at all, so chats that only exist in SQLite still page.
        const cursorTs = dtos.length ? (dtos[0].ts || 0) : Number.MAX_SAFE_INTEGER;
        const cursorId = dtos.length ? dtos[0].id : '';
        const hasMore = all.length > list.length
            || (cursorTs > 0 && chatStore.pageBefore(jids, cursorTs, 1, cursorId).length > 0);
        const access = jid.endsWith('@g.us') ? await groupAccess(jid) : null;
        res.json({
            ok: true,
            jid,
            groupAccess: access ? { announce: access.announce, canSend: access.canSend, known: access.known } : null,
            presence: getPresenceAny(jids),
            lastSeen: lastSeenAny(jids),
            messages: dtos,
            hasMore,
        });
    });

    app.get('/api/search', requireAuth, (req, res) => {
        const q = String(req.query.q || '').trim();
        if (!q) return res.status(400).json({ ok: false, error: 'empty query' });
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
        const seen = new Set();
        const results = [];
        const scopeRaw = req.query.jid ? String(req.query.jid) : '';
        if (scopeRaw && !JID_RE.test(scopeRaw)) return res.status(400).json({ ok: false, error: 'invalid jid' });
        const scope = scopeRaw ? getJidMap().related(getJidMap().canonical(scopeRaw)) : null;
        for (const r of chatStore.search(q, limit, scope)) {
            // LID ↔ PN: show one canonical chat per person.
            const cj = getJidMap().canonical(r.chatJid);
            const key = `${cj}|${r.msgId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            results.push({
                ...r,
                chatJid: cj,
                chatName: chatDisplayName(cj, { pushName: r.pushName }) || cj.split('@')[0],
                isGroup: cj.endsWith('@g.us'),
            });
        }
        refreshGroupNames(results.slice(0, MAX_GROUP_NAME_FETCHES));
        res.json({ ok: true, q, results });
    });

    app.get('/api/media', requireAuth, async (req, res) => {
        const jid = String(req.query.jid || '');
        const msgId = String(req.query.id || '');
        if (!JID_RE.test(jid) && jid !== 'status@broadcast') return res.status(400).json({ ok: false, error: 'invalid jid' });
        if (!MSG_ID_RE.test(msgId)) return res.status(400).json({ ok: false, error: 'invalid id' });
        try {
            const media = await resolveMedia(jid, msgId);
            if (media.error) return res.status(media.error).json({ ok: false, error: media.message });
            res.setHeader('Content-Type', media.mime);
            if (media.kind === 'document' && media.fileName) {
                const safeName = String(media.fileName).replace(/["\\]/g, '_');
                res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
            } else {
                res.setHeader('Content-Disposition', 'inline');
            }
            res.setHeader('Cache-Control', 'private, max-age=3600');
            sendWithRange(req, res, media.buf);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.get('/api/avatar', requireAuth, async (req, res) => {
        const jid = String(req.query.jid || '');
        if (!JID_RE.test(jid)) return res.status(400).json({ ok: false, error: 'invalid jid' });
        try {
            const avatar = await resolveAvatar(jid);
            if (!avatar) return res.status(404).send('no avatar');
            res.setHeader('Content-Type', avatar.mime);
            res.setHeader('Cache-Control', 'private, max-age=3600');
            res.send(avatar.buf);
        } catch (e) {
            res.status(404).send('no avatar');
        }
    });

    app.post('/api/typing', requireAuth, jsonParser, async (req, res) => {
        const { jid, composing } = req.body || {};
        if (typeof jid !== 'string' || !JID_RE.test(jid)) {
            return res.status(400).json({ ok: false, error: 'invalid jid' });
        }
        const sock = getSock();
        if (!sock || typeof sock.sendPresenceUpdate !== 'function') {
            return res.status(503).json({ ok: false, error: 'bot is not connected' });
        }
        try {
            await sock.sendPresenceUpdate(composing ? 'composing' : 'paused', jid);
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/react', requireAuth, jsonParser, async (req, res) => {
        try {
            const { jid, msgId, emoji } = req.body || {};
            if (typeof jid !== 'string' || !JID_RE.test(jid)) {
                return res.status(400).json({ ok: false, error: 'invalid jid' });
            }
            if (typeof msgId !== 'string' || !MSG_ID_RE.test(msgId)) {
                return res.status(400).json({ ok: false, error: 'invalid msgId' });
            }
            if (typeof emoji !== 'string' || emoji.length > 32) {
                return res.status(400).json({ ok: false, error: 'invalid emoji' });
            }
            const text = emoji.trim();
            if (text && (Array.from(text).length > 8 || !/\S/.test(text))) {
                return res.status(400).json({ ok: false, error: 'invalid emoji' });
            }
            // Recent store first, then the SQLite index (empty recent store after a restart).
            const found = findStored(jid, msgId);
            if (!found) {
                return res.status(404).json({ ok: false, error: 'message not in recent store' });
            }
            const sock = getSock();
            if (!sock || typeof sock.sendMessage !== 'function') {
                return res.status(503).json({ ok: false, error: 'bot is not connected' });
            }
            // An empty emoji removes our reaction (WhatsApp semantics).
            await sock.sendMessage(found.msg.key.remoteJid, { react: { text, key: found.msg.key } });
            const reactions = applyReactionUpdate(jid, msgId, text, 'me');
            res.json({
                ok: true,
                id: msgId,
                reactions: reactions.map((r) => ({ emoji: r.emoji, count: r.senders.length, byMe: r.senders.includes('me') })),
            });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // Find a message we hold in memory, under either address of its chat.
    function findStored(jid, msgId) {
        for (const j of getJidMap().related(String(jid))) {
            const msg = store?.messages?.get(j)?.get(String(msgId));
            if (msg) return { msg, chat: j };
        }
        // Last resort in memory: the id alone (WhatsApp message ids are unique), for
        // protocol keys that name a chat address we do not store the message under.
        if (store?.messages instanceof Map) {
            for (const [chatKey, byId] of store.messages) {
                const msg = byId?.get?.(String(msgId));
                if (msg) return { msg, chat: chatKey };
            }
        }
        // After a restart the recent store is empty: quote from the SQLite index instead.
        for (const j of getJidMap().related(String(jid))) {
            const row = chatStore.getIndexed(j, msgId);
            if (row) return { msg: quoteFromIndex(row), chat: row.chatJid };
        }
        return null;
    }

    // Build the minimal WhatsApp message shape a quote needs (id, sender, text).
    function quoteFromIndex(row) {
        const isGroup = String(row.chatJid).endsWith('@g.us');
        return {
            key: {
                remoteJid: row.chatJid,
                id: row.id,
                fromMe: row.fromMe,
                ...(isGroup && row.sender ? { participant: row.sender } : {}),
            },
            message: { conversation: row.text },
            messageTimestamp: Math.floor((row.ts || 0) / 1000),
            pushName: row.fromMe ? '' : (chatStore.phonebookName(row.sender) || ''),
        };
    }

    function afterOutgoing(jid, sent) {
        try { store?.storeMessage?.(jid, sent); } catch (_) {}
        try { chatStore.logMessage(sent); } catch (_) {}
        try { chatStore.setMsgMeta(canonicalChat(jid), sent?.key?.id, { status: STATUS.PENDING }); } catch (_) {}
    }

    // Voice note: browser recording → OGG/Opus + duration + 64-bar waveform.
    app.post('/api/voice', requireAuth, sendParser, async (req, res) => {
        try {
            const { jid, audio, quotedMsgId } = req.body || {};
            if (typeof jid !== 'string' || !JID_RE.test(jid)) {
                return res.status(400).json({ ok: false, error: 'invalid jid' });
            }
            if (typeof audio !== 'string' || !audio) {
                return res.status(400).json({ ok: false, error: 'missing audio' });
            }
            if (await blockedByAdminOnly(jid)) return res.status(403).json({ ok: false, error: ADMIN_ONLY_MSG });
            const buf = Buffer.from(audio, 'base64');
            if (!buf.length || buf.length > MAX_VOICE_BYTES) {
                return res.status(400).json({ ok: false, error: `voice note too large (max ${MAX_VOICE_BYTES / 1024 / 1024}MB)` });
            }
            let quoted = null;
            if (quotedMsgId != null) {
                const found = typeof quotedMsgId === 'string' && MSG_ID_RE.test(quotedMsgId) ? findStored(jid, quotedMsgId) : null;
                if (!found) return res.status(400).json({ ok: false, error: 'quoted message not in recent store' });
                quoted = found.msg;
            }
            const sock = getSock();
            if (!sock) return res.status(503).json({ ok: false, error: 'bot is not connected' });
            let conv;
            try {
                conv = await convertAudio(buf);
            } catch (_) {
                return res.status(500).json({ ok: false, error: 'could not convert audio (is ffmpeg installed?)' });
            }
            const seconds = Math.max(1, Math.round(conv.pcm.length / 2 / 16000));
            const waveform = waveformFromPcm(conv.pcm);
            const sent = await sendVoice(sock, jid, conv.opus, { seconds, waveform, quoted });
            afterOutgoing(jid, sent);
            res.json({ ok: true, id: sent?.key?.id || null, seconds });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // Delete for everyone (WhatsApp: own messages within ~48 h).
    app.post('/api/delete', requireAuth, jsonParser, async (req, res) => {
        try {
            const { jid, msgId } = req.body || {};
            if (typeof jid !== 'string' || !JID_RE.test(jid)) return res.status(400).json({ ok: false, error: 'invalid jid' });
            if (typeof msgId !== 'string' || !MSG_ID_RE.test(msgId)) return res.status(400).json({ ok: false, error: 'invalid msgId' });
            const found = findStored(jid, msgId);
            if (!found) return res.status(404).json({ ok: false, error: 'message not in recent store' });
            const hours = (Date.now() - msgTs(found.msg)) / 3600000;
            if (found.msg.key.fromMe && hours > 48) {
                return res.status(400).json({ ok: false, error: 'delete for everyone is only allowed within 48 hours' });
            }
            const sock = getSock();
            if (!sock) return res.status(503).json({ ok: false, error: 'bot is not connected' });
            await sock.sendMessage(found.msg.key.remoteJid, { delete: found.msg.key });
            markDeletedEverywhere(found.msg.key);
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // Pin / unpin for everyone. WhatsApp keeps a pin for a fixed time; 24 hours here.
    app.post('/api/pin', requireAuth, jsonParser, async (req, res) => {
        try {
            const { jid, msgId, pin } = req.body || {};
            if (typeof jid !== 'string' || !JID_RE.test(jid)) return res.status(400).json({ ok: false, error: 'invalid jid' });
            if (typeof msgId !== 'string' || !MSG_ID_RE.test(msgId)) return res.status(400).json({ ok: false, error: 'invalid msgId' });
            if (typeof pin !== 'boolean') return res.status(400).json({ ok: false, error: 'pin must be true or false' });
            const found = findStored(jid, msgId);
            if (!found) return res.status(404).json({ ok: false, error: 'message not in recent store' });
            const sock = getSock();
            if (!sock) return res.status(503).json({ ok: false, error: 'bot is not connected' });
            await sock.sendMessage(found.msg.key.remoteJid, {
                pin: { type: pin ? 1 : 0, time: 86400, key: found.msg.key },
            });
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // Builds the lastMessages entry chatModify needs, or null when a field is missing.
    function lastMessageForSync(chatJid, id, fromMe, participant, tsMs) {
        if (!chatJid || !id || typeof fromMe !== 'boolean' || !tsMs || !Number.isFinite(Number(tsMs))) return null;
        const isGroup = String(chatJid).endsWith('@g.us');
        if (isGroup && !fromMe && !participant) return null;
        const key = { remoteJid: String(chatJid), id: String(id), fromMe };
        if (participant) key.participant = String(participant);
        return [{ key, messageTimestamp: Math.floor(Number(tsMs) / 1000) }];
    }

    // Calls tab: newest first, with a readable name for each chat.
    app.get('/api/calls', requireAuth, (req, res) => {
        const rows = chatStore.listCalls(100).map((c) => {
            let name = '';
            try { name = chatDisplayName(c.jid, null) || ''; } catch (_) {}
            // A call still "ringing" after 3 minutes never got a final event from WhatsApp.
            const outcome = c.outcome === 'ringing' && Date.now() - c.ts > 3 * 60 * 1000 ? 'ended' : c.outcome;
            return { ...c, outcome, name: name || c.jid.split('@')[0], number: c.jid.split('@')[0] };
        });
        res.json({ ok: true, calls: rows });
    });

    // New chat and status picker: who I message most, and saved contacts with no chats yet.
    app.get('/api/people', requireAuth, (req, res) => {
        try {
            const sock = getSock();
            const me = new Set([digits(sock?.user?.id), digits(sock?.user?.lid)].filter(Boolean));
            const frequent = chatStore.outgoingCounts(40)
                .filter((r) => /@(s\.whatsapp\.net|lid)$/.test(r.jid) && !me.has(digits(r.jid)))
                .slice(0, 20)
                .map((r) => {
                    let name = '';
                    try { name = chatDisplayName(r.jid, null) || ''; } catch (_) {}
                    return { jid: r.jid, count: r.count, name: name || r.jid.split('@')[0] };
                });
            const messaged = new Set(chatStore.chatJidsWithMessages());
            const saved = chatStore.savedContacts()
                .filter((c) => !messaged.has(c.jid))
                .map((c) => ({ jid: c.jid, name: c.name, number: c.number }));
            res.json({ ok: true, frequent, saved });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // My posted statuses from the last day, for the Status viewer.
    app.get('/api/status/mine', requireAuth, (req, res) => {
        res.json({ ok: true, items: chatStore.ownStatuses(Date.now() - STATUS_WINDOW_MS) });
    });

    // Post a photo or video to My status. Visible to the people I have chatted with.
    app.post('/api/status', requireAuth, sendParser, async (req, res) => {
        try {
            const { media, text } = req.body || {};
            if (!media || typeof media !== 'object' || typeof media.mime !== 'string' || typeof media.data !== 'string') {
                return res.status(400).json({ ok: false, error: 'a photo or video is required' });
            }
            const isImage = media.mime.startsWith('image/');
            const isVideo = media.mime.startsWith('video/');
            if (!isImage && !isVideo) return res.status(400).json({ ok: false, error: 'status supports photos and videos' });
            const buf = Buffer.from(media.data, 'base64');
            if (!buf.length || buf.length > MAX_MEDIA_BYTES) {
                return res.status(400).json({ ok: false, error: `media too large (max ${MAX_MEDIA_BYTES / 1024 / 1024}MB)` });
            }
            const sock = getSock();
            if (!sock || typeof sock.sendMessage !== 'function') return res.status(503).json({ ok: false, error: 'bot is not connected' });
            const caption = typeof text === 'string' ? text.slice(0, 700) : '';
            const audience = chatStore.chatJidsWithMessages()
                .filter((j) => /@(s\.whatsapp\.net|lid)$/.test(j))
                .slice(0, 300);
            if (!audience.length) return res.status(409).json({ ok: false, error: 'no contacts to show this status to yet' });
            const payload = isImage
                ? { image: buf, ...(caption ? { caption } : {}) }
                : { video: buf, ...(caption ? { caption } : {}) };
            const sent = await sock.sendMessage('status@broadcast', payload, { statusJidList: audience });
            const id = sent?.key?.id;
            if (id) chatStore.recordOwnStatus(id, caption || (isImage ? 'Photo' : 'Video'), Date.now(), 'Me');
            res.json({ ok: true, id: id || null });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // Swipe actions on a chat row. Each one is synced to the phone with chatModify.
    app.post('/api/chat/action', requireAuth, jsonParser, async (req, res) => {
        try {
            const { jid, action } = req.body || {};
            if (typeof jid !== 'string' || !JID_RE.test(jid)) return res.status(400).json({ ok: false, error: 'invalid jid' });
            const ACTIONS = ['archive', 'unarchive', 'pin', 'unpin', 'markRead', 'markUnread'];
            if (!ACTIONS.includes(action)) return res.status(400).json({ ok: false, error: 'unknown action' });
            // Archive and unarchive from the web are paused: they coincided with session conflicts that force a relink.
            if (action === 'archive' || action === 'unarchive') {
                return res.status(501).json({ ok: false, error: 'Archive and unarchive from the web are paused while a session conflict is investigated. Nothing was changed.' });
            }
            const sock = getSock();
            if (!sock) return res.status(503).json({ ok: false, error: 'bot is not connected' });
            if (typeof sock.chatModify !== 'function') return res.status(501).json({ ok: false, error: 'chat actions are not supported by this bot version' });

            const canon = getJidMap().canonical(jid);
            // WhatsApp needs the newest message to sync archive and read state.
            let lastMessages = null;
            if (['archive', 'unarchive', 'markRead', 'markUnread'].includes(action)) {
                // WhatsApp can log every linked device out if chatModify gets incomplete data
                // (Baileys docs). So the last message must be complete, or the action is skipped.
                for (const k of getJidMap().related(canon)) {
                    const msgs = store?.messages?.get(k);
                    if (!msgs || !msgs.size) continue;
                    const last = Array.from(msgs.values()).filter((m) => m?.key).pop();
                    lastMessages = lastMessageForSync(k, last?.key?.id, last?.key?.fromMe, last?.key?.participant, msgTs(last));
                    if (lastMessages) break;
                }
                // Archived chats are often not in memory any more; use the newest stored message.
                if (!lastMessages) {
                    for (const k of getJidMap().related(canon)) {
                        const lk = chatStore.latestKey(k);
                        if (!lk) continue;
                        const participant = lk.sender && lk.sender !== k ? lk.sender : null;
                        lastMessages = lastMessageForSync(k, lk.id, lk.fromMe, participant, lk.ts);
                        if (lastMessages) break;
                    }
                }
                if (!lastMessages) return res.status(409).json({ ok: false, error: 'not enough stored message data to sync this chat safely, so nothing was changed' });
            }

            const modify = {
                archive: { archive: true, lastMessages },
                unarchive: { archive: false, lastMessages },
                pin: { pin: true },
                unpin: { pin: false },
                markRead: { markRead: true, lastMessages },
                markUnread: { markRead: false, lastMessages },
            }[action];
            global.lastWebChatAction = `${action} @ ${new Date().toISOString()}`;
            console.log(`[webchat] chat action ${action}: sending (${lastMessages ? 'with last message' : 'no last message'})`);
            try {
                await sock.chatModify(modify, canon);
            } catch (err) {
                console.log(`[webchat] chat action ${action} failed: ${err?.message || err}`);
                throw err;
            }
            console.log(`[webchat] chat action ${action}: accepted by WhatsApp`);

            // Local state follows only after WhatsApp accepted the change.
            if (action === 'archive' || action === 'unarchive') chatStore.setArchived(canon, action === 'archive');
            if (action === 'pin' || action === 'unpin') chatStore.setFlag(canon, 'pinned', action === 'pin');
            if (action === 'markRead') { chatStore.setRead(canon, Date.now()); chatStore.setFlag(canon, 'manual_unread', false); }
            if (action === 'markUnread') chatStore.setFlag(canon, 'manual_unread', true);
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // Star / unstar. Synced to the phone's starred messages (Baileys chatModify).
    app.post('/api/star', requireAuth, jsonParser, async (req, res) => {
        try {
            const { jid, msgId, star } = req.body || {};
            if (typeof jid !== 'string' || !JID_RE.test(jid)) return res.status(400).json({ ok: false, error: 'invalid jid' });
            if (typeof msgId !== 'string' || !MSG_ID_RE.test(msgId)) return res.status(400).json({ ok: false, error: 'invalid msgId' });
            if (typeof star !== 'boolean') return res.status(400).json({ ok: false, error: 'star must be true or false' });
            const found = findStored(jid, msgId);
            if (!found) return res.status(404).json({ ok: false, error: 'message not in recent store' });
            const sock = getSock();
            if (!sock) return res.status(503).json({ ok: false, error: 'bot is not connected' });
            if (typeof sock.star !== 'function') return res.status(501).json({ ok: false, error: 'starring is not supported by this bot version' });
            await sock.star(found.msg.key.remoteJid, [{ id: found.msg.key.id, fromMe: !!found.msg.key.fromMe }], star);
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // Edit (WhatsApp: own text messages within 15 minutes).
    app.post('/api/edit', requireAuth, jsonParser, async (req, res) => {
        try {
            const { jid, msgId, text } = req.body || {};
            if (typeof jid !== 'string' || !JID_RE.test(jid)) return res.status(400).json({ ok: false, error: 'invalid jid' });
            if (typeof msgId !== 'string' || !MSG_ID_RE.test(msgId)) return res.status(400).json({ ok: false, error: 'invalid msgId' });
            if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_LEN) {
                return res.status(400).json({ ok: false, error: 'invalid text' });
            }
            const found = findStored(jid, msgId);
            if (!found) return res.status(404).json({ ok: false, error: 'message not in recent store' });
            if (!found.msg.key.fromMe) return res.status(403).json({ ok: false, error: 'you can only edit your own messages' });
            if (Date.now() - msgTs(found.msg) > 15 * 60 * 1000) {
                return res.status(400).json({ ok: false, error: 'WhatsApp only allows edits within 15 minutes' });
            }
            const inner = unwrapMessage(found.msg.message || {});
            if (!inner.conversation && !inner.extendedTextMessage) {
                return res.status(400).json({ ok: false, error: 'only text messages can be edited' });
            }
            const sock = getSock();
            if (!sock) return res.status(503).json({ ok: false, error: 'bot is not connected' });
            await sock.sendMessage(found.msg.key.remoteJid, { text: text.trim(), edit: found.msg.key });
            const chat = canonicalChat(found.msg.key.remoteJid);
            chatStore.setMsgMeta(chat, msgId, { editText: text.trim(), edited: true });
            chatStore.updateIndexText(chat, msgId, text.trim());
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // Forward one or more stored messages to another chat (max 10).
    app.post('/api/forward', requireAuth, jsonParser, async (req, res) => {
        try {
            const { jid, toJid, msgIds } = req.body || {};
            if (typeof jid !== 'string' || !JID_RE.test(jid)) return res.status(400).json({ ok: false, error: 'invalid jid' });
            if (typeof toJid !== 'string' || !JID_RE.test(toJid)) return res.status(400).json({ ok: false, error: 'invalid target jid' });
            if (!Array.isArray(msgIds) || !msgIds.length || msgIds.length > 10 || !msgIds.every((id) => typeof id === 'string' && MSG_ID_RE.test(id))) {
                return res.status(400).json({ ok: false, error: 'pick 1–10 valid messages' });
            }
            const sock = getSock();
            if (!sock) return res.status(503).json({ ok: false, error: 'bot is not connected' });
            if (await blockedByAdminOnly(jid)) return res.status(403).json({ ok: false, error: ADMIN_ONLY_MSG });
            let forwarded = 0, failed = 0;
            for (const id of msgIds) {
                const found = findStored(jid, id);
                if (!found) { failed++; continue; }
                try {
                    const sent = await sock.sendMessage(toJid, { forward: found.msg });
                    afterOutgoing(toJid, sent);
                    forwarded++;
                } catch (_) { failed++; }
            }
            res.json({ ok: true, forwarded, failed });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // Create a poll (2–12 unique options). The message secret is kept so the
    // poll can be tallied and voted on from the web UI.
    app.post('/api/poll', requireAuth, jsonParser, async (req, res) => {
        try {
            const { jid, name, options, selectableCount } = req.body || {};
            if (typeof jid !== 'string' || !JID_RE.test(jid)) return res.status(400).json({ ok: false, error: 'invalid jid' });
            if (typeof name !== 'string' || !name.trim() || name.length > 255) {
                return res.status(400).json({ ok: false, error: 'poll question is required (max 255 chars)' });
            }
            if (!Array.isArray(options) || options.length < 2 || options.length > 12) {
                return res.status(400).json({ ok: false, error: 'a poll needs 2–12 options' });
            }
            if (await blockedByAdminOnly(jid)) return res.status(403).json({ ok: false, error: ADMIN_ONLY_MSG });
            const opts = options.map((o) => (typeof o === 'string' ? o.trim() : '')).filter(Boolean);
            if (opts.length !== options.length || new Set(opts).size !== opts.length || opts.some((o) => o.length > 100)) {
                return res.status(400).json({ ok: false, error: 'options must be unique, non-empty and at most 100 chars' });
            }
            const sel = Number.isInteger(selectableCount) ? selectableCount : 1;
            if (sel < 0 || sel > opts.length) return res.status(400).json({ ok: false, error: 'invalid selectableCount' });
            const sock = getSock();
            if (!sock) return res.status(503).json({ ok: false, error: 'bot is not connected' });
            const sent = await sock.sendMessage(jid, { poll: { name: name.trim(), values: opts, selectableCount: sel } });
            store?.storeMessage?.(jid, sent);
            logMessage(sent);
            const secret = sent?.message?.messageContextInfo?.messageSecret;
            const chat = canonicalChat(jid);
            chatStore.setMsgMeta(chat, String(sent?.key?.id || ''), {
                poll: { name: name.trim(), selectableCount: sel, options: opts, votes: {} },
                pollSecret: secret ? toB64(secret) : null,
            });
            res.json({ ok: true, id: sent?.key?.id || null, voteable: !!secret });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // Vote on a poll from the web UI. Encrypts the vote exactly as WhatsApp
    // expects (see utils/webChatPoll.js) and relays it as pollUpdateMessage.
    app.post('/api/pollvote', requireAuth, jsonParser, async (req, res) => {
        try {
            const { jid, pollId, options } = req.body || {};
            if (typeof jid !== 'string' || !JID_RE.test(jid)) return res.status(400).json({ ok: false, error: 'invalid jid' });
            if (typeof pollId !== 'string' || !MSG_ID_RE.test(pollId)) return res.status(400).json({ ok: false, error: 'invalid pollId' });
            if (!Array.isArray(options) || options.length > 12 || !options.every((o) => typeof o === 'string')) {
                return res.status(400).json({ ok: false, error: 'invalid options' });
            }
            const found = findStored(jid, pollId);
            if (!found) return res.status(404).json({ ok: false, error: 'poll not in recent store' });
            const chat = canonicalChat(found.chat);
            const meta = chatStore.getMsgMeta(chat, pollId);
            if (!meta?.poll || !meta.pollSecret) {
                return res.status(400).json({ ok: false, error: 'this poll cannot be voted on from the web' });
            }
            if (!options.every((o) => meta.poll.options.includes(o))) {
                return res.status(400).json({ ok: false, error: 'unknown option' });
            }
            const max = meta.poll.selectableCount || 0;
            if (max && options.length > max) return res.status(400).json({ ok: false, error: `pick at most ${max}` });
            const voterPn = myPnJid();
            const sock = getSock();
            if (!sock || !voterPn) return res.status(503).json({ ok: false, error: 'bot is not connected' });
            const creatorRaw = found.msg.key.fromMe ? (myLidJid() || voterPn) : (found.msg.key.participant || found.msg.key.remoteJid);
            const creatorJid = creatorRaw.endsWith('@lid')
                ? creatorRaw
                : (jidCandidates(creatorRaw).find((j) => j.endsWith('@lid')) || creatorRaw);
            const { encPayload, encIv } = pollCrypto.encryptPollVote(
                { pollEncKey: meta.pollSecret, pollMsgId: pollId, pollCreatorJid: creatorJid, voterJid: voterPn },
                options
            );
            const id = newMsgId(sock);
            await sock.relayMessage(found.msg.key.remoteJid, {
                pollUpdateMessage: {
                    pollCreationMessageKey: found.msg.key,
                    vote: { encPayload, encIv },
                    senderTimestampMs: Date.now(),
                    metadata: {},
                },
            }, { messageId: id });
            applyVote(chat, pollId, voterPn, options, Date.now());
            res.json({ ok: true, id, selected: options });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // Group members for the @mention picker (cached 5 minutes).
    const memberCache = new Map(); // group jid -> { ts, list }
    // Phone-number address for each group participant, where we can work it out:
    // the participant's phoneNumber field, the id itself, the saved LID↔PN map,
    // then a short live lookup for LID-only members. Capped so big groups stay fast.
    async function resolvePhoneNumbers(parts, sock) {
        const isPn = (j) => /@s\.whatsapp\.net$/.test(j) && !!digits(j);
        const out = new Map();
        const needLive = [];
        for (const p of parts) {
            const id = String(p?.id || '');
            if (!id) continue;
            const field = String(p?.phoneNumber || '');
            const fromField = field ? (field.includes('@') ? field : digits(field) + '@s.whatsapp.net') : '';
            const pn = [fromField, id, canonicalChat(id)].find(isPn);
            if (pn) out.set(id, pn);
            else if (id.endsWith('@lid')) needLive.push(p);
        }
        // Same retrying lookup the bot uses for group members: Baileys learns
        // LID↔number pairs over a few seconds after a group is read.
        if (needLive.length && sock) {
            const jidHelper = require('./jidHelper');
            await withTimeout(
                jidHelper.preloadLidResolution(sock, needLive, { maxWaitMs: 4000, intervalMs: 800 }),
                6000,
            ).catch(() => {});
            for (const p of needLive) {
                const id = String(p.id);
                const pn = canonicalChat(id);
                if (isPn(pn)) out.set(id, pn);
            }
        }
        // Still unresolved: tell the caller, so the result is cached only briefly.
        out.unresolved = needLive.filter((p) => !out.has(String(p.id))).length;
        return out;
    }

    app.get('/api/groupmembers', requireAuth, async (req, res) => {
        const jid = String(req.query.jid || '');
        if (!JID_RE.test(jid) || !jid.endsWith('@g.us')) return res.status(400).json({ ok: false, error: 'invalid group jid' });
        const cached = memberCache.get(jid);
        if (cached && Date.now() - cached.ts < (cached.ttl || 5 * 60 * 1000)) return res.json({ ok: true, members: cached.list });
        const sock = getSock();
        if (!sock || typeof sock.groupMetadata !== 'function') return res.status(503).json({ ok: false, error: 'bot is not connected' });
        try {
            const meta = await withTimeout(sock.groupMetadata(jid), 6000);
            const mine = myDigits();
            const parts = meta?.participants || [];
            // Messages are stored under the phone-number (PN) address, so every
            // member is shown and opened by that address, never by a raw LID.
            const pnFor = await resolvePhoneNumbers(parts, sock);
            const list = parts
                .map((p) => {
                    const id = String(p?.id || '');
                    const pn = pnFor.get(id) || null;
                    const chatJid = pn || canonicalChat(id);
                    const name = (pn && chatStore.phonebookName(pn))
                        || chatStore.senderName(id)
                        || (pn ? '+' + digits(pn) : 'unknown number');
                    const me = mine.has(digits(id)) || [p?.lid, p?.phoneNumber].some((x) => x && mine.has(digits(x)));
                    return { jid: chatJid, name, admin: !!p?.admin, me };
                })
                .filter((m) => m.jid && JID_RE.test(m.jid));
            // Incomplete lists are re-checked soon, so names fill in as Baileys learns them.
            const ttl = pnFor.unresolved ? 30 * 1000 : 5 * 60 * 1000;
            memberCache.set(jid, { ts: Date.now(), list, ttl });
            res.json({ ok: true, members: list });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/send', requireAuth, sendParser, async (req, res) => {
        try {
            const { jid, text, media, quotedMsgId } = req.body || {};
            if (typeof jid === 'string' && jid.endsWith('@newsletter')) {
                return res.status(403).json({ ok: false, error: 'channels are read-only in the web view' });
            }
            if (typeof jid !== 'string' || !JID_RE.test(jid)) {
                return res.status(400).json({ ok: false, error: 'invalid jid' });
            }
            if (await blockedByAdminOnly(jid)) return res.status(403).json({ ok: false, error: ADMIN_ONLY_MSG });
            // Quoted reply: Baileys needs the full stored message (key +
            // message + timestamp) to render the quote on the other side.
            let quoted = null;
            if (quotedMsgId != null) {
                if (typeof quotedMsgId !== 'string' || !MSG_ID_RE.test(quotedMsgId)) {
                    return res.status(400).json({ ok: false, error: 'invalid quotedMsgId' });
                }
                const found = findStored(jid, quotedMsgId);
                quoted = found ? found.msg : null;
                if (!quoted) {
                    return res.status(404).json({ ok: false, error: 'quoted message not in recent store' });
                }
            }
            const caption = typeof text === 'string' ? text : '';
            if (caption.length > MAX_TEXT_LEN) {
                return res.status(400).json({ ok: false, error: `message too long (max ${MAX_TEXT_LEN})` });
            }
            let payload;
            if (media && typeof media === 'object') {
                const { mime, data, fileName } = media;
                if (typeof mime !== 'string' || typeof data !== 'string') {
                    return res.status(400).json({ ok: false, error: 'invalid media' });
                }
                const buf = Buffer.from(data, 'base64');
                if (!buf.length || buf.length > MAX_MEDIA_BYTES) {
                    return res.status(400).json({ ok: false, error: `media too large (max ${MAX_MEDIA_BYTES / 1024 / 1024}MB)` });
                }
                const safeName = typeof fileName === 'string' && fileName ? fileName.slice(0, 120) : null;
                if (mime.startsWith('image/')) payload = { image: buf, ...(caption ? { caption } : {}) };
                else if (mime.startsWith('video/')) payload = { video: buf, ...(caption ? { caption } : {}) };
                else if (mime.startsWith('audio/')) payload = { audio: buf, mimetype: mime };
                else payload = {
                    document: buf,
                    mimetype: mime || 'application/octet-stream',
                    fileName: safeName || 'file',
                    ...(caption ? { caption } : {}),
                };
            } else {
                if (!caption.trim()) {
                    return res.status(400).json({ ok: false, error: 'empty message' });
                }
                payload = { text: caption };
            }
            const sock = getSock();
            if (!sock || typeof sock.sendMessage !== 'function') {
                return res.status(503).json({ ok: false, error: 'bot is not connected' });
            }
            const mentions = Array.isArray(req.body?.mentions)
                ? req.body.mentions.filter((j) => typeof j === 'string' && JID_RE.test(j)).slice(0, 50)
                : [];
            if (mentions.length && payload && typeof payload === 'object') payload.mentions = mentions;
            const sent = await sock.sendMessage(jid, payload, quoted ? { quoted } : undefined);
            // Keep our own outgoing message in the recent store + search index.
            try { store?.storeMessage?.(jid, sent); } catch (_) {}
            try { chatStore.logMessage(sent); } catch (_) {}
            try { chatStore.setMsgMeta(jid, sent?.key?.id, { status: STATUS.PENDING }); } catch (_) {}
            if (quoted) {
                // Fallback descriptor if the sent echo lacks contextInfo.
                try {
                    if (!slimMessage(sent).quoted) {
                        chatStore.setMsgMeta(jid, sent?.key?.id, { quoted: quotedDescriptor(quoted) });
                    }
                } catch (_) {}
            }
            res.json({ ok: true, id: sent?.key?.id || null });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/logout', requireAuth, (req, res) => {
        const token = parseCookies(req)[SESSION_COOKIE];
        if (token) sessions.delete(token);
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        res.json({ ok: true });
    });

    /* ── handle returned to index.js ────────────────────────────────────── */

    // Calls from the `call` event. Only unanswered incoming calls are kept, as a
    // "Missed voice call" row in the chat they came from.
    // chats.upsert / chats.update / chats.set — keep the archived flag per chat.
    function handleChats(list, source) {
        try {
            const items = Array.isArray(list) ? list : [];
            let flagged = 0, archived = 0;
            for (const c of items) {
                if (!c?.id) continue;
                if ('pinned' in c) chatStore.setFlag(canonicalChat(c.id), 'pinned', !!c.pinned);
                if (typeof c.archived !== 'boolean') continue;
                flagged++;
                if (c.archived) archived++;
                chatStore.setArchived(canonicalChat(c.id), c.archived);
            }
            // Counts only (no chat IDs) so the log shows whether WhatsApp sends archive flags.
            console.log(`[webchat] ${source || 'chats'} event: ${items.length} chats, ${flagged} with archive flag, ${archived} archived`);
        } catch (_) {}
    }

    function logCall(call) {
        try {
            if (!call?.id || call.isGroup) return;
            const chatId = call.chatId || call.from;
            if (!chatId) return;
            // Call history for the Calls tab.
            const sock = getSock();
            const fromDigits = digits(call.from);
            const outgoing = !!fromDigits && (fromDigits === digits(sock?.user?.id) || fromDigits === digits(sock?.user?.lid));
            const dir = outgoing ? 'outgoing' : 'incoming';
            const video = !!call.isVideo;
            // call.date is a Date (milliseconds) in Baileys. Only convert when it looks like seconds,
            // otherwise the timestamp lands ~1000x in the future and the 3-minute expiry never runs.
            const rawDate = call.date instanceof Date ? call.date.getTime() : Number(call.date);
            const ts = rawDate > 1e12 ? rawDate : (rawDate > 0 ? rawDate * 1000 : Date.now());
            const callChat = canonicalChat(chatId);
            // Incoming rejects are calls the caller ended before you answered: WhatsApp shows them as missed.
            const finalOutcome = {
                accept: 'answered',
                timeout: outgoing ? 'no answer' : 'missed',
                reject: outgoing ? 'rejected' : 'missed',
            }[call.status];
            // Counts only (no numbers) so the logs show whether call events reach the bot.
            console.log(`[webchat] call event: status=${call.status} ${dir} video=${video}`);
            if (finalOutcome) chatStore.recordCall(call.id, callChat, dir, finalOutcome, video, ts, true);
            else if (call.status === 'offer' || call.status === 'ringing') chatStore.recordCall(call.id, callChat, dir, 'ringing', video, ts, false);
            else if (call.status === 'terminate') chatStore.recordCall(call.id, callChat, dir, 'ended', video, ts, false);

            if (call.status !== 'timeout' && call.status !== 'reject') return;
            logMessage({
                key: { id: 'CALL-' + String(call.id), remoteJid: chatId, fromMe: false },
                message: { callLogMessage: { isVideo: !!call.isVideo } },
                messageTimestamp: Number(call.date) || Math.floor(Date.now() / 1000),
                pushName: '',
            });
        } catch (_) {}
    }

    function logMessage(msg) {
        try {
            // Learn LID ↔ PN pairs from the message's alternate address.
            linkKey(msg?.key);
            const inner = unwrapMessage(msg?.message || {});
            rememberSecret(msg, inner);
            if (inner.protocolMessage) { handleProtocol(inner, msg); return; }
            if (secretEditOf(inner)) { handleSecretEdit(msg, secretEditOf(inner)); return; }
            if (inner.pollUpdateMessage) { handlePollVote(msg, inner.pollUpdateMessage); return; }
            // Some reactions arrive as ordinary messages. Apply them like messages.reaction
            // (applying the same reaction twice is harmless: one reaction per person).
            if (inner.reactionMessage) {
                const rm = inner.reactionMessage;
                const target = rm.key || {};
                handleReactions([{
                    key: { id: target.id, remoteJid: target.remoteJid || msg.key.remoteJid, fromMe: target.fromMe },
                    reaction: { text: rm.text, key: msg.key },
                }]);
                return;
            }
            if (msg?.key?.remoteJid === 'status@broadcast' && msg.key.id && extractMedia(inner)) {
                chatStore.saveRaw('status@broadcast', msg.key.id, msgTs(msg), msg);
            }
            // Index under the canonical chat so search + phonebook see one chat.
            const canon = msg?.key?.remoteJid ? canonicalChat(msg.key.remoteJid) : null;
            if (canon && canon !== msg.key.remoteJid) {
                chatStore.logMessage({ ...msg, key: { ...msg.key, remoteJid: canon } });
            } else {
                chatStore.logMessage(msg);
            }
            if (canon && msg.key.id) rememberPollCreation(canon, msg, inner);
        } catch (_) {}
    }

    /* ── identity helpers (LID ↔ PN aware) ─────────────────────────────── */

    function canonicalChat(jid) {
        return getJidMap().canonical(String(jid || ''));
    }

    function myPnJid() {
        const d = digits(getSock()?.user?.id);
        return d ? `${d}@s.whatsapp.net` : null;
    }

    function myLidJid() {
        const d = digits(getSock()?.user?.lid);
        return d ? `${d}@lid` : null;
    }

    // Digits of our own addresses — used to mark our own poll votes.
    // ── admin-only groups ("announce" mode): who may send ─────────────────
    const ADMIN_ONLY_MSG = 'Only admins can send messages in this group';
    const groupAccessCache = new Map();   // group jid -> { ts, value }
    const groupLastKnown = new Map();     // group jid -> { announce, amAdmin } (survives lookup failures)
    const groupWarned = new Set();
    const GROUP_ACCESS_TTL = 60 * 1000;
    const GROUP_ACCESS_RETRY = 15 * 1000;

    // Fail closed: in an admin-only group we send only when we can confirm the
    // owner is an admin. If the group can't be read right now, the last known
    // state is used. Only a group we have never read is allowed through, and
    // WhatsApp itself refuses the send if it is restricted.
    async function groupAccess(jid) {
        if (!String(jid).endsWith('@g.us')) return { isGroup: false, known: false, announce: false, amAdmin: false, canSend: true };
        const hit = groupAccessCache.get(jid);
        if (hit && Date.now() - hit.ts < (hit.value.known ? GROUP_ACCESS_TTL : GROUP_ACCESS_RETRY)) return hit.value;
        let value = { isGroup: true, known: false, announce: false, amAdmin: false, canSend: true };
        const sock = getSock();
        if (sock && typeof sock.groupMetadata === 'function') {
            try {
                const meta = await withTimeout(sock.groupMetadata(jid), 4000);
                const mine = myDigits();
                const me = (meta?.participants || []).find((p) => {
                    const ids = [p?.id, p?.lid, p?.phoneNumber].filter(Boolean).map(String);
                    return ids.some((x) => mine.has(digits(x)) || jidCandidates(x).some((c) => mine.has(digits(c))));
                });
                const announce = !!meta?.announce;
                const amAdmin = !!me && (me.admin === 'admin' || me.admin === 'superadmin');
                if (announce && !me && !groupWarned.has(jid)) {
                    groupWarned.add(jid);
                    log(`[ WEB ] Admin-only group ${digits(jid)}: owner not found among members, sending blocked`, 'yellow');
                }
                groupLastKnown.set(jid, { announce, amAdmin });
                value = { isGroup: true, known: true, announce, amAdmin, canSend: !announce || amAdmin };
            } catch (_) {
                const last = groupLastKnown.get(jid);
                if (last) value = { isGroup: true, known: false, announce: last.announce, amAdmin: last.amAdmin, canSend: !last.announce || last.amAdmin };
            }
        }
        groupAccessCache.set(jid, { ts: Date.now(), value });
        return value;
    }

    async function blockedByAdminOnly(jid) {
        const a = await groupAccess(jid);
        return a.isGroup && !a.canSend;
    }

    function myDigits() {
        return new Set([digits(getSock()?.user?.id), digits(getSock()?.user?.lid)].filter(Boolean));
    }

    // Every address a jid may be known by (its LID and its phone twin).
    function jidCandidates(raw) {
        const out = [];
        for (const j of getJidMap().related(String(raw || ''))) if (j && !out.includes(j)) out.push(j);
        return out;
    }

    function toB64(secret) {
        return typeof secret === 'string' ? secret : Buffer.from(secret).toString('base64');
    }

    /* ── protocol messages: delete-for-everyone and edits ──────────────── */

    function markDeletedEverywhere(key) {
        if (!key?.id || !key?.remoteJid) return;
        const chat = canonicalChat(key.remoteJid);
        chatStore.setMsgMeta(chat, String(key.id), { deleted: true });
        chatStore.markIndexDeleted(chat, String(key.id));
    }

    // Every address a chat can be keyed under (LID and phone number). Protocol keys
    // do not always use the address the message was stored under.
    function addressesOf(...jids) {
        const out = new Set();
        for (const j of jids) {
            if (!j) continue;
            out.add(canonicalChat(j));
            for (const r of getJidMap().related(String(j))) out.add(r);
        }
        return [...out];
    }

    // Keep the message secret: edits to this message are encrypted with it.
    function rememberSecret(msg, inner) {
        const key = msg?.key;
        if (!key?.id || !key.remoteJid || inner.protocolMessage) return;
        let secret = msg.message?.messageContextInfo?.messageSecret ?? inner.messageContextInfo?.messageSecret;
        if (!secret) return;
        if (typeof secret !== 'string') {
            secret = Buffer.isBuffer(secret) || secret instanceof Uint8Array
                ? Buffer.from(secret).toString('base64')
                : (Array.isArray(secret.data) ? Buffer.from(secret.data).toString('base64') : null);
            if (!secret) return;
        }
        chatStore.setMsgMeta(canonicalChat(key.remoteJid), String(key.id), { messageSecret: secret });
    }

    // Encrypted edit (secretEncryptedMessage, MESSAGE_EDIT): decrypt with the original
    // message's secret, then show the new text on the original message.
    function handleSecretEdit(msg, sem) {
        const target = sem?.targetMessageKey || {};
        if (!target.id) return;
        const id = String(target.id);
        const chats = addressesOf(target.remoteJid, msg?.key?.remoteJid);
        let secret = null;
        for (const c of chats) {
            const meta = chatStore.getMsgMetas(c, [id]).get(id);
            if (meta?.messageSecret) { secret = meta.messageSecret; break; }
        }
        if (!secret) {
            const found = findStored(target.remoteJid, id) || findStored(msg?.key?.remoteJid, id);
            const ms = found?.msg?.message?.messageContextInfo?.messageSecret;
            if (ms) secret = typeof ms === 'string' ? ms : Buffer.from(ms).toString('base64');
        }
        const editor = [msg?.key?.remoteJid, msg?.key?.remoteJidAlt, msg?.key?.participant]
            .filter((j) => j && !String(j).endsWith('@g.us'));
        const dbg = {
            at: new Date().toISOString(),
            targetId: id,
            targetRemoteJid: target.remoteJid || null,
            targetFromMe: target.fromMe ?? null,
            editorJids: editor,
            secretEncType: sem.secretEncType ?? null,
            encIv: sem.encIv ?? null,
            encPayload: sem.encPayload ?? null,
            messageSecret: secret || null,
        };
        if (!secret) {
            writeEditDebug({ ...dbg, result: 'secret-not-found' });
            console.log(`[WEBCHAT] edit ${id}: original message secret not found, cannot decrypt`);
            return;
        }
        const plain = decryptEdit({
            encPayload: sem.encPayload, encIv: sem.encIv, targetId: id, secret,
            origSenders: [...new Set([...editor, target.remoteJid].filter(Boolean))],
            modSenders: [...new Set(editor)],
        });
        if (!plain) {
            writeEditDebug({ ...dbg, result: 'decrypt-failed' });
            console.log(`[WEBCHAT] edit ${id}: could not decrypt`);
            return;
        }
        const text = messageText({ message: waProto.Message.decode(plain) });
        writeEditDebug({ ...dbg, result: 'ok', text });
        for (const c of chats) {
            chatStore.setMsgMeta(c, id, { editText: text, edited: true });
            chatStore.updateIndexText(c, id, text);
        }
    }

    function handleProtocol(inner, msg) {
        const proto = inner.protocolMessage;
        const target = proto?.key;
        if (!target?.id) return;
        const type = protoTypeOf(proto);
        const chats = addressesOf(target.remoteJid, msg?.key?.remoteJid);
        const id = String(target.id);
        if (type === 0) { // REVOKE — "delete for everyone"
            for (const c of chats) {
                chatStore.setMsgMeta(c, id, { deleted: true });
                chatStore.markIndexDeleted(c, id);
            }
            return;
        }
        if (type === 14) { // MESSAGE_EDIT — the new text replaces the old one
            const text = editedTextFromProtocol(inner);
            if (text == null) return;
            for (const c of chats) {
                chatStore.setMsgMeta(c, id, { editText: text, edited: true });
                chatStore.updateIndexText(c, id, text);
            }
        }
    }

    function handleMessagesDelete(payload) {
        try {
            if (payload && Array.isArray(payload.keys)) {
                for (const k of payload.keys) markDeletedEverywhere(k);
            }
        } catch (_) {}
    }

    /* ── polls: remember secrets, decrypt votes, keep one vote per voter ── */

    // Poll creation seen on the wire: keep its options and message secret so
    // votes can be decrypted later. Never resets votes already recorded.
    function rememberPollCreation(chat, msg, inner) {
        const pc = inner.pollCreationMessage || inner.pollCreationMessageV2 || inner.pollCreationMessageV3;
        if (!pc) return;
        const id = String(msg.key.id);
        if (chatStore.getMsgMeta(chat, id)?.poll) return;
        const options = (pc.options || []).map((o) => o.optionName || '').filter(Boolean);
        if (!options.length) return;
        const secret = msg.message?.messageContextInfo?.messageSecret;
        chatStore.setMsgMeta(chat, id, {
            poll: { name: pc.name || '', selectableCount: pc.selectableCount ?? 1, options, votes: {} },
            pollSecret: secret ? toB64(secret) : null,
        });
    }

    // One vote per voter (keyed by phone digits so LID/PN twins collapse).
    // A newer vote replaces the old one; an empty selection withdraws it.
    function applyVote(chat, pollId, voterRaw, names, ts) {
        const meta = chatStore.getMsgMeta(chat, pollId);
        if (!meta?.poll) return false;
        const voter = digits(canonicalChat(voterRaw));
        if (!voter) return false;
        const votes = { ...(meta.poll.votes || {}) };
        const prev = votes[voter];
        if (prev && prev.ts > ts) return false; // out-of-order older vote never wins
        if (!names.length) delete votes[voter];
        else votes[voter] = { sel: names, ts };
        chatStore.setMsgMeta(chat, pollId, { poll: { ...meta.poll, votes } });
        return true;
    }

    function handlePollVote(msg, pu) {
        const creation = pu?.pollCreationMessageKey;
        if (!creation?.id || !creation?.remoteJid) return;
        const chat = canonicalChat(creation.remoteJid);
        const meta = chatStore.getMsgMeta(chat, String(creation.id));
        if (!meta?.poll || !meta.pollSecret) return;
        const voterRaw = msg.key.fromMe ? myPnJid() : (msg.key.participant || msg.key.remoteJid);
        if (!voterRaw) return;
        // Baileys #2342: WhatsApp encrypts with LID for the creator and PN for
        // the voter in 1:1 chats — try every known address combination.
        const creatorJids = creation.fromMe
            ? [myLidJid(), myPnJid()].filter(Boolean)
            : jidCandidates(creation.participant || creation.remoteJid);
        const found = pollCrypto.decryptPollVoteAny(pu.vote || {}, {
            pollEncKey: meta.pollSecret,
            pollMsgId: String(creation.id),
            creatorJids,
            voterJids: msg.key.fromMe ? [myPnJid(), myLidJid()].filter(Boolean) : jidCandidates(voterRaw),
        });
        if (!found) return;
        const names = pollCrypto.namesFromHashes(found.selected, meta.poll.options || []);
        const ts = Number(pu.senderTimestampMs) || msgTs(msg) || Date.now();
        applyVote(chat, String(creation.id), voterRaw, names, ts);
    }

    /* ── read receipts, reactions, edits etc. stay below ─────────────── */

    return { logMessage, logCall, handleChats, handlePresenceUpdate, handleMessageUpdate, handleReactions, handleReceiptUpdate, handleLidMapping, handleMessagesDelete, handleContacts, handleHistorySync };
}

module.exports = { attachChatUI };
