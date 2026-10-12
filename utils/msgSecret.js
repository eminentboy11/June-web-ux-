'use strict';

// Decrypts WhatsApp "secretEncryptedMessage" payloads (message edits), following
// whatsmeow's generateMsgSecretKey / decryptMsgSecret:
//   key  = HKDF-SHA256(origMsgSecret, salt = none,
//                      info = origMsgId + origSender + modSender + "Message Edit")
//   data = AES-256-GCM(key, iv, payload) with no additional data (tag is the last 16 bytes).
const crypto = require('crypto');

const USE_CASE = 'Message Edit';

function toBuf(v) {
    if (v == null) return null;
    if (typeof v === 'string') return Buffer.from(v, 'base64');
    return Buffer.from(v);
}

// JID without the device suffix (what WhatsApp uses in the derivation).
function nonAD(jid) {
    return String(jid || '').replace(/:\d+@/, '@');
}

function decryptEdit({ encPayload, encIv, targetId, secret, origSenders, modSenders }) {
    const payload = toBuf(encPayload);
    const iv = toBuf(encIv);
    const base = toBuf(secret);
    if (!payload || payload.length < 17 || !iv || !base) return null;
    const tag = payload.subarray(payload.length - 16);
    const body = payload.subarray(0, payload.length - 16);
    for (const o of origSenders) {
        for (const m of modSenders) {
            const info = Buffer.concat([
                Buffer.from(String(targetId)),
                Buffer.from(nonAD(o)),
                Buffer.from(nonAD(m)),
                Buffer.from(USE_CASE),
            ]);
            const key = Buffer.from(crypto.hkdfSync('sha256', base, Buffer.alloc(0), info, 32));
            try {
                const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
                d.setAuthTag(tag);
                return Buffer.concat([d.update(body), d.final()]);
            } catch (_) { /* wrong sender form: try the next one */ }
        }
    }
    return null;
}

// Encrypt the way WhatsApp does (used only by the test).
function encryptEdit({ plaintext, targetId, secret, origSender, modSender, iv }) {
    const base = toBuf(secret);
    const info = Buffer.concat([
        Buffer.from(String(targetId)), Buffer.from(nonAD(origSender)),
        Buffer.from(nonAD(modSender)), Buffer.from(USE_CASE),
    ]);
    const key = Buffer.from(crypto.hkdfSync('sha256', base, Buffer.alloc(0), info, 32));
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([c.update(plaintext), c.final()]);
    return Buffer.concat([body, c.getAuthTag()]);
}

module.exports = { decryptEdit, encryptEdit, nonAD, toBuf };
