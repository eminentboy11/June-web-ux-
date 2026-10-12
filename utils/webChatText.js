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
    pollCreationMessageV2: '📊 Poll',
    pollCreationMessageV3: '📊 Poll',
    pollUpdateMessage: '📊 Poll vote',
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
            inner.documentWithCaptionMessage?.message ||
            inner.editedMessage?.message;
        if (!next) break;
        inner = next;
    }
    return inner;
}

// Mathematical Bold Italic letters (𝑻𝒉𝒆 𝒎𝒆𝒔𝒔𝒂𝒈𝒆), used for June's own notices.
function boldItalic(text) {
    return String(text).replace(/[A-Za-z]/g, (c) => {
        const code = c.charCodeAt(0);
        return c <= 'Z'
            ? String.fromCodePoint(0x1D468 + code - 65)
            : String.fromCodePoint(0x1D482 + code - 97);
    });
}

// Protocol types arrive as numbers (0, 14) or as enum names ("REVOKE", "MESSAGE_EDIT").
const PROTO_TYPE_NAMES = { REVOKE: 0, MESSAGE_EDIT: 14 };
function protoTypeOf(proto) {
    const t = proto?.type;
    if (typeof t === 'number') return t;
    if (typeof t === 'string' && t in PROTO_TYPE_NAMES) return PROTO_TYPE_NAMES[t];
    return NaN;
}

// Edit whose new text is encrypted (secretEncryptedMessage, secretEncType MESSAGE_EDIT).
function secretEditOf(inner) {
    const sem = inner?.secretEncryptedMessage;
    return sem && sem.secretEncType === 'MESSAGE_EDIT' ? sem : null;
}

const NOTICE_TEXT = {
    deleted: boldItalic('The message above was deleted but June x got you covered') + ' 😂',
    edited: boldItalic('The message above was edited but June x got you covered') + ' ✏️',
};

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
    if (inner.callLogMessage) {
        const c = inner.callLogMessage;
        return `📞 Missed ${c.isVideo ? 'video' : 'voice'} call`;
    }
    if (inner.protocolMessage) {
        // Delete-for-everyone and edit notices read as June notes, not system messages.
        const t = protoTypeOf(inner.protocolMessage);
        if (t === 0) return NOTICE_TEXT.deleted;
        if (t === 14) return NOTICE_TEXT.edited;
        return '⚙️ System message';
    }
    if (secretEditOf(inner)) return NOTICE_TEXT.edited;
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

// First contextInfo found on any message node (replies, mentions, forwards).
function firstContext(inner) {
    for (const value of Object.values(inner || {})) {
        const ctx = value && typeof value === 'object' ? value.contextInfo : null;
        if (ctx) return ctx;
    }
    return null;
}

// Quoted-reply descriptor from a message node's contextInfo (incoming
// replies carry stanzaId + participant + quotedMessage on the node).
function quotedFromContext(inner) {
    const ctx = firstContext(inner);
    if (!ctx || (!ctx.stanzaId && !ctx.quotedMessage)) return null;
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

// @mentioned JIDs of an incoming message (contextInfo.mentionedJid).
function extractMentions(inner) {
    const ctx = firstContext(inner);
    const list = ctx?.mentionedJid;
    return Array.isArray(list) ? list.map(String).filter(Boolean) : [];
}

// Forwarded label (contextInfo.forwardingScore / isForwarded).
function isForwardedMsg(inner) {
    const ctx = firstContext(inner);
    return !!(ctx && (Number(ctx.forwardingScore) > 0 || ctx.isForwarded === true));
}

// Poll card: creation info from the message + votes from the meta store.
// `meJids` (optional Set) marks the bot's own votes.
function pollDto(inner, meta, meJids) {
    const creation = inner.pollCreationMessage || inner.pollCreationMessageV2 || inner.pollCreationMessageV3;
    const stored = meta?.poll || null;
    if (!creation && !stored) return null;
    const name = creation?.name || stored?.name || '';
    const baseOptions = (creation?.options || []).map((o) => o.optionName || '').filter(Boolean);
    const optionTexts = baseOptions.length ? baseOptions : (stored?.options || []);
    if (!optionTexts.length) return null;
    const votes = stored?.votes || {};
    const isMe = (jid) => !meJids || meJids.has(String(jid));
    const options = optionTexts.map((text) => {
        const voters = Object.keys(votes).filter((jid) => (votes[jid]?.sel || []).includes(text));
        return { text, count: voters.length, voters, byMe: voters.some(isMe) };
    });
    const myEntry = Object.entries(votes).find(([jid]) => isMe(jid));
    return {
        name,
        selectableCount: creation?.selectableCount ?? stored?.selectableCount ?? 1,
        options,
        totalVotes: Object.keys(votes).length,
        myVote: myEntry ? (myEntry[1].sel || []) : [],
    };
}

// Incoming edit (protocolMessage.editedMessage) — returns the new text.
function editedTextFromProtocol(inner) {
    const proto = inner?.protocolMessage;
    if (!proto?.editedMessage) return null;
    return messageText({ message: proto.editedMessage });
}

// Incoming delete-for-everyone (protocolMessage REVOKE) — returns the key of
// the message that was deleted.
function revokedTargetKey(inner) {
    const proto = inner?.protocolMessage;
    if (!proto || protoTypeOf(proto) !== 0 || !proto.key) return null;
    return proto.key;
}

// Delete / edit notice: which message it is about (the quote target).
function noticeOf(inner, outerKey) {
    const senderChat = String(outerKey?.remoteJid || '');
    const sem = secretEditOf(inner);
    if (sem && sem.targetMessageKey?.id) {
        return {
            kind: 'edited',
            targetId: String(sem.targetMessageKey.id),
            targetChat: String(sem.targetMessageKey.remoteJid || ''),
            senderChat,
        };
    }
    const proto = inner?.protocolMessage;
    if (!proto || !proto.key?.id) return null;
    const t = protoTypeOf(proto);
    if (t !== 0 && t !== 14) return null;
    return {
        kind: t === 0 ? 'deleted' : 'edited',
        targetId: String(proto.key.id),
        targetChat: String(proto.key.remoteJid || ''),
        senderChat,
    };
}

// True for delete/edit protocol rows. They are not shown in the chat; the target
// message carries the deleted / edited state instead.
function isNoticeRow(m) {
    return !!noticeOf(unwrapMessage(m?.message || {}), m?.key);
}

// Slim DTO sent to the browser. Media messages carry a descriptor so the page
// can render them via /api/media (the text is the caption, not a label).
// `meta` (optional) attaches status ticks, reactions, quoted blocks, polls
// and edited/deleted flags. `meJids` (optional Set) marks the bot's own votes.
function slimMessage(m, meta, meJids) {
    const inner = unwrapMessage(m?.message || {});
    const media = extractMedia(inner);
    const reactions = Array.isArray(meta?.reactions) ? meta.reactions : [];
    return {
        id: m?.key?.id || '',
        fromMe: !!m?.key?.fromMe,
        sender: m?.key?.participant || m?.key?.remoteJid || '',
        pushName: m?.pushName || '',
        text: meta?.editText != null ? meta.editText : (media ? media.caption : messageText(m)),
        ts: msgTs(m) || null,
        media: media ? {
            kind: media.kind,
            mime: media.mime,
            fileName: media.fileName,
            seconds: typeof media.content?.seconds === 'number' ? media.content.seconds : null,
            waveform: media.content?.waveform ? Array.from(media.content.waveform) : null,
        } : null,
        status: meta && meta.status != null ? meta.status : null,
        reactions: reactions.map((r) => ({
            emoji: r.emoji,
            count: (r.senders || []).length,
            byMe: (r.senders || []).includes('me'),
        })),
        quoted: quotedFromContext(inner) || (meta && meta.quoted) || null,
        edited: !!(meta && meta.edited),
        deleted: !!(meta && meta.deleted),
        mentions: extractMentions(inner),
        forwarded: isForwardedMsg(inner),
        poll: pollDto(inner, meta, meJids),
        notice: noticeOf(inner, m?.key),
        history: false,
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
    extractMentions,
    isForwardedMsg,
    pollDto,
    editedTextFromProtocol,
    revokedTargetKey,
    noticeOf,
    isNoticeRow,
    protoTypeOf,
    secretEditOf,
    slimMessage,
};
