/**
 * ToURL Command
 * Upload any file to pone.rs via URL or quoted media (permanent hosting)
 */

const axios = require('axios');
const FormData = require('form-data');
const { sendButtons } = require('gifted-btns');

// Baileys helper
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const database = require('../../database');

const PONE_BASE = 'https://pone.rs';

// pone.rs is a pomf-style host. Try the known endpoint shapes in order.
const UPLOAD_ATTEMPTS = [
    { endpoint: `${PONE_BASE}/upload.php`, field: 'files[]' },
    { endpoint: `${PONE_BASE}/upload`,     field: 'files[]' },
    { endpoint: `${PONE_BASE}/upload`,     field: 'file' }
];

/**
 * Pull a hosted URL out of whatever pone.rs returns (JSON or plain text)
 */
function extractUrl(data) {
    if (!data) return null;

    if (typeof data === 'string') {
        const trimmed = data.trim();
        try {
            return extractUrl(JSON.parse(trimmed));
        } catch {
            const match = trimmed.match(/https?:\/\/[^\s"'<>]+/);
            return match ? match[0] : null;
        }
    }

    if (Array.isArray(data)) {
        for (const item of data) {
            const found = extractUrl(item);
            if (found) return found;
        }
        return null;
    }

    if (typeof data === 'object') {
        if (typeof data.url === 'string' && data.url.startsWith('http')) return data.url;
        if (data.files) {
            const found = extractUrl(data.files);
            if (found) return found;
        }
        if (data.data) {
            const found = extractUrl(data.data);
            if (found) return found;
        }
        if (typeof data.url === 'string') return `${PONE_BASE}/${data.url.replace(/^\//, '')}`;
    }

    return null;
}

async function uploadToPone(fileBuffer, fileName, contentType) {
    let lastError;

    for (const { endpoint, field } of UPLOAD_ATTEMPTS) {
        try {
            const form = new FormData();
            form.append(field, fileBuffer, {
                filename: fileName,
                contentType: contentType
            });

            const { data } = await axios.post(endpoint, form, {
                headers: {
                    ...form.getHeaders(),
                    'User-Agent': 'Mozilla/5.0'
                },
                timeout: 60000,
                maxBodyLength: Infinity,
                maxContentLength: Infinity
            });

            const url = extractUrl(data);
            if (url) return url;

            lastError = new Error('Unexpected response from pone.rs');
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error('Upload failed or was rejected by pone.rs');
}

module.exports = {
    name: 'tourl',
    aliases: ['pone', 'upload', 'tolink'],
    category: 'tools',
    description: 'Upload a file to pone.rs via URL or quoted media (permanent hosting)',
    usage: '.tourl <file-url> or reply to media',

    async execute(sock, msg, args, extra) {
        try {
            await sock.sendMessage(extra.from, { react: { text: '⏳', key: msg.key } });

            let fileBuffer, fileName, contentType, fileSizeKB;

            // ─── MODE 1: Quoted Media ───────────────────────────────
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (quoted) {
                const mediaType =
                    quoted.imageMessage     ? 'imageMessage'     :
                    quoted.videoMessage     ? 'videoMessage'     :
                    quoted.audioMessage     ? 'audioMessage'     :
                    quoted.documentMessage  ? 'documentMessage'  :
                    quoted.stickerMessage   ? 'stickerMessage'   :
                    null;

                if (!mediaType) return extra.reply('❌ Quoted message has no supported media!');

                const mediaMsg = quoted[mediaType];
                const fakeMsg = {
                    key: msg.message.extendedTextMessage.contextInfo.stanzaId
                        ? { ...msg.key, id: msg.message.extendedTextMessage.contextInfo.stanzaId }
                        : msg.key,
                    message: quoted
                };

                // Use Baileys downloadMediaMessage
                fileBuffer = await downloadMediaMessage(fakeMsg, 'buffer', {}, { logger: sock.logger });
                contentType = mediaMsg.mimetype || 'application/octet-stream';
                const ext = contentType.split('/')[1]?.split(';')[0] || 'bin';
                fileName = mediaMsg.fileName || `upload_${Date.now()}.${ext}`;
                fileSizeKB = (fileBuffer.byteLength / 1024).toFixed(1);

            // ─── MODE 2: URL Argument ───────────────────────────────
            } else {
                const url = args.join(' ').trim();
                if (!url) return extra.reply(
                    '❌ Please provide a file URL or reply to a media message!\nExample:\n.tourl https://example.com/image.png'
                );

                const fileResponse = await axios.get(url, {
                    responseType: 'arraybuffer',
                    timeout: 30000,
                    maxContentLength: 200 * 1024 * 1024 // 200MB limit
                });

                const contentDisposition = fileResponse.headers['content-disposition'];
                if (contentDisposition) {
                    const match = contentDisposition.match(/filename="?([^";\n]+)"?/);
                    if (match) fileName = match[1].trim();
                }
                if (!fileName) {
                    const urlPath = url.split('?')[0];
                    fileName = urlPath.split('/').pop() || `upload_${Date.now()}`;
                }

                contentType = fileResponse.headers['content-type'] || 'application/octet-stream';
                fileBuffer = Buffer.from(fileResponse.data);
                fileSizeKB = (fileBuffer.byteLength / 1024).toFixed(1);
            }

            // ─── Upload to pone.rs ──────────────────────────────────
            const hostedUrl = await uploadToPone(fileBuffer, fileName, contentType);

            if (!hostedUrl || !hostedUrl.startsWith('http')) {
                throw new Error('Upload failed or was rejected by pone.rs');
            }

            await sock.sendMessage(extra.from, { react: { text: '✅', key: msg.key } });

            const hostedName = hostedUrl.split('/').pop();
            const responseText =
                ` *📦 File Hosted on pone.rs*\n\n` +
                ` *File:* ${hostedName}\n` +
                ` *Size:* ${fileSizeKB} KB\n` +
                ` *Hosted:* ${hostedUrl}\n\n` +
                ` ♾️ _This link is permanent_`;

            await sendButtons(sock, extra.from, {
                text: responseText,
                footer: `> Powered by ${database.getBotSetting('botName')}`,
                buttons: [
                    {
                        name: 'cta_url',
                        buttonParamsJson: JSON.stringify({
                            display_text: '🌐 Open File',
                            url: hostedUrl
                        })
                    },
                    {
                        name: 'cta_copy',
                        buttonParamsJson: JSON.stringify({
                            display_text: '📋 Copy Link',
                            copy_code: hostedUrl
                        })
                    }
                ]
            }, { quoted: msg });

        } catch (error) {
            console.error('TOURL ERROR:', error);
            await sock.sendMessage(extra.from, { react: { text: '❌', key: msg.key } });

            let errMsg = '❌ Failed to upload to pone.rs: ';
            if (error.code === 'ECONNABORTED') errMsg += 'Request timed out (file may be too large)';
            else if (error.code === 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED') errMsg += 'File exceeds the 200MB limit';
            else errMsg += (error.message || 'Unknown error');

            await extra.reply(errMsg);
        }
    }
};
