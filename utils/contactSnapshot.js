'use strict';

// Contact names (the phone's address book) live in WhatsApp's `critical_unblock_low`
// app-state collection. The normal re-sync only moves forward from the stored version, so it
// never sends the full address book again. If the bot's saved-name phonebook is missing (for
// example after a fresh copy of the project), this asks WhatsApp for a full snapshot of that
// one collection: clear its stored version, then sync from scratch.
//
// Only that single collection is touched. Chats, archive and read state are not affected.

const COLLECTION = 'critical_unblock_low';
const MIN_SAVED_NAMES = 50;

async function refreshContactSnapshot({ sock, authState, savedNameCount, log = () => {}, minSavedNames = MIN_SAVED_NAMES }) {
    const count = Number(savedNameCount?.() || 0);
    if (count >= minSavedNames) {
        log(`[contacts-sync] ${count} saved names on file, no snapshot needed`);
        return { requested: false, count };
    }
    if (!sock || typeof sock.resyncAppState !== 'function') {
        log('[contacts-sync] cannot request a contact snapshot: no socket');
        return { requested: false, count };
    }
    if (!authState?.keys?.set) {
        log('[contacts-sync] cannot request a contact snapshot: no auth store');
        return { requested: false, count };
    }
    log(`[contacts-sync] only ${count} saved names on file; requesting a full contact snapshot from WhatsApp`);
    // A null value deletes the stored version, so WhatsApp returns the full collection.
    await authState.keys.set({ 'app-state-sync-version': { [COLLECTION]: null } });
    await sock.resyncAppState([COLLECTION], true);
    const after = Number(savedNameCount?.() || 0);
    log(`[contacts-sync] snapshot done: ${after} saved names on file`);
    return { requested: true, count: after };
}

module.exports = { refreshContactSnapshot, COLLECTION, MIN_SAVED_NAMES };
