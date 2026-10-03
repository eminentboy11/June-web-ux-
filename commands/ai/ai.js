/**
 * AI Commands — powered by ravenn.site (Keith APIs)
 * All commands in a single array export.
 */

const axios = require('axios');
const FormData = require('form-data');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

const BASE = 'https://apiskeith2-production-3679.up.railway.app';

const react = (sock, msg, emoji) =>
    sock.sendMessage(msg.key.remoteJid, { react: { text: emoji, key: msg.key } });

const send = (sock, msg, text) =>
    sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });

function cleanResult(result) {
    if (result == null) return '';
    if (typeof result === 'string') return result.trim();
    if (typeof result === 'number' || typeof result === 'boolean') return String(result);

    if (Array.isArray(result)) {
        return result.map(r => cleanResult(r)).filter(Boolean).join('\n\n');
    }

    if (typeof result === 'object') {
        const candidate =
            result.text ?? result.message ?? result.response ?? result.answer ??
            result.result ?? result.output ?? result.content ?? result.reply ?? null;
        if (candidate != null) return cleanResult(candidate);
        return Object.entries(result)
            .filter(([, v]) => v != null && typeof v !== 'object')
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n') || JSON.stringify(result);
    }

    return String(result);
}

async function ravenn(url, params = {}) {
    const { data } = await axios.get(url, { params, timeout: 60000 });
    if (!data || !data.status) throw new Error(data?.err || data?.error || 'Service temporarily unavailable');
    if (data.result && typeof data.result === 'object' && data.result.status === false) {
        throw new Error(data.result.err || data.result.error || 'API error from upstream');
    }
    return data.result;
}

async function ravennBinary(url, params = {}) {
    const resp = await axios.get(url, {
        params,
        responseType: 'arraybuffer',
        timeout: 60000,
    });
    const raw = Buffer.from(resp.data);

    if (raw.length < 2048) {
        let json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch { }
        if (json && json.status === false) {
            throw new Error(json.err || json.error || 'API returned an error instead of an image');
        }
    }
    return raw;
}

async function uploadToUguu(buffer, filename = 'image.jpg', contentType = 'image/jpeg') {
    const form = new FormData();
    form.append('files[]', buffer, { filename, contentType });
    const { data } = await axios.post('https://uguu.se/upload', form, {
        headers: form.getHeaders(),
        timeout: 30000,
    });
    const fileEntry = Array.isArray(data) ? data[0]
        : Array.isArray(data?.files) ? data.files[0]
        : null;
    const url = fileEntry?.url;
    if (!url) throw new Error('Failed to upload file to Uguu');
    return url;
}

function getContextInfo(msg) {
    const m = msg.message || {};
    return (
        m.extendedTextMessage?.contextInfo ||
        m.imageMessage?.contextInfo ||
        m.videoMessage?.contextInfo ||
        m.audioMessage?.contextInfo ||
        m.documentMessage?.contextInfo ||
        null
    );
}

async function downloadQuoted(sock, msg, ctx, quotedMsg) {
    const target = {
        key: { remoteJid: msg.key.remoteJid, id: ctx.stanzaId, participant: ctx.participant },
        message: quotedMsg,
    };
    return downloadMediaMessage(target, 'buffer', {}, {
        logger: undefined,
        reuploadRequest: sock.updateMediaMessage,
    });
}

async function resolveImageUrl(sock, msg, args) {
    if (args[0] && /^https?:\/\//i.test(args[0])) {
        return { url: args[0], remainingArgs: args.slice(1) };
    }
    const ctx = getContextInfo(msg);
    const quotedMsg = ctx?.quotedMessage;
    const imageMsg = quotedMsg?.imageMessage || quotedMsg?.stickerMessage;
    if (!imageMsg) return { url: null, remainingArgs: args };
    const buffer = await downloadQuoted(sock, msg, ctx, quotedMsg);
    if (!buffer || !buffer.length) throw new Error('Could not download image from the replied message');
    const url = await uploadToUguu(buffer);
    return { url, remainingArgs: args };
}

async function resolveAudioUrl(sock, msg, args) {
    if (args[0] && /^https?:\/\//i.test(args[0])) {
        return { url: args[0], remainingArgs: args.slice(1) };
    }
    const ctx = getContextInfo(msg);
    const quotedMsg = ctx?.quotedMessage;
    const audioMsg = quotedMsg?.audioMessage;
    if (!audioMsg) return { url: null, remainingArgs: args };
    const buffer = await downloadQuoted(sock, msg, ctx, quotedMsg);
    if (!buffer || !buffer.length) throw new Error('Could not download audio from the replied message');
    const mimetype = audioMsg.mimetype || 'audio/ogg';
    const ext = mimetype.includes('mpeg') ? 'mp3' : mimetype.includes('mp4') ? 'm4a' : 'ogg';
    const url = await uploadToUguu(buffer, `audio.${ext}`, mimetype);
    return { url, remainingArgs: args };
}

function chatCommand({ name, aliases, emoji, label, description, usage, example, path }) {
    return {
        name,
        aliases,
        category: 'ai',
        description,
        usage,
        apiUrl: `${BASE}${path}`,
        async execute(sock, msg, args, extra) {
            const query = args.join(' ').trim();
            if (!query) return extra.reply(`❌ Please provide a question\n\nExample: ${example}`);
            await react(sock, msg, emoji);
            try {
                const result = await ravenn(this.apiUrl, { q: query });
                const text = cleanResult(result);
                if (!text) throw new Error('Empty response from the AI');
                await send(sock, msg, `${emoji} *${label}*\n\n${text}`);
                await react(sock, msg, '✅');
            } catch (err) {
                console.error(`[${name}]`, err.message);
                await react(sock, msg, '❌');
                extra.reply(`❌ ${label} error: ${err.message}`);
            }
        },
    };
}

module.exports = [

    chatCommand({
        name: 'ai',
        aliases: ['keithai', 'supremeai'],
        emoji: '⚡',
        label: 'Keith AI',
        description: 'Ask Keith AI (custom model) a question',
        usage: '.ai <question>',
        example: '.ai How does the internet work?',
        path: '/keithai',
    }),

    chatCommand({
        name: 'chatgpt',
        aliases: ['gpt', 'gpt2', 'gptai'],
        emoji: '🤖',
        label: 'ChatGPT',
        description: 'Ask GPT AI a question',
        usage: '.chatgpt <question>',
        example: '.chatgpt What is JavaScript?',
        path: '/ai/gpt',
    }),

    chatCommand({
        name: 'gpt4o',
        aliases: ['gpt4', 'chatgpt4', 'gpt4nano', 'gpt41nano'],
        emoji: '🤖',
        label: 'GPT-4',
        description: 'Ask GPT-4 a question',
        usage: '.gpt4o <question>',
        example: '.gpt4o How does a black hole form?',
        path: '/ai/chatgpt4',
    }),

    chatCommand({
        name: 'claude',
        aliases: ['claudeai'],
        emoji: '🧠',
        label: 'Claude AI',
        description: 'Ask Claude AI a question',
        usage: '.claude <question>',
        example: '.claude Explain recursion',
        path: '/ai/claudeai',
    }),

    chatCommand({
        name: 'gemini',
        aliases: ['geminai'],
        emoji: '♊',
        label: 'Google Gemini',
        description: 'Ask Google Gemini a question',
        usage: '.gemini <question>',
        example: '.gemini Explain quantum physics',
        path: '/ai/gemini',
    }),

    chatCommand({
        name: 'mistral',
        aliases: ['mistralai'],
        emoji: '🔍',
        label: 'Mistral AI',
        description: 'Ask Mistral AI a question',
        usage: '.mistral <question>',
        example: '.mistral What is machine learning?',
        path: '/ai/mistral',
    }),

    chatCommand({
        name: 'copilot',
        aliases: ['microsoftai'],
        emoji: '🪟',
        label: 'Microsoft Copilot',
        description: 'Ask Microsoft Copilot a question',
        usage: '.copilot <question>',
        example: '.copilot How are you?',
        path: '/ai/copilot',
    }),

    chatCommand({
        name: 'metaai',
        aliases: ['meta', 'metalai'],
        emoji: '💭',
        label: 'Meta AI',
        description: 'Ask Meta AI a question',
        usage: '.metaai <question>',
        example: '.metaai Hello, how are you?',
        path: '/ai/metai',
    }),

    chatCommand({
        name: 'aiLlama',
        aliases: ['llama', 'llamaai', 'ilama'],
        emoji: '🦙',
        label: 'Llama AI',
        description: 'Ask Llama AI a question',
        usage: '.llama <question>',
        example: '.llama What is deep learning?',
        path: '/ai/ilama',
    }),

    chatCommand({
        name: 'blackbox',
        aliases: ['bb', 'blackboxai'],
        emoji: '📦',
        label: 'Blackbox AI',
        description: 'Ask Blackbox AI a question',
        usage: '.blackbox <question>',
        example: '.blackbox Explain recursion',
        path: '/ai/blackbox',
    }),

    chatCommand({
        name: 'bard',
        aliases: ['googlebard'],
        emoji: '✨',
        label: 'Google Bard',
        description: 'Ask Google Bard a question',
        usage: '.bard <question>',
        example: '.bard Explain black holes',
        path: '/ai/bard',
    }),

    chatCommand({
        name: 'perplexity',
        aliases: ['perplexai'],
        emoji: '🔎',
        label: 'Perplexity AI',
        description: 'Ask Perplexity AI a question',
        usage: '.perplexity <question>',
        example: '.perplexity What is quantum computing?',
        path: '/ai/perplexity',
    }),

    chatCommand({
        name: 'venice',
        aliases: ['vai', 'veniceai'],
        emoji: '🌊',
        label: 'Venice AI',
        description: 'Ask Venice AI a question',
        usage: '.venice <question>',
        example: '.venice What is life?',
        path: '/ai/venice',
    }),

    chatCommand({
        name: 'o3',
        aliases: ['o3ai', 'openai03'],
        emoji: '🔵',
        label: 'O3 AI',
        description: 'Ask O3 AI a question',
        usage: '.o3 <question>',
        example: '.o3 What is consciousness?',
        path: '/ai/o3',
    }),

    // add remaining commands here

];

module.exports.helpers = { ravenn, ravennBinary, resolveImageUrl, resolveAudioUrl, uploadToUguu, cleanResult, react, send };
