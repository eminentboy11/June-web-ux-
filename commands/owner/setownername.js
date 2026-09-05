const config = require('../../config');
const fs = require('fs');
const path = require('path');

module.exports = {
  name: 'setownername',
  aliases: ['setowner_name'],
  category: 'owner',
  description: 'Change the bot owner display name',
  usage: '.setownername <new name>',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      let newName = '';

      const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      if (quotedMsg) {
        newName = (quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || '').trim();
      } else {
        newName = args.join(' ').trim();
      }

      if (!newName) {
        const current = Array.isArray(config.ownerName) ? config.ownerName[0] : config.ownerName;
        return extra.reply(`👑 *Set Owner Name*\n\nCurrent: *${current}*\n\nUsage: ${config.prefix}setownername <new name>`);
      }

      if (newName.length > 50) {
        return extra.reply('❌ Owner name must be 50 characters or less!');
      }

      // Assign, do not mutate. config.ownerName is a getter that builds a
      // fresh array from SQLite, so `config.ownerName[0] = x` would change a
      // throwaway copy. Assigning goes through the setter and persists.
      config.ownerName = [newName];

      await extra.reply(`✅ Owner name changed to: *${newName}*`);
    } catch (error) {
      await extra.reply(`❌ Error: ${error.message}`);
    }
  }
};
