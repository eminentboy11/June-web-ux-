# June X — Plain External Auth Mirror

This update removes the AES-encrypted external-auth feature and replaces it with a **direct remote auth mirror**.

## What changes

- `JUNE_AUTH_BACKUP_KEY` is no longer used.
- The encryption helper is removed.
- Verified local SQLite auth rows are mirrored directly to configured PostgreSQL and/or MongoDB:
  - `session_creds`
  - `session_keys`
  - `session_auth_meta`
- PostgreSQL uses a dedicated `session_auth_state` table.
- MongoDB uses the `auth-state` record in `june_mirror_records`.
- If the local SQLite auth state is missing and no usable file session exists, June X restores the latest direct remote auth state before normal startup.
- A deliberate logout/session clear deletes the direct remote auth state too.
- After the first successful direct mirror, the old compatibility auth record from the previous feature is removed automatically.

## Required GitHub deletion

A ZIP upload cannot delete an existing GitHub file. Before or after uploading this bundle, use GitHub's **Delete file** action to delete exactly:

```text
utils/juneDb/authBackup.js
```

Do not delete `utils/juneDb/auth-state.js`; that is the active SQLite/Baileys auth implementation.

## Upload

Upload and overwrite these bundle files at the matching repository paths:

```text
database.js
index.js
README.md
utils/juneDb/mongoAdapter.js
utils/juneDb/pgAdapter.js
utils/juneDb/postgres-schema.sql
```

Then restart the bot normally.

## Panel variables

No backup key is required for this version. You may remove this unused panel variable after the code is uploaded:

```text
JUNE_AUTH_BACKUP_KEY
```

No new variable is required. Optional timing only:

```text
JUNE_AUTH_MIRROR_DEBOUNCE_MS=2000
```

## Expected startup logs

With PostgreSQL available and verified local auth:

```text
[ PG ] Connected; remote persistence enabled for bot_id=...
[ AUTH MIRROR ] External auth state mirror scheduled.
```

During a recovery startup where the local SQLite auth rows are missing:

```text
[ AUTH MIRROR ] Restored postgres auth state (... key rows).
```

or:

```text
[ AUTH MIRROR ] Restored mongo auth state (... key rows).
```

## Important operational note

This version stores the selected auth state directly in the configured external database. Restrict PostgreSQL/MongoDB access to trusted administrators and do not expose database dumps, connection URLs, or auth data in logs or chat.

Do not delete the live `database/` directory as an immediate test. First upload, restart, wait at least 15 seconds for the mirror job, and confirm the safe startup log above. A destructive recovery test should be done later on a copied/staging deployment.

## Validation completed locally

- `database.js`, `index.js`, `mongoAdapter.js`, and `pgAdapter.js` parse successfully.
- PostgreSQL and Mongo direct-auth mirror adapter round trips were tested with local in-memory test doubles.
- The removed encryption helper is not referenced by the updated runtime source.

---

# Centralized Session Server (NEW — additive, in testing)

June Ultra can now use a **centralized remote session system** instead of pasting
huge base64 session strings:

```
Pair on the website → server stores your WhatsApp auth state (encrypted)
→ you receive a short token:  june-ultra:~xxxxxxxxxxxxxxxxxxxxxxxx
→ put it in your bot environment → the bot fetches the session and connects
```

## Setup

1. Deploy/visit the **June Session Server** pairing website and pair your number
   (pairing code, like before).
2. Copy the `june-ultra:~…` token (shown on the site **and** sent to your WhatsApp).
3. Set in the bot environment (`.env`, Heroku config vars, etc.):

```
JUNE_SESSION_TOKEN=june-ultra:~xxxxxxxxxxxxxxxxxxxxxxxx
```

4. Restart the bot. Done — no QR code, no base64 string.

The session server URL is **built into the code** — users never set it.
(`JUNE_SESSION_SERVER_URL` still exists as an undocumented override for
testing/staging.) The built-in server is the unified June service at
`https://burning-lorena-eminentbo-ede53cc1.koyeb.app` (pairing + sessions + storage in one).

## One token = full setup (recommended)

The **same `JUNE_SESSION_TOKEN`** also provides remote storage for your bot
settings, group settings and kv data — no `DB=` and no separate database
secret:

- On hosts that wipe their disk (Render/Koyeb/Heroku/Replit/Railway/…), the
  bot automatically mirrors its data to your session's private storage on
  the session server. Pair once, redeploy freely — everything survives.
- On hosts with durable disks (e.g. Pterodactyl/VPS), local SQLite is kept
  (your data is already safe there). Set `JUNE_FORCE_SESSION_STORE=1` if you
  want remote storage anyway.
- Precedence if you set several: `DATABASE_URL` > `DB=` > session token.
- Revoking your session (pairing site → Manage) removes the session **and**
  its stored bot data in one action.

## How it behaves

- **SQLite remains the bot's local runtime auth store** — the token only provisions
  and recovers it.
- The token **never overrides a verified local session** (same policy as SESSION_ID).
  Use `JUNE_FORCE_SESSION_BOOTSTRAP=true` for an intentional replacement.
- While connected, the bot pushes evolved Signal keys back to the server, so
  redeploys always get the latest state, and sends a heartbeat every 60 s.
- **One bot per session**: a booting bot automatically takes over the session
  lease (restarts are same-installation and never lock themselves out); a
  second *running* deployment stops syncing this session — and two bots on one
  token will also show device conflicts in WhatsApp.
- **Revocation is conservative**: the server-side session is destroyed only on a
  genuine WhatsApp logout or an explicit `.resetbot confirm --session`. Conflicts,
  timeouts, restarts and server downtime never destroy anything.
- If the session server is unreachable but the bot has a healthy local session,
  the bot still connects normally.
- Legacy `Ultra-X:~` / `JUNE-MD:~` / `June-Ultra:~` session strings keep working
  exactly as before. This feature is purely additive.

## Token management

- `.getsession` (owner) — in token mode shows the token fingerprint, server
  status and bot-online state instead of a base64 string.
- The pairing website's **Manage** page can check status and revoke a token.
- A revoked/expired token produces a clear terminal error; re-pair to get a new one.

## New environment variables

| Variable | Purpose |
|---|---|
| `JUNE_SESSION_TOKEN` | `june-ultra:~<24 chars>` or `june-ultra:<your-id>:~<24 chars>` token from the pairing website |
| `JUNE_SESSION_SERVER_URL` | *(optional, undocumented)* override the built-in session server URL — testing/staging only |
| `JUNE_FORCE_SESSION_STORE` | `1` = use session-token storage even on hosts with durable disks |
| `JUNE_TAKEOVER_SESSION` | `true` to take over a session held by another deployment (rarely needed — taking over at boot is automatic) |
| `JUNE_FORCE_SESSION_BOOTSTRAP` | `true` to replace verified local auth from the token's session |
