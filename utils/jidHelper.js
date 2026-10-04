/**
 * Block Command — block one or more users
 * Accepts: .block @user, .block <number with country code>, reply to a user, or any combo.
 *
 * Global: any country code works. Phone numbers are verified via sock.onWhatsApp().
 * LID-safe: a @lid target is blocked by its LID directly. A mapping is only used
 * as a fallback candidate. Unresolved LIDs are never turned into fake phone JIDs.
 */

const { jidDecode } = require('@whiskeysockets/baileys');
const { getLidMappingValue } = require('../../utils/jidHelper');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// International phone normaliser → { digits } or { error }
function normalizePhone(raw) {
  let d = String(raw).replace(/\D/g, '');
  if (!d) return null; // nothing numeric, ignore chunk
  if (d.startsWith('00')) d = d.slice(2); // 00 international prefix
  if (d.startsWith('0')) return { error: 'include the country code (no leading 0)' };
  if (d.length < 8 || d.length > 15) return { error: 'invalid number length' };
  return { digits: d };
}

// Split JID into { user, server } with device suffix removed
function parseJid(jid) {
  if (!jid) return null;
  try {
    const dec = jidDecode(jid);
    if (dec?.user) {
      return {
        user: dec.user.split(':')[0],
        server: dec.server === 'c.us' ? 's.whatsapp.net' : dec.server,
      };
    }
  } catch (_) {}
  const user = String(jid).split('@')[0].split(':')[0];
  return user ? { user, server: 's.whatsapp.net' } : null;
}

// Build ordered list of JIDs to try for one target
function buildCandidates(jid) {
  const p = parseJid(jid);
  if (!p) return [];
  const out = [];

  if (p.server === 'lid' || p.server === 'hosted.lid') {
    out.push(`${p.user}@lid`); // block by LID first — always valid
    const pn = getLidMappingValue(p.user, 'lidToPn');
    if (pn) out.push(`${pn}@s.whatsapp.net`);
  } else {
    out.push(`${p.user}@s.whatsapp.net`);
    const lid = getLidMappingValue(p.user, 'pnToLid');
    if (lid) out.push(`${lid}@lid`);
  }
  return out;
}

// Resolve a phone number to its real WhatsApp JID (any country)
async function resolvePhoneJid(sock, digits) {
  try {
    const res = await sock.onWhatsApp(digits);
    const hit = Array.isArray(res) ? res[0] : null;
    if (hit) {
      if (hit.exists === false) return { error: 'not on WhatsApp' };
      if (hit.jid) return { jid: hit.jid };
    }
  } catch (_) {
    // lookup failed — fall back to the plain JID below
  }
  return { jid: `${digits}@s.whatsapp.net` };
}

module.exports = {
  name: 'block',
  aliases: ['blockuser'],
  category: 'owner',
  description: 'Block one or more users (mention, reply, or phone number with country code)',
  usage: '.block @user | .block +254140480956 | .block 14155550123, 447911123456 | reply to a user with .block',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const ctx = msg.message?.extendedTextMessage?.contextInfo;
      const rawTargets = new Set();
      const fail = [];

      // Mentions
      for (const m of (ctx?.mentionedJid || [])) rawTargets.add(m);

      // Reply (group → participant, DM → remoteJid)
      if (ctx?.stanzaId && ctx?.quotedMessage) {
        const quoted = ctx.participant ||
          (!String(extra.from).endsWith('@g.us') ? msg.key.remoteJid : null);
        if (quoted) rawTargets.add(quoted);
      }

      // Phone numbers — skip @mention tokens, separate multiple numbers with commas/newlines
      const phoneText = args.filter((a) => !a.startsWith('@')).join(' ');
      for (const chunk of phoneText.split(/[,\n]+/)) {
        const n = normalizePhone(chunk);
        if (!n) continue;
        if (n.error) {
          fail.push({ jid: chunk.trim(), err: n.error });
          continue;
        }
        const r = await resolvePhoneJid(sock, n.digits);
        if (r.error) fail.push({ jid: `${n.digits}@s.whatsapp.net`, err: r.error });
        else rawTargets.add(r.jid);
      }

      if (rawTargets.size === 0 && fail.length === 0) {
        return extra.reply(
          '❌ Please mention a user, reply to a user, or provide a phone number with country code.\n\n' +
          'Examples:\n' +
          '• `.block @user`\n' +
          '• `.block +254140480956`\n' +
          '• `.block 14155550123, 447911123456`\n' +
          '• Reply to a user with `.block`'
        );
      }

      // Self guard
      const me = parseJid(sock.user?.id)?.user;
      const myLid = parseJid(sock.user?.lid)?.user;

      const ok = [];
      const seen = new Set();
      let first = true;

      for (const raw of rawTargets) {
        const p = parseJid(raw);
        if (!p || seen.has(p.user)) continue;
        seen.add(p.user);

        if (p.user === me || p.user === myLid) {
          fail.push({ jid: raw, err: 'cannot block the bot itself' });
          continue;
        }

        if (!first) await sleep(500);
        first = false;

        const candidates = buildCandidates(raw);
        let done = false;
        let lastErr = 'invalid JID';

        for (const cand of candidates) {
          try {
            await sock.updateBlockStatus(cand, 'block');
            ok.push(cand);
            done = true;
            break;
          } catch (e) {
            lastErr = e.message;
          }
        }
        if (!done) fail.push({ jid: candidates[0] || raw, err: lastErr });
      }

      let text = '';
      if (ok.length) {
        text += `✅ *Blocked (${ok.length}):*\n` +
                ok.map((j) => `• @${j.split('@')[0]}`).join('\n');
      }
      if (fail.length) {
        if (text) text += '\n\n';
        text += `❌ *Failed (${fail.length}):*\n` +
                fail.map((f) => `• @${f.jid.split('@')[0]} — ${f.err}`).join('\n');
      }

      await sock.sendMessage(extra.from, {
        text,
        mentions: [...ok, ...fail.map((f) => f.jid).filter((j) => j.includes('@'))],
      }, { quoted: msg });

    } catch (error) {
      console.error('[block] error:', error);
      await extra.reply(`❌ Error: ${error.message}`);
    }
  },
};
