/**
 * June-X Ultra — Web Chat persistence (utils/webChatStore.js)
 *
 * Four jobs:
 *   1. Message search index — every message is written to a small SQLite
 *      database (better-sqlite3, already a project dependency) so the web
 *      chat can search and page through history that survives restarts.
 *   2. Phonebook — number → WhatsApp profile name (pushName), persisted to a
 *      JSON file, so the chat list shows "Amaka" instead of 2348111111111.
 *   3. Message meta — per-message status (✓/✓✓ ticks), reactions, quoted
 *      blocks, edits, deletes and poll state.
 *   4. Read state — per-chat last-read timestamp that drives unread badges.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { messageText, msgTs, digits, unwrapMessage } = require('./webChatText');

const MAX_ROWS = 500000;
const RETENTION_MS = 365 * 24 * 60 * 60 * 1000; // keep a year of history, like WhatsApp

function createWebChatStore({ dbPath, phonebookPath }) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(path.dirname(phonebookPath), { recursive: true });

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS webchat_messages (
            chat_jid  TEXT NOT NULL,
            msg_id    TEXT NOT NULL,
            from_me   INTEGER NOT NULL,
            sender    TEXT,
            push_name TEXT,
            text      TEXT,
            ts        INTEGER NOT NULL,
            PRIMARY KEY (chat_jid, msg_id)
        );
        CREATE INDEX IF NOT EXISTS idx_webchat_text ON webchat_messages(text);
        CREATE INDEX IF NOT EXISTS idx_webchat_ts ON webchat_messages(ts);
        CREATE INDEX IF NOT EXISTS idx_webchat_chat_ts ON webchat_messages(chat_jid, ts);
        CREATE TABLE IF NOT EXISTS webchat_meta (
            chat_jid   TEXT NOT NULL,
            msg_id     TEXT NOT NULL,
            status     INTEGER,
            reactions  TEXT,
            edited     INTEGER DEFAULT 0,
            deleted    INTEGER DEFAULT 0,
            quoted     TEXT,
            updated_ts INTEGER NOT NULL,
            PRIMARY KEY (chat_jid, msg_id)
        );
        CREATE TABLE IF NOT EXISTS webchat_raw (
            chat_jid TEXT NOT NULL,
            msg_id   TEXT NOT NULL,
            ts       INTEGER NOT NULL,
            body     TEXT NOT NULL,
            PRIMARY KEY (chat_jid, msg_id)
        );
        CREATE TABLE IF NOT EXISTS webchat_read (
            chat_jid     TEXT PRIMARY KEY,
            last_read_ts INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS webchat_archived (
            chat_jid TEXT PRIMARY KEY,
            archived INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS webchat_flags (
            chat_jid      TEXT PRIMARY KEY,
            pinned        INTEGER NOT NULL DEFAULT 0,
            manual_unread INTEGER NOT NULL DEFAULT 0
        );
    `);
    // Reaction rows written by earlier builds show up as "❤️ Reaction" bubbles. Remove them.
    db.prepare('DELETE FROM webchat_messages WHERE text = ?').run('❤️ Reaction');
    // Forward-only migrations for databases created by earlier phases.
    for (const sql of [
        'ALTER TABLE webchat_meta ADD COLUMN quoted TEXT',
        'ALTER TABLE webchat_meta ADD COLUMN extra TEXT',
        'ALTER TABLE webchat_messages ADD COLUMN deleted INTEGER DEFAULT 0',
    ]) {
        try { db.exec(sql); } catch (_) {}
    }

    const insertStmt = db.prepare(
        'INSERT OR REPLACE INTO webchat_messages (chat_jid, msg_id, from_me, sender, push_name, text, ts, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
    );
    const searchStmt = db.prepare(
        `SELECT chat_jid, msg_id, from_me, sender, push_name, text, ts
           FROM webchat_messages
          WHERE text LIKE ? ESCAPE '\\' AND deleted = 0 AND chat_jid NOT LIKE '%@newsletter' AND chat_jid <> 'status@broadcast'
          ORDER BY ts DESC
          LIMIT ?`
    );
    const pruneStmt = db.prepare('DELETE FROM webchat_messages WHERE ts < ?');
    const pruneMetaStmt = db.prepare('DELETE FROM webchat_meta WHERE updated_ts < ?');
    const countStmt = db.prepare('SELECT COUNT(*) AS c FROM webchat_messages');
    const pruneOverflowStmt = db.prepare(
        'DELETE FROM webchat_messages WHERE ts < (SELECT ts FROM webchat_messages ORDER BY ts DESC LIMIT 1 OFFSET ?)'
    );
    const getMetaStmt = db.prepare(
        'SELECT status, reactions, edited, deleted, quoted, extra FROM webchat_meta WHERE chat_jid = ? AND msg_id = ?'
    );
    const upsertMetaStmt = db.prepare(
        `INSERT INTO webchat_meta (chat_jid, msg_id, status, reactions, edited, deleted, quoted, extra, updated_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_jid, msg_id) DO UPDATE SET
            status = excluded.status,
            reactions = excluded.reactions,
            edited = excluded.edited,
            deleted = excluded.deleted,
            quoted = excluded.quoted,
            extra = excluded.extra,
            updated_ts = excluded.updated_ts`
    );
    const metasStmtCache = new Map();
    const getMetasStmt = (n) => {
        if (!metasStmtCache.has(n)) {
            metasStmtCache.set(n, db.prepare(
                `SELECT msg_id, status, reactions, edited, deleted, quoted, extra
                   FROM webchat_meta
                  WHERE chat_jid = ? AND msg_id IN (${Array(n).fill('?').join(',')})`
            ));
        }
        return metasStmtCache.get(n);
    };
    const setReadStmt = db.prepare(
        'INSERT INTO webchat_read (chat_jid, last_read_ts) VALUES (?, ?) ON CONFLICT(chat_jid) DO UPDATE SET last_read_ts = excluded.last_read_ts'
    );
    const getReadStmt = db.prepare('SELECT last_read_ts FROM webchat_read WHERE chat_jid = ?');
    const setArchivedStmt = db.prepare('INSERT OR REPLACE INTO webchat_archived (chat_jid, archived) VALUES (?, ?)');
    const getArchivedStmt = db.prepare('SELECT archived FROM webchat_archived WHERE chat_jid = ?');

    function setArchived(chatJid, archived) {
        try { setArchivedStmt.run(String(chatJid), archived ? 1 : 0); } catch (_) {}
    }
    function isArchived(chatJid) {
        try { return getArchivedStmt.get(String(chatJid))?.archived === 1; } catch (_) { return false; }
    }
    const updateTextStmt = db.prepare('UPDATE webchat_messages SET text = ? WHERE chat_jid = ? AND msg_id = ?');
    const markDeletedStmt = db.prepare('UPDATE webchat_messages SET deleted = 1 WHERE chat_jid = ? AND msg_id = ?');

    /* ── phonebook ─────────────────────────────────────────────────────── */
    let phonebook = {};
    try {
        phonebook = JSON.parse(fs.readFileSync(phonebookPath, 'utf8')) || {};
    } catch (_) {}
    let phonebookDirty = false;

    function savePhonebook() {
        if (!phonebookDirty) return;
        phonebookDirty = false;
        try {
            const tmp = phonebookPath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(phonebook, null, 1));
            fs.renameSync(tmp, phonebookPath);
        } catch (_) {}
    }
    setInterval(savePhonebook, 30 * 1000).unref?.();

    /* ── message index ─────────────────────────────────────────────────── */
    function logMessage(msg) {
        try {
            if (!msg?.key?.id || !msg?.key?.remoteJid) return;
            const jid = msg.key.remoteJid;
            // Reactions are not messages. They update the reacted-to message's meta
            // (webchat_meta.reactions), so they must never become rows of their own.
            if (unwrapMessage(msg.message || {}).reactionMessage) return;
            const text = messageText(msg);
            if (!text) return;
            insertStmt.run(
                jid,
                String(msg.key.id),
                msg.key.fromMe ? 1 : 0,
                msg.key.participant || jid,
                msg.pushName || '',
                text,
                msgTs(msg) || Date.now()
            );
            // Phonebook: remember the WhatsApp profile name of everyone who DMs us.
            if (!msg.key.fromMe && msg.pushName && !msg.key.participant) {
                const num = digits(jid);
                // A saved contact name (from the address book) always wins over a profile name.
                if (num && !phonebook[num]?.saved && phonebook[num]?.name !== msg.pushName) {
                    phonebook[num] = { name: msg.pushName, updated: Date.now() };
                    phonebookDirty = true;
                }
            }
        } catch (_) {}
    }

    // Optional chat scope: `jids` restricts the search to those chat addresses.
    function search(q, limit = 50, jids = null) {
        // Escape LIKE wildcards so user input can't break out of the pattern.
        const escaped = String(q).replace(/[\\%_]/g, (ch) => '\\' + ch);
        const pattern = `%${escaped}%`;
        let rows;
        if (jids && jids.length) {
            const placeholders = jids.map(() => '?').join(',');
            rows = db.prepare(
                `SELECT chat_jid, msg_id, from_me, sender, push_name, text, ts
                   FROM webchat_messages
                  WHERE text LIKE ? ESCAPE '\\' AND deleted = 0 AND chat_jid NOT LIKE '%@newsletter' AND chat_jid <> 'status@broadcast' AND chat_jid IN (${placeholders})
                  ORDER BY ts DESC LIMIT ?`
            ).all(pattern, ...jids, limit);
        } else {
            rows = searchStmt.all(pattern, limit);
        }
        return rows.map((r) => ({
            chatJid: r.chat_jid,
            msgId: r.msg_id,
            fromMe: !!r.from_me,
            sender: r.sender,
            pushName: r.push_name,
            text: r.text,
            ts: r.ts,
        }));
    }

    // Older history for infinite scroll: rows strictly before `beforeTs`.
    // Older rows strictly before the cursor (beforeTs, beforeId). Ties on the
    // timestamp are broken by msg_id so a page boundary never drops messages
    // that share a second with it. Returned oldest-first.
    function pageBefore(jids, beforeTs, limit = 50, beforeId = '') {
        const list = (jids || []).filter(Boolean);
        if (!list.length) return [];
        const placeholders = list.map(() => '?').join(',');
        const cond = beforeId ? '(ts < ? OR (ts = ? AND msg_id < ?))' : 'ts < ?';
        const params = beforeId
            ? [...list, beforeTs, beforeTs, String(beforeId), limit]
            : [...list, beforeTs, limit];
        return db.prepare(
            `SELECT chat_jid, msg_id, from_me, sender, push_name, text, ts
               FROM webchat_messages
              WHERE chat_jid IN (${placeholders}) AND ${cond} AND deleted = 0
              ORDER BY ts DESC, msg_id DESC LIMIT ?`
        ).all(...params).reverse().map((r) => ({
            id: r.msg_id,
            fromMe: !!r.from_me,
            sender: r.sender,
            pushName: r.push_name,
            text: r.text,
            ts: r.ts,
        }));
    }

    // Statuses (status@broadcast), grouped by poster, newest first.
    function statusPosters(sinceTs) {
        return db.prepare(
            `SELECT sender, MAX(push_name) AS push_name, COUNT(*) AS n, MAX(ts) AS last_ts
               FROM webchat_messages
              WHERE chat_jid = 'status@broadcast' AND from_me = 0 AND deleted = 0 AND ts > ?
              GROUP BY sender ORDER BY last_ts DESC LIMIT 200`
        ).all(Number(sinceTs) || 0).map((r) => ({
            sender: r.sender, pushName: r.push_name || '', count: r.n, lastTs: r.last_ts,
        }));
    }

    // One poster's statuses, oldest first.
    function statusItems(sender, sinceTs) {
        return db.prepare(
            `SELECT msg_id, text, ts, push_name FROM webchat_messages
              WHERE chat_jid = 'status@broadcast' AND sender = ? AND from_me = 0 AND deleted = 0 AND ts > ?
              ORDER BY ts ASC LIMIT 100`
        ).all(String(sender), Number(sinceTs) || 0).map((r) => ({
            id: r.msg_id, text: r.text || '', ts: r.ts, pushName: r.push_name || '',
        }));
    }

    function countStatusesSince(sender, sinceTs) {
        const row = db.prepare(
            "SELECT COUNT(*) AS n FROM webchat_messages WHERE chat_jid = 'status@broadcast' AND sender = ? AND from_me = 0 AND deleted = 0 AND ts > ?"
        ).get(String(sender), Number(sinceTs) || 0);
        return row ? row.n : 0;
    }

    // Channels (newsletters): one entry per channel, newest first.
    function channelList(limit = 100) {
        return db.prepare(
            `SELECT chat_jid, MAX(ts) AS last_ts FROM webchat_messages
              WHERE chat_jid LIKE '%@newsletter' AND deleted = 0
              GROUP BY chat_jid ORDER BY last_ts DESC LIMIT ?`
        ).all(limit).map((r) => ({ jid: r.chat_jid, lastTs: r.last_ts }));
    }

    // Raw message JSON (Buffers kept), so media can be downloaded after a restart.
    const RAW_BUF = '__buf64';
    function rawReplacer(k, v) {
        if (v && v.type === 'Buffer' && Array.isArray(v.data)) return { [RAW_BUF]: Buffer.from(v.data).toString('base64') };
        return v;
    }
    function rawReviver(k, v) {
        if (v && typeof v === 'object' && typeof v[RAW_BUF] === 'string') return Buffer.from(v[RAW_BUF], 'base64');
        return v;
    }
    function saveRaw(chatJid, msgId, ts, msg) {
        try {
            db.prepare('INSERT OR REPLACE INTO webchat_raw (chat_jid, msg_id, ts, body) VALUES (?, ?, ?, ?)')
                .run(String(chatJid), String(msgId), Number(ts) || Date.now(), JSON.stringify(msg, rawReplacer));
        } catch (_) {}
    }
    function getRaw(chatJid, msgId) {
        try {
            const row = db.prepare('SELECT body FROM webchat_raw WHERE chat_jid = ? AND msg_id = ?').get(String(chatJid), String(msgId));
            return row ? JSON.parse(row.body, rawReviver) : null;
        } catch (_) { return null; }
    }

    // One indexed message by id (used to quote a message after a restart).
    function getIndexed(chatJid, msgId) {
        const row = db.prepare(
            'SELECT chat_jid, msg_id, from_me, sender, text, ts FROM webchat_messages WHERE chat_jid = ? AND msg_id = ? AND deleted = 0'
        ).get(String(chatJid), String(msgId));
        return row ? { chatJid: row.chat_jid, id: row.msg_id, fromMe: !!row.from_me, sender: row.sender, text: row.text || '', ts: row.ts } : null;
    }

    // Newest indexed message of every chat — chats that exist only in SQLite (after a restart).
    function latestPerChat(limit = 200) {
        // Newest timestamp per chat (index-backed), then the row at that timestamp.
        return db.prepare(
            `SELECT w.chat_jid, w.msg_id, w.from_me, w.sender, w.push_name, w.text, w.ts
               FROM (SELECT chat_jid, MAX(ts) AS mts FROM webchat_messages WHERE deleted = 0 AND chat_jid NOT LIKE '%@newsletter' AND chat_jid <> 'status@broadcast' GROUP BY chat_jid) m
               JOIN webchat_messages w ON w.chat_jid = m.chat_jid AND w.ts = m.mts AND w.deleted = 0
              GROUP BY w.chat_jid
              ORDER BY w.ts DESC LIMIT ?`
        ).all(limit).map((r) => ({
            chatJid: r.chat_jid, id: r.msg_id, fromMe: !!r.from_me,
            sender: r.sender, pushName: r.push_name, text: r.text, ts: r.ts,
        }));
    }

    // Incoming messages newer than sinceTs — the unread count for a chat.
    function countSince(chatJids, sinceTs) {
        const list = (chatJids || []).filter(Boolean);
        if (!list.length) return 0;
        const placeholders = list.map(() => '?').join(',');
        const row = db.prepare(
            `SELECT COUNT(*) AS n FROM webchat_messages
              WHERE chat_jid IN (${placeholders}) AND from_me = 0 AND deleted = 0 AND ts > ?`
        ).get(...list, Number(sinceTs) || 0);
        return row ? row.n : 0;
    }

    function updateIndexText(chatJid, msgId, text) {
        try { updateTextStmt.run(String(text), chatJid, String(msgId)); } catch (_) {}
    }

    function markIndexDeleted(chatJid, msgId) {
        try { markDeletedStmt.run(chatJid, String(msgId)); } catch (_) {}
    }

    // Saved contact name from WhatsApp's address book (contacts.upsert / contacts.update).
    function setContactName(jid, name) {
        const num = digits(jid);
        const clean = String(name || '').trim();
        if (!num || !clean) return;
        if (phonebook[num]?.saved && phonebook[num].name === clean) return;
        phonebook[num] = { name: clean, saved: true, updated: Date.now() };
        phonebookDirty = true;
    }

    // Latest name the other side used in this chat (never one of our own messages).
    function lastIncomingName(jids) {
        const list = (jids || []).filter(Boolean);
        if (!list.length) return '';
        const placeholders = list.map(() => '?').join(',');
        const row = db.prepare(
            `SELECT push_name FROM webchat_messages
              WHERE chat_jid IN (${placeholders}) AND from_me = 0 AND deleted = 0 AND push_name <> ''
              ORDER BY ts DESC LIMIT 1`
        ).get(...list);
        return row ? row.push_name : '';
    }

    function phonebookName(jid) {
        return phonebook[digits(jid)]?.name || null;
    }

    // Last WhatsApp display name seen for a sender address (LID or PN).
    function senderName(jid) {
        try {
            const row = db.prepare(
                `SELECT push_name FROM webchat_messages
                  WHERE sender = ? AND push_name <> '' ORDER BY ts DESC LIMIT 1`
            ).get(String(jid || ''));
            return row?.push_name || null;
        } catch (_) { return null; }
    }

    /* ── message meta (status, reactions, quoted, edits, deletes, polls) ── */

    function parseJson(raw, fallback) {
        try {
            const v = JSON.parse(raw == null ? 'null' : raw);
            return v == null ? fallback : v;
        } catch (_) {
            return fallback;
        }
    }

    function rowToMeta(row) {
        const extra = parseJson(row.extra, {});
        return {
            status: row.status,
            reactions: Array.isArray(parseJson(row.reactions, [])) ? parseJson(row.reactions, []) : [],
            edited: !!row.edited,
            deleted: !!row.deleted,
            quoted: parseJson(row.quoted, null),
            editText: extra.editText ?? null,
            poll: extra.poll ?? null,
            pollSecret: extra.pollSecret ?? null,
        };
    }

    function getMsgMeta(chatJid, msgId) {
        try {
            const row = getMetaStmt.get(chatJid, String(msgId));
            return row ? rowToMeta(row) : null;
        } catch (_) {
            return null;
        }
    }

    function getMsgMetas(chatJid, msgIds) {
        const out = new Map();
        try {
            const ids = (msgIds || []).map(String).filter(Boolean);
            for (let i = 0; i < ids.length; i += 200) {
                const chunk = ids.slice(i, i + 200);
                for (const row of getMetasStmt(chunk.length).all(chatJid, ...chunk)) {
                    out.set(row.msg_id, rowToMeta(row));
                }
            }
        } catch (_) {}
        return out;
    }

    function setMsgMeta(chatJid, msgId, patch) {
        try {
            if (!chatJid || !msgId || !patch) return;
            const existing = getMsgMeta(chatJid, String(msgId)) || {
                status: null, reactions: [], edited: false, deleted: false, quoted: null,
                editText: null, poll: null, pollSecret: null,
            };
            let status = existing.status;
            if (typeof patch.status === 'number') {
                // Statuses only move forward (a hard ERROR always wins).
                if (status == null || patch.status >= status || patch.status === 0) {
                    status = patch.status;
                }
            }
            const pick = (key) => (patch[key] !== undefined ? patch[key] : existing[key]);
            const extra = {
                editText: pick('editText'),
                poll: pick('poll'),
                pollSecret: pick('pollSecret'),
            };
            upsertMetaStmt.run(
                chatJid,
                String(msgId),
                status,
                JSON.stringify(pick('reactions') || []),
                pick('edited') ? 1 : 0,
                pick('deleted') ? 1 : 0,
                pick('quoted') ? JSON.stringify(pick('quoted')) : null,
                JSON.stringify(extra),
                Date.now()
            );
        } catch (_) {}
    }

    /* ── read state (unread badges) ────────────────────────────────────── */

    // Pinned and manually-marked-unread flags, kept beside the archive flag.
    function setFlag(chatJid, column, on) {
        try {
            db.prepare(`INSERT INTO webchat_flags (chat_jid, ${column}) VALUES (?, ?)
                ON CONFLICT(chat_jid) DO UPDATE SET ${column} = excluded.${column}`)
                .run(String(chatJid), on ? 1 : 0);
        } catch (_) {}
    }
    function getFlag(chatJid, column) {
        try {
            return db.prepare(`SELECT ${column} AS v FROM webchat_flags WHERE chat_jid = ?`).get(String(chatJid))?.v === 1;
        } catch (_) { return false; }
    }

    // Newest stored message of a chat (works after a restart, unlike the memory store).
    function latestKey(chatJid) {
        try {
            const r = db.prepare(
                'SELECT msg_id, from_me, ts, sender FROM webchat_messages WHERE chat_jid = ? AND deleted = 0 ORDER BY ts DESC LIMIT 1'
            ).get(String(chatJid));
            return r ? { id: r.msg_id, fromMe: r.from_me === 1, ts: r.ts, sender: r.sender || null } : null;
        } catch (_) { return null; }
    }

    function setRead(chatJid, ts) {
        try {
            setReadStmt.run(chatJid, ts);
        } catch (_) {}
    }

    function getRead(chatJid) {
        try {
            return getReadStmt.get(chatJid)?.last_read_ts || 0;
        } catch (_) {
            return 0;
        }
    }

    // Retention: drop messages older than 30 days, cap the table at MAX_ROWS.
    setInterval(() => {
        try {
            pruneStmt.run(Date.now() - RETENTION_MS);
            pruneMetaStmt.run(Date.now() - RETENTION_MS);
            db.prepare("DELETE FROM webchat_messages WHERE chat_jid = 'status@broadcast' AND ts < ?").run(Date.now() - 2 * 24 * 60 * 60 * 1000);
            db.prepare('DELETE FROM webchat_raw WHERE ts < ?').run(Date.now() - 2 * 24 * 60 * 60 * 1000);
            const count = countStmt.get().c;
            if (count > MAX_ROWS) pruneOverflowStmt.run(MAX_ROWS);
        } catch (_) {}
    }, 6 * 60 * 60 * 1000).unref?.();

    function flush() {
        savePhonebook();
        try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_) {}
    }

    function close() {
        flush();
        try { db.close(); } catch (_) {}
    }

    return {
        logMessage,
        search,
        pageBefore,
        latestPerChat,
        getIndexed,
        saveRaw,
        getRaw,
        statusPosters,
        statusItems,
        countStatusesSince,
        channelList,
        countSince,
        senderName,
        phonebookName,
        setContactName,
        lastIncomingName,
        getMsgMeta,
        getMsgMetas,
        setMsgMeta,
        updateIndexText,
        markIndexDeleted,
        setRead,
        getRead,
        setArchived,
        isArchived,
        setFlag,
        getFlag,
        latestKey,
        flush,
        close,
    };
}

module.exports = { createWebChatStore };
