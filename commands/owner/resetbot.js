'use strict';

/**
 * ResetBot Command - Wipe the bot's database (owner only).
 * Aliases: resetdb
 *
 * Usage:
 *   .resetbot                       -> shows what will be wiped (safe, no changes)
 *   .resetbot confirm               -> resets DATA only (keeps the WhatsApp login)
 *   .resetbot confirm --session     -> also clears the login session (bot re-pairs)
 *
 * The reset clears both the local SQLite tables and the remote JuneDB mirror,
 * so the data does not get re-seeded on the next restart.
 */

const database = require('../../database');

const DATA_SCOPE = [
  'warnings', 'moderators', 'muted users', 'KV store', 'antidelete logs',
  'status-download history', 'group stats', 'group settings', 'user profiles',
  'chat profiles', 'LID map', 'runtime telemetry', 'bot settings', 'sync queue',
];

module.exports = {
  name: 'resetbot',
  aliases: ['resetdb'],
  category: 'owner',
  description: 'Wipe the bot database (data only by default; add --session to also log out).',
  usage: '.resetbot confirm [--session]',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const argSet = new Set((args || []).map((a) => String(a).toLowerCase()));
      const confirmed = argSet.has('confirm');
      const includeSession = argSet.has('--session') || argSet.has('--full') || argSet.has('-s');
      // Owner identity survives a reset unless explicitly included, the same
      // way the login session does. Losing control of your own bot should
      // never be a side effect of clearing data.
      const includeOwner = argSet.has('--owner') || argSet.has('--full');

      if (!confirmed) {
        return extra.reply(
          '⚠️ *DATABASE RESET — CONFIRMATION REQUIRED*\n\n' +
          'This permanently wipes the bot’s stored data:\n' +
          '• ' + DATA_SCOPE.join('\n• ') + '\n\n' +
          'Kept by default:\n' +
          '• WhatsApp login session\n' +
          '• Owner number and name\n\n' +
          'Add *--session* to also clear the login (bot must re-pair).\n' +
          'Add *--owner* to also clear the owner.\n' +
          '_(--full does both)_\n\n' +
          'To proceed, send: *.resetbot confirm*' +
          (includeSession ? ' *--session*' : '') +
          (includeOwner ? ' *--owner*' : '') + '\n\n' +
          '🔒 Owner only.'
        );
      }

      await extra.reply('🧹 Wiping database, please wait…');

      const result = await database.resetDatabase({ includeSession, includeOwner });

      // Explicit user request (--session): also revoke the server-side
      // Session Server session so the token can no longer fetch credentials.
      // Only ever triggered here — never by transient errors or conflicts.
      let sessionServerRevoked = null;
      if (includeSession) {
        try {
          const sessionServer = require('../../utils/juneDb/sessionServer');
          sessionServerRevoked = await sessionServer.revokeSession('user-reset');
        } catch (_) {
          sessionServerRevoked = { revoked: false, error: 'revoke-failed' };
        }
      }

      const lines = [
        '✅ *Database reset complete*\n',
        '🗄️ *Local tables cleared:* ' + (result.localCleared ? result.localCleared.length : 0),
        '☁️ *Remote mirror cleared:* ' + (result.remote && result.remote.remoteCleared ? 'yes' : 'no / not configured'),
      ];
      lines.push('');
      lines.push(result.ownerPreserved
        ? '👑 *Owner kept* — ' + (database.getOwners()[0] || 'none')
        : '👑 *Owner cleared* — the paired account is re-claimed on the next connect.');

      if (includeSession) {
        lines.push('');
        lines.push('🔑 *Login session cleared* — the bot returns to the pairing screen on next reconnect/restart.');
        if (sessionServerRevoked && sessionServerRevoked.revoked) {
          lines.push('☁️ *Session Server token revoked* — the june-ultra token no longer works.');
        } else if (sessionServerRevoked && sessionServerRevoked.skipped === 'already-revoked-or-not-active') {
          lines.push('☁️ Session Server: no active token to revoke.');
        } else if (sessionServerRevoked) {
          lines.push('☁️ Session Server: could not revoke automatically — revoke the token on the manage page.');
        }
      } else {
        lines.push('');
        lines.push('🔑 Login session kept — bot stays connected.');
      }
      lines.push('\n_Data will not return after a restart._');

      return extra.reply(lines.join('\n'));
    } catch (error) {
      console.error('ResetBot command error:', error);
      return extra.reply('❌ Failed to reset database: ' + (error && error.message ? error.message : error));
    }
  },
};
