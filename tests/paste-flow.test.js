// End-to-end test of the paste-session flow against the REAL src/index.js,
// with the network-facing modules (Telegram, Baileys, DB, WA handlers) stubbed.
//
// Run from the package root:  node tests/paste-flow.test.js
'use strict';
const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const Module  = require('module');

// index.js refuses to boot without a token; the value never leaves this process.
process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '123456789:TEST-TOKEN-FOR-UNIT-TEST';
process.env.OWNER_TELEGRAM_ID = process.env.OWNER_TELEGRAM_ID || '8703390483';

const SRC = path.resolve(__dirname, '..');
process.chdir(SRC);                       // index.js uses './database' and './sessions'

const calls = { sockets: [], replies: [], telegram: [], launched: false };

// ── module stubs ──────────────────────────────────────────────
class FakeTelegraf {
  constructor(token) {
    this.token = token;
    this.handlers = { text: [], message: [], command: [], action: [] };
    this.telegram = { sendMessage: async (chat, msg) => { calls.telegram.push({ chat, msg }); } };
    FakeTelegraf.lastInstance = this;
  }
  catch() {}
  use() {}
  start(fn)            { this.handlers.start = fn; }
  on(ev, fn)           { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  command(name, fn)    { this.handlers.command.push({ name, fn }); }
  action(name, fn)     { this.handlers.action.push({ name, fn }); }
  async launch()       { calls.launched = true; }
  stop() {}
}
FakeTelegraf.Markup = {
  keyboard: (rows) => ({ resize: () => ({ reply_markup: { rows } }) }),
  inlineKeyboard: () => ({}),
  button: { callback: (t, d) => ({ t, d }) },
};

function makeFakeSock() {
  return {
    ev: { on: () => {} },
    user: { id: '254704955033:1@s.whatsapp.net' },
    requestPairingCode: async () => 'TALKLESS1',
    logout: async () => {},
    ws: { close() {} },
    newsletterFollow: async () => {},
    subscribeNewsletterUpdates: async () => {},
  };
}

const chalkProxy = new Proxy(function () {}, {
  get: () => chalkProxy,
  apply: () => '',
});

const stubs = {
  telegraf: { Telegraf: FakeTelegraf, Markup: FakeTelegraf.Markup },
  'blacklord-baileys': {
    default: (opts) => { const s = makeFakeSock(opts); calls.sockets.push(s); return s; },
    useMultiFileAuthState: async () => ({ state: { creds: { registered: true }, keys: {} }, saveCreds: async () => {} }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
    makeCacheableSignalKeyStore: (keys) => keys,
    DisconnectReason: { loggedOut: 401, connectionClosed: 428 },
  },
  chalk: chalkProxy,
  pino: () => ({ level: 'silent', child: () => ({ level: 'silent' }) }),
  dotenv: { config: () => ({ parsed: {} }) },
  axios: { get: async () => ({ data: {} }), post: async () => ({ data: {} }) },
  pg: { Pool: class { query() { return Promise.resolve({ rows: [] }); } end() {} } },
  mysql2: { createPool: () => ({ query: () => {}, execute: () => {} }) },
  './case': { handleMessage: async () => {}, runAutoFollow: async () => {} },
  './helper/listeners': new Proxy({}, { get: () => () => {} }),
  './helper/logger': {
    logInfo:    (...a) => fs.appendFileSync('/tmp/logger.log', `INFO ${a.join(' ')}`),
    logSuccess: (...a) => fs.appendFileSync('/tmp/logger.log', `SUCCESS ${a.join(' ')}\n`),
    logWarn:    (...a) => fs.appendFileSync('/tmp/logger.log', `WARN ${a.join(' ')}\n`),
    logError:   (...a) => fs.appendFileSync('/tmp/logger.log', `ERROR ${a.join(' ')}\n`),
    logSession: (...a) => fs.appendFileSync('/tmp/logger.log', `SESSION ${a.join(' ')}\n`),
  },
  './helper/chatbot': { handleChatbot: async () => {} },
  './helper/talkless-neon': {
    startTalklessPairingLoop: () => {},
    markPairingConnected: async () => {},
    upsertSession: async () => {},
  },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.call(this, request, parent, isMain);
};

// ── load the bot ─────────────────────────────────────────────
require('../index.js');

// index.js keeps its Telegraf instance private; the constructor records it.
const liveBot = FakeTelegraf.lastInstance;
assert.ok(liveBot, 'Telegraf instance was constructed');

const textHandler = liveBot.handlers.text[0];
assert.ok(typeof textHandler === 'function', 'text middleware registered');

// ── test harness ─────────────────────────────────────────────
const CREDS = {
  noiseKey: { private: 'AAAA', public: 'BBBB' },
  signedIdentityKey: { private: 'CCCC', public: 'DDDD' },
  signedPreKey: { keyPair: { private: 'EEEE', public: 'FFFF' }, signature: 'GGGG', keyId: 1 },
  advSecretKey: 'HHHHHHHH',
  me: { id: '254704955033:12@s.whatsapp.net', name: 'Talkless' },
  registered: true,
};
const PASTE_B64 = Buffer.from(JSON.stringify(CREDS)).toString('base64');

function mkCtx(uid, text) {
  const ctx = {
    from: { id: uid, first_name: 'Tester' },
    chat: { id: uid },
    message: { text },
    replied: [],
    reply: async (msg) => { ctx.replied.push(msg); calls.replies.push({ uid, msg }); return {}; },
  };
  return ctx;
}

const next = async () => {};
const lastReply = (ctx) => ctx.replied[ctx.replied.length - 1] || '';

(async () => {
  // 1) button opens the paste prompt and arms the state
  const a = mkCtx(1001, '💾 𝑷𝑨𝑺𝑻𝑬 𝑺𝑬𝑺𝑺𝑰𝑶𝑵 𝑰𝑫');
  await textHandler(a, next);
  assert.match(lastReply(a), /Paste your session ID/i, 'prompt shown');

  // 2) pasting Base64 creds writes the session and starts a socket
  const before = calls.sockets.length;
  const b = mkCtx(1001, 'TALKLESS!' + PASTE_B64);
  await textHandler(b, next);
  assert.match(lastReply(b), /Session saved for \+254704955033/i, 'saved message');

  const credsPath = path.join(SRC, 'sessions', 'wa_1001_254704955033', 'creds.json');
  assert.ok(fs.existsSync(credsPath), 'creds.json written');
  const written = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  assert.strictEqual(written.me.id, CREDS.me.id, 'creds persisted verbatim');
  assert.strictEqual(calls.sockets.length, before + 1, 'makeWASocket called once');

  // 3) a foreign brand prefix is refused, and nothing is written
  const foreign = mkCtx(7007, '💾 𝑷𝑨𝑺𝑻𝑬 𝑺𝑬𝑺𝑺𝑰𝑶𝑵 𝑰𝑫');
  await textHandler(foreign, next);
  const foreignPaste = mkCtx(7007, 'Pixel!' + PASTE_B64);
  await textHandler(foreignPaste, next);
  assert.match(lastReply(foreignPaste), /only .*TALKLESS.* sessions are accepted/i, 'foreign prefix rejected');
  assert.ok(!fs.existsSync(path.join(SRC, 'sessions', 'wa_7007_254704955033')), 'nothing written for foreign prefix');

  // 4) same session again → "already connected" instead of a second socket
  const c = mkCtx(1001, '💾 𝑷𝑨𝑺𝑻𝑬 𝑺𝑬𝑺𝑺𝑰𝑶𝑵 𝑰𝑫');
  await textHandler(c, next);
  const again = mkCtx(1001, PASTE_B64);
  await textHandler(again, next);
  assert.match(lastReply(again), /already connected/i, 'duplicate guarded');
  assert.strictEqual(calls.sockets.length, before + 1, 'no extra socket');

  // 5) raw creds.json paste for a second user
  const d = mkCtx(2002, '💾 𝑷𝑨𝑺𝑻𝑬 𝑺𝑬𝑺𝑺𝑰𝑶𝑵 𝑰𝑫');
  await textHandler(d, next);
  const e = mkCtx(2002, JSON.stringify(CREDS));
  await textHandler(e, next);
  assert.match(lastReply(e), /Session saved for \+254704955033 \(json\)/i, 'raw JSON accepted');
  assert.ok(fs.existsSync(path.join(SRC, 'sessions', 'wa_2002_254704955033', 'creds.json')), 'json paste persisted');

  // 6) junk is rejected and no folder is created
  const f = mkCtx(3003, '💾 𝑷𝑨𝑺𝑻𝑬 𝑺𝑬𝑺𝑺𝑰𝑶𝑵 𝑰𝑫');
  await textHandler(f, next);
  const g = mkCtx(3003, 'hello, this is not a session');
  await textHandler(g, next);
  assert.match(lastReply(g), /does not look like a session ID/i, 'junk rejected');
  assert.ok(!fs.existsSync(path.join(SRC, 'sessions', 'wa_3003_254704955033')), 'nothing written for junk');

  // 7) missing me.id is rejected even though the JSON is valid
  const h = mkCtx(4004, '💾 𝑷𝑨𝑺𝑻𝑬 𝑺𝑬𝑺𝑺𝑰𝑶𝑵 𝑰𝑫');
  await textHandler(h, next);
  const noMe = Buffer.from(JSON.stringify({ noiseKey: { private: 'x' } })).toString('base64');
  const i = mkCtx(4004, noMe);
  await textHandler(i, next);
  assert.match(lastReply(i), /no usable WhatsApp number/i, 'me.id required');

  // 8) /cancel aborts an armed paste prompt instead of being parsed as one
  const k1 = mkCtx(6006, '💾 𝑷𝑨𝑺𝑻𝑬 𝑺𝑬𝑺𝑺𝑰𝑶𝑵 𝑰𝑫');
  await textHandler(k1, next);
  const k2 = mkCtx(6006, '/cancel');
  await textHandler(k2, next);
  assert.match(lastReply(k2), /Cancelled/i, '/cancel aborts paste');
  assert.ok(!fs.existsSync(path.join(SRC, 'sessions', 'wa_6006_254704955033')), 'cancel wrote nothing');

  // 8) /pastesession with inline string goes straight through
  const cmd = liveBot.handlers.command.find((entry) =>
    Array.isArray(entry.name) ? entry.name.includes('pastesession') : entry.name === 'pastesession');
  assert.ok(cmd, '/pastesession registered');
  const j = mkCtx(5005, '/pastesession ' + PASTE_B64);
  await cmd.fn(j);
  assert.match(lastReply(j), /Session saved for \+254704955033/i, 'inline command works');

  process.stdout.write(
    `ok — paste flow verified (${calls.replies.length} replies, ${calls.sockets.length} sockets)\n`,
    () => process.exit(0)
  );
})().catch((err) => {
  require('fs').writeFileSync('/tmp/pf-fail.log', `FAILED: ${err.message}\n${err.stack || ''}\n`);
  process.exit(1);
});

process.on('unhandledRejection', (e) => {
  require('fs').writeFileSync('/tmp/pf-unhandled.log', String(e && e.stack || e));
});
