# June X Ultra

WhatsApp **Multi-Device (MD)** chatbot built on
[`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) —
400+ commands across 21 categories (media downloads, stickers, group
moderation, AI helpers, mini-games as WhatsApp rich apps, notes, owner
tooling, and more).

## Architecture at a glance

| File | Role |
|---|---|
| `index.js` | Boot, session resolution (pairing token / local SQLite), connection lifecycle, dashboard, cleanup |
| `handler.js` | Message dispatch: prefix routing, anti-spam/anti-link/view-once, button & native-flow responses |
| `database.js` | SQLite settings + state (native `better-sqlite3`, `sql.js` WASM fallback), optional PostgreSQL / MongoDB mirroring |
| `commands/<category>/*.js` | One module per command (or a module exporting an array). Loaded and hot-reloaded by `utils/commandLoader.js` — **the folder name is the command's category** |
| `utils/` | Shared helpers (APIs, stickers, fonts, temp files, mini-app sender, …) |
| `utils/juneDb/` | SQLite-backed Baileys auth state, PG/Mongo adapters, session server client |
| `test/` | Plain `node:test` suites (no framework) |

## Requirements

- Node.js **20.x** (`engines` in `package.json`), npm 10+
- No lockfile is committed by design (deploys use the platform's package manager)

## Setup

```bash
git clone <repo-url> && cd <repo>
npm install        # or: npm run install:no-puppeteer
```

### Session (login)

The official login path is the **pairing website**:

1. Pair your number at your session server
   (default: `https://burning-lorena-eminentbo-ede53cc1.koyeb.app/pair`,
   override with `JUNE_SESSION_SERVER_URL`).
2. You receive a token of the form `june-ultra:~<24 chars>`
   (or `june-ultra:<bot-id>:~<24 chars>`).
3. Put it in the environment as `JUNE_SESSION_TOKEN` (recommended) or
   `SESSION_ID`.

`JUNE_SESSION_TOKEN` takes priority over `SESSION_ID`. Legacy base64
session strings are retired and no longer work. If no remote session is
available, the bot falls back to its local SQLite auth state
(`utils/juneDb/auth-state.js`).

### Run

```bash
npm start          # node index.js
npm run dev        # nodemon
```

The bot auto-generates a starter `.env` if none exists, prints a startup
report box, and keeps running until stopped.

## Environment variables

The important ones (all others in the code are optional tuning knobs):

| Variable | Purpose |
|---|---|
| `SESSION_ID` | Session token from the pairing site (legacy name) |
| `JUNE_SESSION_TOKEN` | Same token — **preferred**, takes priority |
| `JUNE_SESSION_SERVER_URL` | Session server base URL |
| `OWNER_NUMBER` / `JUNE_PN` / `PN` | Owner phone number |
| `PREFIX` | Command prefix (default `.`) |
| `TIMEZONE` | Display timezone (e.g. `Africa/Lagos`) |
| `BOT_ID` / `JUNE_BOT_ID` | Bot identity for multi-instance setups |
| `POSTGRES_URL` / `DATABASE_URL` | Optional PostgreSQL remote mirror |
| `MONGODB_URI` / `MONGO_URL` | Optional MongoDB remote mirror |
| `PORT` | HTTP port (platform-provided) |
| `DEBUG` | `1` to enable verbose boot/session logs |
| `JUNE_DB_FILE` / `JUNE_DB_DIR` | Override SQLite location (default `database/june-ultra.db`) |

Remote mirrors (PostgreSQL/MongoDB) are optional: when configured,
verified settings and auth state are mirrored for recovery; the local
SQLite DB always works standalone.

## Commands

Every `commands/<category>/<name>.js` exports a command object
(`name`, `aliases`, `description`, `execute(sock, msg, args, extra)`),
or an **array** of them. Category comes from the folder. The loader
watches the tree and hot-reloads changed files without a restart.

List everything in a chat with `.menu` or `.help` (rich HTML mini-app on
supported clients, text fallback otherwise). `.disable <cmd>` /
`.enable <cmd>` (owner) toggle individual commands at runtime.

## Tests

```bash
npm test           # node --test test/
```

Suites: `notes` (notes module), `stalker` (presence watcher),
`handler-gate` (command gating). Requires `npm install` first — they
load real project modules.

## Obfuscation & publishing (CI)

`.github/workflows/build.yml` runs on every push to `main`:

1. `npm run build` — `obfuscator.js` writes an obfuscated copy of the
   source tree into the `June x on/` folder (gitignored).
2. The workflow pushes that build to a second (private) repo using
   `secrets.REPO_B_TOKEN`.

The obfuscated repo is for distribution only — **develop here**.

## Deployment

Works on any Node 20 platform. `app.json` + `Procfile` target
**Heroku** (node buildpack); Koyeb, Render, Railway, Replit and
Docker environments are detected at runtime. Set the session token and
owner number as platform env vars.

## Project layout

```
├── commands/            # 21 categories, ~307 command modules
├── utils/               # shared helpers + rich mini-app sender
│   └── juneDb/          # auth state, PG/Mongo adapters, session server
├── test/                # node:test suites
├── database.js          # SQLite settings/state + remote mirroring
├── handler.js           # message dispatch & moderation
├── index.js             # boot, session, connection, dashboard
├── obfuscator.js        # build step for the distribution repo
├── Procfile / app.json  # Heroku deployment
└── .github/workflows/build.yml
```
