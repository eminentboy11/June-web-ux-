# June-X Ultra — deploy notes for this bundle

Built from commit `492f9b3` of the private repo `eminentboy11/..wdp`.
This bundle is **not yet pushed** to `main`.

---

## ⚠️ STEP 1 — DELETE THREE FILES (required, do this first)

Extracting a ZIP **overwrites and adds** files. It **cannot delete** them.
Three files were removed in this change. If they survive on your server they
will re-register their old command names and undo most of the fix.

Delete these after extracting:

```text
commands/general/setpp.js
commands/general/antibug.js
commands/general/memesearch.js
```

One-liner from the bot's root directory:

```bash
rm -f commands/general/setpp.js commands/general/antibug.js commands/general/memesearch.js
```

Verify they are gone before starting the bot:

```bash
ls commands/general/setpp.js commands/general/antibug.js commands/general/memesearch.js 2>&1
# expected: "No such file or directory" for all three
```

If you skip this step:
- `setpp.js` still exports `name: 'getpp'` and, loading after `getpp.js`,
  will win again — reverting the profile-picture fix.
- `antibug.js` and `memesearch.js` will re-create their duplicate registrations.

---

## STEP 2 — start and read the new boot warnings

`utils/commandLoader.js` now prints a line whenever two commands fight over a
name. A clean start should print **no** `[ COMMANDS ]` warnings at all.

If you see either of these, something is still duplicated — send me the lines:

```text
[ COMMANDS ] Duplicate name "x": cat/file.js overrides cat/other.js
[ COMMANDS ] Alias "x" of cat/file.js shadows the real command "x" (...) — alias skipped
```

---

## STEP 3 — what to check in the running bot

| Check | Command | Expected |
|---|---|---|
| Menu is sorted | `.menu` | every section A→Z; `SPORT` starts at `bet`, not `playersearch` |
| No stray section | `.menu` | **no** `UNDEFINED-CMD` section; `shutdown` sits under `OWNER` |
| Categories correct | `.menu` | `chatbot` under AI · `neko` under ANIME · `leave`/`getjid` under OWNER · `antibug`/`delpp`/`setprofile` under GENERAL |
| **Kick restored** | `.kick @user` in a group | removes the member (was sending a GIF) |
| Kick GIF still works | `.kickgif` | sends the reaction GIF |
| Shutdown alias | `.kill` | triggers shutdown (was sending a GIF); `.killgif` sends the GIF |
| Profile picture | `.getpp` and `.pp` `.pfp` `.profilepic` | all reach the same working command |
| Meme search on a panel | `.memesearch cat` | GIF conversion works — this now uses `utils/ffmpegPath` instead of raw `ffmpeg-static` |
| Reassigned aliases | `.status` `.stats` `.info` `.quote` `.host` `.screenshot` | botstatus · groupstats · botinfo · quotes · catbox · ssweb |
| Memory line | `.menu` header | reads `ᴜꜱᴀɢᴇ: … (bot)` and `ʀᴀᴍ: … (host)` |

---

## Known-unverified

- Nothing here was run. `npm install` was never executed; verification was
  `node --check` on all 333 files plus a static simulation of the loader.
- The static audit counts 431 commands; your bot reports 467. The gap is
  dynamically-generated exports the parser cannot resolve. Collision results
  are sound, the census is not exhaustive.
- `.quote` was **re-pointed** to `fun/quote.js` (`quotes`). This is the only
  place an alias was added rather than removed. If you prefer it on
  `tools/quotedinfo.js`, revert that one line.

---

## Still outstanding (not addressed in this bundle)

- **Rotate the leaked credentials.** OpenRouter key in `utils/juneDb/orap.js`
  (obfuscated but trivially recoverable), Telegram tokens in `config.js` and
  `commands/general/telegramsticker.js`. All three are also sitting in the
  public mirror `..wdx` and in git history.
- `..wdx` is public and byte-identical to this private repo.
- Three other files still use raw `ffmpeg-static` and may fail on containers.
- `config.js` says `version: '2.9.0'`, `package.json` says `2.8.8`.

Delete this file before re-uploading the tree to GitHub.
