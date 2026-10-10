/**
 * June-X Ultra — WhatsApp poll vote crypto (utils/webChatPoll.js)
 *
 * Mirrors Baileys' decryptPollVote (src/Utils/process-message.ts) and adds the
 * inverse so the web UI can cast votes. Pure functions, no Baileys import.
 *
 *   vote key  = HMAC( HMAC(pollEncKey, 32×0x00), "<pollMsgId><creator><voter>Poll Vote\x01" )
 *   payload   = AES-256-GCM(key, iv, aad = "<pollMsgId>\0<voter>")  (ciphertext ‖ 16-byte tag)
 *   plaintext = PollVoteMessage { repeated bytes selectedOptions = 1 }
 *               where each option is sha256(optionName)
 *
 * Caveat (from upstream Baileys issue #2342): WhatsApp uses LID for the poll
 * creator and PN for the voter in 1:1 chats. Callers should try the candidate
 * JID combinations; a wrong combination simply fails the GCM tag check.
 */
'use strict';

const crypto = require('crypto');

const ZEROS32 = Buffer.alloc(32);

function hmac(data, key) {
    return crypto.createHmac('sha256', key).update(data).digest();
}

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest();
}

function deriveKey(pollEncKey, pollMsgId, creatorJid, voterJid) {
    const enc = Buffer.isBuffer(pollEncKey) ? pollEncKey : Buffer.from(pollEncKey, 'base64');
    const key0 = hmac(enc, ZEROS32);                       // hmacSign(pollEncKey, zeros) in Baileys
    const sign = Buffer.concat([
        Buffer.from(String(pollMsgId)),
        Buffer.from(String(creatorJid)),
        Buffer.from(String(voterJid)),
        Buffer.from('Poll Vote'),
        Buffer.from([1]),
    ]);
    return hmac(sign, key0);                               // hmacSign(sign, key0)
}

function aad(pollMsgId, voterJid) {
    return Buffer.from(`${pollMsgId}\u0000${voterJid}`);
}

// Option hash used by WhatsApp (and by Baileys' getAggregateVotesInPollMessage).
function optionHash(name) {
    return sha256(Buffer.from(String(name)));
}

/* ── minimal protobuf for PollVoteMessage { repeated bytes selectedOptions = 1 } ── */

function encodeVarint(n) {
    const out = [];
    let v = n >>> 0;
    while (v > 0x7f) {
        out.push((v & 0x7f) | 0x80);
        v >>>= 7;
    }
    out.push(v);
    return Buffer.from(out);
}

function decodeVarint(buf, pos) {
    let result = 0, shift = 0, p = pos;
    for (;;) {
        if (p >= buf.length) throw new Error('truncated varint');
        const b = buf[p++];
        result += (b & 0x7f) * Math.pow(2, shift);
        if (!(b & 0x80)) break;
        shift += 7;
        if (shift > 35) throw new Error('varint too long');
    }
    return [result, p];
}

function encodePollVote(optionNames) {
    const parts = [];
    for (const name of optionNames || []) {
        const h = optionHash(name);
        parts.push(Buffer.from([0x0a]), encodeVarint(h.length), h);
    }
    return Buffer.concat(parts);
}

function decodePollVote(buf) {
    const selected = [];
    let pos = 0;
    while (pos < buf.length) {
        const [tag, p1] = decodeVarint(buf, pos);
        const field = tag >>> 3;
        const wire = tag & 7;
        if (field === 1 && wire === 2) {
            const [len, p2] = decodeVarint(buf, p1);
            selected.push(buf.subarray(p2, p2 + len));
            pos = p2 + len;
        } else {
            // Skip unknown fields safely (varint or length-delimited only).
            if (wire === 0) { const [, p2] = decodeVarint(buf, p1); pos = p2; }
            else if (wire === 2) { const [len, p2] = decodeVarint(buf, p1); pos = p2 + len; }
            else break;
        }
    }
    return selected;
}

/* ── encrypt / decrypt ─────────────────────────────────────────────────── */

function encryptPollVote(ctx, optionNames) {
    const { pollEncKey, pollMsgId, pollCreatorJid, voterJid } = ctx;
    const key = deriveKey(pollEncKey, pollMsgId, pollCreatorJid, voterJid);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(pollMsgId, voterJid));
    const body = Buffer.concat([cipher.update(encodePollVote(optionNames)), cipher.final()]);
    return { encPayload: Buffer.concat([body, cipher.getAuthTag()]), encIv: iv };
}

// Returns the selected option hashes (Buffers), or throws on a wrong key.
function decryptPollVote({ encPayload, encIv }, ctx) {
    const { pollEncKey, pollMsgId, pollCreatorJid, voterJid } = ctx;
    const key = deriveKey(pollEncKey, pollMsgId, pollCreatorJid, voterJid);
    const payload = Buffer.from(encPayload);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(encIv));
    decipher.setAAD(aad(pollMsgId, voterJid));
    decipher.setAuthTag(payload.subarray(payload.length - 16));
    const plain = Buffer.concat([decipher.update(payload.subarray(0, payload.length - 16)), decipher.final()]);
    return decodePollVote(plain);
}

// Try candidate creator/voter JID combinations until the tag verifies.
function decryptPollVoteAny(vote, { pollEncKey, pollMsgId, creatorJids, voterJids }) {
    for (const creatorJid of creatorJids) {
        for (const voterJid of voterJids) {
            try {
                return { selected: decryptPollVote(vote, { pollEncKey, pollMsgId, pollCreatorJid: creatorJid, voterJid }), voterJid };
            } catch (_) {}
        }
    }
    return null;
}

// Map option hashes back to option names.
function namesFromHashes(hashes, optionNames) {
    const byHash = new Map(optionNames.map((n) => [optionHash(n).toString('hex'), n]));
    return hashes.map((h) => byHash.get(Buffer.from(h).toString('hex'))).filter(Boolean);
}

module.exports = {
    optionHash,
    encodePollVote,
    decodePollVote,
    encryptPollVote,
    decryptPollVote,
    decryptPollVoteAny,
    namesFromHashes,
};
