const { requestShutdown, EXIT_CODE } = require('../../utils/shutdown');

module.exports = {
  name: 'shutdown',
  aliases: ['stop', 'off', 'kill'],
  category: 'owner',
  description: 'Forces the bot and server to stay offline.',
  ownerOnly: true,

  async execute(sock, msg, args, { from, reply }) {
    console.log('[ BOT ] Shutdown command received. Triggering Nuclear Shutdown...');

    try {
      await reply('☢️ *Nuclear Shutdown Engaged.* Forcing server offline...');
      // Wait 2 seconds so the message finishes sending
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (e) {
      console.error('Error sending shutdown feedback:', e);
    }

    // Kill 1/3 of the nuclear chain (utils/shutdown.js): the state file makes
    // the bot survive its supervisor's auto-restarts — it re-kills itself on
    // the next two boots, then the state is gone and the bot stays dead.
    requestShutdown();
    process.exit(EXIT_CODE);
  }
};
