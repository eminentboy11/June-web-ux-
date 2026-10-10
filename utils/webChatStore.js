/**
 * June-X Ultra — Web Chat persistence (utils/webChatStore.js)
 *
 * Two jobs:
 *   1. Message search index — every incoming/outgoing message is written to a
 *      small SQLite database (better-sqlite3, already a project dependency) so
 *      the web chat can search history that survives restarts.
 *   2. Phonebook — number → WhatsApp profile name (pushName), persisted to a
 *      JSON file, so the chat list shows "Amaka" instead of 2348111111111.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { messageText, msgTs, digits } = require('./webChatText');

const MAX_ROWS = 100000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // keep 30 days of history

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
    `);

    const insertStmt = db.prepare(
        'INSERT OR REPLACE INTO webchat_messages (chat_jid, msg_id, from_me, sender, push_name, text, ts) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const searchStmt = db.prepare(
        `SELECT chat_jid, msg_id, from_me, sender, push_name, text, ts
           FROM webchat_messages
          WHERE text LIKE ? ESCAPE '\\'
          ORDER BY ts DESC
          LIMIT ?`
    );
    const pruneStmt = db.prepare('DELETE FROM webchat_messages WHERE ts < ?');
    const countStmt = db.prepare('SELECT COUNT(*) AS c FROM webchat_messages');
    const pruneOverflowStmt = db.prepare(
        'DELETE FROM webchat_messages WHERE ts < (SELECT ts FROM webchat_messages ORDER BY ts DESC LIMIT 1 OFFSET ?)'
    );

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
            if (jid === 'status@broadcast') return;
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
            if (!msg.key.fromMe && msg.pushName) {
                const num = digits(jid);
                if (num && phonebook[num]?.name !== msg.pushName) {
                    phonebook[num] = { name: msg.pushName, updated: Date.now() };
                    phonebookDirty = true;
                }
            }
        } catch (_) {}
    }

    function search(q, limit = 50) {
        // Escape LIKE wildcards so user input can't break out of the pattern.
        const escaped = String(q).replace(/[\\%_]/g, (ch) => '\\' + ch);
        return searchStmt.all(`%${escaped}%`, limit).map((r) => ({
            chatJid: r.chat_jid,
            msgId: r.msg_id,
            fromMe: !!r.from_me,
            sender: r.sender,
            pushName: r.push_name,
            text: r.text,
            ts: r.ts,
        }));
    }

    function phonebookName(jid) {
        return phonebook[digits(jid)]?.name || null;
    }

    // Retention: drop messages older than 30 days, cap the table at MAX_ROWS.
    setInterval(() => {
        try {
            pruneStmt.run(Date.now() - RETENTION_MS);
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

    return { logMessage, search, phonebookName, flush, close };
}

module.exports = { createWebChatStore };
