module.exports = {
  name: 'shutdown',
  aliases: ['stop', 'off', 'kill'],
  description: 'Shuts down both the bot and the supervisor script.',
  async execute(client, message, args) {
    try {
      if (message && typeof message.reply === 'function') {
        await message.reply('🛑 **Shutdown initiated.** Killing supervisor and bot...');
      }
    } catch (e) {
      console.error('Failed to send shutdown message:', e);
    }

    console.log('[ BOT ] Shutdown command received. Signaling supervisor...');
    
    // Sending SIGINT to the parent process (the supervisor) 
    // tells the supervisor to stop everything.
    process.kill(process.ppid, 'SIGINT');
  }
};
