// ============================================================
//   helper/chatbot.js  – auto-reply chatbot for the Ultra XMD bot
// ============================================================
//
// The bot had no chatbot at all. This adds one, wired into the same
// messages.upsert pipeline as the other listeners (see index.js).
//
// Configuration lives in the normal per-number settings store, so it is
// isolated per paired WhatsApp number:
//     chatbot            on / off
//     chatbotMentionOnly in groups, only answer when tagged or replied to
//
// Providers are tried in order and the first one that answers wins, because
// free AI endpoints rate-limit (HTTP 402) when several chats fire at once.
// Calls are serialised with a minimum gap for the same reason.

'use strict';

const axios = require('axios');
const { getWaSettings } = require('./function');
const { logInfo, logError } = require('./logger');

const MAX_REPLY_CHARS = 4000;
const REQUEST_TIMEOUT_MS = Number(process.env.CHATBOT_TIMEOUT_MS || 30000);
const MIN_CALL_GAP_MS = Number(process.env.CHATBOT_MIN_INTERVAL_MS || 750);
const MAX_PENDING = Number(process.env.CHATBOT_MAX_PENDING || 4);
const CHAT_COOLDOWN_MS = Number(process.env.CHATBOT_COOLDOWN_MS || 1500);
const CHATBOT_MODEL = process.env.CHATBOT_MODEL || 'openai';

const SYSTEM_PROMPT = [
  'You are a warm, natural WhatsApp conversational assistant.',
  'Answer the user\'s actual question first, then add a short helpful detail when useful.',
  'Sound like a thoughtful person: acknowledge what they said, use the conversation context, and ask one clear follow-up question when the request is unclear.',
  'Match the user\'s language, tone, and level of formality. If they are casual, be relaxed; if they are serious, be respectful and direct. Use emojis sparingly and only when they fit the user\'s style. Keep normal replies concise, usually 1-4 short paragraphs.',
  'Use plain WhatsApp-friendly formatting; avoid headings, fake quotes, repetitive greetings, and unnecessary disclaimers.',
  'Do not invent personal experiences, actions, links, dates, or facts. If you are unsure, say so briefly and suggest the safest next step.',
  'Do not claim to have sent, searched, opened, or changed anything unless the bot actually did it.',
  'When the user writes in Kiswahili, reply in natural, fluent Kiswahili. When the user mixes Kiswahili and English, naturally mirror that mix without translating unless asked. Do not switch to English just because a few technical words are English.',
  'Never output or mention the names Charles, Charetam, or Talkless. Do not call the user by those names, introduce a persona with those names, or mention internal project names. Never assume the user\'s name.',
].join(' ');

const KISWAHILI_WORDS = new Set([
  'habari', 'jambo', 'tafadhali', 'asante', 'karibu', 'kwa', 'nini', 'vipi',
  'uko', 'niko', 'nina', 'nataka', 'unaweza', 'jinsi', 'leo', 'kesho', 'sasa',
  'sawa', 'ndiyo', 'ndio', 'hapana', 'maana', 'kuhusu', 'wewe', 'yangu', 'yako',
  'hii', 'hiyo', 'hapa', 'pale', 'lakini', 'kwani', 'naomba', 'msaada', 'mtu',
  'wapi', 'lini', 'kwa nini', 'imekuwaje', 'unafanyaje', 'naweza', 'nisaidie',
]);

function languageGuidance(text) {
  const normalized = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const words = normalized.split(/\s+/).filter(Boolean);
  const score = words.reduce((total, word) => total + (KISWAHILI_WORDS.has(word) ? 1 : 0), 0);
  if (score >= 2) {
    return 'The latest message is Kiswahili or Kiswahili-heavy. Reply in natural Kiswahili, preserving necessary English technical terms.';
  }
  if (score === 1 && words.length <= 8) {
    return 'The latest message may be Kiswahili. Prefer a natural Kiswahili reply unless the user clearly asks in another language.';
  }
  return 'Reply in the language used in the latest message. Preserve a natural mixed-language style when the user mixes languages.';
}

const PROVIDERS = [
  { name: 'pollinations-openai', kind: 'openai', url: process.env.CHATBOT_API_URL || 'https://text.pollinations.ai/openai' },
  { name: 'pollinations-referrer', kind: 'openai', url: 'https://text.pollinations.ai/openai?referrer=ultra-xmd' },
  { name: 'pollinations-plain', kind: 'plain', url: 'https://text.pollinations.ai/' },
  { name: 'fallback-site', kind: 'cortana', url: process.env.CHATBOT_FALLBACK_URL || 'https://mrfarai.me/cortana/api.php' }
];

const HEADERS = { 'Content-Type': 'application/json', Accept: '*/*', 'User-Agent': 'UltraXMD-Chatbot/1.0' };

const histories = new Map();        // senderKey -> [{ role, content }]
const lastChatReply = new Map();    // paired-number + jid -> timestamp
const seenMessageIds = new Set();

const callChains = new Map();
const lastCallAtBySession = new Map();
const pendingBySession = new Map();

/* ───────────────────────── helpers ───────────────────────── */

function normNum(jid) {
  return String(jid || '').split(':')[0].split('@')[0].replace(/\D/g, '');
}

function textOf(message) {
  if (!message) return '';
  let value = message;
  for (const wrapper of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage']) {
    if (value[wrapper]?.message) value = value[wrapper].message;
  }
  return value.conversation ||
    value.extendedTextMessage?.text ||
    value.imageMessage?.caption ||
    value.videoMessage?.caption ||
    value.documentMessage?.caption ||
    '';
}

function contextInfoOf(message) {
  if (!message || typeof message !== 'object') return null;
  const queue = [message];
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    if (current.contextInfo) return current.contextInfo;
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

/** True when the message tags the bot or quotes one of its messages. */
function isBotAddressed(sock, m) {
  const selfIds = [sock?.user?.id, sock?.user?.lid, sock?.authState?.creds?.me?.id]
    .map(normNum).filter(Boolean);
  if (!selfIds.length) return false;
  const ctx = contextInfoOf(m?.message);
  if (ctx) {
    const mentioned = Array.isArray(ctx.mentionedJid) ? ctx.mentionedJid : [];
    if (mentioned.some((jid) => selfIds.includes(normNum(jid)))) return true;
    if (ctx.participant && selfIds.includes(normNum(ctx.participant))) return true;
  }
  // Some WhatsApp clients preserve the visible @number but omit mentionedJid.
  const visibleText = textOf(m?.message);
  if (selfIds.some((id) => new RegExp(`@${id}(?:\\D|$)`).test(visibleText))) return true;
  return false;
}

function cleanReply(value) {
  return String(value || '')
    .replace(/^\s*(assistant|bot)\s*:\s*/i, '')
    .replace(/```(?:text)?/gi, '')
    .replace(/```/g, '')
    // Keep provider output from exposing the forbidden bot/person names.
    .replace(/\b(charles|charetam)\b/gi, 'the assistant')
    .replace(/\btalkless(?:\s+(?:xmd|ultra|systems?))?\b/gi, 'the bot')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/* ───────────────────────── providers ───────────────────────── */

async function callProvider(provider, history) {
  const latestUserText = [...history].reverse().find(item => item.role === 'user')?.content || '';
  const systemPrompt = `${SYSTEM_PROMPT} ${languageGuidance(latestUserText)}`;
  const messages = [{ role: 'system', content: systemPrompt }, ...history];

  if (provider.kind === 'openai' || provider.kind === 'plain') {
    const { data } = await axios.post(provider.url, { model: CHATBOT_MODEL, messages },
      { headers: HEADERS, timeout: REQUEST_TIMEOUT_MS });
    if (typeof data === 'string') return data;
    return data?.choices?.[0]?.message?.content;
  }

  if (provider.kind === 'cortana') {
    const transcript = history
      .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
      .join('\n');
    const { data } = await axios.post(provider.url, { message: `${systemPrompt}\n\n${transcript}`, history: [] },
      { headers: HEADERS, timeout: REQUEST_TIMEOUT_MS });
    return data?.reply;
  }

  throw new Error(`unknown provider kind: ${provider.kind}`);
}

function schedule(sessionId, job) {
  const pendingCalls = pendingBySession.get(sessionId) || 0;
  if (pendingCalls >= MAX_PENDING) {
    logInfo(sessionId, `chatbot skipped (backlog=${pendingCalls})`);
    return Promise.resolve(null);
  }
  pendingBySession.set(sessionId, pendingCalls + 1);
  const callChain = callChains.get(sessionId) || Promise.resolve();
  const run = callChain.then(async () => {
    const lastCallAt = lastCallAtBySession.get(sessionId) || 0;
    const wait = lastCallAt + MIN_CALL_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAtBySession.set(sessionId, Date.now());
    return job();
  });
  callChains.set(sessionId, run.then(() => {}, () => {}));
  return run.finally(() => {
    const remaining = Math.max(0, (pendingBySession.get(sessionId) || 1) - 1);
    if (remaining) pendingBySession.set(sessionId, remaining);
    else {
      pendingBySession.delete(sessionId);
      callChains.delete(sessionId);
    }
  });
}

async function ask(sessionId, history) {
  return schedule(sessionId, async () => {
    let lastError = null;
    for (const provider of PROVIDERS) {
      const started = Date.now();
      try {
        const reply = await callProvider(provider, history);
        const text = reply && String(reply).trim();
        if (text) {
          logInfo(sessionId, `chatbot ok provider=${provider.name} ms=${Date.now() - started}`);
          return text;
        }
        logInfo(sessionId, `chatbot empty provider=${provider.name}`);
      } catch (err) {
        const status = err?.response?.status ? ` status=${err.response.status}` : '';
        logInfo(sessionId, `chatbot fail provider=${provider.name}${status} ms=${Date.now() - started}`);
        lastError = err;
      }
    }
    throw lastError || new Error('all chatbot providers failed');
  });
}

/* ───────────────────────── handler ───────────────────────── */

async function handleChatbot(sock, m) {
  try {
    if (!m?.message || !m.key) return;
    if (m.key.fromMe) return;

    const jid = m.key.remoteJid;
    if (!jid) return;
    if (jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return;

    const waNum = sock.__waNum || (sock.user?.id ? normNum(sock.user.id) : null);
    if (!waNum) return;

    const c = getWaSettings(waNum);
    if (!c.chatbot) return;

    const isGroup = jid.endsWith('@g.us');
    if (isGroup && c.chatbotMentionOnly !== false && !isBotAddressed(sock, m)) return;

    const text = String(textOf(m.message) || '').trim();
    if (!text) return;
    const prefix = c.prefix || '.';
    if (text.startsWith(prefix)) return;   // let the command handler own it

    const msgId = `${waNum}:${jid}:${m.key.id}`;
    if (seenMessageIds.has(msgId)) return;
    seenMessageIds.add(msgId);
    setTimeout(() => seenMessageIds.delete(msgId), 60000).unref?.();

    const chatStateKey = `${waNum}:${jid}`;
    if ((lastChatReply.get(chatStateKey) || 0) > Date.now()) return;

    const sender = m.key.participant || jid;
    // Keep context inside this paired session and chat. This lets the bot
    // understand follow-up questions such as “what about tomorrow?” without
    // mixing one WhatsApp chat with another.
    const key = `${waNum}:${jid}`;
    const history = (histories.get(key) || [])
      .filter(item => !(item.role === 'assistant' && /\b(charles|charetam|talkless)\b/i.test(item.content || '')))
      .slice(-20);
    history.push({ role: 'user', content: text });

    try { await sock.sendPresenceUpdate('composing', jid); } catch {}

    const started = Date.now();
    let reply;
    try {
      reply = cleanReply(await ask(waNum, history));
    } catch (err) {
      logInfo(waNum, `chatbot providers unavailable: ${err.message}`);
      reply = 'I’m having trouble connecting right now. Please try that again in a moment.';
    }
    if (!reply) reply = 'I’m here. Could you say a little more about what you need?';

    const updated = history.slice(-20);
    updated.push({ role: 'assistant', content: reply });
    histories.set(key, updated.slice(-20));

    try { await sock.sendPresenceUpdate('paused', jid); } catch {}
    await sock.sendMessage(jid, { text: reply.slice(0, MAX_REPLY_CHARS) }, {});
    lastChatReply.set(chatStateKey, Date.now() + CHAT_COOLDOWN_MS);
    logInfo(waNum, `chatbot replied chat=${jid.split('@')[0]} ms=${Date.now() - started} chars=${reply.length}`);
  } catch (err) {
    logError('CHATBOT', err.message);
  }
}

module.exports = { handleChatbot };
