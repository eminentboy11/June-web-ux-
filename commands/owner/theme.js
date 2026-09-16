/**
 * .theme — force the console look or hand it back to the day/night clock.
 *   .theme dark  → June Ultra's classic console, always
 *   .theme light → June Lite's white console, always
 *   .theme auto  → ☀️ white 06:00–18:00, 🌙 dark 18:00–06:00
 *                  (TIMEZONE env if set, otherwise standard UTC)
 * Persisted in SQLite bot_settings via utils/consoleTheme — survives restarts.
 */
'use strict';
const consoleTheme = require('../../utils/consoleTheme');

module.exports = {
  name: 'theme',
  aliases: ['consoletheme', 'consolename'],
  category: 'owner',
  ownerOnly: true,
  description: 'Switch console theme (dark = Ultra style, light = Lite style, auto = day/night)',
  usage: '.theme <dark|light|auto>',

  async execute(sock, msg, args, extra) {
    try {
      const opt = (args[0] || '').toLowerCase().trim();
      const tz = consoleTheme.getTimeZone();
      const tzSource = consoleTheme.getTimeZoneSource();
      const tzLabel = tzSource === 'bot'
        ? `${tz} (bot setting — change with .settimezone)`
        : tzSource === 'env'
          ? `${tz} (TIMEZONE env)`
          : `${tz} (bot default — change with .settimezone)`;
      const mode = consoleTheme.getMode();
      const active = consoleTheme.currentTheme();
      const activeLabel = active === 'light' ? '☀️ white (June Lite style)' : '🌙 dark (June Ultra style)';

      if (!opt || !consoleTheme.VALID.includes(opt)) {
        return extra.reply(
          `🎨 *Console Theme*\n\n` +
          `📌 Mode    : *${mode}*${mode === 'auto' ? ' ⏰' : ''}\n` +
          `🖥️ Right now: ${activeLabel}\n` +
          `⏰ Auto    : ☀️ 06:00 → 🌙 18:00\n` +
          `🌍 Timezone: ${tzLabel}\n\n` +
          `*Usage:*\n` +
          `  .theme dark  → Ultra's dark console always\n` +
          `  .theme light → Lite's white console always\n` +
          `  .theme auto  → follow the day/night clock\n\n` +
          `_Switching is instant — no restart needed._`
        );
      }

      const changed = consoleTheme.setMode(opt);
      if (!changed && opt !== mode) {
        return extra.reply(`❌ Could not save the theme setting. Try again in a moment.`);
      }
      // Force the transition line + confirm the now-active look
      const nowActive = consoleTheme.currentTheme();
      const nowLabel = nowActive === 'light' ? '☀️ white (June Lite style)' : '🌙 dark (June Ultra style)';

      return extra.reply(
        opt === 'auto'
          ? `⏰ Theme set to *AUTO*\n\n☀️ white 06:00 → 18:00\n🌙 dark 18:00 → 06:00\n🌍 Timezone: ${tzLabel}\n\n🖥️ Showing right now: ${nowLabel}`
          : `🎨 Theme locked to *${opt.toUpperCase()}*\n\n🖥️ Console is now: ${nowLabel}\n\n_(use .theme auto to follow the day/night clock again)_`
      );
    } catch (err) {
      await extra.reply(`❌ Error: ${err.message}`);
    }
  },
};
