/**
 * .2048 — live 2048 mini-app on the in-chat canvas (same channel as .tetris).
 * Swipe the board or use arrow keys; same numbers merge; reach 2048.
 * June skinned: dark card, gold tiles.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { sendRichApp, RICH_FALLBACK } = require('../../utils/richApp');

const APP_HTML = fs.readFileSync(path.join(__dirname, '2048-app.html'), 'utf8');

module.exports = {
    name: '2048',
    aliases: ['twenty48', 'game2048'],
    category: 'games',
    description: 'Play a live 2048 canvas mini-app (renders inside WhatsApp)',
    usage: '.2048',

    async execute(sock, msg, args, extra) {
        const chatId = extra.from || msg.key.remoteJid;
        try {
            await sendRichApp(sock, msg, APP_HTML, chatId);
        } catch (error) {
            console.error('[2048] mini-app unavailable:', error.message);
            await sock.sendMessage(chatId, { text: RICH_FALLBACK('2048') }, { quoted: msg }).catch(() => {});
        }
    }
};
