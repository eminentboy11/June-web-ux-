

const { sendButtons } = require('gifted-btns');

module.exports = {
  name: 'restart',
  aliases: ['reboot'],
  category: 'owner',
  description: 'Restart the bot with options.',
  ownerOnly: true,

  async execute(sock, msg, args, { from, reply, prefix }) {
    const type = args[0]?.toLowerCase();

    // 1. Handle the "Quick" action
    if (type === 'quick') {
      await reply('🔄 *Quick Restart initiated...* Runtime preserved.');
      setTimeout(() => process.exit(42), 2000);
      return;
    }

    // 2. Handle the "Full" action
    if (type === 'full') {
      await reply('⚙️ *Full System Reboot...* Resetting all processes.');
      setTimeout(() => process.exit(1), 2000);
      return;
    }

    // 3. Default: Show Buttons
    try {
      await sendButtons(sock, from, {
        text: '*RESTART MANAGER*\n\nChoose your restart method below:',
        footer: 'June-X Ultra System',
        buttons: [
          {
            id: `${prefix}restart quick`,
            text: '⚡ QUICK RESTART',
          },
          {
            id: `${prefix}restart full`,
            text: '🛡️ FULL REBOOT',
          },
        ],
      }, { quoted: msg });
    } catch (e) {
      // Fallback if buttons fail
      await reply(`*RESTART OPTIONS:*\n\n1. *${prefix}restart quick* (Fast, no console box)\n2. *${prefix}restart full* (Full reboot + console box)`);
    }
  }
};
