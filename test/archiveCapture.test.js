const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize } = require('../utils/archiveCapture');

test('summarizes an outgoing app-state patch', () => {
    const xml = '<iq id="36584.62943-110" to="s.whatsapp.net" type="set" xmlns="w:sync:app:state"><sync><collection name="regular_low" version="8" return_snapshot="false"><patch>..</patch></collection></sync></iq>';
    assert.deepEqual(summarize('out', xml), { dir: 'out', id: '36584.62943-110', type: 'set', xmlns: 'w:sync:app:state', collection: 'regular_low', version: '8', error: null });
});

test('summarizes an error reply and ignores unrelated traffic', () => {
    const err = '<iq id="36584.62943-111" type="error" from="s.whatsapp.net"><error code="404" text="item-not-found"/></iq>';
    const s = summarize('in', err);
    assert.equal(s.id, '36584.62943-111');
    assert.equal(s.error, '404 item-not-found');
    assert.equal(summarize('out', '<iq id="x" xmlns="usync" type="get"/>'), null);
});
