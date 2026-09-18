/**
 * .ttt2 — Tic-Tac-Toe mini-app (TEST VERSION) on the in-chat canvas channel.
 * You (✖) vs an unbeatable minimax bot (◉), with "you first"/"bot first"
 * modes and a running score. Sunset teal/gold palette.
 *
 * TEST replacement candidate for the text-based .tictactoe (fun/tictactoe.js)
 * — that command is untouched until this is approved.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { sendRichApp, RICH_FALLBACK } = require('../../utils/richApp');

const APP_HTML = fs.readFileSync(path.join(__dirname, 'ttt2-app.html'), 'utf8');

module.exports = {
    name: 'ttt2',
    aliases: ['xo2', 'tictactoebot'],
    category: 'fun',
    description: 'TEST: Tic-Tac-Toe vs bot — mini-app version (render in chat)',
    usage: '.ttt2',

    async execute(sock, msg, args, extra) {
        const chatId = extra.from || msg.key.remoteJid;
        try {
            await sendRichApp(sock, msg, APP_HTML, chatId);
        } catch (error) {
            console.error('[TTT2] mini-app unavailable:', error.message);
            await sock.sendMessage(chatId, { text: RICH_FALLBACK('TIC-TAC-TOE') }, { quoted: msg }).catch(() => {});
        }
    }
};
