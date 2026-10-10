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

const DM = '2348111111111@s.whatsapp.net';
const GROUP = '120363000000@g.us';

function makeMsg({ id, jid, fromMe = false, text, participant, ts, pushName }) {
    return {
        key: { id, remoteJid: jid, fromMe, ...(participant ? { participant } : {}) },
        message: { conversation: text },
        messageTimestamp: ts,
        pushName: pushName || (fromMe ? '' : 'Friend'),
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
    let downloadCalls = 0;
    const sock = {
        user: { id: '2348000000000:5@s.whatsapp.net' },
        sendMessage: async (jid, content) => {
            sent.push({ jid, content });
            return {
                key: { id: 'SENT' + sent.length, remoteJid: jid, fromMe: true },
                message: content.text ? { conversation: content.text } : content,
                messageTimestamp: Math.floor(Date.now() / 1000),
            };
        },
        sendPresenceUpdate: async (presence, jid) => {
            presenceCalls.push({ presence, jid });
        },
        groupMetadata: async (jid) => ({ subject: 'Test Group ' + jid.slice(0, 6) }),
        profilePictureUrl: async (jid) => 'https://cdn.example.com/' + encodeURIComponent(jid) + '.jpg',
    };
    const handle = attachChatUI(app, {
        getSock: () => sock,
        getBotState: () => 'connected',
        store,
        chatStore,
        log: () => {},
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
        server, port, store, chatStore, sent, presenceCalls, sock,
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
    const { port, store, sent, presenceCalls, handle } = ctx;
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
