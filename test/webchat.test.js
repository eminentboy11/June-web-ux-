'use strict';

/**
 * Tests for utils/webChat.js — spins up a real Express server with a mock
 * Baileys socket and exercises the whole auth + chat API surface:
 * auth, chats, messages, search, media (send + receive), avatars, typing
 * indicators and the phonebook.
 *
 * Run:  node --test test/webchat.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

process.env.WEB_PASSWORD = process.env.WEB_PASSWORD || 'test-pass';

const { attachChatUI } = require('../utils/webChat');
const { createMessageStore } = require('../utils/messageStore');
const { createWebChatStore } = require('../utils/webChatStore');
const pollCrypto = require('../utils/webChatPoll');

const DM = '2348111111111@s.whatsapp.net';
const GROUP = '120363000000@g.us';
const PN2 = '2349000000001@s.whatsapp.net';
const LID2 = '71109999999999@lid';
const PN3 = '2349000000003@s.whatsapp.net';
const ANN_GROUP = '120363111000@g.us';
const ANN_ADMIN_GROUP = '120363222000@g.us';
const ANN_UNKNOWN_GROUP = '120363333000@g.us';
const ANN_LID_GROUP = '120363444000@g.us';
const OWNER_PN = '2348000000000@s.whatsapp.net';

const voiceCalls = [];
const relayCalls = [];
const pollSecret = Buffer.from('0123456789abcdef0123456789abcdef');

// What the mock socket reports back for each kind of outgoing message.
function messageFor(content) {
    if (content.text) return { conversation: content.text };
    if (content.poll) return {
        pollCreationMessageV3: {
            name: content.poll.name,
            selectableCount: content.poll.selectableCount,
            options: content.poll.values.map((optionName) => ({ optionName })),
        },
        messageContextInfo: { messageSecret: pollSecret },
    };
    return content;
}

// 2 seconds of 16 kHz mono PCM with a ramp, for the voice-note analysis.
function fakePcm() {
    const buf = Buffer.alloc(16000 * 2 * 2);
    for (let i = 0; i < buf.length / 2; i++) buf.writeInt16LE(Math.round((i % 400) * 40), i * 2);
    return buf;
}

function makeMsg({ id, jid, fromMe = false, text, participant, ts, pushName }) {
    return {
        key: { id, remoteJid: jid, fromMe, ...(participant ? { participant } : {}) },
        message: { conversation: text },
        messageTimestamp: ts,
        pushName: pushName || (fromMe ? '' : 'Friend'),
    };
}

// In-memory LID ↔ PN map with the same interface as the production adapter.
function makeMemoryJidMap() {
    const lidToPn = new Map();
    const pnToLid = new Map();
    const isLid = (j) => String(j).endsWith('@lid');
    const isPn = (j) => String(j).endsWith('@s.whatsapp.net');
    return {
        link(a, b) {
            let lid = null, pn = null;
            if (isLid(a) && isPn(b)) { lid = String(a); pn = String(b); }
            else if (isLid(b) && isPn(a)) { lid = String(b); pn = String(a); }
            else return;
            lidToPn.set(lid, pn);
            pnToLid.set(pn, lid);
        },
        pnForLid(lid) { return lidToPn.get(String(lid)) || null; },
        lidForPn(pn) { return pnToLid.get(String(pn)) || null; },
        canonical(jid) {
            const j = String(jid || '');
            return isLid(j) ? (lidToPn.get(j) || j) : j;
        },
        related(jid) {
            const j = String(jid || '');
            const out = [j];
            if (isLid(j)) { const p = lidToPn.get(j); if (p) out.push(p); }
            else if (isPn(j)) { const l = pnToLid.get(j); if (l) out.push(l); }
            return out;
        },
        async enrich() {},
    };
}

async function startTestServer() {
    const app = express();
    const store = createMessageStore({ maxPerChat: 100, maxChats: 50 });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-test-'));
    const chatStore = createWebChatStore({
        dbPath: path.join(tmpDir, 'webchat.db'),
        phonebookPath: path.join(tmpDir, 'phonebook.json'),
    });
    const sent = [];
    const presenceCalls = [];
    const readCalls = [];
    let downloadCalls = 0;
    const sock = {
        user: { id: '2348000000000:5@s.whatsapp.net', lid: '71100000000000:3@lid' },
        sendMessage: async (jid, content, options) => {
            sent.push({ jid, content, options });
            return {
                key: { id: 'SENT' + sent.length, remoteJid: jid, fromMe: true },
                message: messageFor(content),
                messageTimestamp: Math.floor(Date.now() / 1000),
            };
        },
        sendPresenceUpdate: async (presence, jid) => {
            presenceCalls.push({ presence, jid });
        },
        relayMessage: async (jid, message, opts) => {
            relayCalls.push({ jid, message, opts });
            return 'RELAY' + relayCalls.length;
        },
        readMessages: async (keys) => {
            readCalls.push(keys);
        },
        groupMetadata: async (jid) => {
            // Admin-only ("announce") groups: the owner is a plain member, or an admin.
            if (jid === ANN_GROUP) return { subject: 'Announce', announce: true, participants: [{ id: OWNER_PN }, { id: DM }] };
            if (jid === ANN_LID_GROUP) return { subject: 'LID admins', announce: true, participants: [
                { id: '71100000005555@lid', phoneNumber: '2347000000009@s.whatsapp.net', admin: 'admin' },
                { id: DM },
            ] };
            if (jid === ANN_UNKNOWN_GROUP) return { subject: 'Announce, owner not listed', announce: true, participants: [{ id: DM }] };
            if (jid === ANN_ADMIN_GROUP) return { subject: 'Announce admin', announce: true, participants: [{ id: OWNER_PN, admin: 'admin' }, { id: DM }] };
            return { subject: 'Test Group ' + jid.slice(0, 6), participants: [{ id: DM }, { id: LID2 }] };
        },
        profilePictureUrl: async (jid) => 'https://cdn.example.com/' + encodeURIComponent(jid) + '.jpg',
    };
    const jidMap = makeMemoryJidMap();
    const handle = attachChatUI(app, {
        getSock: () => sock,
        getBotState: () => 'connected',
        store,
        chatStore,
        jidMap,
        log: () => {},
        convertAudio: async () => ({ opus: Buffer.from('OPUS'), pcm: fakePcm() }),
        sendVoice: async (sock, jid, opus, opts) => {
            voiceCalls.push({ jid, opus, ...opts });
            return { key: { id: 'VOICE' + voiceCalls.length, remoteJid: jid, fromMe: true }, message: { audioMessage: { ptt: true } }, messageTimestamp: Math.floor(Date.now() / 1000) };
        },
        newMsgId: () => 'PMSG' + relayCalls.length,
        downloadMedia: async () => {
            downloadCalls++;
            return Buffer.from('PNGBYTES');
        },
    });
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;
    return {
        server, port, store, chatStore, jidMap, sent, presenceCalls, readCalls, sock,
        getDownloadCalls: () => downloadCalls,
        handle,
        cleanup: () => {
            server.close();
            chatStore.close();
            fs.rmSync(tmpDir, { recursive: true, force: true });
        },
    };
}

test('web chat UI', async (t) => {
    const ctx = await startTestServer();
    const { port, store, sent, presenceCalls, readCalls, handle } = ctx;
    const base = `http://127.0.0.1:${port}`;
    t.after(() => ctx.cleanup());

    // Seed the recent-message store with one DM and one group message.
    store.storeMessage(DM, makeMsg({ id: 'A1', jid: DM, text: 'hello bot', ts: 1700000000 }));
    store.storeMessage(GROUP, makeMsg({
        id: 'G1', jid: GROUP, text: 'hi group',
        participant: DM, ts: 1700000060,
    }));
    // A media message (image with caption).
    store.storeMessage(DM, {
        key: { id: 'MEDIA1', remoteJid: DM, fromMe: false },
        message: { imageMessage: { mimetype: 'image/png', caption: 'look at this', mediaKey: Buffer.from('k'), directPath: '/x', url: 'https://x' } },
        messageTimestamp: 1700000120,
        pushName: 'Friend',
    });

    await t.test('chat page redirects to /login when unauthenticated', async () => {
        const r = await fetch(`${base}/chat`, { redirect: 'manual' });
        assert.equal(r.status, 302);
        assert.equal(r.headers.get('location'), '/login');
    });

    await t.test('api returns 401 when unauthenticated', async () => {
        const r = await fetch(`${base}/api/status`);
        assert.equal(r.status, 401);
    });

    await t.test('login page is public', async () => {
        const r = await fetch(`${base}/login`);
        assert.equal(r.status, 200);
        assert.ok((await r.text()).includes('June-X'));
    });

    await t.test('login rejects a wrong password', async () => {
        const r = await fetch(`${base}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: 'nope' }),
        });
        assert.equal(r.status, 401);
    });

    let cookie;
    await t.test('login accepts the right password and sets a session cookie', async () => {
        const r = await fetch(`${base}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: 'test-pass' }),
        });
        assert.equal(r.status, 200);
        const setCookie = r.headers.get('set-cookie');
        assert.ok(setCookie && setCookie.includes('june_web_session='), 'session cookie set');
        cookie = setCookie.split(';')[0];
    });

    await t.test('status works with the session cookie', async () => {
        const r = await fetch(`${base}/api/status`, { headers: { cookie } });
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.equal(j.botState, 'connected');
        assert.equal(j.number, '2348000000000');
        assert.equal(j.loggedOut, false);
    });

    await t.test('chat page serves the UI with the session cookie', async () => {
        const r = await fetch(`${base}/chat`, { headers: { cookie } });
        assert.equal(r.status, 200);
        assert.ok((await r.text()).includes('Web Chat'));
    });

    await t.test('chats lists the seeded DM and group', async () => {
        const r = await fetch(`${base}/api/chats`, { headers: { cookie } });
        const j = await r.json();
        assert.equal(j.ok, true);
        const jids = j.chats.map((c) => c.jid);
        assert.ok(jids.includes(DM));
        assert.ok(jids.includes(GROUP));
    });

    await t.test('group subject is resolved in the background', async () => {
        await new Promise((r) => setTimeout(r, 300)); // let the background fetch land
        const r = await fetch(`${base}/api/chats`, { headers: { cookie } });
        const j = await r.json();
        const group = j.chats.find((c) => c.jid === GROUP);
        assert.ok(group.name && group.name.startsWith('Test Group'), `group name resolved, got: ${group.name}`);
    });

    await t.test('messages returns the seeded history with media descriptors', async () => {
        const r = await fetch(`${base}/api/messages?jid=${encodeURIComponent(DM)}`, { headers: { cookie } });
        const j = await r.json();
        assert.equal(j.messages.length, 2);
        assert.equal(j.messages[0].text, 'hello bot');
        assert.equal(j.messages[1].media.kind, 'image');
        assert.equal(j.messages[1].media.mime, 'image/png');
        assert.equal(j.messages[1].text, 'look at this'); // caption, not a label
    });

    await t.test('messages rejects an invalid jid', async () => {
        const r = await fetch(`${base}/api/messages?jid=evil`, { headers: { cookie } });
        assert.equal(r.status, 400);
    });

    await t.test('admin-only group: a non-admin owner is told they cannot send', async () => {
        const j = await (await fetch(`${base}/api/messages?jid=${encodeURIComponent(ANN_GROUP)}`, { headers: { cookie } })).json();
        assert.equal(j.groupAccess.announce, true);
        assert.equal(j.groupAccess.canSend, false);
    });

    await t.test('admin-only group: sending is refused by the server with a clear message', async () => {
        const r = await fetch(`${base}/api/send`, {
            method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: ANN_GROUP, text: 'can I talk?' }),
        });
        assert.equal(r.status, 403);
        assert.match((await r.json()).error, /Only admins can send/);
    });

    await t.test('admin-only group: an admin owner can still send', async () => {
        const j = await (await fetch(`${base}/api/messages?jid=${encodeURIComponent(ANN_ADMIN_GROUP)}`, { headers: { cookie } })).json();
        assert.equal(j.groupAccess.canSend, true);
        const r = await fetch(`${base}/api/send`, {
            method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: ANN_ADMIN_GROUP, text: 'admin hello' }),
        });
        assert.equal(r.status, 200);
        sent.length = 0; // keep the shared outbox clean for the next send test
    });

    await t.test('admin-only group: when the owner cannot be matched, sending fails closed', async () => {
        const j = await (await fetch(`${base}/api/messages?jid=${encodeURIComponent(ANN_UNKNOWN_GROUP)}`, { headers: { cookie } })).json();
        assert.equal(j.groupAccess.canSend, false);
        const r = await fetch(`${base}/api/send`, {
            method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: ANN_UNKNOWN_GROUP, text: 'should not go out' }),
        });
        assert.equal(r.status, 403);
        assert.equal(sent.length, 0, 'nothing reached the socket');
    });

    await t.test('group members mark the owner and their admin status', async () => {
        const j = await (await fetch(`${base}/api/groupmembers?jid=${encodeURIComponent(ANN_ADMIN_GROUP)}`, { headers: { cookie } })).json();
        const me = j.members.find((m) => m.me);
        assert.ok(me, 'owner is flagged as me');
        assert.equal(me.admin, true);
        assert.equal(j.members.filter((m) => m.admin && !m.me).length, 0, 'no other admins in this fixture');
    });

    await t.test('group members are shown by phone number, never by a raw LID', async () => {
        const j = await (await fetch(`${base}/api/groupmembers?jid=${encodeURIComponent(ANN_LID_GROUP)}`, { headers: { cookie } })).json();
        const admin = j.members.find((m) => m.admin);
        assert.equal(admin.jid, '2347000000009@s.whatsapp.net', 'opens the phone-number chat');
        assert.equal(admin.name, '+2347000000009');
        assert.ok(!j.members.some((m) => m.jid.endsWith('@lid')), 'no LID addresses in the list');
    });

    await t.test('normal group stays open to everyone', async () => {
        const j = await (await fetch(`${base}/api/messages?jid=${encodeURIComponent(GROUP)}`, { headers: { cookie } })).json();
        assert.equal(j.groupAccess.canSend, true);
        assert.equal(j.groupAccess.announce, false);
    });

    await t.test('send validates the jid', async () => {
        const r = await fetch(`${base}/api/send`, {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: 'evil;drop', text: 'hi' }),
        });
        assert.equal(r.status, 400);
    });

    await t.test('send delivers text via the socket and stores the outgoing message', async () => {
        const r = await fetch(`${base}/api/send`, {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, text: 'hi from web' }),
        });
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.equal(j.ok, true);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].content.text, 'hi from web');

        const r2 = await fetch(`${base}/api/messages?jid=${encodeURIComponent(DM)}`, { headers: { cookie } });
        const j2 = await r2.json();
        assert.equal(j2.messages.at(-1).fromMe, true);
        assert.equal(j2.messages.at(-1).text, 'hi from web');
    });

    await t.test('send delivers media as an image payload', async () => {
        const data = Buffer.from('fake-image-bytes').toString('base64');
        const r = await fetch(`${base}/api/send`, {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, media: { mime: 'image/png', fileName: 'pic.png', data } }),
        });
        assert.equal(r.status, 200);
        const last = sent.at(-1);
        assert.ok(Buffer.isBuffer(last.content.image), 'image buffer sent');
        assert.equal(last.content.image.toString(), 'fake-image-bytes');
    });

    await t.test('send rejects invalid media', async () => {
        const r = await fetch(`${base}/api/send`, {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, media: { mime: 'image/png' } }),
        });
        assert.equal(r.status, 400);
    });

    await t.test('media endpoint downloads, serves and caches', async () => {
        const r1 = await fetch(`${base}/api/media?jid=${encodeURIComponent(DM)}&id=MEDIA1`, { headers: { cookie } });
        assert.equal(r1.status, 200);
        assert.equal(r1.headers.get('content-type'), 'image/png');
        assert.equal(await r1.text(), 'PNGBYTES');
        assert.equal(ctx.getDownloadCalls(), 1);

        const r2 = await fetch(`${base}/api/media?jid=${encodeURIComponent(DM)}&id=MEDIA1`, { headers: { cookie } });
        assert.equal(r2.status, 200);
        assert.equal(ctx.getDownloadCalls(), 1, 'second request served from cache');
    });

    await t.test('media endpoint honours Range requests for audio seeking', async () => {
        const url = `${base}/api/media?jid=${encodeURIComponent(DM)}&id=MEDIA1`;
        const full = await fetch(url, { headers: { cookie } });
        assert.equal(full.headers.get('accept-ranges'), 'bytes');
        assert.equal(full.status, 200);

        const mid = await fetch(url, { headers: { cookie, range: 'bytes=3-' } });
        assert.equal(mid.status, 206);
        assert.equal(mid.headers.get('content-range'), 'bytes 3-7/8');
        assert.equal(await mid.text(), 'BYTES');

        const head = await fetch(url, { headers: { cookie, range: 'bytes=0-2' } });
        assert.equal(head.status, 206);
        assert.equal(head.headers.get('content-range'), 'bytes 0-2/8');
        assert.equal(await head.text(), 'PNG');

        const tail = await fetch(url, { headers: { cookie, range: 'bytes=-5' } });
        assert.equal(tail.status, 206);
        assert.equal(await tail.text(), 'BYTES');

        const bad = await fetch(url, { headers: { cookie, range: 'bytes=50-60' } });
        assert.equal(bad.status, 416);
        assert.equal(bad.headers.get('content-range'), 'bytes */8');
    });

    await t.test('media endpoint validates input', async () => {
        const badJid = await fetch(`${base}/api/media?jid=evil&id=MEDIA1`, { headers: { cookie } });
        assert.equal(badJid.status, 400);
        const badId = await fetch(`${base}/api/media?jid=${encodeURIComponent(DM)}&id=../etc`, { headers: { cookie } });
        assert.equal(badId.status, 400);
        const unknown = await fetch(`${base}/api/media?jid=${encodeURIComponent(DM)}&id=NOPE`, { headers: { cookie } });
        assert.equal(unknown.status, 404);
        const notMedia = await fetch(`${base}/api/media?jid=${encodeURIComponent(DM)}&id=A1`, { headers: { cookie } });
        assert.equal(notMedia.status, 400);
    });

    await t.test('avatar endpoint serves the profile picture', async () => {
        const origFetch = global.fetch;
        let fetchCalls = 0;
        global.fetch = async (url, opts) => {
            // Only intercept the avatar CDN URL; pass test-server requests through.
            if (String(url).includes('cdn.example.com')) {
                fetchCalls++;
                return new Response(Buffer.from('JPEGDATA'), { headers: { 'content-type': 'image/jpeg' } });
            }
            return origFetch(url, opts);
        };
        try {
            const r1 = await fetch(`${base}/api/avatar?jid=${encodeURIComponent(DM)}`, { headers: { cookie } });
            assert.equal(r1.status, 200);
            assert.equal(r1.headers.get('content-type'), 'image/jpeg');
            assert.equal(await r1.text(), 'JPEGDATA');
            const r2 = await fetch(`${base}/api/avatar?jid=${encodeURIComponent(DM)}`, { headers: { cookie } });
            assert.equal(r2.status, 200);
            assert.equal(fetchCalls, 1, 'second request served from cache');
        } finally {
            global.fetch = origFetch;
        }
    });

    await t.test('avatar endpoint validates the jid', async () => {
        const r = await fetch(`${base}/api/avatar?jid=evil`, { headers: { cookie } });
        assert.equal(r.status, 400);
    });

    await t.test('typing endpoint forwards presence to the socket', async () => {
        const r = await fetch(`${base}/api/typing`, {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, composing: true }),
        });
        assert.equal(r.status, 200);
        assert.deepEqual(presenceCalls.at(-1), { presence: 'composing', jid: DM });
        const r2 = await fetch(`${base}/api/typing`, {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, composing: false }),
        });
        assert.equal(r2.status, 200);
        assert.deepEqual(presenceCalls.at(-1), { presence: 'paused', jid: DM });
    });

    await t.test('typing endpoint validates the jid', async () => {
        const r = await fetch(`${base}/api/typing`, {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: 'evil', composing: true }),
        });
        assert.equal(r.status, 400);
    });

    await t.test('incoming presence shows up in the messages response', async () => {
        handle.handlePresenceUpdate(DM, { [DM]: { lastKnownPresence: 'composing' } });
        const r = await fetch(`${base}/api/messages?jid=${encodeURIComponent(DM)}`, { headers: { cookie } });
        const j = await r.json();
        assert.equal(j.presence, 'composing');
    });

    await t.test('group presence aggregates participants', async () => {
        handle.handlePresenceUpdate(GROUP, { [DM]: { lastKnownPresence: 'composing' } });
        const r = await fetch(`${base}/api/messages?jid=${encodeURIComponent(GROUP)}`, { headers: { cookie } });
        const j = await r.json();
        assert.equal(j.presence, 'composing');
    });

    await t.test('search finds indexed messages', async () => {
        handle.logMessage(makeMsg({ id: 'S1', jid: DM, text: 'birthday party on saturday', ts: 1700000200, pushName: 'Amaka' }));
        handle.logMessage(makeMsg({ id: 'S2', jid: DM, text: 'see you there', ts: 1700000260, pushName: 'Amaka' }));
        const r = await fetch(`${base}/api/search?q=birthday`, { headers: { cookie } });
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.equal(j.results.length, 1);
        assert.equal(j.results[0].text, 'birthday party on saturday');
        assert.equal(j.results[0].chatJid, DM);
    });

    await t.test('search escapes LIKE wildcards', async () => {
        const r = await fetch(`${base}/api/search?q=${encodeURIComponent('100%')}`, { headers: { cookie } });
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.equal(j.results.length, 0, 'no literal match for 100% — and no crash');
    });

    await t.test('search requires a query', async () => {
        const r = await fetch(`${base}/api/search?q=`, { headers: { cookie } });
        assert.equal(r.status, 400);
    });

    await t.test('phonebook turns numbers into names', async () => {
        const r = await fetch(`${base}/api/chats`, { headers: { cookie } });
        const j = await r.json();
        const dm = j.chats.find((c) => c.jid === DM);
        assert.equal(dm.name, 'Amaka', 'DM shown with the WhatsApp profile name');
    });

    await t.test('react endpoint sends a WhatsApp reaction and stores it', async () => {
        store.storeMessage(DM, makeMsg({ id: 'R1', jid: DM, fromMe: true, text: 'react to me', ts: 1700000200 }));
        const r = await fetch(`${base}/api/react`, {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, msgId: 'R1', emoji: '👍' }),
        });
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.equal(j.ok, true);
        assert.deepEqual(j.reactions, [{ emoji: '👍', count: 1, byMe: true }]);
        const last = sent.at(-1);
        assert.equal(last.jid, DM);
        assert.equal(last.content.react.text, '👍');
        assert.equal(last.content.react.key.id, 'R1');
        const r2 = await fetch(`${base}/api/messages?jid=${encodeURIComponent(DM)}`, { headers: { cookie } });
        const m = (await r2.json()).messages.find((x) => x.id === 'R1');
        assert.deepEqual(m.reactions, [{ emoji: '👍', count: 1, byMe: true }]);
    });

    await t.test('react endpoint removes the reaction with an empty emoji', async () => {
        const r = await fetch(`${base}/api/react`, {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, msgId: 'R1', emoji: '' }),
        });
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.deepEqual(j.reactions, []);
        assert.equal(sent.at(-1).content.react.text, '');
        const r2 = await fetch(`${base}/api/messages?jid=${encodeURIComponent(DM)}`, { headers: { cookie } });
        const m = (await r2.json()).messages.find((x) => x.id === 'R1');
        assert.deepEqual(m.reactions, []);
    });

    await t.test('react endpoint validates input', async () => {
        const noAuth = await fetch(`${base}/api/react`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, msgId: 'R1', emoji: '👍' }),
        });
        assert.equal(noAuth.status, 401);
        const badJid = await fetch(`${base}/api/react`, {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: 'evil', msgId: 'R1', emoji: '👍' }),
        });
        assert.equal(badJid.status, 400);
        const badId = await fetch(`${base}/api/react`, {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, msgId: '../x', emoji: '👍' }),
        });
        assert.equal(badId.status, 400);
        const unknown = await fetch(`${base}/api/react`, {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, msgId: 'NOPE', emoji: '👍' }),
        });
        assert.equal(unknown.status, 404);
    });

    await t.test('message status updates flow into /api/messages (ticks)', async () => {
        store.storeMessage(DM, makeMsg({ id: 'S1', jid: DM, fromMe: true, text: 'tick me', ts: 1700000300 }));
        handle.handleMessageUpdate([{ key: { id: 'S1', remoteJid: DM, fromMe: true }, update: { status: 3 } }]);
        let r = await fetch(`${base}/api/messages?jid=${encodeURIComponent(DM)}`, { headers: { cookie } });
        let m = (await r.json()).messages.find((x) => x.id === 'S1');
        assert.equal(m.status, 3);
        // READ sticks — a later lower status never downgrades it.
        handle.handleMessageUpdate([{ key: { id: 'S1', remoteJid: DM, fromMe: true }, update: { status: 4 } }]);
        handle.handleMessageUpdate([{ key: { id: 'S1', remoteJid: DM, fromMe: true }, update: { status: 2 } }]);
        r = await fetch(`${base}/api/messages?jid=${encodeURIComponent(DM)}`, { headers: { cookie } });
        m = (await r.json()).messages.find((x) => x.id === 'S1');
        assert.equal(m.status, 4);
    });

    await t.test('group receipts update ticks (message-receipt.update)', async () => {
        store.storeMessage(GROUP, makeMsg({ id: 'S2', jid: GROUP, fromMe: true, text: 'group tick', ts: 1700000400 }));
        handle.handleReceiptUpdate([{ key: { id: 'S2', remoteJid: GROUP, fromMe: true }, receipt: { type: 'read' } }]);
        const r = await fetch(`${base}/api/messages?jid=${encodeURIComponent(GROUP)}`, { headers: { cookie } });
        const m = (await r.json()).messages.find((x) => x.id === 'S2');
        assert.equal(m.status, 4);
    });

    await t.test('incoming reactions flow into /api/messages (messages.reaction)', async () => {
        store.storeMessage(DM, makeMsg({ id: 'R2', jid: DM, text: 'others react', ts: 1700000500 }));
        const stanzaKey = { id: 'RX1', remoteJid: DM, participant: '2349000000000@s.whatsapp.net' };
        handle.handleReactions([{ key: { id: 'R2', remoteJid: DM }, reaction: { key: stanzaKey, text: '❤️' } }]);
        let r = await fetch(`${base}/api/messages?jid=${encodeURIComponent(DM)}`, { headers: { cookie } });
        let m = (await r.json()).messages.find((x) => x.id === 'R2');
        assert.deepEqual(m.reactions, [{ emoji: '❤️', count: 1, byMe: false }]);
        // A new emoji from the same sender replaces the old one.
        handle.handleReactions([{ key: { id: 'R2', remoteJid: DM }, reaction: { key: stanzaKey, text: '😂' } }]);
        r = await fetch(`${base}/api/messages?jid=${encodeURIComponent(DM)}`, { headers: { cookie } });
        m = (await r.json()).messages.find((x) => x.id === 'R2');
        assert.deepEqual(m.reactions, [{ emoji: '😂', count: 1, byMe: false }]);
        // Empty text removes the reaction.
        handle.handleReactions([{ key: { id: 'R2', remoteJid: DM }, reaction: { key: stanzaKey, text: '' } }]);
        r = await fetch(`${base}/api/messages?jid=${encodeURIComponent(DM)}`, { headers: { cookie } });
        m = (await r.json()).messages.find((x) => x.id === 'R2');
        assert.deepEqual(m.reactions, []);
    });

    await t.test('opening a chat marks incoming messages read once', async () => {
        store.storeMessage(DM, makeMsg({ id: 'RD1', jid: DM, text: 'mark me read', ts: Math.floor(Date.now() / 1000) + 20 }));
        const before = readCalls.length;
        await fetch(`${base}/api/messages?jid=${encodeURIComponent(DM)}`, { headers: { cookie } });
        assert.ok(readCalls.length > before, 'readMessages called');
        const keys = readCalls.at(-1);
        assert.ok(keys.some((k) => k.id === 'RD1'), 'the new incoming message is marked read');
        const n = readCalls.length;
        await fetch(`${base}/api/messages?jid=${encodeURIComponent(DM)}`, { headers: { cookie } });
        assert.equal(readCalls.length, n, 'second poll does not re-mark');
    });

    await t.test('chat list reports unread counts', async () => {
        store.storeMessage(DM, makeMsg({ id: 'U1', jid: DM, text: 'unread one', ts: Math.floor(Date.now() / 1000) + 10 }));
        const r = await fetch(`${base}/api/chats`, { headers: { cookie } });
        const dm = (await r.json()).chats.find((c) => c.jid === DM);
        assert.ok(dm.unread >= 1, `unread badge count, got ${dm.unread}`);
    });

    await t.test('LID and PN buckets merge into one chat view', async () => {
        const inMsg = makeMsg({ id: 'L1', jid: LID2, text: 'good morning', ts: 1700000600 });
        inMsg.key.remoteJidAlt = PN2; // WhatsApp tells us the phone twin
        handle.logMessage(inMsg);
        store.storeMessage(LID2, inMsg);
        store.storeMessage(PN2, makeMsg({ id: 'P1', jid: PN2, fromMe: true, text: 'hi', ts: 1700000590 }));

        const r = await fetch(`${base}/api/messages?jid=${encodeURIComponent(PN2)}`, { headers: { cookie } });
        const j = await r.json();
        assert.deepEqual(j.messages.map((m) => m.id), ['P1', 'L1'], 'merged + sorted by time');
        assert.equal(j.messages[1].text, 'good morning');
    });

    await t.test('chat list merges LID and PN into one entry', async () => {
        handle.handleLidMapping({ pn: PN2, lid: LID2 });
        store.storeMessage(LID2, makeMsg({ id: 'L2', jid: LID2, text: 'fresh reply', ts: Math.floor(Date.now() / 1000) + 30 }));
        const r = await fetch(`${base}/api/chats`, { headers: { cookie } });
        const chats = (await r.json()).chats;
        assert.equal(chats.filter((c) => c.jid === PN2).length, 1, 'one PN entry');
        assert.equal(chats.filter((c) => c.jid === LID2).length, 0, 'no separate LID entry');
        const entry = chats.find((c) => c.jid === PN2);
        assert.equal(entry.name, 'Friend', 'the real name beats the bare number');
        assert.equal(entry.count, 3);
        assert.ok(entry.unread >= 1, 'unread counts merge across buckets');
    });

    await t.test('status updates stored under the LID show on the PN chat', async () => {
        handle.handleMessageUpdate([{ key: { id: 'P1', remoteJid: LID2, fromMe: true }, update: { status: 4 } }]);
        const r = await fetch(`${base}/api/messages?jid=${encodeURIComponent(PN2)}`, { headers: { cookie } });
        const m = (await r.json()).messages.find((x) => x.id === 'P1');
        assert.equal(m.status, 4, 'meta keyed under either address is found');
    });

    await t.test('lid-mapping.update events teach the web chat', async () => {
        const PN4 = '2349000000004@s.whatsapp.net';
        const LID4 = '71107777777777@lid';
        handle.handleLidMapping({ pn: PN4, lid: LID4 });
        store.storeMessage(LID4, makeMsg({ id: 'L9', jid: LID4, text: 'mapped hi', ts: 1700000700 }));
        const r = await fetch(`${base}/api/messages?jid=${encodeURIComponent(PN4)}`, { headers: { cookie } });
        const ids = (await r.json()).messages.map((m) => m.id);
        assert.ok(ids.includes('L9'), 'LID bucket merged via the reported mapping');
    });

    await t.test('search results canonicalize LID chats to the PN chat', async () => {
        const r = await fetch(`${base}/api/search?q=${encodeURIComponent('good morning')}`, { headers: { cookie } });
        const j = await r.json();
        const hit = j.results.find((x) => x.msgId === 'L1');
        assert.ok(hit, 'the LID-indexed message is found');
        assert.equal(hit.chatJid, PN2, 'and shown under the canonical PN chat');
    });

    await t.test('reaction stanzas are not chat previews', async () => {
        store.storeMessage(PN3, makeMsg({ id: 'T1', jid: PN3, text: 'real message', ts: 1700000800 }));
        store.storeMessage(PN3, {
            key: { id: 'T2', remoteJid: PN3, fromMe: false },
            message: { reactionMessage: { key: { id: 'T1', remoteJid: PN3 }, text: '❤️' } },
            messageTimestamp: 1700000900,
            pushName: 'Friend',
        });
        const r = await fetch(`${base}/api/chats`, { headers: { cookie } });
        const c = (await r.json()).chats.find((x) => x.jid === PN3);
        assert.equal(c.preview, 'real message', 'preview skips reaction stanzas');
    });

    await t.test('presence on the LID shows in the PN chat', async () => {
        handle.handlePresenceUpdate(LID2, { [LID2]: { lastKnownPresence: 'composing' } });
        const r = await fetch(`${base}/api/messages?jid=${encodeURIComponent(PN2)}`, { headers: { cookie } });
        assert.equal((await r.json()).presence, 'composing');
    });

    await t.test('send with a quoted reply passes the full message as quoted', async () => {
        store.storeMessage(DM, makeMsg({ id: 'Q1', jid: DM, text: 'original message', ts: 1700000950 }));
        const r = await fetch(`${base}/api/send`, {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, text: 'this is a reply', quotedMsgId: 'Q1' }),
        });
        assert.equal(r.status, 200);
        const j = await r.json();
        const last = sent.at(-1);
        assert.equal(last.content.text, 'this is a reply');
        assert.ok(last.options && last.options.quoted, 'quoted option passed to Baileys');
        assert.equal(last.options.quoted.key.id, 'Q1');
        assert.equal(last.options.quoted.message.conversation, 'original message');
        // The sent message shows the quoted block (meta fallback — the mock
        // echo carries no contextInfo).
        const r2 = await fetch(`${base}/api/messages?jid=${encodeURIComponent(DM)}`, { headers: { cookie } });
        const m = (await r2.json()).messages.find((x) => x.id === j.id);
        assert.ok(m.quoted, 'quoted block attached to the sent message');
        assert.equal(m.quoted.text, 'original message');
        assert.equal(m.quoted.pushName, 'Friend', 'quoted sender name enriched');
    });

    await t.test('send validates the quoted message', async () => {
        const badId = await fetch(`${base}/api/send`, {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, text: 'hi', quotedMsgId: '../x' }),
        });
        assert.equal(badId.status, 400);
        const unknown = await fetch(`${base}/api/send`, {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, text: 'hi', quotedMsgId: 'NOPE' }),
        });
        assert.equal(unknown.status, 404);
    });

    await t.test('incoming replies expose the quoted block', async () => {
        const reply = makeMsg({ id: 'Q2', jid: DM, text: 'replying to you', ts: 1700001000 });
        reply.message = {
            extendedTextMessage: {
                text: 'replying to you',
                contextInfo: {
                    stanzaId: 'Q1',
                    participant: DM,
                    quotedMessage: { conversation: 'original message' },
                },
            },
        };
        store.storeMessage(DM, reply);
        const r = await fetch(`${base}/api/messages?jid=${encodeURIComponent(DM)}`, { headers: { cookie } });
        const m = (await r.json()).messages.find((x) => x.id === 'Q2');
        assert.ok(m.quoted, 'quoted block present');
        assert.equal(m.quoted.id, 'Q1');
        assert.equal(m.quoted.text, 'original message');
        assert.equal(m.quoted.pushName, 'Friend', 'quoted sender name enriched from the store');
        assert.equal(m.quoted.fromMe, false);
    });

    await t.test('quoted media shows its kind and caption', async () => {
        const reply2 = makeMsg({ id: 'Q3', jid: DM, text: '', ts: 1700001050 });
        reply2.message = {
            imageMessage: {
                mimetype: 'image/png',
                caption: '',
                contextInfo: {
                    stanzaId: 'MEDIA1',
                    participant: DM,
                    quotedMessage: { imageMessage: { mimetype: 'image/png', caption: 'look at this', mediaKey: Buffer.from('k'), directPath: '/x', url: 'https://x' } },
                },
            },
        };
        store.storeMessage(DM, reply2);
        const r = await fetch(`${base}/api/messages?jid=${encodeURIComponent(DM)}`, { headers: { cookie } });
        const m = (await r.json()).messages.find((x) => x.id === 'Q3');
        assert.equal(m.quoted.mediaKind, 'image');
        assert.equal(m.quoted.text, 'look at this', 'caption as the quoted text');
    });

    await t.test('quoting works across LID and PN buckets', async () => {
        // P1 lives in the PN2 bucket; a reply from the LID twin can quote it.
        const r = await fetch(`${base}/api/send`, {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: LID2, text: 'reply from lid', quotedMsgId: 'P1' }),
        });
        assert.equal(r.status, 200, 'quoted message found in the PN bucket');
        const last = sent.at(-1);
        assert.equal(last.options.quoted.key.id, 'P1');
    });

    const nowSec = () => Math.floor(Date.now() / 1000);

    await t.test('voice note converts, measures and sends a PTT waveform', async () => {
        const r = await fetch(`${base}/api/voice`, {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, audio: Buffer.from('webm-bytes').toString('base64') }),
        });
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.equal(j.seconds, 2, 'duration from the PCM length');
        const call = voiceCalls.at(-1);
        assert.equal(call.jid, DM);
        assert.equal(call.opus.toString(), 'OPUS', 'converted OGG/Opus is what gets sent');
        assert.equal(call.waveform.length, 64, '64-bar waveform');
        assert.ok(Array.from(call.waveform).every((v) => v >= 0 && v <= 99), 'WhatsApp 0–99 scale');
        assert.ok(Array.from(call.waveform).some((v) => v > 0), 'waveform is not flat');
    });

    await t.test('voice note rejects oversized and invalid input', async () => {
        const big = await fetch(`${base}/api/voice`, {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, audio: Buffer.alloc(11 * 1024 * 1024).toString('base64') }),
        });
        assert.equal(big.status, 400);
        const bad = await fetch(`${base}/api/voice`, {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: 'evil', audio: 'AAAA' }),
        });
        assert.equal(bad.status, 400);
    });

    await t.test('delete for everyone sends a revoke and hides the text', async () => {
        store.storeMessage(DM, makeMsg({ id: 'D1', jid: DM, fromMe: true, text: 'oops wrong chat', ts: nowSec() }));
        const r = await fetch(`${base}/api/delete`, {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, msgId: 'D1' }),
        });
        assert.equal(r.status, 200);
        assert.equal(sent.at(-1).content.delete.id, 'D1');
        const m = (await (await fetch(`${base}/api/messages?jid=${encodeURIComponent(DM)}`, { headers: { cookie } })).json())
            .messages.find((x) => x.id === 'D1');
        assert.equal(m.deleted, true);
        assert.equal(m.text, 'This message was deleted');
    });

    await t.test('delete refuses messages older than 48 hours', async () => {
        store.storeMessage(DM, makeMsg({ id: 'D2', jid: DM, fromMe: true, text: 'ancient', ts: nowSec() - 3 * 24 * 3600 }));
        const r = await fetch(`${base}/api/delete`, {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, msgId: 'D2' }),
        });
        assert.equal(r.status, 400);
    });

    await t.test('edit sends the new text and marks the message edited', async () => {
        store.storeMessage(DM, makeMsg({ id: 'E1', jid: DM, fromMe: true, text: 'typo hre', ts: nowSec() }));
        const r = await fetch(`${base}/api/edit`, {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, msgId: 'E1', text: 'typo here' }),
        });
        assert.equal(r.status, 200);
        assert.equal(sent.at(-1).content.text, 'typo here');
        assert.equal(sent.at(-1).content.edit.id, 'E1');
        const m = (await (await fetch(`${base}/api/messages?jid=${encodeURIComponent(DM)}`, { headers: { cookie } })).json())
            .messages.find((x) => x.id === 'E1');
        assert.equal(m.text, 'typo here');
        assert.equal(m.edited, true);
    });

    await t.test('edit refuses others messages, media and expired windows', async () => {
        store.storeMessage(DM, makeMsg({ id: 'E2', jid: DM, text: 'not mine', ts: nowSec() }));
        const notMine = await fetch(`${base}/api/edit`, {
            method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, msgId: 'E2', text: 'x' }),
        });
        assert.equal(notMine.status, 403);
        store.storeMessage(DM, makeMsg({ id: 'E3', jid: DM, fromMe: true, text: 'old', ts: nowSec() - 3600 }));
        const late = await fetch(`${base}/api/edit`, {
            method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, msgId: 'E3', text: 'x' }),
        });
        assert.equal(late.status, 400);
    });

    await t.test('incoming revoke and edit protocol messages update the chat', async () => {
        store.storeMessage(DM, makeMsg({ id: 'P9', jid: DM, fromMe: true, text: 'will be deleted', ts: nowSec() }));
        handle.logMessage({
            key: { id: 'RV1', remoteJid: DM, fromMe: false },
            message: { protocolMessage: { type: 0, key: { id: 'P9', remoteJid: DM, fromMe: true } } },
            messageTimestamp: nowSec(),
        });
        handle.logMessage({
            key: { id: 'ED1', remoteJid: DM, fromMe: false },
            message: { protocolMessage: { type: 14, key: { id: 'E1', remoteJid: DM, fromMe: true }, editedMessage: { conversation: 'corrected by them' } } },
            messageTimestamp: nowSec(),
        });
        const msgs = (await (await fetch(`${base}/api/messages?jid=${encodeURIComponent(DM)}`, { headers: { cookie } })).json()).messages;
        assert.equal(msgs.find((x) => x.id === 'P9').deleted, true, 'revoke applied');
        assert.equal(msgs.find((x) => x.id === 'E1').text, 'corrected by them', 'edit applied');
    });

    await t.test('forward sends a stored message to another chat', async () => {
        const r = await fetch(`${base}/api/forward`, {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, toJid: PN3, msgIds: ['A1'] }),
        });
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.equal(j.forwarded, 1);
        const last = sent.at(-1);
        assert.equal(last.jid, PN3);
        assert.equal(last.content.forward.key.id, 'A1');
    });

    await t.test('forward validates the target and selection', async () => {
        const badTarget = await fetch(`${base}/api/forward`, {
            method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, toJid: 'evil', msgIds: ['A1'] }),
        });
        assert.equal(badTarget.status, 400);
        const tooMany = await fetch(`${base}/api/forward`, {
            method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, toJid: PN3, msgIds: Array.from({ length: 11 }, (_, i) => 'M' + i) }),
        });
        assert.equal(tooMany.status, 400);
    });

    await t.test('mentions are passed to Baileys with the message', async () => {
        const r = await fetch(`${base}/api/send`, {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, text: 'hey @2349000000001', mentions: [PN2, 'not-a-jid'] }),
        });
        assert.equal(r.status, 200);
        assert.deepEqual(sent.at(-1).content.mentions, [PN2], 'invalid mentions are dropped');
    });

    await t.test('poll: create, receive a vote, cast a vote, tally', async () => {
        const create = await fetch(`${base}/api/poll`, {
            method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, name: 'Lunch?', options: ['Pizza', 'Rice'], selectableCount: 1 }),
        });
        const created = await create.json();
        assert.equal(created.ok, true);
        assert.equal(created.voteable, true, 'message secret kept for voting');
        const pollId = created.id;

        // Someone else votes "Rice" — encrypted the way WhatsApp does it.
        const enc = pollCrypto.encryptPollVote(
            { pollEncKey: pollSecret, pollMsgId: pollId, pollCreatorJid: '2348000000000@s.whatsapp.net', voterJid: DM },
            ['Rice']
        );
        handle.logMessage({
            key: { id: 'VOTE1', remoteJid: DM, fromMe: false },
            message: { pollUpdateMessage: { pollCreationMessageKey: { id: pollId, remoteJid: DM, fromMe: true }, vote: enc, senderTimestampMs: Date.now() } },
            messageTimestamp: nowSec(),
        });
        let m = (await (await fetch(`${base}/api/messages?jid=${encodeURIComponent(DM)}`, { headers: { cookie } })).json())
            .messages.find((x) => x.id === pollId);
        assert.equal(m.poll.name, 'Lunch?');
        assert.equal(m.poll.options.find((o) => o.text === 'Rice').count, 1, 'incoming vote tallied');
        assert.equal(m.poll.totalVotes, 1);

        // We vote "Pizza" from the web UI; the relayed vote must decrypt for WhatsApp's creator/voter pair.
        const vote = await fetch(`${base}/api/pollvote`, {
            method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, pollId, options: ['Pizza'] }),
        });
        assert.equal(vote.status, 200);
        const relayed = relayCalls.at(-1);
        assert.equal(relayed.jid, DM);
        const names = pollCrypto.namesFromHashes(
            pollCrypto.decryptPollVote(relayed.message.pollUpdateMessage.vote, {
                pollEncKey: pollSecret, pollMsgId: pollId,
                pollCreatorJid: '71100000000000@lid', voterJid: '2348000000000@s.whatsapp.net',
            }),
            ['Pizza', 'Rice']
        );
        assert.deepEqual(names, ['Pizza'], 'relayed vote decrypts to our selection');

        m = (await (await fetch(`${base}/api/messages?jid=${encodeURIComponent(DM)}`, { headers: { cookie } })).json())
            .messages.find((x) => x.id === pollId);
        assert.deepEqual(m.poll.myVote, ['Pizza']);
        assert.equal(m.poll.options.find((o) => o.text === 'Pizza').byMe, true);
        assert.equal(m.poll.totalVotes, 2);

        // Multi-select is blocked for a single-choice poll.
        const tooMany = await fetch(`${base}/api/pollvote`, {
            method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, pollId, options: ['Pizza', 'Rice'] }),
        });
        assert.equal(tooMany.status, 400);

        // Withdrawing the vote (empty selection) removes it from the tally.
        await fetch(`${base}/api/pollvote`, {
            method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, pollId, options: [] }),
        });
        m = (await (await fetch(`${base}/api/messages?jid=${encodeURIComponent(DM)}`, { headers: { cookie } })).json())
            .messages.find((x) => x.id === pollId);
        assert.deepEqual(m.poll.myVote, []);
        assert.equal(m.poll.totalVotes, 1);
    });

    await t.test('poll validation rejects bad option lists', async () => {
        const r = await fetch(`${base}/api/poll`, {
            method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: DM, name: 'Dupes', options: ['a', 'a'] }),
        });
        assert.equal(r.status, 400);
    });

    await t.test('history paging returns older messages from the index', async () => {
        handle.logMessage(makeMsg({ id: 'OLD1', jid: DM, text: 'ancient message', ts: 1600000000 }));
        const r = await fetch(`${base}/api/messages?jid=${encodeURIComponent(DM)}&before=${1700000000 * 1000}`, { headers: { cookie } });
        const j = await r.json();
        assert.equal(j.history, true);
        const old = j.messages.find((x) => x.id === 'OLD1');
        assert.ok(old, 'older message returned from SQLite');
        assert.equal(old.text, 'ancient message');
    });

    await t.test('history paging never skips messages that share a timestamp', async () => {
        const ids = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5'];
        for (const id of ids) handle.logMessage(makeMsg({ id, jid: DM, text: 'tie ' + id, ts: 1600000100 }));
        const base0 = `${base}/api/messages?jid=${encodeURIComponent(DM)}&limit=2`;
        const seen = [];
        let url = `${base0}&before=${1600000200 * 1000}`;
        for (let guard = 0; guard < 10; guard++) {
            const j = await (await fetch(url, { headers: { cookie } })).json();
            const ours = j.messages.filter((x) => ids.includes(x.id));
            seen.unshift(...ours.map((x) => x.id));
            if (!j.hasMore) break;
            const oldest = j.messages[0];
            url = `${base0}&before=${oldest.ts}&beforeId=${encodeURIComponent(oldest.id)}`;
        }
        assert.deepEqual(seen, ids, 'every tied message returned exactly once, oldest first');
    });

    await t.test('last seen comes from presence updates', async () => {
        handle.handlePresenceUpdate(DM, { [DM]: { lastKnownPresence: 'unavailable', lastSeen: 1700000000 } });
        const j = await (await fetch(`${base}/api/messages?jid=${encodeURIComponent(DM)}`, { headers: { cookie } })).json();
        assert.equal(j.lastSeen, 1700000000000);
    });

    await t.test('group members feed the mention picker', async () => {
        const r = await fetch(`${base}/api/groupmembers?jid=${encodeURIComponent(GROUP)}`, { headers: { cookie } });
        const j = await r.json();
        assert.equal(j.members.length, 2);
        // The phonebook follows the most recent push name ("Friend" in these fixtures).
        assert.equal(j.members[0].name, 'Friend', 'phonebook name used, not the bare number');
        assert.equal(j.members[1].name, 'Friend', 'LID member resolved to its phone contact name');
    });

    await t.test('scoped search only looks inside one chat', async () => {
        const inDm = await (await fetch(`${base}/api/search?q=birthday&jid=${encodeURIComponent(DM)}`, { headers: { cookie } })).json();
        assert.equal(inDm.results.length, 1);
        const inGroup = await (await fetch(`${base}/api/search?q=birthday&jid=${encodeURIComponent(GROUP)}`, { headers: { cookie } })).json();
        assert.equal(inGroup.results.length, 0);
    });

    await t.test('logout kills the session', async () => {
        const r = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie } });
        assert.equal(r.status, 200);
        const r2 = await fetch(`${base}/api/status`, { headers: { cookie } });
        assert.equal(r2.status, 401);
    });
});

test('web chat UI generates a password when WEB_PASSWORD is unset', async (t) => {
    const saved = process.env.WEB_PASSWORD;
    delete process.env.WEB_PASSWORD;
    t.after(() => { if (saved != null) process.env.WEB_PASSWORD = saved; });

    let generated = null;
    const app = express();
    attachChatUI(app, {
        getSock: () => null,
        getBotState: () => 'disconnected',
        store: createMessageStore({}),
        chatStore: createWebChatStore({
            dbPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-test-')), 'webchat.db'),
            phonebookPath: path.join(os.tmpdir(), 'webchat-test-pb.json'),
        }),
        log: (msg) => {
            const m = String(msg);
            const i = m.indexOf('generated password:');
            if (i !== -1) generated = m.slice(i + 'generated password:'.length).trim();
        },
    });
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    t.after(() => server.close());
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    assert.ok(generated && generated.length >= 8, 'a random password was generated and logged');

    // Nothing is exposed without the password.
    const r0 = await fetch(`${base}/api/status`);
    assert.equal(r0.status, 401);

    // Login with the generated password works.
    const r = await fetch(`${base}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: generated }),
    });
    assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie').split(';')[0];

    // Auth passes but sending reports the bot is not connected (sock is null).
    const r2 = await fetch(`${base}/api/send`, {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jid: DM, text: 'hi' }),
    });
    assert.equal(r2.status, 503);
});
