# June-X Web Chat — WhatsApp Feature Research

Deep research on how the planned "pro" features work on WhatsApp (user-facing
behavior + rules) and how Baileys implements them (events, payloads, functions),
with an implementation plan for the June-X web chat UI.

**Feature order (owner's priority):**
reactions → ticks → reply/quote → unread badges → last seen → voice notes →
emoji picker → delete for everyone → in-chat search → history pagination →
polls → mentions → edit messages → forward messages

**What we already have (Phase 1 + 2):** live text chat, media send/receive,
phonebook names, avatars, typing indicators (both ways), global message search
(SQLite), logged-out banner, mobile one-pane layout.

---

## 0. Baileys event map (the backbone of everything)

| Event | Fires when | Key payload |
|---|---|---|
| `messages.upsert` | new messages (in + out) | `{ messages, type: 'notify' \| 'append' }` |
| `messages.update` | **status of an existing message changes** — delivery receipts, read receipts, **reactions**, **poll votes** | `[{ key, update: { status?, pollUpdates?, ... } }]` |
| `messages.reaction` | (some forks) a message is reacted to; `reaction.text` falsey = removed | `[{ key, reaction }]` |
| `message-receipt.update` | **group** receipts (per participant) — `messages.update` carries **no status for group jids** | `[{ key, receipt: { ... } }]` |
| `messages.delete` | messages revoked (delete for everyone / delete for me) | `{ keys: WAMessageKey[] }` or `{ jid, all: true }` |
| `presence.update` | typing / recording / online / offline of contacts | `{ id, presences: { [participant]: { lastKnownPresence, lastSeen } } }` |
| `chats.upsert` / `chats.update` | chat list changes (carries `unreadCount`) | `Chat[]` / `Partial<Chat>[]` |

**WAMessageStatus (map explicitly — off-by-one bugs are common):**
`ERROR = 0, PENDING = 1, SERVER_ACK = 2, DELIVERY_ACK = 3, READ = 4, PLAYED = 5`
[S1](https://baileys.wiki/concepts/events) [S2](https://baileys.wiki/api-reference/variables/WAMessageStatus)

---

## 1. Reactions ⭐

**On WhatsApp:** hover (desktop) / long-press (mobile) a message → 6-emoji quick
bar + "+" for any emoji. One reaction per user per message; reacting again
**changes** it; tapping your own emoji **removes** it (silently — no
notification). Only the original sender is notified of a reaction. Reactions
can't be hidden; counts are public. Reactions on disappearing messages vanish
with the message. [S8](https://faq.whatsapp.com/424198503229937/?locale=en_US&cms_platform=web) [S9](https://pocketnow.com/whatsapp-message-reactions-how-to-use/)

**Baileys mechanics:**
```js
// add / change a reaction
await sock.sendMessage(jid, { react: { text: '👍', key: message.key } })
// remove a reaction: same call with text: ''
await sock.sendMessage(jid, { react: { text: '', key: message.key } })
```
Incoming reactions arrive via `messages.update` (reaction updates) and, in some
builds, a dedicated `messages.reaction` event. [S1](https://baileys.wiki/concepts/events)

**June plan:**
- `POST /api/react { jid, msgId, emoji }` → look up the full message in the
  in-memory store (must be complete), `sendMessage(jid, { react: { text: emoji, key } })`.
- Persist reactions in a small map `msgId → [{ emoji, sender, ts }]` (JSON file,
  survives restarts) and merge into `slimMessage` as `reactions: [{ emoji, count, byMe, senders: [] }]`.
- Hook `messages.update` in `index.js` → forward reaction updates to the web
  module → the open chat re-renders live (we already poll every 2.5s).
- UI: hover a bubble → 😀 button → quick bar of 6 + "+" opens the emoji picker
  (feature 7). Reactions render as a small pill under the bubble.
- **Effort: S. Pitfall:** reacting to a message not in the store (evicted/old)
  fails — return 404 "message expired".

## 2. Ticks (read receipts / message status) ✓✓

**On WhatsApp:** your messages show ✓ (sent) → ✓✓ grey (delivered) → ✓✓ blue
(read). In groups, blue ticks mean **all** members read it. Ticks appear next to
the timestamp inside the bubble. [S1](https://baileys.wiki/concepts/events)

**Baileys mechanics:**
```js
sock.ev.on('messages.update', (updates) => {
  for (const { key, update } of updates) {
    if (update.status) {
      // 1 = sent(PENDING), 2 = SERVER_ACK, 3 = DELIVERY_ACK, 4 = READ, 5 = PLAYED
    }
  }
})
```
- **Critical:** `messages.update` carries **no status for group jids** — group
  receipts route to `message-receipt.update` per participant. Handle both.
- The sender's privacy settings affect whether READ receipts are sent at all.
- **Marking incoming messages read:** `await sock.readMessages([key])` — keys
  must be tracked individually (you cannot mark a whole chat read).

**June plan:**
- Add `status` to `slimMessage` (from the stored message / a status map
  `msgId → status` fed by `messages.update` + `message-receipt.update`).
- UI: ticks inside the bubble next to the timestamp; grey ✓✓ → blue ✓✓
  (June-cyan for "read" to keep the palette).
- **Bonus:** when the owner opens a chat in the web UI, call
  `sock.readMessages(keys)` for that chat's unread incoming messages → the
  friend sees blue ticks (this also feeds feature 4).
- **Effort: S. Pitfalls:** map statuses explicitly (ERROR=0 … PLAYED=5);
  group chats need `message-receipt.update`; status-less updates must be
  skipped (don't reset to PENDING).

## 3. Reply / quote 💬

**On WhatsApp:** reply to a message → your bubble contains a quoted block
(sender name + preview, grey bar on the left, tappable → jumps to the original).
Works for text, media, locations, contacts.

**Baileys mechanics:**
```js
// quoted goes in the OPTIONS (3rd arg), not the content
await sock.sendMessage(jid, { text: 'This is a reply' }, { quoted: originalMessage })
```
- Incoming replies: `msg.message.extendedTextMessage.contextInfo` with
  `stanzaId`, `participant`, `quotedMessage`.
- **Pitfall:** the quoted message object must be **complete** (key + message +
  timestamp) or WhatsApp won't render the quote. Our store keeps full objects —
  good. [S5](https://www.mintlify.com/whiskeysockets/Baileys/messaging/message-options) [S6](https://whiskeysockets-baileys-94.mintlify.app/messaging/text-messages)

**June plan:**
- Extend `POST /api/send` with `quotedMsgId`; look up the full message in the
  store, pass `{ quoted: storedMsg }`.
- `slimMessage` gains `quoted: { id, sender, pushName, text, mediaKind }` built
  from `contextInfo` (unwrap first — replies can be wrapped in ephemeral/VO).
- UI: hover a bubble → "↩ reply" sets a quoted-preview bar above the composer
  (with ✕ to cancel); quoted block inside bubbles is tappable → scrolls to the
  original (needs message anchors by id — also powers feature 9's jump-to).
- **Effort: S.**

## 4. Unread badges 🔢

**On WhatsApp:** chat list items show a count badge for unread messages; the
badge clears when you open the chat. Opening a chat marks its messages read
(blue ticks go to the sender).

**Baileys mechanics:** `Chat.unreadCount` arrives on `chats.upsert` /
`chats.update`, but with `syncFullHistory: false` the bot doesn't reliably get
the chat list. Reading is explicit: `sock.readMessages([keys])` (track keys
yourself). Mark a chat unread: `sock.chatModify({ markRead: false, lastMessages: [lastMsg] }, jid)`.
[S16](https://www.npmjs.com/package/@whiskeysockets/baileys)

**June plan (simpler + more reliable than Baileys chat events):**
- Track read state **in the web layer**: `database/webchat-read.json` =
  `{ [chatJid]: lastReadTs }`. When the owner opens a chat, set
  `lastReadTs = now` and call `sock.readMessages(keys)` for incoming messages.
- Unread count = messages in the store (and SQLite) with `ts > lastReadTs`.
  `/api/chats` returns `unread` per chat; the list renders a cyan badge.
- **Effort: S.**

## 5. Last seen / online / recording 👀

**On WhatsApp:** under a contact's name: "online", "typing…", "recording
audio…", or "last seen today at 14:32" / "last seen yesterday at …".

**Baileys mechanics:**
```js
await sock.presenceSubscribe(jid)   // must subscribe per chat to receive updates
sock.ev.on('presence.update', ({ id, presences }) => {
  // presences[participant] = { lastKnownPresence, lastSeen }  // lastSeen = unix ts
})
await sock.sendPresenceUpdate('composing', jid)   // expires after ~10 s — repeat to sustain
// WAPresence: 'unavailable' | 'available' | 'composing' | 'recording' | 'paused'
```
[S14](https://baileys.wiki/features/presence) [S15](https://baileys.wiki/messaging/message-actions)

**June plan:**
- We already track presence for typing (Phase 2). Extend the header subtitle:
  `composing` → "typing…", `recording` → "recording audio…" (pairs with voice
  notes), `available` → "online", else → "last seen <relative time>" using
  `lastSeen` (store it in our presence map — currently we drop it).
- Groups: show *"Amaka is typing…"* (we have per-participant presence; resolve
  the name via phonebook).
- Subscribe to presence for opened chats: `sock.presenceSubscribe(jid)` when a
  chat is opened via `POST /api/open` (or piggyback on `/api/messages`).
- **Effort: S.**

## 6. Voice notes 🎙️

**On WhatsApp:** hold the mic → record → slide to lock / release to send. The
bubble shows a play button, a waveform, and a duration. While recording, the
other side sees "recording audio…".

**Baileys mechanics:**
```js
await sock.sendMessage(jid, {
  audio: buffer,
  mimetype: 'audio/ogg; codecs=opus',
  ptt: true,          // push-to-talk = voice note
  seconds: 30,        // duration
})
```
- **Waveform pitfall (important):** a plain `sendMessage` with `ptt: true` sends
  the note but WhatsApp renders a **flat waveform line**. To get the real
  waveform you must build the AudioMessage yourself:
  1. Convert audio to **OGG/Opus, mono** (`ffmpeg -ac 1`, libopus) — their repo
     already has `ffmpeg-static` + `fluent-ffmpeg`.
  2. Compute duration + a **64-sample waveform** from PCM amplitude.
  3. `prepareWAMessageMedia({ audio, mimetype, ptt: true }, { upload: sock.waUploadToServer })`
     → patch `audioMessage` with `seconds` + `waveform` →
     `generateWAMessageFromContent(jid, { audioMessage }, { userJid: sock.user.id })`
     → `sock.relayMessage(...)`.
  [S17](https://github.com/webahna/whatsapp-voice-note-sender) [S18](https://whiskeysockets-baileys-85.mintlify.app/messages/sending-media)
- Known upstream bug: waveform missing in Baileys ≥ 6.7.9 (issue #1120).
  [S19](https://github.com/WhiskeySockets/Baileys/issues/1120)
- Browser side: `MediaRecorder` produces `audio/webm;codecs=opus` — send it to
  the server, convert with ffmpeg.
- While recording, broadcast `sendPresenceUpdate('recording', jid)`.

**June plan:**
- `POST /api/voice { jid, audio: <base64 webm>, seconds }` → ffmpeg → ogg/opus
  mono → waveform (64 samples) → manual AudioMessage → relay. Return the sent
  message so it appears in history.
- UI: mic button in the composer (hold-to-record on desktop, tap-toggle on
  mobile), live timer, cancel/send, then a voice-note bubble (play button +
  waveform bars rendered from the `waveform` array — incoming notes carry it in
  `audioMessage.waveform`).
- **Effort: M (ffmpeg conversion + waveform math).**

## 7. Emoji picker 😀

**On WhatsApp:** a smiley button in the composer opens a panel: search,
categories (recent, smileys, animals, food, activities, travel, objects,
symbols, flags), skin-tone variants.

**Mechanics:** purely client-side — no protocol involvement. A small built-in
emoji dataset (grouped JSON) + search input + a popover panel. Zero new
dependencies. (Native OS emoji panel is the zero-effort fallback.)

**June plan:**
- `utils/webChatEmoji.js` (served as a static JS file or inlined): emoji list
  grouped by category, search by name/keyword, recent-emojis row (localStorage).
- Composer gets a 😀 button → popover above the input; click inserts at caret.
- The same panel powers the reaction quick-bar (feature 1).
- **Effort: S.**

## 8. Delete for everyone 🗑️

**On WhatsApp:** long-press your message → Delete → "Delete for everyone".
Everyone sees a grey italic *"This message was deleted"* placeholder. **Rules:**
~48-hour window (after that, only "delete for me"); group admins can delete
anyone's messages; media already saved to a recipient's Photos may remain;
nobody can recover it unless it was in a backup. [S3](https://www.mintlify.com/whiskeysockets/Baileys/messaging/modifying-messages) [S22](https://timelines.ai/managing-messages-on-whatsapp-how-to-edit-and-delete-messages)

**Baileys mechanics:**
```js
const msg = await sock.sendMessage(jid, { text: 'oops' })
await sock.sendMessage(jid, { delete: msg.key })   // sends protocolMessage REVOKE
// group admin deleting someone else's message:
await sock.sendMessage(msg.key.remoteJid, { delete: msg.key })
```
Incoming revocations arrive as a message with
`message.protocolMessage.type === 'REVOKE'` (+ the `messages.delete` event).
Errors: 404 (not found / already deleted), 403 (no permission).

**June plan:**
- `POST /api/delete { jid, msgId }` → look up key in store →
  `sendMessage(jid, { delete: key })`. Validate: message exists, is ≤ 48h old,
  and is fromMe (or group admin — check via groupMetadata if we want admin deletes).
- Mark the message `deleted: true` in our store/SQLite (keep the tombstone so
  the bubble shows *"This message was deleted"* instead of vanishing).
- Detect incoming REVOKE in the message feed → mark tombstone → live re-render.
- `slimMessage` gains `deleted: true` → UI renders the italic placeholder.
- **Effort: S. Pitfall:** deleting a message not in the store (old) → 404;
  catch and report "message expired".

## 9. In-chat search with jump-to 🔍

**On WhatsApp:** a chat has its own search (magnifier in the header) → results
listed with snippets → tap a result → the thread scrolls/jumps to that message
and briefly highlights it.

**Mechanics:** pure web-layer feature. Our SQLite index already stores every
message with `chat_jid`, `msg_id`, `text`, `ts`.

**June plan:**
- `GET /api/search?jid=...&q=...` (scoped variant of the existing global search).
- UI: when a chat is open, the header gets a 🔍 toggle → a search bar replaces
  the chat list (mobile) / appears above the thread (desktop) → results list →
  tap → `openChat` + scroll to `data-msg-id` anchor + flash highlight.
- Messages render with `data-msg-id` anchors (also used by quoted-block taps,
  feature 3).
- **Effort: S.**

## 10. History pagination ⬆️

**On WhatsApp:** scroll to the top of a chat → older messages load
automatically (infinite scroll upward).

**Mechanics:** Baileys history sync is limited (`syncFullHistory: false`,
`downloadHistory: false` in this bot). **Our SQLite index is the history
store** — it already keeps 30 days / 100k rows.

**June plan:**
- `GET /api/messages?jid=...&before=<ts>&limit=50` → paginate from SQLite
  (`WHERE chat_jid = ? AND ts < ? ORDER BY ts DESC LIMIT ?`), merge with the
  in-memory store for the newest messages.
- UI: when the thread is scrolled to the top, fetch the previous page and
  prepend (preserve scroll position). Show a small "loading older…" indicator.
- **Effort: M. Note:** media in old messages can't be re-downloaded (Baileys
  CDN links die) — render those as "media expired" labels.

## 11. Polls 📊

**On WhatsApp:** in groups (and channels), create a poll: question + options,
single or multi-select. Results show live vote bars + counts; you can change
your vote; the creator can end the poll.

**Baileys mechanics:**
```js
// create (V3)
await sock.sendMessage(jid, { poll: { name: 'Lunch?', values: ['🍲', '🍕'], selectableCount: 1 } })
// V4/V5 add: endDate, hideVoter, canAddOption, correctAnswer, pollType
```
Votes arrive as `pollUpdateMessage` inside `messages.upsert`:
`{ pollCreationMessageKey, vote: { encPayload, encIv }, senderTimestampMs }`.
Decrypt with `decryptPollVote(vote, { pollEncKey, pollCreatorJid, voterJid })`
where `pollEncKey = storedPoll.messageContextInfo.messageSecret` — **the poll
creation message must be in the store**, and `getMessage` must be configured.
Aggregate with `getAggregateVotesInPollMessage({ message, pollUpdates })`.
Final votes land on `messages.update` as `update.pollUpdates`.
**Pitfall (documented upstream bugs):** vote encryption uses **LID for the
creator, PN for the voter** — try `[creatorLid, voterPn]` then `[creatorPn, voterPn]`
combos; without the right combo decryption fails silently. [S10](https://github.com/WhiskeySockets/Baileys/issues/2158) [S11](https://github.com/WhiskeySockets/Baileys/issues/2342) [S12](https://www.npmjs.com/package/@realvare/baileys) [S1](https://baileys.wiki/concepts/events)

**June plan:**
- `POST /api/poll { jid, name, options: [...], selectableCount }` → create;
  store the returned poll message (so votes can decrypt).
- Poll votes can't be cast via a plain "send" — the web UI needs the encrypted
  vote. Practical approach: voting happens by **replying to the poll with the
  option number/text** (like WhatsApp's "vote by replying" fallback), and the
  bot casts the real vote... Actually the clean way: Baileys has no simple
  "vote" helper — the official clients encrypt votes with the poll's
  messageSecret. Simplest robust v1: the web UI shows live results
  (decrypted via `messages.update` pollUpdates), and **creating** polls works;
  casting votes from the web UI is V2 (encrypt with the poll secret using the
  same scheme the clients use — non-trivial).
- UI: poll bubble = question + option rows with vote bars + counts + "x votes".
- **Effort: M for create + live results; L for web-side voting.**

## 12. Mentions @

**On WhatsApp:** in groups, typing `@` opens an autocomplete of members; the
mention renders as blue highlighted `@name` and pings the person.

**Baileys mechanics:**
```js
await sock.sendMessage(jid, {
  text: 'Hey @2348111111111, look',
  mentions: ['2348111111111@s.whatsapp.net'],   // full JIDs; @number in text is cosmetic but recommended
})
```
Incoming mentions: `extendedTextMessage.contextInfo.mentionedJid: string[]`.
[S6](https://whiskeysockets-baileys-94.mintlify.app/messaging/text-messages) [S7](https://baileys.wiki/messaging/sending-messages)

**June plan:**
- `GET /api/groupmembers?jid=...` → `sock.groupMetadata(jid)` → participants
  (id, admin flags) + resolve names via phonebook; cached.
- Composer: on `@` in a group chat, show an autocomplete dropdown (filter by
  name/number); pick → insert `@<number>` and add the JID to a `mentions` set.
- `POST /api/send` gains `mentions: [jids]` → passed to sendMessage.
- Render incoming `mentionedJid` as highlighted spans (parse `@digits` in text).
- **Effort: M.**

## 13. Edit your messages ✏️

**On WhatsApp:** long-press your message → Edit (available **15 minutes** after
sending, text only, only your own messages, only from the same device). The
message updates for everyone and shows an **"edited"** label next to the
timestamp. **No new notification, no edit history, timestamp unchanged.**
After 15 minutes the fallback is: delete for everyone + send a corrected message.
[S3](https://www.mintlify.com/whiskeysockets/Baileys/messaging/modifying-messages) [S21](https://getkanal.com/blog/edit-whatsapp-message) [S22](https://timelines.ai/managing-messages-on-whatsapp-how-to-edit-and-delete-messages)

**Baileys mechanics:**
```js
const msg = await sock.sendMessage(jid, { text: 'Original' })
await sock.sendMessage(jid, { text: 'Updated', edit: msg.key })  // protocolMessage MESSAGE_EDIT
```
Incoming edits arrive as `protocolMessage` with `type: MESSAGE_EDIT` and
`editedMessage` (the new content) — the original is replaced in place.

**June plan:**
- `POST /api/edit { jid, msgId, text }` → validate (fromMe, text-only, ≤ 15 min
  old, in store) → `sendMessage(jid, { text, edit: key })`.
- Update the stored message + SQLite row with the new text; set `edited: true`
  (and keep `editedAt`).
- `slimMessage` gains `edited: true` → UI renders a small "edited" label next to
  the timestamp.
- Incoming MESSAGE_EDIT → apply to store/SQLite → live re-render.
- **Effort: S. Pitfall:** window expired → WhatsApp rejects; catch and tell the
  user to delete + resend.

## 14. Forward messages ↗️

**On WhatsApp:** select one or more messages → forward → pick chats. The
forwarded bubble shows a *"Forwarded"* label. Media forwards too.

**Baileys mechanics:**
```js
const msg = getMessageFromStore(jid, msgId)   // full message object required
await sock.sendMessage(targetJid, { forward: msg })   // WA forward the message!
```
Incoming forwarded messages carry `contextInfo.forwardingScore > 0` /
`isForwarded: true`. [S20](https://www.npmjs.com/package/@whiskeysockets/baileys)

**June plan:**
- Selection mode in the thread: long-press a bubble → "select" → checkboxes on
  bubbles → toolbar shows "forward" → chat picker (reuse the chat list as a
  picker) → `POST /api/forward { toJid, fromJid, msgIds: [...] }` → loop
  `sendMessage(toJid, { forward: msg })`.
- `slimMessage` gains `forwarded: true` when `forwardingScore > 0` → UI shows the
  "Forwarded" label above the bubble.
- **Effort: M. Pitfall:** forwarding needs the full message object in the store;
  old/evicted messages can't be forwarded (media would need re-upload anyway).

---

## Cross-cutting: data model changes

Add to the message record (in-memory store + SQLite `webchat_messages`):

| Field | Type | Source |
|---|---|---|
| `status` | int (0-5) | `messages.update` / `message-receipt.update` |
| `reactions` | `[{ emoji, sender, ts }]` | `messages.update` / `messages.reaction` |
| `quoted` | `{ id, sender, pushName, text, mediaKind }` | `contextInfo` on incoming |
| `edited` / `editedAt` | bool / ts | `protocolMessage.MESSAGE_EDIT` |
| `deleted` | bool | `protocolMessage.REVOKE` / `messages.delete` |
| `forwarded` | bool | `contextInfo.forwardingScore` |
| `mentions` | string[] | `contextInfo.mentionedJid` |
| `poll` | `{ name, options, votes }` | poll creation + `pollUpdates` |

New SQLite tables (extend `webChatStore`): `webchat_reactions`, and a
`webchat_read` table (or JSON file) for read state. Add a `meta` column to
`webchat_messages` (JSON) for edited/deleted/forwarded flags.

## Suggested build order (owner's priority, with dependencies)

1. **Reactions** (S) — needs `messages.update` hook (also feeds ticks + polls)
2. **Ticks** (S) — same hook
3. **Reply/quote** (S)
4. **Unread badges** (S) — + `readMessages` on chat open (feeds ticks)
5. **Last seen** (S) — extends existing presence map
6. **Voice notes** (M) — ffmpeg + waveform; uses `recording` presence
7. **Emoji picker** (S) — also powers the reaction bar
8. **Delete for everyone** (S)
9. **In-chat search + jump-to** (S)
10. **History pagination** (M) — SQLite
11. **Polls** (M create+results / L voting)
12. **Mentions** (M)
13. **Edit messages** (S)
14. **Forward messages** (M)

**Foundation first:** the `messages.update` hook in `index.js` (one listener
forwarding to the web module) unlocks reactions, ticks, and poll results in one
move.

## Sources

- [S1](https://baileys.wiki/concepts/events) — Baileys events: `messages.update` (status/reactions/pollUpdates)
- [S2](https://baileys.wiki/api-reference/variables/WAMessageStatus) — WAMessageStatus enum
- [S3](https://www.mintlify.com/whiskeysockets/Baileys/messaging/modifying-messages) — delete + edit messages
- [S4](https://baileys.wiki/messaging/message-actions) — edit/delete/read/presence actions
- [S5](https://www.mintlify.com/whiskeysockets/Baileys/messaging/message-options) — quoted messages, contextInfo
- [S6](https://whiskeysockets-baileys-94.mintlify.app/messaging/text-messages) — mentions, quoting
- [S7](https://baileys.wiki/messaging/sending-messages) — mentions
- [S8](https://faq.whatsapp.com/424198503229937/?locale=en_US&cms_platform=web) — WhatsApp reactions FAQ (rules)
- [S9](https://pocketnow.com/whatsapp-message-reactions-how-to-use/) — reactions UX
- [S10](https://github.com/WhiskeySockets/Baileys/issues/2158) — poll vote decryption bug
- [S11](https://github.com/WhiskeySockets/Baileys/issues/2342) — poll LID/PN fix
- [S12](https://www.npmjs.com/package/@realvare/baileys) — poll creation (V3/V4/V5)
- [S14](https://baileys.wiki/features/presence) — presence states, subscribe, 10s expiry
- [S15](https://baileys.wiki/messaging/message-actions) — WAPresence values
- [S16](https://www.npmjs.com/package/@whiskeysockets/baileys) — readMessages, chatModify
- [S17](https://github.com/webahna/whatsapp-voice-note-sender) — PTT waveform pipeline
- [S18](https://whiskeysockets-baileys-85.mintlify.app/messages/sending-media) — voice notes (ptt)
- [S19](https://github.com/WhiskeySockets/Baileys/issues/1120) — ptt waveform regression
- [S20](https://www.npmjs.com/package/@whiskeysockets/baileys) — forwarding (`{ forward: msg }`)
- [S21](https://getkanal.com/blog/edit-whatsapp-message) — edit: 15-min rule, "edited" label
- [S22](https://timelines.ai/managing-messages-on-whatsapp-how-to-edit-and-delete-messages) — edit vs delete rules (48h)
