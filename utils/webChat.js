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
 *   POST /api/send       send text or a media attachment      (auth)
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

const { unwrapMessage, extractMedia, slimMessage, msgTs, STATUS, applyReaction } = require('./webChatText');
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

function attachChatUI(app, deps) {
    const getSock = deps.getSock || (() => global.currentSock || null);
    const getBotState = deps.getBotState || (() => global.botState || 'unknown');
    const store = deps.store || null;
    const log = deps.log || console.log;
    const downloadMedia = deps.downloadMedia || defaultDownloadMedia;

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
                const chatJid = key.remoteJid;
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
                applyReactionUpdate(
                    reactedTo.remoteJid,
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
                chatStore.setMsgMeta(key.remoteJid, String(key.id), { status });
            }
        } catch (_) {}
    }

    // lid-mapping.update — Baileys reports { pn, lid } for one person.
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
        const msg = store?.messages?.get(jid)?.get(msgId);
        if (!msg) return { error: 404, message: 'message not in recent store (media expired)' };
        const media = extractMedia(unwrapMessage(msg.message || {}));
        if (!media) return { error: 400, message: 'not a media message' };
        const key = `${jid}|${msgId}`;
        const cached = mediaCache.get(key);
        if (cached && Date.now() - cached.ts < MEDIA_CACHE_TTL_MS) {
            return { buf: cached.buf, mime: cached.mime, fileName: cached.fileName, kind: cached.kind };
        }
        const buf = await downloadMedia(media.content, media.kind);
        const entry = { buf, mime: media.mime, fileName: media.fileName, kind: media.kind, size: buf.length, ts: Date.now() };
        cacheMedia(key, entry);
        return { buf: entry.buf, mime: entry.mime, fileName: entry.fileName, kind: entry.kind };
    }

    /* ── avatars ────────────────────────────────────────────────────────── */

    async function resolveAvatar(jid) {
        const cached = avatarCache.get(jid);
        if (cached && Date.now() - cached.ts < AVATAR_CACHE_TTL_MS) return cached;
        const sock = getSock();
        if (!sock || typeof sock.profilePictureUrl !== 'function') return null;
        const url = await sock.profilePictureUrl(jid, 'image');
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

    function chatDisplayName(jid, lastMsg) {
        const canon = getJidMap().canonical(jid);
        if (canon.endsWith('@g.us')) return groupNames.get(canon) || null;
        return chatStore.phonebookName(canon) || lastMsg?.pushName || null;
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

    app.get('/api/chats', requireAuth, (req, res) => {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
        const byJid = store?.messages;
        const merged = new Map(); // canonical jid → one chat entry
        if (byJid) {
            for (const [jid, msgs] of byJid) {
                if (!jid || jid === 'status@broadcast' || !msgs || msgs.size === 0) continue;
                const canon = getJidMap().canonical(jid);
                const isGroup = jid.endsWith('@g.us');
                const lastRead = chatStore.getRead(canon);
                let last = null, unread = 0, count = 0;
                for (const m of msgs.values()) {
                    if (!m?.key || m.message?.reactionMessage) continue; // reactions aren't previews
                    count++;
                    last = m; // insertion order → last non-reaction is newest
                    if (!m.key.fromMe && msgTs(m) > lastRead) unread++;
                }
                if (!last) continue;
                const name = chatDisplayName(jid, last) || jid.split('@')[0];
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
        const chats = Array.from(merged.values());
        chats.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
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

    app.get('/api/messages', requireAuth, async (req, res) => {
        const jid = String(req.query.jid || '');
        if (!JID_RE.test(jid)) {
            return res.status(400).json({ ok: false, error: 'invalid jid' });
        }
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
        // LID ↔ PN: one person can chat under both addresses. Best-effort
        // live lookup, then merge every bucket that maps to this chat.
        await withTimeout(getJidMap().enrich(jid, getSock()), 1500).catch(() => {});
        const jids = getJidMap().related(jid);
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
        // Ticks/reactions meta can be keyed under either address — query both.
        const metas = new Map();
        for (const j of jids) {
            for (const [id, meta] of chatStore.getMsgMetas(j, list.map((m) => m?.key?.id))) {
                if (!metas.has(id)) metas.set(id, meta);
            }
        }
        // Opening a chat marks it read → the sender sees blue ticks.
        markChatRead(jid, all);
        res.json({
            ok: true,
            jid,
            presence: getPresenceAny(jids),
            messages: list.map((m) => slimMessage(m, metas.get(m?.key?.id))),
        });
    });

    app.get('/api/search', requireAuth, (req, res) => {
        const q = String(req.query.q || '').trim();
        if (!q) return res.status(400).json({ ok: false, error: 'empty query' });
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
        const seen = new Set();
        const results = [];
        for (const r of chatStore.search(q, limit)) {
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
        if (!JID_RE.test(jid)) return res.status(400).json({ ok: false, error: 'invalid jid' });
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
            res.send(media.buf);
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
            const msg = store?.messages?.get(jid)?.get(msgId);
            if (!msg) {
                return res.status(404).json({ ok: false, error: 'message not in recent store' });
            }
            const sock = getSock();
            if (!sock || typeof sock.sendMessage !== 'function') {
                return res.status(503).json({ ok: false, error: 'bot is not connected' });
            }
            // An empty emoji removes our reaction (WhatsApp semantics).
            await sock.sendMessage(jid, { react: { text, key: msg.key } });
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

    app.post('/api/send', requireAuth, sendParser, async (req, res) => {
        try {
            const { jid, text, media } = req.body || {};
            if (typeof jid !== 'string' || !JID_RE.test(jid)) {
                return res.status(400).json({ ok: false, error: 'invalid jid' });
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
            const sent = await sock.sendMessage(jid, payload);
            // Keep our own outgoing message in the recent store + search index.
            try { store?.storeMessage?.(jid, sent); } catch (_) {}
            try { chatStore.logMessage(sent); } catch (_) {}
            try { chatStore.setMsgMeta(jid, sent?.key?.id, { status: STATUS.PENDING }); } catch (_) {}
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

    function logMessage(msg) {
        try {
            // Learn LID ↔ PN pairs from the message's alternate address.
            linkKey(msg?.key);
            // Index under the canonical chat so search + phonebook see one chat.
            const canon = msg?.key?.remoteJid ? getJidMap().canonical(msg.key.remoteJid) : null;
            if (canon && canon !== msg.key.remoteJid) {
                chatStore.logMessage({ ...msg, key: { ...msg.key, remoteJid: canon } });
            } else {
                chatStore.logMessage(msg);
            }
        } catch (_) {}
    }

    return { logMessage, handlePresenceUpdate, handleMessageUpdate, handleReactions, handleReceiptUpdate, handleLidMapping };
}

module.exports = { attachChatUI };
