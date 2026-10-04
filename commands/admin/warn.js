/**
 * Warn Command - Warn a user (groups + PM)
 * Group: removes user at max warnings
 * PM: blocks user at max warnings
 */

const database = require(require('path').join(global.__CORE__, 'database'));

module.exports = {
    name: 'warn',
    aliases: ['warning'],
    category: 'admin',
    description: 'Warn a user (groups and PM)',
    usage: '.warn @user <reason>',
    groupOnly: false,
    adminOnly: false,
    botAdminNeeded: false,

    async execute(sock, msg, args, extra) {
        try {
            const isGroup = extra.from.endsWith('@g.us');
            const isOwner = msg.key.fromMe || extra.isOwner;
            const maxWarnings = database.getBotSetting('maxWarnings');

            let target;
            let reason;

            if (isGroup) {
                // Admin check (group only)
                const senderId = msg.key.participant || msg.participant;
                const senderIsAdmin = extra.isAdmin !== undefined
                    ? extra.isAdmin
                    : extra.groupMetadata?.participants?.some(
                        p => (p.id === senderId || p.lid === senderId) && (p.admin === 'admin' || p.admin === 'superadmin')
                    );

                if (!senderIsAdmin && !isOwner) {
                    return extra.reply('❌ Only group admins can use this command!');
                }

                const ctx = msg.message?.extendedTextMessage?.contextInfo;
                const mentioned = ctx?.mentionedJid || [];

                if (mentioned.length > 0) {
                    target = mentioned[0];
                } else if (ctx?.participant && ctx.stanzaId && ctx.quotedMessage) {
                    target = ctx.participant;
                } else {
                    return extra.reply('❌ Please mention or reply to the user to warn!\n\nExample: .warn @user Breaking rules');
                }

                reason = args.slice(mentioned.length > 0 ? 1 : 0).join(' ') || 'No reason specified';

                // Prevent warning the bot itself
                const botId = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : null;
                const botLid = sock.user?.lid || null;
                if (botId && (target === botId || target === botLid || target === sock.user?.id)) {
                    return extra.reply('🤖 I cannot warn myself!');
                }

                // Cannot warn admins
                const foundParticipant = extra.groupMetadata.participants.find(
                    p => (p.id === target || p.lid === target) && (p.admin === 'admin' || p.admin === 'superadmin')
                );
                if (foundParticipant) {
                    return extra.reply('❌ Cannot warn an admin!');
                }
            } else {
                // PM: only the owner can warn the person in this chat
                if (!isOwner) {
                    return extra.reply('❌ Only the owner can use this command in PM!');
                }

                target = extra.from;
                reason = args.join(' ') || 'No reason specified';
            }

            const warnings = database.addWarning(extra.from, target, reason);

            const text = `⚠️ @${target.split('@')[0]}\nWarning: ${warnings.count}/${maxWarnings}`;

            await sock.sendMessage(extra.from, {
                text,
                mentions: [target]
            }, { quoted: msg });

            // Max warnings reached
            if (warnings.count >= maxWarnings) {
                if (isGroup) {
                    if (extra.isBotAdmin) {
                        await sock.groupParticipantsUpdate(extra.from, [target], 'remove');
                        database.clearWarnings(extra.from, target);
                    }
                } else {
                    await sock.updateBlockStatus(target, 'block');
                    database.clearWarnings(extra.from, target);
                }
            }

        } catch (error) {
            await extra.reply(`❌ Error: ${error.message}`);
        }
    }
};
