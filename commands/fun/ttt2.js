/**
 * .ttt2 — Tic-Tac-Toe 2 (TEST VERSION — candidate to replace fun/tictactoe.js)
 *
 *  .ttt2              → rich INFO CARD menu (no text menu)
 *  .ttt2 bot          → canvas mini-app game vs unbeatable minimax bot
 *  .ttt2 start        → open a PvP room (another player runs the same to join)
 *  .ttt2 <room name>  → open/join a named room
 *  .ttt2 cancel       → cancel your waiting/active game
 *  during a room game: type 1-9 to move, or surrender to give up
 *
 * Room/move logic ported from fun/tictactoe.js (shares utils/tictactoe),
 * with 'ttt2' room ids so the two commands never collide.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const TicTacToe = require('../../utils/tictactoe');
const { sendRichApp, RICH_FALLBACK } = require('../../utils/richApp');

const GAME_HTML = fs.readFileSync(path.join(__dirname, 'ttt2-app.html'), 'utf8');

// Sentinel JID for the AI opponent (never matches a real user)
const BOT_ID = 'bot@tictactoe.local';
const BOT_TAG = '🤖 Bot';

// Store room games globally (handler reads this too)
const games = {};

// ───────────────────────── helpers ─────────────────────────
const SYMBOLS = {
    'X': '❎', 'O': '⭕',
    '1': '1️⃣', '2': '2️⃣', '3': '3️⃣',
    '4': '4️⃣', '5': '5️⃣', '6': '6️⃣',
    '7': '7️⃣', '8': '8️⃣', '9': '9️⃣',
};

const renderBoard = (game) => {
    const arr = game.render().map(v => SYMBOLS[v] || v);
    return `${arr.slice(0, 3).join('')}\n${arr.slice(3, 6).join('')}\n${arr.slice(6).join('')}`;
};

const playerLabel = (jid) => jid === BOT_ID ? BOT_TAG : `@${jid.split('@')[0]}`;
const mentionsOf  = (...jids) => jids.filter(j => j && j !== BOT_ID);

/** Minimax: returns the best move index (0-8) for `botSym` on `boardArr`. */
function bestBotMove(boardArr, botSym, humanSym) {
    const board = boardArr.slice();
    const checkWin = (b) => {
        const lines = [
            [0,1,2],[3,4,5],[6,7,8],
            [0,3,6],[1,4,7],[2,5,8],
            [0,4,8],[2,4,6],
        ];
        for (const [a,b2,c] of lines) {
            if (b[a] && b[a] === b[b2] && b[a] === b[c]) return b[a];
        }
        return null;
    };
    const minimax = (b, isMax, depth) => {
        const w = checkWin(b);
        if (w === botSym)   return 10 - depth;
        if (w === humanSym) return depth - 10;
        if (b.every(c => c)) return 0;

        let best = isMax ? -Infinity : Infinity;
        for (let i = 0; i < 9; i++) {
            if (b[i]) continue;
            b[i] = isMax ? botSym : humanSym;
            const score = minimax(b, !isMax, depth + 1);
            b[i] = null;
            best = isMax ? Math.max(best, score) : Math.min(best, score);
        }
        return best;
    };

    let bestScore = -Infinity;
    let bestMove  = board.findIndex(c => !c);
    for (let i = 0; i < 9; i++) {
        if (board[i]) continue;
        board[i] = botSym;
        const score = minimax(board, false, 0);
        board[i] = null;
        if (score > bestScore) {
            bestScore = score;
            bestMove  = i;
        }
    }
    return bestMove;
}

// ───────────────────── rich info card menu ─────────────────────
// Static card — replaces the old plain-text menu. No "for usage" footer.
const INFO_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}html,body{margin:0;width:100%;background:transparent;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;overflow-x:hidden}
body{padding:4px}.card{width:268px;margin:0;padding:14px 12px;border-radius:18px;background:linear-gradient(160deg,#041f22 0%,#062e33 55%,#021417 100%);color:#d7fbf6;box-shadow:0 8px 24px #0009;border:1px solid #0e6e63;text-align:center}
h1{margin:0;font-size:16px;letter-spacing:.5px;background:linear-gradient(90deg,#2dd4bf,#fbbf24);-webkit-background-clip:text;background-clip:text;color:transparent}
.mode{margin:3px 0 12px;font-size:10px;color:#fbbf24;font-weight:700;letter-spacing:2px}
.row{display:flex;align-items:flex-start;text-align:left;background:#06272b;border:1px solid #0e5f57;border-radius:12px;padding:9px 10px;margin-bottom:8px}
.cmd{flex:0 0 auto;font-family:monospace;font-size:12px;font-weight:700;color:#2dd4bf;background:#04262b;border:1px solid #0e5f57;border-radius:8px;padding:3px 7px;margin-right:8px}
.what{font-size:11.5px;color:#a7e8de;line-height:1.45;padding-top:2px}
.div{height:1px;margin:12px 6px;background:linear-gradient(90deg,transparent,#0e6e63,transparent)}
.dur{font-size:11.5px;color:#a7e8de;line-height:1.5;text-align:center;margin:0}
.dur b{color:#fbbf24}
</style></head><body><div class="card">
<h1>🎮 TIC-TAC-TOE 2</h1>
<p class="mode">CARD MODE</p>
<div class="row"><span class="cmd">.ttt2 start</span><span class="what">open a room (another player runs the same to join)</span></div>
<div class="row"><span class="cmd">.ttt2 bot</span><span class="what">play against the bot</span></div>
<div class="row"><span class="cmd">.ttt2 cancel</span><span class="what">cancel your waiting/active game</span></div>
<div class="div"></div>
<p class="dur">During a game: type <b>1-9</b> to move, or <b>surrender</b> to give up.</p>
</div></body></html>`;

// Plain-text twin of the card, used only if the canvas channel fails.
const INFO_TEXT =
    `🎮 *Tic-Tac-Toe2 card mode*\n` +
    `━━━━━━━━━━━━━━━\n` +
    `▢ \`.ttt2 start\`  – open a room (another player runs the same to join)\n` +
    `▢ \`.ttt2 bot\`    – play against the bot\n` +
    `▢ \`.ttt2 cancel\` – cancel your waiting/active game\n\n` +
    `During a game: type *1-9* to move, or *surrender* to give up.`;

// ───────────────────────── command ─────────────────────────
module.exports = {
    games, // exported for handler access
    name:        'ttt2',
    aliases:     ['xo2', 'tictactoebot'],
    category:    'fun',
    description: 'TEST: Tic-Tac-Toe 2 — rich menu card, canvas bot game, PvP rooms',
    usage:       '.ttt2',

    async execute(sock, msg, args, extra) {
        try {
            const { sender, from, reply } = extra;
            const chatId = from || msg.key.remoteJid;
            const sub = (args[0] || '').toLowerCase();

            // No args → rich info card menu
            if (!sub || ['help', 'menu', 'info', '?'].includes(sub)) {
                try {
                    await sendRichApp(sock, msg, INFO_HTML, chatId);
                } catch (error) {
                    console.error('[ttt2] info card unavailable:', error.message);
                    await sock.sendMessage(chatId, { text: INFO_TEXT }, { quoted: msg }).catch(() => {});
                }
                return;
            }

            // Find any existing room this sender is in
            const existingRoom = Object.values(games).find(r =>
                r.id.startsWith('ttt2') &&
                [r.game.playerX, r.game.playerO].includes(sender)
            );

            // ── cancel ────────────────────────────────────────────────
            if (sub === 'cancel') {
                if (!existingRoom) return reply('❌ You are not in any game.');
                delete games[existingRoom.id];
                return reply('🛑 Your tic-tac-toe game has been cancelled.');
            }

            if (existingRoom && existingRoom.state === 'PLAYING') {
                return reply('❌ You are still in a game. Type *surrender* to quit, or *.ttt2 cancel*.');
            }
            if (existingRoom && existingRoom.state === 'WAITING') {
                return reply('⏳ You already have a room waiting. Type *.ttt2 cancel* to drop it.');
            }

            // ── play vs bot (canvas mini-app) ─────────────────────────
            if (sub === 'bot' || sub === 'cpu' || sub === 'ai') {
                try {
                    await sendRichApp(sock, msg, GAME_HTML, chatId);
                } catch (error) {
                    console.error('[ttt2] mini-app unavailable:', error.message);
                    await sock.sendMessage(chatId, { text: RICH_FALLBACK('TIC-TAC-TOE 2') }, { quoted: msg }).catch(() => {});
                }
                return;
            }

            // ── start / named room (multiplayer) ──────────────────────
            const roomName = sub === 'start' ? (args.slice(1).join(' ').trim() || '') : args.join(' ').trim();

            // Look for existing waiting room
            const waiting = Object.values(games).find(r =>
                r.state === 'WAITING' &&
                r.id.startsWith('ttt2') &&
                !r.botMode &&
                (roomName ? r.name === roomName : !r.name)
            );

            if (waiting) {
                // Join existing room
                waiting.o = from;
                waiting.game.playerO = sender;
                waiting.state = 'PLAYING';

                const text =
                    `🎮 *Tic-Tac-Toe 2 Started!*\n\n` +
                    `${renderBoard(waiting.game)}\n\n` +
                    `▢ ❎ ${playerLabel(waiting.game.playerX)}\n` +
                    `▢ ⭕ ${playerLabel(waiting.game.playerO)}\n\n` +
                    `🎲 Turn: ${playerLabel(waiting.game.currentTurn)}\n` +
                    `▢ Type *1-9* to play, *surrender* to give up.`;

                await sock.sendMessage(from, {
                    text,
                    mentions: mentionsOf(waiting.game.playerX, waiting.game.playerO),
                });
                return;
            }

            // Create new waiting room
            const room = {
                id:    'ttt2-' + Date.now(),
                x:     from,
                o:     '',
                game:  new TicTacToe(sender, 'o'), // playerO will be set on join
                state: 'WAITING',
            };
            if (roomName) room.name = roomName;
            games[room.id] = room;

            await reply(
                `⏳ *Waiting for an opponent…*\n` +
                `Have someone type *.ttt2 start${roomName ? ' ' + roomName : ''}* to join.\n\n` +
                `Or type *.ttt2 cancel* to drop the room.`
            );
        } catch (error) {
            console.error('Error in ttt2 command:', error);
            await extra.reply('❌ Error starting game. Please try again.');
        }
    },
};

// ───────────────────────── move handler ─────────────────────────
async function handleTtt2Move(sock, msg, extra) {
    try {
        const { sender, from } = extra;
        const text = (msg.message?.conversation ||
                      msg.message?.extendedTextMessage?.text || '').trim();

        const room = Object.values(games).find(r =>
            r.id.startsWith('ttt2') &&
            [r.game.playerX, r.game.playerO].includes(sender) &&
            r.state === 'PLAYING'
        );
        if (!room) return false;

        const isSurrender = /^(surrender|give up)$/i.test(text);
        if (!isSurrender && !/^[1-9]$/.test(text)) return false;

        // Surrender bypasses turn check
        if (sender !== room.game.currentTurn && !isSurrender) {
            await sock.sendMessage(from, { text: '❌ Not your turn!' });
            return true;
        }

        if (isSurrender) {
            const winner = sender === room.game.playerX ? room.game.playerO : room.game.playerX;
            await sock.sendMessage(from, {
                text: `🏳️ ${playerLabel(sender)} surrendered! ${playerLabel(winner)} wins!`,
                mentions: mentionsOf(sender, winner),
            });
            delete games[room.id];
            return true;
        }

        // Apply the human move
        const ok = room.game.turn(sender === room.game.playerO, parseInt(text) - 1);
        if (!ok) {
            await sock.sendMessage(from, { text: '❌ Invalid move! That position is already taken.' });
            return true;
        }

        // If bot mode and it's the bot's turn (and game not over), make the bot move
        if (room.botMode &&
            !room.game.winner &&
            room.game.turns < 9 &&
            room.game.currentTurn === BOT_ID) {
            const botSym   = 'O';
            const humanSym = 'X';
            const idx = bestBotMove(room.game.board, botSym, humanSym);
            room.game.turn(true, idx); // bot is playerO
        }

        await sendBoard(sock, room);

        if (room.game.winner || (room.game.turns === 9 && !room.game.winner)) {
            delete games[room.id];
        }
        return true;
    } catch (error) {
        console.error('Error in ttt2 move:', error);
        return false;
    }
}

async function sendBoard(sock, room) {
    const winner = room.game.winner;
    const isTie  = room.game.turns === 9 && !winner;

    let status;
    if (winner) {
        status = winner === BOT_ID
            ? `🤖 ${BOT_TAG} wins! Better luck next time.`
            : `🎉 ${playerLabel(winner)} wins the game!`;
    } else if (isTie) {
        status = `🤝 It's a draw!`;
    } else {
        const sym = room.game.currentTurn === room.game.playerX ? '❎' : '⭕';
        status = `🎲 Turn: ${playerLabel(room.game.currentTurn)} (${sym})`;
    }

    const text =
        `🎮 *Tic-Tac-Toe 2${room.botMode ? ' vs ' + BOT_TAG : ''}*\n\n` +
        `${status}\n\n` +
        `${renderBoard(room.game)}\n\n` +
        `▢ ❎ ${playerLabel(room.game.playerX)}\n` +
        `▢ ⭕ ${playerLabel(room.game.playerO)}` +
        (!winner && !isTie ? `\n\n• Type *1-9* to move\n• Type *surrender* to give up` : '');

    const mentions = mentionsOf(
        room.game.playerX,
        room.game.playerO,
        winner || room.game.currentTurn,
    );

    await sock.sendMessage(room.x, { text, mentions });
    if (!room.botMode && room.x !== room.o) {
        await sock.sendMessage(room.o, { text, mentions });
    }
}

module.exports.handleTtt2Move = handleTtt2Move;
