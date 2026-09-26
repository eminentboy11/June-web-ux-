const crypto = require('crypto');
const {
  generateWAMessageContent,
  generateWAMessageFromContent,
  downloadContentFromMessage,
} = require('@whiskeysockets/baileys');
const { PassThrough } = require('stream');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('../../utils/ffmpegPath');
ffmpeg.setFfmpegPath(ffmpegPath);

const PURPLE_COLOR = '#9C27B0';
const SUCCESS_EMOJI = '✅';

module.exports = [
  {
    name: 'groupstatus',
    aliases: ['togstatus', 'swgc', 'gs', 'gstatus'],
    description: 'Post replied media or text as a WhatsApp group status.',
    usage: '.groupstatus [caption] [groupJid]',
    category: 'owner',
    ownerOnly: true,

    async execute(sock, msg, args, extra) {
      try {
        const from = extra.from;
        let captionArgs = [...(args || [])];
        let targetJid = null;

        const lastArg = captionArgs[captionArgs.length - 1] || '';
        if (lastArg.endsWith('@g.us')) {
          targetJid = lastArg;
          captionArgs = captionArgs.slice(0, -1);
        } else if (extra.isGroup) {
          targetJid = from;
        }

        if (!targetJid) {
          return extra.reply(
            '📝 *Group Status Usage*\n\n' +
            '*In a group:*\n' +
            ' `.swgc Your text here`\n' +
            ' `.swgc` (reply to image/video/gif/audio/sticker/document/text)\n\n' +
            '*From private chat:*\n' +
            ' `.swgc Hello everyone <groupJid>`\n' +
            ' `.swgc <groupJid>` (reply to media/text)'
          );
        }

        // enforce group only - studied above: non-@g.us must reject with INVALID_RECIPIENT
        if (!targetJid.endsWith('@g.us')) {
          return extra.reply('❌ Group status only works in groups. JID must end with @g.us');
        }

        const caption = captionArgs.join(' ').trim();

        // Find contextInfo wherever it lives — a reply can arrive nested inside
        // ephemeralMessage/viewOnceMessage (disappearing chats), and not every
        // reply type puts contextInfo on extendedTextMessage.
        const ctxInfo = extractContext(msg.message);
        const rawQuoted = ctxInfo?.quotedMessage;
        const hasQuoted = !!rawQuoted;

        if (!hasQuoted) {
          if (!caption) return extra.reply('❌ Provide text or reply to media.');
          try {
            await postGroupStatus(sock, targetJid, {
              text: caption,
              backgroundColor: PURPLE_COLOR,
            });
            return react(sock, msg, from);
          } catch (e) {
            console.error('[groupstatus] text error:', e);
            return extra.reply('❌ Failed to post text status: ' + (e.message || e));
          }
        }

        const unwrapped = unwrapMessage(rawQuoted);
        if (!unwrapped) return extra.reply('❌ Could not read quoted message.');

        const quotedMsg = {
          key: { remoteJid: from, id: ctxInfo.stanzaId, participant: ctxInfo.participant },
          message: unwrapped,
        };
        const mtype = Object.keys(unwrapped)[0] || '';

        if (/^(conversation|extendedTextMessage)$/i.test(mtype)) {
          const quotedText = unwrapped.conversation || unwrapped.extendedTextMessage?.text || '';
          const text = caption || quotedText;
          if (!text) return extra.reply('❌ Quoted message has no text.');
          await postGroupStatus(sock, targetJid, { text, backgroundColor: PURPLE_COLOR });
          return react(sock, msg, from);
        }

        if (/sticker/i.test(mtype)) {
          const buf = await downloadMedia(quotedMsg.message, 'sticker');
          // stickers don't take captions/backgrounds - post as-is
          await postGroupStatus(sock, targetJid, { sticker: buf });
          return react(sock, msg, from);
        }

        if (/^imageMessage$/i.test(mtype)) {
          const buf = await downloadMedia(quotedMsg.message, 'image');
          await postGroupStatus(sock, targetJid, { image: buf, caption: caption || '' });
          return react(sock, msg, from);
        }

        if (/videoMessage/i.test(mtype)) {
          const buf = await downloadMedia(quotedMsg.message, 'video');
          const gifPlayback = !!unwrapped.videoMessage?.gifPlayback;
          await postGroupStatus(sock, targetJid, { video: buf, caption: caption || '', gifPlayback });
          return react(sock, msg, from);
        }

        if (/documentMessage/i.test(mtype)) {
          const buf = await downloadMedia(quotedMsg.message, 'document');
          const docSub = unwrapped.documentMessage || {};
          await postGroupStatus(sock, targetJid, {
            document: buf,
            mimetype: docSub.mimetype || 'application/octet-stream',
            fileName: docSub.fileName || 'file',
            caption: caption || '',
          });
          return react(sock, msg, from);
        }

        if (/audio/i.test(mtype)) {
          const buf = await downloadMedia(quotedMsg.message, 'audio');
          const vnBuf = await toVN(buf).catch(() => buf);
          const waveform = await generateWaveform(buf).catch(() => undefined);
          await postGroupStatus(sock, targetJid, {
            audio: vnBuf,
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true,
            waveform,
          });
          return react(sock, msg, from);
        }

        return extra.reply('❌ Unsupported. Reply to image/video/gif/audio/sticker/document/text.');
      } catch (e) {
        console.error('[groupstatus] outer:', e);
        return extra.reply('❌ Error: ' + (e.message || e));
      }
    },
  },
];

// ── FIXED CORE ─────────────────────────────────────────────────────────
function parseColor(input) {
  if (!input) return undefined;
  // hex string like #9C27B0 -> Baileys expects 0xAARRGGBB integer
  if (typeof input === 'string' && input.startsWith('#')) {
    const hex = input.replace('#','');
    const rgb = parseInt(hex.length === 6? 'FF' + hex : hex, 16);
    return rgb; // ARGB
  }
  if (typeof input === 'number') return input; // already ARGB
  return undefined;
}

async function postGroupStatus(sock, jid, content) {
  // extract our custom opts
  const { backgroundColor: rawBg, font,...mediaContent } = content;
  const backgroundColor = parseColor(rawBg);

  // 1. generate uploadable content - this is the fix:
  // content goes to generateWAMessageContent, not options
  const inside = await generateWAMessageContent(mediaContent, {
    upload: sock.waUploadToServer,
  });

  // 2. fix text background - inside has extendedTextMessage, inject backgroundArgb
  if (inside.extendedTextMessage && backgroundColor!== undefined) {
    inside.extendedTextMessage.backgroundArgb = backgroundColor;
    if (font!== undefined) inside.extendedTextMessage.font = font;
  }

  const secret = crypto.randomBytes(32);

  // 3. envelope MUST be groupStatusMessageV2 with inner messageContextInfo
  // relayMessage will call patchMessageBeforeSending and set mediatype attr correctly
  const waMsg = generateWAMessageFromContent(
    jid,
    {
      messageContextInfo: { messageSecret: secret },
      groupStatusMessageV2: {
        message: {
         ...inside,
          messageContextInfo: { messageSecret: secret },
        },
      },
    },
    { userJid: sock.user.id }
  );

  await sock.relayMessage(jid, waMsg.message, { messageId: waMsg.key.id });
  return waMsg;
}

// Unwraps ephemeral/view-once/document-with-caption layers to reach the
// actual content message.
function unwrapMessage(message) {
  let m = message; let g=0;
  while (m && (m.ephemeralMessage || m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension || m.documentWithCaptionMessage) && g<5) {
    m = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.viewOnceMessageV2Extension?.message || m.documentWithCaptionMessage?.message;
    g++;
  }
  return m;
}

// Finds contextInfo (and therefore the quoted message) regardless of which
// wrapper or message-type key it's nested under.
function extractContext(message) {
  const m = unwrapMessage(message);
  if (!m || typeof m !== 'object') return null;
  for (const key of Object.keys(m)) {
    const val = m[key];
    if (val && typeof val === 'object' && val.contextInfo && val.contextInfo.quotedMessage) {
      return val.contextInfo;
    }
  }
  return null;
}

async function react(sock, msg, from, emoji = SUCCESS_EMOJI) {
  try { await sock.sendMessage(from, { react: { text: emoji, key: msg.key } }); } catch {}
}
async function downloadMedia(msg, type) {
  const mediaMsg = msg[`${type}Message`] || msg;
  const stream = await downloadContentFromMessage(mediaMsg, type);
  const chunks = []; for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}
function toVN(buffer) {
  return new Promise((resolve, reject) => {
    const input = new PassThrough(); const output = new PassThrough(); const chunks=[];
    input.end(buffer);
    ffmpeg(input).noVideo().audioCodec('libopus').format('ogg').audioChannels(1).audioFrequency(48000)
     .on('error', reject).on('end', () => resolve(Buffer.concat(chunks))).pipe(output);
    output.on('data', c=>chunks.push(c));
  });
}
function generateWaveform(buffer, bars=64) {
  return new Promise((resolve, reject) => {
    const input = new PassThrough(); input.end(buffer);
    const output = new PassThrough(); const chunks=[];
    output.on('data', c=>chunks.push(c));
    ffmpeg(input).audioChannels(1).audioFrequency(16000).format('s16le')
     .on('error', reject).on('end', () => {
        const raw = Buffer.concat(chunks); const samples = raw.length/2; const amps=[];
        for(let i=0;i<samples;i++) amps.push(Math.abs(raw.readInt16LE(i*2))/32768);
        const size = Math.floor(amps.length/bars); if(size===0) return resolve(undefined);
        const avg = Array.from({length:bars}, (_,i)=> amps.slice(i*size,(i+1)*size).reduce((a,b)=>a+b,0)/size);
        const max = Math.max(...avg); if(max===0) return resolve(undefined);
        resolve(Buffer.from(avg.map(v=>Math.floor((v/max)*100))).toString('base64'));
      }).pipe(output);
  });
}
