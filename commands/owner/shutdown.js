module.exports = {
  name: 'shutdown',
  aliases: ['stop', 'off', 'kill'],
  description: 'Shuts down both the bot and the supervisor script.',
  async execute(sock, msg, args, { from, reply }) {
    console.log('[ BOT ] Shutdown command received. Signaling supervisor...');
    
    try {
      // Send feedback using the provided reply helper
      await reply('🛑 *Shutdown initiated.* The bot and supervisor are stopping now.');
      
      // Give the message 2 seconds to actually leave the server
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (e) {
      console.error('Error sending shutdown feedback:', e);
    }

    // Signal supervisor
    process.kill(process.ppid, 'SIGINT');
  }
};
