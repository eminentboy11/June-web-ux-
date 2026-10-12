'use strict';

// Debug log of the raw WhatsApp message structure for protocol / edit / unknown
// messages. Remove once the edit and delete shapes are confirmed.
const TAG = '[RAW-SHAPE]';

function safeReplacer(_key, value) {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[bytes ${value.length}]`;
    // JSON.stringify runs toJSON() before this replacer, so Buffers arrive as { type, data }.
    if (value && value.type === 'Buffer' && Array.isArray(value.data)) return `[bytes ${value.data.length}]`;
    if (typeof value === 'bigint') return value.toString();
    if (value && typeof value === 'object' && typeof value.toNumber === 'function' && value.low !== undefined) {
        return value.toString(); // protobuf Long
    }
    return value;
}

// True when the message body holds something the web chat does not already understand.
function isInteresting(msg) {
    const m = msg?.message;
    if (!m) return false;
    if (m.protocolMessage || m.editedMessage || m.encReactionMessage) return true;
    if (msg.update?.message?.editedMessage || msg.update?.message?.protocolMessage) return true;
    const known = ['conversation', 'extendedTextMessage', 'reactionMessage', 'pollUpdateMessage',
        'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage',
        'locationMessage', 'liveLocationMessage', 'contactMessage', 'contactsArrayMessage',
        'pollCreationMessage', 'pollCreationMessageV2', 'pollCreationMessageV3', 'ephemeralMessage',
        'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage',
        'callLogMessage', 'buttonsResponseMessage', 'listResponseMessage', 'templateButtonReplyMessage',
        'messageContextInfo', 'senderKeyDistributionMessage'];
    return !Object.keys(m).some((k) => known.includes(k));
}

function logRawShape(where, msgs) {
    try {
        for (const msg of Array.isArray(msgs) ? msgs : [msgs]) {
            if (!isInteresting(msg)) continue;
            console.log(`${TAG} ${where}\n${JSON.stringify(msg, safeReplacer, 2)}`);
        }
    } catch (e) {
        console.log(`${TAG} ${where} could not stringify: ${e.message}`);
    }
}

module.exports = { logRawShape };
