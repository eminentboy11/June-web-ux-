/**
 * June-X Ultra — Web Chat text/media helpers (utils/webChatText.js)
 *
 * Pure functions shared by the web chat server (webChat.js) and the
 * search/phonebook store (webChatStore.js). No I/O in here.
 */
'use strict';

const MEDIA_MAP = {
    imageMessage: 'image',
    videoMessage: 'video',
    audioMessage: 'audio',
    stickerMessage: 'sticker',
    documentMessage: 'document',
};

const MEDIA_LABELS = {
    imageMessage: '🖼️ Photo',
    videoMessage: '🎬 Video',
    audioMessage: '🎵 Audio',
    stickerMessage: '🩹 Sticker',
    documentMessage: '📄 Document',
    locationMessage: '📍 Location',
    liveLocationMessage: '📍 Live location',
    contactMessage: '👤 Contact',
    contactsArrayMessage: '👤 Contacts',
    pollCreationMessage: '📊 Poll',
    pollUpdateMessage: '📊 Poll update',
    reactionMessage: '❤️ Reaction',
    editedMessage: '✏️ Edited message',
};

const DEFAULT_MIME = {
    image: 'image/jpeg',
    video: 'video/mp4',
    audio: 'audio/ogg',
    sticker: 'image/webp',
    document: 'application/octet-stream',
};

// Unwrap ephemeral / view-once / document-with-caption wrappers.
function unwrapMessage(m) {
    let inner = m || {};
    for (let i = 0; i < 5 && inner; i++) {
        const next =
            inner.ephemeralMessage?.message ||
            inner.viewOnceMessage?.message ||
            inner.viewOnceMessageV2?.message ||
            inner.viewOnceMessageV2Extension?.message ||
            inner.documentWithCaptionMessage?.message;
        if (!next) break;
        inner = next;
    }
    return inner;
}

function messageText(msg) {
    if (!msg || !msg.message) return '';
    const inner = unwrapMessage(msg.message);
    if (inner.conversation) return String(inner.conversation);
    if (inner.extendedTextMessage?.text) return String(inner.extendedTextMessage.text);
    for (const [key, label] of Object.entries(MEDIA_LABELS)) {
        if (inner[key]) {
            const caption = inner[key].caption;
            return caption ? `${label}: ${caption}` : label;
        }
    }
    if (inner.protocolMessage) return '⚙️ System message';
    if (msg.messageStubType != null) return '⚙️ Notification';
    return '· Unsupported message ·';
}

// Find downloadable media in an (already unwrapped) message body.
function extractMedia(inner) {
    for (const [key, kind] of Object.entries(MEDIA_MAP)) {
        const content = inner?.[key];
        if (content) {
            return {
                kind,
                mime: content.mimetype || DEFAULT_MIME[kind],
                fileName: content.fileName || null,
                caption: content.caption || '',
                content,
            };
        }
    }
    return null;
}

function msgTs(m) {
    return m?.messageTimestamp ? Number(m.messageTimestamp) * 1000 : 0;
}

function digits(v) {
    return String(v || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

// Slim DTO sent to the browser. Media messages carry a descriptor so the page
// can render them via /api/media (the text is the caption, not a label).
function slimMessage(m) {
    const inner = unwrapMessage(m?.message || {});
    const media = extractMedia(inner);
    return {
        id: m?.key?.id || '',
        fromMe: !!m?.key?.fromMe,
        sender: m?.key?.participant || m?.key?.remoteJid || '',
        pushName: m?.pushName || '',
        text: media ? media.caption : messageText(m),
        ts: msgTs(m) || null,
        media: media ? { kind: media.kind, mime: media.mime, fileName: media.fileName } : null,
    };
}

module.exports = {
    MEDIA_MAP,
    MEDIA_LABELS,
    DEFAULT_MIME,
    unwrapMessage,
    messageText,
    extractMedia,
    msgTs,
    digits,
    slimMessage,
};
