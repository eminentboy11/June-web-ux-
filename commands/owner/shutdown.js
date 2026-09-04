module.exports = {
  name: 'shutdown',
  aliases: ['stop', 'off', 'kill'],
  category: 'owner',
  description: 'Forces the bot and server to stay offline.',
  async execute(sock, msg, args, { from, reply }) {
    console.log('[ BOT ] Shutdown command received. Triggering Nuclear Shutdown...');
    
    try {
      await reply('☢️ *Nuclear Shutdown Engaged.* Forcing server offline...');
      
      // Wait 2 seconds so the message finishes sending
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (e) {
      console.error('Error sending shutdown feedback:', e);
    }

    // 🚀 NEW LOGIC: Exit with code 44
    // This tells the supervisor in index.js to activate the "Pterodactyl Trap"
    process.exit(44);
  }
};
