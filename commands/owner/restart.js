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

    // 3. Default: plain-text menu, answered by replying 1 or 2.
    //
    // The reply is matched on this message's id rather than its text. reply()
    // pipes through applyFont(), which rewrites letters into unicode variants
    // for 21 of the 23 fonts — 'RESTART MANAGER' becomes '𝚁𝙴𝚂𝚃𝙰𝚁𝚃 𝙼𝙰𝙽𝙰𝙶𝙴𝚁'
    // and any text match silently fails. An id cannot be reformatted, and it
    // also stops someone triggering a restart by quoting the words back.
    const sent = await reply(
      'RESTART MANAGER\n' +
      '1️⃣ Quick Restart — advisable for updating bot while runtime preserved\n' +
      '2️⃣ Full Reboot — also update bot but runtime not preserved\n\n' +
      'Reply with 1 or 2'
    );

    const menuId = sent?.key?.id;
    if (menuId) {
      global.__RESTART_MENU__ = { id: menuId, chat: from, at: Date.now() };
    }
  }
};
