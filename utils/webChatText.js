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

// WhatsApp message status (proto.WebMessageInfo.Status) — drives the
// ✓ / ✓✓ / blue ✓✓ ticks on our own messages.
const STATUS = {
    ERROR: 0,
    PENDING: 1,
    SERVER_ACK: 2,
    DELIVERY_ACK: 3,
    READ: 4,
    PLAYED: 5,
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

// Apply one reaction update to a reactions list ([{ emoji, senders: [] }]).
// WhatsApp allows a single reaction per user: a new emoji replaces their
// previous one, and an empty emoji removes it. Returns a new list.
function applyReaction(reactions, emoji, sender) {
    let list = Array.isArray(reactions)
        ? reactions.map((r) => ({ emoji: r.emoji, senders: [...(r.senders || [])] }))
        : [];
    list = list
        .map((r) => ({ emoji: r.emoji, senders: r.senders.filter((s) => s !== sender) }))
        .filter((r) => r.senders.length > 0);
    const target = typeof emoji === 'string' ? emoji.trim() : '';
    if (!target) return list;
    const existing = list.find((r) => r.emoji === target);
    if (existing) existing.senders.push(sender);
    else list.push({ emoji: target, senders: [sender] });
    return list;
}

// Quoted-reply descriptor from a message node's contextInfo (incoming
// replies carry stanzaId + participant + quotedMessage on the node).
function quotedFromContext(inner) {
    for (const value of Object.values(inner || {})) {
        const ctx = value && typeof value === 'object' ? value.contextInfo : null;
        if (!ctx || (!ctx.stanzaId && !ctx.quotedMessage)) continue;
        const qm = ctx.quotedMessage || {};
        const media = extractMedia(unwrapMessage(qm));
        return {
            id: String(ctx.stanzaId || ''),
            sender: ctx.participant || '',
            pushName: '',
            text: media ? (media.caption || '') : messageText({ message: qm }),
            mediaKind: media ? media.kind : null,
            fromMe: null,
        };
    }
    return null;
}

// Quoted-reply descriptor from a full message (fallback for sent echoes
// that do not carry contextInfo).
function quotedDescriptor(msg) {
    const inner = unwrapMessage(msg?.message || {});
    const media = extractMedia(inner);
    return {
        id: msg?.key?.id || '',
        sender: msg?.key?.participant || msg?.key?.remoteJid || '',
        pushName: msg?.pushName || '',
        text: media ? (media.caption || '') : messageText(msg),
        mediaKind: media ? media.kind : null,
        fromMe: !!msg?.key?.fromMe,
    };
}

// Slim DTO sent to the browser. Media messages carry a descriptor so the page
// can render them via /api/media (the text is the caption, not a label).
// `meta` (optional) attaches status ticks, reactions, quoted blocks and
// edited/deleted flags.
function slimMessage(m, meta) {
    const inner = unwrapMessage(m?.message || {});
    const media = extractMedia(inner);
    const reactions = Array.isArray(meta?.reactions) ? meta.reactions : [];
    return {
        id: m?.key?.id || '',
        fromMe: !!m?.key?.fromMe,
        sender: m?.key?.participant || m?.key?.remoteJid || '',
        pushName: m?.pushName || '',
        text: media ? media.caption : messageText(m),
        ts: msgTs(m) || null,
        media: media ? { kind: media.kind, mime: media.mime, fileName: media.fileName } : null,
        status: meta && meta.status != null ? meta.status : null,
        reactions: reactions.map((r) => ({
            emoji: r.emoji,
            count: (r.senders || []).length,
            byMe: (r.senders || []).includes('me'),
        })),
        quoted: quotedFromContext(inner) || (meta && meta.quoted) || null,
        edited: !!(meta && meta.edited),
        deleted: !!(meta && meta.deleted),
    };
}

module.exports = {
    MEDIA_MAP,
    MEDIA_LABELS,
    DEFAULT_MIME,
    STATUS,
    unwrapMessage,
    messageText,
    extractMedia,
    msgTs,
    digits,
    applyReaction,
    quotedFromContext,
    quotedDescriptor,
    slimMessage,
};
