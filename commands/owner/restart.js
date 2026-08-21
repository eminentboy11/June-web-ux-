module.exports = {
  name: 'restart',
  aliases: ['update', 'reboot'],
  description: 'Restarts the bot process via the supervisor.',
  async execute(client, message, args) {
    try {
      if (message && typeof message.reply === 'function') {
        await message.reply('🔄 **Restarting bot...** Please wait.');
      }
    } catch (e) {
      console.error('Failed to send restart message:', e);
    }

    console.log('[ BOT ] Restart command received. Exiting with code 42...');
    
    // Exit code 42 is caught by the supervisor to trigger an immediate restart
    process.exit(42);
  }
};
