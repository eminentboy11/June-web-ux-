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

    // 3. Default: Show plain-text menu (reply with 1 or 2)
    await reply(
      'RESTART MANAGER\n' +
      '1️⃣ Quick Restart — advisable for updating bot while runtime preserved\n' +
      '2️⃣ Full Reboot — also update bot but runtime not preserved\n\n' +
      'Reply with 1 or 2'
    );
  }
};
