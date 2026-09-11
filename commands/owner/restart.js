module.exports = {
  name: 'restart',
  aliases: ['reboot'],
  category: 'owner',
  description: 'Restart the bot.',
  ownerOnly: true,

  async execute(sock, msg, args, { reply }) {
    try {
      await reply('🔄 *Restarting...*');

      // Give the socket a moment to flush the outgoing message
      await new Promise((res) => setTimeout(res, 1500));

      // Close the connection gracefully so session/auth state isn't
      // left mid-write when the process exits.
      try {
        await sock.end?.(undefined);
      } catch (err) {
        console.error('[restart] socket close failed', err.message);
      }

      process.exit(0);
    } catch (err) {
      console.error('[restart] failed', err.message);
      await reply('❌ Restart failed — check logs.').catch(() => {});
    }
  }
};
