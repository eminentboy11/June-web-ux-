const test = require('node:test');
const assert = require('node:assert/strict');
const { refreshContactSnapshot } = require('../utils/contactSnapshot');

function fakes(count) {
    const sets = [];
    const resyncs = [];
    let n = count;
    const sock = { resyncAppState: async (cols, initial) => { resyncs.push({ cols, initial }); n = 3000; } };
    const authState = { keys: { set: async (data) => { sets.push(data); } } };
    return { sock, authState, sets, resyncs, savedNameCount: () => n };
}

test('no snapshot when the saved-name phonebook is healthy', async () => {
    const f = fakes(3717);
    const r = await refreshContactSnapshot({ sock: f.sock, authState: f.authState, savedNameCount: f.savedNameCount });
    assert.equal(r.requested, false);
    assert.equal(f.sets.length, 0);
    assert.equal(f.resyncs.length, 0);
});

test('an empty phonebook clears only the contact collection version, then syncs it from scratch', async () => {
    const f = fakes(2);
    const logs = [];
    const r = await refreshContactSnapshot({ sock: f.sock, authState: f.authState, savedNameCount: f.savedNameCount, log: (m) => logs.push(m) });
    assert.equal(r.requested, true);
    assert.deepEqual(f.sets, [{ 'app-state-sync-version': { critical_unblock_low: null } }]);
    assert.deepEqual(f.resyncs, [{ cols: ['critical_unblock_low'], initial: true }]);
    assert.equal(r.count, 3000);
    assert.ok(logs.some((m) => m.includes('snapshot done: 3000')));
});

test('missing socket or auth store does nothing and does not throw', async () => {
    const f = fakes(0);
    const a = await refreshContactSnapshot({ sock: null, authState: f.authState, savedNameCount: f.savedNameCount });
    const b = await refreshContactSnapshot({ sock: f.sock, authState: {}, savedNameCount: f.savedNameCount });
    assert.equal(a.requested, false);
    assert.equal(b.requested, false);
    assert.equal(f.resyncs.length, 0);
});
