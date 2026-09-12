/**
 * GetSession Command - Owner only
 * Shows the Session Server token status. The legacy raw-session
 * (Ultra-X:~<base64>) export was RETIRED — the token is the single
 * official session mechanism.
 */

const sessionServer = require('../../utils/juneDb/sessionServer');

module.exports = {
  name: 'getsession',
  aliases: ['sessionid', 'mysession', 'session'],
  category: 'owner',
  description: 'Show your Session Server token status',
  usage: '.getsession',
  ownerOnly: true,
  adminOnly: false,
  groupOnly: false,
  botAdminOnly: false,

  async execute(sock, msg, args, extra) {
    try {
      // ── Session Server token mode ────────────────────────────────────────
      // The token already lives in the bot's environment; never print the raw
      // credentials. Show a status summary from the server instead.
      if (sessionServer.isTokenModeActive()) {
        const token = sessionServer.getConfiguredToken();
        const redacted = token.slice(0, 'june-ultra:~'.length + 4) + '…' + token.slice(-4);
        const fingerprint = sessionServer.sha256Hex(token).slice(0, 8);
        const status = sessionServer.getStatus();

        let serverLines = '';
        try {
          const check = await sessionServer.checkTokenStatus();
          if (check && check.status === 'active') {
            serverLines =
              `\n📱 Account: …${check.phoneLast4 || '????'}` +
              `\n🤖 Bot online (server view): ${check.botOnline ? 'yes' : 'no'}` +
              `\n🗂️ Server auth state: v${check.authStateVersion || '?'} · ${check.keyRows || 0} key rows` +
              `\n🕐 Last used: ${check.lastUsedAt ? new Date(check.lastUsedAt).toLocaleString() : '—'}`;
          } else if (check) {
            serverLines = `\n⚠️ Server reports the session is *${check.status}* — re-pair to get a fresh token.`;
          }
        } catch (error) {
          serverLines = `\n⚠️ Could not reach the session server: ${error.message}`;
        }

        return extra.reply(
          `╭━━『 *Session Token (active)* 』━━╮\n\n` +
          `🔑 Token: \`${redacted}\`\n` +
          `🔖 Fingerprint: \`${fingerprint}\`\n` +
          `🔗 Server: ${sessionServer.getServerUrl()}\n` +
          `📡 Lease: ${status.authenticated ? 'authenticated' : 'not authenticated'}` +
          `${status.heartbeatRunning ? ' · heartbeat running' : ''}` +
          `${serverLines}\n\n` +
          `📋 The full token is in your bot environment\n` +
          `(SESSION_ID / JUNE_SESSION_TOKEN).\n\n` +
          `⚠️ Lost the token or suspect a leak? Revoke it at\n` +
          `${sessionServer.getServerUrl()}/manage and re-pair.\n` +
          `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━╯`
        );
      }

      // ── No token configured ─────────────────────────────────────────────
      return extra.reply(
        '❌ *No Session Server token configured.*\n\n' +
        'Raw session IDs (Ultra-X:~/JUNE-MD:~) were retired —\n' +
        'the token is now the only session mechanism.\n\n' +
        `1️⃣ Pair at ${sessionServer.getServerUrl()}/pair\n` +
        '2️⃣ Copy your june-ultra:~ token\n' +
        '3️⃣ Set it as SESSION_ID in this bot\'s .env\n' +
        '4️⃣ Restart the bot'
      );
    } catch (error) {
      console.error('GetSession command error:', error);
      await extra.reply(`❌ Failed to read session status: ${error.message}`);
    }
  }
};
