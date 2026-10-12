'use strict';

// Debug log of the full raw WhatsApp message structure, every message, unfiltered.
// Remove once the edit and delete shapes are confirmed.
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

function logRawShape(where, msgs) {
    try {
        for (const msg of Array.isArray(msgs) ? msgs : [msgs]) {
            console.log(`${TAG} ${where}\n${JSON.stringify(msg, safeReplacer, 2)}`);
        }
    } catch (e) {
        console.log(`${TAG} ${where} could not stringify: ${e.message}`);
    }
}

module.exports = { logRawShape };
