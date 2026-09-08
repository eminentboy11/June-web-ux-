'use strict';

// API-only mapping. Uses the existing database interface/schema without altering
// either SQLite driver or the independent direct-PostgreSQL implementation.
const text = (p, name) => {
  if (typeof p[name] !== 'string' || !p[name]) throw new Error(`Invalid restore field: ${name}`);
  return p[name];
};
const json = value => JSON.stringify(value === undefined ? {} : value);
const number = (value, fallback) => {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n)) throw new Error('Invalid numeric restore field');
  return n;
};
function mapping(resource, p) {
  switch (resource) {
    case 'bot_settings':
      if (p.key === '__june_encrypted_auth_backup_v1__') return null;
      return ['bot_settings', ['key','value'], [text(p,'key'),json(p.value)]];
    case 'group_settings': return ['groups', ['group_id','settings'], [text(p,'groupId'),json(p.settings)]];
    case 'group_stats': return ['group_stats', ['group_id','date','data'], [text(p,'groupId'),text(p,'date'),json(p.data)]];
    case 'users': return ['users', ['user_id','data'], [text(p,'userId'),json(p.data)]];
    case 'warnings': return ['warnings', ['group_id','user_id','count','entries'], [text(p,'groupId'),text(p,'userId'),number(p.count,0),json(p.entries || [])]];
    case 'moderators': return ['moderators', ['user_id'], [text(p,'userId')]];
    case 'muted_users': return ['muted_users', ['group_id','user_id'], [text(p,'groupId'),text(p,'userId')]];
    case 'kv_store':
      if (p.namespace === 'runtime_telemetry' && p.value?.eventType) {
        const e = p.value;
        return ['runtime_telemetry', ['event_type','event_key','payload','count','first_seen','last_seen'],
          [text(e,'eventType'),text(e,'eventKey'),json(e.payload),number(e.count,1),number(e.firstSeen,Date.now()),number(e.lastSeen,Date.now())]];
      }
      return ['kv_store', ['namespace','key','value'], [text(p,'namespace'),text(p,'key'),json(p.value)]];
    case 'profiles': return ['chat_profiles', ['bot_id','user_id','profile'], [text(p,'botProfileId'),text(p,'userId'),json(p.profile)]];
    case 'antidelete_messages': return ['antidelete_messages', ['chat_id','message_id','payload','stored_at'], [text(p,'chatId'),text(p,'messageId'),json(p.payload),number(p.storedAt,Date.now())]];
    case 'antidelete_statuses': return ['antidelete_statuses', ['status_id','payload','stored_at'], [text(p,'statusId'),json(p.payload),number(p.storedAt,Date.now())]];
    case 'lid_map': return ['lid_map', ['direction','user','value','updated_at'], [text(p,'direction'),text(p,'user'),text(p,'value'),number(p.updatedAt,Date.now())]];
    // Auth is restored only by database.js's existing verified-auth validation.
    case 'auth_state': case '_legacy_session': return null;
    default: throw new Error(`Unsupported restore resource: ${resource}`);
  }
}
function restoreRecords(db, records, botId) {
  let restored = 0;
  const rows = records.filter(r => typeof r.key === 'string' && r.key.startsWith(`${botId}:`));
  const restore = db.transaction(() => {
    for (const row of rows) {
      if (!row.value || typeof row.value !== 'object' || Array.isArray(row.value)) throw new Error('Invalid restore record');
      const mapped = mapping(row.resource, row.value);
      if (!mapped) continue;
      const [table, columns, values] = mapped; // All SQL identifiers are constants above.
      db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')}) ON CONFLICT DO NOTHING`).run(...values);
      // sql.js wrapper historically reports 1 for zero changes. Query SQLite
      // itself so repeat restores are counted accurately without changing it.
      restored += Number(db.prepare('SELECT changes() AS n').get().n);
    }
  });
  restore();
  return { restored, botId };
}
module.exports = { restoreRecords };
