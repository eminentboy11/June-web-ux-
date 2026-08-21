/**
 * .update — pulls the latest bot source and restarts.
 *
 * How it works:
 *   1. This command replies to confirm, then exits the current process
 *      with a special code (42) instead of just process.exit(0).
 *   2. bot.js (the supervisor) sees exit code 42 and knows this was an
 *      intentional restart — not a crash — so it respawns loader.js
 *      immediately, skipping the restart delay and crash-loop counter.
 *   3. loader.js runs its normal flow: back up database/session/data,
 *      wipe the cache, download the latest source from REPO_URL,
 *      extract, restore the backed-up folders, then launch index.js.
 *
 * Requires bot.js to be the process supervisor (not `node index.js`
 * directly, and not `node loader.js` directly) — otherwise there is no
 * parent process listening for exit code 42 to respawn the loader, and
 * calling this command will just kill the bot with nothing bringing it
 * back up.
 *
 * ⚠️ ASSUMPTION: command signature and reply/sender helpers below are
 * guessed from commandLoader.js alone (I don't have handler.js or an
 * existing command file to copy the exact shape from). Adjust the
 * `execute(context)` parameters and the `reply(...)` / sender-JID lines
 * to match however your other commands actually receive the socket,
 * message, and args.
 */

const OWNER_JIDS = (process.env.OWNER_NUMBERS || '')
  .split(',')
  .map(n => n.trim())
  .filter(Boolean);

function isOwner(senderJid) {
  if (!senderJid) return false;
  if (!OWNER_JIDS.length) {
    console.warn('[ UPDATE ] OWNER_NUMBERS is not set — .update is unrestricted. Set it in .env.');
    return true;
  }
  const senderNumber = senderJid.split('@')[0];
  return OWNER_JIDS.includes(senderNumber);
}

module.exports = {
  name: 'update',
  aliases: ['reload'],
  description: 'Pulls the latest bot code from GitHub and restarts the bot.',
  category: 'owner',

  // ⚠️ Adjust this signature to match your other commands' actual shape.
  execute: async (context) => {
    const { sock, message, reply } = context || {};

    const senderJid =
      message?.key?.participant ||   // group message
      message?.key?.remoteJid;       // direct message

    if (!isOwner(senderJid)) {
      if (typeof reply === 'function') {
        await reply('❌ Only the bot owner can run .update.');
      }
      return;
    }

    const send =
      typeof reply === 'function'
        ? reply
        : async (text) => {
            if (sock && message?.key?.remoteJid) {
              await sock.sendMessage(message.key.remoteJid, { text });
            } else {
              console.log('[ UPDATE ]', text);
            }
          };

    await send('🔄 Update started — pulling the latest code and restarting. This may take a moment.');

    console.log('[ UPDATE ] .update triggered by', senderJid || 'unknown sender');

    // Give the outgoing message a moment to actually flush over the
    // socket before this process exits.
    setTimeout(() => {
      process.exit(42); // matches INTENTIONAL_RESTART_CODE in bot.js
    }, 1500);
  }
};
