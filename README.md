# TALKLESS — session-ID build

Talkless XMD (Telegram-controlled multi-session WhatsApp bot) with **paste-a-session-ID** support, so a user can drop a ready `creds` string instead of waiting on a QR code or pairing code.

Upstream base: `jj2001887-hash/TALKLESS---MAIN-BOT` (v28 package). This repo adds one feature and removes two hardcoded secrets — nothing else.

## What the feature does

`/start` gains a third keyboard row: **💾 𝑷𝑨𝑺𝑻𝑬 𝑺𝑬𝑺𝑺𝑰𝑶𝑵 𝑰𝑫**

1. Tap it (or send `/pastesession`) → the bot asks for the string
2. Paste → saved to `sessions/wa_<telegramId>_<phone>/creds.json` → `makeWASocket()` connects immediately
3. Any later message from `/listpaired` shows it as 🟢 Online

Inline works too: `/pastsession Pixel!eyJ...` — one message, no prompt.

### Accepted formats

| Paste | Handling |
|---|---|
| `eyJub2lzZUtleSI6…` | Base64 of `creds.json` |
| `Pixel!` · `Blacklord!` · `Varnox!` · `Astro!` · `TALKLESS!` · `TALKLESS-MD!` | prefix stripped, then Base64-decoded |
| ```` ```json … ``` ```` | fences stripped |
| Base64 using `-` / `_` | normalised to standard Base64 |
| Base64 broken across lines | whitespace removed first |
| `{"creds":{…}}` (raw or Base64) | unwrapped |
| raw `creds.json` JSON | parsed directly |
| double-encoded JSON string | parsed twice |

Rejected with no file written: empty text, prose, truncated Base64, JSON without a `creds`/`me` shape, arrays.

### Validation

`creds.me.id` is the only hard requirement; the phone number is derived from it. Missing `noiseKey` / `signedIdentityKey` / `signedPreKey` / `advSecretKey` / `registered` does **not** block the import — the reply warns (`⚠️ Missing fields: …`) and it tries anyway. An already-connected number is refused so the same socket is never opened twice.

Pastes are keyed to the Telegram user id, so two users pasting the same session get separate folders and will fight over one WhatsApp connection. Holding the Base64 string is equivalent to holding the account.

## Layout

```
index.js              Telegram + Baileys bootstrap, session import
case.js               WhatsApp command dispatcher
helper/
  sessionId.js        ← session-string parser (new, no deps, no I/O)
  function.js         sessions / pairs / premium / users storage
  listeners.js        antidelete, antilink, welcome, group events
  talkless-neon.js    optional website pairing loop (needs NEON_DATABASE_URL)
tests/
  session-id.test.js  28 parser assertions
  paste-flow.test.js  end-to-end run of the real index.js with Telegram/Baileys stubbed
```

## Install

```bash
npm install                       # blacklord-baileys, telegraf, pg, mysql2, sharp, …
cp .env.example .env              # then fill it in — never commit .env
node index.js
```

Required in `.env`:

| Key | Purpose |
|---|---|
| `TELEGRAM_TOKEN` | control bot token |
| `OWNER_TELEGRAM_ID` | your numeric Telegram id |
| `NEON_DATABASE_URL` | optional — only for the website pairing loop |

Optional: `GITHUB_TOKEN` / `GITHUB_USERNAME` / `GITHUB_REPO` for session backup to a private repo, `PANEL_URL`, `WEBSITE_URL`.

## Tests

```bash
node tests/session-id.test.js    # parser only
node tests/paste-flow.test.js    # real index.js, stubbed network
```

`paste-flow.test.js` pushes actual messages through the `bot.on('text')` middleware and asserts: prompt shown, Base64 saved, socket opened once, duplicate guarded, raw JSON accepted, junk rejected, `me.id`-less JSON rejected, `/cancel` aborts, inline command works.

## Security notes

- `.env`, `sessions/`, `node_modules/` and all runtime database JSON are git-ignored. `database/users.json`, `pairs.json`, `premium.json`, `settings.json` hold real Telegram ids and WhatsApp numbers — keep them out of git.
- `settings.js` no longer ships a hardcoded Neon connection string; it is env-only now. If you were using the upstream file, **rotate that database password** — it was published in the original zip.
- `stickers.js` embeds a public Tenor/Google demo API key. Replace it with your own if you plan to run stickers at scale.

## Attribution

Bot code © the original Talkless XMD author (`jj2001887-hash`). No license file ships with the upstream package, so none is added here — add the license you actually hold the rights to before publishing.
