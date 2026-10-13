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

test('reads Baileys single-quoted XML, which is what the socket actually writes', () => {
    const out = "<iq id='33778.11586-95' to='s.whatsapp.net' type='set' xmlns='w:sync:app:state'>\n\t<sync>\n\t\t<collection name='regular_low' version='5' return_snapshot='false'/>\n\t</sync>\n</iq>";
    const s = summarize('out', out);
    assert.equal(s.id, '33778.11586-95');
    assert.equal(s.collection, 'regular_low');
    assert.equal(s.version, '5');
    const inn = "<iq id='33778.11586-89' type='error' from='s.whatsapp.net'>\n\t<error code='404' text='item-not-found'/>\n</iq>";
    assert.equal(summarize('in', inn).error, '404 item-not-found');
});
