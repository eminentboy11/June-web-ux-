'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('../../config');
const database = require('../../database');

module.exports = {
  name: 'update',
  aliases: ['upgrade', 'updatebot'],
  category: 'owner',
  description: 'Apply the latest bot code and restart',
  usage: '.update',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      await extra.reply('⏳ *Applying update...* Preparing database and session safety.');
      
      // Fix: Correct way to wait 1 second
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Ensure settings and the current auth state are durable
      if (typeof database.flushBackup === 'function') await database.flushBackup();
      if (typeof database.flushRemoteAuthMirror === 'function') {
         await database.flushRemoteAuthMirror('update');
      }

      await extra.reply(
        `✅ *Update applied successfully.*\n\n` + 
        `✅ June-X Runtime preserved.\n` +
        `🗄️ Database and settings preserved.\n` +
        `🔐 WhatsApp session preserved.\n\n` +
        `🔁 *Restarting via Supervisor...*`
      );

      // Give the WhatsApp message time to send before exiting
      setTimeout(() => process.exit(43), 2000);

    } catch (error) {
      console.error('[UPDATE] Failed:', error);
      await extra.reply(`❌ Update failed: ${error.message}`);
    }
    // Removed the 'workRoot' line since it wasn't defined in this snippet
  },
};