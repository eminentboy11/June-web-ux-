'use strict';

// TEMPORARY debug capture for archive/unarchive. Baileys writes every outgoing and incoming
// XML node to its logger at trace level. This keeps that logger silent, except for a short
// window opened when an archive action is sent. Inside the window it records each request
// (id, xmlns, collection, version) and each reply (id, type, error), so an error reply can be
// matched to the request it answers.

const pino = require('pino');

function attrs(xml, tag) {
    const m = String(xml || '').match(new RegExp(`<${tag}\\b([^>]*)>`));
    const out = {};
    if (!m) return out;
    for (const a of m[1].matchAll(/(\w[\w-]*)=(["'])(.*?)\2/g)) out[a[1]] = a[3];
    return out;
}

// Compact one-line summary of a Baileys XML node, or null if it isn't an app-state/error node.
function summarize(direction, xml) {
    const iq = attrs(xml, 'iq');
    const coll = attrs(xml, 'collection');
    const errAttrs = attrs(xml, 'error');
    const errText = errAttrs.code ? `${errAttrs.code} ${errAttrs.text || ''}`.trim() : null;
    if (direction === 'out' && !/w:sync:app:state/.test(xml || '')) return null;
    if (direction === 'in' && !/w:sync:app:state/.test(xml || '') && !errText) return null;
    return { dir: direction, id: iq.id, type: iq.type, xmlns: iq.xmlns || null, collection: coll.name || null, version: coll.version || null, error: errText };
}

function createArchiveCapture() {
    let open = false;
    let timer = null;
    const lines = [];
    const logger = pino({ level: 'silent' }, {
        write(chunk) {
            if (!open) return;
            try {
                const rec = JSON.parse(chunk);
                if (rec.msg !== 'xml send' && rec.msg !== 'recv xml') return;
                const s = summarize(rec.msg === 'xml send' ? 'out' : 'in', rec.xml);
                if (!s) return;
                const line = `[archive-capture] ${JSON.stringify(s)}`;
                console.log(line);
            } catch (_) {}
        },
    });
    function start(ms = 60000, log = console.log) {
        open = true;
        logger.level = 'trace';
        log(`[archive-capture] window open for ${Math.round(ms / 1000)}s`);
        clearTimeout(timer);
        timer = setTimeout(() => { open = false; logger.level = 'silent'; log('[archive-capture] window closed'); }, ms);
        if (timer.unref) timer.unref();
    }
    return { logger, start, lines };
}

module.exports = { createArchiveCapture, summarize, attrs };
