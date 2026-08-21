module.exports = {
  name: 'restart',
  aliases: ['update', 'reboot'],
  description: 'Restarts the bot process via the supervisor.',
  async execute(sock, msg, args, { from, reply }) {
    console.log('[ BOT ] Restart command received. Exiting with code 42...');

    try {
      // Send feedback using the provided reply helper
      await reply('🔄 *Restarting...* Please wait a moment for the bot to reconnect.');
      
      // Give the message 2 seconds to actually leave the server
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (e) {
      console.error('Error sending restart feedback:', e);
    }
    
    // Exit code 42 is caught by the supervisor to trigger an immediate restart
    process.exit(42);
  }
};
